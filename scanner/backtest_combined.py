"""
backtest_combined.py
Comprehensive comparison of all strategies on 2016-2022 fully-resolved signals.

Fundamental scores are used for RANKING only — not as a hard filter.
Technical composite score (price_52w_position + ema_diff_pct + momentum_4w + ema20_slope)
is the primary filter, as established in factor_filter_2022.py.

Strategies compared:
  0. Baseline — all 2016-2022 signals, no filter
  1. Tech composite >= 9 only
  2. Tech composite >= 10 only
  3. Hard-rejection only (fundamentally broken stocks excluded)
  4. Tech >= 9  + Fundamental rank top-half   (score >= median)
  5. Tech >= 9  + Fundamental rank top-Q      (score >= Q75)
  6. Tech >= 10 + Fundamental rank top-half
  7. Tech >= 10 + Fundamental rank top-Q
  8. Hard-reject off + Tech >= 9 + Fund top-half   (all in one)
  9. Hard-reject off + Tech >= 10 + Fund top-Q     (kitchen sink)

Outcome metric: return_pct (GC→DC exit) — 2016-2022 closed signals only.
Win label: return_pct >= 10%.
Loss label: return_pct < 0%.

Run from scanner/ directory:
    python backtest_combined.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
sys.stdout.reconfigure(encoding='utf-8')

# ── Load data ─────────────────────────────────────────────────────────────────
print("Loading data...")

# factor_filter_results.csv = winner_loser_features.csv + composite scores
ffr = pd.read_csv(HERE / "factor_filter_results.csv", parse_dates=["gc_date"])

# Fundamental scores (one row per stock symbol)
fund = pd.read_csv(HERE / "scored_fundamentals.csv")[
    ["symbol", "fundamental_score", "hard_reject", "fund_class"]
]
# Both files use plain symbol (no .NS suffix) — direct join
df = ffr.merge(fund, on="symbol", how="left", suffixes=("", "_fund"))
df["fundamental_score"] = df["fundamental_score"].fillna(np.nan)
df["hard_reject"]        = df["hard_reject"].fillna(False).astype(bool)

print(f"  Total signals: {len(df)}")

# ── Restrict to 2016-2022 closed signals ─────────────────────────────────────
df = df[
    (df["gc_date"] >= "2016-01-01") &
    (df["gc_date"] <= "2022-12-31") &
    (df["status"] == "closed")
].copy()

print(f"  2016-2022 closed: {len(df)}")

# Evaluation subset: winner/loser only (no neutrals), post burn-in composite score
wl_all = df[df["label_binary"].isin(["winner", "loser"])].copy()
print(f"  Winner/Loser signals: {len(wl_all)}")

# Compute fundamental percentiles (expanding would be ideal but we use cross-sectional
# as a close approximation — fundamental quality doesn't change fast enough to create
# meaningful lookahead bias over a multi-year window)
fund_median = df["fundamental_score"].median()
fund_q75    = df["fundamental_score"].quantile(0.75)
print(f"  Fundamental score — median: {fund_median:.1f}  Q75: {fund_q75:.1f}")

# ── Helper: evaluate a mask ───────────────────────────────────────────────────

def evaluate(mask: pd.Series, label: str, baseline_wr: float,
             eval_df: pd.DataFrame = wl_all) -> dict:
    sub = eval_df[mask]
    n   = len(sub)
    if n < 10:
        return dict(label=label, n=n, win_pct=float("nan"),
                    lift=float("nan"), avg_ret=float("nan"),
                    med_ret=float("nan"), pass_pct=float("nan"))
    wr   = (sub["label_binary"] == "winner").mean() * 100
    lift = wr - baseline_wr
    avg  = sub["return_pct"].mean()
    med  = sub["return_pct"].median()
    pct  = n / len(eval_df) * 100
    return dict(label=label, n=n, win_pct=wr, lift=lift,
                avg_ret=avg, med_ret=med, pass_pct=pct)


# ── Strategy 0: Baseline ──────────────────────────────────────────────────────
baseline = evaluate(pd.Series([True] * len(wl_all), index=wl_all.index),
                    "0. Baseline (all signals)", 0)
BASE_WR = baseline["win_pct"]

# Masks
has_score     = wl_all["composite_score"].notna()
tech_9        = has_score & (wl_all["composite_score"] >= 9)
tech_10       = has_score & (wl_all["composite_score"] >= 10)
not_rejected  = ~wl_all["hard_reject"]
fund_top_half = wl_all["fundamental_score"] >= fund_median
fund_top_q    = wl_all["fundamental_score"] >= fund_q75

results = [
    evaluate(pd.Series([True]*len(wl_all), index=wl_all.index),
             "0. Baseline (all signals)", BASE_WR),

    evaluate(tech_9,
             "1. Tech composite >= 9", BASE_WR),

    evaluate(tech_10,
             "2. Tech composite >= 10", BASE_WR),

    evaluate(not_rejected,
             "3. Hard-rejection only (fund gate)", BASE_WR),

    evaluate(tech_9 & fund_top_half,
             "4. Tech>=9 + Fund top-half (score>={:.0f})".format(fund_median), BASE_WR),

    evaluate(tech_9 & fund_top_q,
             "5. Tech>=9 + Fund top-Q (score>={:.0f})".format(fund_q75), BASE_WR),

    evaluate(tech_10 & fund_top_half,
             "6. Tech>=10 + Fund top-half (score>={:.0f})".format(fund_median), BASE_WR),

    evaluate(tech_10 & fund_top_q,
             "7. Tech>=10 + Fund top-Q (score>={:.0f})".format(fund_q75), BASE_WR),

    evaluate(not_rejected & tech_9 & fund_top_half,
             "8. Hard-reject + Tech>=9 + Fund top-half", BASE_WR),

    evaluate(not_rejected & tech_10 & fund_top_q,
             "9. Hard-reject + Tech>=10 + Fund top-Q", BASE_WR),
]

# ── Print main results table ──────────────────────────────────────────────────
print()
print("=" * 90)
print("STRATEGY COMPARISON — 2016-2022 (return_pct GC→DC, closed signals)")
print("=" * 90)
print(f"  {'Strategy':<46} {'WinRate':>8} {'Lift':>7} {'N':>6} {'%Sigs':>7} {'AvgRet':>8} {'MedRet':>8}")
print(f"  {'-'*46} {'-'*8} {'-'*7} {'-'*6} {'-'*7} {'-'*8} {'-'*8}")

for r in results:
    wr   = f"{r['win_pct']:.1f}%"  if not np.isnan(r['win_pct'])  else "  N/A"
    lift = f"{r['lift']:+.1f}pp"   if not np.isnan(r['lift'])     else "  N/A"
    avg  = f"{r['avg_ret']:+.1f}%" if not np.isnan(r['avg_ret'])  else "  N/A"
    med  = f"{r['med_ret']:+.1f}%" if not np.isnan(r['med_ret'])  else "  N/A"
    pct  = f"{r['pass_pct']:.0f}%" if not np.isnan(r['pass_pct'])else "  N/A"
    print(f"  {r['label']:<46} {wr:>8} {lift:>7} {r['n']:>6} {pct:>7} {avg:>8} {med:>8}")


# ── Year-stratified for top 3 strategies ─────────────────────────────────────
print()
print("=" * 90)
print("YEAR-STRATIFIED WIN RATES")
print("=" * 90)

strats = [
    ("Baseline",           pd.Series([True]*len(wl_all), index=wl_all.index)),
    ("Tech>=9",            tech_9),
    ("Tech>=10",           tech_10),
    ("Tech>=9+Fund>=half", tech_9  & fund_top_half),
    ("Tech>=9+Fund>=Q75",  tech_9  & fund_top_q),
    ("Tech>=10+Fund>=Q75", tech_10 & fund_top_q),
]

header = f"  {'Year':>5}  " + "  ".join(f"{s[0]:>18}" for s in strats)
print(header)
print("  " + "-" * (7 + len(strats) * 20))

for yr in sorted(wl_all["gc_date"].dt.year.unique()):
    yr_mask = wl_all["gc_date"].dt.year == yr
    parts = [f"  {yr}  "]
    for lbl, mask in strats:
        sub = wl_all[yr_mask & mask]
        wr_str = (f"{(sub['label_binary']=='winner').mean()*100:.1f}% (n={len(sub)})"
                  if len(sub) >= 5 else "  N/A           ")
        parts.append(f"{wr_str:>18}  ")
    print("".join(parts))


# ── Fundamental ranking within Tech>=9 ───────────────────────────────────────
print()
print("=" * 90)
print("FUNDAMENTAL RANKING WITHIN TECH>=9 SIGNALS")
print("  (Does fundamental score predict which tech-filtered signals win?)")
print("=" * 90)

tech9_sigs = wl_all[tech_9].copy()
fund_q25_val = tech9_sigs["fundamental_score"].quantile(0.25)
fund_q50_val = tech9_sigs["fundamental_score"].quantile(0.50)
fund_q75_val = tech9_sigs["fundamental_score"].quantile(0.75)

def fund_tier(score):
    if pd.isna(score): return "Q2"  # no data → middle
    if score < fund_q25_val:  return "Q1 (lowest)"
    if score < fund_q50_val:  return "Q2"
    if score < fund_q75_val:  return "Q3"
    return "Q4 (highest)"

tech9_sigs["fund_quartile"] = tech9_sigs["fundamental_score"].apply(fund_tier)

print(f"\n  Tech>=9 signals: {len(tech9_sigs)}")
print(f"  Q25={fund_q25_val:.0f}  Q50={fund_q50_val:.0f}  Q75={fund_q75_val:.0f}")
print(f"  {'Fund Quartile':<15} {'WinRate':>9} {'N':>6} {'AvgRet':>8} {'MedRet':>8}")
print(f"  {'-'*15} {'-'*9} {'-'*6} {'-'*8} {'-'*8}")
for q in ["Q1 (lowest)", "Q2", "Q3", "Q4 (highest)"]:
    sub = tech9_sigs[tech9_sigs["fund_quartile"] == q]
    wr  = (sub["label_binary"] == "winner").mean() * 100
    avg = sub["return_pct"].mean()
    med = sub["return_pct"].median()
    print(f"  {q:<15} {wr:>8.1f}%  {len(sub):>6} {avg:>+8.1f}% {med:>+8.1f}%")


# ── Same analysis within Tech>=10 ────────────────────────────────────────────
print()
print("  Fundamental ranking within Tech>=10 signals:")
tech10_sigs = wl_all[tech_10].copy()
if len(tech10_sigs) >= 40:
    fq25 = tech10_sigs["fundamental_score"].quantile(0.25)
    fq50 = tech10_sigs["fundamental_score"].quantile(0.50)
    fq75 = tech10_sigs["fundamental_score"].quantile(0.75)
    def ft10(s):
        if pd.isna(s): return "Q2"
        if s < fq25: return "Q1 (lowest)"
        if s < fq50: return "Q2"
        if s < fq75: return "Q3"
        return "Q4 (highest)"
    tech10_sigs["fund_quartile"] = tech10_sigs["fundamental_score"].apply(ft10)
    print(f"  Tech>=10 signals: {len(tech10_sigs)}")
    print(f"  Q25={fq25:.0f}  Q50={fq50:.0f}  Q75={fq75:.0f}")
    for q in ["Q1 (lowest)", "Q2", "Q3", "Q4 (highest)"]:
        sub = tech10_sigs[tech10_sigs["fund_quartile"] == q]
        wr  = (sub["label_binary"] == "winner").mean() * 100
        avg = sub["return_pct"].mean()
        med = sub["return_pct"].median()
        print(f"  {q:<15} {wr:>8.1f}%  {len(sub):>6} {avg:>+8.1f}% {med:>+8.1f}%")


# ── Return distribution comparison ───────────────────────────────────────────
print()
print("=" * 90)
print("RETURN DISTRIBUTION — Key Strategies")
print("=" * 90)

for lbl, mask in [
    ("Baseline",           pd.Series([True]*len(wl_all), index=wl_all.index)),
    ("Tech>=9",            tech_9),
    ("Tech>=10",           tech_10),
    ("Tech>=10 + Fund Q75",tech_10 & fund_top_q),
]:
    sub = wl_all[mask]["return_pct"].dropna()
    n_w = (wl_all[mask]["label_binary"] == "winner").sum()
    n_l = (wl_all[mask]["label_binary"] == "loser").sum()
    wr  = n_w / (n_w + n_l) * 100

    # Expectancy
    w_returns = wl_all[mask & (wl_all["label_binary"]=="winner")]["return_pct"].dropna()
    l_returns = wl_all[mask & (wl_all["label_binary"]=="loser" )]["return_pct"].dropna()
    avg_w = w_returns.mean() if len(w_returns) else 0
    avg_l = l_returns.mean() if len(l_returns) else 0
    expectancy = (wr/100)*avg_w + (1 - wr/100)*avg_l

    print(f"\n  {lbl} (n={len(sub)}, WR={wr:.1f}%):")
    print(f"    Q10={sub.quantile(.10):+.1f}%  Q25={sub.quantile(.25):+.1f}%"
          f"  Median={sub.median():+.1f}%  Mean={sub.mean():+.1f}%"
          f"  Q75={sub.quantile(.75):+.1f}%  Q90={sub.quantile(.90):+.1f}%")
    print(f"    Avg winner: {avg_w:+.1f}%   Avg loser: {avg_l:+.1f}%")
    print(f"    Expectancy: {expectancy:+.1f}% per trade")
    print(f"    Win/Loss ratio: {abs(avg_w/avg_l):.1f}x" if avg_l != 0 else "")


print("\nDone.")
