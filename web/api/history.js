const {
  db, must, send, sendErr,
  getExcluded, getObsContext, getLatestRunStart, fetchLatestIndicators, fetchAllPaged,
  buildEmaEpisodeIndex, emaRowKey,
} = require('./_utils')

// Signal History is sorted, filtered and paginated over EVERY listable signal —
// not just the rows on screen. Return%, Status, Exit Date and Exit/CMP aren't
// stored columns: they come from matching each golden cross to its real trade
// episode (buildEmaEpisodeIndex) and to today's price. So the database can't
// ORDER BY or filter on them, and the only way to sort "Return% high → low"
// across 20+ years of signals is to build the whole list once and work on that.
//
// The built list is kept in memory per warm function instance and reused until
// a newer successful scanner run exists (or MAX_AGE_MS passes), so a header
// click or page change costs a sort/slice in memory, not a database scan.

const PAGE_SIZES        = [25, 50, 100]
const DEFAULT_PAGE_SIZE = 50
const EXPORT_PAGE_SIZE  = 5000
const ROW_CAP           = 1000        // PostgREST's per-request row limit
const SYMBOL_GROUP      = 25          // ~30 signals per stock → one request per group
const GROUP_CONCURRENCY = 12
const CHECK_EVERY_MS    = 60 * 1000   // how often to look for a newer scanner run
const MAX_AGE_MS        = 30 * 60 * 1000

const SIGNAL_COLS = 'signal_date, strategy_name, signal_type, symbol, price, ema_difference_pct, breakout_pct, sector, created_at'

// Sortable columns and how they compare. Anything else falls back to date.
const SORTS = {
  signal_date: 'date', exit_date: 'date',
  symbol: 'text', name: 'text', strategy_name: 'text', signal_type: 'text', status: 'text', sector: 'text',
  price: 'num', cmp: 'num', return_pct: 'num', ema_difference_pct: 'num', breakout_pct: 'num',
}
const TEXT_ASC_DEFAULT = new Set(['symbol', 'name', 'strategy_name', 'signal_type', 'status', 'sector'])

// Return% for an ema_crossover row is matched to its real trade episode, not
// computed against today's price: closed shows the actual entry->exit return
// with Exit/CMP set to the exit price; still-open shows the unrealized return
// marked to today. breakout_6m has no exit-signal counterpart, so it is marked
// to today. Price is the episode's entry price, so Price / Exit-CMP / Return%
// on one row always reconcile even when the row is a re-fire of that entry.
function buildRows(clean, cmpMap, names, episodeIndex) {
  return clean.map(r => {
    const ep = r.strategy_name === 'ema_crossover' ? episodeIndex.get(emaRowKey(r)) : null

    let price = r.price, cmp, return_pct, status = null, exit_date = null
    if (ep) {
      price = ep.entryPrice
      if (ep.exitDate != null) {
        cmp = ep.exitPrice
        return_pct = ep.entryPrice ? (ep.exitPrice / ep.entryPrice - 1) * 100 : null
        status = 'closed'
        exit_date = ep.exitDate
      } else {
        cmp = cmpMap[r.symbol] ?? null
        return_pct = (cmp != null && ep.entryPrice) ? (cmp / ep.entryPrice - 1) * 100 : null
        status = 'open'
      }
    } else {
      cmp = cmpMap[r.symbol] ?? null
      return_pct = (cmp != null && r.price) ? (cmp / r.price - 1) * 100 : null
    }

    return {
      symbol:             r.symbol,
      name:               names[r.symbol] || '',
      signal_date:        r.signal_date,
      strategy_name:      r.strategy_name,
      signal_type:        r.signal_type,
      price, cmp, return_pct, status, exit_date,
      ema_difference_pct: r.ema_difference_pct,
      breakout_pct:       r.breakout_pct,
      sector:             r.sector,
    }
  })
}

