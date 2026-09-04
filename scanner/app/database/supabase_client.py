from __future__ import annotations

from functools import lru_cache

from supabase import Client, create_client

from app.config.settings import settings


@lru_cache(maxsize=1)
def get_client() -> Client:
    """Return a cached Supabase client using the service-role key."""
    if not settings.supabase_url or not settings.supabase_service_role_key:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env"
        )
    return create_client(settings.supabase_url, settings.supabase_service_role_key)
