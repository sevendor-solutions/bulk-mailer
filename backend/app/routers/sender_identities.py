from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import List

from app.database import get_db
from app.models.user import User
from app.models.sender_identity import SenderIdentity
from app.schemas.sender_identity import SenderIdentityCreate, SenderIdentityUpdate, SenderIdentityResponse
from app.utils.dependencies import get_admin_user, get_current_user
from app.services.public_codes import generate_unique_public_code, PREFIXES

router = APIRouter(prefix="/sender-identities", tags=["sender-identities"])


@router.get("/", response_model=List[SenderIdentityResponse])
async def list_sender_identities(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List active sender identities (all authenticated users can view)."""
    result = await db.execute(
        select(SenderIdentity).where(SenderIdentity.is_active == True).order_by(SenderIdentity.is_default.desc(), SenderIdentity.from_name)
    )
    return result.scalars().all()


@router.get("/all", response_model=List[SenderIdentityResponse])
async def list_all_sender_identities(
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_admin_user),
):
    """List all sender identities including inactive (admin only)."""
    result = await db.execute(
        select(SenderIdentity).order_by(SenderIdentity.is_default.desc(), SenderIdentity.from_name)
    )
    return result.scalars().all()


@router.post("/", response_model=SenderIdentityResponse, status_code=201)
async def create_sender_identity(
    data: SenderIdentityCreate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_admin_user),
):
    """Create a new sender identity (admin only)."""
    # If setting as default, clear existing defaults
    if data.is_default:
        await _clear_defaults(db)

    reply_to = (data.reply_to or "").strip() or data.from_email

    identity = SenderIdentity(
        public_code=await generate_unique_public_code(db, SenderIdentity, PREFIXES["sender"]),
        from_email=data.from_email.strip(),
        from_name=data.from_name.strip(),
        reply_to=reply_to,
        is_default=data.is_default,
    )
    db.add(identity)
    await db.commit()
    await db.refresh(identity)
    return identity


@router.patch("/{identity_code}", response_model=SenderIdentityResponse)
async def update_sender_identity(
    identity_code: str,
    data: SenderIdentityUpdate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_admin_user),
):
    """Update a sender identity (admin only)."""
    result = await db.execute(select(SenderIdentity).where(SenderIdentity.public_code == identity_code.strip().upper()))
    identity = result.scalar_one_or_none()
    if not identity:
        raise HTTPException(404, "Sender identity not found")

    update_data = data.model_dump(exclude_unset=True)

    # If setting as default, clear existing defaults
    if update_data.get("is_default"):
        await _clear_defaults(db)

    if "reply_to" in update_data and not (update_data["reply_to"] or "").strip():
        update_data["reply_to"] = update_data.get("from_email") or identity.from_email

    for field, value in update_data.items():
        setattr(identity, field, value)

    await db.commit()
    await db.refresh(identity)
    return identity


@router.delete("/{identity_code}", status_code=204)
async def delete_sender_identity(
    identity_code: str,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_admin_user),
):
    """Delete a sender identity (admin only)."""
    result = await db.execute(select(SenderIdentity).where(SenderIdentity.public_code == identity_code.strip().upper()))
    identity = result.scalar_one_or_none()
    if not identity:
        raise HTTPException(404, "Sender identity not found")

    await db.delete(identity)
    await db.commit()


async def _clear_defaults(db: AsyncSession):
    """Clear all existing default flags."""
    result = await db.execute(select(SenderIdentity).where(SenderIdentity.is_default == True))
    for identity in result.scalars().all():
        identity.is_default = False