// A cross re-fires on every daily run while its weekly bar is still developing
// (see buildEmaEpisodeIndex), leaving several rows for the SAME real entry or
// exit. Only the row whose own signal_date matches the episode's actual
// entry/exit date is the real event; the rest are echoes and aren't listed.
// breakout_6m rows have no episode and pass through unchanged.
function isEpisodeAnchor(r, episodeIndex) {
  if (r.strategy_name !== 'ema_crossover') return true
  const ep = episodeIndex.get(emaRowKey(r))
  if (!ep) return true   // no episode on record (e.g. orphan leading death_cross)
  const boundary = r.signal_type === 'golden_cross' ? ep.entryDate : ep.exitDate
  return boundary === r.signal_date
}

// Every signals row, fetched a group of stocks at a time. Deep .range() offsets
// over the whole table cost ~1s each on this database (27s for a full read);
// an .in() on a few symbols uses the symbol index from offset 0 (~6s in total).
// A group holding more than ROW_CAP rows keeps paging within that group.
async function fetchAllSignals(symbols) {
  const groups = []
  for (let i = 0; i < symbols.length; i += SYMBOL_GROUP) groups.push(symbols.slice(i, i + SYMBOL_GROUP))

  const out = []
  let next = 0
  await Promise.all(Array.from({ length: GROUP_CONCURRENCY }, async () => {
    while (next < groups.length) {
      const group = groups[next++]
      for (let from = 0; ; from += ROW_CAP) {
        const { data } = must(await db.from('signals')
          .select(SIGNAL_COLS)
          .in('symbol', group)
          .order('symbol').order('signal_date').order('strategy_name').order('signal_type')   // total order: stable pages
          .range(from, from + ROW_CAP - 1), 'signals history')
        out.push(...(data || []))
        if (!data || data.length < ROW_CAP) break
      }
    }
  }))
  return out
}

async function buildDataset(runKey) {
  const [stocks, excluded, { obsDate }] = await Promise.all([
    fetchAllPaged(() => db.from('stocks').select('symbol, name', { count: 'exact' }).order('symbol'), 'stocks names'),
    getExcluded(),
    getObsContext(),
  ])
  // signals.symbol references stocks, so grouping by the stock list reaches every row.
  const [signals, latest] = await Promise.all([
    fetchAllSignals(stocks.map(s => s.symbol)),
    fetchLatestIndicators(obsDate),
  ])

  const names = {}
  for (const s of stocks) names[s.symbol] = s.name
  const cmpMap = {}
  for (const [symbol, r] of latest) cmpMap[symbol] = r.weekly_close

  // The episode index needs every golden AND death cross; the list itself shows
  // entries only — a death cross appears as Status = Closed on the cross it ended.
  const episodeIndex = buildEmaEpisodeIndex(signals.filter(r => r.strategy_name === 'ema_crossover'))
  const listable = signals.filter(r =>
    r.signal_type !== 'death_cross' && !excluded.has(r.symbol) && isEpisodeAnchor(r, episodeIndex))

  const now = Date.now()
  return { runKey, obsDate, builtAt: now, checkedAt: now, rows: buildRows(listable, cmpMap, names, episodeIndex), sorted: new Map() }
}

let cache = null
let building = null   // { runKey, promise } — concurrent requests share one build

