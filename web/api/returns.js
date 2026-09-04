const { db, daysAgo, addDays, mkChunks, getObsContext, getExcluded, parseListingDate, send, sendErr } = require('./_utils')

module.exports = async (req, res) => {
  try {
    const period = parseInt(req.query.period ?? '365', 10)
    const { obsDate, activeSet } = await getObsContext()
    if (!obsDate) return send(res, { obsDate: null, trades: [], kpis: {} })

    const cutoffRecent  = daysAgo(obsDate, 14)
    const lookbackDays  = period === 0 ? 7300 : period
    const cutoffOld     = daysAgo(obsDate, lookbackDays)

    // 1. All golden crosses in the period
    const { data: goldenCrosses, error: gcErr } = await db.from('signals')
      .select('symbol, signal_date, price, sector, stocks(name, date_of_listing)')
      .eq('strategy_name', 'ema_crossover')
      .eq('signal_type', 'golden_cross')
      .gte('signal_date', cutoffOld)
      .lte('signal_date', cutoffRecent)
      .order('signal_date', { ascending: true })
      .limit(5000)

    if (gcErr || !goldenCrosses?.length) return send(res, { obsDate, trades: [], kpis: {} })

    // 2. Strip excluded symbols + filter crosses within 26 weeks of NSE listing
    const excluded = await getExcluded()
    const validCrosses = goldenCrosses
      .filter(gc => !excluded.has(gc.symbol))
      .filter(gc => {
        const ld = parseListingDate(gc.stocks?.date_of_listing)
        return !ld || gc.signal_date >= addDays(ld, 182)
      })

    if (!validCrosses.length) return send(res, { obsDate, trades: [], kpis: {} })

    const validSymbols = [...new Set(validCrosses.map(r => r.symbol))]

    // 3. Death crosses for those symbols (chunked)
    const allDCs = (await Promise.all(mkChunks(validSymbols).map(chunk =>
      db.from('signals')
        .select('symbol, signal_date, price')
        .eq('strategy_name', 'ema_crossover')
        .eq('signal_type', 'death_cross')
        .in('symbol', chunk)
        .gte('signal_date', cutoffOld)
        .order('signal_date', { ascending: true })
        .limit(2000)
        .then(r => r.data || [])
    ))).flat()

    const dcIndex = {}
    for (const dc of allDCs) {
      if (!dcIndex[dc.symbol]) dcIndex[dc.symbol] = []
      dcIndex[dc.symbol].push(dc)
    }

    // 4. CMP for open trades (chunked)
    const openSyms = validSymbols.filter(s => activeSet.has(s))
    const cmpMap = {}
    if (openSyms.length) {
      const cmpRows = (await Promise.all(mkChunks(openSyms).map(chunk =>
        db.from('weekly_indicators')
          .select('symbol, weekly_close')
          .in('symbol', chunk)
          .gte('observation_date', daysAgo(obsDate, 7))
          .order('observation_date', { ascending: false })
          .limit(500)
          .then(r => r.data || [])
      ))).flat()
      for (const row of cmpRows) {
        if (!(row.symbol in cmpMap)) cmpMap[row.symbol] = row.weekly_close
      }
    }

    // 5. Build trade rows
    const daysBetween = (d1, d2) => Math.round((new Date(d2) - new Date(d1)) / 86400000)

    const trades = []
    for (const gc of validCrosses) {
      const exitDC = (dcIndex[gc.symbol] || []).find(dc => dc.signal_date > gc.signal_date)
      if (exitDC) {
        trades.push({
          symbol:      gc.symbol,
          name:        gc.stocks?.name || '',
          sector:      gc.sector,
          status:      'closed',
          signal_date: gc.signal_date,
          exit_date:   exitDC.signal_date,
          held:        daysBetween(gc.signal_date, exitDC.signal_date),
          price:       gc.price,
          cmp:         exitDC.price,
          return_pct:  gc.price > 0 ? (exitDC.price / gc.price - 1) * 100 : null,
        })
      } else if (activeSet.has(gc.symbol)) {
        const cmp = cmpMap[gc.symbol] ?? null
        trades.push({
          symbol:      gc.symbol,
          name:        gc.stocks?.name || '',
          sector:      gc.sector,
          status:      'open',
          signal_date: gc.signal_date,
          exit_date:   null,
          held:        daysBetween(gc.signal_date, obsDate),
          price:       gc.price,
          cmp,
          return_pct:  (cmp != null && gc.price > 0) ? (cmp / gc.price - 1) * 100 : null,
        })
      }
    }

    // 6. KPIs
    const withRet    = trades.filter(t => t.return_pct != null)
    const openCount  = trades.filter(t => t.status === 'open').length
    const closedCount = trades.filter(t => t.status === 'closed').length
    const avgRet  = withRet.length ? withRet.reduce((s, t) => s + t.return_pct, 0) / withRet.length : null
    const best    = withRet.length ? Math.max(...withRet.map(t => t.return_pct)) : null
    const worst   = withRet.length ? Math.min(...withRet.map(t => t.return_pct)) : null
    const nPos    = withRet.filter(t => t.return_pct > 0).length
    const hitRate = withRet.length ? (nPos / withRet.length * 100) : null

    send(res, {
      obsDate,
      period,
      trades,
      kpis: { total: trades.length, openCount, closedCount, avgRet, best, worst, hitRate, nPos, withRetCount: withRet.length },
    })
  } catch (e) {
    sendErr(res, e.message)
  }
}
