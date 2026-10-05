import logging
from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import RedirectResponse, HTMLResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update, func, or_
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
async def unsubscribe_page(recipient_id: int):
    """Show unsubscribe confirmation page."""
    html = f"""
    <!DOCTYPE html>
    <html>
    <head><title>Unsubscribe</title>
    <style>
        body {{ font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }}
        .card {{ background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }}
        button {{ background: #dc3545; color: white; border: none; padding: 12px 24px; border-radius: 4px; cursor: pointer; font-size: 16px; }}
        button:hover {{ background: #c82333; }}
    </style>
    </head>
    <body>
        <div class="card">
            <h2>Unsubscribe</h2>
            <p>Are you sure you want to unsubscribe from future emails?</p>
            <form method="POST" action="/unsubscribe/{recipient_id}/confirm">
                <button type="submit">Yes, Unsubscribe Me</button>
            </form>
        </div>
    </body>
    </html>
    """
    return HTMLResponse(content=html)


@router.post("/unsubscribe/{recipient_id}")
async def one_click_unsubscribe(recipient_id: int):
    """One-click unsubscribe (RFC 8058): mail clients POST to the List-Unsubscribe URL."""
    return await confirm_unsubscribe(recipient_id)


@router.post("/unsubscribe/{recipient_id}/confirm")
async def confirm_unsubscribe(recipient_id: int):
    """Process unsubscribe confirmation."""
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Recipient).where(Recipient.id == recipient_id))
        recipient = result.scalar_one_or_none()

        # Repeating the request must not count the same person twice
        if recipient and recipient.status != "unsubscribed":
            # Update recipient status
            recipient.status = "unsubscribed"

            # Add to global suppression list
            existing = await db.execute(
                select(SuppressionList).where(
                    SuppressionList.email == recipient.email,
                    SuppressionList.scope == "global",
                )
            )
            if not existing.scalar_one_or_none():
                from app.services.public_codes import generate_unique_public_code, PREFIXES
                suppression = SuppressionList(
                    public_code=await generate_unique_public_code(db, SuppressionList, PREFIXES["suppression"]),
                    email=recipient.email,
                    scope="global",
                    reason="unsubscribe",
                )
                db.add(suppression)

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

            await db.commit()

    html = """
    <!DOCTYPE html>
    <html>
    <head><title>Unsubscribed</title>
    <style>
        body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
        .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
    </style>
    </head>
    <body>
        <div class="card">
            <h2>✓ Unsubscribed</h2>
            <p>You have been successfully unsubscribed. You will no longer receive emails from us.</p>
        </div>
    </body>
    </html>
    """
    return HTMLResponse(content=html)
