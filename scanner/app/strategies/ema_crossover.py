from __future__ import annotations

import numpy as np
import pandas as pd

from app.indicators.ema import ema9, ema20
from app.strategies.base import Signal, Strategy

ATR_PERIOD      = 14
ATR_SPREAD_K    = 0.05   # spread must be >= ATR_SPREAD_K × ATR(14)
EMA20_RISE_WEKS = 4      # monotonic rise required over this many consecutive weeks

# Entry gates. Rolled back on 20 Sep 2026 to the plain fresh weekly golden
# cross the scanner ran from 1 Sep until 9 Sep (commit 5b54096 added the three
# gates below): with all of them on, days passed with no signal at all and the
# Fresh Crossovers tab stayed empty. Each gate is still written out in
# generate_signals — flip a flag to True to put it back, nothing else changes.
REQUIRE_EMA20_RISING = False   # criterion 2: EMA20 up 4 weeks in a row
REQUIRE_ATR_SPREAD   = False   # criterion 3: EMA9-EMA20 gap >= 0.05 x ATR(14)
REQUIRE_VOLUME       = False   # criterion 4: cross-day volume > 20-day average


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

    NOTE: evidence on this gate is mixed. Across all 2016-2022 crosses volume made
    almost no difference (vol > avg 31.0% vs 29.1% win rate, win = +10%). Within
    composite score >= 10, low volume led (41.1% vs 35.3%) but that gap shrank to
    ~1pp in 2023-2026. In a replay of this strategy since 2016, removing the gate
    left the win rate level (37.9% vs 37.4%) while doubling the signal count.
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
    Weekly EMA-9 / EMA-20 Golden Crossover — plain fresh-cross version.

    A signal fires when EMA9 crosses above EMA20 on the weekly series and the
    previous week's EMA9 was not already above it (fresh cross only, enforced
    by the `above` state variable). This is the rule the scanner ran from
    1 Sep 2026 and was rolled back to on 20 Sep 2026.

    Three further gates are implemented but switched OFF at the top of this
    module (REQUIRE_EMA20_RISING / REQUIRE_ATR_SPREAD / REQUIRE_VOLUME):

    2. EMA20 has risen monotonically for the 4 weeks preceding the cross:
       EMA20[i] > EMA20[i-1] > EMA20[i-2] > EMA20[i-3] > EMA20[i-4].
    3. EMA9–EMA20 spread ≥ 0.05 × ATR(14) on weekly data (ATR-based minimum
       spread; filters out thin / noise crosses regardless of % magnitude).
    4. Volume on the last trading day of the crossover week > 20-day average
       daily volume. If daily data is absent the gate is skipped (not rejected).

    The runner passes the developing weekly bar, so a cross surfaces on the day
    it happens rather than at Friday's close, and can repaint.

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
        # Only the EMA20-rising gate needs weeks of history before the cross.
        lookback = EMA20_RISE_WEKS if REQUIRE_EMA20_RISING else 0
        if weekly is None or len(weekly) < lookback + 2:
            return []

        e9  = ema9(weekly["Close"])
        e20 = ema20(weekly["Close"])
        atr = _compute_atr(weekly) if REQUIRE_ATR_SPREAD else None

        signals: list[Signal] = []
        above = False   # True while EMA9 has been above EMA20 since last crossover

        for i in range(lookback + 1, len(weekly)):
            prev9, prev20 = e9.iloc[i - 1], e20.iloc[i - 1]
            curr9, curr20 = e9.iloc[i],     e20.iloc[i]

            if pd.isna(prev9) or pd.isna(prev20) or pd.isna(curr9) or pd.isna(curr20):
                continue

            if curr9 > curr20:
                if not above:
                    if prev9 <= prev20:
                        # ── Criterion 2: EMA20 monotonically rising for 4 weeks ──
                        # e20_vals[0] = current, [1] = 1 week ago, …
                        if REQUIRE_EMA20_RISING:
                            e20_vals = [e20.iloc[i - k] for k in range(EMA20_RISE_WEKS + 1)]
                            if not all(e20_vals[k] > e20_vals[k + 1] for k in range(EMA20_RISE_WEKS)):
                                above = True
                                continue

                        # ── Criterion 3: spread ≥ 0.05 × ATR(14) ────────────────
                        if REQUIRE_ATR_SPREAD:
                            curr_atr = atr.iloc[i]
                            if not pd.isna(curr_atr) and curr_atr > 0:
                                if (curr9 - curr20) < ATR_SPREAD_K * curr_atr:
                                    above = True
                                    continue

                        row      = weekly.iloc[i]
                        obs_date = row["observation_date"]

                        # ── Criterion 4: daily volume > 20-day average ────────────
                        if REQUIRE_VOLUME:
                            vol_ok   = _daily_vol_above_20d(daily, obs_date)
                            if vol_ok is False:   # None → skip gate, False → reject
                                above = True
                                continue

                        # ── Signal passes every enabled gate → emit ────────────────────
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
