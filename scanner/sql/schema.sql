-- NSE Stock Screener — Supabase schema
-- Run this once in the Supabase SQL editor to create all tables.
-- Safe to re-run: uses CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS.

-- ============================================================
-- stocks
-- ============================================================
CREATE TABLE IF NOT EXISTS stocks (
    symbol           TEXT        PRIMARY KEY,
    name             TEXT        NOT NULL DEFAULT '',
    exchange         TEXT        NOT NULL DEFAULT 'NSE',
    sector           TEXT        NOT NULL DEFAULT '',
    industry         TEXT        NOT NULL DEFAULT '',
    series           TEXT        NOT NULL DEFAULT '',
    isin             TEXT        NOT NULL DEFAULT '',
    date_of_listing  TEXT        NOT NULL DEFAULT '',
    face_value       TEXT        NOT NULL DEFAULT '',
    active           BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- weekly_indicators
-- One row per (symbol, observation_date).
-- observation_date = the daily close date used for the developing week.
-- ============================================================
CREATE TABLE IF NOT EXISTS weekly_indicators (
    symbol              TEXT        NOT NULL REFERENCES stocks(symbol) ON DELETE CASCADE,
    observation_date    DATE        NOT NULL,
    week_start          DATE        NOT NULL,
    weekly_open         NUMERIC,
    weekly_high         NUMERIC,
    weekly_low          NUMERIC,
    weekly_close        NUMERIC,
    weekly_volume       NUMERIC,
    ema9                NUMERIC,
    ema20               NUMERIC,
    ema_difference      NUMERIC,
    ema_difference_pct  NUMERIC,
    is_developing_week  BOOLEAN     NOT NULL DEFAULT TRUE,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (symbol, observation_date)
);

CREATE INDEX IF NOT EXISTS idx_weekly_indicators_symbol
    ON weekly_indicators (symbol);

-- ============================================================
-- signals
-- Generalized table for all strategy signals.
-- Unique constraint on (strategy_name, symbol, signal_date, signal_type)
-- prevents duplicate signals on re-run.
-- ============================================================
CREATE TABLE IF NOT EXISTS signals (
    id                  BIGSERIAL   PRIMARY KEY,
    strategy_name       TEXT        NOT NULL,
    signal_type         TEXT        NOT NULL,
    symbol              TEXT        NOT NULL REFERENCES stocks(symbol) ON DELETE CASCADE,
    signal_date         DATE        NOT NULL,
    price               NUMERIC,
    weekly_close        NUMERIC,
    ema9                NUMERIC,
    ema20               NUMERIC,
    ema_difference      NUMERIC,
    ema_difference_pct  NUMERIC,
    breakout_reference  NUMERIC,
    breakout_pct        NUMERIC,
    sector              TEXT        NOT NULL DEFAULT '',
    industry            TEXT        NOT NULL DEFAULT '',
    status              TEXT        NOT NULL DEFAULT 'active',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_signal UNIQUE (strategy_name, symbol, signal_date, signal_type)
);

CREATE INDEX IF NOT EXISTS idx_signals_symbol
    ON signals (symbol);
CREATE INDEX IF NOT EXISTS idx_signals_signal_date
    ON signals (signal_date DESC);
CREATE INDEX IF NOT EXISTS idx_signals_strategy
    ON signals (strategy_name, signal_date DESC);

-- ============================================================
-- scanner_runs
-- One row per scanner execution — auditable run log.
-- ============================================================
CREATE TABLE IF NOT EXISTS scanner_runs (
    id                BIGSERIAL   PRIMARY KEY,
    started_at        TIMESTAMPTZ NOT NULL,
    finished_at       TIMESTAMPTZ,
    status            TEXT        NOT NULL DEFAULT 'running',   -- running | success | failed
    stocks_requested  INTEGER     NOT NULL DEFAULT 0,
    stocks_processed  INTEGER     NOT NULL DEFAULT 0,
    stocks_failed     INTEGER     NOT NULL DEFAULT 0,
    signals_created   INTEGER     NOT NULL DEFAULT 0,
    error_summary     TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Row Level Security
-- Frontend uses the anon key → read-only access to these tables.
-- Scanner uses the service_role key → bypasses RLS entirely.
-- ============================================================
ALTER TABLE stocks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_indicators ENABLE ROW LEVEL SECURITY;
ALTER TABLE signals           ENABLE ROW LEVEL SECURITY;
ALTER TABLE scanner_runs      ENABLE ROW LEVEL SECURITY;

-- Allow public read on all four tables
-- Wrapped in DO blocks because CREATE POLICY has no IF NOT EXISTS clause
DO $$ BEGIN
    CREATE POLICY "public read stocks" ON stocks FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE POLICY "public read weekly_indicators" ON weekly_indicators FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE POLICY "public read signals" ON signals FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE POLICY "public read scanner_runs" ON scanner_runs FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
