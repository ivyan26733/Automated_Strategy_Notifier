const { db, getObsContext, getExcluded, fetchCmp, send, sendErr } = require('./_utils')

module.exports = async (req, res) => {
  try {
    const { obsDate } = await getObsContext()
    if (!obsDate) return send(res, { obsDate: null, freshFrom: null, rows: [] })

    // Use the latest COMPLETED (non-developing) weekly candle date as the lower bound.
    // This excludes any mid-week developing-bar signals still in the DB from before
    // the runner.py fix, and keeps the window tight regardless of when the scanner last ran.
    const { data: lastCompleted } = await db.from('weekly_indicators')
      .select('observation_date')
      .eq('is_developing_week', false)
      .order('observation_date', { ascending: false })
      .limit(1)

    const freshFrom = lastCompleted?.[0]?.observation_date
    if (!freshFrom) return send(res, { obsDate, freshFrom: null, rows: [] })

    const { data, error } = await db.from('signals')
      .select('symbol, signal_date, price, ema9, ema20, ema_difference_pct, sector, industry, stocks(name)')
      .eq('strategy_name', 'ema_crossover')
      .eq('signal_type', 'golden_cross')
      .gte('signal_date', freshFrom)
      .order('ema_difference_pct', { ascending: false })

    if (error || !data?.length) return send(res, { obsDate, freshFrom, rows: [] })

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

    send(res, { obsDate, freshFrom, rows })
  } catch (e) {
    sendErr(res, e.message)
  }
}
