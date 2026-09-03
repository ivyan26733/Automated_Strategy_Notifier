from __future__ import annotations

import pandas as pd

from app.indicators.ema import ema9, ema20
from app.strategies.base import Signal, Strategy


class EmaCrossoverStrategy(Strategy):
    """
    Weekly EMA-9 / EMA-20 Golden Crossover — README §12, §13.

    A FRESH golden crossover fires when:
        previous EMA9 <= previous EMA20  AND  current EMA9 > current EMA20

    The "current" values are computed from the developing weekly close,
    so a crossover detected on Wednesday is a Wednesday signal.

    Duplicate prevention:  a new signal is only generated after the state
    has reset (EMA9 <= EMA20 again after a prior crossover).
    Historical signals are never deleted if the crossover later disappears.
    """

    name = "ema_crossover"

    def generate_signals(
        self,
        symbol: str,
        weekly: pd.DataFrame,
        sector: str,
        industry: str,
    ) -> list[Signal]:
        if weekly is None or len(weekly) < 2:
            return []

        e9  = ema9(weekly["Close"])
        e20 = ema20(weekly["Close"])

        signals: list[Signal] = []
        above = False   # tracks whether EMA9 is currently above EMA20

        for i in range(1, len(weekly)):
            prev9, prev20 = e9.iloc[i - 1], e20.iloc[i - 1]
            curr9, curr20 = e9.iloc[i],     e20.iloc[i]

            # Skip rows where either EMA is not yet initialised
            if pd.isna(prev9) or pd.isna(prev20) or pd.isna(curr9) or pd.isna(curr20):
                continue

            if curr9 > curr20:
                if not above:
                    # Fresh golden crossover
                    if prev9 <= prev20:
                        row          = weekly.iloc[i]
                        obs_date     = row["observation_date"]
                        signal_date  = obs_date.date() if hasattr(obs_date, "date") else obs_date
                        diff         = curr9 - curr20
                        diff_pct     = (diff / curr20) * 100.0 if curr20 else None

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
                above = False   # EMA9 <= EMA20 → state resets

        return signals
