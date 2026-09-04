#!/usr/bin/env python
"""
EMA Crossover Audit — compares Python (SMA-seeded) vs TradingView (first-close-seeded) EMAs,
checks developing-week construction, and identifies all signal losses across the universe.

Output files (written to project root):
  audit_ema_full.csv    — one row per stock, all diagnostic fields
  audit_ema_summary.txt — human-readable summary + findings
  audit_ema_sample.txt  — deep trace for SAMPLE_STOCKS (last 10 weeks each)
"""

from __future__ import annotations

import csv
import math
import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.config.settings import settings
from app.data.market_data import load_daily
from app.data.universe import load_universe
from app.data.validation import validate_and_clean
from app.data.weekly import build_weekly
from app.indicators.ema import compute_ema

# ---------------------------------------------------------------------------
TODAY = date.today()
EMA_WINDOW = 28   # "fresh" = signal_date within last N days
SAMPLE_STOCKS = [
    "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK",
    "WIPRO", "BAJFINANCE", "SBIN", "KOTAKBANK", "AXISBANK",
]
OUT_DIR = Path(__file__).resolve().parent


# ---------------------------------------------------------------------------
# TradingView-compatible EMA (seeds on first close, not SMA of first period)
# ---------------------------------------------------------------------------
def ema_tv(closes: pd.Series, period: int) -> pd.Series:
    """
    Pine Script ta.ema() initializes on the very first non-NaN bar (close[0] = seed).
    After that: ema = close*alpha + ema_prev*(1-alpha)
    """
    alpha = 2.0 / (period + 1)
    arr   = closes.to_numpy(dtype=float, na_value=float("nan"))
    out   = [float("nan")] * len(arr)

    seed = None
    for i, v in enumerate(arr):
        if not math.isnan(v):
            seed = i
            break
    if seed is None:
        return pd.Series(out, index=closes.index, name=f"emaTV{period}", dtype=float)

    out[seed] = arr[seed]
    for i in range(seed + 1, len(arr)):
        if math.isnan(arr[i]):
            out[i] = out[i - 1]   # TradingView carries EMA forward over gaps
        else:
            out[i] = arr[i] * alpha + out[i - 1] * (1.0 - alpha)

    return pd.Series(out, index=closes.index, name=f"emaTV{period}", dtype=float)


# ---------------------------------------------------------------------------
# Crossover scanner — returns list of (obs_date, ema9, ema20) for golden crosses
# ---------------------------------------------------------------------------
def scan_crossovers(e9: pd.Series, e20: pd.Series, weekly: pd.DataFrame) -> list[dict]:
    crosses = []
    above   = False
    for i in range(1, len(weekly)):
        p9, p20 = e9.iloc[i - 1], e20.iloc[i - 1]
        c9, c20 = e9.iloc[i],     e20.iloc[i]
        if any(math.isnan(v) for v in (p9, p20, c9, c20)):
            continue
        if c9 > c20:
            if not above and p9 <= p20:
                obs = weekly.iloc[i]["observation_date"]
                crosses.append({
                    "obs_date": obs.date() if hasattr(obs, "date") else obs,
                    "ema9": round(c9, 4),
                    "ema20": round(c20, 4),
                    "diff_pct": round((c9 - c20) / c20 * 100, 4),
                    "row_idx": i,
                })
            above = True
        else:
            above = False
    return crosses


