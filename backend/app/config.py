import os
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # App
    APP_NAME: str = "Bulk Email Sender"
    DEBUG: bool = False
    SECRET_KEY: str = "change-this-to-a-secure-random-string"
    PORT: int = 8000
    
    # Database
    DATABASE_URL: str = "sqlite+aiosqlite:///./data/bulk_email.db"
    
    # JWT
    JWT_SECRET_KEY: str = "jwt-secret-change-this"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 15
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    
    # SES
    AWS_ACCESS_KEY_ID: Optional[str] = None
    AWS_SECRET_ACCESS_KEY: Optional[str] = None
    AWS_REGION: str = "us-east-1"
    SES_SANDBOX_MODE: bool = True
    
    # SMTP
    SMTP_HOST: Optional[str] = None
    SMTP_PORT: int = 587
    SMTP_USERNAME: Optional[str] = None
    SMTP_PASSWORD: Optional[str] = None
    SMTP_USE_TLS: bool = True
    
    # IMAP mailbox read for bounces. Blank values follow the SMTP settings.
    IMAP_ENABLED: bool = False
    IMAP_HOST: Optional[str] = None
    IMAP_PORT: int = 993
    IMAP_USERNAME: Optional[str] = None
    IMAP_PASSWORD: Optional[str] = None
    IMAP_FOLDER: str = "INBOX"

    # Email Provider: "ses" or "smtp"
    EMAIL_PROVIDER: str = "ses"
    
    # Rate Limiting
    MAX_SEND_RATE: int = 14  # emails per second (when rate_limit_type == "per_second")
    SEND_DELAY_SECONDS: float = 60.0  # seconds between emails (when rate_limit_type == "delay", e.g. 60s, 80s)
    RATE_LIMIT_TYPE: str = "delay"  # "delay" (seconds between emails) or "per_second" (emails/sec)
    
    # Upload
    UPLOAD_DIR: str = "./uploads"
    MAX_UPLOAD_SIZE_MB: int = 50
    
    # Tracking
    TRACKING_BASE_URL: str = os.getenv(
        "TRACKING_BASE_URL",
        "http://bulkmailer-backend-z9iqeh-d78262-200-97-162-130.sslip.io"
    )
    # None = automatic: track only when TRACKING_BASE_URL is publicly reachable
    TRACKING_ENABLED: Optional[bool] = None
    
    # CORS
    CORS_ORIGINS: list[str] = ["http://localhost:5173"]


settings = Settings()
