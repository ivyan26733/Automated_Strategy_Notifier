const { db } = require('./_db')

const CHUNK = 200
const EMA_WINDOW_DAYS = 28
const BRK_WINDOW_DAYS = 30

function daysAgo(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

function mkChunks(arr) {
  const out = []
  for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK))
  return out
}

function send(res, data, status = 200) {
  res.status(status).json(data)
}

function sendErr(res, message, status = 500) {
  res.status(status).json({ error: message })
}

// Latest obs date + set of symbols where EMA9 > EMA20
async function getObsContext() {
  const { data } = await db.from('weekly_indicators')
    .select('observation_date')
    .order('observation_date', { ascending: false })
    .limit(1)

  const obsDate = data?.[0]?.observation_date
  if (!obsDate) return { obsDate: null, activeSet: new Set() }

  const { data: active } = await db.from('weekly_indicators')
    .select('symbol')
    .gte('observation_date', daysAgo(obsDate, 7))
    .gt('ema_difference', 0)

  return {
    obsDate,
    activeSet: new Set((active || []).map(r => r.symbol)),
  }
}

// Start time of the most recent COMPLETED scanner run.
// Signals whose created_at is >= this were discovered for the first time by that run.
// created_at survives upsert (upsert_signals only rewrites updated_at), so a signal
// already known from an earlier run keeps its original timestamp and drops out of
// "fresh" as soon as the next run finishes.
// Anchored to status='success' so a run in flight doesn't make Fresh grow mid-scan.
async function getLatestRunStart() {
  const { data } = await db.from('scanner_runs')
    .select('started_at')
    .eq('status', 'success')
    .not('finished_at', 'is', null)
    .order('started_at', { ascending: false })
    .limit(1)
  return data?.[0]?.started_at || null
}

// Monday of the ISO week containing `date`
function weekStart(date) {
  const d = new Date(date)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

// Collapse each symbol's duplicate rows down to its current cross episode.
//
// A cross detected on the in-progress weekly bar re-fires on every daily run,
// because that bar's observation_date advances each day and signal_date is part
// of the upsert key — so one cross can leave five rows (JUNIPER: Sep 2, 3, 7, 8,
// 9). Taken at face value those rows make a stock look newly-crossed every day,
// so it never leaves Fresh.
//
// Death crosses would give exact episode boundaries, but the scanner has never
// written one (32,758 golden crosses, 0 death crosses), so the boundary used
// here is the week: re-fires of a single cross always land inside one week,
// because once that week closes the strategy's `above` state suppresses further
// signals. The episode is therefore the run of signals sharing the week of the
// symbol's most recent signal.
//
// Returns Map<symbol, { start, firstSeen, price, stocks }> where `start` is the
// true crossing date to display and `firstSeen` is when the scanner first saw it.
async function getEpisodes(symbols) {
  const out = new Map()
  if (!symbols?.length) return out

  const rows = (await Promise.all(mkChunks(symbols).map(chunk =>
    db.from('signals')
      .select('symbol, signal_date, price, created_at, stocks(name, sector, industry)')
      .eq('strategy_name', 'ema_crossover')
      .eq('signal_type', 'golden_cross')
      .in('symbol', chunk)
      .order('signal_date', { ascending: false })
      .limit(1000)
      .then(r => r.data || [])
  ))).flat()

  // Rows arrive newest-first, so the first row seen for a symbol is its latest.
  for (const r of rows) {
    const e = out.get(r.symbol)
    if (!e) {
      out.set(r.symbol, {
        wk: weekStart(r.signal_date),
        start: r.signal_date,
        firstSeen: r.created_at,
        price: r.price,
        stocks: r.stocks,
      })
      continue
    }
    if (r.signal_date >= e.wk) {            // still the same week => same cross
      if (r.signal_date < e.start) { e.start = r.signal_date; e.price = r.price }
      if (r.created_at < e.firstSeen) e.firstSeen = r.created_at
    }
  }
  return out
}

// Symbols whose current cross EPISODE began in the latest completed run.
// Keyed on the episode's first sighting, not on any individual row, so a stock
// that crossed on Monday and merely re-fired today is not treated as new.
async function getFreshEmaSet(runStartedAt) {
  if (!runStartedAt) return new Set()
  const { data } = await db.from('signals')
    .select('symbol')
    .eq('strategy_name', 'ema_crossover')
    .eq('signal_type', 'golden_cross')
    .gte('created_at', runStartedAt)

  const candidates = [...new Set((data || []).map(r => r.symbol))]
  if (!candidates.length) return new Set()

  const episodes = await getEpisodes(candidates)
  return new Set(candidates.filter(s => {
    const e = episodes.get(s)
    return e && e.firstSeen >= runStartedAt
  }))
}

// Circuit stocks + recently-listed stocks (<90 days NSE listing)
async function getExcluded() {
  const [circuitRes, newListedRes] = await Promise.all([
    db.rpc('circuit_symbols'),
    db.rpc('recently_listed_symbols', { cutoff_days: 90 }),
  ])
  return new Set([
    ...(circuitRes.data  || []).map(r => r.symbol),
    ...(newListedRes.data || []).map(r => r.symbol),
  ])
}

// Latest weekly_close per symbol, chunked to avoid PostgREST URL limits
async function fetchCmp(symbols) {
  if (!symbols.length) return {}
  const rows = (await Promise.all(mkChunks(symbols).map(chunk =>
    db.from('weekly_indicators')
      .select('symbol, weekly_close, observation_date')
      .in('symbol', chunk)
      .order('observation_date', { ascending: false })
      .limit(500)
      .then(r => r.data || [])
  ))).flat()
  const map = {}
  for (const row of rows) {
    if (!(row.symbol in map)) map[row.symbol] = row.weekly_close
  }
  return map
}

// Parse stocks.date_of_listing format "17-AUG-2026" → "2026-08-17"
function parseListingDate(s) {
  if (!s) return null
  const d = new Date(s.replace(/-([A-Z]{3})-/, ' $1 '))
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

module.exports = {
  db,
  daysAgo, addDays, mkChunks,
  send, sendErr,
  getObsContext, getExcluded, fetchCmp, parseListingDate,
  getLatestRunStart, getFreshEmaSet, getEpisodes, weekStart,
  EMA_WINDOW_DAYS, BRK_WINDOW_DAYS,
}
