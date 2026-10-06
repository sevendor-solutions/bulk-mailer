from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, delete
from app.database import get_db
from app.models.user import User
from app.models.campaign import Campaign, Recipient, UploadJob, ImportMappingProfile
from app.models.template import Template
from app.models.suppression import SuppressionList
from app.models.settings_model import AppSettings
from app.schemas.campaign import (
    CampaignCreate, CampaignUpdate, CampaignResponse,
    ColumnMappingRequest, UploadResponse, UploadStatusResponse,
    SendCampaignRequest, PreviewRecipientResponse, PreviewRenderRequest,
    PreviewRenderResponse, SuggestMappingRequest, SuggestMappingResponse,
)
from app.utils.dependencies import get_current_user
from app.services.file_parser import (
    parse_csv_headers, parse_excel_headers,
    parse_csv_rows, parse_excel_rows,
    validate_email_address, count_rows,
)
from app.services.merge_engine import (
    build_render_context, render_campaign_content, normalize_field_key,
    compute_header_signature, auto_map_template_fields, extract_merge_fields,
)
from app.services.public_codes import generate_unique_public_code, PREFIXES
from app.services.provider_config import provider_problem
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timezone
import os
import json
from sqlalchemy import delete, or_, and_, update

router = APIRouter(prefix="/campaigns", tags=["campaigns"])

UPLOAD_DIR = "./uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)


async def _get_campaign_mode(db: AsyncSession) -> str:
    """Get campaign visibility mode from settings."""
    result = await db.execute(select(AppSettings).where(AppSettings.key == "campaign_mode"))
    setting = result.scalar_one_or_none()
    if setting and setting.value:
        return json.loads(setting.value)
    return "global"


def _campaign_to_response(campaign: Campaign) -> CampaignResponse:
    """Convert Campaign model to response with creator_name."""
    data = CampaignResponse.model_validate(campaign)
    if campaign.creator:
        data.creator_name = campaign.creator.full_name
    return data


