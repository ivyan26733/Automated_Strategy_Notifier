const { db, daysAgo, getObsContext, getExcluded, send, sendErr } = require('./_utils')

module.exports = async (req, res) => {
  try {
    const { obsDate } = await getObsContext()
    if (!obsDate) return send(res, { obsDate: null, activeCount: 0, rows: [] })

    const { data: rawInds, error } = await db.from('weekly_indicators')
      .select('symbol, ema9, ema20, ema_difference_pct, weekly_close, observation_date')
      .gte('observation_date', daysAgo(obsDate, 7))
      .gt('ema_difference', 0)
      .order('observation_date', { ascending: false })
      .limit(2000)

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
    clean.sort((a, b) => (b.ema_difference_pct ?? 0) - (a.ema_difference_pct ?? 0))

    // Latest golden-cross signal per symbol in the last 2 years
    const { data: sigs } = await db.from('signals')
      .select('symbol, signal_date, price, stocks(name, sector, industry)')
      .eq('strategy_name', 'ema_crossover')
      .eq('signal_type', 'golden_cross')
      .gte('signal_date', daysAgo(obsDate, 730))
      .order('signal_date', { ascending: false })

    const sigMap = {}
    for (const s of (sigs || [])) { if (!sigMap[s.symbol]) sigMap[s.symbol] = s }

    // Also get the fresh scan date so the frontend can distinguish fresh vs older
    const { data: latestRow } = await db.from('signals')
      .select('signal_date')
      .eq('strategy_name', 'ema_crossover')
      .eq('signal_type', 'golden_cross')
      .order('signal_date', { ascending: false })
      .limit(1)
    const freshDate = latestRow?.[0]?.signal_date

    const rows = clean.map(ind => {
      const sig = sigMap[ind.symbol] || {}
      const sigPrice = sig.price ?? null
      const cmp = ind.weekly_close
      return {
        symbol:             ind.symbol,
        name:               sig.stocks?.name || '',
        signal_date:        sig.signal_date || null,
        signal_price:       sigPrice,
        cmp,
        return_pct:         (sigPrice && cmp) ? (cmp / sigPrice - 1) * 100 : null,
        ema9:               ind.ema9,
        ema20:              ind.ema20,
        ema_difference_pct: ind.ema_difference_pct,
        sector:             sig.stocks?.sector || '',
        is_fresh:           sig.signal_date === freshDate,
      }
    })

    send(res, { obsDate, freshDate, activeCount: clean.length, rows })
  } catch (e) {
    sendErr(res, e.message)
  }
}
