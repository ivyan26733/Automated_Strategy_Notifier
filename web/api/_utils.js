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

// The full error goes to the Vercel function log, where it can be diagnosed;
// the browser gets a generic message rather than raw database internals.
// no-store keeps a failure from being cached and replayed after recovery.
function sendErr(res, message, status = 500) {
  console.error(`[api] ${res.req?.url || ''} ${status}: ${message}`)
  res.setHeader('Cache-Control', 'no-store')
  res.status(status).json({ error: 'Could not load data. Please try again.' })
}

// supabase-js reports a failed query as `{ error }` instead of throwing, so
// destructuring only `data` turns an outage into an empty result: a blank tab
// that reads like a quiet market, or — through getExcluded — circuit and
// newly-listed stocks presented as tradeable. Every read goes through here so
// a failure reaches the handler's catch and sendErr as a real error. `label`
// names the query in the log line.
function must(res, label) {
  if (res.error) throw new Error(`${label}: ${res.error.message}`)
  return res
}

// Latest observation date in the table — the "as of" date every tab reports
// against. Current per-stock readings come from fetchLatestIndicators.
async function getObsContext() {
  const { data } = must(await db.from('weekly_indicators')
    .select('observation_date')
    .order('observation_date', { ascending: false })
    .limit(1), 'weekly_indicators latest date')

  return { obsDate: data?.[0]?.observation_date || null }
}

// Start time of the most recent COMPLETED scanner run.
// Signals whose created_at is >= this were discovered for the first time by that run.
// created_at survives upsert (upsert_signals only rewrites updated_at), so a signal
// already known from an earlier run keeps its original timestamp and drops out of
// "fresh" as soon as the next run finishes.
// Anchored to status='success' so a run in flight doesn't make Fresh grow mid-scan.
async function getLatestRunStart() {
  const { data } = must(await db.from('scanner_runs')
    .select('started_at')
    .eq('status', 'success')
    .not('finished_at', 'is', null)
    .order('started_at', { ascending: false })
    .limit(1), 'scanner_runs latest success')
  return data?.[0]?.started_at || null
}

// Monday of the ISO week containing `date`
function weekStart(date) {
  const d = new Date(date)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

// Collapse each symbol's duplicate rows down to its current OPEN cross episode.
//
// A cross detected on the in-progress weekly bar re-fires on every daily run,
// because that bar's observation_date advances each day and signal_date is part
// of the upsert key — so one cross can leave five rows (JUNIPER: Sep 2, 3, 7, 8,
// 9). Taken at face value those rows make a stock look newly-crossed every day,
// so it never leaves Fresh.
//
// The episode's START still comes from the WEEK rule: re-fires of a single
// cross land inside one week, because once that week closes the strategy's
// `above` state suppresses further signals. The week boundary is deliberately
// kept instead of collapsing every consecutive golden cross into one episode:
// rows accumulate across runs, and each run re-evaluates the developing weekly
// bar, so a cross seen one week can REPAINT away and re-appear at a later bar
// with no death cross between the two (RPEL has golden crosses on 2026-05-17
// and 2026-05-22, different ISO weeks). Collapsing those together would walk
// the displayed cross date back onto a cross that no longer exists — it moved
// the date on 159 of 933 active rows when tried.
//
// What the week rule can NOT do is tell whether the position is still open,
// and that's the part that was wrong: it reads golden crosses only, because
// the scanner had never written a death cross. It writes them now, so a symbol
// is CLOSED when a death cross lands after the episode's start, and closed
// positions are dropped here rather than presented as live holdings.
//
// That gate has to key on the death cross, not on today's EMA snapshot: a
// stock can climb back above EMA20 without emitting a golden cross at all (the
// entry gates in ema_crossover.py reject it while the state machine still
// flips `above`), so weekly_indicators shows EMA9 > EMA20 while the newest
// signal on record is still the old death cross. That is exactly how 40 closed
// positions sat on the Active list showing a cross date and a return carried
// over from an episode that had ended months earlier.
//
// Returns Map<symbol, { start, firstSeen, price, stocks }> for symbols whose
// position is still OPEN — `start` is the true crossing date to display and
// `firstSeen` is when the scanner first saw it. Closed symbols are absent.
async function getEpisodes(symbols) {
  const out = new Map()
  if (!symbols?.length) return out

  // Paged, not .limit(1000): 200-symbol chunks against a 60k-row signals table
  // silently truncate to the newest 1000 rows chunk-wide, dropping every symbol
  // whose signals are all older than that cut — the same failure that left 578
  // blank Cross Dates before, still live here (ARIHANT, SICAGEN). symbol and
  // signal_type join the sort purely to make the ordering total: .range() pages
  // a tied ordering inconsistently, which silently drops and repeats rows.
  const rows = (await Promise.all(mkChunks(symbols).map(chunk =>
    fetchAllPaged(() =>
      db.from('signals')
        .select('symbol, signal_type, signal_date, price, created_at, stocks(name, sector, industry)', { count: 'exact' })
        .eq('strategy_name', 'ema_crossover')
        .in('symbol', chunk)
        .order('symbol', { ascending: true })
        .order('signal_date', { ascending: false })
        .order('signal_type', { ascending: true })
        .order('created_at', { ascending: false }),
      'signals episodes'
    )
  ))).flat()

  const bySymbol = new Map()
  for (const r of rows) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, [])
    bySymbol.get(r.symbol).push(r)
  }

  for (const [symbol, symRows] of bySymbol) {
    symRows.sort((a, b) => a.signal_date === b.signal_date
      ? new Date(b.created_at) - new Date(a.created_at)
      : (a.signal_date > b.signal_date ? -1 : 1))          // newest first

    let e = null
    let lastDeath = null
    for (const r of symRows) {
      if (r.signal_type === 'death_cross') {
        if (r.signal_date > (lastDeath || '')) lastDeath = r.signal_date
        continue
      }
      if (!e) {
        e = { wk: weekStart(r.signal_date), start: r.signal_date, firstSeen: r.created_at, price: r.price, stocks: r.stocks }
        continue
      }
      if (r.signal_date >= e.wk) {            // still the same week => same cross
        if (r.signal_date < e.start) { e.start = r.signal_date; e.price = r.price }
        if (r.created_at < e.firstSeen) e.firstSeen = r.created_at
      }
    }

    // A death cross after the entry closed this position — no open episode.
    if (!e || (lastDeath && lastDeath > e.start)) continue
    out.set(symbol, { start: e.start, firstSeen: e.firstSeen, price: e.price, stocks: e.stocks })
  }
  return out
}

