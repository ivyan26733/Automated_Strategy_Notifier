# NSE Stock Screener — V2

A daily technical screener, signal dashboard and plain-English research guide for NSE-listed equities.

**Live dashboard:** https://screener-swart-three.vercel.app

---

## What it does

- A Python **scanner** runs every weekday after market close (GitHub Actions) and:
  - detects **weekly EMA 9/20 golden crosses** that pass a 6-rule quality checklist, plus the **death crosses** that end them;
  - detects **6-month price breakouts**;
  - writes stocks, weekly indicators, signals and a run log to **Supabase PostgreSQL**.
- A **Vercel** site serves the dashboard and a small Node API (`/api/*`) that reads Supabase server-side and turns raw signal rows into trades: entry, exit, status and return.

---

## Architecture

```
Yahoo Finance (yfinance)
        │
        ▼
Python scanner (GitHub Actions, Mon–Fri 16:30 IST)  ──►  Supabase PostgreSQL
                                                                 │
                                                                 ▼
                                   Vercel project "screener" (Root Directory = web)
                                   ├─ /api/*      Node serverless functions (supabase-js)
                                   └─ /frontend   static HTML/CSS/JS dashboard
```

The database keys live only in GitHub Actions secrets and Vercel environment variables. The browser never talks to Supabase directly.

---

## Dashboard tabs

| Tab | What it shows |
|-----|---------------|
| **Fresh EMA Crossovers** | Golden-cross episodes first seen by the latest successful scanner run |
| **Active EMA** | Open positions: a golden cross with no death cross since, marked to today's price |
| **Signal History** | Every golden cross and breakout on record, back to 1991. A cross that later hit its death cross shows as **Closed**, with its exit date and entry→exit return. Sorting, filters and **numbered pages** apply to all signals, not just the page on screen. |
| **📈 Returns** | How golden-cross trades performed over a chosen period (1Y … all time) |
| **☆ Watchlist** | Stocks you starred on any tab (saved in your browser) |
| **Research & Backtests** | A 10-minute plain-English guide to the live strategy: trade replay, rule checker, results, risks, rule versions and a quiz. Chapters are followed by an analyst deep dive and a glossary. A **sticky animated reading timeline** on the left follows your scroll. |
| **📋 Formula Sheet** | Every number on the site explained four ways: plain words, exact formula, a worked example (M&M, 19 Jun 2020) and where it appears. Includes small calculators. |

**Global filters** (Return% threshold, Watchlist only) apply to every tab. On Signal History they are applied on the server.

---

## Strategy rules

### EMA crossover (`scanner/app/strategies/ema_crossover.py`)

EMA 9 and EMA 20 are computed on weekly closes. The developing weekly bar is evaluated after each daily close, so a cross shows up the day it happens (a mid-week cross can still repaint by Friday). A golden cross becomes a signal only if **all six rules** pass:

1. **Fresh cross:** `prev EMA9 ≤ prev EMA20` and `EMA9 > EMA20`, and EMA9 was not already above.
2. **Rising trend:** EMA20 has risen strictly for 4 weeks in a row.
3. **Real gap:** `EMA9 − EMA20 ≥ 0.05 × ATR(14)`, using Wilder's ATR on weekly bars.
4. **Volume:** that day's volume is above the 20-day average. The rule is skipped if there isn't enough daily data.
5. **Enough history:** at least 6 weekly candles.
6. **One signal per cross:** a cross that fails a rule is used up. There is no new signal until EMA9 drops back below EMA20.

A **death cross** (EMA9 falls back below EMA20) closes the position and has no extra rules. Re-fires from the developing bar are collapsed into one trade episode by the API.

### 6-month breakout (`scanner/app/strategies/breakout_6m.py`)

Fires when the developing weekly close is above the highest completed weekly close in the window 6 months to 2 months before. Stored with `breakout_pct = close ÷ reference − 1`.

---

## Backtest headline (live 6 rules, Jan 2016 – Sep 2026)

From an offline replay of `EmaCrossoverStrategy` on completed weekly candles (see the Research tab):

| Measure | Result |
|---------|--------|
| Finished trades | 941 (about 96 signals a year) |
| Trades that made money | 37.4% |
| Typical win vs typical loss | +48.7% vs −13.4% |
| Money won ÷ money lost | ≈ 4.1× |
| Volume rule | Halves the signals, win rate about level (37.9% → 37.4%) |

The guide's numbers come from `web/frontend/research-data.js`, which was generated offline. If the strategy rules change, the backtest must be re-run.

