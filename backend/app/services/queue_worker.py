import asyncio
import logging
from datetime import datetime, timedelta, timezone
from sqlalchemy import select, update, func, or_
from app.database import AsyncSessionLocal
from app.models.campaign import Campaign, Recipient
from app.models.suppression import SuppressionList
from app.services.email_sender import get_email_sender
from app.services.provider_config import provider_problem, tracking_active, tracking_url_is_public
from app.services.inline_images import localize_images
from app.services.merge_engine import render_merge_fields, build_field_defaults, build_render_context, render_campaign_content
from app.utils.rate_limiter import TokenBucketRateLimiter
from app.config import settings

logger = logging.getLogger(__name__)

# Global rate limiter instance
rate_limiter = TokenBucketRateLimiter()

# Attempts per recipient before it is marked failed, and the wait between them
MAX_ATTEMPTS = 3
RETRY_DELAY_SECONDS = 60

# Control flag for graceful shutdown
_shutdown_event = asyncio.Event()


async def start_queue_worker():
    """Start the background queue worker. Called during app lifespan."""
    logger.info("Queue worker started")

    try:
        await recover_interrupted_sends()
    except Exception as e:
        logger.error(f"Could not recover interrupted sends: {e}")

    # Initialize rate limiter based on configured mode (delay vs per_second)
    try:
        sender = get_email_sender()
        if hasattr(sender, "get_send_quota") and getattr(settings, "RATE_LIMIT_TYPE", "delay") == "per_second":
            quota = await sender.get_send_quota()
            auto_rate = min(quota["max_send_rate"], settings.MAX_SEND_RATE)
            rate_limiter.update_config(mode="per_second", rate=auto_rate)
            logger.info(f"Rate limit set to {auto_rate}/sec (SES: {quota['max_send_rate']}, config: {settings.MAX_SEND_RATE})")
            await sender.close()
        else:
            rate_limiter.update_config(
                mode=getattr(settings, "RATE_LIMIT_TYPE", "delay"),
                delay_seconds=getattr(settings, "SEND_DELAY_SECONDS", 60.0),
                rate=getattr(settings, "MAX_SEND_RATE", 14),
            )
            logger.info(f"Rate limiter configured: mode={rate_limiter.mode}, delay={rate_limiter.delay_seconds}s, rate={rate_limiter.rate}/s")
    except Exception as e:
        logger.warning(f"Could not configure rate limiter: {e}")

    while not _shutdown_event.is_set():
        try:
            await _process_campaigns()
        except Exception as e:
            logger.error(f"Queue worker error: {e}")
        
        # Poll every 2 seconds
        try:
            await asyncio.wait_for(_shutdown_event.wait(), timeout=2.0)
            break  # Shutdown requested
        except asyncio.TimeoutError:
            pass  # Continue polling


async def recover_interrupted_sends() -> int:
    """
    Requeue recipients left in "sending" by a crash or restart.

    Nothing else ever picks those rows up, so without this they stay stuck and
    their campaign can never complete. The interrupted message may or may not
    have left, so a restart mid-send can deliver that one email twice.
    """
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            update(Recipient).where(Recipient.status == "sending").values(status="pending")
        )
        await db.commit()
        count = result.rowcount or 0
    if count:
        logger.warning(f"Requeued {count} recipient(s) interrupted mid-send")
    return count


async def stop_queue_worker():
    """Signal the queue worker to stop gracefully."""
    _shutdown_event.set()
    logger.info("Queue worker stopping...")


async def _process_campaigns():
    """Find active campaigns and process their pending recipients."""
    async with AsyncSessionLocal() as db:
        now = datetime.now(timezone.utc)
        
        # Find campaigns ready to send
        result = await db.execute(
            select(Campaign).where(
                (Campaign.status == "sending") |
                ((Campaign.status == "scheduled") & (Campaign.scheduled_at <= now))
            )
        )
        campaigns = result.scalars().all()

        for campaign in campaigns:
            # Activate scheduled campaigns
            if campaign.status == "scheduled":
                campaign.status = "sending"
            if campaign.started_at is None:
                campaign.started_at = now
            await db.commit()

            # Process a batch of recipients
            await _process_campaign_batch(db, campaign)


