const { db, getObsContext, getExcluded, fetchCmp, send, sendErr } = require('./_utils')

module.exports = async (req, res) => {
  try {
    const { obsDate, activeSet } = await getObsContext()
    if (!obsDate) return send(res, { obsDate: null, freshDate: null, rows: [] })

    // Find the latest scanner run date (MAX signal_date from ema_crossover golden_cross)
    const { data: latestRow } = await db.from('signals')
      .select('signal_date')
      .eq('strategy_name', 'ema_crossover')
      .eq('signal_type', 'golden_cross')
      .order('signal_date', { ascending: false })
      .limit(1)

    const freshDate = latestRow?.[0]?.signal_date
    if (!freshDate) return send(res, { obsDate, freshDate: null, rows: [] })

    // Fetch only signals from that exact scan date
    const { data, error } = await db.from('signals')
      .select('symbol, signal_date, price, ema9, ema20, ema_difference_pct, sector, industry, stocks(name)')
      .eq('strategy_name', 'ema_crossover')
      .eq('signal_type', 'golden_cross')
      .eq('signal_date', freshDate)
      .order('ema_difference_pct', { ascending: false })

    if (error || !data?.length) return send(res, { obsDate, freshDate, rows: [] })

    const excluded = await getExcluded()

    // Keep only stocks still in uptrend (EMA9 > EMA20) and not excluded
    const filtered = data.filter(r => activeSet.has(r.symbol) && !excluded.has(r.symbol))

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

    send(res, { obsDate, freshDate, rows })
  } catch (e) {
    sendErr(res, e.message)
  }
}
