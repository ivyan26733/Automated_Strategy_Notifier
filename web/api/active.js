const { db, getObsContext, getExcluded, getLatestRunStart, getFreshEmaSet, getEpisodes, send, sendErr } = require('./_utils')

module.exports = async (req, res) => {
  try {
    const { obsDate } = await getObsContext()
    if (!obsDate) return send(res, { obsDate: null, activeCount: 0, rows: [] })

    const { data: rawInds, error } = await db.from('weekly_indicators')
      .select('symbol, ema9, ema20, ema_difference_pct, weekly_close, observation_date')
      .gt('ema_difference', 0)
      .order('observation_date', { ascending: false })
      .limit(5000)

    if (error || !rawInds?.length) return send(res, { obsDate, activeCount: 0, rows: [] })

    // Dedup: keep latest observation per symbol
    const seen = new Set()
    const inds = []
    for (const row of rawInds) {
      if (!seen.has(row.symbol)) { seen.add(row.symbol); inds.push(row) }
    }

    // Exclude circuit + recently-listed
    const excluded = await getExcluded()
    const clean = inds.filter(r => !excluded.has(r.symbol))

    // Exclude stocks whose cross episode began in the latest run — those belong
    // in Fresh Crossovers. They land here on the next run and stay while EMA9 > EMA20.
    const runStartedAt = await getLatestRunStart()
    const freshSet = await getFreshEmaSet(runStartedAt)

    const activeOnly = clean.filter(r => !freshSet.has(r.symbol))
    activeOnly.sort((a, b) => (b.ema_difference_pct ?? 0) - (a.ema_difference_pct ?? 0))

    // Cross date / entry price come from the episode, fetched for exactly these
    // symbols. The previous unbounded query hit PostgREST's 1000-row cap and
    // truncated at ~3 months, leaving most long-held stocks with no cross date.
    const episodes = await getEpisodes(activeOnly.map(r => r.symbol))

    // getEpisodes only returns symbols whose position is still OPEN, so a symbol
    // missing from it has death-crossed and is no longer an active holding —
    // drop it. EMA9 > EMA20 today is not sufficient on its own: a stock can
    // climb back above EMA20 without ever emitting a golden cross (the entry
    // gates in ema_crossover.py reject it while the state machine still flips
    // `above`), which left 40 closed positions on this list showing a cross
    // date and a return carried over from an episode that ended months ago.
    const withOpenEpisode = activeOnly.filter(r => episodes.has(r.symbol))

    const rows = withOpenEpisode.map(ind => {
      const e = episodes.get(ind.symbol)
      const sigPrice = e?.price ?? null
      const cmp = ind.weekly_close
      return {
        symbol:             ind.symbol,
        name:               e?.stocks?.name || '',
        signal_date:        e?.start || null,
        signal_price:       sigPrice,
        cmp,
        return_pct:         (sigPrice && cmp) ? (cmp / sigPrice - 1) * 100 : null,
        ema9:               ind.ema9,
        ema20:              ind.ema20,
        ema_difference_pct: ind.ema_difference_pct,
        sector:             e?.stocks?.sector || '',
      }
    })

    send(res, { obsDate, activeCount: withOpenEpisode.length, rows })
  } catch (e) {
    sendErr(res, e.message)
  }
}
