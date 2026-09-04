const { db, daysAgo, getObsContext, getExcluded, fetchCmp, send, sendErr, EMA_WINDOW_DAYS } = require('./_utils')

module.exports = async (req, res) => {
  try {
    const { obsDate, activeSet } = await getObsContext()
    if (!obsDate) return send(res, { obsDate: null, cutoff: null, rows: [] })

    const cutoff = daysAgo(obsDate, EMA_WINDOW_DAYS)

    const { data, error } = await db.from('signals')
      .select('symbol, signal_date, price, ema9, ema20, ema_difference_pct, sector, industry, stocks(name)')
      .eq('strategy_name', 'ema_crossover')
      .eq('signal_type', 'golden_cross')
      .gte('signal_date', cutoff)
      .lte('signal_date', obsDate)
      .order('signal_date', { ascending: false })

    if (error || !data?.length) return send(res, { obsDate, cutoff, rows: [] })

    const excluded = await getExcluded()

    // Keep earliest signal per symbol, only if still active and not excluded
    const seen = new Set()
    const filtered = []
    for (const row of [...data].sort((a, b) => a.signal_date.localeCompare(b.signal_date))) {
      if (seen.has(row.symbol)) continue
      seen.add(row.symbol)
      if (activeSet.has(row.symbol) && !excluded.has(row.symbol)) filtered.push(row)
    }
    filtered.sort((a, b) => b.signal_date.localeCompare(a.signal_date))

    const cmpMap = await fetchCmp(filtered.map(r => r.symbol))

    const rows = filtered.map(r => ({
      symbol:             r.symbol,
      name:               r.stocks?.name || '',
      signal_date:        r.signal_date,
      price:              r.price,
      cmp:                cmpMap[r.symbol] ?? null,
      return_pct:         (cmpMap[r.symbol] && r.price) ? (cmpMap[r.symbol] / r.price - 1) * 100 : null,
      ema9:               r.ema9,
      ema20:              r.ema20,
      ema_difference_pct: r.ema_difference_pct,
      sector:             r.sector,
      industry:           r.industry,
    }))

    send(res, { obsDate, cutoff, rows })
  } catch (e) {
    sendErr(res, e.message)
  }
}
