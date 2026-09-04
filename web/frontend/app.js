/* NSE Stock Screener — frontend (thin client, all data from /api/*) */

// ── State ─────────────────────────────────────────────────────────
let historyPage    = 1
let historyTotal   = 0
let historyFilters = {}
let historyAllRows = []
let sortState      = {}
let loaded         = {}
let globalFilters  = { returnPct: null, watchlistOnly: false }
let perfPeriodDays = 365

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
function loading(c) { c.innerHTML = '<div class="state-box"><div class="spinner"></div><span class="state-title">Loading…</span></div>' }
function empty(c, msg, sub = '') { c.innerHTML = `<div class="state-box"><span class="state-title">${esc(msg)}</span>${sub ? `<span class="state-sub">${esc(sub)}</span>` : ''}</div>` }

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
  el('kpi-crossovers').innerHTML = `<div class="kpi-label">EMA Crossovers</div><div class="kpi-value">${fmt.num(d.freshEmaCount)}</div><div class="kpi-sub">Fresh &amp; active · last 4 weeks</div>`
  el('kpi-breakouts').innerHTML  = `<div class="kpi-label">6M Breakouts</div><div class="kpi-value">${fmt.num(d.freshBrkCount)}</div><div class="kpi-sub">Last 30 days</div>`
  el('kpi-signals').innerHTML    = `<div class="kpi-label">Total Signals</div><div class="kpi-value">${fmt.num(d.totalSignals)}</div><div class="kpi-sub">All time · ${obsSub}</div>`
}

// ── Tab 1: Fresh EMA Crossovers ───────────────────────────────────
async function loadCrossoverTab() {
  const container = el('body-crossovers')
  loading(container)

  const d = await apiFetch('/api/crossovers')
  if (!d.rows?.length) {
    empty(container, 'No EMA crossovers in the last 4 weeks.', 'The scanner will populate this after daily runs.')
    return
  }

  el('meta-crossovers').textContent = `Golden crosses in last 4 weeks still active · ${fmt.date(d.cutoff)} → ${fmt.date(d.obsDate)}`

  const cols = [
    { label: '★',            key: '_star',             cls: 'star-col', fmt: v => starCell(v) },
    { label: 'Symbol',       key: 'symbol',            cls: 'sym',      fmt: v => esc(v) },
    { label: 'Name',         key: 'name',              cls: 'name',     fmt: v => esc(v) },
    { label: 'Cross Date',   key: 'signal_date',       cls: 'mono',     fmt: v => fmt.date(v) },
    { label: 'Held',         key: 'signal_date',       cls: 'mono',     fmt: v => fmt.days(v) },
    { label: 'Signal Price', key: 'price',             cls: 'num r',    fmt: v => fmt.price(v) },
    { label: 'CMP',          key: 'cmp',               cls: 'num r',    fmt: v => fmt.price(v) },
    { label: 'Return%',      key: 'return_pct',        cls: 'pct r',    fmt: v => v == null ? '—' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` },
    { label: 'EMA9',         key: 'ema9',              cls: 'num r',    fmt: v => fmt.price(v) },
    { label: 'EMA20',        key: 'ema20',             cls: 'num r',    fmt: v => fmt.price(v) },
    { label: 'EMA Diff%',    key: 'ema_difference_pct',cls: 'pct r',   fmt: v => `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` },
    { label: 'Sector',       key: 'sector',            cls: 'muted',    fmt: v => esc(v) },
  ]
  renderTable(container, 'crossovers', cols, d.rows.map(r => ({ ...r, _star: r.symbol })))
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
async function loadActiveTab() {
  const container = el('body-active')
  loading(container)

  const d = await apiFetch('/api/active')
  if (!d.rows?.length) {
    empty(container, 'No stocks currently above EMA9 > EMA20.')
    el('meta-active').textContent = ''
    return
  }

  el('meta-active').textContent = `${d.activeCount} stocks above EMA9 > EMA20 · as of ${fmt.date(d.obsDate)}`

  const cols = [
    { label: '★',            key: '_star',             cls: 'star-col', fmt: v => starCell(v) },
    { label: 'Symbol',       key: 'symbol',            cls: 'sym',      fmt: v => esc(v) },
    { label: 'Name',         key: 'name',              cls: 'name',     fmt: v => esc(v) },
    { label: 'Cross Date',   key: 'signal_date',       cls: 'mono',     fmt: v => fmt.date(v) },
    { label: 'Held',         key: 'signal_date',       cls: 'mono',     fmt: v => fmt.days(v) },
    { label: 'Signal Price', key: 'signal_price',      cls: 'num r',    fmt: v => fmt.price(v) },
    { label: 'CMP',          key: 'cmp',               cls: 'num r',    fmt: v => fmt.price(v) },
    { label: 'Return%',      key: 'return_pct',        cls: 'pct r',    fmt: v => v == null ? '—' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` },
    { label: 'EMA9',         key: 'ema9',              cls: 'num r',    fmt: v => fmt.price(v) },
    { label: 'EMA20',        key: 'ema20',             cls: 'num r',    fmt: v => fmt.price(v) },
    { label: 'EMA Diff%',    key: 'ema_difference_pct',cls: 'pct r',   fmt: v => `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` },
    { label: 'Sector',       key: 'sector',            cls: 'muted',    fmt: v => esc(v) },
  ]
  renderTable(container, 'active', cols, d.rows.map(r => ({ ...r, _star: r.symbol })))
}

