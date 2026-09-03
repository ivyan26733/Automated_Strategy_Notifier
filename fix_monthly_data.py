#!/usr/bin/env python3
"""
Delete stock CSV files that contain monthly data (avg bar gap > 10 days).
After running this, run:
    python download_nse_data.py --workers 8
to re-download them with proper daily OHLCV data.
"""
from __future__ import annotations
import csv
from datetime import date
from pathlib import Path

STOCK_DIR = Path(__file__).parent / "stock_data"


def avg_gap(path: Path) -> float:
    """Return average days between rows. > 10 means monthly data."""
    dates = []
    try:
        with path.open(newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                d = row.get("Date", "").strip()
                if d:
                    try:
                        dates.append(date.fromisoformat(d))
                    except ValueError:
                        pass
    except Exception:
        return 0.0
    if len(dates) < 5:
        return 0.0
    span = (max(dates) - min(dates)).days
    return span / len(dates)


def main() -> None:
    files = sorted(STOCK_DIR.glob("*_daily_history.csv"))
    monthly_files = []
    for f in files:
        g = avg_gap(f)
        if g > 10:
            monthly_files.append(f)

    print(f"Found {len(monthly_files)} files with monthly data (avg gap > 10 days)")
    print("Deleting them so the downloader fetches fresh daily data...\n")

    for f in monthly_files:
        f.unlink()
        print(f"  deleted: {f.name}")

    print(f"\nDone. Deleted {len(monthly_files)} files.")
    print("\nNow run:")
    print("  python download_nse_data.py --workers 8")
    print("to re-download with proper daily OHLCV data.")


if __name__ == "__main__":
    main()
