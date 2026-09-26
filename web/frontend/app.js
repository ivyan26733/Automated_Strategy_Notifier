/* NSE Stock Screener — frontend (thin client, all data from /api/*) */

// ── State ─────────────────────────────────────────────────────────
let historyQuery   = { page: 1, pageSize: 50, sort: 'signal_date', dir: 'desc' }
let historyReq     = 0
let historyFilters = {}
let sortState      = {}
let loaded         = {}
let globalFilters  = { returnPct: null, watchlistOnly: false }
let perfPeriodDays = 365
let tableData      = {}   // tab → { cols, rows } as last shown, for the Excel export

// ── Watchlist (localStorage) ──────────────────────────────────────
function getWatchlist() {
  try { return new Set(JSON.parse(localStorage.getItem('nse_watchlist') || '[]')) } catch { return new Set() }
}
function saveWatchlist(s) {
  try { localStorage.setItem('nse_watchlist', JSON.stringify([...s])) } catch {}
}
function updateWlCount() {
  const badge = el('wl-count')
  if (badge) { const n = getWatchlist().size; badge.textContent = n > 0 ? n : '' }
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
function loading(c, sub = '') { c.innerHTML = `<div class="state-box"><div class="spinner"></div><span class="state-title">Loading…</span>${sub ? `<span class="state-sub">${esc(sub)}</span>` : ''}</div>` }
function empty(c, msg, sub = '') { c.innerHTML = `<div class="state-box"><span class="state-title">${esc(msg)}</span>${sub ? `<span class="state-sub">${esc(sub)}</span>` : ''}</div>` }
// A failed load must look different from an empty result — "no stocks today"
// and "the database didn't answer" call for opposite reactions.
function failed(c, retry) {
  c.innerHTML = `<div class="state-box"><span class="state-title state-error">Couldn't load this data.</span><span class="state-sub">The server didn't respond properly — this is usually temporary.</span><button type="button" class="btn btn-secondary">Try again</button></div>`
  c.querySelector('button').addEventListener('click', retry)
}

async function apiFetch(path) {
  const r = await fetch(path)
  if (!r.ok) throw new Error(`API ${r.status}: ${path}`)
  return r.json()
}

// ── Summary / KPI bar ─────────────────────────────────────────────
async function loadSummary() {
  const d = await apiFetch('/api/summary')
  const run = d.lastRun

  if (run) {
    el('run-dot').className = 'dot ' + (run.status === 'success' ? 'ok' : run.status === 'running' ? 'run' : 'err')
    el('run-text').textContent = run.status === 'success' ? 'Scanner OK' : run.status === 'running' ? 'Running…' : 'Last run failed'
    el('last-scan').textContent = run.finished_at
      ? 'Last scan: ' + fmt.date(run.finished_at) + ' · ' + fmt.days(run.finished_at)
      : 'Scan in progress'
  }

  const obsSub = d.obsDate ? 'As of ' + fmt.date(d.obsDate) : 'No scanner data yet'
  el('kpi-universe').innerHTML   = `<div class="kpi-label">Universe</div><div class="kpi-value">${fmt.num(d.universeCount)}</div><div class="kpi-sub">NSE EQ stocks</div>`
  el('kpi-crossovers').innerHTML = `<div class="kpi-label">EMA Crossovers</div><div class="kpi-value">${fmt.num(d.freshEmaCount)}</div><div class="kpi-sub">Fresh from latest scanner run</div>`
  el('kpi-signals').innerHTML    = `<div class="kpi-label">Total Signals</div><div class="kpi-value">${fmt.num(d.totalSignals)}</div><div class="kpi-sub">All time · ${obsSub}</div>`
}

// ── Tab 1: Fresh EMA Crossovers ───────────────────────────────────
async function loadCrossoverTab() {
  const container = el('body-crossovers')
  loading(container)

  const d = await apiFetch('/api/crossovers')
  if (!d.rows?.length) {
    // Genuinely quiet days are normal — on a falling market nothing crosses up
    // at all. Say that plainly instead of leaving a bare empty table, which
    // reads like the scan failed.
    el('meta-crossovers').textContent = d.obsDate
      ? `Fresh Golden Crosses · trading day ${fmt.date(d.obsDate)}`
      : 'Fresh Golden Crosses'
    empty(
      container,
      'No stocks crossed over on the latest trading day.',
      d.obsDate
        ? `Nothing crossed above its EMA20 on ${fmt.date(d.obsDate)}. Earlier crosses that are still running are in Active EMA.`
        : 'Please check back after the next scan.'
    )
    return
  }

  el('meta-crossovers').textContent = `Fresh Golden Crosses · crossed on ${fmt.date(d.obsDate)} · move to Active EMA the next trading day`

  const cols = [
    { label: '★',            key: '_star',             cls: 'star-col', fmt: v => starCell(v) },
    { label: 'Symbol',       key: 'symbol',            cls: 'sym',      fmt: v => esc(v) },
    { label: 'Name',         key: 'name',              cls: 'name',     fmt: v => esc(v) },
    { label: 'Cross Date',   key: 'signal_date',       cls: 'mono hide-xs', fmt: v => fmt.date(v) },
    { label: 'Held',         key: '_held',             cls: 'mono hide-xs', fmt: v => fmt.days(v) },
    { label: 'Signal Price', key: 'price',             cls: 'num r hide-sm', fmt: v => fmt.price(v) },
    { label: 'CMP',          key: 'cmp',               cls: 'num r',    fmt: v => fmt.price(v) },
    { label: 'Return%',      key: 'return_pct',        cls: 'pct r',    fmt: v => v == null ? '—' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` },
    { label: 'EMA9',         key: 'ema9',              cls: 'num r hide-xs', fmt: v => fmt.price(v) },
    { label: 'EMA20',        key: 'ema20',             cls: 'num r hide-xs', fmt: v => fmt.price(v) },
    { label: 'EMA Diff%',    key: 'ema_difference_pct',cls: 'pct r hide-sm', fmt: v => v != null ? `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` : '—' },
    { label: 'Sector',       key: 'sector',            cls: 'muted hide-xs', fmt: v => esc(v) },
  ]
  renderTable(container, 'crossovers', cols, d.rows.map(r => ({ ...r, _star: r.symbol, _held: r.signal_date })))
}

// ── Tab 2: 6-Month Breakouts ──────────────────────────────────────
async function loadBreakoutTab() {
  const container = el('body-breakouts')
  loading(container)

  const d = await apiFetch('/api/breakouts')
  if (!d.rows?.length) {
    empty(container, 'No 6-month breakouts in the last 30 days.', 'The scanner will populate this after daily runs.')
    return
  }

  el('meta-breakouts').textContent = `Breakouts in last 30 days · from ${fmt.date(d.cutoff)}`

  const cols = [
    { label: '★',            key: '_star',             cls: 'star-col', fmt: v => starCell(v) },
    { label: 'Symbol',       key: 'symbol',            cls: 'sym',      fmt: v => esc(v) },
    { label: 'Name',         key: 'name',              cls: 'name',     fmt: v => esc(v) },
    { label: 'Breakout Date',key: 'signal_date',       cls: 'mono',     fmt: v => fmt.date(v) },
    { label: 'Signal Price', key: 'price',             cls: 'num r',    fmt: v => fmt.price(v) },
    { label: 'CMP',          key: 'cmp',               cls: 'num r',    fmt: v => fmt.price(v) },
    { label: 'Return%',      key: 'return_pct',        cls: 'pct r',    fmt: v => v == null ? '—' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` },
    { label: '6M High Ref',  key: 'breakout_reference',cls: 'num r',   fmt: v => fmt.price(v) },
    { label: 'Breakout%',    key: 'breakout_pct',      cls: 'pct r',    fmt: v => `<span class="pos">${fmt.pct(v)}</span>` },
    { label: 'Sector',       key: 'sector',            cls: 'muted',    fmt: v => esc(v) },
    { label: 'Industry',     key: 'industry',          cls: 'muted',    fmt: v => esc(v) },
  ]
  renderTable(container, 'breakouts', cols, d.rows.map(r => ({ ...r, _star: r.symbol })))
}

// ── Tab 3: Active EMA ─────────────────────────────────────────────
// Unrealised stats across the open positions on screen. Computed from the rows
// renderTable actually displayed, so the numbers always describe the table you
// are looking at — including when a global filter has narrowed it.
function median(xs) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function renderActiveStats(box, rows, obsDate, totalCount) {
  if (!box) return
  if (!rows.length) { box.innerHTML = ''; return }

  // A position with no entry price cannot have a return; count it, don't zero it.
  const withRet = rows.filter(r => r.return_pct != null)
  const rets    = withRet.map(r => r.return_pct)
  const noRet   = rows.length - withRet.length

  if (!rets.length) { box.innerHTML = ''; return }

  const avg     = rets.reduce((a, b) => a + b, 0) / rets.length
  const med     = median(rets)
  const best    = withRet.reduce((a, b) => (b.return_pct > a.return_pct ? b : a))
  const worst   = withRet.reduce((a, b) => (b.return_pct < a.return_pct ? b : a))
  const winners = rets.filter(r => r > 0).length

  // Held is measured to the scan's observation date, the same basis the Returns
  // tab uses — not to the browser's clock, which drifts ahead between scans.
  const asOf = obsDate ? new Date(obsDate) : new Date()
  const held = rows.map(r => r.signal_date
    ? Math.round((asOf - new Date(r.signal_date)) / 86400000) : null).filter(h => h != null)
  const avgHeld = held.length ? held.reduce((a, b) => a + b, 0) / held.length : null

  const retStr = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%'
  const holdStr = v => v == null ? '—'
    : v >= 365 ? (v / 365).toFixed(1) + 'y' : v >= 60 ? (v / 30).toFixed(1) + 'mo' : Math.round(v) + 'd'
  const cls = v => v == null ? '' : v >= 0 ? 'pos' : 'neg'

  const filtered = totalCount != null && totalCount !== rows.length
  const scope = filtered
    ? `${rows.length} of ${totalCount} positions match your filters`
    : `all ${rows.length} open positions`

  box.innerHTML = `<div class="perf-summary">
    <div class="perf-kpi">
      <div class="perf-kpi-val ${cls(avg)}">${retStr(avg)}</div>
      <div class="perf-kpi-label">Average Return</div>
      <div class="perf-kpi-sub">Unrealised, ${scope}</div>
    </div>
    <div class="perf-kpi">
      <div class="perf-kpi-val ${cls(med)}">${retStr(med)}</div>
      <div class="perf-kpi-label">Median Return</div>
      <div class="perf-kpi-sub">The typical holding, not skewed by outliers</div>
    </div>
    <div class="perf-kpi">
      <div class="perf-kpi-val pos">${retStr(best.return_pct)}</div>
      <div class="perf-kpi-label">Best Position</div>
      <div class="perf-kpi-sub">${esc(best.symbol)}${best.signal_date ? ' · held ' + holdStr(Math.round((asOf - new Date(best.signal_date)) / 86400000)) : ''}</div>
    </div>
    <div class="perf-kpi">
      <div class="perf-kpi-val ${cls(worst.return_pct)}">${retStr(worst.return_pct)}</div>
      <div class="perf-kpi-label">Worst Position</div>
      <div class="perf-kpi-sub">${esc(worst.symbol)}${worst.signal_date ? ' · held ' + holdStr(Math.round((asOf - new Date(worst.signal_date)) / 86400000)) : ''}</div>
    </div>
    <div class="perf-kpi">
      <div class="perf-kpi-val neutral">${(winners / rets.length * 100).toFixed(0)}%</div>
      <div class="perf-kpi-label">In Profit</div>
      <div class="perf-kpi-sub">${winners} up · ${rets.length - winners} down${noRet ? ' · ' + noRet + ' with no entry price' : ''}</div>
    </div>
    <div class="perf-kpi">
      <div class="perf-kpi-val neutral">${holdStr(avgHeld)}</div>
      <div class="perf-kpi-label">Avg Holding Period</div>
      <div class="perf-kpi-sub">Since each cross, to ${fmt.date(obsDate)}</div>
    </div>
  </div>
  <p class="perf-caveat">
    These are <strong>open positions marked to the latest weekly close</strong> — paper
    gains on trades still running, not a realised track record. Read them alongside the
    Returns tab, not instead of it: a stock only stays on this list while EMA9 &gt; EMA20,
    so losers keep dropping off at their death cross while winners stay and compound.
    That makes the average here structurally flattering, and it is why it sits well above
    the Returns tab's figure for the same strategy.
  </p>`
}

async function loadActiveTab() {
  const container = el('body-active')
  loading(container)
  if (el('stats-active')) el('stats-active').innerHTML = ''

  const d = await apiFetch('/api/active')
  if (!d.rows?.length) {
    empty(container, 'No stocks currently above EMA9 > EMA20.')
    el('meta-active').textContent = ''
    return
  }

  el('meta-active').textContent = `${d.activeCount} stocks above EMA9 > EMA20 · holding position · as of ${fmt.date(d.obsDate)}`

  const cols = [
    { label: '★',            key: '_star',             cls: 'star-col', fmt: v => starCell(v) },
    { label: 'Symbol',       key: 'symbol',            cls: 'sym',      fmt: v => esc(v) },
    { label: 'Name',         key: 'name',              cls: 'name',     fmt: v => esc(v) },
    { label: 'Cross Date',   key: 'signal_date',       cls: 'mono hide-sm', fmt: v => fmt.date(v) },
    { label: 'Held',         key: '_held',             cls: 'mono',     fmt: v => fmt.days(v) },
    { label: 'Signal Price', key: 'signal_price',      cls: 'num r hide-sm', fmt: v => fmt.price(v) },
    { label: 'CMP',          key: 'cmp',               cls: 'num r hide-sm', fmt: v => fmt.price(v) },
    { label: 'Return%',      key: 'return_pct',        cls: 'pct r',    fmt: v => v == null ? '—' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` },
    { label: 'EMA9',         key: 'ema9',              cls: 'num r hide-xs', fmt: v => fmt.price(v) },
    { label: 'EMA20',        key: 'ema20',             cls: 'num r hide-xs', fmt: v => fmt.price(v) },
    { label: 'EMA Diff%',    key: 'ema_difference_pct',cls: 'pct r hide-sm', fmt: v => v != null ? `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` : '—' },
    { label: 'Sector',       key: 'sector',            cls: 'muted hide-xs', fmt: v => esc(v) },
  ]
  renderTable(container, 'active', cols, d.rows.map(r => ({ ...r, _star: r.symbol, _held: r.signal_date })))
  // After renderTable, so the stats are built from the rows it actually showed.
  renderActiveStats(el('stats-active'), tableData['active']?.rows || [], d.obsDate, d.rows.length)
}

// ── Tab 4: Signal History ─────────────────────────────────────────
// Sorting, filters and page numbers are all applied by the server across every
// signal on record — the page on screen is just one slice of that result.
const HISTORY_COLS = [
    { label: '★',            key: '_star',              cls: 'star-col', fmt: v => starCell(v) },
    { label: 'Date',         key: 'signal_date',        cls: 'mono',     fmt: v => fmt.date(v) },
    { label: 'Symbol',       key: 'symbol',             cls: 'sym',      fmt: v => esc(v) },
    { label: 'Name',         key: 'name',               cls: 'name',     fmt: v => esc(v) },
    { label: 'Strategy',     key: 'strategy_name',      cls: 'hide-xs',  fmt: v => fmt.strat(v) },
    { label: 'Type',         key: 'signal_type',        cls: 'hide-sm',  fmt: v => fmt.type(v) },
    { label: 'Status',       key: 'status',             cls: '',         fmt: v => v === 'open'
        ? '<span class="badge badge-green">Open</span>'
        : v === 'closed' ? '<span class="badge badge-red">Closed</span>' : '<span class="muted">—</span>' },
    { label: 'Exit Date',    key: 'exit_date',          cls: 'mono hide-sm', fmt: v => v ? fmt.date(v) : '—' },
    { label: 'Signal Price', key: 'price',              cls: 'num r hide-sm', fmt: v => fmt.price(v) },
    { label: 'Exit/CMP',     key: 'cmp',                cls: 'num r hide-sm', fmt: v => fmt.price(v) },
    { label: 'Return%',      key: 'return_pct',         cls: 'pct r',    fmt: v => v == null ? '—' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` },
    { label: 'EMA Diff%',    key: 'ema_difference_pct', cls: 'pct r hide-xs', fmt: v => v != null ? `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` : '—' },
    { label: 'Brk%',         key: 'breakout_pct',       cls: 'pct r hide-xs', fmt: v => v != null ? `<span class="pos">${fmt.pct(v)}</span>` : '—' },
    { label: 'Sector',       key: 'sector',             cls: 'muted hide-xs', fmt: v => esc(v) },
]
const HISTORY_TEXT_COLS = new Set(['symbol', 'name', 'strategy_name', 'signal_type', 'status', 'sector'])

function historySortLabel(sort, dir) {
  const label = HISTORY_COLS.find(c => c.key === sort)?.label || 'Date'
  const words = sort === 'signal_date' || sort === 'exit_date' ? (dir === 'desc' ? 'newest first' : 'oldest first')
    : HISTORY_TEXT_COLS.has(sort) ? (dir === 'asc' ? 'A → Z' : 'Z → A')
    : (dir === 'desc' ? 'high → low' : 'low → high')
  return `${label}, ${words}`
}

// reset = back to page 1 (tab opened, filters changed). Page, sort and page-size
// changes keep the current table on screen, dimmed, until the new page arrives.
async function loadHistoryTab(reset = false) {
  const container = el('body-history')
  const bars = [el('pager-history-top'), el('pager-history')]
  if (reset) historyQuery.page = 1
  const req = ++historyReq
  const busy = [container, ...bars]
  if (container.querySelector('table')) busy.forEach(b => b.classList.add('is-busy'))
  else {
    loading(container, 'Sorting and filtering every signal on record — the first load after a scan takes a few seconds')
    renderHistoryPager(null)
  }

  // Return% and Watchlist-only are global filters; here they're sent to the server
  // so they apply to all signals, not only to the page on screen.
  const params = { ...historyQuery, ...historyFilters }
  if (globalFilters.returnPct !== null) params.minReturn = globalFilters.returnPct
  if (globalFilters.watchlistOnly) {
    params.watchlistOnly = '1'
    params.watchlist = [...getWatchlist()].join(',')
  }
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''))

  let d
  try {
    d = await apiFetch(`/api/history?${qs}`)
  } catch (e) {
    if (req !== historyReq) return
    busy.forEach(b => b.classList.remove('is-busy'))
    renderHistoryPager(null)
    throw e
  }
  if (req !== historyReq) return   // a newer page, sort or filter request replaced this one
  busy.forEach(b => b.classList.remove('is-busy'))

  historyQuery.page = d.page
  const filtered = Object.values(historyFilters).some(Boolean) || globalFilters.returnPct !== null || globalFilters.watchlistOnly
  el('meta-history').textContent = `${fmt.num(d.total)} golden crosses & breakouts${filtered ? ' match your filters' : ''} · sorted by ${historySortLabel(d.sort, d.dir)} · Closed = the cross later hit its death cross (Return% is entry → exit); Open = marked to today`

  if (!d.rows.length) {
    empty(container, 'No signals match your filters.', 'Try a wider date range or clear a filter.')
    renderHistoryPager(null)
    return
  }
  renderTable(container, 'history', HISTORY_COLS, d.rows.map(r => ({ ...r, _star: r.symbol })), {
    server: { col: d.sort, dir: d.dir, onSort: sortHistory },
  })
  renderHistoryPager(d)
}

