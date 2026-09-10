const {
  db, getExcluded, fetchCmp, fetchNames, fetchAllPaged,
  buildEmaEpisodeIndex, fetchEmaHistory, emaRowKey,
  send, sendErr,
} = require('./_utils')

const PAGE_SIZE = 50

// `names` is optional: the fast path still joins stocks(name) per-row (cheap at
// 50 rows), the full-scan path passes a symbol->name map instead (see fetchNames).
//
// Return% for an ema_crossover row is matched to its real trade episode, not
// computed against today's price: closed shows the actual entry->exit return
// with Exit/CMP set to the exit price; still-open shows the unrealized return
// marked to today, same as before. A signal from years ago that already exited
// no longer inherits a decade of unrelated price drift. breakout_6m has no
// exit-signal counterpart to match against, so it keeps the previous
// mark-to-today calculation unchanged.
//
// Price is also taken from the episode (ep.entryPrice), not the raw row's own
// price. A cross re-fires on every daily run while its weekly bar is still
// developing, so a row DATED after the real entry can still belong to that
// same episode — e.g. a genuine entry on Sep 2 re-fires again on Sep 8 and
// Sep 9 (see buildEmaEpisodeIndex). Showing that later row's own raw price as
// "Signal Price" while computing Return% from the Sep 2 entry would put two
// numbers on one row that don't reconcile with each other. Using the episode's
// entry price for every row it touches keeps Price / Exit-CMP / Return%
// internally consistent no matter which underlying duplicate is being shown.
function buildRows(clean, cmpMap, names, episodeIndex) {
  return clean.map(r => {
    const ep = r.strategy_name === 'ema_crossover' ? episodeIndex.get(emaRowKey(r)) : null

    let price = r.price, cmp, return_pct, status = null
    if (ep) {
      price = ep.entryPrice
      if (ep.exitDate != null) {
        cmp = ep.exitPrice
        return_pct = ep.entryPrice ? (ep.exitPrice / ep.entryPrice - 1) * 100 : null
        status = 'closed'
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
      name:               names ? (names[r.symbol] || '') : (r.stocks?.name || ''),
      signal_date:        r.signal_date,
      strategy_name:      r.strategy_name,
      signal_type:        r.signal_type,
      price, cmp, return_pct, status,
      ema_difference_pct: r.ema_difference_pct,
      breakout_pct:       r.breakout_pct,
      sector:             r.sector,
    }
  })
}

// A cross re-fires on every daily run while its weekly bar is still developing
// (see buildEmaEpisodeIndex), leaving several rows — one per re-fire date —
// for the SAME real entry or exit. Only the row whose own signal_date matches
// the episode's actual entry/exit date is the real event; every other row
// mapped to that same episode is a same-priced echo of it and must not be
// displayed. breakout_6m has no episode concept here (episodeIndex only ever
// holds ema_crossover keys), so every one of its rows passes through unchanged
// — that strategy's own re-fire behavior is a separate, strategy-level issue,
// not something this display-layer filter should paper over.
function isEpisodeAnchor(r, episodeIndex) {
  if (r.strategy_name !== 'ema_crossover') return true
  const ep = episodeIndex.get(emaRowKey(r))
  if (!ep) return true   // no episode on record (e.g. orphan leading death_cross) — nothing to collapse against
  const boundary = r.signal_type === 'golden_cross' ? ep.entryDate : ep.exitDate
  return boundary === r.signal_date
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
    // return_pct is now matched against each row's real trade episode, and
    // watchlist membership lives in the browser's localStorage. The DB can't
    // filter on either, so a naive per-page fetch (fast path below) only checks
    // the 50 rows on the current page: with these filters active, most pages come
    // back with zero matches and "Load More" degenerates into a hunt. Fixed by
    // fetching every row matching the cheap filters, computing return_pct for
    // all of them, filtering, and paginating the RESULT — so the requested page
    // always has real rows to show (or genuinely doesn't exist).
    const needsFullScan = minReturnVal != null || wlOnly

    if (!needsFullScan) {
      // Fast path, but re-fire duplicates (see isEpisodeAnchor) have to be
      // dropped before a page can be filled from raw rows — a plain single
      // .range() can no longer promise 50 real rows once some raw rows in
      // that range are echoes of an episode already shown elsewhere. A
      // re-fire duplicate sits within a few rows of its anchor (same
      // developing week), so fetch in growing chunks and keep going only
      // until enough SURVIVING rows exist to fill this page plus one more
      // (to know whether a further page exists) — that stays close to the
      // cost of a plain .range() for ordinary page depths, instead of
      // scanning the whole table the way the filtered path below must.
      const CHUNK = PAGE_SIZE * 3
      const target = offset + PAGE_SIZE + 1
      let episodeIndex = new Map()
      const historySeenSyms = new Set()
      let collected = []
      let rawOffset = 0
      let rawTotal = 0

      while (collected.length < target) {
        const { data, count, error } = await applyFilters(
          db.from('signals')
            .select('signal_date, strategy_name, signal_type, symbol, price, ema_difference_pct, breakout_pct, sector, stocks(name)', { count: 'exact' })
            .order('signal_date', { ascending: false })
            .order('symbol', { ascending: true })
        ).range(rawOffset, rawOffset + CHUNK - 1)

        if (error) return sendErr(res, error.message)
        rawTotal = count ?? 0

        const chunk = (data || []).filter(r => !excluded.has(r.symbol))
        const newEmaSyms = [...new Set(
          chunk.filter(r => r.strategy_name === 'ema_crossover' && !historySeenSyms.has(r.symbol)).map(r => r.symbol)
        )]
        if (newEmaSyms.length) {
          const hist = await fetchEmaHistory(newEmaSyms)
          const idx = buildEmaEpisodeIndex(hist)
          for (const [k, v] of idx) episodeIndex.set(k, v)
          for (const s of newEmaSyms) historySeenSyms.add(s)
        }

        for (const r of chunk) {
          if (!isEpisodeAnchor(r, episodeIndex)) continue   // drop re-fire duplicate
          collected.push(r)
        }

        if (!data || data.length < CHUNK) break   // raw table exhausted
        rawOffset += CHUNK
      }

      const pageRaw  = collected.slice(offset, offset + PAGE_SIZE)
      const hasMore  = collected.length > offset + PAGE_SIZE
      const cmpMap   = await fetchCmp(pageRaw.map(r => r.symbol))

      return send(res, {
        total:    rawTotal,
        page:     pageNum,
        pageSize: PAGE_SIZE,
        hasMore,
        rows:     buildRows(pageRaw, cmpMap, null, episodeIndex),
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
    const emaSyms = [...new Set(clean.filter(r => r.strategy_name === 'ema_crossover').map(r => r.symbol))]

    // Filtering must use the SAME return_pct being displayed, so the episode
    // match has to run over the full candidate set here, not just the page
    // eventually shown — this is the expensive part of an unnarrowed Return%
    // scan (emaSyms can approach the whole universe), same cost class as the
    // 10Y/All-time button on the Returns tab.
    //
    // fetchEmaHistory is run on its own, not folded into the Promise.all below:
    // it already opens up to PAGE_CONCURRENCY (40) connections internally for a
    // scan this wide, and stacking fetchCmp's and fetchNames' own chunked
    // concurrency on top of that in the same instant is what caused an
    // intermittent "fetch failed" under load — the combined burst exceeded a
    // connection limit that none of the three would hit on its own.
    const emaHistory = await fetchEmaHistory(emaSyms)
    const [cmpMap, names] = await Promise.all([fetchCmp(distinctSyms), fetchNames(distinctSyms)])
    const episodeIndex = buildEmaEpisodeIndex(emaHistory)

    // Same re-fire collapse as the fast path above: keep only the row that IS
    // its episode's real entry/exit date, drop every echo of it.
    clean = clean.filter(r => isEpisodeAnchor(r, episodeIndex))

    let rows = buildRows(clean, cmpMap, names, episodeIndex)

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