@router.get("/", response_model=list[CampaignResponse])
async def list_campaigns(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    mode = await _get_campaign_mode(db)

    if current_user.role == "admin" or mode == "global":
        result = await db.execute(
            select(Campaign).order_by(Campaign.created_at.desc())
        )
    else:
        result = await db.execute(
            select(Campaign)
            .where(Campaign.created_by == current_user.id)
            .order_by(Campaign.created_at.desc())
        )
    campaigns = result.scalars().all()
    # Eager load creator names
    for c in campaigns:
        await db.refresh(c, ["creator"])
    return [_campaign_to_response(c) for c in campaigns]


@router.post("/", response_model=CampaignResponse, status_code=201)
async def create_campaign(
    data: CampaignCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Check for duplicate name
    existing = await db.execute(
        select(Campaign).where(Campaign.name == data.name)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(409, "A campaign with this name already exists")

    campaign = Campaign(
        public_code=await generate_unique_public_code(db, Campaign, PREFIXES["campaign"]),
        name=data.name,
        subject=data.subject,
        from_email=data.from_email,
        from_name=data.from_name,
        reply_to=data.reply_to,
        preheader=data.preheader,
        created_by=current_user.id,
    )
    db.add(campaign)
    await db.commit()
    await db.refresh(campaign, ["creator"])
    return _campaign_to_response(campaign)


@router.get("/{campaign_code}", response_model=CampaignResponse)
async def get_campaign(
    campaign_code: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    campaign = await _get_campaign(campaign_code, current_user, db)
    campaign_id = campaign.id
    await db.refresh(campaign, ["creator"])
    return _campaign_to_response(campaign)


@router.patch("/{campaign_code}", response_model=CampaignResponse)
async def update_campaign(
    campaign_code: str,
    data: CampaignUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    campaign = await _get_campaign(campaign_code, current_user, db)
    campaign_id = campaign.id
    if campaign.status not in ("draft", "paused"):
        raise HTTPException(400, "Cannot edit campaign in current status")

    update_data = data.model_dump(exclude_unset=True)

    # Check for duplicate name if name is being changed
    if "name" in update_data and update_data["name"] != campaign.name:
        existing = await db.execute(
            select(Campaign).where(Campaign.name == update_data["name"], Campaign.id != campaign_id)
        )
        if existing.scalar_one_or_none():
            raise HTTPException(409, "A campaign with this name already exists")

    for field, value in update_data.items():
        setattr(campaign, field, value)

    await db.commit()
    await db.refresh(campaign, ["creator"])
    return _campaign_to_response(campaign)


@router.post("/{campaign_code}/clone", response_model=CampaignResponse, status_code=201)
async def clone_campaign(
    campaign_code: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Clone an existing campaign as a new draft."""
    source = await _get_campaign(campaign_code, current_user, db)
    clone = Campaign(
        public_code=await generate_unique_public_code(db, Campaign, PREFIXES["campaign"]),
        name=f"{source.name} (Copy)",
        subject=source.subject,
        from_email=source.from_email,
        from_name=source.from_name,
        reply_to=source.reply_to,
        sender_identity_id=source.sender_identity_id,
        editor_type=source.editor_type,
        content_json=source.content_json,
        html_body=source.html_body,
        preheader=source.preheader,
        theme_config=source.theme_config,
        created_by=current_user.id,
    )
    db.add(clone)
    await db.commit()
    await db.refresh(clone, ["creator"])
    return _campaign_to_response(clone)


@router.delete("/{campaign_code}", status_code=204)
async def delete_campaign(
    campaign_code: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    campaign = await _get_campaign(campaign_code, current_user, db)
    campaign_id = campaign.id
    if campaign.status == "sending":
        raise HTTPException(400, "Cannot delete a campaign that is currently sending")

    # 1. Nullify source_campaign_id references
    await db.execute(update(Campaign).where(Campaign.source_campaign_id == campaign_id).values(source_campaign_id=None))
    await db.execute(update(ImportMappingProfile).where(ImportMappingProfile.source_campaign_id == campaign_id).values(source_campaign_id=None))

    # 2. Delete tracking events
    from app.models.tracking import TrackingEvent
    await db.execute(delete(TrackingEvent).where(TrackingEvent.campaign_id == campaign_id))

    # 3. Delete recipients
    await db.execute(delete(Recipient).where(Recipient.campaign_id == campaign_id))

    # 4. Delete upload jobs
    await db.execute(delete(UploadJob).where(UploadJob.campaign_id == campaign_id))

    # 5. Delete attachments
    from app.models.campaign import CampaignAttachment
    await db.execute(delete(CampaignAttachment).where(CampaignAttachment.campaign_id == campaign_id))

    # 6. Delete template snapshots and composer revisions
    try:
        from app.models.composer import CampaignTemplateSnapshot, TemplateRevision, ValidationReportRecord
        await db.execute(delete(CampaignTemplateSnapshot).where(CampaignTemplateSnapshot.campaign_id == campaign_id))
        rev_result = await db.execute(select(TemplateRevision.id).where(TemplateRevision.campaign_id == campaign_id))
        rev_ids = [r[0] for r in rev_result.fetchall()]
        if rev_ids:
            await db.execute(delete(ValidationReportRecord).where(ValidationReportRecord.revision_id.in_(rev_ids)))
            await db.execute(delete(TemplateRevision).where(TemplateRevision.id.in_(rev_ids)))
    except Exception:
        pass

    # 7. Delete the campaign
    await db.delete(campaign)
    await db.commit()


class ImportRecipientsRequest(BaseModel):
    source_campaign_code: str


@router.post("/{campaign_code}/import-recipients")
async def import_recipients_from_campaign(
    campaign_code: str,
    req: ImportRecipientsRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Copy recipients from another campaign into this one."""
    target = await _get_campaign(campaign_code, current_user, db)
    campaign_id = target.id
    if target.status != "draft":
        raise HTTPException(400, "Can only import recipients into draft campaigns")

    source = await _get_campaign(req.source_campaign_code, current_user, db)
    if source.id == campaign_id:
        raise HTTPException(400, "Cannot import from the same campaign")

    # Get existing emails in target to deduplicate
    existing_result = await db.execute(
        select(Recipient.email).where(Recipient.campaign_id == campaign_id)
    )
    existing_emails = set(row[0].lower() for row in existing_result.fetchall())

    # Get suppression list
    suppression_result = await db.execute(select(SuppressionList.email))
    suppressed_emails = set(row[0].lower() for row in suppression_result.fetchall())

    # Get source recipients ordered by row_index for deterministic copy
    source_result = await db.execute(
        select(Recipient)
        .where(Recipient.campaign_id == source.id, Recipient.is_included == True)
        .order_by(Recipient.row_index.asc().nullslast(), Recipient.id.asc())
    )
    source_recipients = source_result.scalars().all()

    copied = 0
    duplicates = 0
    suppressed = 0

    for r in source_recipients:
        email_lower = r.email.lower()
        if email_lower in existing_emails:
            duplicates += 1
            continue
        if email_lower in suppressed_emails:
            suppressed += 1
            continue
        db.add(Recipient(
            public_code=await generate_unique_public_code(db, Recipient, PREFIXES["recipient"]),
            campaign_id=campaign_id,
            email=r.email,
            merge_data=r.merge_data,
            row_index=copied,
            is_included=True,
            status="pending",
        ))
        existing_emails.add(email_lower)
        copied += 1

    included = await db.execute(
        select(func.count()).select_from(Recipient).where(
            Recipient.campaign_id == campaign_id, Recipient.is_included == True
        )
    )
    target.total_recipients = included.scalar() or 0
    target.source_campaign_id = source.id

    # Copy field schema from source
    if source.campaign_field_definitions_json:
        target.campaign_field_definitions_json = source.campaign_field_definitions_json
    
    # Copy template bindings if same template
    if source.selected_template_id and source.selected_template_id == target.selected_template_id:
        if source.template_field_bindings_json:
            target.template_field_bindings_json = source.template_field_bindings_json

    await db.commit()

    return {
        "copied": copied,
        "duplicates": duplicates,
        "suppressed": suppressed,
        "total_recipients": target.total_recipients,
        "field_definitions_copied": target.campaign_field_definitions_json is not None,
    }


@router.get("/{campaign_code}/recipients/summary")
async def get_recipients_summary(
    campaign_code: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a summary of recipients in a campaign."""
    campaign = await _get_campaign(campaign_code, current_user, db)
    campaign_id = campaign.id
    result = await db.execute(
        select(Recipient.status, func.count(Recipient.id))
        .where(Recipient.campaign_id == campaign_id)
        .group_by(Recipient.status)
    )
    by_status = {row[0]: row[1] for row in result.fetchall()}
    total = sum(by_status.values())
    included_result = await db.execute(
        select(func.count()).select_from(Recipient).where(
            Recipient.campaign_id == campaign_id, Recipient.is_included == True
        )
    )
    included = included_result.scalar() or 0
    return {
        "total": total,
        "included": included,
        "excluded": max(0, total - included),
        "by_status": by_status,
    }


class RecipientInclusionRequest(BaseModel):
    is_included: bool
    codes: Optional[List[str]] = None
    all: bool = False
    except_codes: Optional[List[str]] = None


@router.get("/{campaign_code}/recipients")
async def list_recipients(
    campaign_code: str,
    page: int = 1,
    page_size: int = 50,
    q: Optional[str] = None,
    included: Optional[bool] = None,
    status: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Paginated recipient list with inclusion and status filters."""
    campaign = await _get_campaign(campaign_code, current_user, db)
    campaign_id = campaign.id
    page = max(1, page)
    page_size = min(max(1, page_size), 200)

    filters = [Recipient.campaign_id == campaign_id]
    if included is not None:
        filters.append(Recipient.is_included == included)
    if status:
        # Accepts one status or several: "pending,sending" is the whole queue
        statuses = [s.strip().lower() for s in status.split(",") if s.strip()]
        if statuses:
            filters.append(Recipient.status.in_(statuses))
    if q:
        like = f"%{q.strip().lower()}%"
        filters.append(or_(
            func.lower(Recipient.email).like(like),
            func.lower(Recipient.public_code).like(like),
        ))

    total_result = await db.execute(
        select(func.count()).select_from(Recipient).where(*filters)
    )
    total = total_result.scalar() or 0

    result = await db.execute(
        select(Recipient)
        .where(*filters)
        .order_by(Recipient.row_index.asc().nullslast(), Recipient.id.asc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = result.scalars().all()
    items = []
    for r in rows:
        merge = r.merge_data or {}
        name_val = (
            merge.get("name")
            or merge.get("Name")
            or merge.get("full_name")
            or merge.get("FullName")
            or merge.get("first_name")
            or merge.get("FirstName")
            or merge.get("contact_name")
            or ""
        )
        items.append({
            "public_code": r.public_code,
            "email": r.email,
            "name": name_val,
            "merge_data": merge,
            "is_included": bool(r.is_included),
            "status": r.status,
            "error_message": r.error_message,
            "row_index": r.row_index,
            "sent_at": r.sent_at.isoformat() if r.sent_at else None,
            "retry_count": r.retry_count or 0,
            "next_attempt_at": r.next_attempt_at.isoformat() if r.next_attempt_at else None,
        })
    return {"items": items, "total": total, "page": page, "page_size": page_size}


@router.patch("/{campaign_code}/recipients/inclusion")
async def update_recipients_inclusion(
    campaign_code: str,
    req: RecipientInclusionRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Bulk include/exclude recipients. Send uses only is_included=True."""
    campaign = await _get_campaign(campaign_code, current_user, db)
    campaign_id = campaign.id
    if campaign.status not in ("draft", "paused"):
        raise HTTPException(400, "Cannot change inclusion for a campaign that is sending or completed")

    if req.all:
        except_codes = {(c or "").strip().upper() for c in (req.except_codes or [])}
        result = await db.execute(select(Recipient).where(Recipient.campaign_id == campaign_id))
        for r in result.scalars().all():
            if r.public_code and r.public_code.upper() in except_codes:
                continue
            r.is_included = req.is_included
            if req.is_included and r.status == "unsubscribed" and not r.sent_at:
                r.status = "pending"
                r.error_message = None
                await db.execute(
                    delete(SuppressionList).where(
                        func.lower(SuppressionList.email) == r.email.lower(),
                        SuppressionList.scope == "global",
                    )
                )
    else:
        if not req.codes:
            raise HTTPException(400, "Provide codes or set all=true")
        codes = [(c or "").strip().upper() for c in req.codes]
        result = await db.execute(
            select(Recipient).where(
                Recipient.campaign_id == campaign_id,
                Recipient.public_code.in_(codes),
            )
        )
        for r in result.scalars().all():
            r.is_included = req.is_included
            if req.is_included and r.status == "unsubscribed" and not r.sent_at:
                r.status = "pending"
                r.error_message = None
                await db.execute(
                    delete(SuppressionList).where(
                        func.lower(SuppressionList.email) == r.email.lower(),
                        SuppressionList.scope == "global",
                    )
                )

    included = await db.execute(
        select(func.count()).select_from(Recipient).where(
            Recipient.campaign_id == campaign_id, Recipient.is_included == True
        )
    )
    campaign.total_recipients = included.scalar() or 0
    await db.commit()
    return {"included": campaign.total_recipients, "is_included": req.is_included}


@router.get("/{campaign_code}/upload/latest")
async def get_latest_upload(
    campaign_code: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Latest upload job + column mapping for wizard restore."""
    campaign = await _get_campaign(campaign_code, current_user, db)
    campaign_id = campaign.id
    result = await db.execute(
        select(UploadJob)
        .where(UploadJob.campaign_id == campaign_id)
        .order_by(UploadJob.id.desc())
        .limit(1)
    )
    job = result.scalar_one_or_none()
    if not job:
        return None
    return {
        "job_id": job.id,
        "filename": job.filename,
        "total_rows": job.total_rows,
        "status": job.status,
        "valid_rows": job.valid_rows,
        "invalid_rows": job.invalid_rows,
        "duplicate_rows": job.duplicate_rows,
        "suppressed_rows": job.suppressed_rows,
        "column_mapping": job.column_mapping,
        "columns": job.source_headers_json or [],
    }


@router.post("/{campaign_code}/upload", response_model=UploadResponse)
async def upload_recipients(
    campaign_code: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    campaign = await _get_campaign(campaign_code, current_user, db)
    campaign_id = campaign.id
    if campaign.status != "draft":
        raise HTTPException(400, "Can only upload recipients for draft campaigns")

    # Validate file type. Only the base name is kept: the name comes from the
    # client and is used to build a path on disk.
    filename = os.path.basename((file.filename or "upload").replace("\\", "/")) or "upload"
    ext = filename.rsplit(".", 1)[-1].lower()
    if ext not in ("csv", "xlsx", "xls"):
        raise HTTPException(400, "Only CSV and Excel files are supported")

    # Read file content
    content = await file.read()

    # Save file
    file_path = os.path.join(UPLOAD_DIR, f"campaign_{campaign_id}_{filename}")
    with open(file_path, "wb") as f:
        f.write(content)

    # Parse headers
    if ext == "csv":
        columns = parse_csv_headers(content)
    else:
        columns = parse_excel_headers(content)

    total_rows = count_rows(content, "csv" if ext == "csv" else "excel")

    # Create upload job
    job = UploadJob(
        campaign_id=campaign_id,
        filename=filename,
        total_rows=total_rows,
        status="pending",
        source_headers_json=columns,
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    return UploadResponse(
        job_id=job.id,
        filename=filename,
        total_rows=total_rows,
        columns=columns,
    )


@router.post("/{campaign_code}/upload/{job_id}/map", response_model=UploadStatusResponse)
async def map_columns_and_process(
    campaign_code: str,
    job_id: int,
    mapping: ColumnMappingRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    campaign = await _get_campaign(campaign_code, current_user, db)
    campaign_id = campaign.id
    # Processing replaces every recipient, which would wipe a send in progress
    if campaign.status != "draft":
        raise HTTPException(400, "Can only map recipients for draft campaigns")

    result = await db.execute(select(UploadJob).where(UploadJob.id == job_id, UploadJob.campaign_id == campaign_id))
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(404, "Upload job not found")

    # Save mapping
    job.column_mapping = mapping.model_dump()
    job.status = "processing"
    
    # Store source headers and signature for mapping reuse
    file_path = os.path.join(UPLOAD_DIR, f"campaign_{campaign_id}_{job.filename}")
    ext = job.filename.rsplit(".", 1)[-1].lower()
    try:
        with open(file_path, "rb") as f:
            content = f.read()
        headers = parse_csv_headers(content) if ext == "csv" else parse_excel_headers(content)
        job.source_headers_json = headers
        job.normalized_header_signature = compute_header_signature(headers)
    except Exception:
        pass
    
    await db.commit()
    
    # Generate and persist campaign field definitions
    field_defs = []
    if mapping.field_definitions:
        field_defs = mapping.field_definitions
    else:
        # Auto-generate from mapping
        if mapping.merge_fields:
            for var_name, col_name in mapping.merge_fields.items():
                key = normalize_field_key(var_name) if var_name else normalize_field_key(col_name)
                field_defs.append({
                    "key": key,
                    "label": col_name,
                    "data_type": "text",
                    "required": False,
                    "default_value": None,
                    "source_kind": "uploaded_column",
                    "source_column": col_name,
                    "is_system": False,
                })
    
    if field_defs:
        campaign.campaign_field_definitions_json = field_defs
        await db.commit()
    
    # Save/update import mapping profile
    if job.normalized_header_signature:
        profile = ImportMappingProfile(
            source_headers_json=job.source_headers_json,
            normalized_header_signature=job.normalized_header_signature,
            column_mapping_json=mapping.model_dump(),
            campaign_field_definitions_json=field_defs or None,
            source_campaign_id=campaign_id,
            created_by=current_user.id,
        )
        db.add(profile)
        await db.commit()

    # Process in background
    background_tasks.add_task(process_upload, job.id, campaign_id, mapping)

    return UploadStatusResponse(
        job_id=job.id,
        status="processing",
        total_rows=job.total_rows,
        processed_rows=0,
        valid_rows=0,
        invalid_rows=0,
        duplicate_rows=0,
        suppressed_rows=0,
    )


@router.get("/{campaign_code}/upload/{job_id}/status", response_model=UploadStatusResponse)
async def get_upload_status(
    campaign_code: str,
    job_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    campaign = await _get_campaign(campaign_code, current_user, db)
    campaign_id = campaign.id
    result = await db.execute(select(UploadJob).where(UploadJob.id == job_id, UploadJob.campaign_id == campaign_id))
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(404, "Upload job not found")

    return UploadStatusResponse(
        job_id=job.id,
        status=job.status,
        total_rows=job.total_rows,
        processed_rows=job.processed_rows,
        valid_rows=job.valid_rows,
        invalid_rows=job.invalid_rows,
        duplicate_rows=job.duplicate_rows,
        suppressed_rows=job.suppressed_rows,
    )


@router.post("/{campaign_code}/send")
async def send_campaign(
    campaign_code: str,
    data: SendCampaignRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    campaign = await _get_campaign(campaign_code, current_user, db)
    campaign_id = campaign.id

    if campaign.status not in ("draft", "paused"):
        raise HTTPException(400, f"Cannot send campaign in '{campaign.status}' status")

    if not campaign.html_body:
        raise HTTPException(400, "Campaign has no email content")

    problem = provider_problem()
    if problem:
        raise HTTPException(400, problem)

    included = await db.execute(
        select(func.count()).select_from(Recipient).where(
            Recipient.campaign_id == campaign.id, Recipient.is_included == True
        )
    )
    included_count = included.scalar() or 0
    campaign.total_recipients = included_count
    if included_count == 0:
        raise HTTPException(400, "Campaign has no included recipients")

    # Admin limits from Settings > Campaign Controls
    controls_row = await db.execute(select(AppSettings).where(AppSettings.key == "campaign_controls"))
    controls_setting = controls_row.scalar_one_or_none()
    controls = json.loads(controls_setting.value) if controls_setting and controls_setting.value else {}
    max_recipients = controls.get("max_recipients")
    if max_recipients and included_count > max_recipients:
        raise HTTPException(
            400,
            f"This campaign has {included_count} recipients; the limit is {max_recipients} per campaign",
        )
    if data.schedule_at and not controls.get("allow_scheduling", True):
        raise HTTPException(400, "Scheduling is disabled by your administrator")

    campaign.last_error = None
    if data.schedule_at:
        schedule_at = data.schedule_at
        # Stored and compared as UTC; a value without an offset is taken as UTC
        if schedule_at.tzinfo is None:
            schedule_at = schedule_at.replace(tzinfo=timezone.utc)
        campaign.status = "scheduled"
        campaign.scheduled_at = schedule_at.astimezone(timezone.utc)
    else:
        campaign.status = "sending"
        if campaign.started_at is None:
            campaign.started_at = datetime.now(timezone.utc)

    await db.commit()

    # Freeze composer content so later template edits cannot change this campaign.
    try:
        from app.routers.composer import create_campaign_snapshot

        await create_campaign_snapshot(db, campaign, current_user)
    except Exception:
        # Campaigns authored in the classic editor have nothing to freeze.
        pass

    return {"message": "Campaign queued for sending", "status": campaign.status}


@router.post("/{campaign_code}/pause")
async def pause_campaign(
    campaign_code: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    campaign = await _get_campaign(campaign_code, current_user, db)
    campaign_id = campaign.id
    if campaign.status != "sending":
        raise HTTPException(400, "Can only pause a sending campaign")
    campaign.status = "paused"
    await db.commit()
    return {"message": "Campaign paused"}


@router.post("/{campaign_code}/resume")
async def resume_campaign(
    campaign_code: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    campaign = await _get_campaign(campaign_code, current_user, db)
    campaign_id = campaign.id
    if campaign.status != "paused":
        raise HTTPException(400, "Can only resume a paused campaign")
    problem = provider_problem()
    if problem:
        raise HTTPException(400, problem)
    campaign.status = "sending"
    campaign.last_error = None
    await db.commit()
    return {"message": "Campaign resumed"}


@router.post("/{campaign_code}/retry-failed")
async def retry_failed_recipients(
    campaign_code: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Put failed recipients back in the queue and resume sending."""
    campaign = await _get_campaign(campaign_code, current_user, db)
    if campaign.status not in ("paused", "completed", "sending"):
        raise HTTPException(400, f"Cannot retry a campaign in '{campaign.status}' status")
    problem = provider_problem()
    if problem:
        raise HTTPException(400, problem)

    result = await db.execute(
        update(Recipient)
        .where(
            Recipient.campaign_id == campaign.id,
            Recipient.status == "failed",
            Recipient.is_included == True,
        )
        .values(status="pending", retry_count=0, next_attempt_at=None)
    )
    requeued = result.rowcount or 0
    if requeued == 0:
        raise HTTPException(400, "There are no failed recipients to retry")

    campaign.failed_count = max(0, (campaign.failed_count or 0) - requeued)
    campaign.status = "sending"
    campaign.completed_at = None
    campaign.last_error = None
    await db.commit()
    return {"message": f"{requeued} recipient(s) queued for retry", "requeued": requeued}


async def get_queue_counts(db: AsyncSession, campaign_id: int) -> dict:
    """Recipient counts by send status, for the recipients that will be or were sent to."""
    result = await db.execute(
        select(Recipient.status, func.count(Recipient.id))
        .where(Recipient.campaign_id == campaign_id, Recipient.is_included == True)
        .group_by(Recipient.status)
    )
    by_status = {row[0] or "pending": int(row[1]) for row in result.all()}
    now = datetime.now(timezone.utc)
    waiting = await db.execute(
        select(func.count()).select_from(Recipient).where(
            Recipient.campaign_id == campaign_id,
            Recipient.is_included == True,
            Recipient.status == "pending",
            Recipient.next_attempt_at.isnot(None),
            Recipient.next_attempt_at > now,
        )
    )
    total = sum(by_status.values())
    pending = by_status.get("pending", 0)
    sending = by_status.get("sending", 0)
    failed = by_status.get("failed", 0)
    return {
        "total": total,
        "pending": pending,
        "sending": sending,
        "queued": pending + sending,
        "retry_waiting": int(waiting.scalar() or 0),
        "sent": by_status.get("sent", 0),
        "failed": failed,
        "bounced": by_status.get("bounced", 0),
        "unsubscribed": by_status.get("unsubscribed", 0),
        # No longer waiting in the queue, whatever the outcome
        "processed": total - pending - sending,
        "by_status": by_status,
    }


@router.get("/{campaign_code}/queue")
async def get_campaign_queue(
    campaign_code: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Live send status: how many are pending, sending, sent and failed."""
    from app.config import settings as app_settings
    from app.services.queue_worker import rate_limiter

    campaign = await _get_campaign(campaign_code, current_user, db)
    counts = await get_queue_counts(db, campaign.id)
    rate = float(rate_limiter.rate or 0)
    eta_seconds = None
    if campaign.status == "sending" and rate > 0 and counts["queued"] > 0:
        eta_seconds = int(counts["queued"] / rate)
    return {
        "public_code": campaign.public_code,
        "status": campaign.status,
        "last_error": campaign.last_error,
        "provider": app_settings.EMAIL_PROVIDER,
        "send_rate": rate,
        "eta_seconds": eta_seconds,
        "scheduled_at": campaign.scheduled_at.isoformat() if campaign.scheduled_at else None,
        "started_at": campaign.started_at.isoformat() if campaign.started_at else None,
        "completed_at": campaign.completed_at.isoformat() if campaign.completed_at else None,
        **counts,
    }


async def _get_campaign(campaign_code: str, user: User, db: AsyncSession) -> Campaign:
    code = (campaign_code or "").strip().upper()
    result = await db.execute(select(Campaign).where(Campaign.public_code == code))
    campaign = result.scalar_one_or_none()
    if not campaign:
        raise HTTPException(404, "Campaign not found")
    # In "user" mode, non-admins can only access their own campaigns
    mode = await _get_campaign_mode(db)
    if mode == "user" and user.role != "admin" and campaign.created_by != user.id:
        raise HTTPException(403, "Access denied")
    return campaign


async def process_upload(job_id: int, campaign_id: int, mapping: ColumnMappingRequest):
    """Background task to process uploaded file and insert recipients."""
    from app.database import AsyncSessionLocal
    from app.services.public_codes import random_public_code

    async with AsyncSessionLocal() as db:
        result = await db.execute(select(UploadJob).where(UploadJob.id == job_id))
        job = result.scalar_one_or_none()
        if not job:
            return

        # Replace prior draft recipients so remapping never duplicates
        await db.execute(delete(Recipient).where(Recipient.campaign_id == campaign_id))
        await db.commit()

        filename = job.filename
        ext = filename.rsplit(".", 1)[-1].lower()
        file_path = os.path.join(UPLOAD_DIR, f"campaign_{campaign_id}_{filename}")

        with open(file_path, "rb") as f:
            content = f.read()

        supp_result = await db.execute(select(SuppressionList.email))
        suppressed_emails = {row[0].lower() for row in supp_result.all()}

        used_codes = set()
        seen_emails = set()
        valid = 0
        invalid = 0
        duplicates = 0
        suppressed = 0
        processed = 0

        def next_code() -> str:
            code = random_public_code(PREFIXES["recipient"])
            while code in used_codes:
                code = random_public_code(PREFIXES["recipient"])
            used_codes.add(code)
            return code

        def _get_row_field(row_dict: dict, col_name: str | None) -> str:
            if not col_name:
                return ""
            if col_name in row_dict and row_dict[col_name] is not None:
                val = str(row_dict[col_name]).strip()
                if val:
                    return val
            target = col_name.strip().lower()
            for k, v in row_dict.items():
                if k and str(k).strip().lower() == target:
                    return str(v).strip() if v is not None else ""
            return ""

        parser = parse_csv_rows if ext == "csv" else parse_excel_rows
        for batch in parser(content, batch_size=500):
            recipients_to_add = []
            for row in batch:
                processed += 1
                email_value = _get_row_field(row, mapping.email_column).lower()
                if not email_value:
                    for k, v in row.items():
                        clean_k = str(k).strip().lower().replace(" ", "_").replace("-", "_")
                        if clean_k in ("email", "e_mail", "email_address", "recipient_email", "mail"):
                            candidate = str(v).strip().lower() if v else ""
                            if candidate and validate_email_address(candidate):
                                email_value = candidate
                                break

                if not email_value or not validate_email_address(email_value):
                    invalid += 1
                    continue

                if email_value in seen_emails:
                    duplicates += 1
                    continue

                if email_value in suppressed_emails:
                    suppressed += 1
                    seen_emails.add(email_value)
                    continue

                seen_emails.add(email_value)

                # Extract name with case/whitespace-insensitivity and standard fallback
                name_val = _get_row_field(row, mapping.name_column) if mapping.name_column else ""
                if not name_val:
                    for k, v in row.items():
                        clean_k = str(k).strip().lower().replace(" ", "_").replace("-", "_")
                        if clean_k in ("name", "full_name", "fullname", "first_name", "firstname", "recipient_name", "contact_name", "customer_name", "client_name"):
                            candidate = str(v).strip() if v is not None else ""
                            if candidate:
                                name_val = candidate
                                break

                merge_data = {}
                # Include all normalized columns from row so any variable in templates works
                for k, v in row.items():
                    if k:
                        norm_key = normalize_field_key(str(k))
                        merge_data[norm_key] = str(v).strip() if v is not None else ""

                if name_val:
                    merge_data["name"] = name_val

                if mapping.merge_fields:
                    for var_name, col_name in mapping.merge_fields.items():
                        key = normalize_field_key(var_name) if var_name else normalize_field_key(col_name)
                        val = _get_row_field(row, col_name)
                        merge_data[key] = val
                        if not merge_data.get("name") and key.lower() in ("name", "full_name", "first_name"):
                            merge_data["name"] = val

                recipients_to_add.append(Recipient(
                    public_code=next_code(),
                    campaign_id=campaign_id,
                    email=email_value,
                    merge_data=merge_data,
                    row_index=valid,
                    is_included=True,
                    status="pending",
                ))
                valid += 1

            if recipients_to_add:
                db.add_all(recipients_to_add)
                await db.commit()

            job.processed_rows = processed
            job.valid_rows = valid
            job.invalid_rows = invalid
            job.duplicate_rows = duplicates
            job.suppressed_rows = suppressed
            await db.commit()

        campaign_result = await db.execute(select(Campaign).where(Campaign.id == campaign_id))
        campaign = campaign_result.scalar_one_or_none()
        if campaign:
            campaign.total_recipients = valid
            await db.commit()

        job.status = "completed"
        await db.commit()


# ─── Preview endpoints ─────────────────────────────────────────────────────

@router.get("/{campaign_code}/preview-recipient", response_model=PreviewRecipientResponse)
async def get_preview_recipient(
    campaign_code: str,
    index: int = 0,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a single recipient by index for lazy preview navigation."""
    campaign = await _get_campaign(campaign_code, current_user, db)
    campaign_id = campaign.id

    # Get total count
    total_result = await db.execute(
        select(func.count()).select_from(Recipient).where(Recipient.campaign_id == campaign_id)
    )
    total = total_result.scalar() or 0

    if total == 0:
        raise HTTPException(404, "No recipients in this campaign")

    # Clamp index
    index = max(0, min(index, total - 1))

    # Fetch recipient by row_index (deterministic order)
    result = await db.execute(
        select(Recipient)
        .where(Recipient.campaign_id == campaign_id)
        .order_by(Recipient.row_index.asc().nullslast(), Recipient.id.asc())
        .offset(index)
        .limit(1)
    )
    recipient = result.scalar_one_or_none()

    if not recipient:
        raise HTTPException(404, "Recipient not found at this index")

    return PreviewRecipientResponse(
        recipient={
            "id": recipient.id,
            "index": index,
            "display_index": index + 1,
            "total": total,
            "email": recipient.email,
            "display_name": (
                (recipient.merge_data or {}).get("name")
                or (recipient.merge_data or {}).get("Name")
                or (recipient.merge_data or {}).get("full_name")
                or (recipient.merge_data or {}).get("first_name")
                or ""
            ),
            "variables": recipient.merge_data or {},
        },
        has_previous=index > 0,
        has_next=index < total - 1,
    )


@router.post("/{campaign_code}/preview/render", response_model=PreviewRenderResponse)
async def render_campaign_preview(
    campaign_code: str,
    req: PreviewRenderRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Render campaign content with actual recipient data for live preview."""
    campaign = await _get_campaign(campaign_code, current_user, db)
    campaign_id = campaign.id

    # Get recipient data
    recipient_vars = {}
    if req.recipient_id:
        result = await db.execute(
            select(Recipient).where(
                Recipient.id == req.recipient_id,
                Recipient.campaign_id == campaign_id,
            )
        )
        recipient = result.scalar_one_or_none()
        if recipient:
            recipient_vars = recipient.merge_data or {}
    elif req.recipient_index is not None:
        result = await db.execute(
            select(Recipient)
            .where(Recipient.campaign_id == campaign_id)
            .order_by(Recipient.row_index.asc().nullslast(), Recipient.id.asc())
            .offset(req.recipient_index)
            .limit(1)
        )
        recipient = result.scalar_one_or_none()
        if recipient:
            recipient_vars = recipient.merge_data or {}

    # Load template definitions if template is selected
    template_field_defs = None
    if campaign.selected_template_id:
        tmpl_result = await db.execute(
            select(Template).where(Template.id == campaign.selected_template_id)
        )
        tmpl = tmpl_result.scalar_one_or_none()
        if tmpl and tmpl.merge_field_definitions_json:
            template_field_defs = tmpl.merge_field_definitions_json

    # Build render context
    context, defaults_used, warnings, missing_required = build_render_context(
        recipient_vars,
        campaign.campaign_field_definitions_json,
        template_field_defs,
        campaign.template_field_bindings_json,
    )

    # Use provided draft content or campaign content
    subject = req.subject if req.subject is not None else (campaign.subject or "")
    preheader = req.preheader if req.preheader is not None else (campaign.preheader or "")
    html = req.html if req.html is not None else (campaign.html_body or "")
    plain_text = req.plain_text or ""

    # Render
    rendered = render_campaign_content(subject, preheader, html, plain_text, context)

    return PreviewRenderResponse(
        subject=rendered["subject"],
        preheader=rendered["preheader"],
        html=rendered["html"],
        plain_text=rendered["plain_text"],
        resolved_values=context,
        defaults_used=defaults_used,
        warnings=warnings,
        missing_required_fields=missing_required,
    )


@router.get("/{campaign_code}/field-definitions")
async def get_campaign_field_definitions(
    campaign_code: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get campaign field definitions with sample data stats."""
    campaign = await _get_campaign(campaign_code, current_user, db)
    campaign_id = campaign.id

    field_defs = campaign.campaign_field_definitions_json or []

    # Get sample values from first recipient
    sample_result = await db.execute(
        select(Recipient)
        .where(Recipient.campaign_id == campaign_id)
        .order_by(Recipient.row_index.asc().nullslast(), Recipient.id.asc())
        .limit(1)
    )
    sample_recipient = sample_result.scalar_one_or_none()
    sample_values = sample_recipient.merge_data if sample_recipient else {}

    # Get total recipient count
    total_result = await db.execute(
        select(func.count()).select_from(Recipient).where(Recipient.campaign_id == campaign_id)
    )
    total = total_result.scalar() or 0

    return {
        "field_definitions": field_defs,
        "sample_values": sample_values or {},
        "total_recipients": total,
        "template_field_bindings": campaign.template_field_bindings_json,
        "selected_template_id": campaign.selected_template_id,
    }


@router.post("/{campaign_code}/suggest-mapping", response_model=SuggestMappingResponse)
async def suggest_mapping(
    campaign_code: str,
    req: SuggestMappingRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Suggest a column mapping based on previously saved profiles."""
    campaign = await _get_campaign(campaign_code, current_user, db)
    campaign_id = campaign.id

    signature = compute_header_signature(req.headers)

    # Look for a matching profile
    result = await db.execute(
        select(ImportMappingProfile)
        .where(ImportMappingProfile.normalized_header_signature == signature)
        .order_by(ImportMappingProfile.created_at.desc())
        .limit(1)
    )
    profile = result.scalar_one_or_none()

    if not profile:
        return SuggestMappingResponse(found=False)

    # Update last_used_at
    profile.last_used_at = datetime.now(timezone.utc)
    await db.commit()

    return SuggestMappingResponse(
        found=True,
        column_mapping=profile.column_mapping_json,
        field_definitions=profile.campaign_field_definitions_json,
        source_campaign_id=profile.source_campaign_id,
    )


@router.post("/{campaign_code}/auto-map-template")
async def auto_map_template_fields_endpoint(
    campaign_code: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Auto-map template fields to campaign fields."""
    campaign = await _get_campaign(campaign_code, current_user, db)
    campaign_id = campaign.id

    if not campaign.selected_template_id:
        raise HTTPException(400, "No template selected for this campaign")

    # Load template
    tmpl_result = await db.execute(
        select(Template).where(Template.id == campaign.selected_template_id)
    )
    tmpl = tmpl_result.scalar_one_or_none()
    if not tmpl:
        raise HTTPException(404, "Selected template not found")

    template_defs = tmpl.merge_field_definitions_json or []
    campaign_defs = campaign.campaign_field_definitions_json or []

    bindings = auto_map_template_fields(template_defs, campaign_defs)

    # Persist bindings
    campaign.template_field_bindings_json = bindings
    await db.commit()

    return {
        "bindings": bindings,
        "template_fields": template_defs,
        "campaign_fields": campaign_defs,
    }