// First click on a column: dates and numbers high→low (newest first), text A→Z.
function sortHistory(col) {
  if (historyQuery.sort === col) historyQuery.dir = historyQuery.dir === 'asc' ? 'desc' : 'asc'
  else { historyQuery.sort = col; historyQuery.dir = HISTORY_TEXT_COLS.has(col) ? 'asc' : 'desc' }
  historyQuery.page = 1
  navHistory()
}

// A failed page change shows the error in place of the table, with a retry.
function navHistory(scrollToTop = false) {
  if (scrollToTop) {
    const top = el('panel-history').getBoundingClientRect().top + scrollY - 110
    if (top < scrollY) scrollTo({ top, behavior: 'smooth' })
  }
  loadHistoryTab(false).catch(e => {
    console.error('History page error:', e)
    failed(el('body-history'), () => navHistory())
  })
}

// 1 … 4 5 [6] 7 8 … 682 — first, last, and two either side of the current page.
function pageList(page, pages) {
  const keep = [...new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2])]
    .filter(p => p >= 1 && p <= pages).sort((a, b) => a - b)
  const out = []
  keep.forEach((p, i) => {
    const prev = keep[i - 1]
    if (prev && p - prev === 2) out.push(prev + 1)
    else if (prev && p - prev > 2) out.push(null)
    out.push(p)
  })
  return out
}

