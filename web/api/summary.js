const { db, daysAgo, getObsContext, getExcluded, send, sendErr, EMA_WINDOW_DAYS, BRK_WINDOW_DAYS } = require('./_utils')

module.exports = async (req, res) => {
  try {
    const [runRes, uniRes, sigRes] = await Promise.all([
      db.from('scanner_runs').select('started_at,finished_at,status').order('created_at', { ascending: false }).limit(1),
      db.from('stocks').select('*', { count: 'exact', head: true }),
      db.from('signals').select('*', { count: 'exact', head: true }),
    ])

    const { obsDate, activeSet } = await getObsContext()

    let freshEmaCount = 0
    let freshBrkCount = 0

    if (obsDate) {
      // Fresh EMA = golden-cross signals from the past 7 days (same window as crossovers.js)
      const [emaRes, brkRes] = await Promise.all([
        db.from('signals').select('symbol')
          .eq('strategy_name', 'ema_crossover').eq('signal_type', 'golden_cross')
          .gte('signal_date', daysAgo(obsDate, 7)),
        db.from('signals').select('*', { count: 'exact', head: true })
          .eq('strategy_name', 'breakout_6m')
          .gte('signal_date', daysAgo(obsDate, BRK_WINDOW_DAYS))
          .lte('signal_date', obsDate),
      ])

      const excluded = await getExcluded()
      freshEmaCount = (emaRes.data || []).filter(r => !excluded.has(r.symbol)).length
      freshBrkCount = brkRes.count || 0
    }

    send(res, {
      obsDate,
      universeCount:  uniRes.count ?? 0,
      totalSignals:   sigRes.count ?? 0,
      freshEmaCount,
      freshBrkCount,
      lastRun:        runRes.data?.[0] ?? null,
    })
  } catch (e) {
    sendErr(res, e.message)
  }
}
