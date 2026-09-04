const { db } = require('./_db')

const CHUNK = 200
const EMA_WINDOW_DAYS = 28
const BRK_WINDOW_DAYS = 30

function daysAgo(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

function mkChunks(arr) {
  const out = []
  for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK))
  return out
}

function send(res, data, status = 200) {
  res.status(status).json(data)
}

function sendErr(res, message, status = 500) {
  res.status(status).json({ error: message })
}

// Latest obs date + set of symbols where EMA9 > EMA20
async function getObsContext() {
  const { data } = await db.from('weekly_indicators')
    .select('observation_date')
    .order('observation_date', { ascending: false })
    .limit(1)

  const obsDate = data?.[0]?.observation_date
  if (!obsDate) return { obsDate: null, activeSet: new Set() }

  const { data: active } = await db.from('weekly_indicators')
    .select('symbol')
    .gte('observation_date', daysAgo(obsDate, 7))
    .gt('ema_difference', 0)

  return {
    obsDate,
    activeSet: new Set((active || []).map(r => r.symbol)),
  }
}

// Circuit stocks + recently-listed stocks (<90 days NSE listing)
async function getExcluded() {
  const [circuitRes, newListedRes] = await Promise.all([
    db.rpc('circuit_symbols'),
    db.rpc('recently_listed_symbols', { cutoff_days: 90 }),
  ])
  return new Set([
    ...(circuitRes.data  || []).map(r => r.symbol),
    ...(newListedRes.data || []).map(r => r.symbol),
  ])
}

// Latest weekly_close per symbol, chunked to avoid PostgREST URL limits
async function fetchCmp(symbols) {
  if (!symbols.length) return {}
  const rows = (await Promise.all(mkChunks(symbols).map(chunk =>
    db.from('weekly_indicators')
      .select('symbol, weekly_close, observation_date')
      .in('symbol', chunk)
      .order('observation_date', { ascending: false })
      .limit(500)
      .then(r => r.data || [])
  ))).flat()
  const map = {}
  for (const row of rows) {
    if (!(row.symbol in map)) map[row.symbol] = row.weekly_close
  }
  return map
}

// Parse stocks.date_of_listing format "17-AUG-2026" → "2026-08-17"
function parseListingDate(s) {
  if (!s) return null
  const d = new Date(s.replace(/-([A-Z]{3})-/, ' $1 '))
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

module.exports = {
  db,
  daysAgo, addDays, mkChunks,
  send, sendErr,
  getObsContext, getExcluded, fetchCmp, parseListingDate,
  EMA_WINDOW_DAYS, BRK_WINDOW_DAYS,
}
