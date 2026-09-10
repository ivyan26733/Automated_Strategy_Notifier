from __future__ import annotations

import numpy as np
import pandas as pd

from app.indicators.ema import ema9, ema20
from app.strategies.base import Signal, Strategy

ATR_PERIOD      = 14
ATR_SPREAD_K    = 0.05   # spread must be >= ATR_SPREAD_K × ATR(14)
EMA20_RISE_WEKS = 4      # monotonic rise required over this many consecutive weeks


def _compute_atr(weekly: pd.DataFrame, period: int = ATR_PERIOD) -> pd.Series:
    """
    ATR using Wilder's smoothing on weekly OHLC data.

    Seed = simple average of the first `period` true-range values;
    subsequent values use Wilder's recursive formula:
        ATR[i] = (ATR[i-1] × (period-1) + TR[i]) / period
    """
    high  = weekly["High"].to_numpy(dtype=float)
    low   = weekly["Low"].to_numpy(dtype=float)
    close = weekly["Close"].to_numpy(dtype=float)
    n = len(high)
    tr  = np.full(n, float("nan"))
    atr = np.full(n, float("nan"))

    for i in range(1, n):
        if not (np.isnan(high[i]) or np.isnan(low[i]) or np.isnan(close[i - 1])):
            tr[i] = max(
                high[i] - low[i],
                abs(high[i] - close[i - 1]),
                abs(low[i]  - close[i - 1]),
            )

    first = next((i for i in range(1, n) if not np.isnan(tr[i])), None)
    if first is not None:
        seed_slice = tr[first : first + period]
        valid      = seed_slice[~np.isnan(seed_slice)]
        if len(valid) == period:
            atr[first + period - 1] = valid.mean()
            for i in range(first + period, n):
                if not (np.isnan(tr[i]) or np.isnan(atr[i - 1])):
                    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period

    return pd.Series(atr, index=weekly.index, name=f"ATR{period}")


def _daily_vol_above_20d(daily: pd.DataFrame | None, obs_date) -> bool | None:
    """
    True  → volume on obs_date > mean volume of the 20 prior trading days.
    None  → insufficient data; caller treats this as gate-skipped (not rejected).

    NOTE: backtest finding (vol_ratio_20d, 2016-2022): within tech-filtered signals,
    LOW-volume signals (vol < 20d avg) OUTPERFORM high-volume signals:
      Tech≥10 + low vol: 41.1% WR (+11.1pp) n=414
      Tech≥10 + high vol: 35.3% WR (+5.3pp)  n=759
    This criterion is implemented as specified; consider reviewing this data point.
    """
    if daily is None or daily.empty:
        return None
    cutoff = pd.Timestamp(obs_date)
    past   = daily[daily.index <= cutoff]
    if len(past) < 21:   # need today + 20 prior trading days
        return None
    today_vol = float(past.iloc[-1]["Volume"])
    avg_20d   = float(past.iloc[-21:-1]["Volume"].mean())
    if avg_20d == 0:
        return None
    return today_vol > avg_20d


