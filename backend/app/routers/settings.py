from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import json
from app.database import get_db
from app.models.user import User
from app.models.settings_model import AppSettings
from app.utils.dependencies import get_admin_user
from app.services.provider_config import (
    SETTINGS_KEY, SECRET_FIELDS, read_provider_config, public_provider_config,
    apply_provider_config, provider_problem, tracking_active, tracking_url_is_public,
)
from pydantic import BaseModel
from typing import Optional, List

router = APIRouter(prefix="/settings", tags=["settings"])


class SettingUpdate(BaseModel):
    value: str  # JSON-encoded value


class EmailProviderConfig(BaseModel):
    provider: str  # "ses" or "smtp"
    ses_region: Optional[str] = None
    ses_access_key: Optional[str] = None
    ses_secret_key: Optional[str] = None
    smtp_host: Optional[str] = None
    smtp_port: Optional[int] = None
    smtp_username: Optional[str] = None
    smtp_password: Optional[str] = None
    smtp_use_tls: Optional[bool] = True
    sandbox_mode: Optional[bool] = True
    max_send_rate: Optional[int] = None
    rate_limit_type: Optional[str] = "delay"  # "delay" or "per_second"
    send_delay_seconds: Optional[float] = 60.0  # seconds between emails
    # Mailbox read for bounces; blank values follow the SMTP settings
    imap_enabled: Optional[bool] = None
    imap_host: Optional[str] = None
    imap_port: Optional[int] = None
    imap_username: Optional[str] = None
    imap_password: Optional[str] = None
    imap_folder: Optional[str] = None
    tracking_base_url: Optional[str] = None  # Public URL of this backend, used in tracked links
    tracking_enabled: Optional[bool] = None  # None = automatic


@router.get("/")
async def get_all_settings(
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_admin_user),
):
    result = await db.execute(select(AppSettings))
    settings_list = result.scalars().all()
    values = {s.key: json.loads(s.value) if s.value else None for s in settings_list}
    # Stored passwords and keys never go back to the browser
    if isinstance(values.get(SETTINGS_KEY), dict):
        values[SETTINGS_KEY] = _provider_view(values[SETTINGS_KEY])
    return values


def _provider_view(config: dict) -> dict:
    from app.config import settings as app_settings

    view = public_provider_config(config)
    view["tracking_base_url"] = app_settings.TRACKING_BASE_URL
    view["tracking_active"] = tracking_active()
    view["tracking_url_is_public"] = tracking_url_is_public()
    view["problem"] = provider_problem()
    view.setdefault("rate_limit_type", getattr(app_settings, "RATE_LIMIT_TYPE", "delay"))
    view.setdefault("send_delay_seconds", getattr(app_settings, "SEND_DELAY_SECONDS", 60.0))
    view.setdefault("max_send_rate", getattr(app_settings, "MAX_SEND_RATE", 14))
    return view


@router.get("/email-provider")
async def get_email_provider(
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_admin_user),
):
    """The saved provider configuration, without secrets."""
    from app.config import settings as app_settings

    config = await read_provider_config(db)
    view = _provider_view(config)
    view.setdefault("provider", app_settings.EMAIL_PROVIDER)
    return view


# ─── Campaign Mode ───


class CampaignModeConfig(BaseModel):
    mode: str  # "global" or "user"
    max_recipients: Optional[int] = None
    allow_scheduling: bool = True


@router.get("/campaign-mode")
async def get_campaign_mode(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_admin_user),
):
    """Get campaign mode settings."""
    result = await db.execute(select(AppSettings).where(AppSettings.key == "campaign_mode"))
    mode_setting = result.scalar_one_or_none()
    result2 = await db.execute(select(AppSettings).where(AppSettings.key == "campaign_controls"))
    controls_setting = result2.scalar_one_or_none()

    mode = json.loads(mode_setting.value) if mode_setting and mode_setting.value else "global"
    controls = json.loads(controls_setting.value) if controls_setting and controls_setting.value else {}

    return {"mode": mode, "max_recipients": controls.get("max_recipients"), "allow_scheduling": controls.get("allow_scheduling", True)}


