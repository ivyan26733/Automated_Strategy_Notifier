from __future__ import annotations

import csv
from dataclasses import dataclass

from app.config.settings import settings


@dataclass(frozen=True)
class Stock:
    symbol: str
    name: str
    exchange: str
    series: str
    isin: str
    date_of_listing: str
    face_value: str
    sector: str
    industry: str
    active: bool


def load_universe(series_filter: frozenset[str] = frozenset({"EQ"})) -> list[Stock]:
    """Load stocks from nse_universe.csv, optionally filtered by series."""
    path = settings.universe_csv
    if not path.exists():
        raise FileNotFoundError(f"Universe file not found: {path}")

    stocks: list[Stock] = []
    with path.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if series_filter and row.get("series", "").strip() not in series_filter:
                continue
            stocks.append(Stock(
                symbol=row["symbol"],
                name=row["name"],
                exchange=row["exchange"],
                series=row.get("series", ""),
                isin=row.get("isin", ""),
                date_of_listing=row.get("date_of_listing", ""),
                face_value=row.get("face_value", ""),
                sector=row.get("sector", ""),
                industry=row.get("industry", ""),
                active=row.get("active", "true").lower() == "true",
            ))
    return stocks
