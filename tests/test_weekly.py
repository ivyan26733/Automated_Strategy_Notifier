import pandas as pd
import pytest

from app.data.weekly import build_weekly


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def make_daily(dates: list[str], closes: list[float],
               opens: list[float] | None = None,
               highs: list[float] | None = None,
               lows: list[float] | None = None,
               volumes: list[float] | None = None) -> pd.DataFrame:
    n = len(dates)
    opens   = opens   or closes
    highs   = highs   or closes
    lows    = lows    or closes
    volumes = volumes or [1_000.0] * n
    return pd.DataFrame(
        {"Open": opens, "High": highs, "Low": lows, "Close": closes, "Volume": volumes},
        index=pd.DatetimeIndex(dates),
    )


# ---------------------------------------------------------------------------
# Empty input
# ---------------------------------------------------------------------------
def test_empty_returns_empty():
    assert build_weekly(pd.DataFrame()).empty


# ---------------------------------------------------------------------------
# Completed week (Mon-Fri all present)
# ---------------------------------------------------------------------------
def test_completed_week():
    daily = make_daily(
        dates=["2024-01-08", "2024-01-09", "2024-01-10", "2024-01-11", "2024-01-12"],
        opens=[10, 11, 12, 13, 14],
        highs=[15, 16, 17, 18, 19],
        lows=[ 9, 10, 11, 12, 13],
        closes=[11, 12, 13, 14, 15],
        volumes=[100, 200, 300, 400, 500],
    )
    weekly = build_weekly(daily)
    assert len(weekly) == 1
    row = weekly.iloc[0]
    assert row["Open"]   == 10        # first day open
    assert row["High"]   == 19        # max high across week
    assert row["Low"]    == 9         # min low across week
    assert row["Close"]  == 15        # last day close (Friday)
    assert row["Volume"] == 1500      # sum
    assert row["is_developing"] == True   # last (only) week is always developing


# ---------------------------------------------------------------------------
# Developing week — Monday only
# ---------------------------------------------------------------------------
def test_monday_only_developing_week():
    # Week 1 completed Mon-Fri; Week 2 has Monday only
    daily = make_daily(
        dates=["2024-01-08","2024-01-09","2024-01-10","2024-01-11","2024-01-12",
               "2024-01-15"],
        opens= [10,11,12,13,14, 20],
        highs= [15,16,17,18,19, 25],
        lows=  [ 9,10,11,12,13, 18],
        closes=[11,12,13,14,15, 22],
    )
    weekly = build_weekly(daily)
    assert len(weekly) == 2

    w1 = weekly.iloc[0]
    assert w1["Open"]   == 10
    assert w1["High"]   == 19
    assert w1["Low"]    == 9
    assert w1["Close"]  == 15
    assert w1["is_developing"] == False

    w2 = weekly.iloc[1]
    assert w2["Open"]   == 20
    assert w2["High"]   == 25
    assert w2["Low"]    == 18
    assert w2["Close"]  == 22
    assert w2["is_developing"] == True


# ---------------------------------------------------------------------------
# Developing week — Tuesday
# ---------------------------------------------------------------------------
def test_tuesday_developing_week():
    daily = make_daily(
        dates=["2024-01-08","2024-01-09","2024-01-10","2024-01-11","2024-01-12",
               "2024-01-15","2024-01-16"],
        opens= [10,11,12,13,14, 20,21],
        highs= [15,16,17,18,19, 25,26],
        lows=  [ 9,10,11,12,13, 18,19],
        closes=[11,12,13,14,15, 22,23],
    )
    weekly = build_weekly(daily)
    assert len(weekly) == 2
    w2 = weekly.iloc[1]
    assert w2["Open"]  == 20   # Monday open
    assert w2["High"]  == 26   # max(Mon high, Tue high)
    assert w2["Low"]   == 18   # min(Mon low, Tue low)
    assert w2["Close"] == 23   # Tuesday close
    assert w2["is_developing"] == True


