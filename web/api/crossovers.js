const { db, daysAgo, getObsContext, getExcluded, fetchCmp, send, sendErr } = require('./_utils')

module.exports = async (req, res) => {
  try {
    const { obsDate } = await getObsContext()
    if (!obsDate) return send(res, { obsDate: null, freshFrom: null, rows: [] })

    // Fresh = golden-cross signals from the past 7 days (covers the latest completed weekly candle).
    // Using a window instead of MAX(signal_date) prevents a single developing-week signal
    // from hiding all completed-candle signals from the same week.
    const freshFrom = daysAgo(obsDate, 7)

    const { data, error } = await db.from('signals')
      .select('symbol, signal_date, price, ema9, ema20, ema_difference_pct, sector, industry, stocks(name)')
      .eq('strategy_name', 'ema_crossover')
      .eq('signal_type', 'golden_cross')
      .gte('signal_date', freshFrom)
      .order('ema_difference_pct', { ascending: false })

    if (error || !data?.length) return send(res, { obsDate, freshFrom, rows: [] })

    const excluded = await getExcluded()

    // Show ALL fresh crossovers — including those that may have briefly dipped since crossing.
    // Do NOT filter by activeSet: if a signal fired this week it belongs in Fresh regardless
    // of whether EMA9 > EMA20 right now.
    const filtered = data.filter(r => !excluded.has(r.symbol))

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

    send(res, { obsDate, freshFrom, rows })
  } catch (e) {
    sendErr(res, e.message)
  }
}