---

## Project structure

```
.github/workflows/
  scanner.yml               — Scheduled scanner run (Mon–Fri 11:00 UTC) + manual trigger
  keepalive.yml             — Weekly job that stops GitHub disabling the schedule

scanner/
  app/
    config/settings.py      — Environment config
    data/                   — yfinance download, universe, weekly candles, validation
    indicators/ema.py       — EMA 9 / EMA 20
    strategies/             — base.py, ema_crossover.py, breakout_6m.py
    database/               — Supabase client (service role) and upsert repositories
    scanner/runner.py       — Scan orchestration (entry point)
    utils/                  — Logging and date helpers
  sql/schema.sql            — Database schema
  tests/                    — EMA, weekly candles, crossover, breakout, validation
  requirements.txt
  run_scanner.bat           — Windows one-click local run
  .env.example              — Required environment variables

web/
  api/
    _db.js, _utils.js       — Supabase client, paging, episode matching, shared helpers
    summary.js              — Header KPIs and last scanner run
    crossovers.js           — Fresh EMA Crossovers
    active.js               — Active EMA
    breakouts.js            — Recent 6-month breakouts
    history.js              — Signal History (server-side sort / filter / pages)
    returns.js              — Returns tab
    watchlist.js            — Watchlist rows
  frontend/
    index.html, styles.css  — Layout, tabs, light/dark themes
    app.js                  — Tabs, tables, pager, filters, watchlist
    charts.js               — Chart.js helpers
    research.js             — Research guide widgets and the reading timeline
    research-data.js        — Static backtest data for the guide
    formulas.js             — Formula Sheet widgets
  vercel.json               — Rewrites + History function timeout (60s)
```

---

## Setup

### 1. Scanner (Python)

```bash
git clone https://github.com/ivyan26733/Automated_Strategy_Notifier.git
cd Automated_Strategy_Notifier/scanner
pip install -r requirements.txt
cp .env.example .env        # fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
```

Create the tables by running `scanner/sql/schema.sql` in the Supabase SQL editor.

Run the scanner locally with `python -m app.scanner.runner` (or `run_scanner.bat` on Windows). In production it runs from `.github/workflows/scanner.yml`; add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as repository secrets.

### 2. Website (Vercel)

- Vercel project **screener**, Root Directory `web`.
- Environment variables: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.
- **Deploy by pushing to `main`**: Vercel builds automatically.

### 3. Tests

```bash
cd scanner
pytest tests/
```

---

## Database tables

| Table | Purpose |
|-------|---------|
| `stocks` | NSE universe: symbol, name, sector, industry, listing date |
| `weekly_indicators` | Weekly close, EMA 9/20 and gap per stock per observation date |
| `signals` | Golden crosses, death crosses and breakouts (unique on strategy, symbol, date, type) |
| `scanner_runs` | Audit log of every scanner run (start, finish, status) |

---

## Recent progress (September 2026)

- **Header V2:** centred brand with logo mark and a V2 badge; scanner status on the left, last scan on the right.
- **Research tab:**
  - rebuilt as a plain-English, 7-chapter guide backed by a replay of the live rules;
  - sticky animated reading timeline (active chapter, % read, minutes left);
  - content uses the full page width.
- **Formula Sheet:** rebuilt with plain words, exact maths, worked examples and calculators.
- **Signal History:**
  - server-side sorting, filtering and numbered pagination over every signal, replacing "Load more";
  - the full list is built once per scanner run and cached in memory (about 7s on a cold start, milliseconds after);
  - exact totals after removing repeat sightings.
- **History accuracy:** entries only (death crosses show as Closed with their exit), Return% matched to the real exit, duplicate re-fire rows collapsed.
- **Reliability:**
  - database failures are shown as errors, not as empty tables;
  - PostgREST 1,000-row caps are paged around with a stable order;
  - "nothing crossed today" is stated plainly.
- **Strategy:** the 6-rule entry checklist is live, and the scanner emits death crosses so positions close properly.

## Known limitations

- The header's **Total Signals** (37,534) counts raw rows. Signal History lists 34,078 after dropping circuit and newly listed stocks and repeat sightings of the same cross.
- A few very old trades span gaps in the historical price data and show impossible returns (for example KPIL 2004: +61,893%). They surface at the top when sorting Return% high → low.
- The developing weekly bar means a mid-week cross can disappear by Friday (repaint). This is accepted so signals appear daily.
- The backtest only includes companies listed today (survivorship bias), and prices ignore brokerage, taxes and slippage.