// Symbols whose current cross EPISODE began in the latest completed run.
// Keyed on the episode's first sighting, not on any individual row, so a stock
// that crossed on Monday and merely re-fired today is not treated as new.
async function getFreshEmaSet(runStartedAt) {
  if (!runStartedAt) return new Set()
  const { data } = must(await db.from('signals')
    .select('symbol')
    .eq('strategy_name', 'ema_crossover')
    .eq('signal_type', 'golden_cross')
    .gte('created_at', runStartedAt), 'signals fresh golden crosses')

  const candidates = [...new Set((data || []).map(r => r.symbol))]
  if (!candidates.length) return new Set()

  const episodes = await getEpisodes(candidates)
  return new Set(candidates.filter(s => {
    const e = episodes.get(s)
    return e && e.firstSeen >= runStartedAt
  }))
}

const PAGE = 1000
// Measured against live data: Supabase showed no meaningful degradation up to
// 66 concurrent range() requests (9.8s total vs 20s at concurrency 8 for the
// same 66-page, 65k-row scan) — the earlier low value serialized into ~9
// sequential batches for no real benefit. 40 keeps a large future table's
// worst-case concurrent connections bounded while covering today's full
// history scan in two batches.
const PAGE_CONCURRENCY = 40

// Fetch every row matching a query, paginating with .range() so a bare .limit()
// can't silently truncate — that's exactly what produced the 578 blank Cross
// Dates earlier in this project. `buildQuery` receives the query builder
// (already filtered/ordered) and must NOT call .range() or .limit() itself.
// Its ORDER BY must be TOTAL (end on a unique key): with no order, or ties
// left in it, pages fetched concurrently can overlap and skip rows without
// any error (see fetchEmaHistory).
//
// Pages fetch in bounded-concurrency batches, not one at a time: a 40,000-row
// scan is ~40 pages, and fetched serially that timed out a 2-minute request
// outright. Concurrency requires knowing the total up front, so the caller's
// .select() must request `{ count: 'exact' }` — page 1 then carries the count,
// the remaining pages are computed and fetched PAGE_CONCURRENCY at a time. A
// caller that doesn't request count falls back to the original sequential
// loop, which stays correct, just slow.
async function fetchAllPaged(buildQuery, label = 'paged query') {
  const first = must(await buildQuery().range(0, PAGE - 1), label)
  const out = [...(first.data || [])]

  const total = first.count
  if (total == null) {
    // No count requested — fall back to sequential paging.
    let from = PAGE
    while (first.data && first.data.length === PAGE) {
      const { data } = must(await buildQuery().range(from, from + PAGE - 1), label)
      out.push(...(data || []))
      if (!data || data.length < PAGE) break
      from += PAGE
    }
    return out
  }

  const totalPages = Math.ceil(total / PAGE)
  const remaining  = Array.from({ length: Math.max(0, totalPages - 1) }, (_, i) => i + 1)

  for (let b = 0; b < remaining.length; b += PAGE_CONCURRENCY) {
    const batch = remaining.slice(b, b + PAGE_CONCURRENCY)
    const results = await Promise.all(batch.map(p =>
      buildQuery().range(p * PAGE, p * PAGE + PAGE - 1).then(r => must(r, label).data || [])
    ))
    for (const chunk of results) out.push(...chunk)
  }
  return out
}