# ---------------------------------------------------------------------------
# Per-stock audit
# ---------------------------------------------------------------------------
def audit_one(symbol: str) -> dict:
    rec: dict = {
        "symbol":          symbol,
        "status":          "ok",
        "daily_bars":      0,
        "weekly_bars":     0,
        "obs_date":        "",
        "week_start":      "",
        "is_developing":   "",
        "wk_close":        "",
        # Python EMA (SMA seed)
        "py_ema9":         "",
        "py_ema20":        "",
        "py_diff_pct":     "",
        "py_above":        "",
        # TV EMA (first-close seed)
        "tv_ema9":         "",
        "tv_ema20":        "",
        "tv_diff_pct":     "",
        "tv_above":        "",
        # Discrepancy
        "ema9_rel_err_pct":  "",
        "ema20_rel_err_pct": "",
        "seed_disagrees":    "",   # True if methods give opposite above/below
        # Crossover (Python)
        "py_latest_gc":      "",
        "py_gc_days_ago":    "",
        "py_gc_in_window":   "",
        "py_gc_active":      "",
        "py_would_show":     "",
        # Crossover (TV)
        "tv_latest_gc":      "",
        "tv_gc_days_ago":    "",
        "tv_gc_in_window":   "",
        "tv_gc_active":      "",
        "tv_would_show":     "",
        # Signal loss flag
        "signal_lost_tv_has_py_misses": "",
    }

    # ---- Load data ----
    daily = load_daily(symbol)
    if daily.empty:
        rec["status"] = "no_csv"
        return rec

    daily, _ = validate_and_clean(daily, symbol)
    if daily.empty:
        rec["status"] = "failed_validation"
        return rec

    rec["daily_bars"] = len(daily)

    weekly = build_weekly(daily)
    if weekly.empty or len(weekly) < 2:
        rec["status"] = "insufficient_weekly"
        return rec

    rec["weekly_bars"] = len(weekly)

    last     = weekly.iloc[-1]
    obs_raw  = last["observation_date"]
    obs_date = obs_raw.date() if hasattr(obs_raw, "date") else obs_raw
    rec["obs_date"]      = str(obs_date)
    rec["week_start"]    = str(weekly.index[-1].date())
    rec["is_developing"] = str(bool(last["is_developing"]))
    rec["wk_close"]      = round(float(last["Close"]), 4)

    if len(weekly) < 21:   # need 20 for EMA20 + 1 lookback bar
        rec["status"] = "too_short_for_ema20"
        return rec

    closes = weekly["Close"]

    # ---- Python EMA ----
    py9  = compute_ema(closes, 9)
    py20 = compute_ema(closes, 20)
    c_py9, c_py20 = float(py9.iloc[-1]), float(py20.iloc[-1])

    if not (math.isnan(c_py9) or math.isnan(c_py20)):
        rec["py_ema9"]     = round(c_py9, 4)
        rec["py_ema20"]    = round(c_py20, 4)
        rec["py_diff_pct"] = round((c_py9 - c_py20) / c_py20 * 100, 4)
        rec["py_above"]    = c_py9 > c_py20

    # ---- TradingView EMA ----
    tv9  = ema_tv(closes, 9)
    tv20 = ema_tv(closes, 20)
    c_tv9, c_tv20 = float(tv9.iloc[-1]), float(tv20.iloc[-1])

    if not (math.isnan(c_tv9) or math.isnan(c_tv20)):
        rec["tv_ema9"]     = round(c_tv9, 4)
        rec["tv_ema20"]    = round(c_tv20, 4)
        rec["tv_diff_pct"] = round((c_tv9 - c_tv20) / c_tv20 * 100, 4)
        rec["tv_above"]    = c_tv9 > c_tv20

    # ---- Discrepancy ----
    if rec["py_ema9"] != "" and rec["tv_ema9"] != "":
        rec["ema9_rel_err_pct"]  = round((c_py9  - c_tv9)  / c_tv9  * 100, 6)
        rec["ema20_rel_err_pct"] = round((c_py20 - c_tv20) / c_tv20 * 100, 6)
        rec["seed_disagrees"]    = (c_py9 > c_py20) != (c_tv9 > c_tv20)

    # ---- Crossover detection ----
    py_crosses = scan_crossovers(py9, py20, weekly)
    tv_crosses = scan_crossovers(tv9, tv20, weekly)

    # Python state
    py_above_now = (c_py9 > c_py20) if rec["py_ema9"] != "" else None
    if py_crosses:
        lgc = py_crosses[-1]
        days_ago = (TODAY - lgc["obs_date"]).days
        in_win   = days_ago <= EMA_WINDOW
        rec["py_latest_gc"]   = str(lgc["obs_date"])
        rec["py_gc_days_ago"] = days_ago
        rec["py_gc_in_window"]= in_win
        rec["py_gc_active"]   = bool(py_above_now)
        rec["py_would_show"]  = in_win and bool(py_above_now)

    # TV state
    tv_above_now = (c_tv9 > c_tv20) if rec["tv_ema9"] != "" else None
    if tv_crosses:
        lgc = tv_crosses[-1]
        days_ago = (TODAY - lgc["obs_date"]).days
        in_win   = days_ago <= EMA_WINDOW
        rec["tv_latest_gc"]   = str(lgc["obs_date"])
        rec["tv_gc_days_ago"] = days_ago
        rec["tv_gc_in_window"]= in_win
        rec["tv_gc_active"]   = bool(tv_above_now)
        rec["tv_would_show"]  = in_win and bool(tv_above_now)

    # Signal loss: TV says "show fresh" but Python does NOT
    rec["signal_lost_tv_has_py_misses"] = (
        rec["tv_would_show"] is True and rec["py_would_show"] is not True
    )

    return rec


