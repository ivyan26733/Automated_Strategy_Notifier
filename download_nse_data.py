#!/usr/bin/env python3
"""
NSE Stock Data Downloader
Downloads full OHLCV history from Yahoo Finance for all NSE-listed stocks.
Uses only Python stdlib — no pip installs required.

Usage:
    python download_nse_data.py                  # download missing stocks
    python download_nse_data.py --update         # also fetch new candles for existing stocks
    python download_nse_data.py --workers 8      # parallel threads (default 5)
    python download_nse_data.py --tickers RELIANCE INFY TCS   # specific symbols only
    python download_nse_data.py --pause 0.3      # seconds between requests per thread
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, date, datetime
from pathlib import Path
from threading import Lock

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
BASE_DIR   = Path(__file__).parent
NSE_CSV    = BASE_DIR / "nse_equities.csv"
STOCK_DIR  = BASE_DIR / "stock_data"
ERROR_LOG  = BASE_DIR / "errors.log"

YAHOO_URL  = "https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
USER_AGENT = "Mozilla/5.0 (compatible; NSEDownloader/1.0)"
FIELDNAMES = ["Date", "Open", "High", "Low", "Close", "Adj Close", "Volume"]

_print_lock = Lock()


# ---------------------------------------------------------------------------
# Yahoo Finance helpers
# ---------------------------------------------------------------------------
def _fetch_raw(ticker: str, period1: int) -> list[dict]:
    query = urllib.parse.urlencode({
        "period1": period1,
        "period2": int(time.time()),
        "interval": "1d",
        "includeAdjustedClose": "true",
        "events": "history",
    })
    url = f"{YAHOO_URL.format(ticker=urllib.parse.quote(ticker, safe='.^-='))}?{query}"
    req = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"}
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.load(resp)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"Network error: {e.reason}") from e

    chart = payload.get("chart", {})
    if chart.get("error"):
        raise RuntimeError(chart["error"].get("description", "Unknown Yahoo error"))

    result = (chart.get("result") or [None])[0]
    if not result:
        raise RuntimeError("Empty result from Yahoo")

    timestamps = result.get("timestamp") or []
    quote      = (result.get("indicators", {}).get("quote") or [{}])[0]
    adj_list   = (result.get("indicators", {}).get("adjclose") or [{}])[0].get("adjclose", [])

    def _val(lst, i):
        return lst[i] if lst and i < len(lst) and lst[i] is not None else ""

    rows = []
    for i, ts in enumerate(timestamps):
        close = _val(quote.get("close", []), i)
        if close == "":
            continue  # skip candles with no close
        rows.append({
            "Date":      datetime.fromtimestamp(ts, UTC).date().isoformat(),
            "Open":      _val(quote.get("open", []), i),
            "High":      _val(quote.get("high", []), i),
            "Low":       _val(quote.get("low", []), i),
            "Close":     close,
            "Adj Close": _val(adj_list, i),
            "Volume":    _val(quote.get("volume", []), i),
        })
    return rows


# ---------------------------------------------------------------------------
# CSV helpers
# ---------------------------------------------------------------------------
def _safe_name(ticker: str) -> str:
    return "".join(c if c.isalnum() or c in ".-_" else "_" for c in ticker)


def _csv_path(ticker: str) -> Path:
    return STOCK_DIR / f"{_safe_name(ticker)}_daily_history.csv"


def _last_date(path: Path) -> date | None:
    try:
        with path.open(newline="", encoding="utf-8") as f:
            last = None
            for row in csv.DictReader(f):
                if row.get("Date"):
                    last = row["Date"]
            return date.fromisoformat(last) if last else None
    except Exception:
        return None


def _read_csv(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _write_csv(path: Path, rows: list[dict]) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDNAMES)
        w.writeheader()
        w.writerows(rows)


# ---------------------------------------------------------------------------
# Per-ticker logic
# ---------------------------------------------------------------------------
def process_ticker(ticker: str, update: bool, pause: float) -> tuple[str, str]:
    """Download or update one ticker. Returns (ticker, status)."""
    path = _csv_path(ticker)

    period1       = 0       # epoch 0 → fetch all history
    existing_rows: list[dict] = []

    if path.exists():
        last = _last_date(path)
        if last is None:
            pass  # corrupt file — re-download from scratch
        elif not update:
            # Skip files that are already up to date (within last 5 trading days)
            age = (date.today() - last).days
            if age <= 7:
                return ticker, f"skip  ({last})"
            # Outdated but --update not set; still refresh to keep data current
        # Fetch only candles newer than what we have
        if last:
            period1 = int(datetime(last.year, last.month, last.day, tzinfo=UTC).timestamp()) + 86400
            if period1 >= int(time.time()):
                return ticker, f"up-to-date  ({last})"
            existing_rows = _read_csv(path)

    time.sleep(pause)

    try:
        new_rows = _fetch_raw(ticker, period1)
    except RuntimeError as e:
        return ticker, f"ERROR {e}"

    if not new_rows:
        return ticker, "up-to-date"

    if existing_rows:
        known = {r["Date"] for r in existing_rows}
        new_rows = [r for r in new_rows if r["Date"] not in known]
        if not new_rows:
            return ticker, "up-to-date"
        merged = existing_rows + new_rows
        _write_csv(path, merged)
        return ticker, f"+{len(new_rows):,} rows  (total {len(merged):,})"

    _write_csv(path, new_rows)
    return ticker, f"{len(new_rows):,} rows  ({new_rows[0]['Date']} → {new_rows[-1]['Date']})"


# ---------------------------------------------------------------------------
# NSE symbol list
# ---------------------------------------------------------------------------
def load_symbols(extra_tickers: list[str]) -> list[str]:
    symbols: list[str] = []

    if NSE_CSV.exists():
        try:
            with NSE_CSV.open(newline="", encoding="utf-8-sig") as f:
                for row in csv.DictReader(f):
                    sym = row.get("SYMBOL", "").strip()
                    if sym:
                        symbols.append(f"{sym}.NS")
        except OSError as e:
            print(f"Warning: could not read {NSE_CSV}: {e}", file=sys.stderr)
    else:
        print(f"Warning: {NSE_CSV} not found; pass tickers via --tickers", file=sys.stderr)

    for t in extra_tickers:
        t = t.strip().upper()
        if t and not t.endswith(".NS"):
            t += ".NS"
        if t:
            symbols.append(t)

    # deduplicate while preserving order
    seen: set[str] = set()
    result = []
    for s in symbols:
        if s not in seen:
            seen.add(s)
            result.append(s)
    return result


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Download NSE stock OHLCV data from Yahoo Finance.")
    p.add_argument("--update",  action="store_true", help="Refresh existing files with latest candles")
    p.add_argument("--workers", type=int, default=5,  help="Parallel download threads (default 5)")
    p.add_argument("--pause",   type=float, default=0.3, help="Seconds to sleep between requests per thread (default 0.3)")
    p.add_argument("--tickers", nargs="*", default=[], metavar="SYM", help="Download only these NSE symbols (e.g. RELIANCE INFY)")
    return p.parse_args()


def main() -> int:
    args = parse_args()

    if args.tickers:
        # If specific tickers given, use only those
        symbols = []
        for t in args.tickers:
            t = t.strip().upper()
            if not t.endswith(".NS"):
                t += ".NS"
            symbols.append(t)
    else:
        symbols = load_symbols([])

    if not symbols:
        print("No symbols to process. Add NSE_equities.csv or use --tickers.")
        return 1

    STOCK_DIR.mkdir(parents=True, exist_ok=True)
    total   = len(symbols)
    done    = 0
    errors  = []
    skipped = 0

    print(f"Symbols : {total:,}")
    print(f"Mode    : {'update existing + download missing' if args.update else 'download missing / refresh outdated'}")
    print(f"Threads : {args.workers}   Pause: {args.pause}s/thread")
    print(f"Output  : {STOCK_DIR}")
    print("-" * 60)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(process_ticker, sym, args.update, args.pause): sym for sym in symbols}
        for fut in as_completed(futures):
            sym = futures[fut]
            done += 1
            try:
                _, status = fut.result()
            except Exception as e:
                status = f"ERROR {e}"

            is_error = status.startswith("ERROR")
            is_skip  = status.startswith("skip")

            if is_error:
                errors.append(f"{sym}: {status}")
            if is_skip:
                skipped += 1

            pct = done / total * 100
            # Only print non-skip lines to keep output tidy; always print errors
            if not is_skip or is_error:
                with _print_lock:
                    print(f"[{done:>5}/{total}  {pct:5.1f}%]  {sym:<30} {status}")

    print("-" * 60)
    print(f"Done. {total - len(errors) - skipped:,} updated/downloaded  |  {skipped:,} skipped  |  {len(errors):,} errors")

    if errors:
        ERROR_LOG.write_text("\n".join(errors), encoding="utf-8")
        print(f"Errors written to {ERROR_LOG}")

    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
