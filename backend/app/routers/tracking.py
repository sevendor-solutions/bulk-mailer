import logging
from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import RedirectResponse, HTMLResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update, delete, func, or_
from urllib.parse import unquote
from app.database import get_db, AsyncSessionLocal
from app.models.campaign import Recipient, Campaign
from app.models.tracking import TrackingEvent
from app.models.suppression import SuppressionList

logger = logging.getLogger(__name__)

router = APIRouter(tags=["tracking"])

# 1x1 transparent GIF pixel
PIXEL_GIF = bytes([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00,
    0x80, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x21,
    0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00,
    0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44,
    0x01, 0x00, 0x3b
])


@router.get("/track/open/{recipient_id}")
async def track_open(recipient_id: str, request: Request):
    """Track email open via tracking pixel."""
    try:
        async with AsyncSessionLocal() as db:
            # Identifier can be numeric ID or public_code string
            if str(recipient_id).isdigit():
                result = await db.execute(
                    select(Recipient).where(or_(Recipient.id == int(recipient_id), Recipient.public_code == str(recipient_id)))
                )
            else:
                result = await db.execute(
                    select(Recipient).where(Recipient.public_code == str(recipient_id))
                )
            recipient = result.scalar_one_or_none()
            if recipient:
                # Check for earlier open to record first_open accurately
                existing = await db.execute(
                    select(TrackingEvent.id).where(
                        TrackingEvent.recipient_id == recipient.id,
                        TrackingEvent.event_type == "open",
                    ).limit(1)
                )
                first_open = existing.first() is None

                # Log tracking event
                event = TrackingEvent(
                    recipient_id=recipient.id,
                    campaign_id=recipient.campaign_id,
                    event_type="open",
                    metadata_json={
                        "user_agent": request.headers.get("user-agent"),
                        "ip": request.client.host if request.client else None,
                    },
                )
                db.add(event)

                # Update campaign stats (only increment once per recipient)
                if first_open:
                    await db.execute(
                        update(Campaign)
                        .where(Campaign.id == recipient.campaign_id)
                        .values(opened_count=func.coalesce(Campaign.opened_count, 0) + 1)
                    )

                await db.commit()
    except Exception as exc:
        logger.error(f"Error recording open event for recipient {recipient_id}: {exc}")

    return Response(
        content=PIXEL_GIF,
        media_type="image/gif",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0, proxy-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
            "Access-Control-Allow-Origin": "*",
        },
    )


@router.get("/track/click/{recipient_id}")
async def track_click(recipient_id: str, url: str, cid: int = None, request: Request = None):
    """Track link click and redirect to original URL."""
    original_url = unquote(url)

    try:
        async with AsyncSessionLocal() as db:
            if str(recipient_id).isdigit():
                result = await db.execute(
                    select(Recipient).where(or_(Recipient.id == int(recipient_id), Recipient.public_code == str(recipient_id)))
                )
            else:
                result = await db.execute(
                    select(Recipient).where(Recipient.public_code == str(recipient_id))
                )
            recipient = result.scalar_one_or_none()
            if recipient:
                campaign_id = recipient.campaign_id
                existing = await db.execute(
                    select(TrackingEvent.id).where(
                        TrackingEvent.recipient_id == recipient.id,
                        TrackingEvent.event_type == "click",
                    ).limit(1)
                )
                first_click = existing.first() is None

                event = TrackingEvent(
                    recipient_id=recipient.id,
                    campaign_id=campaign_id,
                    event_type="click",
                    metadata_json={
                        "url": original_url,
                        "user_agent": request.headers.get("user-agent") if request else None,
                        "ip": request.client.host if request and request.client else None,
                    },
                )
                db.add(event)

                # Update campaign click count (first click per recipient)
                if first_click:
                    await db.execute(
                        update(Campaign)
                        .where(Campaign.id == campaign_id)
                        .values(clicked_count=func.coalesce(Campaign.clicked_count, 0) + 1)
                    )

                await db.commit()
    except Exception as exc:
        logger.error(f"Error recording click event for recipient {recipient_id}: {exc}")

    return RedirectResponse(url=original_url, status_code=302)


