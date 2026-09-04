from __future__ import annotations

import pandas as pd

from app.utils.dates import ts_week_monday


def build_weekly(daily: pd.DataFrame) -> pd.DataFrame:
    """
    Build weekly OHLCV candles from daily data using the developing-week rule.

    The last row of the output is always the *developing* (current) week,
    constructed from all available daily bars up to and including the latest
    trading day — regardless of which day of the week that is.

    Weekly aggregation:
        Open   = first trading day's open in the week
        High   = highest high in the week
        Low    = lowest low in the week
        Close  = latest trading day's close (developing or completed)
        Volume = sum of daily volumes in the week

    Returns a DataFrame indexed by week_start (Monday midnight) with columns:
        Open, High, Low, Close, Volume, observation_date, is_developing
    """
    if daily.empty:
        return pd.DataFrame()

    # Assign each daily bar to its ISO week (keyed by that week's Monday)
    week_keys = daily.index.map(ts_week_monday)

    records: list[dict] = []
    for week_start, group in daily.groupby(week_keys):
        records.append({
            "week_start":       week_start,
            "Open":             float(group["Open"].iloc[0]),
            "High":             float(group["High"].max()),
            "Low":              float(group["Low"].min()),
            "Close":            float(group["Close"].iloc[-1]),
            "Volume":           float(group["Volume"].sum()),
            "observation_date": group.index[-1],   # last trading day in this group
        })

    weekly = pd.DataFrame(records).set_index("week_start")
    weekly.index.name = "week_start"

    weekly["is_developing"] = False
    weekly.iloc[-1, weekly.columns.get_loc("is_developing")] = True

    return weekly