function renderHistoryPager(d) {
  const top = el('pager-history-top'), bottom = el('pager-history')
  if (!d || !d.total) { top.hidden = bottom.hidden = true; return }

  const first = (d.page - 1) * d.pageSize + 1
  const last  = Math.min(d.total, d.page * d.pageSize)
  const info  = `<span class="pager-info">Showing <b>${fmt.num(first)}–${fmt.num(last)}</b> of <b>${fmt.num(d.total)}</b> · page <b>${fmt.num(d.page)}</b> of <b>${fmt.num(d.pages)}</b></span>`
  const btn   = (page, html, label, attrs = '') => `<button type="button" class="pager-btn" data-page="${page}" aria-label="${label}"${attrs}>${html}</button>`
  const step  = (page, html, label) => btn(page, html, label, page < 1 || page > d.pages || page === d.page ? ' disabled' : '')
  const prev  = step(d.page - 1, '‹<span class="pager-word"> Prev</span>', 'Previous page')
  const next  = step(d.page + 1, '<span class="pager-word">Next </span>›', 'Next page')
  const nums  = pageList(d.page, d.pages).map(p => p == null
    ? '<span class="pager-gap" aria-hidden="true">…</span>'
    : btn(p, fmt.num(p), `Page ${p}`, p === d.page ? ' aria-current="page" disabled' : '')).join('')

  top.innerHTML = `${info}<div class="pager-pages">${prev}${next}</div>`
  bottom.innerHTML = `${info}
    <div class="pager-pages">${step(1, '«', 'First page')}${prev}${nums}${next}${step(d.pages, '»', 'Last page')}</div>
    <div class="pager-tools">
      <label>Rows <select class="filter-select" data-pager="size">${[25, 50, 100].map(n => `<option value="${n}"${n === d.pageSize ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>Go to page <input class="filter-input" type="number" min="1" max="${d.pages}" inputmode="numeric" data-pager="jump" placeholder="${d.page}"></label>
    </div>`
  top.hidden = bottom.hidden = false
}

// ── Tab 5: Crossover Returns ──────────────────────────────────────
async function loadPerfTab() {
  const container = el('body-perf')
  loading(container)

  const d = await apiFetch(`/api/returns?period=${perfPeriodDays}`)

  const periodLabel = {
    0: 'All time', 90: 'Last 3 months', 180: 'Last 6 months',
    365: 'Last 1 year', 1095: 'Last 3 years', 1825: 'Last 5 years',
  }[perfPeriodDays] || 'Last 10 years'

  el('meta-perf').textContent = `${periodLabel} · ₹100 entered at each stock's first golden cross in this window, compounded through every golden-cross → death-cross cycle since`

  if (!d.trades?.length) {
    empty(container, 'No qualifying crossovers found.', 'No crosses found in this period.')
    return
  }

  const k = d.kpis
  const retStr = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%'
  const holdStr = v => {
    if (v == null) return '—'
    return v >= 365 ? (v / 365).toFixed(1) + 'y' : v >= 60 ? (v / 30).toFixed(1) + 'mo' : Math.round(v) + 'd'
  }

  container.innerHTML = `<div class="perf-summary">
    <div class="perf-kpi">
      <div class="perf-kpi-val ${k.compoundedAvg == null ? '' : k.compoundedAvg >= 0 ? 'pos' : 'neg'}">${retStr(k.compoundedAvg)}</div>
      <div class="perf-kpi-label">Compounded Return</div>
      <div class="perf-kpi-sub">₹100/stock, equal-weight · ${k.stockCount} stocks · ${periodLabel}</div>
    </div>
    <div class="perf-kpi">
      <div class="perf-kpi-val ${k.compoundedMedian == null ? '' : k.compoundedMedian >= 0 ? 'pos' : 'neg'}">${retStr(k.compoundedMedian)}</div>
      <div class="perf-kpi-label">Median Per-Stock</div>
      <div class="perf-kpi-sub">Typical stock, not skewed by outliers</div>
    </div>
    <div class="perf-kpi">
      <div class="perf-kpi-val pos">${retStr(k.compoundedBest)}</div>
      <div class="perf-kpi-label">Best Stock</div>
      <div class="perf-kpi-sub">Compounded, ${periodLabel}</div>
    </div>
    <div class="perf-kpi">
      <div class="perf-kpi-val ${k.compoundedWorst != null && k.compoundedWorst < 0 ? 'neg' : 'pos'}">${retStr(k.compoundedWorst)}</div>
      <div class="perf-kpi-label">Worst Stock</div>
      <div class="perf-kpi-sub">Compounded, ${periodLabel}</div>
    </div>
    <div class="perf-kpi">
      <div class="perf-kpi-val neutral">${k.winRate == null ? '—' : k.winRate.toFixed(0) + '%'}</div>
      <div class="perf-kpi-label">Win Rate</div>
      <div class="perf-kpi-sub">Stocks ending above ₹100 · ${k.stockCount} stocks</div>
    </div>
    <div class="perf-kpi">
      <div class="perf-kpi-val neutral">${holdStr(k.avgHoldDays)}</div>
      <div class="perf-kpi-label">Avg Holding Period</div>
      <div class="perf-kpi-sub">${k.totalTrades} trades · ${k.openCount} open · ${k.closedCount} closed</div>
    </div>
  </div>
  <p class="perf-caveat">
    <strong>Compounded Return</strong> answers "if I'd systematically done this on every stock, what's my average outcome?" — it is signal quality, not an achievable portfolio return: these ${k.stockCount} sequences overlap in time and can't all be run with the same rupee at once. The gap between it and the median above is the tell — a few multi-baggers usually carry the average while most individual stocks land near or below it.
  </p>
  <div id="chartbox-returns" class="chart-grid">
    <figure class="chart-box">
      <figcaption class="chart-title">Where the returns land</figcaption>
      <div class="chart-canvas-wrap"><canvas id="chart-returns-dist"></canvas></div>
      <figcaption class="chart-note">Each bar counts trades in that return band. End bands are overflow buckets — GC→DC returns are right-skewed, so a linear axis would hide the shape.</figcaption>
    </figure>
    <figure class="chart-box">
      <figcaption class="chart-title">Median return by sector</figcaption>
      <div class="chart-canvas-wrap"><canvas id="chart-returns-sector"></canvas></div>
      <figcaption class="chart-note">Median, not average — one multi-bagger can drag a sector mean into the thousands of percent. Sectors with at least 5 trades only; sample size is in each label.</figcaption>
    </figure>
  </div>
  <div id="perf-table-wrap"></div>`

  const cols = [
    { label: '★',           key: '_star',      cls: 'star-col', fmt: v => starCell(v) },
    { label: 'Symbol',      key: 'symbol',      cls: 'sym',      fmt: v => esc(v) },
    { label: 'Name',        key: 'name',        cls: 'name',     fmt: v => esc(v) },
    { label: 'Status',      key: 'status',      cls: '',         fmt: v => v === 'open'
        ? '<span class="badge badge-green">Open</span>'
        : '<span class="badge badge-red">Closed</span>' },
    { label: 'Entry Date',  key: 'signal_date', cls: 'mono hide-sm', fmt: v => fmt.date(v) },
    { label: 'Exit Date',   key: 'exit_date',   cls: 'mono hide-xs', fmt: v => v ? fmt.date(v) : '<span class="muted">Holding</span>' },
    { label: 'Held',        key: 'held',        cls: 'num r hide-sm', fmt: v => v == null ? '—' : v + 'd' },
    { label: 'Buy Price',   key: 'price',       cls: 'num r hide-sm', fmt: v => fmt.price(v) },
    { label: 'Exit/CMP',    key: 'cmp',         cls: 'num r',    fmt: v => fmt.price(v) },
    { label: 'Return%',     key: 'return_pct',  cls: 'pct r',    fmt: v => v == null ? '—' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` },
    { label: 'Sector',      key: 'sector',      cls: 'muted hide-xs', fmt: v => esc(v) },
  ]
  renderTable(el('perf-table-wrap'), 'perf', cols, d.trades.map(r => ({ ...r, _star: r.symbol })))
  window.NSECharts?.renderReturnsCharts(d.trades)
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

  const d = await apiFetch(`/api/watchlist?symbols=${wlSyms.join(',')}`)

  const cols = [
    { label: '★',            key: '_star',              cls: 'star-col', fmt: v => starCell(v) },
    { label: 'Symbol',       key: 'symbol',             cls: 'sym',      fmt: v => esc(v) },
    { label: 'Name',         key: 'name',               cls: 'name',     fmt: v => esc(v) },
    { label: 'Strategy',     key: 'strategy_name',      cls: 'hide-sm',  fmt: v => v ? fmt.strat(v) : '—' },
    { label: 'Signal Date',  key: 'signal_date',        cls: 'mono hide-sm', fmt: v => fmt.date(v) },
    { label: 'Signal Price', key: 'signal_price',       cls: 'num r hide-sm', fmt: v => fmt.price(v) },
    { label: 'CMP',          key: 'cmp',                cls: 'num r',    fmt: v => fmt.price(v) },
    { label: 'Return%',      key: 'return_pct',         cls: 'pct r',    fmt: v => v == null ? '—' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` },
    { label: 'EMA9',         key: 'ema9',               cls: 'num r hide-xs', fmt: v => fmt.price(v) },
    { label: 'EMA20',        key: 'ema20',              cls: 'num r hide-xs', fmt: v => fmt.price(v) },
    { label: 'EMA Diff%',    key: 'ema_difference_pct', cls: 'pct r hide-xs', fmt: v => v != null ? `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` : '—' },
    { label: 'Sector',       key: 'sector',             cls: 'muted hide-xs', fmt: v => esc(v) },
  ]
  renderTable(container, 'watchlist', cols, (d.rows || []).map(r => ({ ...r, _star: r.symbol })))
}

// ── Table Renderer ────────────────────────────────────────────────
// opts.server = { col, dir, onSort }: the rows are one page the API already
// filtered and sorted across all data, so neither step may run again here —
// a header click asks the server for a new sort instead.
function renderTable(container, tabId, cols, rows, opts = {}) {
  const server = opts.server
  let display = rows
  if (!server && globalFilters.returnPct !== null) {
    display = display.filter(r => r.return_pct != null && r.return_pct >= globalFilters.returnPct)
  }
  if (!server && globalFilters.watchlistOnly) {
    const wl = getWatchlist()
    display = display.filter(r => wl.has(r.symbol))
  }
  tableData[tabId] = null
  if (!display.length) {
    const msg = (globalFilters.returnPct !== null || globalFilters.watchlistOnly)
      ? 'No stocks match the active filters.' : 'No data to display.'
    empty(container, msg)
    return
  }

  const ss = server || sortState[tabId] || {}
  const sorted = server ? display : sortRows(display, ss.col, ss.dir)
  tableData[tabId] = { cols, rows: sorted }

  const head = cols.map(c => {
    const on = ss.col === c.key
    const sc = on ? (ss.dir === 'asc' ? 'sorted-asc' : 'sorted-desc') : ''
    const star = c.cls?.includes('star-col')
    const attrs = star ? ' style="cursor:default"'
      : (on ? ` aria-sort="${ss.dir === 'asc' ? 'ascending' : 'descending'}"` : '') + (server ? ' title="Sort all matching signals"' : '')
    return `<th class="${c.cls || ''} ${sc}" data-tab="${tabId}" data-col="${c.key}"${attrs}>${c.label}</th>`
  }).join('')

  const body = sorted.map(row =>
    '<tr>' + cols.map(c => {
      const val = c.fmt ? c.fmt(row[c.key]) : (row[c.key] == null ? '—' : esc(String(row[c.key])))
      return `<td class="${c.cls || ''}">${val}</td>`
    }).join('') + '</tr>'
  ).join('')

  // Re-rendering destroys the scroll container, so a sort would throw you back
  // to the far left — after scrolling 600px right to reach the column you just
  // tapped. Carry the offset across the rebuild.
  const keepLeft = container.querySelector('.table-wrap')?.scrollLeft || 0
  container.innerHTML = `<div class="table-wrap"><table id="table-${tabId}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
  if (keepLeft) container.querySelector('.table-wrap').scrollLeft = keepLeft

  container.querySelectorAll('th[data-col]').forEach(th => {
    if (th.classList.contains('star-col')) return
    th.addEventListener('click', () => {
      const col = th.dataset.col, tab = th.dataset.tab
      if (server) return server.onSort(col)
      const cur = sortState[tab] || {}
      sortState[tab] = { col, dir: cur.col === col && cur.dir === 'asc' ? 'desc' : 'asc' }
      renderTable(container, tabId, cols, rows)
    })
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

// ── Formula Sheet Nav ─────────────────────────────────────────────
function initFormulaNav() {
  document.querySelectorAll('.formula-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.formula-nav-btn').forEach(b => b.classList.remove('active'))
      document.querySelectorAll('.formula-section').forEach(s => s.classList.remove('active'))
      btn.classList.add('active')
      const sec = document.getElementById('fsec-' + btn.dataset.section)
      if (sec) sec.classList.add('active')
    })
  })
}

// ── Tab Switching ─────────────────────────────────────────────────
const loaders = {
  crossovers: loadCrossoverTab,
  active:     loadActiveTab,
  history:    () => loadHistoryTab(true),
  perf:       loadPerfTab,
  watchlist:  loadWatchlistTab,
  research:   () => { window.NSEResearch?.init(); window.NSECharts?.initResearchCharts() },
  formulas:   () => { initFormulaNav(); window.NSEFormulas?.init() },
}

// Body container per data tab, where a load failure is shown in place.
const TAB_BODY = { crossovers: 'body-crossovers', active: 'body-active', history: 'body-history', perf: 'body-perf', watchlist: 'body-watchlist' }

async function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab))
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tab}`))
  syncNavLabel(tab)
  if (!loaded[tab]) {
    // Marked before the await so a double click doesn't start two loads, and
    // cleared on failure so the tab can't stay stuck on its spinner.
    loaded[tab] = true
    tableData[tab] = null   // a load that ends empty must not leave the old table exportable
    try {
      await loaders[tab]()
    } catch (e) {
      loaded[tab] = false
      console.error(`Load error (${tab}):`, e)
      const c = el(TAB_BODY[tab])
      if (c) failed(c, () => switchTab(tab))
    }
  }
}

