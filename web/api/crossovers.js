const { getObsContext, getExcluded, getLatestRunStart, getFreshEmaSet, getEpisodes, fetchLatestIndicators, send, sendErr } = require('./_utils')

module.exports = async (req, res) => {
  try {
    const { obsDate } = await getObsContext()
    if (!obsDate) return send(res, { obsDate: null, runStartedAt: null, rows: [] })

    // Fresh = stocks whose cross happened on the latest trading day. Anything
    // that crossed earlier is already a holding and belongs in Active EMA, even
    // when its row reached the database only in the latest run.
    const runStartedAt = await getLatestRunStart()
    const excluded = await getExcluded()
    const freshSet = await getFreshEmaSet(obsDate)
    const symbols  = [...freshSet].filter(s => !excluded.has(s))
    if (!symbols.length) return send(res, { obsDate, runStartedAt, rows: [] })

    // The episode carries the cross date and entry price; the indicator row
    // carries this week's EMA readings and close — the same source Active uses,
    // so a stock shows the same numbers on the day it moves between the tabs.
    const episodes = await getEpisodes(symbols)
    const latest   = await fetchLatestIndicators(obsDate, symbols)

    const rows = symbols.map(sym => {
      const e = episodes.get(sym)
      const l = latest.get(sym) || {}
      const price = e?.price ?? null
      const cmp = l.weekly_close ?? null
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
        sector:             e?.stocks?.sector || '',
        industry:           e?.stocks?.industry || '',
      }
    }).sort((a, b) => (b.ema_difference_pct ?? -Infinity) - (a.ema_difference_pct ?? -Infinity))

    send(res, { obsDate, runStartedAt, rows })
  } catch (e) {
    sendErr(res, e.message)
  }
}
