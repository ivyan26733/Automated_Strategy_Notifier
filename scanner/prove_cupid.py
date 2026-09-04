#!/usr/bin/env python
"""
Prove EMA crossover correctness for CUPID — last 2 years.
Shows every crossover (golden + death) with 4-week context around each.
"""
from __future__ import annotations
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.data.market_data import load_daily
from app.data.validation import validate_and_clean
from app.data.weekly import build_weekly
from app.indicators.ema import compute_ema

TODAY    = date.today()
TWO_YEARS_AGO = TODAY - timedelta(days=730)

def main():
    symbol = "CUPID"
    daily  = load_daily(symbol)

    if daily.empty:
        print(f"ERROR: No CSV found for {symbol}")
        return

    daily, issues = validate_and_clean(daily, symbol)
    if issues:
        for i in issues:
            print("  WARN:", i)

    print(f"Daily bars loaded: {len(daily)}  ({daily.index[0].date()} to {daily.index[-1].date()})")

    weekly = build_weekly(daily)
    print(f"Weekly bars built: {len(weekly)}")
    print()

    e9  = compute_ema(weekly["Close"], 9)
    e20 = compute_ema(weekly["Close"], 20)

    # ----------------------------------------------------------------
    # Collect ALL crossovers in the last 2 years
    # ----------------------------------------------------------------
    crossovers = []   # (idx, type, obs_date, close, e9, e20)
    above = None      # None = unknown, True/False = current state

    for i in range(1, len(weekly)):
        p9, p20 = float(e9.iloc[i-1]), float(e20.iloc[i-1])
        c9, c20 = float(e9.iloc[i]),   float(e20.iloc[i])

        import math
        if any(math.isnan(v) for v in (p9, p20, c9, c20)):
            continue

        curr_above = c9 > c20
        prev_above = p9 > p20

        obs = weekly.iloc[i]["observation_date"]
        obs_date = obs.date() if hasattr(obs, "date") else obs

        if curr_above and not prev_above:
            crossovers.append((i, "GOLDEN", obs_date, weekly.iloc[i]["Close"], c9, c20))
        elif not curr_above and prev_above:
            crossovers.append((i, "DEATH",  obs_date, weekly.iloc[i]["Close"], c9, c20))

        above = curr_above

    # Filter to last 2 years
    recent = [(i, t, d, cl, e9v, e20v) for i, t, d, cl, e9v, e20v in crossovers
              if d >= TWO_YEARS_AGO]

    print(f"Total crossovers detected ever : {len(crossovers)}")
    print(f"Crossovers in last 2 years     : {len(recent)}")
    print(f"  (from {TWO_YEARS_AGO} to {TODAY})")
    print()

    if not recent:
        print("No crossovers in the last 2 years.")
        # Still show recent weekly state
        print("\n--- RECENT 8 WEEKS (EMA state) ---")
        _print_window(weekly, e9, e20, len(weekly)-8, len(weekly))
        return

    # ----------------------------------------------------------------
    # For each crossover: print a 4-week context window
    # ----------------------------------------------------------------
    SEP = "-" * 95

    for idx, (row_i, cross_type, obs_date, close, c9, c20) in enumerate(recent):
        diff_pct = (c9 - c20) / c20 * 100
        days_ago = (TODAY - obs_date).days

        print(SEP)
        print(f"  CROSSOVER {idx+1}/{len(recent)} : {cross_type}")
        print(f"  Signal date  : {obs_date}  ({days_ago}d ago)")
        print(f"  Week start   : {weekly.index[row_i].date()}")
        print(f"  Close        : Rs.{close:.2f}")
        print(f"  EMA9         : Rs.{c9:.4f}")
        print(f"  EMA20        : Rs.{c20:.4f}")
        print(f"  EMA diff %   : {diff_pct:+.4f}%")
        is_dev = bool(weekly.iloc[row_i]["is_developing"])
        print(f"  Developing?  : {'YES (intra-week close)' if is_dev else 'No (completed week)'}")
        print()

        # 4 bars before, crossover bar, 4 bars after
        start = max(0, row_i - 4)
        end   = min(len(weekly), row_i + 5)
        _print_window(weekly, e9, e20, start, end, highlight=row_i)

    print(SEP)
    print()

    # ----------------------------------------------------------------
    # Summary table — all crossovers last 2 years
    # ----------------------------------------------------------------
    print("SUMMARY — ALL CROSSOVERS LAST 2 YEARS")
    print(f"{'#':<4}{'Type':<12}{'Signal Date':<14}{'Days Ago':>9}{'Close':>10}{'EMA9':>12}{'EMA20':>12}{'Diff%':>9}")
    print("-" * 80)
    for idx, (row_i, cross_type, obs_date, close, c9, c20) in enumerate(recent):
        diff_pct = (c9 - c20) / c20 * 100
        days_ago = (TODAY - obs_date).days
        print(f"{idx+1:<4}{cross_type:<12}{str(obs_date):<14}{days_ago:>9}"
              f"{close:>10.2f}{c9:>12.4f}{c20:>12.4f}{diff_pct:>+9.4f}%")

    print()

    # Current state
    last_c9  = float(e9.iloc[-1])
    last_c20 = float(e20.iloc[-1])
    last_close = float(weekly.iloc[-1]["Close"])
    last_obs   = weekly.iloc[-1]["observation_date"]
    last_date  = last_obs.date() if hasattr(last_obs, "date") else last_obs
    diff_pct   = (last_c9 - last_c20) / last_c20 * 100
    print(f"CURRENT STATE  (obs_date: {last_date}{'  [DEVELOPING]' if weekly.iloc[-1]['is_developing'] else ''})")
    print(f"  Close  : Rs.{last_close:.2f}")
    print(f"  EMA9   : Rs.{last_c9:.4f}")
    print(f"  EMA20  : Rs.{last_c20:.4f}")
    print(f"  Diff%  : {diff_pct:+.4f}%  =>  {'ABOVE (bullish)' if last_c9 > last_c20 else 'BELOW (bearish)'}")


