from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy import event, text
from app.config import settings
import os
import json
import logging
import random

logger = logging.getLogger(__name__)


db_url = settings.DATABASE_URL
if db_url.startswith("postgres://"):
    db_url = db_url.replace("postgres://", "postgresql+asyncpg://", 1)
elif db_url.startswith("postgresql://") and not db_url.startswith("postgresql+"):
    db_url = db_url.replace("postgresql://", "postgresql+asyncpg://", 1)

is_sqlite = db_url.startswith("sqlite")

# Ensure data directory exists if SQLite
if is_sqlite:
    db_path = db_url.replace("sqlite+aiosqlite:///", "")
    db_dir = os.path.dirname(db_path)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)

connect_args = {"check_same_thread": False} if is_sqlite else {}

engine = create_async_engine(
    db_url,
    echo=settings.DEBUG,
    connect_args=connect_args,
)


if is_sqlite:
    @event.listens_for(engine.sync_engine, "connect")
    def set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.execute("PRAGMA cache_size=-64000")  # 64MB cache
        cursor.close()


AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    pass


async def get_db():
    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            await session.close()


async def init_db():
    async with engine.begin() as conn:
        from app.models import (
            user, campaign, template, tracking, settings_model, suppression,
            sender_identity, asset, composer,
        )
        await conn.run_sync(Base.metadata.create_all)
    if engine.dialect.name == "sqlite":
        await _run_migrations()
    else:
        await _backfill_data()


def _random_code(prefix: str) -> str:
    return f"{prefix}-{random.randint(10000, 99999):05d}"


async def _run_migrations():
    """Add new columns to existing tables if they don't exist (SQLite ALTER TABLE)."""
    async with engine.begin() as conn:
        def _get_columns(sync_conn, table_name):
            result = sync_conn.execute(text(f"PRAGMA table_info({table_name})"))
            return {row[1] for row in result.fetchall()}

        def _table_exists(sync_conn, table_name):
            result = sync_conn.execute(
                text("SELECT name FROM sqlite_master WHERE type='table' AND name=:n"),
                {"n": table_name},
            )
            return result.fetchone() is not None

        tables = ["campaigns", "templates", "recipients", "upload_jobs", "users",
                  "sender_identities", "suppression_list", "assets"]
        existing = {}
        for t in tables:
            exists = await conn.run_sync(lambda c, name=t: _table_exists(c, name))
            existing[t] = await conn.run_sync(lambda c, name=t: _get_columns(c, name)) if exists else set()

        # Campaign new columns
        campaign_adds = {
            "campaign_field_definitions_json": "TEXT",
            "template_field_bindings_json": "TEXT",
            "selected_template_id": "INTEGER REFERENCES templates(id)",
            "source_campaign_id": "INTEGER",
            "public_code": "VARCHAR(16)",
            "last_error": "TEXT",
        }
        for col, col_type in campaign_adds.items():
            if col not in existing["campaigns"]:
                await conn.execute(text(f"ALTER TABLE campaigns ADD COLUMN {col} {col_type}"))
                logger.info(f"Migration: added campaigns.{col}")

        # Template new columns
        template_adds = {
            "merge_field_definitions_json": "TEXT",
            "public_code": "VARCHAR(16)",
        }
        for col, col_type in template_adds.items():
            if col not in existing["templates"]:
                await conn.execute(text(f"ALTER TABLE templates ADD COLUMN {col} {col_type}"))
                logger.info(f"Migration: added templates.{col}")

        # Recipient new columns
        recipient_adds = {
            "row_index": "INTEGER",
            "is_included": "BOOLEAN DEFAULT 1",
            "public_code": "VARCHAR(16)",
            "next_attempt_at": "DATETIME",
        }
        for col, col_type in recipient_adds.items():
            if col not in existing["recipients"]:
                await conn.execute(text(f"ALTER TABLE recipients ADD COLUMN {col} {col_type}"))
                logger.info(f"Migration: added recipients.{col}")

        # UploadJob new columns
        uj_adds = {
            "source_headers_json": "TEXT",
            "normalized_header_signature": "TEXT",
        }
        for col, col_type in uj_adds.items():
            if col not in existing["upload_jobs"]:
                await conn.execute(text(f"ALTER TABLE upload_jobs ADD COLUMN {col} {col_type}"))
                logger.info(f"Migration: added upload_jobs.{col}")

        # User / sender / suppression public_code
        for table, label in (
            ("users", "users"),
            ("sender_identities", "sender_identities"),
            ("suppression_list", "suppression_list"),
        ):
            if existing[table] and "public_code" not in existing[table]:
                await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN public_code VARCHAR(16)"))
                logger.info(f"Migration: added {label}.public_code")

        # Composer asset metadata
        asset_adds = {
            "alt_text": "TEXT",
            "folder": "VARCHAR DEFAULT ''",
            "tags_json": "TEXT",
            "created_by": "INTEGER REFERENCES users(id)",
            "usage_count": "INTEGER DEFAULT 0",
            "width": "INTEGER",
            "height": "INTEGER",
            "archived_at": "DATETIME",
            "updated_at": "DATETIME",
            "is_shared": "BOOLEAN DEFAULT 1",
        }
        if existing["assets"]:
            for col, col_type in asset_adds.items():
                if col not in existing["assets"]:
                    await conn.execute(text(f"ALTER TABLE assets ADD COLUMN {col} {col_type}"))
                    logger.info(f"Migration: added assets.{col}")

    await _backfill_data()


