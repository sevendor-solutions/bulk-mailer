import asyncio
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders
from email.utils import formataddr, formatdate, make_msgid
from typing import Optional
import aiosmtplib
from app.config import settings


class EmailSender:
    """Abstract email sender that supports both SES and SMTP."""

    async def send_email(
        self,
        to_email: str,
        subject: str,
        html_body: str,
        from_email: str,
        from_name: Optional[str] = None,
        reply_to: Optional[str] = None,
        attachments: list = None,
        custom_headers: dict = None,
        plain_body: Optional[str] = None,
    ) -> dict:
        """Send a single email. Returns {"message_id": ..., "success": True} or {"success": False, "error": ...}"""
        raise NotImplementedError

    async def close(self) -> None:
        """Release any connection held by the sender."""


class SESEmailSender(EmailSender):
    """Send emails via Amazon SES."""

    def __init__(self):
        self._client = None

    async def _get_client(self):
        if self._client is None:
            import aioboto3
            session = aioboto3.Session(
                aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
                aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
                region_name=settings.AWS_REGION,
            )
            self._client = await session.client("ses").__aenter__()
        return self._client

    async def send_email(
        self,
        to_email: str,
        subject: str,
        html_body: str,
        from_email: str,
        from_name: Optional[str] = None,
        reply_to: Optional[str] = None,
        attachments: list = None,
        custom_headers: dict = None,
        plain_body: Optional[str] = None,
    ) -> dict:
        try:
            client = await self._get_client()

            # Build MIME message
            msg = _build_mime_message(
                to_email=to_email,
                subject=subject,
                html_body=html_body,
                from_email=from_email,
                from_name=from_name,
                reply_to=reply_to,
                attachments=attachments,
                custom_headers=custom_headers,
                plain_body=plain_body,
            )

            response = await client.send_raw_email(
                Source=msg["From"],
                Destinations=[to_email],
                RawMessage={"Data": msg.as_string()},
            )

            return {
                "success": True,
                "message_id": response["MessageId"],
            }
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def get_send_quota(self) -> dict:
        """Get SES sending limits."""
        try:
            client = await self._get_client()
            response = await client.get_send_quota()
            return {
                "max_send_rate": response["MaxSendRate"],
                "max_24_hour_send": response["Max24HourSend"],
                "sent_last_24_hours": response["SentLast24Hours"],
            }
        except Exception:
            return {"max_send_rate": 14, "max_24_hour_send": 50000, "sent_last_24_hours": 0}

    async def close(self):
        if self._client:
            await self._client.__aexit__(None, None, None)
            self._client = None


class SMTPEmailSender(EmailSender):
    """
    Send emails via SMTP.

    The connection is opened on first use and reused for the following
    messages, so a batch does not pay for a TLS handshake and login per email.
    Call close() when the batch is done.
    """

    TIMEOUT_SECONDS = 30

    def __init__(self, host: str = None, port: int = None, username: str = None, password: str = None, use_tls: bool = None):
        self.host = host or settings.SMTP_HOST
        self.port = port or settings.SMTP_PORT
        self.username = username or settings.SMTP_USERNAME
        self.password = password or settings.SMTP_PASSWORD
        self.use_tls = use_tls if use_tls is not None else settings.SMTP_USE_TLS
        self._client: Optional[aiosmtplib.SMTP] = None

    def _new_client(self) -> aiosmtplib.SMTP:
        # Port 465 speaks TLS from the first byte; every other port upgrades with STARTTLS.
        implicit_tls = bool(self.use_tls) and self.port == 465
        return aiosmtplib.SMTP(
            hostname=self.host,
            port=self.port,
            use_tls=implicit_tls,
            start_tls=bool(self.use_tls) and not implicit_tls,
            timeout=self.TIMEOUT_SECONDS,
        )

    async def connect(self) -> None:
        """Open the connection and log in. Raises on any failure."""
        if not self.host:
            raise aiosmtplib.SMTPConnectError("SMTP host is not configured")
        await self.close()
        client = self._new_client()
        await client.connect()
        try:
            if self.username:
                await client.login(self.username, self.password or "")
        except Exception:
            client.close()
            raise
        self._client = client

    async def _ensure_connected(self) -> aiosmtplib.SMTP:
        if self._client is None or not self._client.is_connected:
            await self.connect()
        return self._client

    async def close(self) -> None:
        client, self._client = self._client, None
        if client is None:
            return
        try:
            if client.is_connected:
                await client.quit()
        except Exception:
            client.close()

    async def send_email(
        self,
        to_email: str,
        subject: str,
        html_body: str,
        from_email: str,
        from_name: Optional[str] = None,
        reply_to: Optional[str] = None,
        attachments: list = None,
        custom_headers: dict = None,
        plain_body: Optional[str] = None,
    ) -> dict:
        try:
            msg = _build_mime_message(
                to_email=to_email,
                subject=subject,
                html_body=html_body,
                from_email=from_email,
                from_name=from_name,
                reply_to=reply_to,
                attachments=attachments,
                custom_headers=custom_headers,
                plain_body=plain_body,
            )
        except Exception as e:
            return {"success": False, "error": f"Could not build message: {e}", "error_kind": "recipient"}

        for attempt in (1, 2):
            try:
                client = await self._ensure_connected()

                # Determine envelope sender (MAIL FROM)
                envelope_sender = from_email
                if self.username and "@" in self.username:
                    from_domain = (from_email.rsplit("@", 1)[-1] if "@" in from_email else "").lower()
                    user_domain = self.username.rsplit("@", 1)[-1].lower()
                    if from_domain != user_domain:
                        # Use authenticated username as envelope sender to satisfy strict SMTP auth and SPF
                        envelope_sender = self.username

                await client.send_message(msg, sender=envelope_sender, recipients=[to_email])
                return {"success": True, "message_id": msg["Message-ID"]}
            except aiosmtplib.SMTPServerDisconnected as e:
                await self.close()
                if attempt == 2:
                    return {"success": False, "error": _describe(e), "error_kind": "connection"}
            except Exception as e:
                kind = _classify_smtp_error(e)
                if kind == "connection":
                    await self.close()
                elif self._client is not None and self._client.is_connected:
                    # Clear the failed transaction so the next message starts clean.
                    try:
                        await self._client.rset()
                    except Exception:
                        await self.close()
                return {"success": False, "error": _describe(e), "error_kind": kind}