async function getDataset() {
  const now = Date.now()
  const fresh = cache && now - cache.builtAt < MAX_AGE_MS
  if (fresh && now - cache.checkedAt < CHECK_EVERY_MS) return cache

  let runKey
  try {
    runKey = await getLatestRunStart()
  } catch (e) {
    if (cache) return cache   // a blip on this small check shouldn't fail a request a warm cache can answer
    throw e
  }
  if (fresh && cache.runKey === runKey) { cache.checkedAt = now; return cache }

  if (!building || building.runKey !== runKey) {
    const promise = buildDataset(runKey)
      .then(ds => { cache = ds; return ds })
      .finally(() => { if (building?.promise === promise) building = null })
    building = { runKey, promise }
  }
  return building.promise
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

// Blanks sort last in both directions; ties fall back to newest date, then
// symbol, strategy and type, so every page boundary is stable.
function sortedRows(ds, sort, dir) {
  const key = `${sort}:${dir}`
  if (ds.sorted.has(key)) return ds.sorted.get(key)

  const kind = SORTS[sort]
  const sign = dir === 'asc' ? 1 : -1
  const blank = v => v == null || v === ''
  const cmpVal = kind === 'num'  ? (a, b) => a - b
               : kind === 'date' ? (a, b) => (a < b ? -1 : a > b ? 1 : 0)   // ISO dates order as text
               : collator.compare

  const out = [...ds.rows].sort((x, y) => {
    const a = x[sort], b = y[sort]
    if (blank(a) !== blank(b)) return blank(a) ? 1 : -1
    if (!blank(a)) { const c = cmpVal(a, b); if (c) return sign * c }
    if (x.signal_date !== y.signal_date) return x.signal_date < y.signal_date ? 1 : -1
    if (x.symbol !== y.symbol) return x.symbol < y.symbol ? -1 : 1
    if (x.strategy_name !== y.strategy_name) return x.strategy_name < y.strategy_name ? -1 : 1
    return x.signal_type < y.signal_type ? -1 : x.signal_type > y.signal_type ? 1 : 0
  })
  ds.sorted.set(key, out)
  return out
}

module.exports = async (req, res) => {
  try {
    const q = req.query
    // Strip "undefined" / "null" strings that URLSearchParams can inject
    const val = v => (typeof v === 'string' && v.trim() && v !== 'undefined' && v !== 'null') ? v.trim() : undefined

    const sort     = SORTS[val(q.sort)] ? val(q.sort) : 'signal_date'
    const dirParam = val(q.dir)
    const dir      = dirParam === 'asc' || dirParam === 'desc' ? dirParam : (TEXT_ASC_DEFAULT.has(sort) ? 'asc' : 'desc')
    // The Excel export walks every page in big chunks; one response holding the
    // whole list would overrun Vercel's response-size limit.
    const pageSize = val(q.export) === '1' ? EXPORT_PAGE_SIZE
      : PAGE_SIZES.includes(parseInt(q.pageSize, 10)) ? parseInt(q.pageSize, 10) : DEFAULT_PAGE_SIZE

    const strategy  = val(q.strategy)
    const symbol    = val(q.symbol)?.toUpperCase()
    const sector    = val(q.sector)?.toLowerCase()
    const from      = val(q.from)
    const to        = val(q.to)
    const minRet    = val(q.minReturn) != null ? parseFloat(val(q.minReturn)) : NaN
    const minReturn = Number.isFinite(minRet) ? minRet : null
    // Watchlist membership lives in the browser's localStorage, so it's sent along.
    const watchlist = val(q.watchlistOnly) === '1' ? new Set((val(q.watchlist) || '').split(',').filter(Boolean)) : null

    const ds = await getDataset()
    const matches = r =>
      (!strategy  || r.strategy_name === strategy) &&
      (!symbol    || r.symbol.includes(symbol)) &&
      (!sector    || (r.sector || '').toLowerCase().includes(sector)) &&
      (!from      || r.signal_date >= from) &&
      (!to        || r.signal_date <= to) &&
      (minReturn == null || (r.return_pct != null && r.return_pct >= minReturn)) &&
      (!watchlist || watchlist.has(r.symbol))

    const filtered = sortedRows(ds, sort, dir).filter(matches)   // filter keeps the sort order
    const total    = filtered.length
    const pages    = Math.max(1, Math.ceil(total / pageSize))
    const page     = Math.min(pages, Math.max(1, parseInt(q.page, 10) || 1))
    const offset   = (page - 1) * pageSize

    // Each cold instance builds its own copy; letting the CDN answer repeats of
    // the same URL keeps a burst of visitors from starting many builds at once.
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
    send(res, {
      total, page, pageSize, pages, sort, dir,
      obsDate: ds.obsDate,
      hasMore: page < pages,
      rows:    filtered.slice(offset, offset + pageSize),
    })
  } catch (e) {
    sendErr(res, e.message)
  }
}
