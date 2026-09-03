from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.data.universe import Stock
from app.database.supabase_client import get_client
from app.strategies.base import Signal


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _upsert(table: str, rows: list[dict], on_conflict: str) -> int:
    """Upsert rows into table, return count of rows sent."""
    if not rows:
        return 0
    get_client().table(table).upsert(rows, on_conflict=on_conflict).execute()
    return len(rows)


# ---------------------------------------------------------------------------
# stocks
# ---------------------------------------------------------------------------
def upsert_stocks(stocks: list[Stock]) -> int:
    rows = [
        {
            "symbol":          s.symbol,
            "name":            s.name,
            "exchange":        s.exchange,
            "sector":          s.sector,
            "industry":        s.industry,
            "series":          s.series,
            "isin":            s.isin,
            "date_of_listing": s.date_of_listing,
            "face_value":      s.face_value,
            "active":          s.active,
            "updated_at":      _now(),
        }
        for s in stocks
    ]
    return _upsert("stocks", rows, "symbol")


# ---------------------------------------------------------------------------
# weekly_indicators
# ---------------------------------------------------------------------------
def upsert_weekly_indicators(rows: list[dict[str, Any]]) -> int:
    """
    Each dict must contain at minimum:
        symbol, observation_date, week_start, weekly_close, ema9, ema20
    """
    payload = [
        {
            "symbol":             r["symbol"],
            "observation_date":   str(r["observation_date"]),
            "week_start":         str(r["week_start"]),
            "weekly_open":        r.get("weekly_open"),
            "weekly_high":        r.get("weekly_high"),
            "weekly_low":         r.get("weekly_low"),
            "weekly_close":       r.get("weekly_close"),
            "weekly_volume":      r.get("weekly_volume"),
            "ema9":               r.get("ema9"),
            "ema20":              r.get("ema20"),
            "ema_difference":     r.get("ema_difference"),
            "ema_difference_pct": r.get("ema_difference_pct"),
            "is_developing_week": r.get("is_developing_week", True),
            "updated_at":         _now(),
        }
        for r in rows
    ]
    return _upsert("weekly_indicators", payload, "symbol,observation_date")


# ---------------------------------------------------------------------------
# signals
# ---------------------------------------------------------------------------
def upsert_signals(signals: list[Signal]) -> int:
    rows = [
        {
            "strategy_name":      s.strategy_name,
            "signal_type":        s.signal_type,
            "symbol":             s.symbol,
            "signal_date":        str(s.signal_date),
            "price":              s.price,
            "weekly_close":       s.weekly_close,
            "ema9":               s.ema9,
            "ema20":              s.ema20,
            "ema_difference":     s.ema_difference,
            "ema_difference_pct": s.ema_difference_pct,
            "breakout_reference": s.breakout_reference,
            "breakout_pct":       s.breakout_pct,
            "sector":             s.sector,
            "industry":           s.industry,
            "status":             "active",
            "updated_at":         _now(),
        }
        for s in signals
    ]
    return _upsert("signals", rows, "strategy_name,symbol,signal_date,signal_type")


# ---------------------------------------------------------------------------
# scanner_runs
# ---------------------------------------------------------------------------
def start_scanner_run(stocks_requested: int) -> int:
    """Insert a new scanner_runs row and return its id."""
    result = (
        get_client()
        .table("scanner_runs")
        .insert({
            "started_at":       _now(),
            "status":           "running",
            "stocks_requested": stocks_requested,
        })
        .execute()
    )
    return result.data[0]["id"]


def finish_scanner_run(
    run_id: int,
    *,
    status: str,
    stocks_processed: int,
    stocks_failed: int,
    signals_created: int,
    error_summary: str | None = None,
) -> None:
    get_client().table("scanner_runs").update({
        "finished_at":      _now(),
        "status":           status,
        "stocks_processed": stocks_processed,
        "stocks_failed":    stocks_failed,
        "signals_created":  signals_created,
        "error_summary":    error_summary,
    }).eq("id", run_id).execute()
