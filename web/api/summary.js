const { db, daysAgo, getObsContext, getExcluded, getLatestRunStart, getFreshEmaSet, send, sendErr, must, EMA_WINDOW_DAYS, BRK_WINDOW_DAYS } = require('./_utils')

module.exports = async (req, res) => {
  try {
    const [runRes, uniRes, sigRes] = await Promise.all([
      db.from('scanner_runs').select('started_at,finished_at,status').order('created_at', { ascending: false }).limit(1)
        .then(r => must(r, 'scanner_runs latest')),
      db.from('stocks').select('*', { count: 'exact', head: true }).then(r => must(r, 'stocks count')),
      db.from('signals').select('*', { count: 'exact', head: true }).then(r => must(r, 'signals count')),
    ])

    const { obsDate } = await getObsContext()

    let freshEmaCount = 0
    let freshBrkCount = 0

    if (obsDate) {
      // Fresh EMA = cross episodes that began in the latest run — the same set
      // crossovers.js renders, so the KPI and the tab cannot disagree.
      const runStartedAt = await getLatestRunStart()

      const [freshSet, brkRes] = await Promise.all([
        getFreshEmaSet(runStartedAt),
        db.from('signals').select('*', { count: 'exact', head: true })
          .eq('strategy_name', 'breakout_6m')
          .gte('signal_date', daysAgo(obsDate, BRK_WINDOW_DAYS))
          .lte('signal_date', obsDate)
          .then(r => must(r, 'signals breakout count')),
      ])

      const excluded = await getExcluded()
      freshEmaCount = [...freshSet].filter(s => !excluded.has(s)).length
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
