const { db, daysAgo, addDays, getObsContext, getExcluded, fetchCmp, parseListingDate, fetchAllPaged, send, sendErr } = require('./_utils')

// ── Per-symbol timeline ──────────────────────────────────────────────
// A cross detected on the in-progress weekly bar re-fires on every daily run —
// signal_date advances with the bar's observation_date, so one real cross can
// leave several rows (see _utils.js getEpisodes for the same issue on entries).
// Unlike the current-episode case, a full trade history can have GENUINELY
// repeated same-type events separated by a real opposite-type signal in between
// (a stock can cross up, fall back down, and cross up again weeks later) — so
// the correct dedupe rule is general, not week-bounded: collapse a row only
// when the immediately preceding KEPT row is the same type. That is exactly
// what a re-fire looks like, and exactly what a genuine second event does not.
function collapseReFires(rows) {
  const out = []
  for (const r of rows) {
    const last = out[out.length - 1]
    if (last && last.signal_type === r.signal_type) continue
    out.push(r)
  }
  return out
}

// Walk one symbol's deduped, chronological GC/DC sequence and produce:
//   - trades: realized entry/exit pairs, plus one open leg if still holding
//   - capital: ₹100 compounded through every closed cycle in the window,
//     marked to market on any open leg (cmp may be null if no live indicator row)
// A leading death_cross is dropped: it closes a position opened before this
// window started, so it isn't a valid entry point for this window's compounding.
function walkTimeline(timeline, { symbol, name, sector, cmp, obsDate, daysBetween }) {
  let i = 0
  if (timeline[i]?.signal_type === 'death_cross') i++

  let capital = 100
  let anyEntry = false
  let openEntry = null
  const trades = []

  for (; i < timeline.length; i++) {
    const sig = timeline[i]
    if (sig.signal_type === 'golden_cross') {
      if (openEntry) continue          // guarded by collapseReFires; defensive only
      openEntry = sig
      anyEntry = true
    } else if (openEntry) {            // death_cross closing the open entry
      const ret = (sig.price / openEntry.price - 1) * 100
      capital *= sig.price / openEntry.price
      trades.push({
        symbol, name, sector, status: 'closed',
        signal_date: openEntry.signal_date, exit_date: sig.signal_date,
        held: daysBetween(openEntry.signal_date, sig.signal_date),
        price: openEntry.price, cmp: sig.price, return_pct: ret,
      })
      openEntry = null
    }
  }

  if (openEntry) {
    const ret = cmp != null ? (cmp / openEntry.price - 1) * 100 : null
    trades.push({
      symbol, name, sector, status: 'open',
      signal_date: openEntry.signal_date, exit_date: null,
      held: daysBetween(openEntry.signal_date, obsDate),
      price: openEntry.price, cmp: cmp ?? null, return_pct: ret,
    })
    if (cmp != null) capital *= cmp / openEntry.price
    // cmp missing (no live indicator row) → open leg not marked to market;
    // capital stays at its last booked value rather than guessing.
  }

  return { capital, anyEntry, trades }
}

function median(xs) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

module.exports = async (req, res) => {
  try {
    const period = parseInt(req.query.period ?? '365', 10)
    const { obsDate, activeSet } = await getObsContext()
    if (!obsDate) return send(res, { obsDate: null, trades: [], kpis: {} })

    const lookbackDays = period === 0 ? 7300 : period
    const cutoffOld = daysAgo(obsDate, lookbackDays)
    const daysBetween = (d1, d2) => Math.round((new Date(d2) - new Date(d1)) / 86400000)

    // Every golden/death cross in the window, for every symbol, paginated so a
    // wide window (10Y/All) cannot silently truncate the way an unbounded
    // .limit() did before (see active.js's 578-blank-Cross-Date bug).
    const rawSignals = await fetchAllPaged(() =>
      db.from('signals')
        .select('symbol, signal_type, signal_date, price, sector, created_at, stocks(name, date_of_listing)', { count: 'exact' })
        .eq('strategy_name', 'ema_crossover')
        .in('signal_type', ['golden_cross', 'death_cross'])
        .gte('signal_date', cutoffOld)
        .lte('signal_date', obsDate)
        .order('symbol', { ascending: true })
        .order('signal_date', { ascending: true })
        .order('created_at', { ascending: true })
    )

    if (!rawSignals.length) return send(res, { obsDate, period, trades: [], kpis: {} })

    const excluded = await getExcluded()

    const bySymbol = new Map()
    for (const r of rawSignals) {
      if (excluded.has(r.symbol)) continue
      if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, [])
      bySymbol.get(r.symbol).push(r)
    }

    const cmpMap = await fetchCmp([...bySymbol.keys()].filter(s => activeSet.has(s)))

    const stockResults = []
    for (const [symbol, rows] of bySymbol) {
      const meta = rows[0]?.stocks || {}
      const ld = parseListingDate(meta.date_of_listing)
      const minGcDate = ld ? addDays(ld, 182) : null

      // Drop IPO-noise golden crosses (within 182d of listing); death crosses
      // are never filtered — they only close positions, never open one.
      const filtered = rows.filter(r =>
        r.signal_type !== 'golden_cross' || !minGcDate || r.signal_date >= minGcDate)

      const timeline = collapseReFires(filtered)
      if (!timeline.length) continue

      const { capital, anyEntry, trades } = walkTimeline(timeline, {
        symbol, name: meta.name || '', sector: rows[0]?.sector || '',
        cmp: cmpMap[symbol] ?? null, obsDate, daysBetween,
      })

      if (!anyEntry) continue   // no valid entry in this window — excluded from the average,
                                // not counted as a 0% trade (that would silently pull it down)
      stockResults.push({ symbol, capital, trades })
    }

    const allTrades = stockResults.flatMap(r => r.trades)
      .sort((a, b) => (b.signal_date || '').localeCompare(a.signal_date || ''))

    // Headline metric: ₹100 per stock, compounded through every closed cycle in
    // the window, equal-weighted across stocks. This is a signal-quality measure,
    // not an achievable portfolio return — see the per-trade table below for the
    // individual entries/exits this rolls up.
    const perStockReturn = stockResults.map(r => r.capital - 100)

    const openCount   = allTrades.filter(t => t.status === 'open').length
    const closedCount = allTrades.filter(t => t.status === 'closed').length
    const heldDays    = allTrades.map(t => t.held).filter(h => h != null)

    const kpis = {
      stockCount:      stockResults.length,
      totalTrades:     allTrades.length,
      openCount, closedCount,
      compoundedAvg:    perStockReturn.length ? perStockReturn.reduce((a, b) => a + b, 0) / perStockReturn.length : null,
      compoundedMedian: median(perStockReturn),
      compoundedBest:   perStockReturn.length ? Math.max(...perStockReturn) : null,
      compoundedWorst:  perStockReturn.length ? Math.min(...perStockReturn) : null,
      winRate:          perStockReturn.length ? perStockReturn.filter(r => r > 0).length / perStockReturn.length * 100 : null,
      avgHoldDays:      heldDays.length ? heldDays.reduce((a, b) => a + b, 0) / heldDays.length : null,
    }

    send(res, { obsDate, period, trades: allTrades, kpis })
  } catch (e) {
    sendErr(res, e.message)
  }
}
