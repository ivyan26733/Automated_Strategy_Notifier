from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any

import pandas as pd

from app.config.settings import settings
from app.data.market_data import load_daily
from app.data.universe import Stock, load_universe
from app.data.validation import validate_and_clean
from app.data.weekly import build_weekly
from app.database.repositories import (
    finish_scanner_run,
    start_scanner_run,
    upsert_signals,
    upsert_stocks,
    upsert_weekly_indicators,
)
from app.indicators.ema import ema9, ema20
from app.strategies.breakout_6m import Breakout6mStrategy
from app.strategies.ema_crossover import EmaCrossoverStrategy
from app.strategies.base import Signal
from app.utils.logging import get_logger

logger = get_logger(__name__)

_STRATEGIES_EMA      = [EmaCrossoverStrategy()]
_STRATEGIES_BREAKOUT = [Breakout6mStrategy()]


# ---------------------------------------------------------------------------
# Per-stock processing
# ---------------------------------------------------------------------------
def _process_stock(stock: Stock) -> tuple[list[Signal], dict[str, Any] | None, str | None]:
    """
    Load, validate, build weekly candles, compute EMAs, run strategies.

    Returns:
        signals   — list of Signal objects detected for this stock
        indicator — dict for weekly_indicators upsert (latest observation only)
        error     — error message string, or None on success
    """
    # Load & validate
    daily = load_daily(stock.symbol)
    if daily.empty:
        return [], None, f"{stock.symbol}: no local data file"

    daily, issues = validate_and_clean(daily, stock.symbol)
    for issue in issues:
        logger.debug(issue)

    if daily.empty:
        return [], None, f"{stock.symbol}: no usable rows after validation"

    # Build weekly candles
    weekly = build_weekly(daily)
    if weekly.empty or len(weekly) < 2:
        return [], None, f"{stock.symbol}: insufficient weekly history"

    # Compute EMAs on weekly closes
    e9  = ema9(weekly["Close"])
    e20 = ema20(weekly["Close"])

    # Build indicator row for the latest (developing) week
    last       = weekly.iloc[-1]
    last_e9    = e9.iloc[-1]
    last_e20   = e20.iloc[-1]
    obs_date   = last["observation_date"]

    indicator: dict[str, Any] | None = None
    if not (pd.isna(last_e9) or pd.isna(last_e20)):
        diff     = float(last_e9 - last_e20)
        diff_pct = (diff / float(last_e20)) * 100.0 if last_e20 else None
        indicator = {
            "symbol":             stock.symbol,
            "observation_date":   obs_date.date() if hasattr(obs_date, "date") else obs_date,
            "week_start":         weekly.index[-1].date(),
            "weekly_open":        float(last["Open"]),
            "weekly_high":        float(last["High"]),
            "weekly_low":         float(last["Low"]),
            "weekly_close":       float(last["Close"]),
            "weekly_volume":      float(last["Volume"]),
            "ema9":               float(last_e9),
            "ema20":              float(last_e20),
            "ema_difference":     diff,
            "ema_difference_pct": diff_pct,
            "is_developing_week": bool(last["is_developing"]),
        }

    # Run strategies
    signals: list[Signal] = []
    for strategy in _STRATEGIES_EMA:
        signals.extend(strategy.generate_signals(
            stock.symbol, weekly, stock.sector, stock.industry
        ))
    for strategy in _STRATEGIES_BREAKOUT:
        signals.extend(strategy.generate_signals(
            stock.symbol, weekly, stock.sector, stock.industry, daily=daily
        ))

    return signals, indicator, None


