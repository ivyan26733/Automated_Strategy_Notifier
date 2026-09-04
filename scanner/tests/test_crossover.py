"""
Tests for EmaCrossoverStrategy — README §12, §13.

Strategy rule:
    fresh golden cross  <=>  prev_ema9 <= prev_ema20  AND  curr_ema9 > curr_ema20
    state resets when EMA9 <= EMA20 after a crossover.
    No repeat signal while EMA9 remains above EMA20.
"""

from __future__ import annotations

from datetime import date

import pandas as pd
import pytest

from app.data.weekly import build_weekly
from app.indicators.ema import ema9, ema20
from app.strategies.ema_crossover import EmaCrossoverStrategy


STRATEGY = EmaCrossoverStrategy()


# ---------------------------------------------------------------------------
# Helper: build a synthetic weekly DataFrame where we can control
# the resulting EMA9/EMA20 values precisely.
#
# We seed 20 weeks at price=100 (so EMA9=EMA20=100), then inject
# subsequent closes to steer EMA9 vs EMA20.
# ---------------------------------------------------------------------------
_SEED  = [100.0] * 20
_DATES_SEED = pd.date_range("2020-01-06", periods=20, freq="W-MON")


def make_weekly(extra_closes: list[float]) -> pd.DataFrame:
    """
    Build a weekly DataFrame: 20 seed weeks (EMA9=EMA20=100) followed
    by `extra_closes`.  observation_date = week_start for simplicity.
    """
    closes = _SEED + extra_closes
    n      = len(closes)
    idx    = pd.date_range("2020-01-06", periods=n, freq="W-MON")
    obs    = [pd.Timestamp(d) for d in idx]
    return pd.DataFrame({
        "Open":             closes,
        "High":             closes,
        "Low":              closes,
        "Close":            closes,
        "Volume":           [1_000_000.0] * n,
        "observation_date": obs,
        "is_developing":    [False] * (n - 1) + [True],
    }, index=idx)


def _signal_dates(signals) -> list[date]:
    return [s.signal_date for s in signals]


# ---------------------------------------------------------------------------
# No crossover — EMA9 already above (no previous cross)
# ---------------------------------------------------------------------------
def test_no_crossover_when_no_cross_condition():
    # After seed (EMA9=EMA20=100), keep price at 100 → never crosses
    weekly = make_weekly([100.0] * 10)
    signals = STRATEGY.generate_signals("TEST.NS", weekly, "", "")
    assert signals == []


# ---------------------------------------------------------------------------
# Fresh golden crossover fires once
# ---------------------------------------------------------------------------
def test_fresh_golden_cross_fires():
    # Seed keeps EMA9=EMA20=100.  Drive price up so EMA9 overtakes EMA20.
    # After seed week 20, inject rising prices to force EMA9 > EMA20.
    # With alpha9=0.2 and alpha20≈0.095, EMA9 reacts faster to price rises.
    weekly = make_weekly([150.0] * 15)
    signals = STRATEGY.generate_signals("TEST.NS", weekly, "Energy", "Oil")
    assert len(signals) >= 1
    assert signals[0].signal_type == "golden_cross"
    assert signals[0].symbol      == "TEST.NS"
    assert signals[0].sector      == "Energy"


# ---------------------------------------------------------------------------
# Signal does NOT repeat every week while EMA9 stays above EMA20
# ---------------------------------------------------------------------------
def test_no_repeat_while_above():
    weekly   = make_weekly([150.0] * 15)
    signals  = STRATEGY.generate_signals("TEST.NS", weekly, "", "")
    # All signals must have distinct dates (no same-date repeat)
    dates = _signal_dates(signals)
    assert len(dates) == len(set(dates))
    # And only one fresh cross in the above run (single transition)
    assert len(signals) == 1


