"""Org and campaign analytics endpoints for dashboard insights."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, case, cast, String, Date
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db, engine
from app.models.user import User
from app.models.campaign import Campaign, Recipient
from app.models.tracking import TrackingEvent
from app.models.settings_model import AppSettings
from app.utils.dependencies import get_current_user
from app.routers.campaigns import _get_campaign, _get_campaign_mode
import json

router = APIRouter(prefix="/analytics", tags=["analytics"])


def _date_bucket(col, granularity: str):
    if engine.dialect.name == "postgresql":
        pg_fmt = "YYYY-MM-DD HH24:00" if granularity == "hour" else "YYYY-MM-DD"
        return func.to_char(col, pg_fmt)
    sqlite_fmt = "%Y-%m-%d %H:00" if granularity == "hour" else "%Y-%m-%d"
    return func.strftime(sqlite_fmt, col)


def _parse_range(from_s: Optional[str], to_s: Optional[str], default_days: int = 30):
    now = datetime.now(timezone.utc)
    end = datetime.fromisoformat(to_s.replace("Z", "+00:00")) if to_s else now
    start = datetime.fromisoformat(from_s.replace("Z", "+00:00")) if from_s else end - timedelta(days=default_days)
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    return start, end


async def _visible_campaign_filter(db: AsyncSession, user: User):
    mode = await _get_campaign_mode(db)
    if user.role == "admin" or mode == "global":
        return True, None
    return False, user.id


@router.get("/overview")
async def analytics_overview(
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    start, end = _parse_range(from_, to, 30)
    period = end - start
    prev_start, prev_end = start - period, start

    is_global, owner_id = await _visible_campaign_filter(db, current_user)

    async def aggregate(a: datetime, b: datetime):
        q = select(
            func.coalesce(func.sum(Campaign.sent_count), 0),
            func.coalesce(func.sum(Campaign.opened_count), 0),
            func.coalesce(func.sum(Campaign.clicked_count), 0),
            func.coalesce(func.sum(Campaign.bounced_count), 0),
            func.coalesce(func.sum(Campaign.failed_count), 0),
            func.coalesce(func.sum(Campaign.unsubscribed_count), 0),
            func.coalesce(func.sum(Campaign.total_recipients), 0),
            func.count(Campaign.id),
        ).where(
            Campaign.created_at >= a,
            Campaign.created_at <= b,
        )
        if not is_global and owner_id is not None:
            q = q.where(Campaign.created_by == owner_id)
        row = (await db.execute(q)).one()
        sent, opened, clicked, bounced, failed, unsub, recipients, campaigns = [int(x or 0) for x in row]

        # Complaints from tracking events in window
        cq = select(func.count()).select_from(TrackingEvent).where(
            TrackingEvent.event_type == "complaint",
            TrackingEvent.created_at >= a,
            TrackingEvent.created_at <= b,
        )
        complaints = int((await db.execute(cq)).scalar() or 0)

        delivery = (max(sent - bounced, 0) / sent * 100) if sent else 0
        open_rate = (opened / sent * 100) if sent else 0
        click_rate = (clicked / sent * 100) if sent else 0
        ctr = (clicked / opened * 100) if opened else 0
        bounce_rate = (bounced / sent * 100) if sent else 0
        return {
            "sent": sent,
            "opened": opened,
            "clicked": clicked,
            "bounced": bounced,
            "failed": failed,
            "unsubscribed": unsub,
            "complaints": complaints,
            "recipients": recipients,
            "campaigns": campaigns,
            "delivery_rate": round(delivery, 1),
            "open_rate": round(open_rate, 1),
            "click_rate": round(click_rate, 1),
            "ctr": round(ctr, 1),
            "bounce_rate": round(bounce_rate, 1),
        }

    current = await aggregate(start, end)
    previous = await aggregate(prev_start, prev_end)

    def delta(cur, prev):
        if prev == 0:
            return 100.0 if cur else 0.0
        return round((cur - prev) / prev * 100, 1)

    deltas = {k: delta(current[k], previous[k]) for k in current if isinstance(current[k], (int, float))}

    # Active sending
    aq = select(Campaign).where(Campaign.status.in_(["sending", "scheduled"]))
    if not is_global and owner_id is not None:
        aq = aq.where(Campaign.created_by == owner_id)
    active = (await db.execute(aq.order_by(Campaign.updated_at.desc().nullslast()).limit(10))).scalars().all()

    return {
        "from": start.isoformat(),
        "to": end.isoformat(),
        "current": current,
        "previous": previous,
        "deltas": deltas,
        "active_campaigns": [
            {
                "public_code": c.public_code,
                "name": c.name,
                "status": c.status,
                "sent_count": c.sent_count,
                "total_recipients": c.total_recipients,
                "failed_count": c.failed_count,
            }
            for c in active
        ],
    }


@router.get("/timeseries")
async def analytics_timeseries(
    granularity: str = Query("day", pattern="^(day|hour)$"),
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    campaign_code: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    start, end = _parse_range(from_, to, 30)
    campaign_id = None
    if campaign_code:
        c = await _get_campaign(campaign_code, current_user, db)
        campaign_id = c.id

    # Build buckets from tracking events + sent_at
    fmt = "%Y-%m-%d %H:00" if granularity == "hour" else "%Y-%m-%d"

    async def series(event_type: Optional[str] = None, use_sent: bool = False):
        if use_sent:
            b_expr = _date_bucket(Recipient.sent_at, granularity)
            q = select(
                b_expr,
                func.count(Recipient.id),
            ).where(
                Recipient.sent_at.isnot(None),
                Recipient.sent_at >= start,
                Recipient.sent_at <= end,
            )
            if campaign_id:
                q = q.where(Recipient.campaign_id == campaign_id)
            q = q.group_by(b_expr).order_by(b_expr)
        else:
            b_expr = _date_bucket(TrackingEvent.created_at, granularity)
            q = select(
                b_expr,
                func.count(TrackingEvent.id),
            ).where(
                TrackingEvent.created_at >= start,
                TrackingEvent.created_at <= end,
                TrackingEvent.event_type == event_type,
            )
            if campaign_id:
                q = q.where(TrackingEvent.campaign_id == campaign_id)
            q = q.group_by(b_expr).order_by(b_expr)
        rows = (await db.execute(q)).all()
        return [{"bucket": r[0], "count": int(r[1])} for r in rows if r[0]]

    return {
        "granularity": granularity,
        "sent": await series(use_sent=True),
        "opens": await series("open"),
        "clicks": await series("click"),
    }


@router.get("/campaigns/{campaign_code}")
async def campaign_analytics(
    campaign_code: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    campaign = await _get_campaign(campaign_code, current_user, db)
    sent = campaign.sent_count or 0
    opened = campaign.opened_count or 0
    clicked = campaign.clicked_count or 0
    bounced = campaign.bounced_count or 0
    failed = campaign.failed_count or 0
    unsub = campaign.unsubscribed_count or 0

    status_q = await db.execute(
        select(Recipient.status, func.count(Recipient.id))
        .where(Recipient.campaign_id == campaign.id)
        .group_by(Recipient.status)
    )
    by_status = {r[0]: int(r[1]) for r in status_q.all()}

    included_q = await db.execute(
        select(func.count()).select_from(Recipient).where(
            Recipient.campaign_id == campaign.id, Recipient.is_included == True
        )
    )
    included = int(included_q.scalar() or 0)

    duration_sec = None
    if campaign.started_at and campaign.completed_at:
        duration_sec = int((campaign.completed_at - campaign.started_at).total_seconds())

    complaints = int((await db.execute(
        select(func.count()).select_from(TrackingEvent).where(
            TrackingEvent.campaign_id == campaign.id,
            TrackingEvent.event_type == "complaint",
        )
    )).scalar() or 0)

    return {
        "public_code": campaign.public_code,
        "name": campaign.name,
        "status": campaign.status,
        "funnel": {
            "included": included,
            "sent": sent,
            "opened": opened,
            "clicked": clicked,
            "unsubscribed": unsub,
            "bounced": bounced,
            "failed": failed,
            "complaints": complaints,
        },
        "rates": {
            # failed sends were never counted in sent, so only bounces come off
            "delivery": round((max(sent - bounced, 0) / sent * 100) if sent else 0, 1),
            "open": round((opened / sent * 100) if sent else 0, 1),
            "click": round((clicked / sent * 100) if sent else 0, 1),
            "ctr": round((clicked / opened * 100) if opened else 0, 1),
            "bounce": round((bounced / sent * 100) if sent else 0, 1),
        },
        "by_status": by_status,
        "duration_seconds": duration_sec,
        "started_at": campaign.started_at.isoformat() if campaign.started_at else None,
        "completed_at": campaign.completed_at.isoformat() if campaign.completed_at else None,
    }


@router.get("/campaigns/{campaign_code}/events/timeseries")
async def campaign_events_timeseries(
    campaign_code: str,
    granularity: str = Query("hour", pattern="^(day|hour)$"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    campaign = await _get_campaign(campaign_code, current_user, db)
    bucket_expr = _date_bucket(TrackingEvent.created_at, granularity)

    async def series(event_type: str):
        q = (
            select(bucket_expr, func.count(TrackingEvent.id))
            .where(
                TrackingEvent.campaign_id == campaign.id,
                TrackingEvent.event_type == event_type,
            )
            .group_by(bucket_expr)
            .order_by(bucket_expr)
        )
        return [{"bucket": r[0], "count": int(r[1])} for r in (await db.execute(q)).all() if r[0]]

    return {"opens": await series("open"), "clicks": await series("click")}


@router.get("/campaigns/{campaign_code}/links")
async def campaign_links(
    campaign_code: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    campaign = await _get_campaign(campaign_code, current_user, db)
    if engine.dialect.name == "postgresql":
        url_expr = TrackingEvent.metadata_json["url"].as_string()
    else:
        url_expr = func.json_extract(TrackingEvent.metadata_json, "$.url")

    q = await db.execute(
        select(
            url_expr,
            func.count(TrackingEvent.id),
        )
        .where(
            TrackingEvent.campaign_id == campaign.id,
            TrackingEvent.event_type == "click",
        )
        .group_by(url_expr)
        .order_by(func.count(TrackingEvent.id).desc())
        .limit(50)
    )
    sent = campaign.sent_count or 0
    links = []
    for url, count in q.all():
        if not url:
            continue
        links.append({
            "url": url,
            "clicks": int(count),
            "ctr": round((int(count) / sent * 100) if sent else 0, 2),
        })
    return {"links": links, "sent": sent}
