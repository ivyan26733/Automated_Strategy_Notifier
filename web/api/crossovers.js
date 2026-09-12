const { db, getObsContext, getExcluded, fetchCmp, getLatestRunStart, getFreshEmaSet, getEpisodes, send, sendErr, must } = require('./_utils')

module.exports = async (req, res) => {
  try {
    const { obsDate } = await getObsContext()
    if (!obsDate) return send(res, { obsDate: null, runStartedAt: null, rows: [] })

    // Fresh = stocks whose cross EPISODE began in this run. Keyed on the episode
    // rather than on any single row: a mid-week cross re-fires a new row on every
    // daily run, so row-level created_at would keep a stock here indefinitely
    // instead of handing it to Active on the next run.
    const runStartedAt = await getLatestRunStart()
    if (!runStartedAt) return send(res, { obsDate, runStartedAt: null, rows: [] })

    const excluded = await getExcluded()
    const freshSet = await getFreshEmaSet(runStartedAt)
    const symbols  = [...freshSet].filter(s => !excluded.has(s))
    if (!symbols.length) return send(res, { obsDate, runStartedAt, rows: [] })

    // Latest row per symbol carries the current EMA readings; the episode carries
    // the true crossing date and entry price.
    const { data } = must(await db.from('signals')
      .select('symbol, ema9, ema20, ema_difference_pct, sector, industry')
      .eq('strategy_name', 'ema_crossover')
      .eq('signal_type', 'golden_cross')
      .in('symbol', symbols)
      .gte('created_at', runStartedAt)
      .order('signal_date', { ascending: false }), 'signals fresh EMA readings')

    const latest = {}
    for (const r of (data || [])) if (!latest[r.symbol]) latest[r.symbol] = r

    const episodes = await getEpisodes(symbols)
    const cmpMap   = await fetchCmp(symbols, obsDate)

    const rows = symbols.map(sym => {
      const e = episodes.get(sym)
      const l = latest[sym] || {}
      const price = e?.price ?? null
      const cmp = cmpMap[sym] ?? null
      return {
        symbol:             sym,
        name:               e?.stocks?.name || '',
        signal_date:        e?.start || null,
        price,
        cmp,
        return_pct:         (cmp && price) ? (cmp / price - 1) * 100 : null,
        ema9:               l.ema9 ?? null,
        ema20:              l.ema20 ?? null,
        ema_difference_pct: l.ema_difference_pct ?? null,
        sector:             l.sector || e?.stocks?.sector || '',
        industry:           l.industry || '',
      }
    }).sort((a, b) => (b.ema_difference_pct ?? -Infinity) - (a.ema_difference_pct ?? -Infinity))

    send(res, { obsDate, runStartedAt, rows })
  } catch (e) {
    sendErr(res, e.message)
  }
}
