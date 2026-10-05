"""
Email provider configuration saved from the Settings page.

The settings table is the source of truth; this module copies it onto the
runtime `settings` object so the senders and the queue worker pick it up, both
right after a save and again on every startup.
"""
import json
import logging
from typing import Optional
from urllib.parse import urlparse

from sqlalchemy import select

from app.config import settings
from app.models.settings_model import AppSettings

logger = logging.getLogger(__name__)

SETTINGS_KEY = "email_provider"
SECRET_FIELDS = ("smtp_password", "ses_secret_key", "imap_password")

_LOCAL_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "::1", ""}


async def read_provider_config(db) -> dict:
    """The stored provider configuration, secrets included."""
    result = await db.execute(select(AppSettings).where(AppSettings.key == SETTINGS_KEY))
    setting = result.scalar_one_or_none()
    if not setting or not setting.value:
        return {}
    try:
        value = json.loads(setting.value)
    except (json.JSONDecodeError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def public_provider_config(config: dict) -> dict:
    """The configuration as it may be returned to the browser: no secrets."""
    public = {k: v for k, v in config.items() if k not in SECRET_FIELDS}
    for field in SECRET_FIELDS:
        public[f"{field}_set"] = bool(config.get(field))
    return public


def apply_provider_config(config: dict) -> None:
    """Copy a stored configuration onto the runtime settings."""
    if not config:
        return

    provider = (config.get("provider") or "").lower()
    if provider in ("ses", "smtp"):
        settings.EMAIL_PROVIDER = provider

    if config.get("ses_region"):
        settings.AWS_REGION = config["ses_region"]
    if config.get("ses_access_key"):
        settings.AWS_ACCESS_KEY_ID = config["ses_access_key"]
    if config.get("ses_secret_key"):
        settings.AWS_SECRET_ACCESS_KEY = config["ses_secret_key"]
    if config.get("sandbox_mode") is not None:
        settings.SES_SANDBOX_MODE = bool(config["sandbox_mode"])

    if "smtp_host" in config:
        settings.SMTP_HOST = (config.get("smtp_host") or "").strip() or None
    if config.get("smtp_port"):
        settings.SMTP_PORT = int(config["smtp_port"])
    if "smtp_username" in config:
        settings.SMTP_USERNAME = config.get("smtp_username") or None
    if "smtp_password" in config:
        settings.SMTP_PASSWORD = config.get("smtp_password") or None
    if config.get("smtp_use_tls") is not None:
        settings.SMTP_USE_TLS = bool(config["smtp_use_tls"])

    if config.get("imap_enabled") is not None:
        settings.IMAP_ENABLED = bool(config["imap_enabled"])
    if "imap_host" in config:
        settings.IMAP_HOST = (config.get("imap_host") or "").strip() or None
    if config.get("imap_port"):
        settings.IMAP_PORT = int(config["imap_port"])
    if "imap_username" in config:
        settings.IMAP_USERNAME = config.get("imap_username") or None
    if "imap_password" in config:
        settings.IMAP_PASSWORD = config.get("imap_password") or None
    if config.get("imap_folder"):
        settings.IMAP_FOLDER = config["imap_folder"]

    if config.get("tracking_base_url"):
        settings.TRACKING_BASE_URL = config["tracking_base_url"].strip().rstrip("/")
    if "tracking_enabled" in config:
        settings.TRACKING_ENABLED = config.get("tracking_enabled")

    if config.get("rate_limit_type"):
        settings.RATE_LIMIT_TYPE = str(config["rate_limit_type"])
    if "send_delay_seconds" in config and config["send_delay_seconds"] is not None:
        try:
            settings.SEND_DELAY_SECONDS = float(config["send_delay_seconds"])
        except (ValueError, TypeError):
            pass
    if config.get("max_send_rate"):
        try:
            settings.MAX_SEND_RATE = int(config["max_send_rate"])
        except (ValueError, TypeError):
            pass

    from app.services.queue_worker import rate_limiter
    rate_limiter.update_config(
        mode=settings.RATE_LIMIT_TYPE,
        delay_seconds=settings.SEND_DELAY_SECONDS,
        rate=settings.MAX_SEND_RATE,
    )


async def load_provider_config(db) -> dict:
    """Apply the stored configuration at startup."""
    config = await read_provider_config(db)
    if config:
        apply_provider_config(config)
        logger.info(f"Email provider loaded from settings: {settings.EMAIL_PROVIDER}")
    return config


_WILDCARD_SUFFIXES = ("sslip.io", "nip.io", "traefik.me")


def is_wildcard_host(url: str) -> bool:
    """Return True if URL host is local or dynamic wildcard DNS (sslip.io, nip.io)."""
    if not url:
        return True
    host = (urlparse(url).hostname or "").lower()
    if not host or host in _LOCAL_HOSTS:
        return True
    for suffix in _WILDCARD_SUFFIXES:
        if host == suffix or host.endswith("." + suffix):
            return True
    return False


def get_effective_tracking_url() -> str:
    """Get the usable tracking URL if configured."""
    return (settings.TRACKING_BASE_URL or "").strip().rstrip("/")


def tracking_url_is_public() -> bool:
    """Check if the tracking URL points to a non-local, non-wildcard public domain."""
    url = (settings.TRACKING_BASE_URL or "").strip().rstrip("/")
    if not url:
        return False
    host = (urlparse(url).hostname or "").lower()
    if host in _LOCAL_HOSTS:
        return False
    return not is_wildcard_host(url)


def tracking_active() -> bool:
    """
    Whether to rewrite links and add the open pixel.
    - False if explicitly disabled in settings
    - True if explicitly enabled by user (with a configured URL)
    - If automatic (None), ONLY True if a genuine non-wildcard public domain is configured.
      This prevents sslip.io/wildcard domains from being injected into outgoing emails,
      which triggers SMTP '554 5.7.1 Spam message rejected'.
    """
    if settings.TRACKING_ENABLED is False:
        return False
    if settings.TRACKING_ENABLED is True:
        url = (settings.TRACKING_BASE_URL or "").strip()
        host = (urlparse(url).hostname or "").lower()
        return bool(url and host not in _LOCAL_HOSTS)
    return tracking_url_is_public()


def provider_problem() -> Optional[str]:
    """Why the active provider cannot send, or None when it looks usable."""
    if settings.EMAIL_PROVIDER == "smtp":
        if not settings.SMTP_HOST:
            return "SMTP is selected but no SMTP host is configured. Set it in Settings > Email Provider."
        return None
    # SES may get its credentials from the environment or an instance role,
    # so missing keys here do not prove it cannot send.
    return None