# ---------------------------------------------------------------------------
# Main runner
# ---------------------------------------------------------------------------
def run(
    *,
    refresh_data: bool = True,
    series_filter: frozenset[str] = frozenset({"EQ"}),
    batch_size: int = 200,
) -> dict[str, Any]:
    """
    Execute a full V1 scan.

    Steps:
        1.  Start scanner_runs record
        2.  Load/upsert stock universe
        3.  Optionally refresh market data
        4.  Process each stock (validate → weekly → EMA → signals)
        5.  Batch-upsert indicators and signals
        6.  Finish scanner_runs record

    Returns a summary dict.
    """
    started_at = datetime.now(timezone.utc)
    logger.info("=" * 60)
    logger.info("NSE STOCK SCANNER STARTING")
    logger.info("=" * 60)

    # Step 1 — universe
    logger.info("Loading universe …")
    stocks = load_universe(series_filter)
    logger.info(f"Universe: {len(stocks):,} stocks (series={series_filter})")

    # Step 2 — start run record
    run_id = start_scanner_run(stocks_requested=len(stocks))
    logger.info(f"Run ID: {run_id}")

    # Step 3 — upsert stock metadata
    logger.info("Upserting stock universe to Supabase …")
    upsert_stocks(stocks)

    # Step 4 — optional data refresh
    if refresh_data:
        logger.info("Refreshing market data (download_nse_data.py --update) …")
        import subprocess, sys
        result = subprocess.run(
            [sys.executable, str(settings.data_dir.parent / "download_nse_data.py"), "--update", "--workers", "8"],
            capture_output=True, text=True
        )
        if result.returncode != 0:
            logger.warning(f"Data refresh completed with errors:\n{result.stderr[-500:]}")
        else:
            logger.info("Market data refresh: OK")

    # Step 5 — process stocks
    logger.info("Processing stocks …")
    all_signals:    list[Signal]         = []
    all_indicators: list[dict[str, Any]] = []
    failures:       list[str]            = []
    processed = 0

    for i, stock in enumerate(stocks):
        try:
            signals, indicator, error = _process_stock(stock)
            if error:
                failures.append(error)
                logger.debug(error)
            else:
                all_signals.extend(signals)
                if indicator:
                    all_indicators.append(indicator)
                processed += 1
        except Exception as exc:
            msg = f"{stock.symbol}: unexpected error — {exc}"
            failures.append(msg)
            logger.warning(msg)

        if (i + 1) % 100 == 0:
            pct = (i + 1) / len(stocks) * 100
            logger.info(f"  {i+1:>5}/{len(stocks)}  ({pct:.0f}%)  signals so far: {len(all_signals)}")

    logger.info(f"Processing done. Processed: {processed:,}  Failed: {len(failures):,}  Signals: {len(all_signals):,}")

    # Step 6 — batch upsert indicators
    if all_indicators:
        logger.info(f"Upserting {len(all_indicators):,} weekly indicator rows …")
        for start in range(0, len(all_indicators), batch_size):
            upsert_weekly_indicators(all_indicators[start:start + batch_size])

    # Step 7 — batch upsert signals
    signals_created = 0
    if all_signals:
        logger.info(f"Upserting {len(all_signals):,} signals …")
        for start in range(0, len(all_signals), batch_size):
            batch = all_signals[start:start + batch_size]
            upsert_signals(batch)
            signals_created += len(batch)

    # Step 8 — finish run record
    status        = "failed" if len(failures) == len(stocks) else "success"
    error_summary = "\n".join(failures[:50]) if failures else None
    finish_scanner_run(
        run_id,
        status=status,
        stocks_processed=processed,
        stocks_failed=len(failures),
        signals_created=signals_created,
        error_summary=error_summary,
    )

    elapsed = (datetime.now(timezone.utc) - started_at).total_seconds()
    summary = {
        "run_id":           run_id,
        "stocks_requested": len(stocks),
        "stocks_processed": processed,
        "stocks_failed":    len(failures),
        "signals_created":  signals_created,
        "status":           status,
        "elapsed_seconds":  round(elapsed, 1),
    }

    logger.info("=" * 60)
    logger.info("NSE STOCK SCANNER COMPLETE")
    logger.info("=" * 60)
    logger.info(f"Run ID           : {run_id}")
    logger.info(f"Stocks scanned   : {len(stocks):,}")
    logger.info(f"Stocks processed : {processed:,}")
    logger.info(f"Stocks failed    : {len(failures):,}")
    logger.info(f"Signals created  : {signals_created:,}")
    logger.info(f"Status           : {status.upper()}")
    logger.info(f"Duration         : {elapsed:.1f}s")
    logger.info("=" * 60)

    return summary


if __name__ == "__main__":
    import json
    result = run()
    print("\n=== SCAN COMPLETE ===")
    for k, v in result.items():
        print(f"  {k}: {v}")
