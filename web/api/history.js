const { db, getExcluded, fetchCmp, send, sendErr } = require('./_utils')

const PAGE_SIZE = 50

module.exports = async (req, res) => {
  try {
    const { page = '1', strategy, symbol, sector, from, to } = req.query
    const pageNum = Math.max(1, parseInt(page, 10))
    const offset  = (pageNum - 1) * PAGE_SIZE

    let q = db.from('signals')
      .select('signal_date, strategy_name, signal_type, symbol, price, ema_difference_pct, breakout_pct, sector, stocks(name)', { count: 'exact' })
      .order('signal_date', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1)

    if (strategy) q = q.eq('strategy_name', strategy)
    if (symbol)   q = q.ilike('symbol', `%${symbol}%`)
    if (sector)   q = q.ilike('sector', `%${sector}%`)
    if (from)     q = q.gte('signal_date', from)
    if (to)       q = q.lte('signal_date', to)

    const { data, count, error } = await q
    if (error) return sendErr(res, error.message)

    const excluded = await getExcluded()
    const clean = (data || []).filter(r => !excluded.has(r.symbol))
    const cmpMap = await fetchCmp(clean.map(r => r.symbol))

    const rows = clean.map(r => ({
      symbol:             r.symbol,
      name:               r.stocks?.name || '',
      signal_date:        r.signal_date,
      strategy_name:      r.strategy_name,
      signal_type:        r.signal_type,
      price:              r.price,
      cmp:                cmpMap[r.symbol] ?? null,
      return_pct:         (cmpMap[r.symbol] && r.price) ? (cmpMap[r.symbol] / r.price - 1) * 100 : null,
      ema_difference_pct: r.ema_difference_pct,
      breakout_pct:       r.breakout_pct,
      sector:             r.sector,
    }))

    send(res, {
      total:    count ?? 0,
      page:     pageNum,
      pageSize: PAGE_SIZE,
      hasMore:  offset + PAGE_SIZE < (count ?? 0),
      rows,
    })
  } catch (e) {
    sendErr(res, e.message)
  }
}