@router.post("/campaign-mode")
async def update_campaign_mode(
    config: CampaignModeConfig,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_admin_user),
):
    """Update campaign mode settings (admin only)."""
    # Save mode
    result = await db.execute(select(AppSettings).where(AppSettings.key == "campaign_mode"))
    setting = result.scalar_one_or_none()
    mode_value = json.dumps(config.mode)
    if setting:
        setting.value = mode_value
    else:
        db.add(AppSettings(key="campaign_mode", value=mode_value, description="Campaign visibility mode"))

    # Save controls
    controls = json.dumps({"max_recipients": config.max_recipients, "allow_scheduling": config.allow_scheduling})
    result2 = await db.execute(select(AppSettings).where(AppSettings.key == "campaign_controls"))
    setting2 = result2.scalar_one_or_none()
    if setting2:
        setting2.value = controls
    else:
        db.add(AppSettings(key="campaign_controls", value=controls, description="Campaign control settings"))

    await db.commit()
    return {"mode": config.mode, "max_recipients": config.max_recipients, "allow_scheduling": config.allow_scheduling}


@router.post("/email-provider")
async def configure_email_provider(
    config: EmailProviderConfig,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_admin_user),
):
    """Configure email provider settings (SES or SMTP)."""
    if config.provider not in ("ses", "smtp"):
        raise HTTPException(400, "Provider must be 'ses' or 'smtp'")
    if config.max_send_rate is not None and config.max_send_rate < 1:
        raise HTTPException(400, "Max send rate must be at least 1 per second")
    if config.send_delay_seconds is not None and config.send_delay_seconds < 0:
        raise HTTPException(400, "Send delay must be 0 or greater")

    # Merge onto what is stored: a blank password or key means "keep the current one",
    # and saving one provider must not wipe the other's settings.
    config_data = await read_provider_config(db)
    incoming = config.model_dump(exclude_unset=True)
    for key, value in incoming.items():
        if key in SECRET_FIELDS and not value:
            continue
        if key == "tracking_enabled" or value is not None:
            config_data[key] = value
    value = json.dumps(config_data)

    result = await db.execute(select(AppSettings).where(AppSettings.key == SETTINGS_KEY))
    setting = result.scalar_one_or_none()

    if setting:
        setting.value = value
    else:
        setting = AppSettings(key=SETTINGS_KEY, value=value, description="Email provider configuration")
        db.add(setting)

    await db.commit()

    # Update runtime config
    apply_provider_config(config_data)

    return {
        "message": "Email provider configured",
        "provider": config.provider,
        "config": _provider_view(config_data),
    }


async def _bounce_mailbox_view(db: AsyncSession) -> dict:
    from app.services.bounce_worker import mailbox_settings, mailbox_problem, read_state, POLL_SECONDS

    cfg = mailbox_settings()
    state = await read_state(db)
    return {
        "enabled": cfg["enabled"],
        # What will actually be used, after falling back to the SMTP settings
        "host": cfg["host"],
        "port": cfg["port"],
        "username": cfg["username"],
        "folder": cfg["folder"],
        "password_set": bool(cfg["password"]),
        "problem": mailbox_problem(cfg),
        "check_every_seconds": POLL_SECONDS,
        "last_checked_at": state.get("last_checked_at"),
        "last_success_at": state.get("last_success_at"),
        "last_error": state.get("last_error"),
        "total_marked": int(state.get("total_marked") or 0),
    }


@router.get("/bounce-mailbox")
async def get_bounce_mailbox(
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_admin_user),
):
    """Bounce detection settings in effect and the result of the last check."""
    return await _bounce_mailbox_view(db)


@router.post("/bounce-mailbox/check")
async def check_bounce_mailbox(
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_admin_user),
):
    """Read the mailbox now. Also serves as the connection test."""
    from app.services.bounce_worker import check_mailbox

    summary = await check_mailbox()
    return {**summary, "mailbox": await _bounce_mailbox_view(db)}


class ProviderTestRequest(BaseModel):
    to_email: Optional[str] = None  # When given, a test message is sent as well
    from_email: Optional[str] = None