async def _load_snapshot(db, campaign: Campaign):
    """
    The frozen composer content for this campaign, when one exists.

    Campaigns authored in the classic editor have no snapshot, so the worker keeps
    using campaign.html_body for them.
    """
    try:
        from app.models.composer import CampaignTemplateSnapshot

        result = await db.execute(
            select(CampaignTemplateSnapshot)
            .where(CampaignTemplateSnapshot.campaign_id == campaign.id)
            .order_by(CampaignTemplateSnapshot.id.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()
    except Exception as exc:  # pragma: no cover - table missing on very old databases
        logger.debug(f"No composer snapshot available: {exc}")
        return None


def _read_attachments(snapshot) -> list:
    """Read the frozen attachment files from disk, skipping anything missing."""
    import os

    files = []
    for ref in (snapshot.attachment_refs_json or []):
        path = ref.get("path")
        if not path or not os.path.exists(path):
            logger.warning(f"Attachment missing on disk, skipping: {path}")
            continue
        try:
            with open(path, "rb") as handle:
                files.append({"filename": ref.get("filename") or os.path.basename(path), "content": handle.read()})
        except OSError as exc:
            logger.warning(f"Attachment could not be read ({path}): {exc}")
    return files


async def _process_campaign_batch(db, campaign: Campaign):
    """Process a batch of pending recipients for a campaign."""
    # Build field defaults once per batch (legacy compat)
    field_defaults = build_field_defaults(campaign.merge_fields_config)

    # Prefer frozen composer content; fall back to the campaign body.
    snapshot = await _load_snapshot(db, campaign)
    snapshot_attachments = _read_attachments(snapshot) if snapshot else []
    
    # Load template definitions if campaign uses a template
    template_field_defs = None
    if campaign.selected_template_id:
        from app.models.template import Template
        tmpl_result = await db.execute(
            select(Template).where(Template.id == campaign.selected_template_id)
        )
        tmpl = tmpl_result.scalar_one_or_none()
        if tmpl and tmpl.merge_field_definitions_json:
            template_field_defs = tmpl.merge_field_definitions_json

    problem = provider_problem()
    if problem:
        await _pause_with_error(db, campaign, problem)
        return

    # Get a batch of pending recipients that are due (not waiting out a retry delay)
    now = datetime.now(timezone.utc)
    batch_size = max(int(rate_limiter.rate * 2), 10)  # 2 seconds worth
    result = await db.execute(
        select(Recipient)
        .where(
            Recipient.campaign_id == campaign.id,
            Recipient.status == "pending",
            Recipient.is_included == True,
            or_(Recipient.next_attempt_at.is_(None), Recipient.next_attempt_at <= now),
        )
        .order_by(Recipient.row_index.asc().nullslast(), Recipient.id.asc())
        .limit(batch_size)
    )
    recipients = result.scalars().all()

    if not recipients:
        # Check if campaign is done (excluded rows are ignored)
        pending_count = await db.execute(
            select(func.count()).select_from(Recipient).where(
                Recipient.campaign_id == campaign.id,
                Recipient.status.in_(("pending", "sending")),
                Recipient.is_included == True,
            )
        )
        if pending_count.scalar() == 0:
            campaign.status = "completed"
            campaign.completed_at = datetime.now(timezone.utc)
            await db.commit()
            logger.info(f"Campaign {campaign.id} completed")
        return

    sender = get_email_sender()
    try:
        await _send_batch(db, campaign, recipients, sender, snapshot, snapshot_attachments,
                          template_field_defs, field_defaults)
    finally:
        await sender.close()


async def _pause_with_error(db, campaign: Campaign, message: str):
    campaign.status = "paused"
    campaign.last_error = message
    await db.commit()
    logger.warning(f"Campaign {campaign.id} paused: {message}")


async def _send_batch(db, campaign, recipients, sender, snapshot, snapshot_attachments,
                      template_field_defs, field_defaults):
    use_tracking = tracking_active()
    public_links = tracking_url_is_public()

    # Track failures for circuit breaker
    batch_failures = 0
    failure_threshold = max(len(recipients) * 0.1, 5)

    for recipient in recipients:
        # Re-check campaign status (might have been paused)
        await db.refresh(campaign)
        if campaign.status != "sending":
            return

        # Rate limit (respects delay or tokens/sec)
        acquired = await rate_limiter.acquire(is_cancelled=lambda: _shutdown_event.is_set())
        if not acquired or _shutdown_event.is_set():
            return

        # Re-check status in case user paused during the delay
        await db.refresh(campaign)
        if campaign.status != "sending":
            return

        # Re-check recipient status
        await db.refresh(recipient)
        if recipient.status == "unsubscribed" or not recipient.is_included:
            logger.info(f"Skipping unsubscribed or excluded recipient: {recipient.email}")
            continue

        # Check suppression list (if recipient unsubscribed in another campaign or globally)
        supp_check = await db.execute(
            select(SuppressionList.id).where(
                func.lower(SuppressionList.email) == recipient.email.lower(),
                SuppressionList.scope == "global",
            ).limit(1)
        )
        if supp_check.scalar_one_or_none():
            recipient.status = "unsubscribed"
            recipient.error_message = "Suppressed: recipient previously unsubscribed"
            await db.commit()
            logger.info(f"Skipping suppressed/unsubscribed recipient: {recipient.email}")
            continue

        # Mark as sending
        recipient.status = "sending"
        await db.commit()

        # Render merge fields in body and subject using canonical pipeline
        merge_data = recipient.merge_data or {}

        source_html = (snapshot.compiled_html if snapshot and snapshot.compiled_html else None) or campaign.html_body
        source_subject = (snapshot.subject if snapshot and snapshot.subject else None) or campaign.subject
        source_preheader = (snapshot.preheader if snapshot and snapshot.preheader else None) or campaign.preheader or ""
        source_plain = snapshot.plain_text if snapshot else None
        snapshot_defs = snapshot.merge_defs_json if snapshot else None
        bindings = (snapshot.field_bindings_json if snapshot else None) or campaign.template_field_bindings_json

        if campaign.campaign_field_definitions_json or template_field_defs or snapshot_defs:
            # Use canonical pipeline
            context, _, _, _ = build_render_context(
                merge_data,
                campaign.campaign_field_definitions_json,
                snapshot_defs or template_field_defs,
                bindings,
            )
            rendered = render_campaign_content(
                source_subject, source_preheader, source_html, source_plain or "", context
            )
            html_body = rendered["html"]
            subject = rendered["subject"]
            plain_body = rendered.get("plain_text") or None
        else:
            # Legacy fallback
            html_body = render_merge_fields(source_html, merge_data, field_defaults)
            subject = render_merge_fields(source_subject, merge_data, field_defaults)
            plain_body = render_merge_fields(source_plain, merge_data, field_defaults) if source_plain else None

        # Ensure plain_body is present for multipart/alternative to improve spam score
        if not plain_body and html_body:
            try:
                from app.services.composer.plaintext import html_to_text
                plain_body = html_to_text(html_body)
            except Exception:
                pass

        # Add tracking pixel and default unsubscribe footer
        if use_tracking:
            from app.services.tracking_injector import inject_tracking
            html_body = inject_tracking(html_body, recipient.id, campaign.id)
        else:
            # Even if click/open tracking is off, ensure unsubscribe link/footer is present
            from app.services.tracking_injector import inject_unsubscribe
            html_body = inject_unsubscribe(html_body, recipient.id, settings.TRACKING_BASE_URL)

        # Unsubscribe URL for plain body and headers
        unsub_base = (settings.TRACKING_BASE_URL or "").strip().rstrip("/")
        custom_headers = None
        if unsub_base:
            unsub_url = f"{unsub_base}/unsubscribe/{recipient.id}"
            if plain_body and "unsubscribe" not in plain_body.lower():
                plain_body += f"\n\n---\nTo unsubscribe from future emails: {unsub_url}"
            custom_headers = {
                "List-Unsubscribe": f"<{unsub_url}>",
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            }

        # Images uploaded here are stored with this machine's address
        html_body, inline_images = localize_images(html_body)
        message_attachments = list(snapshot_attachments or []) + inline_images

        # Send
        try:
            result = await sender.send_email(
                to_email=recipient.email,
                subject=subject,
                html_body=html_body,
                from_email=campaign.from_email,
                from_name=campaign.from_name,
                reply_to=campaign.reply_to,
                custom_headers=custom_headers,
                plain_body=plain_body,
                attachments=message_attachments or None,
            )
        except Exception as exc:
            # Never leave the row in "sending": that would hide it from the queue.
            result = {"success": False, "error": str(exc) or type(exc).__name__}

        now = datetime.now(timezone.utc)
        if result["success"]:
            recipient.status = "sent"
            recipient.sent_at = now
            recipient.ses_message_id = result.get("message_id")
            recipient.error_message = None
            recipient.next_attempt_at = None
            campaign.sent_count += 1
            campaign.last_error = None
        else:
            error = result.get("error") or "Unknown error"
            kind = result.get("error_kind", "temporary")
            recipient.error_message = error

            if kind == "connection":
                # The mail server itself is the problem. Keep this recipient queued
                # and stop, instead of burning every recipient's retries.
                recipient.status = "pending"
                await _pause_with_error(db, campaign, f"Mail server problem: {error}")
                return

            recipient.retry_count = (recipient.retry_count or 0) + 1
            if kind == "recipient" or recipient.retry_count >= MAX_ATTEMPTS:
                recipient.status = "failed"
                recipient.next_attempt_at = None
                campaign.failed_count += 1
                batch_failures += 1
            else:
                recipient.status = "pending"  # Will retry later
                recipient.next_attempt_at = now + timedelta(seconds=RETRY_DELAY_SECONDS * recipient.retry_count)

        await db.commit()

        # Circuit breaker: pause campaign if too many failures
        if batch_failures >= failure_threshold and campaign.sent_count < 100:
            await _pause_with_error(
                db, campaign,
                f"Paused after {batch_failures} failed sends in one batch. "
                f"Last error: {recipient.error_message}",
            )
            return