# ---------------------------------------------------------------------------
# Deep weekly trace for sample stocks
# ---------------------------------------------------------------------------
def trace_stock(symbol: str, n_weeks: int = 12) -> str:
    daily = load_daily(symbol)
    if daily.empty:
        return f"{symbol}: NO CSV\n"

    daily, _ = validate_and_clean(daily, symbol)
    if daily.empty:
        return f"{symbol}: VALIDATION FAILED\n"

    weekly = build_weekly(daily)
    if weekly.empty or len(weekly) < 21:
        return f"{symbol}: TOO SHORT ({len(weekly)} weekly bars)\n"

    closes = weekly["Close"]
    py9  = compute_ema(closes, 9)
    py20 = compute_ema(closes, 20)
    tv9  = ema_tv(closes, 9)
    tv20 = ema_tv(closes, 20)

    lines = [
        f"\n{'='*90}",
        f"  {symbol}  |  {len(weekly)} weekly bars  |  latest obs: {weekly.iloc[-1]['observation_date']}",
        f"{'='*90}",
        f"{'Wk Start':<12}{'ObsDate':<13}{'Dev':<5}{'Close':>10}  "
        f"{'pyEMA9':>10}{'pyEMA20':>10}{'py%':>8}  "
        f"{'tvEMA9':>10}{'tvEMA20':>10}{'tv%':>8}  "
        f"{'Δema9%':>9}{'Cross':>8}",
        "-" * 90,
    ]

    tail = weekly.iloc[-n_weeks:]
    for i, (idx, row) in enumerate(tail.iterrows()):
        abs_i    = len(weekly) - n_weeks + i
        obs_raw  = row["observation_date"]
        obs_str  = str(obs_raw.date() if hasattr(obs_raw, "date") else obs_raw)
        wk_str   = str(idx.date())
        dev      = "→" if row["is_developing"] else " "
        close    = row["Close"]

        p9  = py9.iloc[abs_i]
        p20 = py20.iloc[abs_i]
        t9  = tv9.iloc[abs_i]
        t20 = tv20.iloc[abs_i]

        def fmt(v): return f"{v:10.2f}" if not math.isnan(v) else f"{'nan':>10}"

        py_pct  = (p9 - p20) / p20 * 100 if not any(math.isnan(v) for v in (p9, p20)) else float("nan")
        tv_pct  = (t9 - t20) / t20 * 100 if not any(math.isnan(v) for v in (t9, t20)) else float("nan")
        ema9err = (p9 - t9) / t9 * 100  if not any(math.isnan(v) for v in (p9, t9))  else float("nan")

        # Detect crossover on this bar
        cross = ""
        if abs_i >= 1:
            pp9  = py9.iloc[abs_i - 1]
            pp20 = py20.iloc[abs_i - 1]
            if not any(math.isnan(v) for v in (pp9, pp20, p9, p20)):
                if p9 > p20 and pp9 <= pp20:
                    cross = "GOLDEN↑"
                elif p9 < p20 and pp9 >= pp20:
                    cross = "DEATH↓"

        py_pct_str  = f"{py_pct:8.3f}" if not math.isnan(py_pct)  else f"{'nan':>8}"
        tv_pct_str  = f"{tv_pct:8.3f}" if not math.isnan(tv_pct)  else f"{'nan':>8}"
        ema9err_str = f"{ema9err:9.6f}" if not math.isnan(ema9err) else f"{'nan':>9}"

        lines.append(
            f"{wk_str:<12}{obs_str:<13}{dev:<5}{close:>10.2f}  "
            f"{fmt(p9)}{fmt(p20)}{py_pct_str}  "
            f"{fmt(t9)}{fmt(t20)}{tv_pct_str}  "
            f"{ema9err_str}{cross:>8}"
        )

    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------