async def _backfill_public_codes(db, table: str, prefix: str):
    """Assign unique public codes to rows missing them."""
    result = await db.execute(text(f"SELECT id FROM {table} WHERE public_code IS NULL OR public_code = ''"))
    ids = [row[0] for row in result.fetchall()]
    if not ids:
        return 0

    used = set()
    existing = await db.execute(text(f"SELECT public_code FROM {table} WHERE public_code IS NOT NULL"))
    used.update(row[0] for row in existing.fetchall() if row[0])

    for row_id in ids:
        code = _random_code(prefix)
        while code in used:
            code = _random_code(prefix)
        used.add(code)
        await db.execute(
            text(f"UPDATE {table} SET public_code = :code WHERE id = :id"),
            {"code": code, "id": row_id},
        )
    logger.info(f"Migration: backfilled {len(ids)} {table}.public_code")
    return len(ids)


async def _seed_builtin_themes(db):
    """Insert the built-in composer themes once, keeping their fixed codes."""
    from app.services.composer.theme import BUILTIN_THEMES

    result = await db.execute(text("SELECT public_code FROM composer_themes"))
    existing = {row[0] for row in result.fetchall() if row[0]}
    inserted = 0
    for index, theme in enumerate(BUILTIN_THEMES):
        if theme["code"] in existing:
            continue
        await db.execute(
            text(
                "INSERT INTO composer_themes "
                "(public_code, name, description, tokens_json, is_builtin, is_org_default, is_locked) "
                "VALUES (:code, :name, :description, :tokens, :is_builtin, :is_default, :is_locked)"
            ),
            {
                "code": theme["code"],
                "name": theme["name"],
                "description": theme["description"],
                "tokens": json.dumps(theme["tokens"]),
                "is_builtin": True,
                "is_default": bool(index == 0 and not existing),
                "is_locked": False,
            },
        )
        inserted += 1
    if inserted:
        logger.info(f"Migration: seeded {inserted} built-in composer themes")