@router.post("/email-provider/test")
async def test_email_provider(
    req: ProviderTestRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_admin_user),
):
    """Check the saved provider: connect and log in, then optionally send a test email."""
    from app.config import settings as app_settings
    from app.models.sender_identity import SenderIdentity
    from app.services.email_sender import get_email_sender, SMTPEmailSender, _describe

    problem = provider_problem()
    if problem:
        return {"success": False, "stage": "configuration", "error": problem}

    sender = get_email_sender()
    try:
        if isinstance(sender, SMTPEmailSender):
            try:
                await sender.connect()
            except Exception as exc:
                return {"success": False, "stage": "connection", "error": _describe(exc)}

        if not req.to_email:
            return {"success": True, "stage": "connection", "provider": app_settings.EMAIL_PROVIDER}

        from_email, from_name = req.from_email, None
        if not from_email:
            identity = (await db.execute(
                select(SenderIdentity)
                .where(SenderIdentity.is_active.is_(True))
                .order_by(SenderIdentity.is_default.desc())
                .limit(1)
            )).scalar_one_or_none()
            if identity:
                from_email, from_name = identity.from_email, identity.from_name
        if not from_email:
            from_email = app_settings.SMTP_USERNAME if "@" in (app_settings.SMTP_USERNAME or "") else None
        if not from_email:
            return {
                "success": False, "stage": "configuration",
                "error": "No sender address. Add a sender identity first.",
            }

        result = await sender.send_email(
            to_email=req.to_email.strip(),
            subject="Test email from your bulk email sender",
            html_body="<p>This is a test email. Your email provider settings are working.</p>",
            plain_body="This is a test email. Your email provider settings are working.",
            from_email=from_email,
            from_name=from_name,
        )
        return {
            "success": bool(result.get("success")),
            "stage": "send",
            "provider": app_settings.EMAIL_PROVIDER,
            "from_email": from_email,
            "message_id": result.get("message_id"),
            "error": result.get("error"),
        }
    finally:
        await sender.close()


class EditorSettingsConfig(BaseModel):
    editors: list[str]  # e.g. ["custom", "tiptap", "unlayer", "grapejs", "html"]
    default: str


@router.get("/editors")
async def get_editor_settings(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_admin_user),
):
    """Get enabled editors configuration."""
    result = await db.execute(select(AppSettings).where(AppSettings.key == "enabled_editors"))
    setting = result.scalar_one_or_none()
    if not setting or not setting.value:
        # Default: all editors enabled, custom as default
        return {"editors": ["custom", "tiptap", "unlayer", "grapejs", "html"], "default": "custom"}
    return json.loads(setting.value)


@router.put("/editors")
async def update_editor_settings(
    config: EditorSettingsConfig,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_admin_user),
):
    """Update enabled editors configuration (admin only)."""
    valid_editors = {"custom", "tiptap", "unlayer", "grapejs", "html"}
    if not config.editors:
        raise HTTPException(400, "At least one editor must be enabled")
    if not all(e in valid_editors for e in config.editors):
        raise HTTPException(400, f"Invalid editor. Valid options: {valid_editors}")
    if config.default not in config.editors:
        raise HTTPException(400, "Default editor must be in the enabled list")

    value = json.dumps({"editors": config.editors, "default": config.default})

    result = await db.execute(select(AppSettings).where(AppSettings.key == "enabled_editors"))
    setting = result.scalar_one_or_none()

    if setting:
        setting.value = value
    else:
        setting = AppSettings(key="enabled_editors", value=value, description="Enabled email editors")
        db.add(setting)

    await db.commit()
    return json.loads(value)


# ─── General Settings ───


DEFAULT_APP_NAME = "BulkMailer"
DEFAULT_PALETTE = "ysrcp"


class GeneralSettingsConfig(BaseModel):
    app_name: str = DEFAULT_APP_NAME
    logo_url: Optional[str] = None
    favicon_url: Optional[str] = None
    timezone: str = "UTC"
    theme_palette: str = DEFAULT_PALETTE
    theme_custom_primary: Optional[str] = None