# ---------------------------------------------------------------------------
# Developing week — Wednesday
# ---------------------------------------------------------------------------
def test_wednesday_developing_week():
    daily = make_daily(
        dates=["2024-01-08","2024-01-09","2024-01-10","2024-01-11","2024-01-12",
               "2024-01-15","2024-01-16","2024-01-17"],
        opens= [10,11,12,13,14, 20,21,22],
        highs= [15,16,17,18,19, 25,26,27],
        lows=  [ 9,10,11,12,13, 18,19,20],
        closes=[11,12,13,14,15, 22,23,24],
    )
    weekly = build_weekly(daily)
    w2 = weekly.iloc[1]
    assert w2["High"]  == 27
    assert w2["Close"] == 24
    assert w2["is_developing"] == True


# ---------------------------------------------------------------------------
# Developing week — Thursday
# ---------------------------------------------------------------------------
def test_thursday_developing_week():
    daily = make_daily(
        dates=["2024-01-08","2024-01-09","2024-01-10","2024-01-11","2024-01-12",
               "2024-01-15","2024-01-16","2024-01-17","2024-01-18"],
        closes=[11,12,13,14,15, 22,23,24,25],
    )
    weekly = build_weekly(daily)
    assert weekly.iloc[1]["Close"] == 25
    assert weekly.iloc[1]["is_developing"] == True


# ---------------------------------------------------------------------------
# Developing week — Friday (full week, still flagged as developing)
# ---------------------------------------------------------------------------
def test_friday_full_week_flagged_developing():
    daily = make_daily(
        dates=["2024-01-08","2024-01-09","2024-01-10","2024-01-11","2024-01-12",
               "2024-01-15","2024-01-16","2024-01-17","2024-01-18","2024-01-19"],
        closes=[11,12,13,14,15, 22,23,24,25,26],
    )
    weekly = build_weekly(daily)
    assert len(weekly) == 2
    assert weekly.iloc[1]["Close"] == 26
    assert weekly.iloc[1]["is_developing"] == True
    assert weekly.iloc[0]["is_developing"] == False


# ---------------------------------------------------------------------------
# Holiday week — gap in middle of week
# ---------------------------------------------------------------------------
def test_holiday_gap_in_week():
    # Week with only Mon, Wed, Fri (Tue and Thu are holidays)
    daily = make_daily(
        dates=["2024-01-08","2024-01-10","2024-01-12"],
        opens= [10, 12, 14],
        highs= [15, 17, 19],
        lows=  [ 9, 11, 13],
        closes=[11, 13, 15],
    )
    weekly = build_weekly(daily)
    assert len(weekly) == 1
    row = weekly.iloc[0]
    assert row["Open"]  == 10   # Monday open
    assert row["High"]  == 19   # max across available days
    assert row["Low"]   == 9    # min across available days
    assert row["Close"] == 15   # Friday close
    assert row["is_developing"] == True


# ---------------------------------------------------------------------------
# Week index is always Monday
# ---------------------------------------------------------------------------
def test_week_index_is_monday():
    daily = make_daily(
        dates=["2024-01-10", "2024-01-17"],  # both Wednesdays
        closes=[100.0, 110.0],
    )
    weekly = build_weekly(daily)
    for ts in weekly.index:
        assert ts.dayofweek == 0, f"Expected Monday, got {ts.strftime('%A')}"


# ---------------------------------------------------------------------------
# observation_date is the last trading day of each week
# ---------------------------------------------------------------------------
def test_observation_date():
    daily = make_daily(
        dates=["2024-01-08","2024-01-09","2024-01-10",   # Week 1: Mon-Wed
               "2024-01-15","2024-01-16"],                # Week 2: Mon-Tue
        closes=[10, 11, 12, 20, 21],
    )
    weekly = build_weekly(daily)
    assert weekly.iloc[0]["observation_date"] == pd.Timestamp("2024-01-10")
    assert weekly.iloc[1]["observation_date"] == pd.Timestamp("2024-01-16")


# ---------------------------------------------------------------------------
# Volume is summed per week
# ---------------------------------------------------------------------------
def test_volume_sum():
    daily = make_daily(
        dates=["2024-01-08","2024-01-09","2024-01-10"],
        closes=[10, 11, 12],
        volumes=[100, 200, 300],
    )
    weekly = build_weekly(daily)
    assert weekly.iloc[0]["Volume"] == 600
