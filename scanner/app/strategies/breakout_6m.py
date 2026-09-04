from __future__ import annotations

from dateutil.relativedelta import relativedelta

import pandas as pd

from app.strategies.base import Signal, Strategy


class Breakout6mStrategy(Strategy):
    """
    Weekly 2–6 Month Consolidation Breakout.

    Fires on the current developing week when:
        developing weekly close  >  highest weekly close in the window
        [obs_date - 6 months,  obs_date - 2 months]

    The 2-month lower bound ages the reference high: the stock must have
    consolidated below that level for at least 2 months before a break
    above it counts as a signal.

    Signal date = today's observation_date (the daily close date, not the
    week-start Monday), so the alert fires on the day it happens.
    """

    name = "breakout_6m"

    def generate_signals(
        self,
        symbol: str,
        weekly: pd.DataFrame,
        sector: str,
        industry: str,
        *,
        daily: pd.DataFrame | None = None,  # unused — kept for interface parity
    ) -> list[Signal]:
        if weekly is None or len(weekly) < 2:
            return []

        # Current developing week
        last       = weekly.iloc[-1]
        obs        = last["observation_date"]
        obs_date   = obs.date() if hasattr(obs, "date") else obs
        curr_close = float(last["Close"])

        # Consolidation reference window: 2–6 months before current obs date
        window_end   = obs_date - relativedelta(months=2)
        window_start = obs_date - relativedelta(months=6)

        # Historical weekly rows only (exclude developing week)
        hist     = weekly.iloc[:-1]
        hist_obs = hist["observation_date"].apply(
            lambda x: x.date() if hasattr(x, "date") else x
        )
        ref = hist.loc[(hist_obs >= window_start) & (hist_obs <= window_end)]

        if ref.empty:
            return []

        ref_high = float(ref["Close"].max())

        if curr_close <= ref_high:
            return []

        breakout_pct = (curr_close / ref_high - 1.0) * 100.0
        return [Signal(
            strategy_name      = self.name,
            signal_type        = "breakout_6m",
            symbol             = symbol,
            signal_date        = obs_date,
            price              = curr_close,
            weekly_close       = curr_close,
            breakout_reference = ref_high,
            breakout_pct       = breakout_pct,
            sector             = sector,
            industry           = industry,
        )]
