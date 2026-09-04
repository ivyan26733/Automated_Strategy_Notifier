from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BASE_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Supabase
    supabase_url: str = ""
    supabase_service_role_key: str = ""
    supabase_anon_key: str = ""

    # Local paths (relative to project root)
    data_dir: Path = BASE_DIR / "stock_data"
    universe_csv: Path = BASE_DIR / "nse_universe.csv"

    # Scanner behaviour
    log_level: str = "INFO"
    request_pause: float = 0.3   # seconds between Yahoo requests in sector fetch


settings = Settings()