def _describe(exc: Exception) -> str:
    text = str(exc).strip()
    if "5.7.1" in text or "Spam message rejected" in text:
        return f"{type(exc).__name__}: {text} (Rejected by SMTP server spam filter. Common causes: unverified/wildcard links like sslip.io in email, From email mismatch with SMTP account, or spam keywords.)"
    return f"{type(exc).__name__}: {text}" if text else type(exc).__name__


def _classify_smtp_error(exc: Exception) -> str:
    """
    "connection": the server is unreachable or rejects our login/sender, so
                  every message would fail the same way.
    "recipient":  this address was refused for good (5xx).
    "temporary":  worth retrying later (4xx, timeouts mid-message).
    """
    if isinstance(exc, aiosmtplib.SMTPRecipientsRefused):
        codes = [getattr(r, "code", 0) for r in (exc.recipients or [])]
        return "recipient" if codes and all(c >= 500 for c in codes) else "temporary"
    if isinstance(exc, aiosmtplib.SMTPRecipientRefused):
        return "recipient" if exc.code >= 500 else "temporary"
    if isinstance(exc, (
        aiosmtplib.SMTPAuthenticationError,
        aiosmtplib.SMTPSenderRefused,
        aiosmtplib.SMTPConnectError,
        aiosmtplib.SMTPConnectTimeoutError,
        aiosmtplib.SMTPServerDisconnected,
        aiosmtplib.SMTPHeloError,
        aiosmtplib.SMTPNotSupported,
        OSError,
    )):
        return "connection"
    if isinstance(exc, aiosmtplib.SMTPResponseException):
        return "recipient" if exc.code >= 500 else "temporary"
    return "temporary"


def _build_mime_message(
    to_email: str,
    subject: str,
    html_body: str,
    from_email: str,
    from_name: Optional[str] = None,
    reply_to: Optional[str] = None,
    attachments: list = None,
    custom_headers: dict = None,
    plain_body: Optional[str] = None,
) -> MIMEMultipart:
    """Build a MIME email message."""
    msg = MIMEMultipart("mixed")

    # Set headers
    msg["From"] = formataddr((from_name, from_email)) if from_name else from_email
    msg["To"] = to_email
    msg["Subject"] = subject
    # SMTP servers do not add these; mail without them is commonly scored as spam.
    msg["Date"] = formatdate(localtime=False)
    msg["Message-ID"] = make_msgid(domain=from_email.rsplit("@", 1)[-1] if "@" in from_email else None)

    if reply_to:
        msg["Reply-To"] = reply_to

    # Custom headers (tracking, unsubscribe, etc.)
    if custom_headers:
        for key, value in custom_headers.items():
            msg[key] = value

    # Body: multipart/alternative when a plain-text part is supplied
    if plain_body and plain_body.strip():
        body = MIMEMultipart("alternative")
        body.attach(MIMEText(plain_body, "plain", "utf-8"))
        body.attach(MIMEText(html_body, "html", "utf-8"))
    else:
        body = MIMEText(html_body, "html", "utf-8")

    inline = [a for a in (attachments or []) if a.get("content_id")]
    regular = [a for a in (attachments or []) if not a.get("content_id")]

    # Images shown inside the HTML travel next to it in multipart/related;
    # mail clients then display them in place instead of listing them as files.
    if inline:
        related = MIMEMultipart("related")
        related.attach(body)
        for attachment in inline:
            related.attach(_attachment_part(attachment, inline=True))
        body = related
    msg.attach(body)

    for attachment in regular:
        msg.attach(_attachment_part(attachment, inline=False))

    return msg


def _attachment_part(attachment: dict, inline: bool) -> MIMEBase:
    content_type = attachment.get("content_type") or "application/octet-stream"
    maintype, _, subtype = content_type.partition("/")
    part = MIMEBase(maintype, subtype or "octet-stream")
    part.set_payload(attachment["content"])
    encoders.encode_base64(part)
    part.add_header(
        "Content-Disposition",
        "inline" if inline else "attachment",
        filename=attachment["filename"],
    )
    if inline:
        part.add_header("Content-ID", f"<{attachment['content_id']}>")
    return part


def get_email_sender() -> EmailSender:
    """Factory to get the configured email sender."""
    if settings.EMAIL_PROVIDER == "smtp":
        return SMTPEmailSender()
    return SESEmailSender()
