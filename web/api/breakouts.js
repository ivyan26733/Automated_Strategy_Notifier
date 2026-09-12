const { db, daysAgo, getObsContext, getExcluded, fetchCmp, fetchAllPaged, send, sendErr, BRK_WINDOW_DAYS } = require('./_utils')

module.exports = async (req, res) => {
  try {
    const { obsDate } = await getObsContext()
    const cutoff = daysAgo(obsDate || new Date().toISOString().slice(0, 10), BRK_WINDOW_DAYS)

    // Paged: 30 days of breakouts is several thousand rows, past the 1000-row
    // response cap. symbol + signal_date make the order total, so .range()
    // pages can't skip or repeat rows that share a breakout_pct.
    const data = await fetchAllPaged(() =>
      db.from('signals')
        .select('symbol, signal_date, price, breakout_reference, breakout_pct, sector, industry, stocks(name)', { count: 'exact' })
        .eq('strategy_name', 'breakout_6m')
        .gte('signal_date', cutoff)
        .order('breakout_pct', { ascending: false })
        .order('symbol', { ascending: true })
        .order('signal_date', { ascending: false }),
      'signals breakouts')

    if (!data.length) return send(res, { obsDate, cutoff, rows: [] })

    const excluded = await getExcluded()
    const clean = data.filter(r => !excluded.has(r.symbol))
    const cmpMap = await fetchCmp(clean.map(r => r.symbol), obsDate)

    const rows = clean.map(r => ({
      symbol:             r.symbol,
      name:               r.stocks?.name || '',
      signal_date:        r.signal_date,
      price:              r.price,
      cmp:                cmpMap[r.symbol] ?? null,
      return_pct:         (cmpMap[r.symbol] && r.price) ? (cmpMap[r.symbol] / r.price - 1) * 100 : null,
      breakout_reference: r.breakout_reference,
      breakout_pct:       r.breakout_pct,
      sector:             r.sector,
      industry:           r.industry,
    }))

    send(res, { obsDate, cutoff, rows })
  } catch (e) {
    sendErr(res, e.message)
  }
}