class EmaCrossoverStrategy(Strategy):
    """
    Weekly EMA-9 / EMA-20 Golden Crossover — 6-criteria selective version.

    ALL six criteria must be satisfied for a signal to fire:

    1. EMA9 crosses above EMA20 on the current completed weekly candle.
    2. EMA20 has risen monotonically for the 4 weeks preceding the cross:
       EMA20[i] > EMA20[i-1] > EMA20[i-2] > EMA20[i-3] > EMA20[i-4].
    3. EMA9–EMA20 spread ≥ 0.05 × ATR(14) on weekly data (ATR-based minimum
       spread; filters out thin / noise crosses regardless of % magnitude).
    4. Volume on the last trading day of the crossover week > 20-day average
       daily volume. If daily data is absent the gate is skipped (not rejected).
    5. Crossover occurs on a completed weekly candle (enforced by the weekly
       DataFrame having only non-developing rows in the historical loop).
    6. Previous week's EMA9 was NOT already above EMA20 (fresh cross only;
       enforced by the `above` state variable).

    Also emits `death_cross` when EMA9 falls back below EMA20 while a position
    is open — the exit side of the same state machine. Unlike golden_cross,
    death_cross carries no quality gates: an exit isn't conditional on the
    volume/spread/trend checks that filter entries.

    Fundamentals are NOT a selection criterion here — pass signals to an
    external ranking step (see ema_fundamental.py for a combined variant).

    Implementation assumptions:
    - ATR computed on weekly OHLC (same timeframe as signals).
    - "Rising 4 weeks" = strict monotonic over indices [i-4 … i].
    - "Current daily volume" = volume on obs_date (last trading day of
      the crossover week, as recorded in weekly["observation_date"]).
    """

    name = "ema_crossover"

    def generate_signals(
        self,
        symbol: str,
        weekly: pd.DataFrame,
        sector: str,
        industry: str,
        *,
        daily: pd.DataFrame | None = None,
    ) -> list[Signal]:
        min_rows = EMA20_RISE_WEKS + 2   # need i >= EMA20_RISE_WEKS + 1 in the loop
        if weekly is None or len(weekly) < min_rows:
            return []

        e9  = ema9(weekly["Close"])
        e20 = ema20(weekly["Close"])
        atr = _compute_atr(weekly)

        signals: list[Signal] = []
        above = False   # True while EMA9 has been above EMA20 since last crossover

        for i in range(EMA20_RISE_WEKS + 1, len(weekly)):
            prev9, prev20 = e9.iloc[i - 1], e20.iloc[i - 1]
            curr9, curr20 = e9.iloc[i],     e20.iloc[i]

            if pd.isna(prev9) or pd.isna(prev20) or pd.isna(curr9) or pd.isna(curr20):
                continue

            if curr9 > curr20:
                if not above:
                    if prev9 <= prev20:
                        # ── Criterion 2: EMA20 monotonically rising for 4 weeks ──
                        # e20_vals[0] = current, [1] = 1 week ago, …
                        e20_vals = [e20.iloc[i - k] for k in range(EMA20_RISE_WEKS + 1)]
                        if not all(e20_vals[k] > e20_vals[k + 1] for k in range(EMA20_RISE_WEKS)):
                            above = True
                            continue

                        # ── Criterion 3: spread ≥ 0.05 × ATR(14) ────────────────
                        curr_atr = atr.iloc[i]
                        if not pd.isna(curr_atr) and curr_atr > 0:
                            if (curr9 - curr20) < ATR_SPREAD_K * curr_atr:
                                above = True
                                continue

                        # ── Criterion 4: daily volume > 20-day average ────────────
                        row      = weekly.iloc[i]
                        obs_date = row["observation_date"]
                        vol_ok   = _daily_vol_above_20d(daily, obs_date)
                        if vol_ok is False:   # None → skip gate, False → reject
                            above = True
                            continue

                        # ── Signal passes all criteria → emit ────────────────────
                        signal_date = obs_date.date() if hasattr(obs_date, "date") else obs_date
                        diff        = curr9 - curr20
                        diff_pct    = (diff / curr20) * 100.0 if curr20 else None

                        signals.append(Signal(
                            strategy_name      = self.name,
                            signal_type        = "golden_cross",
                            symbol             = symbol,
                            signal_date        = signal_date,
                            price              = float(row["Close"]),
                            weekly_close       = float(row["Close"]),
                            ema9               = float(curr9),
                            ema20              = float(curr20),
                            ema_difference     = float(diff),
                            ema_difference_pct = float(diff_pct) if diff_pct is not None else None,
                            sector             = sector,
                            industry           = industry,
                        ))
                    above = True
            else:
                if above:
                    # ── Death cross: EMA9 has crossed back below EMA20 ──────────
                    # No quality gates here — an exit is not conditional on the
                    # volume/spread/trend criteria that gate entries. Same
                    # repainting trade-off as the golden cross: this fires on the
                    # developing bar, so a mid-week dip can reverse before the
                    # week closes and re-fire as a fresh row (signal_date
                    # advances daily on the same underlying event, exactly like
                    # golden_cross duplicates — collapsed downstream by
                    # consecutive-same-type dedup, not filtered here).
                    row      = weekly.iloc[i]
                    obs_date = row["observation_date"]
                    signal_date = obs_date.date() if hasattr(obs_date, "date") else obs_date
                    diff     = curr9 - curr20
                    diff_pct = (diff / curr20) * 100.0 if curr20 else None

                    signals.append(Signal(
                        strategy_name      = self.name,
                        signal_type        = "death_cross",
                        symbol             = symbol,
                        signal_date        = signal_date,
                        price              = float(row["Close"]),
                        weekly_close       = float(row["Close"]),
                        ema9               = float(curr9),
                        ema20              = float(curr20),
                        ema_difference     = float(diff),
                        ema_difference_pct = float(diff_pct) if diff_pct is not None else None,
                        sector             = sector,
                        industry           = industry,
                    ))
                above = False   # EMA9 <= EMA20 → state resets

        return signals
