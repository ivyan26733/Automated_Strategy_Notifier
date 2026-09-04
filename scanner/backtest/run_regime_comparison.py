"""
Regime Filter Comparison
Adds Nifty 50 200-week EMA as a market gate: only take signals when Nifty is above it.
Compares 4 strategies side by side:
  1. GC->DC  (no filter)
  2. GC->DC  + regime filter
  3. MB       (no filter)
  4. MB       + regime filter

Run from scanner/ directory:
    python -m backtest.run_regime_comparison
"""
import sys, time, io
from pathlib import Path
from bisect import bisect_right

import pandas as pd
import yfinance as yf

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.path.insert(0, str(Path(__file__).parent.parent))

from backtest.loader           import load
from backtest.weekly           import to_weekly
from backtest.ema              import add_ema, find_all_crosses
from backtest.returns_trend    import calc_trend_return
from backtest.signals_momentum import find_momentum_entries, dedup_by_uptrend

AUDIT_FILE = Path(__file__).parent.parent / 'audit_results_usable.csv'
GC_FILE    = Path(__file__).parent.parent / 'backtest_signals_trend.csv'
MB_FILE    = Path(__file__).parent.parent / 'backtest_signals_momentum.csv'
NIFTY_CACHE= Path(__file__).parent.parent / 'nifty_weekly_cache.csv'

SIGNAL_START = '2016-01-01'
SIGNAL_END   = '2022-12-31'
_START = pd.Timestamp(SIGNAL_START)
_END   = pd.Timestamp(SIGNAL_END)


# ── Step 1: Nifty 200-week EMA regime lookup ─────────────────────────

def build_nifty_regime():
    if NIFTY_CACHE.exists():
        df = pd.read_csv(NIFTY_CACHE, parse_dates=['Date'])
        print(f'  Loaded Nifty cache: {len(df)} weekly bars')
    else:
        print('  Downloading Nifty 50 weekly data from Yahoo Finance...')
        ticker = yf.Ticker('^NSEI')
        raw = ticker.history(start='2010-01-01', interval='1wk')
        raw = raw.reset_index().rename(columns={'Datetime': 'Date'})[['Date', 'Close']].dropna()
        raw.to_csv(NIFTY_CACHE, index=False)
        df = raw
        print(f'  Downloaded {len(df)} weekly bars')

    df = df.sort_values('Date').reset_index(drop=True)
    df['ema200'] = df['Close'].ewm(span=200, adjust=False).mean()
    df['above']  = df['Close'] > df['ema200']
    df['date']   = pd.to_datetime(df['Date']).dt.date

    # Build sorted lookup arrays for bisect
    dates  = list(df['date'])
    above  = list(df['above'])
    return dates, above


def is_uptrend(nifty_dates, nifty_above, signal_date):
    """True if Nifty was above its 200w EMA on or just before signal_date."""
    if isinstance(signal_date, str):
        from datetime import datetime
        signal_date = datetime.strptime(signal_date, '%Y-%m-%d').date()
    idx = bisect_right(nifty_dates, signal_date) - 1
    if idx < 0:
        return True   # no data before this date — allow
    return bool(nifty_above[idx])


# ── Step 2: Stats helper ──────────────────────────────────────────────

def stats(df):
    r = df[df['return_pct'].notna()].copy()
    if r.empty:
        return {}
    w = r[r['return_pct'] > 0]
    l = r[r['return_pct'] <= 0]
    pf = (w['return_pct'].sum() / abs(l['return_pct'].sum())
          if len(l) and l['return_pct'].sum() != 0 else float('inf'))
    return {
        'n':        len(r),
        'wr':       len(w) / len(r) * 100,
        'avg':      r['return_pct'].mean(),
        'median':   r['return_pct'].median(),
        'avg_win':  w['return_pct'].mean() if len(w) else 0,
        'avg_loss': l['return_pct'].mean() if len(l) else 0,
        'pf':       pf,
        'hold':     r['hold_days'].mean(),
        'gt50':     (r['return_pct'] > 50).mean() * 100,
        'lt_20':    (r['return_pct'] < -20).mean() * 100,
    }


def print_stats(label, s, yr_wr=None):
    if not s:
        print(f'  {label}: no data')
        return
    print(f'  {label}')
    print(f'    Trades      : {s["n"]:>5}')
    print(f'    Win rate    : {s["wr"]:>6.1f}%')
    print(f'    Avg return  : {s["avg"]:>+7.2f}%')
    print(f'    Median ret  : {s["median"]:>+7.2f}%')
    print(f'    Avg winner  : {s["avg_win"]:>+7.2f}%')
    print(f'    Avg loser   : {s["avg_loss"]:>+7.2f}%')
    print(f'    Profit fac  : {s["pf"]:>7.3f}')
    print(f'    Avg hold    : {s["hold"]:>7.0f}d ({s["hold"]/30:.1f}mo)')
    print(f'    >50pct      : {s["gt50"]:>6.1f}%')
    print(f'    <-20pct     : {s["lt_20"]:>6.1f}%')
    if yr_wr:
        print(f'    Year WR     :', '  '.join(f'{y}={v:.0f}%' for y, v in yr_wr.items()))
    print()


def year_wr(df, date_col):
    df = df[df['return_pct'].notna()].copy()
    df['yr'] = pd.to_datetime(df[date_col]).dt.year
    return {yr: (grp['return_pct'] > 0).mean() * 100
            for yr, grp in df.groupby('yr')}


# ── Step 3: Load existing signals and apply regime filter ─────────────

