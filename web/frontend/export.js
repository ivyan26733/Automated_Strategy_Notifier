/* Excel export — a "Download Excel" button on every stock tab.
 *
 * Fresh, Active, Returns and Watchlist export the table exactly as shown (same
 * global filters, same sort). Signal History exports every row matching its
 * filters, not just the page on screen, fetched from the API in large pages.
 * SheetJS is loaded from the CDN on the first click only.
 */
;(function () {
  const XLSX_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
  const TABS = {
    crossovers: 'Fresh Crossovers',
    active:     'Active EMA',
    history:    'Signal History',
    perf:       'Returns',
    watchlist:  'Watchlist',
  }
  const DATE_KEYS = new Set(['signal_date', 'exit_date'])
  const PERIODS = { 0: 'All', 90: '3M', 180: '6M', 365: '1Y', 1095: '3Y', 1825: '5Y', 3650: '10Y' }

  let xlsxReady = null
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX)
    xlsxReady = xlsxReady || new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = XLSX_SRC
      s.onload = () => resolve(window.XLSX)
      s.onerror = () => { xlsxReady = null; reject(new Error('Could not load the Excel library')) }
      document.head.appendChild(s)
    })
    return xlsxReady
  }

  // 'YYYY-MM-DD…' → Excel serial day. Built from the date digits, not a Date in
  // local time, so the cell can't slip a day across timezones.
  function excelDate(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v || '')
    if (!m) return null
    return (Date.UTC(+m[1], m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000
  }

  function daysSince(v) {
    if (!v) return null
    return Math.floor((Date.now() - new Date(v)) / 86400000)
  }

  function round2(v) { return typeof v === 'number' ? Math.round(v * 100) / 100 : v }

  // Plain cell values — the on-screen formatters return HTML badges and spans.
  function cellValue(key, row) {
    const v = row[key]
    if (key === '_held') return daysSince(row.signal_date)
    if (DATE_KEYS.has(key)) return excelDate(v)
    if (key === 'strategy_name') return v === 'ema_crossover' ? 'EMA Cross' : v === 'breakout_6m' ? '6M Breakout' : v ?? null
    if (key === 'signal_type') return v === 'golden_cross' ? 'Golden cross' : v === 'death_cross' ? 'Death cross' : v ?? null
    if (key === 'status') return v === 'open' ? 'Open' : v === 'closed' ? 'Closed' : null
    return round2(v ?? null)
  }

  function headerLabel(c) {
    return c.key === '_held' || c.key === 'held' ? 'Held (days)' : c.label
  }

  function buildSheet(XLSX, cols, rows) {
    const use = cols.filter(c => c.key !== '_star')
    const aoa = [use.map(headerLabel), ...rows.map(r => use.map(c => cellValue(c.key, r)))]
    const ws = XLSX.utils.aoa_to_sheet(aoa)

    use.forEach((c, ci) => {
      if (!DATE_KEYS.has(c.key)) return
      for (let ri = 1; ri < aoa.length; ri++) {
        const cell = ws[XLSX.utils.encode_cell({ r: ri, c: ci })]
        if (cell && cell.t === 'n') cell.z = 'dd-mmm-yyyy'
      }
    })
    ws['!cols'] = use.map((c, ci) => {
      if (DATE_KEYS.has(c.key)) return { wch: 12 }
      const longest = aoa.slice(0, 500).reduce((n, r) => Math.max(n, String(r[ci] ?? '').length), 0)
      return { wch: Math.min(40, Math.max(8, longest + 2)) }
    })
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: use.length - 1 } }) }
    return ws
  }

  // Same query the History tab sends, so the file matches what the tab lists.
  async function fetchAllHistory(onProgress) {
    const params = { sort: historyQuery.sort, dir: historyQuery.dir, ...historyFilters, export: '1' }
    if (globalFilters.returnPct !== null) params.minReturn = globalFilters.returnPct
    if (globalFilters.watchlistOnly) {
      params.watchlistOnly = '1'
      params.watchlist = [...getWatchlist()].join(',')
    }
    const rows = []
    let page = 1, pages = 1
    do {
      params.page = page
      const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''))
      const d = await apiFetch(`/api/history?${qs}`)
      rows.push(...d.rows)
      pages = d.pages
      onProgress(page, pages)
      page++
    } while (page <= pages)
    return rows
  }

  function fileName(tab) {
    const today = new Date()
    const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const extra = tab === 'perf' ? `_${PERIODS[perfPeriodDays] || perfPeriodDays + 'd'}` : ''
    return `NSE_${TABS[tab].replace(/\s+/g, '_')}${extra}_${stamp}.xlsx`
  }

  function flash(btn, text, ms = 2500) {
    btn.textContent = text
    setTimeout(() => { btn.textContent = btn.dataset.label; btn.disabled = false }, ms)
  }

  async function exportTab(tab, btn) {
    if (btn.disabled) return
    btn.disabled = true
    btn.textContent = 'Preparing…'
    try {
      const XLSX = await loadXlsx()
      let cols, rows
      if (tab === 'history') {
        cols = HISTORY_COLS
        rows = await fetchAllHistory((p, n) => { if (n > 1) btn.textContent = `Fetching ${p}/${n}…` })
      } else {
        const t = tableData[tab]
        cols = t?.cols
        rows = t?.rows
      }
      if (!rows?.length) return flash(btn, 'Nothing to export')

      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, buildSheet(XLSX, cols, rows), TABS[tab].slice(0, 31))
      XLSX.writeFile(wb, fileName(tab), { compression: true })
      flash(btn, `✓ ${rows.length.toLocaleString('en-IN')} rows`)
    } catch (e) {
      console.error('Excel export error:', e)
      flash(btn, 'Export failed — retry')
    }
  }

  Object.keys(TABS).forEach(tab => {
    const header = document.querySelector(`#panel-${tab} .panel-header`)
    if (!header) return
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn btn-secondary'
    btn.style.cssText = 'margin-left:auto;padding:6px 12px;font-size:13px;white-space:nowrap'
    btn.dataset.label = '⬇ Download Excel'
    btn.textContent = btn.dataset.label
    btn.title = tab === 'history'
      ? 'Download every signal matching the current filters and sort as an .xlsx file'
      : 'Download this table, as shown, as an .xlsx file'
    btn.addEventListener('click', () => exportTab(tab, btn))
    header.appendChild(btn)
  })
})()
