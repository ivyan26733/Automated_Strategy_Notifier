#!/usr/bin/env python3
"""
One-time enrichment: fetches sector & industry for every NSE stock via yfinance
and writes nse_universe.csv — the canonical universe file used by the scanner.

Run once (or re-run to refresh sector metadata):
    python fetch_sector_data.py
    python fetch_sector_data.py --resume   # skip tickers that already have a sector
    python fetch_sector_data.py --workers 4
"""

from __future__ import annotations

import argparse
import csv
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import Lock

import yfinance as yf

NSE_CSV      = Path(__file__).parent / "nse_equities.csv"
UNIVERSE_CSV = Path(__file__).parent / "nse_universe.csv"

FIELDNAMES = [
    "symbol", "name", "exchange", "series",
    "isin", "date_of_listing", "face_value",
    "sector", "industry", "active",
]

_lock = Lock()


def fetch_profile(symbol: str, pause: float) -> tuple[str, str]:
    """Return (sector, industry) for NSE symbol, or ('', '') on failure."""
    time.sleep(pause)
    try:
        info = yf.Ticker(f"{symbol}.NS").info
        return info.get("sector", "") or "", info.get("industry", "") or ""
    except Exception:
        return "", ""


def load_nse_equities() -> list[dict]:
    rows = []
    with NSE_CSV.open(newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            # Strip whitespace from both keys and values
            r = {k.strip(): v.strip() for k, v in r.items()}
            sym = r.get("SYMBOL", "")
            if not sym:
                continue
            rows.append({
                "symbol":          sym,
                "name":            r.get("NAME OF COMPANY", ""),
                "exchange":        "NSE",
                "series":          r.get("SERIES", ""),
                "isin":            r.get("ISIN NUMBER", ""),
                "date_of_listing": r.get("DATE OF LISTING", ""),
                "face_value":      r.get("FACE VALUE", ""),
                "sector":          "",
                "industry":        "",
                "active":          "true",
            })
    return rows


def load_existing_universe() -> dict[str, dict]:
    if not UNIVERSE_CSV.exists():
        return {}
    with UNIVERSE_CSV.open(newline="", encoding="utf-8") as f:
        return {r["symbol"]: r for r in csv.DictReader(f)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--resume",  action="store_true", help="Skip tickers that already have sector data")
    ap.add_argument("--workers", type=int, default=4,   help="Parallel threads (default 4)")
    ap.add_argument("--pause",   type=float, default=0.5, help="Seconds between requests per thread")
    args = ap.parse_args()

    equities = load_nse_equities()
    if not equities:
        print(f"ERROR: could not read {NSE_CSV}", file=sys.stderr)
        return 1

    existing = load_existing_universe() if args.resume else {}

    todo:  list[dict] = []
    ready: list[dict] = []
    for row in equities:
        ex = existing.get(row["symbol"])
        if args.resume and ex and ex.get("sector"):
            ready.append(ex)
        else:
            todo.append(row)

    grand = len(equities)
    done  = len(ready)

    print(f"Universe  : {grand:,} stocks")
    print(f"To fetch  : {len(todo):,}   Already done: {done:,}")
    print(f"Threads   : {args.workers}   Pause: {args.pause}s/thread")
    print("-" * 60)

    results: list[dict] = list(ready)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {
            pool.submit(fetch_profile, row["symbol"], args.pause): row
            for row in todo
        }
        for fut in as_completed(futures):
            row = futures[fut]
            done += 1
            try:
                sector, industry = fut.result()
            except Exception:
                sector, industry = "", ""

            enriched = {**row, "sector": sector, "industry": industry}
            results.append(enriched)

            pct = done / grand * 100
            with _lock:
                print(f"[{done:>5}/{grand}  {pct:5.1f}%]  {row['symbol']:<20} {sector or '—'}")

    # Preserve original CSV order
    order = {r["symbol"]: i for i, r in enumerate(equities)}
    results.sort(key=lambda r: order.get(r["symbol"], 9999))

    with UNIVERSE_CSV.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDNAMES)
        w.writeheader()
        w.writerows(results)

    filled = sum(1 for r in results if r.get("sector"))
    print("-" * 60)
    print(f"Saved     : {UNIVERSE_CSV}")
    print(f"Sectors   : {filled:,}/{grand:,} populated")
    if grand - filled:
        print(f"Missing   : {grand - filled:,}  (likely SME/illiquid stocks not covered by Yahoo)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