def main():
    t0 = time.time()
    print('=' * 65)
    print('  REGIME FILTER COMPARISON (Nifty 50 above 200-week EMA)')
    print('=' * 65)
    print()

    print('Building Nifty regime lookup...')
    nifty_dates, nifty_above = build_nifty_regime()
    print()

    # --- GC->DC (already computed) ---
    print('Loading GC->DC backtest signals...')
    gc_all = pd.read_csv(GC_FILE)
    gc_all['return_pct'] = pd.to_numeric(gc_all['return_pct'], errors='coerce')
    gc_all['hold_days']  = pd.to_numeric(gc_all['hold_days'],  errors='coerce')

    regime_mask_gc = gc_all['gc_date'].apply(
        lambda d: is_uptrend(nifty_dates, nifty_above, d))
    gc_reg = gc_all[regime_mask_gc].copy()
    print(f'  GC->DC: {len(gc_all)} total -> {len(gc_reg)} after regime filter '
          f'({len(gc_all)-len(gc_reg)} removed, {(len(gc_all)-len(gc_reg))/len(gc_all)*100:.1f}%)')
    print()

    # --- MB (already computed) ---
    print('Loading Momentum Breakout signals...')
    mb_all = pd.read_csv(MB_FILE)
    mb_all['return_pct'] = pd.to_numeric(mb_all['return_pct'], errors='coerce')
    mb_all['hold_days']  = pd.to_numeric(mb_all['hold_days'],  errors='coerce')

    regime_mask_mb = mb_all['mb_date'].apply(
        lambda d: is_uptrend(nifty_dates, nifty_above, d))
    mb_reg = mb_all[regime_mask_mb].copy()
    print(f'  MB: {len(mb_all)} total -> {len(mb_reg)} after regime filter '
          f'({len(mb_all)-len(mb_reg)} removed, {(len(mb_all)-len(mb_reg))/len(mb_all)*100:.1f}%)')
    print()

    # --- Print results ---
    print('=' * 65)
    print('  RESULTS')
    print('=' * 65)
    print()

    s1 = stats(gc_all); yr1 = year_wr(gc_all, 'gc_date')
    s2 = stats(gc_reg); yr2 = year_wr(gc_reg, 'gc_date')
    s3 = stats(mb_all); yr3 = year_wr(mb_all, 'mb_date')
    s4 = stats(mb_reg); yr4 = year_wr(mb_reg, 'mb_date')

    print_stats('GC->DC  (baseline, no filter)', s1, yr1)
    print_stats('GC->DC  + regime filter',       s2, yr2)
    print_stats('MB      (baseline, no filter)', s3, yr3)
    print_stats('MB      + regime filter',       s4, yr4)

    # Side by side summary table
    print()
    print('=' * 65)
    print('  SUMMARY TABLE')
    print('=' * 65)
    hdr = f"  {'Metric':<18} {'GC->DC':>10} {'GC+Regime':>10} {'MB':>10} {'MB+Regime':>10}"
    print(hdr)
    print('  ' + '-' * 60)
    rows_out = [
        ('Trades',      s1['n'],      s2['n'],      s3['n'],      s4['n'],      'd', 0),
        ('Win rate%',   s1['wr'],     s2['wr'],     s3['wr'],     s4['wr'],     'f', 1),
        ('Avg return%', s1['avg'],    s2['avg'],    s3['avg'],    s4['avg'],    'f', 2),
        ('Median ret%', s1['median'], s2['median'], s3['median'], s4['median'], 'f', 2),
        ('Avg winner%', s1['avg_win'],s2['avg_win'],s3['avg_win'],s4['avg_win'],'f', 2),
        ('Avg loser%',  s1['avg_loss'],s2['avg_loss'],s3['avg_loss'],s4['avg_loss'],'f',2),
        ('Profit fac',  s1['pf'],     s2['pf'],     s3['pf'],     s4['pf'],     'f', 3),
        ('Avg hold(d)', s1['hold'],   s2['hold'],   s3['hold'],   s4['hold'],   'f', 0),
        ('>50% trades', s1['gt50'],   s2['gt50'],   s3['gt50'],   s4['gt50'],   'f', 1),
        ('<-20% trades',s1['lt_20'],  s2['lt_20'],  s3['lt_20'],  s4['lt_20'],  'f', 1),
    ]
    for name, v1, v2, v3, v4, fmt_, dec in rows_out:
        if fmt_ == 'd':
            print(f"  {name:<18} {v1:>10,d} {v2:>10,d} {v3:>10,d} {v4:>10,d}")
        else:
            f = f'.{dec}f'
            print(f"  {name:<18} {v1:>10{f}} {v2:>10{f}} {v3:>10{f}} {v4:>10{f}}")

    print()
    print('  Year-by-year Win Rate:')
    print(f"  {'Year':<8} {'GC->DC':>8} {'GC+Reg':>8} {'MB':>8} {'MB+Reg':>8}")
    print('  ' + '-' * 40)
    all_years = sorted(set(yr1) | set(yr2) | set(yr3) | set(yr4))
    for yr in all_years:
        v1 = yr1.get(yr, 0); v2 = yr2.get(yr, 0)
        v3 = yr3.get(yr, 0); v4 = yr4.get(yr, 0)
        print(f"  {yr:<8} {v1:>7.1f}% {v2:>7.1f}% {v3:>7.1f}% {v4:>7.1f}%")

    elapsed = time.time() - t0
    print()
    print(f'  Completed in {elapsed:.1f}s')
    print('=' * 65)


if __name__ == '__main__':
    main()
