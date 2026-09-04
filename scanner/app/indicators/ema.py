from __future__ import annotations

import math

import pandas as pd

# Multipliers per README §10 and §11 — must not change without explicit instruction
ALPHA_9:  float = 2.0 / (9  + 1)          # 0.2
ALPHA_20: float = 2.0 / (20 + 1)          # 0.09523809523809523


def compute_ema(closes: pd.Series, period: int) -> pd.Series:
    """
    Compute EMA for a series of weekly closes.

    Matches Pine Script ta.ema() exactly:
    Initialization:  EMA[first_valid] = close[first_valid]   (first-close seed)
    Subsequent:      EMA[t] = Close[t] * alpha + EMA[t-1] * (1 - alpha)
                     where alpha = 2 / (period + 1)

    Returns a Series with the same index as `closes`.
    Values before the first non-NaN close are NaN.
    """
    if period < 1:
        raise ValueError(f"period must be >= 1, got {period}")

    alpha = 2.0 / (period + 1)
    arr   = closes.to_numpy(dtype=float, na_value=float("nan"))
    out   = [float("nan")] * len(arr)

    # Seed on the first non-NaN value — identical to Pine Script ta.ema()
    seed = next((i for i, v in enumerate(arr) if not math.isnan(v)), None)
    if seed is None:
        return pd.Series(out, index=closes.index, name=f"EMA{period}", dtype=float)

    out[seed] = arr[seed]
    for i in range(seed + 1, len(arr)):
        if math.isnan(arr[i]):
            out[i] = out[i - 1]          # carry forward over data gaps
        else:
            out[i] = arr[i] * alpha + out[i - 1] * (1.0 - alpha)

    return pd.Series(out, index=closes.index, name=f"EMA{period}", dtype=float)


def ema9(closes: pd.Series) -> pd.Series:
    """EMA-9 on weekly closes per README §10."""
    return compute_ema(closes, 9)


def ema20(closes: pd.Series) -> pd.Series:
    """EMA-20 on weekly closes per README §11."""
    return compute_ema(closes, 20)
