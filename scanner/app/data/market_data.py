from __future__ import annotations

import pandas as pd

from app.config.settings import settings


def _safe_name(symbol: str) -> str:
    return "".join(c if c.isalnum() or c in ".-_" else "_" for c in symbol)


def load_daily(symbol: str) -> pd.DataFrame:
    """
    Load daily OHLCV for symbol from the local CSV store.

    Tries both `SYMBOL_daily_history.csv` and `SYMBOL.NS_daily_history.csv`
    so plain NSE symbols (e.g. "RELIANCE") resolve to the downloaded file
    ("RELIANCE.NS_daily_history.csv") without requiring callers to know the suffix.

    Returns a DataFrame with DatetimeIndex and columns [Open, High, Low, Close, Volume].
    Returns an empty DataFrame if no matching file exists.
    Numeric columns are coerced to float; unparseable values become NaN.
    """
    candidates = [symbol]
    if not symbol.endswith(".NS"):
        candidates.append(f"{symbol}.NS")

    path = None
    for sym in candidates:
        p = settings.data_dir / f"{_safe_name(sym)}_daily_history.csv"
        if p.exists():
            path = p
            break

    if path is None:
        return pd.DataFrame()

    df = pd.read_csv(path, index_col="Date", parse_dates=["Date"])
    df.index = pd.DatetimeIndex(df.index)

    for col in ("Open", "High", "Low", "Close", "Volume"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    keep = [c for c in ("Open", "High", "Low", "Close", "Volume") if c in df.columns]
    return df[keep].copy()
