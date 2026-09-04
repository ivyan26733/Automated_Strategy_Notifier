const { db, send, sendErr } = require('./_utils')

module.exports = async (req, res) => {
  try {
    const symbols = (req.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean)
    if (!symbols.length) return send(res, { rows: [] })

    const [{ data: rawInds }, { data: sigs }] = await Promise.all([
      db.from('weekly_indicators')
        .select('symbol, ema9, ema20, ema_difference_pct, weekly_close, observation_date')
        .in('symbol', symbols)
        .order('observation_date', { ascending: false }),
      db.from('signals')
        .select('symbol, signal_date, price, strategy_name, signal_type, stocks(name, sector, industry)')
        .in('symbol', symbols)
        .eq('signal_type', 'golden_cross')
        .order('signal_date', { ascending: false }),
    ])

    const indMap = {}, sigMap = {}
    for (const ind of (rawInds || [])) { if (!(ind.symbol in indMap)) indMap[ind.symbol] = ind }
    for (const s   of (sigs    || [])) { if (!(s.symbol   in sigMap)) sigMap[s.symbol]   = s   }

    const rows = symbols.map(sym => {
      const ind = indMap[sym] || {}, sig = sigMap[sym] || {}
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
