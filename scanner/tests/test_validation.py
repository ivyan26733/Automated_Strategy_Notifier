import pandas as pd
import pytest

from app.data.validation import validate_and_clean


def make_df(dates, opens, highs, lows, closes, volumes=None):
    n = len(dates)
    return pd.DataFrame(
        {
            "Open":   opens,
            "High":   highs,
            "Low":    lows,
            "Close":  closes,
            "Volume": volumes or [1000.0] * n,
        },
        index=pd.DatetimeIndex(dates),
    )


# ---------------------------------------------------------------------------
# Clean data passes through unchanged
# ---------------------------------------------------------------------------
def test_clean_data_no_issues():
    df = make_df(
        ["2024-01-01", "2024-01-02"],
        opens=[10, 11], highs=[15, 16], lows=[9, 10], closes=[12, 13],
    )
    cleaned, issues = validate_and_clean(df, "TEST")
    assert len(cleaned) == 2
    assert issues == []


# ---------------------------------------------------------------------------
# Empty DataFrame
# ---------------------------------------------------------------------------
def test_empty_dataframe():
    cleaned, issues = validate_and_clean(pd.DataFrame(), "TEST")
    assert cleaned.empty
    assert any("empty" in i for i in issues)


# ---------------------------------------------------------------------------
# Unsorted timestamps are sorted
# ---------------------------------------------------------------------------
def test_unsorted_timestamps():
    df = make_df(
        ["2024-01-03", "2024-01-01", "2024-01-02"],
        opens=[30, 10, 20], highs=[35, 15, 25], lows=[28, 8, 18], closes=[31, 11, 21],
    )
    cleaned, issues = validate_and_clean(df, "TEST")
    assert list(cleaned.index) == sorted(cleaned.index)
    assert any("unsorted" in i for i in issues)


# ---------------------------------------------------------------------------
# Duplicate dates — last row kept
# ---------------------------------------------------------------------------
def test_duplicate_dates():
    df = make_df(
        ["2024-01-01", "2024-01-01", "2024-01-02"],
        opens=[10, 99, 20], highs=[15, 99, 25], lows=[9, 99, 18], closes=[12, 99, 21],
    )
    cleaned, issues = validate_and_clean(df, "TEST")
    assert len(cleaned) == 2
    # The second occurrence (Close=99) is kept as "last"
    assert cleaned.loc[pd.Timestamp("2024-01-01"), "Close"] == 99
    assert any("duplicate" in i for i in issues)


# ---------------------------------------------------------------------------
# Missing Close — row dropped
# ---------------------------------------------------------------------------
def test_missing_close_dropped():
    df = make_df(
        ["2024-01-01", "2024-01-02", "2024-01-03"],
        opens=[10, 20, 30], highs=[15, 25, 35], lows=[9, 18, 28], closes=[12, float("nan"), 31],
    )
    cleaned, issues = validate_and_clean(df, "TEST")
    assert len(cleaned) == 2
    assert pd.Timestamp("2024-01-02") not in cleaned.index
    assert any("Close" in i for i in issues)


# ---------------------------------------------------------------------------
# Missing Open/High/Low filled with Close
# ---------------------------------------------------------------------------
def test_missing_ohlc_filled_with_close():
    df = make_df(
        ["2024-01-01"],
        opens=[float("nan")], highs=[float("nan")], lows=[float("nan")], closes=[50.0],
    )
    cleaned, issues = validate_and_clean(df, "TEST")
    assert cleaned["Open"].iloc[0] == 50.0
    assert cleaned["High"].iloc[0] == 50.0
    assert cleaned["Low"].iloc[0]  == 50.0


# ---------------------------------------------------------------------------
# Non-positive Close — row dropped
# ---------------------------------------------------------------------------
def test_non_positive_close_dropped():
    df = make_df(
        ["2024-01-01", "2024-01-02", "2024-01-03"],
        opens=[10, 0, 30], highs=[15, 5, 35], lows=[9, -1, 28], closes=[12, 0.0, 31],
    )
    cleaned, issues = validate_and_clean(df, "TEST")
    assert len(cleaned) == 2
    assert any("non-positive" in i for i in issues)


# ---------------------------------------------------------------------------
# Invalid OHLC relationship — clamped, row kept
# ---------------------------------------------------------------------------
def test_invalid_ohlc_clamped():
    # High < Close (bad data: high should be >= close)
    df = make_df(
        ["2024-01-01"],
        opens=[100.0], highs=[90.0], lows=[80.0], closes=[110.0],
    )
    cleaned, issues = validate_and_clean(df, "TEST")
    assert len(cleaned) == 1                      # row kept, not dropped
    assert cleaned["High"].iloc[0] >= cleaned["Close"].iloc[0]
    assert cleaned["Low"].iloc[0]  <= cleaned["Close"].iloc[0]


# ---------------------------------------------------------------------------
# Missing Volume set to 0
# ---------------------------------------------------------------------------
def test_missing_volume_set_to_zero():
    df = make_df(
        ["2024-01-01"],
        opens=[10], highs=[15], lows=[9], closes=[12], volumes=[float("nan")],
    )
    cleaned, issues = validate_and_clean(df, "TEST")
    assert cleaned["Volume"].iloc[0] == 0.0
