import asyncio
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from app.config import settings
from app.database import init_db
from app.routers import (
    auth, users, campaigns, templates, tracking, webhooks, ws,
    settings as settings_router, sender_identities, assets, analytics,
    composer, composer_library,
)
from app.services.queue_worker import start_queue_worker, stop_queue_worker
from app.services.retention_worker import start_retention_worker, stop_retention_worker
from app.services.bounce_worker import start_bounce_worker, stop_bounce_worker
import os

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Background worker task reference
_worker_task = None
_retention_task = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: init DB and start background worker."""
    global _worker_task
    global _retention_task

    # Initialize database
    await init_db()

    # Create default admin if no users exist
    await _create_default_admin()

    # Apply the email provider saved in Settings before anything sends
    from app.database import AsyncSessionLocal
    from app.services.provider_config import load_provider_config
    async with AsyncSessionLocal() as db:
        await load_provider_config(db)

    # Start queue worker
    _worker_task = asyncio.create_task(start_queue_worker())
    # Start retention worker
    _retention_task = asyncio.create_task(start_retention_worker())
    # Start bounce worker (idle until bounce detection is switched on)
    bounce_task = asyncio.create_task(start_bounce_worker())
    logger.info("Application started")

    yield

    # Shutdown
    await stop_queue_worker()
    await stop_retention_worker()
    await stop_bounce_worker()
    bounce_task.cancel()
    try:
        await bounce_task
    except asyncio.CancelledError:
        pass
    if _worker_task:
        _worker_task.cancel()
        try:
            await _worker_task
        except asyncio.CancelledError:
            pass
    if _retention_task:
        _retention_task.cancel()
        try:
            await _retention_task
        except asyncio.CancelledError:
            pass
    logger.info("Application shutdown")


app = FastAPI(
    title=settings.APP_NAME,
    version="1.0.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS or [],
    allow_origin_regex=r".*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# What a recipient's mail app may need from this server
RECIPIENT_PATHS = ("/track/", "/unsubscribe/", "/uploads/")


@app.middleware("http")
async def limit_quick_tunnel(request, call_next):
    """
    A Cloudflare quick tunnel puts this server on the internet for testing.
    Through it, only the recipient-facing paths answer: the login, the API and
    the docs stay reachable from this machine only.
    """
    host = (request.headers.get("host") or "").split(":")[0].lower()
    if host.endswith(".trycloudflare.com") and not request.url.path.startswith(RECIPIENT_PATHS):
        from fastapi.responses import PlainTextResponse
        return PlainTextResponse("Not found", status_code=404)
    return await call_next(request)


# Static files for uploads
os.makedirs("./uploads", exist_ok=True)
app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")

# Routers
app.include_router(auth.router, prefix="/api")
app.include_router(users.router, prefix="/api")
app.include_router(campaigns.router, prefix="/api")
app.include_router(templates.router, prefix="/api")
app.include_router(settings_router.router, prefix="/api")
app.include_router(sender_identities.router, prefix="/api")
app.include_router(assets.router, prefix="/api")
app.include_router(analytics.router, prefix="/api")
app.include_router(composer.router, prefix="/api")
app.include_router(composer_library.router, prefix="/api")
app.include_router(tracking.router)  # No prefix - short tracking URLs
app.include_router(webhooks.router, prefix="/api")
app.include_router(ws.router)  # WebSocket - no prefix


@app.get("/api/health")
async def health_check():
    return {"status": "ok", "app": settings.APP_NAME}


async def _create_default_admin():
    """Create default admin user if database is empty."""
    from app.database import AsyncSessionLocal
    from app.models.user import User
    from app.utils.jwt import hash_password
    from app.services.public_codes import generate_unique_public_code, PREFIXES
    from sqlalchemy import select, func

    async with AsyncSessionLocal() as db:
        result = await db.execute(select(func.count()).select_from(User))
        count = result.scalar()

        if count == 0:
            admin = User(
                public_code=await generate_unique_public_code(db, User, PREFIXES["user"]),
                email="admin@example.com",
                full_name="System Admin",
                hashed_password=hash_password("admin123"),
                role="admin",
                must_change_password=True,
            )
            db.add(admin)
            await db.commit()
            logger.info("Default admin created: admin@example.com / admin123")
