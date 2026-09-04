"""
Tests for Breakout6mStrategy — weekly 2–6 month consolidation breakout.

Rule: current developing weekly close > highest weekly close in the
      consolidation window [obs_date - 6 months, obs_date - 2 months].

The 2-month lower bound means a high from last month does NOT count as the
reference level — the stock must have consolidated below an aged high before
the break counts.
"""

from __future__ import annotations

from datetime import date, timedelta

import pandas as pd
import pytest
from dateutil.relativedelta import relativedelta

from app.strategies.breakout_6m import Breakout6mStrategy


STRATEGY = Breakout6mStrategy()

# Anchor date used across most tests (a Monday)
TODAY = date(2024, 9, 2)


# ---------------------------------------------------------------------------
# Helper: build a weekly DataFrame
# ---------------------------------------------------------------------------
def make_weekly(obs_dates: list[date], closes: list[float]) -> pd.DataFrame:
    """
    Build a minimal weekly DataFrame (same structure as build_weekly output).
    Each obs_date is treated as the observation_date for that week.
    The last row is marked is_developing=True.
    """
    records = []
    for obs, close in zip(obs_dates, closes):
        week_start = obs - timedelta(days=obs.weekday())  # preceding Monday
        records.append({
            "week_start":       pd.Timestamp(week_start),
            "Open":             close,
            "High":             close,
            "Low":              close,
            "Close":            close,
            "Volume":           1_000_000.0,
            "observation_date": pd.Timestamp(obs),
            "is_developing":    False,
        })
    df = pd.DataFrame(records).set_index("week_start")
    df.iloc[-1, df.columns.get_loc("is_developing")] = True
    return df


def _spanning_weekly(today: date, ref_high: float, today_close: float) -> pd.DataFrame:
    """
    7 months of weekly history: all historical closes = ref_high,
    current (developing) close = today_close.
    Obs dates are spaced 7 days apart so some fall in the 2–6m window.
    """
    start  = today - relativedelta(months=7)
    dates  = []
    d      = start
    while d < today:
        dates.append(d)
        d += timedelta(days=7)
    obs_dates = dates + [today]
    closes    = [ref_high] * len(dates) + [today_close]
    return make_weekly(obs_dates, closes)


# ---------------------------------------------------------------------------
# Empty / too-short weekly → no signal
# ---------------------------------------------------------------------------
def test_empty_weekly_no_signal():
    sigs = STRATEGY.generate_signals("X.NS", pd.DataFrame(), "", "")
    assert sigs == []


def test_single_row_no_signal():
    df = make_weekly([TODAY], [200.0])
    assert STRATEGY.generate_signals("X.NS", df, "", "") == []


# ---------------------------------------------------------------------------
# Basic breakout: current close > ref high → signal fires
# ---------------------------------------------------------------------------
def test_close_above_ref_fires_signal():
    df   = _spanning_weekly(TODAY, ref_high=100.0, today_close=101.0)
    sigs = STRATEGY.generate_signals("X.NS", df, "Energy", "Oil")
    assert len(sigs) == 1
    s = sigs[0]
    assert s.strategy_name      == "breakout_6m"
    assert s.signal_type        == "breakout_6m"
    assert s.symbol             == "X.NS"
    assert s.price              == 101.0
    assert s.weekly_close       == 101.0
    assert s.breakout_reference == 100.0
    assert abs(s.breakout_pct - 1.0) < 1e-9


# ---------------------------------------------------------------------------
# Equal to ref → no signal (strict >)
# ---------------------------------------------------------------------------
def test_close_equal_to_ref_no_signal():
    df = _spanning_weekly(TODAY, ref_high=100.0, today_close=100.0)
    assert STRATEGY.generate_signals("X.NS", df, "", "") == []


# ---------------------------------------------------------------------------
# Below ref → no signal
# ---------------------------------------------------------------------------
def test_close_below_ref_no_signal():
    df = _spanning_weekly(TODAY, ref_high=100.0, today_close=99.99)
    assert STRATEGY.generate_signals("X.NS", df, "", "") == []


