/* NSE Stock Screener — frontend application */

// ── Config ────────────────────────────────────────────────────────
const SUPABASE_URL  = 'https://sewhmabsawdocpmazrib.supabase.co'
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNld2htYWJzYXdkb2NwbWF6cmliIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgxOTU0MTQsImV4cCI6MjEwMzc3MTQxNH0.Tv7165bS8WI6ttv82P9Wq8vhtGXIgRMYiclzAzcosHY'
const HISTORY_PAGE  = 50
const EMA_WINDOW_DAYS = 28   // "fresh" crossover = within last 4 weeks
const BRK_WINDOW_DAYS = 30   // "fresh" breakout  = within last 30 days

// ── Init Supabase ─────────────────────────────────────────────────
const { createClient } = supabase
const db = createClient(SUPABASE_URL, SUPABASE_ANON)

// ── State ─────────────────────────────────────────────────────────
let historyOffset  = 0
let historyTotal   = 0
let historyFilters = {}
let historyAllRows = []   // accumulates all fetched history rows across pages
let sortState      = {}
let loaded         = {}
let globalFilters  = { returnPct: null, watchlistOnly: false }

// ── Watchlist (localStorage) ──────────────────────────────────────
function getWatchlist() {
  try { return new Set(JSON.parse(localStorage.getItem('nse_watchlist') || '[]')) } catch { return new Set() }
}
function saveWatchlist(s) {
  try { localStorage.setItem('nse_watchlist', JSON.stringify([...s])) } catch {}
}
function updateWlCount() {
  const n = getWatchlist().size
  const badge = el('wl-count')
  if (badge) badge.textContent = n > 0 ? n : ''
}
function starCell(sym) {
  const on = getWatchlist().has(sym)
  return `<button class="star-btn${on?' starred':''}" data-sym="${esc(sym)}" title="${on?'Remove from watchlist':'Add to watchlist'}">${on?'★':'☆'}</button>`
}

// ── Formatters ────────────────────────────────────────────────────
const INR = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const NUM = new Intl.NumberFormat('en-IN')

const fmt = {
  price: v  => v == null ? '—' : '₹' + INR.format(v),
  pct:   v  => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%',
  num:   v  => v == null ? '—' : NUM.format(v),
  date:  v  => { if (!v) return '—'; return new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) },
  days:  d  => { if (!d) return '—'; const n = Math.floor((Date.now() - new Date(d)) / 86400000); return n === 0 ? 'Today' : n === 1 ? '1d ago' : `${n}d ago` },
  strat: s  => s === 'ema_crossover' ? '<span class="badge badge-green">EMA Cross</span>' : '<span class="badge badge-amber">6M Breakout</span>',
  type:  t  => t === 'golden_cross' ? '<span class="badge badge-green">Golden X</span>' : t === 'death_cross' ? '<span class="badge badge-red">Death X</span>' : `<span class="badge badge-blue">${esc(t)}</span>`,
}

// ── Helpers ───────────────────────────────────────────────────────
function esc(s) { if (!s) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) }
function el(id) { return document.getElementById(id) }
function loading(c) { c.innerHTML = '<div class="state-box"><div class="spinner"></div><span class="state-title">Loading…</span></div>' }
function empty(c, msg, sub = '') { c.innerHTML = `<div class="state-box"><span class="state-title">${esc(msg)}</span>${sub ? `<span class="state-sub">${esc(sub)}</span>` : ''}</div>` }