// ── Tab 4: Signal History ─────────────────────────────────────────
async function loadHistoryTab(reset = false) {
  const container = el('body-history')
  if (reset) { historyPage = 1; historyAllRows = []; loading(container) }

  const params = new URLSearchParams(
    Object.fromEntries(
      Object.entries({ page: historyPage, ...historyFilters })
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
    )
  )
  const d = await apiFetch(`/api/history?${params}`)

  if (!d.rows?.length) {
    if (reset) empty(container, 'No signals match your filters.')
    el('load-more-history').hidden = true
    return
  }

  historyTotal = d.total
  el('meta-history').textContent = `${fmt.num(historyTotal)} total signals`

  const cols = [
    { label: '★',            key: '_star',              cls: 'star-col', fmt: v => starCell(v) },
    { label: 'Date',         key: 'signal_date',        cls: 'mono',     fmt: v => fmt.date(v) },
    { label: 'Symbol',       key: 'symbol',             cls: 'sym',      fmt: v => esc(v) },
    { label: 'Name',         key: 'name',               cls: 'name',     fmt: v => esc(v) },
    { label: 'Strategy',     key: 'strategy_name',      cls: '',         fmt: v => fmt.strat(v) },
    { label: 'Type',         key: 'signal_type',        cls: '',         fmt: v => fmt.type(v) },
    { label: 'Signal Price', key: 'price',              cls: 'num r',    fmt: v => fmt.price(v) },
    { label: 'CMP',          key: 'cmp',                cls: 'num r',    fmt: v => fmt.price(v) },
    { label: 'Return%',      key: 'return_pct',         cls: 'pct r',    fmt: v => v == null ? '—' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` },
    { label: 'EMA Diff%',    key: 'ema_difference_pct', cls: 'pct r',   fmt: v => v != null ? `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` : '—' },
    { label: 'Brk%',         key: 'breakout_pct',       cls: 'pct r',   fmt: v => v != null ? `<span class="pos">${fmt.pct(v)}</span>` : '—' },
    { label: 'Sector',       key: 'sector',             cls: 'muted',    fmt: v => esc(v) },
  ]

  const newRows = d.rows.map(r => ({ ...r, _star: r.symbol }))
  historyPage++

  if (reset) {
    historyAllRows = newRows
    renderTable(container, 'history', cols, historyAllRows)
  } else {
    historyAllRows = historyAllRows.concat(newRows)
    appendRows('table-history', cols, newRows)
  }

  el('load-more-history').hidden = !d.hasMore
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

  el('meta-perf').textContent = `${periodLabel} · entry at golden cross · exit at death cross or still holding`

  if (!d.trades?.length) {
    empty(container, 'No qualifying crossovers found.', 'No crosses found in this period.')
    return
  }

  const k = d.kpis
  const retStr = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%'

  container.innerHTML = `<div class="perf-summary">
    <div class="perf-kpi">
      <div class="perf-kpi-val neutral">${d.trades.length}</div>
      <div class="perf-kpi-label">Total Trades</div>
      <div class="perf-kpi-sub">${k.openCount} open · ${k.closedCount} closed · ${periodLabel}</div>
    </div>
    <div class="perf-kpi">
      <div class="perf-kpi-val ${k.avgRet == null ? '' : k.avgRet >= 0 ? 'pos' : 'neg'}">${retStr(k.avgRet)}</div>
      <div class="perf-kpi-label">Avg Return</div>
      <div class="perf-kpi-sub">Equal-weight · open + closed · ${periodLabel}</div>
    </div>
    <div class="perf-kpi">
      <div class="perf-kpi-val pos">${retStr(k.best)}</div>
      <div class="perf-kpi-label">Best Trade</div>
      <div class="perf-kpi-sub">${periodLabel}</div>
    </div>
    <div class="perf-kpi">
      <div class="perf-kpi-val ${k.worst != null && k.worst < 0 ? 'neg' : 'pos'}">${retStr(k.worst)}</div>
      <div class="perf-kpi-label">Worst Trade</div>
      <div class="perf-kpi-sub">${periodLabel}</div>
    </div>
    <div class="perf-kpi">
      <div class="perf-kpi-val neutral">${k.hitRate == null ? '—' : k.hitRate.toFixed(0) + '%'}</div>
      <div class="perf-kpi-label">Win Rate</div>
      <div class="perf-kpi-sub">${k.nPos} of ${k.withRetCount} profitable · ${periodLabel}</div>
    </div>
  </div>
  <div id="perf-table-wrap"></div>`

  const cols = [
    { label: '★',           key: '_star',      cls: 'star-col', fmt: v => starCell(v) },
    { label: 'Symbol',      key: 'symbol',      cls: 'sym',      fmt: v => esc(v) },
    { label: 'Name',        key: 'name',        cls: 'name',     fmt: v => esc(v) },
    { label: 'Status',      key: 'status',      cls: '',         fmt: v => v === 'open'
        ? '<span class="badge badge-green">Open</span>'
        : '<span class="badge badge-red">Closed</span>' },
    { label: 'Entry Date',  key: 'signal_date', cls: 'mono',     fmt: v => fmt.date(v) },
    { label: 'Exit Date',   key: 'exit_date',   cls: 'mono',     fmt: v => v ? fmt.date(v) : '<span class="muted">Holding</span>' },
    { label: 'Held',        key: 'held',        cls: 'num r',    fmt: v => v == null ? '—' : v + 'd' },
    { label: 'Buy Price',   key: 'price',       cls: 'num r',    fmt: v => fmt.price(v) },
    { label: 'Exit/CMP',    key: 'cmp',         cls: 'num r',    fmt: v => fmt.price(v) },
    { label: 'Return%',     key: 'return_pct',  cls: 'pct r',    fmt: v => v == null ? '—' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` },
    { label: 'Sector',      key: 'sector',      cls: 'muted',    fmt: v => esc(v) },
  ]
  renderTable(el('perf-table-wrap'), 'perf', cols, d.trades.map(r => ({ ...r, _star: r.symbol })))
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
    { label: 'Strategy',     key: 'strategy_name',      cls: '',         fmt: v => v ? fmt.strat(v) : '—' },
    { label: 'Signal Date',  key: 'signal_date',        cls: 'mono',     fmt: v => fmt.date(v) },
    { label: 'Signal Price', key: 'signal_price',       cls: 'num r',    fmt: v => fmt.price(v) },
    { label: 'CMP',          key: 'cmp',                cls: 'num r',    fmt: v => fmt.price(v) },
    { label: 'Return%',      key: 'return_pct',         cls: 'pct r',    fmt: v => v == null ? '—' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` },
    { label: 'EMA9',         key: 'ema9',               cls: 'num r',    fmt: v => fmt.price(v) },
    { label: 'EMA20',        key: 'ema20',              cls: 'num r',    fmt: v => fmt.price(v) },
    { label: 'EMA Diff%',    key: 'ema_difference_pct', cls: 'pct r',   fmt: v => v != null ? `<span class="${v >= 0 ? 'pos' : 'neg'}">${fmt.pct(v)}</span>` : '—' },
    { label: 'Sector',       key: 'sector',             cls: 'muted',    fmt: v => esc(v) },
  ]
  renderTable(container, 'watchlist', cols, (d.rows || []).map(r => ({ ...r, _star: r.symbol })))
}

// ── Table Renderer ────────────────────────────────────────────────
function renderTable(container, tabId, cols, rows) {
  let display = rows
  if (globalFilters.returnPct !== null) {
    display = display.filter(r => r.return_pct != null && r.return_pct >= globalFilters.returnPct)
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
    strategy: el('filter-strategy').value || undefined,
    symbol:   el('filter-symbol').value.trim().toUpperCase() || undefined,
    sector:   el('filter-sector').value.trim() || undefined,
    from:     el('filter-from').value || undefined,
    to:       el('filter-to').value || undefined,
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
  loaded.watchlist = false
})

// ── Perf Period Filter ────────────────────────────────────────────
document.querySelectorAll('.perf-period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    perfPeriodDays = parseInt(btn.dataset.days, 10)
    document.querySelectorAll('.perf-period-btn').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    loadPerfTab()
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
