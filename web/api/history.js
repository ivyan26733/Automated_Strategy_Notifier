const { db, getExcluded, fetchCmp, fetchNames, fetchAllPaged, send, sendErr } = require('./_utils')

const PAGE_SIZE = 50

// `names` is optional: the fast path still joins stocks(name) per-row (cheap at
// 50 rows), the full-scan path passes a symbol->name map instead (see fetchNames).
function buildRows(clean, cmpMap, names) {
  return clean.map(r => ({
    symbol:             r.symbol,
    name:               names ? (names[r.symbol] || '') : (r.stocks?.name || ''),
    signal_date:        r.signal_date,
    strategy_name:      r.strategy_name,
    signal_type:        r.signal_type,
    price:              r.price,
    cmp:                cmpMap[r.symbol] ?? null,
    return_pct:         (cmpMap[r.symbol] && r.price) ? (cmpMap[r.symbol] / r.price - 1) * 100 : null,
    ema_difference_pct: r.ema_difference_pct,
    breakout_pct:       r.breakout_pct,
    sector:             r.sector,
  }))
}

module.exports = async (req, res) => {
  try {
    const { page = '1', strategy, symbol, sector, from, to, minReturn, watchlistOnly, watchlist } = req.query
    const pageNum = Math.max(1, parseInt(page, 10))
    const offset  = (pageNum - 1) * PAGE_SIZE

    // Strip "undefined" / "null" strings that URLSearchParams can inject
    const val = v => (v && v !== 'undefined' && v !== 'null') ? v : undefined
    const strategyVal   = val(strategy)
    const symbolVal     = val(symbol)
    const sectorVal     = val(sector)
    const fromVal       = val(from)
    const toVal         = val(to)
    const minReturnVal  = val(minReturn) != null ? parseFloat(val(minReturn)) : null
    const wlOnly        = val(watchlistOnly) === '1'
    const watchlistSet  = wlOnly ? new Set((val(watchlist) || '').split(',').filter(Boolean)) : null

    const applyFilters = q => {
      if (strategyVal) q = q.eq('strategy_name', strategyVal)
      if (symbolVal)   q = q.ilike('symbol', `%${symbolVal}%`)
      if (sectorVal)   q = q.ilike('sector', `%${sectorVal}%`)
      if (fromVal)     q = q.gte('signal_date', fromVal)
      if (toVal)       q = q.lte('signal_date', toVal)
      return q
    }

    const excluded = await getExcluded()

    // Return% and Watchlist-only filter on values that aren't stored columns —
    // return_pct is computed from a live CMP lookup, and watchlist membership
    // lives in the browser's localStorage. The DB can't filter on either, so
    // a naive per-page fetch (fast path below) only checks the 50 rows on the
    // current page: with these filters active, most pages come back with zero
    // matches and "Load More" degenerates into a hunt. Fixed by fetching every
    // row matching the cheap filters, computing return_pct for all of them,
    // filtering, and paginating the RESULT — so the requested page always has
    // real rows to show (or genuinely doesn't exist).
    const needsFullScan = minReturnVal != null || wlOnly

    if (!needsFullScan) {
      const { data, count, error } = await applyFilters(
        db.from('signals')
          .select('signal_date, strategy_name, signal_type, symbol, price, ema_difference_pct, breakout_pct, sector, stocks(name)', { count: 'exact' })
          .order('signal_date', { ascending: false })
      ).range(offset, offset + PAGE_SIZE - 1)

      if (error) return sendErr(res, error.message)

      const clean = (data || []).filter(r => !excluded.has(r.symbol))
      const cmpMap = await fetchCmp(clean.map(r => r.symbol))

      return send(res, {
        total:    count ?? 0,
        page:     pageNum,
        pageSize: PAGE_SIZE,
        hasMore:  offset + PAGE_SIZE < (count ?? 0),
        rows:     buildRows(clean, cmpMap),
      })
    }

    // Full-scan path. Paginated with .range() (see fetchAllPaged) so a wide
    // date range can't silently truncate the way a bare .limit() did before.
    // No stocks(name) join here — joining on every one of tens of thousands of
    // rows to fetch a name that repeats per symbol measured 2x slower than
    // fetching bare and looking names up for the ~1-2k distinct symbols after.
    const allMatching = await fetchAllPaged(() =>
      applyFilters(
        db.from('signals')
          .select('signal_date, strategy_name, signal_type, symbol, price, ema_difference_pct, breakout_pct, sector', { count: 'exact' })
          .order('signal_date', { ascending: false })
          .order('symbol', { ascending: true })   // deterministic tiebreak across range() pages
      )
    )

    let clean = allMatching.filter(r => !excluded.has(r.symbol))
    if (watchlistSet) clean = clean.filter(r => watchlistSet.has(r.symbol))

    const distinctSyms = [...new Set(clean.map(r => r.symbol))]
    const [cmpMap, names] = await Promise.all([fetchCmp(distinctSyms), fetchNames(distinctSyms)])
    let rows = buildRows(clean, cmpMap, names)

    if (minReturnVal != null) {
      rows = rows.filter(r => r.return_pct != null && r.return_pct >= minReturnVal)
    }

    const total = rows.length
    const paged = rows.slice(offset, offset + PAGE_SIZE)

    send(res, {
      total,
      page:     pageNum,
      pageSize: PAGE_SIZE,
      hasMore:  offset + PAGE_SIZE < total,
      rows:     paged,
    })
  } catch (e) {
    sendErr(res, e.message)
  }
}