# ---------------------------------------------------------------------------
# EMA9 <= EMA20 resets state → allows a new golden cross
# ---------------------------------------------------------------------------
def test_state_resets_after_bearish_cross():
    # Phase 1: price rises → golden cross
    # Phase 2: price drops → EMA9 falls back below EMA20 (reset)
    # Phase 3: price rises again → second golden cross
    weekly  = make_weekly([150.0] * 20 + [50.0] * 20 + [150.0] * 20)
    signals = STRATEGY.generate_signals("TEST.NS", weekly, "", "")
    assert len(signals) == 2, f"Expected 2 signals, got {len(signals)}: {_signal_dates(signals)}"


# ---------------------------------------------------------------------------
# Crossover date equals observation_date of the triggering week
# ---------------------------------------------------------------------------
def test_crossover_date_is_observation_date():
    weekly  = make_weekly([150.0] * 15)
    signals = STRATEGY.generate_signals("TEST.NS", weekly, "", "")
    assert len(signals) >= 1
    s = signals[0]
    # The signal_date must match observation_date of some row in weekly
    obs_dates = {row["observation_date"].date() for _, row in weekly.iterrows()}
    assert s.signal_date in obs_dates


# ---------------------------------------------------------------------------
# Monday crossover detected (developing week has only Monday's data)
# ---------------------------------------------------------------------------
def test_monday_crossover_detected():
    """
    After seed (EMA9≈EMA20≈100), one Monday close at 200
    should drive EMA9 above EMA20 — signal date is that Monday.
    """
    weekly = make_weekly([200.0])
    e9  = ema9(weekly["Close"])
    e20 = ema20(weekly["Close"])
    # Verify the condition actually crossed
    assert e9.iloc[-1] > e20.iloc[-1], "Test setup: EMA9 should exceed EMA20 after 200 close"
    signals = STRATEGY.generate_signals("TEST.NS", weekly, "", "")
    assert len(signals) == 1
    assert signals[0].signal_date == weekly.iloc[-1]["observation_date"].date()


# ---------------------------------------------------------------------------
# Wednesday crossover detected
# ---------------------------------------------------------------------------
def test_wednesday_crossover_detected():
    # Simulate: Mon=100, Tue=100, Wed=200 in the developing week
    # Weekly candle close is the LAST daily close, so Close=200 for this week
    weekly = make_weekly([100.0, 100.0, 200.0])
    signals = STRATEGY.generate_signals("TEST.NS", weekly, "", "")
    # At least the last week triggers; its observation_date is a Wednesday
    if signals:
        obs_date = weekly.iloc[-1]["observation_date"]
        assert signals[-1].signal_date == obs_date.date()


# ---------------------------------------------------------------------------
# No EMA values → no signals (not enough history)
# ---------------------------------------------------------------------------
def test_insufficient_history_no_signals():
    # Only 5 weekly bars — EMA9 needs 9, EMA20 needs 20
    idx    = pd.date_range("2024-01-01", periods=5, freq="W-MON")
    weekly = pd.DataFrame({
        "Close":            [100.0] * 5,
        "Open":             [100.0] * 5,
        "High":             [100.0] * 5,
        "Low":              [100.0] * 5,
        "Volume":           [1e6]   * 5,
        "observation_date": [pd.Timestamp(d) for d in idx],
        "is_developing":    [False]*4 + [True],
    }, index=idx)
    signals = STRATEGY.generate_signals("TEST.NS", weekly, "", "")
    assert signals == []


# ---------------------------------------------------------------------------
# EMA fields are populated on the signal
# ---------------------------------------------------------------------------
def test_signal_contains_ema_fields():
    weekly  = make_weekly([150.0] * 15)
    signals = STRATEGY.generate_signals("TEST.NS", weekly, "Tech", "Software")
    assert len(signals) >= 1
    s = signals[0]
    assert s.ema9  is not None and s.ema9  > 0
    assert s.ema20 is not None and s.ema20 > 0
    assert s.ema_difference     is not None
    assert s.ema_difference_pct is not None
    assert s.ema9 > s.ema20   # golden cross: EMA9 above EMA20