@router.get("/general")
async def get_general_settings(
    db: AsyncSession = Depends(get_db),
):
    """
    Name, logo and colours of the application.

    Public on purpose: the login page and non-admin users need the branding
    too, and nothing here is sensitive.
    """
    result = await db.execute(select(AppSettings).where(AppSettings.key == "general"))
    setting = result.scalar_one_or_none()
    if not setting or not setting.value:
        return GeneralSettingsConfig().model_dump()
    return json.loads(setting.value)


@router.post("/general")
async def update_general_settings(
    config: GeneralSettingsConfig,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_admin_user),
):
    """Update general application settings (admin only)."""
    value = json.dumps(config.model_dump())

    result = await db.execute(select(AppSettings).where(AppSettings.key == "general"))
    setting = result.scalar_one_or_none()

    if setting:
        setting.value = value
    else:
        setting = AppSettings(key="general", value=value, description="General application settings")
        db.add(setting)

    await db.commit()
    return json.loads(value)


# ─── Data Retention ───


class DataRetentionConfig(BaseModel):
    enabled: bool = False
    campaign_retention_days: Optional[int] = None
    campaign_delete_recipients: bool = True
    recipient_retention_days: Optional[int] = None
    tracking_retention_days: Optional[int] = None
    upload_retention_days: Optional[int] = None
    suppression_exempt: bool = True


@router.get("/data-retention")
async def get_data_retention(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_admin_user),
):
    """Get data retention policy settings."""
    result = await db.execute(select(AppSettings).where(AppSettings.key == "data_retention"))
    setting = result.scalar_one_or_none()
    if not setting or not setting.value:
        return DataRetentionConfig().model_dump()
    return json.loads(setting.value)


@router.post("/data-retention")
async def update_data_retention(
    config: DataRetentionConfig,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_admin_user),
):
    """Update data retention policy (admin only)."""
    value = json.dumps(config.model_dump())

    result = await db.execute(select(AppSettings).where(AppSettings.key == "data_retention"))
    setting = result.scalar_one_or_none()

    if setting:
        setting.value = value
    else:
        setting = AppSettings(key="data_retention", value=value, description="Data retention policy")
        db.add(setting)

    await db.commit()
    return config.model_dump()


@router.get("/suppression")
async def get_suppression_list(
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_admin_user),
):
    """List all suppressed/unsubscribed emails."""
    from app.models.suppression import SuppressionList
    result = await db.execute(
        select(SuppressionList).order_by(SuppressionList.created_at.desc())
    )
    items = []
    for s in result.scalars().all():
        items.append({
            "id": s.id,
            "public_code": s.public_code,
            "email": s.email,
            "scope": s.scope,
            "reason": s.reason,
            "created_at": s.created_at.isoformat() if s.created_at else None,
        })
    return {"items": items, "total": len(items)}


@router.delete("/suppression/{email:path}")
async def remove_from_suppression(
    email: str,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_admin_user),
):
    """Re-subscribe / remove an email from the suppression list."""
    from app.models.suppression import SuppressionList
    from app.models.campaign import Recipient
    from sqlalchemy import delete, func
    
    email_clean = email.strip().lower()
    await db.execute(
        delete(SuppressionList).where(
            func.lower(SuppressionList.email) == email_clean
        )
    )
    other_recipients = (await db.execute(
        select(Recipient).where(
            func.lower(Recipient.email) == email_clean,
            Recipient.status == "unsubscribed",
            Recipient.sent_at.is_(None),
        )
    )).scalars().all()
    for other in other_recipients:
        other.status = "pending"
        other.error_message = None

    await db.commit()
    return {"message": f"Successfully re-subscribed {email}", "email": email}


# Generic key-value setting (must be last to avoid shadowing specific routes)
@router.put("/{key}")
async def update_setting(
    key: str,
    data: SettingUpdate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_admin_user),
):
    result = await db.execute(select(AppSettings).where(AppSettings.key == key))
    setting = result.scalar_one_or_none()

    if setting:
        setting.value = data.value
    else:
        setting = AppSettings(key=key, value=data.value)
        db.add(setting)

    await db.commit()
    return {"key": key, "value": json.loads(data.value)}