function daysAgo(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

// ── Shared: latest obs date + active symbol set ───────────────────
// Cached per page load so multiple tabs don't re-fetch
let _obsCache = null
async function getObsContext() {
  if (_obsCache) return _obsCache
  const { data } = await db.from('weekly_indicators')
    .select('observation_date').order('observation_date', { ascending: false }).limit(1)
  const obsDate = data?.[0]?.observation_date
  if (!obsDate) { _obsCache = { obsDate: null, activeSet: new Set() }; return _obsCache }
  // Use a 7-day window so all stocks are included regardless of exact obs_date
  // (different stocks can have different observation dates within the same developing week)
  const { data: active } = await db.from('weekly_indicators')
    .select('symbol')
    .gte('observation_date', daysAgo(obsDate, 7))
    .gt('ema_difference', 0)
  _obsCache = { obsDate, activeSet: new Set((active || []).map(r => r.symbol)) }
  return _obsCache
}

// ── CMP helper: latest weekly_close per symbol (obs_date-agnostic) ─
async function fetchCmp(symbols) {
  if (!symbols.length) return {}
  const { data: inds } = await db.from('weekly_indicators')
    .select('symbol, weekly_close, observation_date')
    .in('symbol', symbols)
    .order('observation_date', { ascending: false })
  const map = {}
  for (const ind of (inds || [])) {
    if (!(ind.symbol in map)) map[ind.symbol] = ind.weekly_close  // first = latest
  }
  return map
}

// ── Summary / Header ──────────────────────────────────────────────
async function loadSummary() {
  const [runRes, uniRes, sigRes] = await Promise.all([
    db.from('scanner_runs').select('started_at,finished_at,status').order('created_at', { ascending: false }).limit(1),
    db.from('stocks').select('*', { count: 'exact', head: true }),
    db.from('signals').select('*', { count: 'exact', head: true }),
  ])

  const run      = runRes.data?.[0]
  const uniCount = uniRes.count ?? '—'
  const sigCount = sigRes.count ?? '—'

  // Get obs context (latest obs date + active set)
  const { obsDate, activeSet } = await getObsContext()

  let freshEmaCount = 0
  let freshBrkCount = 0

  if (obsDate) {
    const emaCutoff = daysAgo(obsDate, EMA_WINDOW_DAYS)
    const brkCutoff = daysAgo(obsDate, BRK_WINDOW_DAYS)

    // Fetch symbols of golden-cross signals within the window (deduplicated)
    const [emaRes, brkRes] = await Promise.all([
      db.from('signals').select('symbol')
        .eq('strategy_name', 'ema_crossover').eq('signal_type', 'golden_cross')
        .gte('signal_date', emaCutoff).lte('signal_date', obsDate),
      db.from('signals').select('*', { count: 'exact', head: true })
        .eq('strategy_name', 'breakout_6m')
        .gte('signal_date', brkCutoff).lte('signal_date', obsDate),
    ])

    // Fresh EMA = crossed in window AND still above (EMA9 > EMA20 today)
    const crossedSymbols = new Set((emaRes.data || []).map(r => r.symbol))
    freshEmaCount = [...crossedSymbols].filter(s => activeSet.has(s)).length
    freshBrkCount = brkRes.count || 0
  }

  // Header
  if (run) {
    el('run-dot').className = 'dot ' + (run.status === 'success' ? 'ok' : run.status === 'running' ? 'run' : 'err')
    el('run-text').textContent = run.status === 'success' ? 'Scanner OK' : run.status === 'running' ? 'Running…' : 'Last run failed'
    el('last-scan').textContent = run.finished_at
      ? 'Last scan: ' + fmt.date(run.finished_at) + ' · ' + fmt.days(run.finished_at)
      : 'Scan in progress'
  }

  // KPI chips
  const obsSub = obsDate ? 'As of ' + fmt.date(obsDate) : 'No scanner data yet'
  el('kpi-universe').innerHTML   = `<div class="kpi-label">Universe</div><div class="kpi-value">${fmt.num(uniCount)}</div><div class="kpi-sub">NSE EQ stocks</div>`
  el('kpi-crossovers').innerHTML = `<div class="kpi-label">EMA Crossovers</div><div class="kpi-value">${fmt.num(freshEmaCount)}</div><div class="kpi-sub">Fresh &amp; active · last 4 weeks</div>`
  el('kpi-breakouts').innerHTML  = `<div class="kpi-label">6M Breakouts</div><div class="kpi-value">${fmt.num(freshBrkCount)}</div><div class="kpi-sub">Last 30 days</div>`
  el('kpi-signals').innerHTML    = `<div class="kpi-label">Total Signals</div><div class="kpi-value">${fmt.num(sigCount)}</div><div class="kpi-sub">All time · ${obsSub}</div>`
}

// ── Tab 1: Fresh EMA Crossovers ───────────────────────────────────
// Rule: golden cross within last 28 days AND EMA9 still > EMA20 today
async function loadCrossoverTab() {
  const container = el('body-crossovers')
  loading(container)

  const { obsDate, activeSet } = await getObsContext()
  if (!obsDate) { empty(container, 'No indicator data yet.', 'Run the scanner first.'); return }

  const cutoff = daysAgo(obsDate, EMA_WINDOW_DAYS)
  el('meta-crossovers').textContent = `Golden crosses in last 4 weeks still active · ${fmt.date(cutoff)} → ${fmt.date(obsDate)}`

  const { data, error } = await db.from('signals')
    .select('symbol, signal_date, price, weekly_close, ema9, ema20, ema_difference_pct, sector, industry, stocks(name)')
    .eq('strategy_name', 'ema_crossover')
    .eq('signal_type', 'golden_cross')
    .gte('signal_date', cutoff)
    .lte('signal_date', obsDate)
    .order('signal_date', { ascending: false })

  if (error || !data?.length) {
    empty(container, 'No EMA crossovers in the last 4 weeks.', 'The scanner will populate this after daily runs.')
    return
  }

  // Only keep symbols where EMA9 is still above EMA20 right now
  // Deduplicate: keep earliest signal per symbol (first cross in window)
  const seen = new Set()
  const filtered = []
  for (const row of [...data].sort((a, b) => a.signal_date.localeCompare(b.signal_date))) {
    if (seen.has(row.symbol)) continue
    seen.add(row.symbol)
    if (activeSet.has(row.symbol)) filtered.push(row)
  }

  if (!filtered.length) {
    empty(container, 'No recent crossovers are still active.', 'All crosses in the last 4 weeks have since reversed.')
    return
  }

  // Sort by signal_date descending for display
  filtered.sort((a, b) => b.signal_date.localeCompare(a.signal_date))

  // Fetch CMP for each crossover symbol
  const crossSyms = [...new Set(filtered.map(r => r.symbol))]
  const crossCmpMap = crossSyms.length ? await fetchCmp(crossSyms) : {}

  const cols = [
    { label: '★',            key: '_star',             cls: 'star-col',    fmt: v => starCell(v) },
    { label: 'Symbol',       key: 'symbol',            cls: 'sym',         fmt: v => esc(v) },
    { label: 'Name',         key: '_name',             cls: 'name',        fmt: v => esc(v) },
    { label: 'Cross Date',   key: 'signal_date',       cls: 'mono',        fmt: v => fmt.date(v) },
    { label: 'Held',         key: 'signal_date',       cls: 'mono',        fmt: v => fmt.days(v) },
    { label: 'Signal Price', key: 'price',             cls: 'num r',       fmt: v => fmt.price(v) },
    { label: 'CMP',          key: '_cmp',              cls: 'num r',       fmt: v => fmt.price(v) },
    { label: 'Return%',      key: '_return_pct',       cls: 'pct r',       fmt: v => v == null ? '—' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` },
    { label: 'EMA9',         key: 'ema9',              cls: 'num r',       fmt: v => fmt.price(v) },
    { label: 'EMA20',        key: 'ema20',             cls: 'num r',       fmt: v => fmt.price(v) },
    { label: 'EMA Diff%',    key: 'ema_difference_pct',cls: 'pct r',      fmt: v => `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` },
    { label: 'Sector',       key: 'sector',            cls: 'muted',       fmt: v => esc(v) },
  ]
  const crossRows = filtered.map(r => {
    const cmp = crossCmpMap[r.symbol] ?? null
    const ret = (cmp != null && r.price) ? (cmp / r.price - 1) * 100 : null
    return { ...r, _star: r.symbol, _name: r.stocks?.name || '', _cmp: cmp, _return_pct: ret }
  })
  renderTable(container, 'crossovers', cols, crossRows)
}

// ── Tab 2: 6-Month Breakouts ──────────────────────────────────────
// Rule: breakout signal within last 30 days (rolling window, not latest date)
async function loadBreakoutTab() {
  const container = el('body-breakouts')
  loading(container)

  const { obsDate } = await getObsContext()
  const cutoff = obsDate ? daysAgo(obsDate, BRK_WINDOW_DAYS) : daysAgo(new Date().toISOString().slice(0, 10), BRK_WINDOW_DAYS)
  el('meta-breakouts').textContent = `Breakouts in last 30 days · from ${fmt.date(cutoff)}`

  const { data, error } = await db.from('signals')
    .select('symbol, signal_date, price, breakout_reference, breakout_pct, sector, industry, stocks(name)')
    .eq('strategy_name', 'breakout_6m')
    .gte('signal_date', cutoff)
    .order('breakout_pct', { ascending: false })

  if (error || !data?.length) {
    empty(container, 'No 6-month breakouts in the last 30 days.', 'The scanner will populate this after daily runs.')
    return
  }

  // Fetch CMP for each breakout symbol
  const { obsDate: brkObs } = await getObsContext()
  const brkSyms = [...new Set(data.map(r => r.symbol))]
  const brkCmpMap = brkSyms.length ? await fetchCmp(brkSyms) : {}

  const cols = [
    { label: '★',            key: '_star',             cls: 'star-col',    fmt: v => starCell(v) },
    { label: 'Symbol',       key: 'symbol',            cls: 'sym',         fmt: v => esc(v) },
    { label: 'Name',         key: '_name',             cls: 'name',        fmt: v => esc(v) },
    { label: 'Breakout Date',key: 'signal_date',       cls: 'mono',        fmt: v => fmt.date(v) },
    { label: 'Signal Price', key: 'price',             cls: 'num r',       fmt: v => fmt.price(v) },
    { label: 'CMP',          key: '_cmp',              cls: 'num r',       fmt: v => fmt.price(v) },
    { label: 'Return%',      key: '_return_pct',       cls: 'pct r',       fmt: v => v == null ? '—' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` },
    { label: '6M High Ref',  key: 'breakout_reference',cls: 'num r',      fmt: v => fmt.price(v) },
    { label: 'Breakout%',    key: 'breakout_pct',      cls: 'pct r',       fmt: v => `<span class="pos">${fmt.pct(v)}</span>` },
    { label: 'Sector',       key: 'sector',            cls: 'muted',       fmt: v => esc(v) },
    { label: 'Industry',     key: 'industry',          cls: 'muted',       fmt: v => esc(v) },
  ]
  const brkRows = data.map(r => {
    const cmp = brkCmpMap[r.symbol] ?? null
    const ret = (cmp != null && r.price) ? (cmp / r.price - 1) * 100 : null
    return { ...r, _star: r.symbol, _name: r.stocks?.name || '', _cmp: cmp, _return_pct: ret }
  })
  renderTable(container, 'breakouts', cols, brkRows)
}

// ── Tab 3: Active EMA ─────────────────────────────────────────────
// All stocks where EMA9 > EMA20 right now, with their golden-cross entry date
async function loadActiveTab() {
  const container = el('body-active')
  const meta = el('meta-active')
  loading(container)

  const { obsDate, activeSet } = await getObsContext()
  if (!obsDate) { empty(container, 'No weekly indicators yet.'); return }
  meta.textContent = `${activeSet.size} stocks above EMA9 > EMA20 · as of ${fmt.date(obsDate)}`

  const { data: rawInds } = await db.from('weekly_indicators')
    .select('symbol, ema9, ema20, ema_difference_pct, weekly_close, observation_date')
    .gte('observation_date', daysAgo(obsDate, 7))
    .gt('ema_difference', 0)
    .order('observation_date', { ascending: false })
    .limit(2000)
  // Deduplicate: keep latest obs_date per symbol, then sort by ema_difference_pct
  const _seenActive = new Set()
  const inds = []
  for (const row of (rawInds || [])) {
    if (!_seenActive.has(row.symbol)) { _seenActive.add(row.symbol); inds.push(row) }
  }
  inds.sort((a, b) => (b.ema_difference_pct ?? 0) - (a.ema_difference_pct ?? 0))

  if (!inds.length) { empty(container, 'No stocks currently above EMA9 > EMA20.'); return }

  // Get latest golden-cross signal per active symbol (last 2 years)
  const cutoff = daysAgo(obsDate, 730)
  const { data: sigs } = await db.from('signals')
    .select('symbol, signal_date, price, stocks(name, sector, industry)')
    .eq('strategy_name', 'ema_crossover').eq('signal_type', 'golden_cross')
    .gte('signal_date', cutoff)
    .order('signal_date', { ascending: false })

  const sigMap = {}
  for (const s of (sigs || [])) { if (!sigMap[s.symbol]) sigMap[s.symbol] = s }

  // Get signal price (price at golden cross) per symbol for return calculation
  const sigPriceMap = {}
  for (const s of (sigs || [])) { if (!sigPriceMap[s.symbol]) sigPriceMap[s.symbol] = s.price }

  const rows = inds.map(ind => {
    const sig       = sigMap[ind.symbol] || {}
    const sigPrice  = sig.price ?? null
    const cmp       = ind.weekly_close
    const ret       = (sigPrice && cmp) ? (cmp / sigPrice - 1) * 100 : null
    return {
      symbol:            ind.symbol,
      _name:             sig.stocks?.name || '',
      signal_date:       sig.signal_date || null,
      _signal_price:     sigPrice,
      weekly_close:      cmp,
      _return_pct:       ret,
      ema9:              ind.ema9,
      ema20:             ind.ema20,
      ema_difference_pct:ind.ema_difference_pct,
      sector:            sig.stocks?.sector || '',
    }
  })

  const cols = [
    { label: '★',            key: '_star',             cls: 'star-col',    fmt: v => starCell(v) },
    { label: 'Symbol',       key: 'symbol',            cls: 'sym',         fmt: v => esc(v) },
    { label: 'Name',         key: '_name',             cls: 'name',        fmt: v => esc(v) },
    { label: 'Cross Date',   key: 'signal_date',       cls: 'mono',        fmt: v => fmt.date(v) },
    { label: 'Held',         key: 'signal_date',       cls: 'mono',        fmt: v => fmt.days(v) },
    { label: 'Signal Price', key: '_signal_price',     cls: 'num r',       fmt: v => fmt.price(v) },
    { label: 'CMP',          key: 'weekly_close',      cls: 'num r',       fmt: v => fmt.price(v) },
    { label: 'Return%',      key: '_return_pct',       cls: 'pct r',       fmt: v => v == null ? '—' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` },
    { label: 'EMA9',         key: 'ema9',              cls: 'num r',       fmt: v => fmt.price(v) },
    { label: 'EMA20',        key: 'ema20',             cls: 'num r',       fmt: v => fmt.price(v) },
    { label: 'EMA Diff%',    key: 'ema_difference_pct',cls: 'pct r',      fmt: v => `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` },
    { label: 'Sector',       key: 'sector',            cls: 'muted',       fmt: v => esc(v) },
  ]
  const activeRows = rows.map(r => ({ ...r, _star: r.symbol }))
  renderTable(container, 'active', cols, activeRows)
}

// ── Tab 4: Signal History ─────────────────────────────────────────
async function loadHistoryTab(reset = false) {
  const container = el('body-history')
  if (reset) { historyOffset = 0; historyAllRows = []; loading(container) }

  const hasGlobalFilter = globalFilters.returnPct !== null || globalFilters.watchlistOnly
  const f = historyFilters

  // When a global filter is active and this is a fresh load, fetch a large
  // batch at once so the filter sees all rows — not just the current page.
  // Return% is computed client-side, so we can't push it to the DB query.
  const fetchSize = (hasGlobalFilter && reset) ? 5000 : HISTORY_PAGE

  let q = db.from('signals')
    .select('signal_date, strategy_name, signal_type, symbol, price, ema_difference_pct, breakout_pct, sector, stocks(name)', { count: 'exact' })
    .order('signal_date', { ascending: false })
    .range(historyOffset, historyOffset + fetchSize - 1)

  if (f.strategy) q = q.eq('strategy_name', f.strategy)
  if (f.symbol)   q = q.ilike('symbol', `%${f.symbol}%`)
  if (f.sector)   q = q.ilike('sector', `%${f.sector}%`)
  if (f.from)     q = q.gte('signal_date', f.from)
  if (f.to)       q = q.lte('signal_date', f.to)

  const { data, count, error } = await q
  if (error || !data?.length) {
    if (reset) empty(container, 'No signals match your filters.')
    el('load-more-history').hidden = true
    return
  }

  historyTotal = count || 0
  el('meta-history').textContent = `${fmt.num(historyTotal)} total signals`

  const syms = [...new Set(data.map(r => r.symbol))]
  const cmpMap = syms.length ? await fetchCmp(syms) : {}

  const cols = [
    { label: '★',            key: '_star',              cls: 'star-col',    fmt: v => starCell(v) },
    { label: 'Date',         key: 'signal_date',        cls: 'mono',        fmt: v => fmt.date(v) },
    { label: 'Symbol',       key: 'symbol',             cls: 'sym',         fmt: v => esc(v) },
    { label: 'Name',         key: '_name',              cls: 'name',        fmt: v => esc(v) },
    { label: 'Strategy',     key: 'strategy_name',      cls: '',            fmt: v => fmt.strat(v) },
    { label: 'Type',         key: 'signal_type',        cls: '',            fmt: v => fmt.type(v) },
    { label: 'Signal Price', key: 'price',              cls: 'num r',       fmt: v => fmt.price(v) },
    { label: 'CMP',          key: '_cmp',               cls: 'num r',       fmt: v => fmt.price(v) },
    { label: 'Return%',      key: '_return_pct',        cls: 'pct r',       fmt: v => v == null ? '—' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` },
    { label: 'EMA Diff%',    key: 'ema_difference_pct', cls: 'pct r',      fmt: v => v != null ? `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` : '—' },
    { label: 'Brk%',         key: 'breakout_pct',       cls: 'pct r',      fmt: v => v != null ? `<span class="pos">${fmt.pct(v)}</span>` : '—' },
    { label: 'Sector',       key: 'sector',             cls: 'muted',       fmt: v => esc(v) },
  ]

  const newRows = data.map(r => {
    const cmp = cmpMap[r.symbol] ?? null
    const ret = (cmp != null && r.price) ? (cmp / r.price - 1) * 100 : null
    return { ...r, _star: r.symbol, _name: r.stocks?.name || '', _cmp: cmp, _return_pct: ret }
  })

  historyOffset += data.length

  if (reset) {
    // Fresh load: replace everything
    historyAllRows = newRows
    renderTable(container, 'history', cols, historyAllRows)
  } else {
    // Load More without a global filter: append to DOM (preserves scroll) and cache
    historyAllRows = historyAllRows.concat(newRows)
    appendRows('table-history', cols, newRows)
  }

  // Hide Load More when a global filter is active (already have all data)
  // or when all rows are loaded
  el('load-more-history').hidden = hasGlobalFilter || historyOffset >= historyTotal
}

// ── Tab 5: Crossover Returns (holds aged ≥ 2 weeks) ───────────────
// Shows golden crosses that happened AT LEAST 2 weeks ago (up to 6 months)
// and are still holding (EMA9 > EMA20 right now). Tracks "if I bought at
// crossover and held till today, what return would I have?"
async function loadPerfTab() {
  const container = el('body-perf')
  loading(container)

  const { obsDate, activeSet } = await getObsContext()
  if (!obsDate) { empty(container, 'No indicator data yet.', 'Run the scanner first.'); return }

  // Crossover must have happened at least 2 weeks ago (≥14 days old).
  // No cap on how old — any crossover still holding (EMA9 > EMA20) is shown.
  const cutoffRecent = daysAgo(obsDate, 14)   // upper bound: at least 14 days old
  const cutoffOld    = daysAgo(obsDate, 730)  // lower bound: up to 2 years back
  el('meta-perf').textContent = `All golden crosses ≥ 2 weeks old · still EMA9 > EMA20 · held to ${fmt.date(obsDate)}`

  const { data, error } = await db.from('signals')
    .select('symbol, signal_date, price, ema_difference_pct, sector, stocks(name)')
    .eq('strategy_name', 'ema_crossover')
    .eq('signal_type', 'golden_cross')
    .gte('signal_date', cutoffOld)
    .lte('signal_date', cutoffRecent)
    .order('signal_date', { ascending: false })

  if (error || !data?.length) {
    empty(container, 'No qualifying crossovers found.', 'No golden crosses older than 2 weeks are currently active.')
    return
  }

  // Deduplicate: keep earliest cross per symbol, then keep only still-active ones
  const seen = new Set()
  const candidates = []
  for (const row of [...data].sort((a, b) => a.signal_date.localeCompare(b.signal_date))) {
    if (seen.has(row.symbol)) continue
    seen.add(row.symbol)
    if (activeSet.has(row.symbol)) candidates.push(row)
  }

  if (!candidates.length) {
    empty(container, 'All older crossovers have since reversed.', 'No stocks from this period are still above EMA9 > EMA20.')
    return
  }

  // Sort by signal_date desc for display
  candidates.sort((a, b) => b.signal_date.localeCompare(a.signal_date))

  const syms = candidates.map(r => r.symbol)
  const cmpMap = await fetchCmp(syms)

  const rows = candidates.map(r => {
    const cmp = cmpMap[r.symbol] ?? null
    const ret = (cmp != null && r.price) ? (cmp / r.price - 1) * 100 : null
    return { ...r, _star: r.symbol, _name: r.stocks?.name || '', _cmp: cmp, _return_pct: ret }
  })

  // ── Summary stats ──────────────────────────────────────────────
  const withRet = rows.filter(r => r._return_pct != null)
  const avgRet  = withRet.length ? withRet.reduce((s, r) => s + r._return_pct, 0) / withRet.length : null
  const best    = withRet.length ? Math.max(...withRet.map(r => r._return_pct)) : null
  const worst   = withRet.length ? Math.min(...withRet.map(r => r._return_pct)) : null
  const nPos    = withRet.filter(r => r._return_pct > 0).length
  const hitRate = withRet.length ? (nPos / withRet.length * 100).toFixed(0) : null

  function retStr(v) { return v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%' }

  const summaryHtml = `<div class="perf-summary">
    <div class="perf-kpi">
      <div class="perf-kpi-val neutral">${rows.length}</div>
      <div class="perf-kpi-label">Stocks tracked</div>
      <div class="perf-kpi-sub">Golden X · still active</div>
    </div>
    <div class="perf-kpi">
      <div class="perf-kpi-val ${avgRet == null ? '' : avgRet >= 0 ? 'pos' : 'neg'}">${retStr(avgRet)}</div>
      <div class="perf-kpi-label">Avg return</div>
      <div class="perf-kpi-sub">Equal-weight basket</div>
    </div>
    <div class="perf-kpi">
      <div class="perf-kpi-val pos">${retStr(best)}</div>
      <div class="perf-kpi-label">Best performer</div>
    </div>
    <div class="perf-kpi">
      <div class="perf-kpi-val ${worst != null && worst < 0 ? 'neg' : 'pos'}">${retStr(worst)}</div>
      <div class="perf-kpi-label">Worst performer</div>
    </div>
    <div class="perf-kpi">
      <div class="perf-kpi-val neutral">${hitRate == null ? '—' : hitRate + '%'}</div>
      <div class="perf-kpi-label">Win rate</div>
      <div class="perf-kpi-sub">${nPos} of ${withRet.length} profitable</div>
    </div>
  </div>
  <div id="perf-table-wrap"></div>`

  container.innerHTML = summaryHtml

  const cols = [
    { label: '★',            key: '_star',              cls: 'star-col',    fmt: v => starCell(v) },
    { label: 'Symbol',       key: 'symbol',             cls: 'sym',         fmt: v => esc(v) },
    { label: 'Name',         key: '_name',              cls: 'name',        fmt: v => esc(v) },
    { label: 'Cross Date',   key: 'signal_date',        cls: 'mono',        fmt: v => fmt.date(v) },
    { label: 'Held',         key: 'signal_date',        cls: 'mono',        fmt: v => fmt.days(v) },
    { label: 'Buy Price',    key: 'price',              cls: 'num r',       fmt: v => fmt.price(v) },
    { label: 'CMP',          key: '_cmp',               cls: 'num r',       fmt: v => fmt.price(v) },
    { label: 'Return%',      key: '_return_pct',        cls: 'pct r',       fmt: v => v == null ? '—' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` },
    { label: 'EMA Diff%',    key: 'ema_difference_pct', cls: 'pct r',      fmt: v => v != null ? `<span class="pos">${fmt.pct(v)}</span>` : '—' },
    { label: 'Sector',       key: 'sector',             cls: 'muted',       fmt: v => esc(v) },
  ]
  renderTable(el('perf-table-wrap'), 'perf', cols, rows)
}

// ── Watchlist Tab ─────────────────────────────────────────────────
async function loadWatchlistTab() {
  const container = el('body-watchlist')
  loading(container)

  const wlSyms = [...getWatchlist()]
  if (!wlSyms.length) {
    empty(container, 'Your watchlist is empty', 'Click ☆ on any row in any tab to add stocks here')
    el('meta-watchlist').textContent = '0 stocks'
    return
  }
  el('meta-watchlist').textContent = `${wlSyms.length} stock${wlSyms.length === 1 ? '' : 's'}`

  const [{ data: rawInds }, { data: sigs }] = await Promise.all([
    db.from('weekly_indicators')
      .select('symbol, ema9, ema20, ema_difference_pct, weekly_close, observation_date')
      .in('symbol', wlSyms).order('observation_date', { ascending: false }),
    db.from('signals')
      .select('symbol, signal_date, price, strategy_name, signal_type, stocks(name, sector, industry)')
      .in('symbol', wlSyms).eq('signal_type', 'golden_cross')
      .order('signal_date', { ascending: false }),
  ])

  const indMap = {}, sigMap = {}
  for (const ind of (rawInds || [])) { if (!(ind.symbol in indMap)) indMap[ind.symbol] = ind }
  for (const s   of (sigs    || [])) { if (!(s.symbol   in sigMap)) sigMap[s.symbol]   = s   }

  const rows = wlSyms.map(sym => {
    const ind = indMap[sym] || {}, sig = sigMap[sym] || {}
    const cmp = ind.weekly_close ?? null, sigPrice = sig.price ?? null
    const ret = (cmp && sigPrice) ? (cmp / sigPrice - 1) * 100 : null
    return {
      _star: sym, symbol: sym,
      _name: sig.stocks?.name || '',
      signal_date: sig.signal_date || null,
      strategy_name: sig.strategy_name || '',
      _signal_price: sigPrice, _cmp: cmp, _return_pct: ret,
      ema9: ind.ema9 ?? null, ema20: ind.ema20 ?? null,
      ema_difference_pct: ind.ema_difference_pct ?? null,
      sector: sig.stocks?.sector || '',
    }
  })

  const cols = [
    { label: '★',            key: '_star',              cls: 'star-col',    fmt: v => starCell(v) },
    { label: 'Symbol',       key: 'symbol',             cls: 'sym',         fmt: v => esc(v) },
    { label: 'Name',         key: '_name',              cls: 'name',        fmt: v => esc(v) },
    { label: 'Strategy',     key: 'strategy_name',      cls: '',            fmt: v => v ? fmt.strat(v) : '—' },
    { label: 'Signal Date',  key: 'signal_date',        cls: 'mono',        fmt: v => fmt.date(v) },
    { label: 'Signal Price', key: '_signal_price',      cls: 'num r',       fmt: v => fmt.price(v) },
    { label: 'CMP',          key: '_cmp',               cls: 'num r',       fmt: v => fmt.price(v) },
    { label: 'Return%',      key: '_return_pct',        cls: 'pct r',       fmt: v => v == null ? '—' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` },
    { label: 'EMA9',         key: 'ema9',               cls: 'num r',       fmt: v => fmt.price(v) },
    { label: 'EMA20',        key: 'ema20',              cls: 'num r',       fmt: v => fmt.price(v) },
    { label: 'EMA Diff%',    key: 'ema_difference_pct', cls: 'pct r',       fmt: v => v != null ? `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` : '—' },
    { label: 'Sector',       key: 'sector',             cls: 'muted',       fmt: v => esc(v) },
  ]
  renderTable(container, 'watchlist', cols, rows)
}

// ── Table Renderer ────────────────────────────────────────────────
function renderTable(container, tabId, cols, rows) {
  // Apply global filters
  let display = rows
  if (globalFilters.returnPct !== null) {
    display = display.filter(r => r._return_pct != null && r._return_pct >= globalFilters.returnPct)
  }
  if (globalFilters.watchlistOnly) {
    const wl = getWatchlist()
    display = display.filter(r => wl.has(r.symbol))
  }
  if (!display.length) {
    const msg = (globalFilters.returnPct !== null || globalFilters.watchlistOnly)
      ? 'No stocks match the active filters.' : 'No data to display.'
    empty(container, msg)
    return
  }

  const ss = sortState[tabId] || {}
  const sorted = sortRows(display, ss.col, ss.dir)

  const head = cols.map(c => {
    const sc = ss.col === c.key ? (ss.dir === 'asc' ? 'sorted-asc' : 'sorted-desc') : ''
    const noSort = c.cls?.includes('star-col') ? ' style="cursor:default"' : ''
    return `<th class="${c.cls || ''} ${sc}" data-tab="${tabId}" data-col="${c.key}"${noSort}>${c.label}</th>`
  }).join('')

  const body = sorted.map(row =>
    '<tr>' + cols.map(c => {
      const val = c.fmt ? c.fmt(row[c.key]) : (row[c.key] == null ? '—' : esc(String(row[c.key])))
      return `<td class="${c.cls || ''}">${val}</td>`
    }).join('') + '</tr>'
  ).join('')

  container.innerHTML = `<div class="table-wrap"><table id="table-${tabId}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`

  container.querySelectorAll('th[data-col]').forEach(th => {
    if (th.classList.contains('star-col')) return
    th.addEventListener('click', () => {
      const col = th.dataset.col, tab = th.dataset.tab
      const cur = sortState[tab] || {}
      sortState[tab] = { col, dir: cur.col === col && cur.dir === 'asc' ? 'desc' : 'asc' }
      renderTable(container, tabId, cols, rows)
    })
  })
}

function appendRows(tableId, cols, rows) {
  const tbody = document.querySelector(`#${tableId} tbody`)
  if (!tbody) return
  rows.forEach(row => {
    const tr = document.createElement('tr')
    tr.innerHTML = cols.map(c => {
      const val = c.fmt ? c.fmt(row[c.key]) : (row[c.key] == null ? '—' : esc(String(row[c.key])))
      return `<td class="${c.cls || ''}">${val}</td>`
    }).join('')
    tbody.appendChild(tr)
  })
}

function sortRows(rows, col, dir) {
  if (!col) return rows
  return [...rows].sort((a, b) => {
    const av = a[col], bv = b[col]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv))
    return dir === 'desc' ? -cmp : cmp
  })
}