@router.get("/unsubscribe/{recipient_id}")
async def unsubscribe_page(recipient_id: str):
    """Show unsubscribe or resubscribe page based on recipient's current status."""
    recipient = None
    is_suppressed = False

    async with AsyncSessionLocal() as db:
        if str(recipient_id).isdigit():
            result = await db.execute(
                select(Recipient).where(or_(Recipient.id == int(recipient_id), Recipient.public_code == str(recipient_id)))
            )
        else:
            result = await db.execute(
                select(Recipient).where(Recipient.public_code == str(recipient_id))
            )
        recipient = result.scalar_one_or_none()
        if recipient:
            email_clean = recipient.email.strip().lower()
            supp = await db.execute(
                select(SuppressionList.id).where(
                    func.lower(SuppressionList.email) == email_clean,
                    SuppressionList.scope == "global",
                ).limit(1)
            )
            is_suppressed = bool(supp.scalar_one_or_none()) or recipient.status == "unsubscribed"

    if not recipient:
        return HTMLResponse(content="""
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><title>Not Found</title></head>
        <body style="font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f3f4f6;">
            <div style="background:white;padding:2rem;border-radius:12px;box-shadow:0 4px 6px -1px rgba(0,0,0,0.1);text-align:center;">
                <h3>Recipient not found or link expired.</h3>
            </div>
        </body></html>
        """, status_code=404)

    if is_suppressed:
        html = f"""
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Subscription Status</title>
            <style>
                body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f3f4f6; color: #1f2937; }}
                .card {{ background: white; padding: 2.5rem; border-radius: 16px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1); text-align: center; max-width: 440px; width: 90%; }}
                .badge {{ display: inline-block; padding: 4px 12px; border-radius: 9999px; font-size: 13px; font-weight: 600; background: #fee2e2; color: #991b1b; margin-bottom: 1rem; }}
                h2 {{ margin: 0 0 0.5rem 0; font-size: 22px; color: #111827; }}
                p {{ color: #4b5563; font-size: 15px; line-height: 1.5; margin: 0 0 1.5rem 0; }}
                .email {{ font-weight: 600; color: #111827; word-break: break-all; }}
                button {{ background: #10b981; color: white; border: none; padding: 12px 28px; border-radius: 8px; cursor: pointer; font-size: 15px; font-weight: 600; transition: background 0.2s; }}
                button:hover {{ background: #059669; }}
            </style>
        </head>
        <body>
            <div class="card">
                <span class="badge">Currently Unsubscribed</span>
                <h2>Subscription Status</h2>
                <p>The address <span class="email">{recipient.email}</span> is currently unsubscribed and will not receive future emails from us.</p>
                <form method="POST" action="/unsubscribe/{recipient_id}/resubscribe">
                    <button type="submit">Re-subscribe / Receive Emails Again</button>
                </form>
            </div>
        </body>
        </html>
        """
        return HTMLResponse(content=html)

    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Unsubscribe</title>
        <style>
            body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f3f4f6; color: #1f2937; }}
            .card {{ background: white; padding: 2.5rem; border-radius: 16px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1); text-align: center; max-width: 440px; width: 90%; }}
            h2 {{ margin: 0 0 0.5rem 0; font-size: 22px; color: #111827; }}
            p {{ color: #4b5563; font-size: 15px; line-height: 1.5; margin: 0 0 1.5rem 0; }}
            .email {{ font-weight: 600; color: #111827; word-break: break-all; }}
            button {{ background: #dc2626; color: white; border: none; padding: 12px 28px; border-radius: 8px; cursor: pointer; font-size: 15px; font-weight: 600; transition: background 0.2s; }}
            button:hover {{ background: #b91c1c; }}
        </style>
    </head>
    <body>
        <div class="card">
            <h2>Unsubscribe</h2>
            <p>Are you sure you want to unsubscribe <span class="email">{recipient.email}</span> from future emails?</p>
            <form method="POST" action="/unsubscribe/{recipient_id}/confirm">
                <button type="submit">Yes, Unsubscribe Me</button>
            </form>
        </div>
    </body>
    </html>
    """
    return HTMLResponse(content=html)


@router.post("/unsubscribe/{recipient_id}")
async def one_click_unsubscribe(recipient_id: str):
    """One-click unsubscribe: mail clients POST to the List-Unsubscribe URL."""
    return await confirm_unsubscribe(recipient_id)


@router.post("/unsubscribe/{recipient_id}/confirm")
async def confirm_unsubscribe(recipient_id: str):
    """Process unsubscribe confirmation and add to global suppression list."""
    recipient_email = ""
    async with AsyncSessionLocal() as db:
        if str(recipient_id).isdigit():
            result = await db.execute(
                select(Recipient).where(or_(Recipient.id == int(recipient_id), Recipient.public_code == str(recipient_id)))
            )
        else:
            result = await db.execute(
                select(Recipient).where(Recipient.public_code == str(recipient_id))
            )
        recipient = result.scalar_one_or_none()

        if recipient:
            recipient_email = recipient.email
            email_clean = recipient.email.strip().lower()

            if recipient.status != "unsubscribed":
                recipient.status = "unsubscribed"

                # Update campaign stats
                await db.execute(
                    update(Campaign)
                    .where(Campaign.id == recipient.campaign_id)
                    .values(unsubscribed_count=Campaign.unsubscribed_count + 1)
                )

                # Log event
                event = TrackingEvent(
                    recipient_id=recipient_id,
                    campaign_id=recipient.campaign_id,
                    event_type="unsubscribe",
                )
                db.add(event)

            # Ensure email is in global suppression list
            existing = await db.execute(
                select(SuppressionList.id).where(
                    func.lower(SuppressionList.email) == email_clean,
                    SuppressionList.scope == "global",
                )
            )
            if not existing.scalar_one_or_none():
                from app.services.public_codes import generate_unique_public_code, PREFIXES
                suppression = SuppressionList(
                    public_code=await generate_unique_public_code(db, SuppressionList, PREFIXES["suppression"]),
                    email=recipient_email,
                    scope="global",
                    reason="unsubscribe",
                )
                db.add(suppression)

            await db.commit()

    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Unsubscribed</title>
        <style>
            body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f3f4f6; color: #1f2937; }}
            .card {{ background: white; padding: 2.5rem; border-radius: 16px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1); text-align: center; max-width: 440px; width: 90%; }}
            .icon {{ font-size: 42px; color: #f59e0b; margin-bottom: 0.5rem; }}
            h2 {{ margin: 0 0 0.5rem 0; font-size: 22px; color: #111827; }}
            p {{ color: #4b5563; font-size: 15px; line-height: 1.5; margin: 0 0 1rem 0; }}
            .email {{ font-weight: 600; color: #111827; word-break: break-all; }}
            .resub-btn {{ background: #10b981; color: white; border: none; padding: 10px 24px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; transition: background 0.2s; }}
            .resub-btn:hover {{ background: #059669; }}
        </style>
    </head>
    <body>
        <div class="card">
            <div class="icon">✓</div>
            <h2>Unsubscribed</h2>
            <p>You have been successfully unsubscribed. <span class="email">{recipient_email or 'Your address'}</span> will no longer receive emails from us.</p>
            <div style="margin-top: 2rem; padding-top: 1.5rem; border-top: 1px solid #e5e7eb;">
                <p style="font-size: 13px; color: #6b7280; margin-bottom: 0.75rem;">Did you unsubscribe by mistake?</p>
                <form method="POST" action="/unsubscribe/{recipient_id}/resubscribe">
                    <button type="submit" class="resub-btn">Re-subscribe / Subscribe Again</button>
                </form>
            </div>
        </div>
    </body>
    </html>
    """
    return HTMLResponse(content=html)


@router.get("/resubscribe/{recipient_id}")
async def resubscribe_get(recipient_id: str):
    """GET endpoint to show or process resubscribe."""
    return await resubscribe_recipient(recipient_id)


@router.post("/unsubscribe/{recipient_id}/resubscribe")
@router.post("/resubscribe/{recipient_id}")
async def resubscribe_recipient(recipient_id: str):
    """Re-subscribe recipient: removes from suppression list and restores pending status."""
    recipient_email = ""
    async with AsyncSessionLocal() as db:
        if str(recipient_id).isdigit():
            result = await db.execute(
                select(Recipient).where(or_(Recipient.id == int(recipient_id), Recipient.public_code == str(recipient_id)))
            )
        else:
            result = await db.execute(
                select(Recipient).where(Recipient.public_code == str(recipient_id))
            )
        recipient = result.scalar_one_or_none()

        if not recipient:
            return HTMLResponse(content="<h3>Recipient not found</h3>", status_code=404)

        recipient_email = recipient.email
        email_clean = recipient.email.strip().lower()

        # 1. Remove from global SuppressionList
        await db.execute(
            delete(SuppressionList).where(
                func.lower(SuppressionList.email) == email_clean,
                SuppressionList.scope == "global",
            )
        )

        # 2. If this recipient in this campaign was unsubscribed and not yet sent, restore to pending
        if recipient.status == "unsubscribed" and not recipient.sent_at:
            recipient.status = "pending"
            recipient.error_message = None

            # Adjust campaign unsubscribed_count if positive
            await db.execute(
                update(Campaign)
                .where(Campaign.id == recipient.campaign_id, Campaign.unsubscribed_count > 0)
                .values(unsubscribed_count=Campaign.unsubscribed_count - 1)
            )

        # 3. Restore any other unsent recipients with this email across all campaigns
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

        # 4. Record resubscribe tracking event
        event = TrackingEvent(
            recipient_id=recipient_id,
            campaign_id=recipient.campaign_id,
            event_type="resubscribe",
        )
        db.add(event)

        await db.commit()

    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Re-Subscribed</title>
        <style>
            body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f3f4f6; color: #1f2937; }}
            .card {{ background: white; padding: 2.5rem; border-radius: 16px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1); text-align: center; max-width: 440px; width: 90%; }}
            .icon {{ font-size: 42px; color: #10b981; margin-bottom: 0.5rem; }}
            h2 {{ margin: 0 0 0.5rem 0; font-size: 22px; color: #111827; }}
            p {{ color: #4b5563; font-size: 15px; line-height: 1.5; margin: 0 0 1rem 0; }}
            .email {{ font-weight: 600; color: #111827; word-break: break-all; }}
            .unsub-btn {{ background: #6b7280; color: white; border: none; padding: 8px 18px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; transition: background 0.2s; }}
            .unsub-btn:hover {{ background: #4b5563; }}
        </style>
    </head>
    <body>
        <div class="card">
            <div class="icon">✓</div>
            <h2>Successfully Re-Subscribed!</h2>
            <p>Welcome back! <span class="email">{recipient_email}</span> is now subscribed to our mailing list and will receive future emails.</p>
            <div style="margin-top: 2rem; padding-top: 1.5rem; border-top: 1px solid #e5e7eb;">
                <p style="font-size: 13px; color: #6b7280; margin-bottom: 0.75rem;">Changed your mind?</p>
                <form method="POST" action="/unsubscribe/{recipient_id}/confirm">
                    <button type="submit" class="unsub-btn">Unsubscribe again</button>
                </form>
            </div>
        </div>
    </body>
    </html>
    """
    return HTMLResponse(content=html)