// Circuit stocks + recently-listed stocks (<90 days NSE listing)
async function getExcluded() {
  const [circuitRes, newListedRes] = await Promise.all([
    db.rpc('circuit_symbols'),
    db.rpc('recently_listed_symbols', { cutoff_days: 90 }),
  ])
  return new Set([
    ...(must(circuitRes, 'rpc circuit_symbols').data || []).map(r => r.symbol),
    ...(must(newListedRes, 'rpc recently_listed_symbols').data || []).map(r => r.symbol),
  ])
}

// weekly_indicators holds one row per (symbol, observation_date) and gains a
// full universe of rows on every scan, so "rows where EMA9 > EMA20" is not
// "stocks where EMA9 > EMA20": it matches every day a stock was above,
// including days before it crossed back down, and it runs far past the 1000
// rows PostgREST returns per request whatever .limit() asks for. That cap
// silently cut the Active tab to 1000 of 1178 stocks and the Returns active
// set to 919.
//
// So a stock's current reading is always its LATEST row, taken from a window
// ending at obsDate, fully paged — and callers filter on EMA values only after
// that reduction. Filtering in the query would let an older positive row stand
// in for a stock that has since crossed down. The window keeps the scan to a
// few days of rows instead of the whole growing history; a symbol with no
// observation inside it (not scanned for over a week) has no current reading.
// Ordered on the primary key so .range() pages are stable.
const LATEST_WINDOW_DAYS = 7

async function fetchLatestIndicators(obsDate, symbols = null) {
  if (symbols) symbols = [...new Set(symbols)]
  if (!obsDate || (symbols && !symbols.length)) return new Map()

  const since = daysAgo(obsDate, LATEST_WINDOW_DAYS)
  const query = subset => () => {
    const q = db.from('weekly_indicators')
      .select('symbol, observation_date, ema9, ema20, ema_difference, ema_difference_pct, weekly_close', { count: 'exact' })
      .gte('observation_date', since)
      .order('symbol', { ascending: true })
      .order('observation_date', { ascending: false })
    return subset ? q.in('symbol', subset) : q
  }

  // Same wide-list rule as fetchEmaHistory: past a few hundred symbols, scan
  // the window unfiltered rather than fire many large .in() lists at once.
  const wide = !symbols || symbols.length > EMA_HISTORY_IN_LIMIT
  const rows = wide
    ? await fetchAllPaged(query(null), 'weekly_indicators latest')
    : (await Promise.all(mkChunks(symbols).map(chunk =>
        fetchAllPaged(query(chunk), 'weekly_indicators latest')))).flat()

  const wanted = symbols ? new Set(symbols) : null
  const latest = new Map()
  for (const r of rows) {
    if (wanted && !wanted.has(r.symbol)) continue
    const cur = latest.get(r.symbol)
    if (!cur || r.observation_date > cur.observation_date) latest.set(r.symbol, r)
  }
  return latest
}

// Latest weekly_close per symbol as of obsDate (looked up when not passed).
async function fetchCmp(symbols, obsDate) {
  if (!symbols.length) return {}
  if (!obsDate) ({ obsDate } = await getObsContext())
  const map = {}
  for (const [symbol, r] of await fetchLatestIndicators(obsDate, symbols)) map[symbol] = r.weekly_close
  return map
}

// Stock display name per symbol, chunked. A joined `stocks(name)` select is
// fine for a page of 50 rows, but on a full-table scan the join re-fetches the
// same name on every row of a repeated symbol — measured 2x slower over 65k
// rows than fetching signals bare and looking up names for just the distinct
// symbols after (see history.js's full-scan path).
async function fetchNames(symbols) {
  if (!symbols.length) return {}
  const rows = (await Promise.all(mkChunks(symbols).map(chunk =>
    db.from('stocks').select('symbol, name').in('symbol', chunk).then(r => must(r, 'stocks names').data || [])
  ))).flat()
  const map = {}
  for (const row of rows) map[row.symbol] = row.name
  return map
}

function emaRowKey(r) { return `${r.symbol}|${r.signal_date}|${r.signal_type}` }