def _print_window(weekly, e9, e20, start, end, highlight=None):
    import math
    hdr = (f"  {'Wk Start':<12}{'Obs Date':<13}{'Dev':<5}"
           f"{'Close':>10}{'EMA9':>12}{'EMA20':>12}{'Diff%':>9}  {'Note'}")
    print(hdr)
    print("  " + "-" * 80)
    for i in range(start, end):
        row    = weekly.iloc[i]
        obs    = row["observation_date"]
        obs_d  = (obs.date() if hasattr(obs, "date") else obs)
        wk     = weekly.index[i].date()
        dev    = "→" if row["is_developing"] else " "
        close  = row["Close"]
        c9     = float(e9.iloc[i])
        c20    = float(e20.iloc[i])

        if math.isnan(c9) or math.isnan(c20):
            diff_s = "  NaN"
            note   = ""
        else:
            diff   = (c9 - c20) / c20 * 100
            diff_s = f"{diff:+9.4f}%"
            note   = ""
            if i == highlight:
                if c9 > c20:
                    note = "  << GOLDEN CROSS"
                else:
                    note = "  << DEATH CROSS"
            elif i > 0:
                pc9  = float(e9.iloc[i-1])
                pc20 = float(e20.iloc[i-1])
                if not (math.isnan(pc9) or math.isnan(pc20)):
                    if c9 > c20 and pc9 <= pc20:
                        note = "  ← cross"
                    elif c9 < c20 and pc9 >= pc20:
                        note = "  ← cross"

        marker = ">" if i == highlight else " "
        print(f"  {marker} {str(wk):<12}{str(obs_d):<13}{dev:<5}"
              f"{close:>10.2f}{c9:>12.4f}{c20:>12.4f}{diff_s}{note}")
    print()


if __name__ == "__main__":
    main()