// ── History Filters ───────────────────────────────────────────────
el('filter-apply').addEventListener('click', () => {
  historyFilters = {
    strategy: el('filter-strategy').value || undefined,
    symbol:   el('filter-symbol').value.trim().toUpperCase() || undefined,
    sector:   el('filter-sector').value.trim() || undefined,
    from:     el('filter-from').value || undefined,
    to:       el('filter-to').value || undefined,
  }
  loaded.history = false
  switchTab('history')
})

el('filter-reset').addEventListener('click', () => {
  historyFilters = {}
  ;['filter-strategy', 'filter-symbol', 'filter-sector', 'filter-from', 'filter-to'].forEach(id => el(id).value = '')
  loaded.history = false
  switchTab('history')
})

;['filter-symbol', 'filter-sector', 'filter-from', 'filter-to'].forEach(id =>
  el(id).addEventListener('keydown', e => { if (e.key === 'Enter') el('filter-apply').click() }))

// ── History Page Numbers ──────────────────────────────────────────
function jumpHistoryPage(input) {
  const n = parseInt(input.value, 10)
  if (!Number.isFinite(n)) return
  historyQuery.page = Math.min(+input.max || 1, Math.max(1, n))
  navHistory(true)
}

;['pager-history-top', 'pager-history'].forEach(id => {
  const bar = el(id)
  bar.addEventListener('click', e => {
    const b = e.target.closest('button[data-page]')
    if (!b || b.disabled) return
    historyQuery.page = +b.dataset.page
    navHistory(id === 'pager-history')   // from the bottom bar, go back up to the table's start
  })
  bar.addEventListener('change', e => {
    const kind = e.target.dataset.pager
    if (kind === 'size') {
      historyQuery.pageSize = +e.target.value
      historyQuery.page = 1
      navHistory()
    } else if (kind === 'jump') {
      jumpHistoryPage(e.target)
    }
  })
})

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    closeNav()
    switchTab(btn.dataset.tab)
  })
})

