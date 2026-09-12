const { db, getObsContext, fetchLatestIndicators, fetchAllPaged, send, sendErr } = require('./_utils')

module.exports = async (req, res) => {
  try {
    const symbols = (req.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean)
    if (!symbols.length) return send(res, { rows: [] })

    // Both lookups span a stock's whole history (an indicator row per scan day,
    // every golden cross ever), so a watchlist of a hundred-odd stocks already
    // runs past the 1000-row response cap — page them instead of trusting one
    // response to hold every symbol's latest row.
    const { obsDate } = await getObsContext()
    const [latest, sigs] = await Promise.all([
      fetchLatestIndicators(obsDate, symbols),
      fetchAllPaged(() =>
        db.from('signals')
          .select('symbol, signal_date, price, strategy_name, signal_type, stocks(name, sector, industry)', { count: 'exact' })
          .in('symbol', symbols)
          .eq('signal_type', 'golden_cross')
          .order('signal_date', { ascending: false })
          .order('symbol', { ascending: true })
          .order('strategy_name', { ascending: true }),
        'signals watchlist'),
    ])

    const sigMap = {}
    for (const s of sigs) { if (!(s.symbol in sigMap)) sigMap[s.symbol] = s }

    const rows = symbols.map(sym => {
      const ind = latest.get(sym) || {}, sig = sigMap[sym] || {}
      const cmp = ind.weekly_close ?? null
      const sigPrice = sig.price ?? null
      return {
        symbol:             sym,
        name:               sig.stocks?.name || '',
        strategy_name:      sig.strategy_name || '',
        signal_date:        sig.signal_date || null,
        signal_price:       sigPrice,
        cmp,
        return_pct:         (cmp && sigPrice) ? (cmp / sigPrice - 1) * 100 : null,
        ema9:               ind.ema9 ?? null,
        ema20:              ind.ema20 ?? null,
        ema_difference_pct: ind.ema_difference_pct ?? null,
        sector:             sig.stocks?.sector || '',
      }
    })

    send(res, { rows })
  } catch (e) {
    sendErr(res, e.message)
  }
}