# ---------------------------------------------------------------------------
# Recent high (< 2 months old) is NOT in reference window → ignored
# A high from 5 weeks ago must not block the signal if the 2–6m window high
# is lower than today's close.
# ---------------------------------------------------------------------------
def test_recent_high_outside_window_is_ignored():
    # Ref window for TODAY (2024-09-02):
    #   window_end   = 2024-07-02  (2 months ago)
    #   window_start = 2024-03-02  (6 months ago)

    # Build 3 groups of weeks:
    #   old    : obs_dates 7 months ago — before window (excluded)
    #   in_win : obs_dates in the 2–6m window, closes = 100
    #   recent : obs_dates < 2 months ago (excluded), closes = 200   ← recent peak
    #   current: today, close = 150 → should fire (ref_high = 100, NOT 200)

    window_end   = TODAY - relativedelta(months=2)   # 2024-07-02
    window_start = TODAY - relativedelta(months=6)   # 2024-03-02

    obs_dates = []
    closes    = []

    # In-window weeks (ref_high = 100)
    d = window_start
    while d <= window_end:
        obs_dates.append(d)
        closes.append(100.0)
        d += timedelta(days=7)

    # Recent weeks outside window (high = 200, must NOT be in ref)
    d = window_end + timedelta(days=7)
    while d < TODAY:
        obs_dates.append(d)
        closes.append(200.0)
        d += timedelta(days=7)

    # Current developing week
    obs_dates.append(TODAY)
    closes.append(150.0)   # 150 > 100 → breakout (ref = 100, not 200)

    df   = make_weekly(obs_dates, closes)
    sigs = STRATEGY.generate_signals("X.NS", df, "", "")
    assert len(sigs) == 1
    assert sigs[0].breakout_reference == 100.0   # NOT 200


# ---------------------------------------------------------------------------
# Old high (> 6 months old) is NOT in reference window → ignored
# A very old peak must not influence the ref high.
# ---------------------------------------------------------------------------
def test_old_high_outside_window_is_ignored():
    window_start = TODAY - relativedelta(months=6)  # 2024-03-02

    obs_dates = []
    closes    = []

    # Pre-window weeks (> 6 months old, close = 300 — must be ignored)
    d = TODAY - relativedelta(months=8)
    while d < window_start:
        obs_dates.append(d)
        closes.append(300.0)
        d += timedelta(days=7)

    # In-window weeks (ref = 100)
    window_end = TODAY - relativedelta(months=2)
    d = window_start
    while d <= window_end:
        obs_dates.append(d)
        closes.append(100.0)
        d += timedelta(days=7)

    # Current developing week
    obs_dates.append(TODAY)
    closes.append(110.0)   # 110 > 100 → breakout (ref = 100, not 300)

    df   = make_weekly(obs_dates, closes)
    sigs = STRATEGY.generate_signals("X.NS", df, "", "")
    assert len(sigs) == 1
    assert sigs[0].breakout_reference == 100.0   # NOT 300


# ---------------------------------------------------------------------------
# No data in 2–6m window → no signal
# ---------------------------------------------------------------------------
def test_no_ref_data_in_window_no_signal():
    # Only 2 rows: one very old (8m), one current — nothing falls in 2–6m window
    obs_dates = [TODAY - relativedelta(months=8), TODAY]
    closes    = [50.0, 999.0]
    df        = make_weekly(obs_dates, closes)
    assert STRATEGY.generate_signals("X.NS", df, "", "") == []


# ---------------------------------------------------------------------------
# Breakout percentage calculation
# ---------------------------------------------------------------------------
def test_breakout_pct_calculation():
    df   = _spanning_weekly(TODAY, ref_high=200.0, today_close=250.0)
    sigs = STRATEGY.generate_signals("X.NS", df, "", "")
    assert len(sigs) == 1
    assert abs(sigs[0].breakout_pct - 25.0) < 1e-9   # (250/200 - 1) * 100


# ---------------------------------------------------------------------------
# Signal date = observation_date of developing week (not week-start Monday)
# ---------------------------------------------------------------------------
def test_signal_date_is_obs_date():
    # TODAY = 2024-09-02 (Monday) — obs_date and week_start coincide here
    df   = _spanning_weekly(TODAY, ref_high=100.0, today_close=110.0)
    sigs = STRATEGY.generate_signals("X.NS", df, "", "")
    assert len(sigs) == 1
    assert sigs[0].signal_date == TODAY

    # Wednesday mid-week obs: signal_date should be Wednesday, not Monday
    wednesday = date(2024, 9, 4)
    df2       = _spanning_weekly(wednesday, ref_high=100.0, today_close=110.0)
    sigs2     = STRATEGY.generate_signals("X.NS", df2, "", "")
    assert len(sigs2) == 1
    assert sigs2[0].signal_date == wednesday


# ---------------------------------------------------------------------------
# Sector and industry pass through
# ---------------------------------------------------------------------------
def test_sector_industry_passed_through():
    df   = _spanning_weekly(TODAY, ref_high=100.0, today_close=105.0)
    sigs = STRATEGY.generate_signals("X.NS", df, "Technology", "IT Services")
    assert sigs[0].sector   == "Technology"
    assert sigs[0].industry == "IT Services"


# ---------------------------------------------------------------------------
# daily kwarg is accepted but ignored (interface parity with runner)
# ---------------------------------------------------------------------------
def test_daily_kwarg_accepted_and_ignored():
    df   = _spanning_weekly(TODAY, ref_high=100.0, today_close=105.0)
    sigs = STRATEGY.generate_signals("X.NS", df, "", "", daily=pd.DataFrame())
    assert len(sigs) == 1