// Build a lookup from a single golden_cross/death_cross ROW's identity
// (symbol|signal_date|signal_type) to the real trade EPISODE it belongs to:
// { entryDate, entryPrice, exitDate, exitPrice } — exitDate/exitPrice null while
// still open. Both the entry row and the exit row of one episode map to the SAME
// object, and so does every re-fired duplicate of either.
//
// A cross on the developing weekly bar re-fires on every daily run (signal_date
// advances with the bar's observation_date), so one real cross can leave several
// rows. The collapse rule is general, not week-bounded: a row is a re-fire only
// when the immediately preceding KEPT row for that symbol is the same type — this
// stays correct even when a stock genuinely crosses, reverses, and crosses again
// weeks apart (only an opposite-type signal in between breaks the run).
//
// `rows` must be EVERY golden_cross/death_cross row for the symbols involved —
// a date-windowed subset would treat a mid-history entry as if it had no prior
// episode. Order within `rows` does not matter; this sorts per symbol itself.
function buildEmaEpisodeIndex(rows) {
  const bySymbol = new Map()
  for (const r of rows) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, [])
    bySymbol.get(r.symbol).push(r)
  }

  const index = new Map()
  for (const [, symRows] of bySymbol) {
    symRows.sort((a, b) => a.signal_date === b.signal_date
      ? new Date(a.created_at) - new Date(b.created_at)
      : (a.signal_date < b.signal_date ? -1 : 1))

    let episode = null
    let lastType = null
    for (const r of symRows) {
      if (r.signal_type === lastType) {          // re-fire of the current episode
        if (episode) index.set(emaRowKey(r), episode)
        continue
      }
      lastType = r.signal_type
      if (r.signal_type === 'golden_cross') {
        episode = { entryDate: r.signal_date, entryPrice: r.price, exitDate: null, exitPrice: null }
      } else if (episode) {
        episode.exitDate = r.signal_date
        episode.exitPrice = r.price
      } else {
        continue   // death_cross with no prior entry in the fetched range
      }
      index.set(emaRowKey(r), episode)
    }
  }
  return index
}

// Above this many symbols, an .in() filter stops being worth applying — see
// below.
const EMA_HISTORY_IN_LIMIT = 500

// Every golden_cross/death_cross row for a set of symbols, full history (no date
// window) — the complete input buildEmaEpisodeIndex needs. Bounded to `symbols`
// with .in() so a page of 50 signals only pays for the ~50 symbols it touches,
// not the whole table.
//
// The full-scan filtered path in history.js can pass most of the universe as
// `symbols` (a Return% filter with nothing else narrowing it), and that's the
// case this guards: a single request with a 2,000-symbol .in() clause (~17KB of
// query string) succeeds on its own, but fetchAllPaged fires many of those
// concurrently, and the combined weight of that made "fetch failed" errors
// under this specific combination — no failure with a small .in() list, none
// with a large *unfiltered* fetch, only large-list-plus-high-concurrency
// together. Reproduced consistently at ~2,000 symbols; not worth chasing the
// exact byte threshold when skipping the filter above a safe symbol count
// costs almost nothing (already fetching most of the table) and sidesteps the
// failure mode entirely — confirmed the plain unfiltered fetch reliably
// completes in ~4-7s regardless of table size.
async function fetchEmaHistory(symbols) {
  if (!symbols?.length) return []
  const wide = symbols.length > EMA_HISTORY_IN_LIMIT
  const symSet = wide ? new Set(symbols) : null

  // Ordered on the row's unique key (strategy is fixed here). This query used to
  // have no ORDER BY at all, and unordered .range() pages carry no guarantee of
  // lining up: fetched concurrently, one 62k-row scan came back with ~10,600
  // rows duplicated and as many silently missing, which split episodes apart
  // and made History's Return% totals change from one request to the next.
  const rows = await fetchAllPaged(() => {
    let q = db.from('signals')
      .select('symbol, signal_type, signal_date, price, created_at', { count: 'exact' })
      .eq('strategy_name', 'ema_crossover')
      .order('symbol', { ascending: true })
      .order('signal_date', { ascending: true })
      .order('signal_type', { ascending: true })
    return wide ? q : q.in('symbol', symbols)
  }, 'signals ema history')

  return wide ? rows.filter(r => symSet.has(r.symbol)) : rows
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
  send, sendErr, must,
  getObsContext, getExcluded, fetchCmp, fetchLatestIndicators, fetchNames, parseListingDate, fetchAllPaged,
  buildEmaEpisodeIndex, fetchEmaHistory, emaRowKey,
  getLatestRunStart, getFreshEmaSet, getEpisodes, weekStart,
  EMA_WINDOW_DAYS, BRK_WINDOW_DAYS,
}