async def _backfill_data():
    """Backfill canonical merge field definitions and public codes."""
    async with AsyncSessionLocal() as db:
        # Backfill templates: merge_fields_config → merge_field_definitions_json
        result = await db.execute(
            text("SELECT id, merge_fields_config FROM templates WHERE merge_field_definitions_json IS NULL AND merge_fields_config IS NOT NULL")
        )
        for row in result.fetchall():
            try:
                legacy = json.loads(row[1]) if isinstance(row[1], str) else row[1]
                if not legacy:
                    continue
                canonical = []
                for field in legacy:
                    if isinstance(field, dict):
                        canonical.append({
                            "key": field.get("name", ""),
                            "label": field.get("label", field.get("name", "")),
                            "data_type": "text",
                            "required": False,
                            "default_value": field.get("defaultValue", None),
                            "source_kind": "custom",
                            "source_column": None,
                            "is_system": False,
                        })
                if canonical:
                    await db.execute(
                        text("UPDATE templates SET merge_field_definitions_json = :defs WHERE id = :id"),
                        {"defs": json.dumps(canonical), "id": row[0]}
                    )
            except (json.JSONDecodeError, TypeError):
                pass

        result = await db.execute(
            text("SELECT id, merge_fields_config FROM campaigns WHERE campaign_field_definitions_json IS NULL AND merge_fields_config IS NOT NULL")
        )
        for row in result.fetchall():
            try:
                legacy = json.loads(row[1]) if isinstance(row[1], str) else row[1]
                if not legacy:
                    continue
                canonical = []
                for field in legacy:
                    if isinstance(field, dict):
                        source_kind = "uploaded_column" if field.get("source") == "csv" else "custom"
                        canonical.append({
                            "key": field.get("name", ""),
                            "label": field.get("label", field.get("name", "")),
                            "data_type": "text",
                            "required": False,
                            "default_value": field.get("defaultValue", None),
                            "source_kind": source_kind,
                            "source_column": field.get("label") if source_kind == "uploaded_column" else None,
                            "is_system": False,
                        })
                if canonical:
                    await db.execute(
                        text("UPDATE campaigns SET campaign_field_definitions_json = :defs WHERE id = :id"),
                        {"defs": json.dumps(canonical), "id": row[0]}
                    )
            except (json.JSONDecodeError, TypeError):
                pass

        # Backfill recipient row_index
        result = await db.execute(
            text("SELECT DISTINCT campaign_id FROM recipients WHERE row_index IS NULL LIMIT 100")
        )
        campaign_ids = [row[0] for row in result.fetchall()]
        for cid in campaign_ids:
            await db.execute(text("""
                UPDATE recipients SET row_index = (
                    SELECT COUNT(*) FROM recipients r2
                    WHERE r2.campaign_id = recipients.campaign_id
                    AND r2.id < recipients.id
                ) WHERE campaign_id = :cid AND row_index IS NULL
            """), {"cid": cid})

        # Ensure is_included is set
        await db.execute(text("UPDATE recipients SET is_included = :val WHERE is_included IS NULL"), {"val": True})

        # Public codes
        await _backfill_public_codes(db, "campaigns", "CMP")
        await _backfill_public_codes(db, "templates", "TPL")
        await _backfill_public_codes(db, "users", "USR")
        await _backfill_public_codes(db, "sender_identities", "SND")
        await _backfill_public_codes(db, "recipients", "RCP")
        await _backfill_public_codes(db, "suppression_list", "SUP")
        await _backfill_public_codes(db, "assets", "AST")
        await _backfill_public_codes(db, "template_revisions", "REV")
        await _backfill_public_codes(db, "composer_themes", "THM")
        await _backfill_public_codes(db, "reusable_blocks", "RUB")
        await _backfill_public_codes(db, "campaign_template_snapshots", "SNP")

        await db.execute(text("UPDATE assets SET usage_count = 0 WHERE usage_count IS NULL"))
        await db.execute(text("UPDATE assets SET is_shared = :val WHERE is_shared IS NULL"), {"val": True})

        await _seed_builtin_themes(db)

        await db.commit()
        if campaign_ids:
            logger.info(f"Migration: backfilled row_index for {len(campaign_ids)} campaigns")