// ── Nav drawer (phones) ───────────────────────────────────────────
// Below 640px the tab strip is a slide-in drawer: seven full tab names need
// roughly 1080px of bar, so on a phone they became a hidden sideways scroll.
// The same .tab-btn elements are reused, so there is one source of truth for
// which tab is active and nothing to keep in sync.
const navBar      = el('tab-bar')
const navToggle   = el('nav-toggle')
const navBackdrop = el('nav-backdrop')

function navIsOpen() { return navBar?.classList.contains('open') }

function openNav() {
  if (!navBar) return
  navBar.classList.add('open')
  navBackdrop.hidden = false
  // Next frame, so the backdrop transitions in rather than appearing at once.
  requestAnimationFrame(() => navBackdrop.classList.add('open'))
  navToggle.setAttribute('aria-expanded', 'true')
  document.body.classList.add('nav-open')
  navBar.querySelector('.tab-btn.active')?.focus()
}

function closeNav() {
  if (!navBar || !navIsOpen()) return
  navBar.classList.remove('open')
  navBackdrop.classList.remove('open')
  navBackdrop.hidden = true
  navToggle.setAttribute('aria-expanded', 'false')
  document.body.classList.remove('nav-open')
}

// The collapsed bar shows which section you are in, so the name must follow
// every route into switchTab — a tab button, a deep link, or a redirect.
function syncNavLabel(tab) {
  const btn = document.querySelector(`.tab-btn[data-tab="${tab}"] .tab-full`)
  const out = el('nav-current')
  if (btn && out) out.textContent = btn.textContent
  // Between the drawer and full labels the strip can still scroll; keep the
  // selected tab in view so it is never stranded off the right edge.
  if (!navIsOpen()) btn?.closest('.tab-btn')?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
}

navToggle?.addEventListener('click', () => (navIsOpen() ? closeNav() : openNav()))
el('nav-close')?.addEventListener('click', closeNav)
navBackdrop?.addEventListener('click', closeNav)
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeNav() })
// Rotating to landscape or resizing past the breakpoint leaves the drawer open
// over a bar that is back in the flow; close it so the page isn't locked.
window.addEventListener('resize', () => { if (window.innerWidth > 640) closeNav() })

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
  loaded.watchlist = false
})

// ── Perf Period Filter ────────────────────────────────────────────
document.querySelectorAll('.perf-period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    perfPeriodDays = parseInt(btn.dataset.days, 10)
    document.querySelectorAll('.perf-period-btn').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    loaded.perf = false
    switchTab('perf')
  })
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
  // Independent: a failed summary must not stop the first tab from loading,
  // and switchTab shows its own error state.
  loadSummary().catch(e => {
    console.error('Summary error:', e)
    el('run-text').textContent = 'Connection error'
    el('run-dot').className = 'dot err'
  })
  await switchTab('crossovers')
}

document.addEventListener('DOMContentLoaded', init)
