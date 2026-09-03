from __future__ import annotations

import pandas as pd


def validate_and_clean(df: pd.DataFrame, symbol: str) -> tuple[pd.DataFrame, list[str]]:
    """
    Validate and clean a daily OHLCV DataFrame.

    Returns (cleaned_df, issues) where issues is a list of human-readable
    warning strings. An empty issues list means the data was clean.
    A None return for cleaned_df means the data is unusable.
    """
    issues: list[str] = []

    if df.empty:
        return df, [f"{symbol}: empty DataFrame"]

    original_len = len(df)

    # 1. Sort by date
    if not df.index.is_monotonic_increasing:
        df = df.sort_index()
        issues.append(f"{symbol}: unsorted timestamps — sorted")

    # 2. Drop duplicate dates (keep the last entry for each date)
    dupes = df.index.duplicated(keep="last")
    if dupes.any():
        n = int(dupes.sum())
        df = df[~df.index.duplicated(keep="last")]
        issues.append(f"{symbol}: {n} duplicate date(s) removed")

    # 3. Drop rows where Close is missing (no close = no usable candle)
    missing_close = df["Close"].isna()
    if missing_close.any():
        n = int(missing_close.sum())
        df = df[~missing_close]
        issues.append(f"{symbol}: {n} row(s) with missing Close dropped")

    if df.empty:
        return df, issues + [f"{symbol}: no usable rows after cleaning"]

    # 4. Fill missing Open/High/Low with Close (degenerate candle — still usable)
    for col in ("Open", "High", "Low"):
        missing = df[col].isna()
        if missing.any():
            n = int(missing.sum())
            df.loc[missing, col] = df.loc[missing, "Close"]
            issues.append(f"{symbol}: {n} missing {col} value(s) filled with Close")

    # 5. Fill missing Volume with 0
    if "Volume" in df.columns and df["Volume"].isna().any():
        n = int(df["Volume"].isna().sum())
        df["Volume"] = df["Volume"].fillna(0.0)
        issues.append(f"{symbol}: {n} missing Volume value(s) set to 0")

    # 6. Drop rows with non-positive Close (data corruption)
    bad_price = df["Close"] <= 0
    if bad_price.any():
        n = int(bad_price.sum())
        df = df[~bad_price]
        issues.append(f"{symbol}: {n} row(s) with non-positive Close dropped")

    # 7. Fix broken OHLC relationships (clamp High/Low without dropping the row)
    #    High must be >= Open, Close, Low; Low must be <= Open, Close, High
    df["High"] = df[["Open", "High", "Low", "Close"]].max(axis=1)
    df["Low"]  = df[["Open", "High", "Low", "Close"]].min(axis=1)

    cleaned_len = len(df)
    if cleaned_len < original_len:
        issues.append(f"{symbol}: {original_len - cleaned_len} row(s) removed total")

    return df, issues
