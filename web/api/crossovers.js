const { db, getObsContext, getExcluded, fetchCmp, getLatestRunStart, send, sendErr } = require('./_utils')

module.exports = async (req, res) => {
  try {
    const { obsDate } = await getObsContext()
    if (!obsDate) return send(res, { obsDate: null, runStartedAt: null, rows: [] })

    // Fresh = golden crosses this scanner run discovered for the first time.
    // Signals already known from an earlier run keep their original created_at
    // and therefore fall out of Fresh (into Active) as soon as the next run completes.
    const runStartedAt = await getLatestRunStart()
    if (!runStartedAt) return send(res, { obsDate, runStartedAt: null, rows: [] })

    const { data, error } = await db.from('signals')
      .select('symbol, signal_date, price, ema9, ema20, ema_difference_pct, sector, industry, stocks(name)')
      .eq('strategy_name', 'ema_crossover')
      .eq('signal_type', 'golden_cross')
      .gte('created_at', runStartedAt)
      .order('ema_difference_pct', { ascending: false })

    if (error || !data?.length) return send(res, { obsDate, runStartedAt, rows: [] })

    const excluded = await getExcluded()
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

    send(res, { obsDate, runStartedAt, rows })
  } catch (e) {
    sendErr(res, e.message)
  }
}