// ── Tab Switching ─────────────────────────────────────────────────
const loaders = {
  crossovers: loadCrossoverTab,
  breakouts:  loadBreakoutTab,
  active:     loadActiveTab,
  history:    () => loadHistoryTab(true),
  perf:       loadPerfTab,
  watchlist:  loadWatchlistTab,
}

async function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab))
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tab}`))
  if (!loaded[tab]) {
    loaded[tab] = true
    await loaders[tab]()
  }
}

// ── History Filters ───────────────────────────────────────────────
el('filter-apply').addEventListener('click', () => {
  historyFilters = {
    strategy: el('filter-strategy').value,
    symbol:   el('filter-symbol').value.trim().toUpperCase(),
    sector:   el('filter-sector').value.trim(),
    from:     el('filter-from').value,
    to:       el('filter-to').value,
  }
  loaded.history = false
  loadHistoryTab(true)
})

el('filter-reset').addEventListener('click', () => {
  historyFilters = {}
  ;['filter-strategy', 'filter-symbol', 'filter-sector', 'filter-from', 'filter-to'].forEach(id => el(id).value = '')
  loaded.history = false
  loadHistoryTab(true)
})

el('load-more-history').addEventListener('click', () => loadHistoryTab(false))

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab))
})

// ── Star click (event delegation) ────────────────────────────────
document.addEventListener('click', e => {
  const btn = e.target.closest('.star-btn')
  if (!btn) return
  const sym = btn.dataset.sym
  const wl = getWatchlist()
  if (wl.has(sym)) {
    wl.delete(sym)
    btn.classList.remove('starred')
    btn.textContent = '☆'
    btn.title = 'Add to watchlist'
  } else {
    wl.add(sym)
    btn.classList.add('starred')
    btn.textContent = '★'
    btn.title = 'Remove from watchlist'
  }
  saveWatchlist(wl)
  updateWlCount()
  loaded.watchlist = false   // force watchlist to reload on next visit
})

// ── Global Filters ────────────────────────────────────────────────
function reloadActiveTab() {
  const activeBtn = document.querySelector('.tab-btn.active')
  if (!activeBtn) return
  const tab = activeBtn.dataset.tab
  loaded[tab] = false
  switchTab(tab)
}

el('gf-return').addEventListener('change', () => {
  const v = el('gf-return').value
  globalFilters.returnPct = v === '' ? null : parseFloat(v)
  reloadActiveTab()
})

el('gf-watchlist-only').addEventListener('click', () => {
  globalFilters.watchlistOnly = !globalFilters.watchlistOnly
  el('gf-watchlist-only').classList.toggle('btn-wl-active', globalFilters.watchlistOnly)
  el('gf-watchlist-only').textContent = globalFilters.watchlistOnly ? '★ Watchlist only' : '☆ Watchlist only'
  reloadActiveTab()
})

el('gf-reset').addEventListener('click', () => {
  globalFilters = { returnPct: null, watchlistOnly: false }
  el('gf-return').value = ''
  el('gf-watchlist-only').classList.remove('btn-wl-active')
  el('gf-watchlist-only').textContent = '☆ Watchlist only'
  reloadActiveTab()
})

// ── Init ──────────────────────────────────────────────────────────
async function init() {
  updateWlCount()
  try {
    await loadSummary()
    await switchTab('crossovers')
  } catch (e) {
    console.error('Init error:', e)
    el('run-text').textContent = 'Connection error'
    el('run-dot').className = 'dot err'
  }
}

document.addEventListener('DOMContentLoaded', init)