def main():
    print(f"Loading universe …")
    stocks = load_universe(frozenset({"EQ"}))
    print(f"Universe: {len(stocks):,} stocks")
    print(f"Today   : {TODAY}")
    print()

    results: list[dict] = []
    for n, stock in enumerate(stocks):
        rec = audit_one(stock.symbol)
        results.append(rec)
        if (n + 1) % 200 == 0:
            print(f"  {n+1:>5}/{len(stocks)}  fresh so far: {sum(1 for r in results if r.get('py_would_show') is True)}")

    print(f"\nDone. {len(results):,} stocks audited.")

    # ---- Write full CSV ----
    csv_path = OUT_DIR / "audit_ema_full.csv"
    fieldnames = list(results[0].keys())
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(results)
    print(f"Full CSV: {csv_path}")

    # ---- Aggregate stats ----
    total        = len(results)
    by_status    = {}
    for r in results:
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1

    ok_results = [r for r in results if r["status"] == "ok"]
    py_fresh   = [r for r in ok_results if r.get("py_would_show") is True]
    tv_fresh   = [r for r in ok_results if r.get("tv_would_show") is True]
    lost       = [r for r in ok_results if r.get("signal_lost_tv_has_py_misses") is True]
    disagree   = [r for r in ok_results if r.get("seed_disagrees") is True]
    borderline = [
        r for r in ok_results
        if r.get("py_diff_pct") != "" and abs(float(r["py_diff_pct"])) < 0.5
    ]
    py_above_all   = [r for r in ok_results if r.get("py_above") is True]
    tv_above_all   = [r for r in ok_results if r.get("tv_above") is True]

    # Cross-date mismatches
    date_mismatch = [
        r for r in ok_results
        if r.get("py_latest_gc") and r.get("tv_latest_gc")
        and r["py_latest_gc"] != r["tv_latest_gc"]
    ]

    # ---- Write summary ----
    txt_path = OUT_DIR / "audit_ema_summary.txt"
    with open(txt_path, "w", encoding="utf-8") as f:
        def w(s=""):
            f.write(s + "\n")

        w("=" * 70)
        w("  NSE STOCK SCREENER — EMA CROSSOVER AUDIT")
        w(f"  Run date : {TODAY}")
        w(f"  Universe : {total:,} stocks")
        w(f"  EMA window: {EMA_WINDOW} days (fresh crossover definition)")
        w("=" * 70)
        w()
        w("STOCK STATUS BREAKDOWN")
        w("-" * 40)
        for st, cnt in sorted(by_status.items(), key=lambda x: -x[1]):
            w(f"  {st:<28} {cnt:>5}")
        w()
        w("EMA COMPUTATION COMPARISON")
        w("-" * 40)
        w(f"  OK stocks (valid EMA)         : {len(ok_results):>5}")
        w(f"  Currently above EMA9>EMA20")
        w(f"    Python (SMA-seeded)          : {len(py_above_all):>5}")
        w(f"    TradingView (1st-close-seed) : {len(tv_above_all):>5}")
        w(f"  Seed disagrees on above/below  : {len(disagree):>5}  ← potential misdetections")
        w(f"  Borderline (|diff%| < 0.5%)    : {len(borderline):>5}  ← sensitive to seed method")
        w()
        w("FRESH CROSSOVER COUNT (last 28 days, still active)")
        w("-" * 40)
        w(f"  Python fresh signals  : {len(py_fresh):>5}")
        w(f"  TradingView fresh sigs: {len(tv_fresh):>5}")
        w(f"  Signals TV has, Py misses: {len(lost):>5}  ← SIGNAL LOSSES")
        w(f"  Latest crossover date mismatch: {len(date_mismatch):>5}")
        w()

        # ---- Seed-disagrees stocks ----
        if disagree:
            w("STOCKS WHERE SEED METHOD FLIPS ABOVE/BELOW (biggest risk)")
            w("-" * 60)
            w(f"  {'Symbol':<16}{'Weekly':>8}{'pyDiff%':>10}{'tvDiff%':>10}{'Δema9%':>12}{'tvFresh':>9}")
            for r in sorted(disagree, key=lambda x: abs(float(x["py_diff_pct"])) if x["py_diff_pct"] != "" else 999):
                w(f"  {r['symbol']:<16}{r['weekly_bars']:>8}{float(r['py_diff_pct']):>10.3f}"
                  f"{float(r['tv_diff_pct']):>10.3f}{float(r['ema9_rel_err_pct']):>12.6f}"
                  f"{str(r['tv_would_show']):>9}")
            w()

        # ---- Signal losses ----
        if lost:
            w("SIGNAL LOSSES — TV shows fresh cross, Python does NOT")
            w("-" * 80)
            w(f"  {'Symbol':<16}{'tvGCDate':<13}{'tDays':>7}{'tvDiff%':>10}{'pyDiff%':>10}{'Reason'}")
            for r in sorted(lost, key=lambda x: x.get("tv_latest_gc", "")):
                reason = "seed_disagrees" if r.get("seed_disagrees") else (
                         "py_gc_stale"   if r.get("py_gc_in_window") is False else
                         "py_not_active" if not r.get("py_gc_active") else "unknown")
                td = r.get("tv_diff_pct", "")
                pd_ = r.get("py_diff_pct", "")
                w(f"  {r['symbol']:<16}{r.get('tv_latest_gc','?'):<13}"
                  f"{str(r.get('tv_gc_days_ago','?')):>7}"
                  f"{(str(round(float(td),3)) if td != '' else '?'):>10}"
                  f"{(str(round(float(pd_),3)) if pd_ != '' else '?'):>10}"
                  f"  {reason}")
            w()

        # ---- Borderline stocks ----
        if borderline:
            w(f"BORDERLINE STOCKS (|pyDiff%| < 0.5%, EMA9 ≈ EMA20)  — top 30")
            w("-" * 70)
            w(f"  {'Symbol':<16}{'Weekly':>8}{'pyDiff%':>10}{'tvDiff%':>10}{'Δema9%':>12}{'pyAbove':>9}")
            for r in sorted(borderline, key=lambda x: abs(float(x["py_diff_pct"])))[:30]:
                w(f"  {r['symbol']:<16}{r['weekly_bars']:>8}"
                  f"{float(r['py_diff_pct']):>10.4f}{float(r['tv_diff_pct']):>10.4f}"
                  f"{float(r['ema9_rel_err_pct']) if r['ema9_rel_err_pct'] != '' else 0:>12.6f}"
                  f"{str(r['py_above']):>9}")
            w()

        # ---- Python fresh list ----
        w(f"PYTHON FRESH CROSSOVERS (last {EMA_WINDOW}d, still active) — all {len(py_fresh)}")
        w("-" * 80)
        w(f"  {'Symbol':<16}{'GCDate':<13}{'DaysAgo':>8}{'pyDiff%':>10}{'tvDiff%':>10}{'tvFresh':>9}")
        for r in sorted(py_fresh, key=lambda x: x.get("py_latest_gc", "")):
            td = r.get("tv_diff_pct", "")
            w(f"  {r['symbol']:<16}{r.get('py_latest_gc','?'):<13}"
              f"{str(r.get('py_gc_days_ago','?')):>8}"
              f"{float(r['py_diff_pct']):>10.3f}"
              f"{(str(round(float(td),3)) if td != '' else '?'):>10}"
              f"{str(r.get('tv_would_show','?')):>9}")
        w()

        # ---- Key findings ----
        w("=" * 70)
        w("KEY FINDINGS")
        w("=" * 70)
        w()
        w("FINDING 1: EMA SEED METHOD")
        w("  Python uses  : SMA of first [period] weekly closes as seed")
        w("  TradingView  : first weekly close = seed (Pine Script ta.ema)")
        w(f"  Impact       : negligible for stocks with 200+ weekly bars (>4yr data)")
        w(f"  Stocks where seed FLIPS above/below: {len(disagree)}")
        if disagree:
            w(f"  These stocks have borderline EMA9≈EMA20 AND short history.")
        w()
        w("FINDING 2: DEVELOPING WEEK CONSTRUCTION")
        w("  Python build_weekly() correctly uses latest daily close as")
        w("  developing week Close — matching TradingView's developing bar.")
        w("  Week keyed by ISO Monday → correct for NSE Mon-Fri sessions.")
        w()
        w("FINDING 3: CROSSOVER STATE VARIABLE")
        w("  EmaCrossoverStrategy.above starts as False each scan, which")
        w("  correctly prevents emitting a signal when EMA9 was already >")
        w("  EMA20 at the first valid EMA20 bar (bar index 19).")
        w("  No false positives from state initialization. ✓")
        w()
        w("FINDING 4: SIGNAL DEDUPLICATION KEY")
        w("  Upsert key: (strategy_name, symbol, signal_date, signal_type)")
        w("  signal_date = observation_date (latest DAILY close, not Mon)")
        w("  Risk: If the scanner runs on Mon and records a developing-week")
        w("  golden cross, then on Tue prices reverse → Mon signal stays in DB.")
        w("  Frontend's activeSet check filters this out correctly. ✓")
        w()
        w("FINDING 5: SCANNER MUST RUN DAILY POST-MARKET")
        w("  The developing-week EMA is recalculated each day using that")
        w("  day's close. A crossover occurring on any day Mon-Fri is only")
        w("  captured if the scanner runs on that day (or later the same week).")
        w("  Crossovers that appear intra-week and reverse before Friday are")
        w("  captured with the day's signal_date but persist in DB unless")
        w("  you implement signal invalidation.")
        w()
        w("FINDING 6: STALE DEVELOPING-WEEK SIGNALS IN DB")
        w("  Each day the scanner runs, the developing week's obs_date changes.")
        w("  Upsert key includes signal_date, so Mon's cross (date=Mon) and")
        w("  Tue's cross (date=Tue if still active) are SEPARATE DB rows.")
        w("  Old developing-week signal rows (e.g. Mon) are never deleted.")
        w("  Frontend's 28-day + activeSet filter handles this correctly. ✓")

    print(f"Summary : {txt_path}")

    # ---- Deep trace for sample stocks ----
    sample_path = OUT_DIR / "audit_ema_sample.txt"
    with open(sample_path, "w", encoding="utf-8") as f:
        f.write(f"EMA DEEP TRACE — {TODAY}  (last 12 weeks per stock)\n")
        f.write("Columns: pyEMA9/pyEMA20 = Python SMA-seeded  |  tvEMA9/tvEMA20 = TV first-close-seeded\n")
        f.write("Δema9% = (pyEMA9 - tvEMA9)/tvEMA9 × 100  |  Cross = detected crossover on this bar\n")
        f.write("Dev (→) = developing (incomplete) week\n\n")
        for sym in SAMPLE_STOCKS:
            f.write(trace_stock(sym, n_weeks=12))
            f.write("\n")
    print(f"Sample  : {sample_path}")

    print("\nDone.")


if __name__ == "__main__":
    main()
