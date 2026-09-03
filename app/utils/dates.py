from datetime import date, timedelta

import pandas as pd


def week_monday(d: date) -> date:
    """Return the Monday of the ISO week containing d."""
    return d - timedelta(days=d.weekday())


def ts_week_monday(ts: pd.Timestamp) -> pd.Timestamp:
    """Return midnight-Monday of the week containing ts."""
    return ts - pd.Timedelta(days=ts.dayofweek)
