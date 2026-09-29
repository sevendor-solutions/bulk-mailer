import asyncio
import time
import logging
from app.config import settings

logger = logging.getLogger(__name__)


class TokenBucketRateLimiter:
    """
    Flexible rate limiter for email sending.
    Supports two modes:
    1. "delay": Exact delay in seconds between emails (e.g. 60s, 80s) - ideal for SMTP.
    2. "per_second": Token bucket with burst capacity (e.g. 14 emails/sec) - ideal for SES.
    """

    def __init__(self, rate: float = None, delay_seconds: float = None, mode: str = None):
        self.mode = mode or getattr(settings, "RATE_LIMIT_TYPE", "delay")
        self.delay_seconds = delay_seconds if delay_seconds is not None else getattr(settings, "SEND_DELAY_SECONDS", 60.0)
        self.rate = rate or getattr(settings, "MAX_SEND_RATE", 14)
        
        # Token bucket state for per_second mode
        self.capacity = max(1, int(self.rate * 2))
        self.tokens = float(self.capacity)
        self.last_refill = time.monotonic()
        
        # Exact delay state for delay mode
        self.last_send_time = None
        self._lock = asyncio.Lock()

    async def acquire(self, is_cancelled=None) -> bool:
        """
        Wait until ready to send next email.
        Returns True if acquired, False if cancelled while waiting.
        """
        if self.mode == "delay":
            return await self._acquire_delay(is_cancelled)
        else:
            return await self._acquire_token_bucket(is_cancelled)

    async def _acquire_delay(self, is_cancelled=None) -> bool:
        async with self._lock:
            if self.delay_seconds > 0 and self.last_send_time is not None:
                target_time = self.last_send_time + self.delay_seconds
                while True:
                    if is_cancelled and is_cancelled():
                        return False
                    remaining = target_time - time.monotonic()
                    if remaining <= 0:
                        break
                    # Sleep in small slices (up to 0.5s) to remain responsive to pause/stop
                    await asyncio.sleep(min(remaining, 0.5))

            self.last_send_time = time.monotonic()
            return True

    async def _acquire_token_bucket(self, is_cancelled=None) -> bool:
        while True:
            if is_cancelled and is_cancelled():
                return False
            async with self._lock:
                self._refill()
                if self.tokens >= 1:
                    self.tokens -= 1
                    return True
            await asyncio.sleep(0.05)

    def _refill(self):
        now = time.monotonic()
        elapsed = now - self.last_refill
        new_tokens = elapsed * self.rate
        if new_tokens > 0:
            self.tokens = min(float(self.capacity), self.tokens + new_tokens)
            self.last_refill = now

    def update_rate(self, new_rate: float):
        """Update tokens/sec rate (backwards compat)."""
        self.rate = max(1, int(new_rate))
        self.capacity = max(1, int(new_rate * 2))

    def update_config(self, mode: str = None, delay_seconds: float = None, rate: float = None):
        """Update full rate limiter configuration."""
        if mode:
            self.mode = mode
        if delay_seconds is not None:
            self.delay_seconds = float(delay_seconds)
        if rate is not None:
            self.update_rate(rate)
        logger.info(f"RateLimiter updated: mode={self.mode}, delay={self.delay_seconds}s, rate={self.rate}/s")
