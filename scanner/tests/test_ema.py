import math

import pandas as pd
import pytest

from app.indicators.ema import ALPHA_9, ALPHA_20, compute_ema, ema9, ema20


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def series(values: list[float]) -> pd.Series:
    return pd.Series(values, dtype=float)


def approx(a: float, b: float, tol: float = 1e-9) -> bool:
    return math.isclose(a, b, rel_tol=tol)


# ---------------------------------------------------------------------------
# Alpha constants (README §10 and §11 exact values)
# ---------------------------------------------------------------------------
def test_alpha9_exact():
    assert ALPHA_9 == 0.2

def test_alpha20_exact():
    assert math.isclose(ALPHA_20, 2 / 21, rel_tol=1e-15)


# ---------------------------------------------------------------------------
# First-close seed: all values from bar 0 are defined (matches Pine Script)
# ---------------------------------------------------------------------------
def test_fewer_than_period_still_produces_values():
    # With first-close seeding, even 2 bars produce valid EMA values
    result = compute_ema(series([100.0, 101.0]), period=9)
    assert not result.isna().any()
    assert approx(result.iloc[0], 100.0)     # seed = first close

def test_exactly_period_minus_one_all_valid():
    # 8 bars < period=9 — all 8 values are valid (no NaN)
    result = compute_ema(series([100.0] * 8), period=9)
    assert not result.isna().any()
    assert (result == 100.0).all()           # constant → EMA stays flat


# ---------------------------------------------------------------------------
# EMA9 — first value is the first close (Pine Script seed), not SMA
# ---------------------------------------------------------------------------
def test_ema9_first_value_is_first_close():
    closes = [10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0]
    result = ema9(series(closes))
    assert approx(result.iloc[0], 10.0)     # seed = close[0]


def test_ema9_no_leading_nan():
    closes = [100.0] * 20
    result = ema9(series(closes))
    assert not result.isna().any()          # all values valid from bar 0
    assert (result == 100.0).all()          # constant → flat throughout


# ---------------------------------------------------------------------------
# EMA9 — subsequent values use alpha = 0.2 exactly
# ---------------------------------------------------------------------------
def test_ema9_subsequent_uses_alpha_02():
    # 9 identical closes → seed EMA = 100.0
    closes = [100.0] * 9 + [120.0]
    result = ema9(series(closes))

    seed = 100.0
    expected = 120.0 * 0.2 + seed * 0.8    # = 24 + 80 = 104.0
    assert approx(result.iloc[9], expected)


def test_ema9_three_steps_manual():
    # Seed from 9 × 100 = 100.0; then three explicit steps
    closes = [100.0] * 9 + [110.0, 130.0, 90.0]
    result = ema9(series(closes))

    e0 = 100.0
    e1 = 110.0 * 0.2 + e0 * 0.8   # 22 + 80   = 102.0
    e2 = 130.0 * 0.2 + e1 * 0.8   # 26 + 81.6 = 107.6
    e3 = 90.0  * 0.2 + e2 * 0.8   # 18 + 86.08 = 104.08

    assert approx(result.iloc[9],  e1)
    assert approx(result.iloc[10], e2)
    assert approx(result.iloc[11], e3)


# ---------------------------------------------------------------------------
# EMA9 — constant series → EMA equals constant throughout
# ---------------------------------------------------------------------------
def test_ema9_constant_series_stays_flat():
    closes = [200.0] * 30
    result = ema9(series(closes))
    valid = result.dropna()
    assert (valid == 200.0).all()


# ---------------------------------------------------------------------------
# EMA20 — first value is the first close (Pine Script seed), not SMA
# ---------------------------------------------------------------------------
def test_ema20_first_value_is_first_close():
    closes = list(range(1, 21))           # 1..20
    result = ema20(series(closes))
    assert approx(result.iloc[0], 1.0)   # seed = close[0] = 1.0


def test_ema20_no_leading_nan():
    closes = [100.0] * 30
    result = ema20(series(closes))
    assert not result.isna().any()        # all values valid from bar 0
    assert (result == 100.0).all()        # constant → flat throughout


# ---------------------------------------------------------------------------
# EMA20 — subsequent values use alpha = 2/21 exactly
# ---------------------------------------------------------------------------
def test_ema20_subsequent_uses_alpha_2_over_21():
    alpha = 2 / 21
    closes = [100.0] * 20 + [150.0]
    result = ema20(series(closes))

    seed     = 100.0
    expected = 150.0 * alpha + seed * (1 - alpha)
    assert approx(result.iloc[20], expected)


def test_ema20_three_steps_manual():
    alpha  = 2 / 21
    closes = [100.0] * 20 + [110.0, 80.0, 120.0]
    result = ema20(series(closes))

    e0 = 100.0
    e1 = 110.0 * alpha + e0 * (1 - alpha)
    e2 = 80.0  * alpha + e1 * (1 - alpha)
    e3 = 120.0 * alpha + e2 * (1 - alpha)

    assert approx(result.iloc[20], e1)
    assert approx(result.iloc[21], e2)
    assert approx(result.iloc[22], e3)


# ---------------------------------------------------------------------------
# EMA20 — constant series → EMA equals constant
# ---------------------------------------------------------------------------
def test_ema20_constant_series_stays_flat():
    closes = [500.0] * 50
    result = ema20(series(closes))
    valid  = result.dropna()
    assert (valid == 500.0).all()


# ---------------------------------------------------------------------------
# Index preservation — output index matches input
# ---------------------------------------------------------------------------
def test_ema_preserves_index():
    idx    = pd.date_range("2024-01-01", periods=15, freq="W")
    closes = pd.Series([100.0] * 15, index=idx)
    result = ema9(closes)
    assert list(result.index) == list(closes.index)


# ---------------------------------------------------------------------------
# Period validation
# ---------------------------------------------------------------------------
def test_invalid_period_raises():
    with pytest.raises(ValueError):
        compute_ema(series([100.0] * 10), period=0)


# ---------------------------------------------------------------------------
# compute_ema(period=9) matches ema9(); compute_ema(period=20) matches ema20()
# ---------------------------------------------------------------------------
def test_ema9_equals_compute_ema_9():
    closes = series([float(i) for i in range(1, 31)])
    pd.testing.assert_series_equal(ema9(closes), compute_ema(closes, 9))


def test_ema20_equals_compute_ema_20():
    closes = series([float(i) for i in range(1, 51)])
    pd.testing.assert_series_equal(ema20(closes), compute_ema(closes, 20))
