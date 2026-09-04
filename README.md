# NSE Stock Screener — V1

A daily technical screener and signal dashboard for NSE-listed equities.

**Live dashboard:** https://web-8pbed5upq-ivyan26733s-projects.vercel.app/

---

## What it does

Runs a local Python scanner after each market session to:
- Detect **weekly EMA 9/20 golden crossovers** (developing weekly candle, not Friday-only)
- Detect **6-month price breakouts** (today's close > highest close in previous 6 months)
- Push all signals and indicators to **Supabase PostgreSQL**
- The **Vercel frontend** reads from Supabase and displays results in real time

---

## Architecture

```
Yahoo Finance (yfinance)
        │
        ▼
Local Python Scanner  ──►  Supabase PostgreSQL
        │                         │
  run_scanner.bat                 ▼
                          Vercel Frontend (read-only)
                          frontend-livid-five-89.vercel.app
```

---

## Frontend Tabs

| Tab | What it shows |
|-----|--------------|
| **Fresh EMA Crossovers** | Golden crosses in the last 4 weeks still above EMA9 > EMA20 |
| **6M Breakouts** | Stocks that broke 6-month highs in the last 30 days |
| **Active EMA** | All stocks currently above EMA9 > EMA20, sorted by EMA diff% |
| **Signal History** | Full paginated history — filter by strategy, symbol, sector, date range |
| **📈 Returns** | Golden crosses ≥2 weeks old still holding — tracks portfolio performance |
| **⭐ Watchlist** | Star any stock from any tab; persisted in browser localStorage |

**Global filters** (apply to every tab at once):
- Return% threshold (Any / >0% / >5% / >10% / >20% / >50%)
- Watchlist-only toggle

---

## Project Structure

```
app/
  config/settings.py          — Environment config (Supabase URL, keys)
  data/
    market_data.py            — yfinance download + update logic
    universe.py               — NSE stock universe loader
    weekly.py                 — Developing weekly candle construction
    validation.py             — OHLCV data validation
  indicators/
    ema.py                    — EMA 9 and EMA 20 calculation
  strategies/
    base.py                   — Abstract strategy interface
    ema_crossover.py          — Weekly EMA 9/20 golden/death cross detection
    breakout_6m.py            — 6-month high breakout detection
  database/
    supabase_client.py        — Supabase connection (service role, scanner-only)
    repositories.py           — Upsert logic for all tables
  scanner/
    runner.py                 — Main scan orchestration (run this)
  utils/
    logging.py                — Structured logging helpers
    dates.py                  — Date utility functions

frontend/
  index.html                  — Dashboard layout and tabs
  styles.css                  — All styles
  app.js                      — All frontend logic (Supabase reads, rendering)

sql/
  schema.sql                  — Database schema for all tables

tests/
  test_ema.py
  test_weekly.py
  test_crossover.py
  test_validation.py

run_scanner.bat               — Windows one-click scanner launcher
.env.example                  — Required environment variables (copy to .env)
requirements.txt              — Python dependencies
```

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/ivyan26733/Automated_Strategy_Notifier.git
cd Automated_Strategy_Notifier
pip install -r requirements.txt
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your credentials:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

The service role key is **only used by the local scanner**. Never expose it in the frontend.

### 3. Set up Supabase

Run `sql/schema.sql` in your Supabase SQL editor to create all tables.

### 4. Run the scanner

**Windows (double-click):**
```
run_scanner.bat
```

**Command line:**
```bash
python -m app.scanner.runner
```

Expected output:
```
========================================
NSE STOCK SCANNER COMPLETE
========================================
Stocks scanned: 2,487
Stocks successful: 2,476
New EMA crossover signals: 7
New 6-month breakout signals: 14
Supabase update: SUCCESS
========================================
```

---

## Key Strategy Rules

### EMA Crossover

- EMA 9 and EMA 20 are calculated on **weekly closes**
- Uses a **developing weekly candle** — updated after each daily close (not Friday-only)
- Golden cross: `prev_EMA9 <= prev_EMA20 AND curr_EMA9 > curr_EMA20`
- Duplicate prevention: once above, no new signal until EMA9 drops back below EMA20

### 6-Month Breakout

- Fires when: `today's close > highest close in the previous 6 calendar months`
- Today's close is excluded from the reference window
- Stored: symbol, breakout date, close price, 6M high reference, breakout %

---

## Database Tables

| Table | Purpose |
|-------|---------|
| `stocks` | NSE universe — symbol, name, sector, industry |
| `weekly_indicators` | Weekly EMA values per stock per observation date |
| `signals` | All generated signals (EMA crossovers + breakouts) |
| `scanner_runs` | Audit log of every scanner execution |

---

## Security

- `.env` is in `.gitignore` — never committed
- The Supabase **service role key** stays on your local machine only
- The frontend uses only the **anon key** (read-only, RLS-protected)
- The anon key is safe to expose in the browser

---

## Frontend Deployment

The frontend (`frontend/`) is deployed to Vercel.

```bash
cd frontend
vercel --prod
```

The frontend reads directly from Supabase using the anon key. No server needed.

---

## Tests

```bash
pytest tests/
```

Covers EMA calculation, weekly candle construction, crossover detection, and data validation.
