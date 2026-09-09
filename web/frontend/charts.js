/* NSE Stock Screener — charts layer.
 *
 * Every chart is a redundant view of a table that is already on the page. If Chart.js
 * fails to load, or a series fails to parse, the chart is skipped and the table stands
 * on its own — nothing here is allowed to blank out content.
 */

const CHARTS_OK = typeof window.Chart !== 'undefined'
// Keyed by canvas id, not an array: the Returns tab re-mounts its canvases every
// time the period changes, and an append-only list would keep repainting charts
// bound to detached canvas elements on each theme flip.
const registry = new Map()

// ── Theme tokens ──────────────────────────────────────────────────
// The dark palette lives inside @media (prefers-color-scheme: dark), so the *values*
// of these custom properties change with no attribute mutating on the document.
// Colors must therefore be re-read at paint time, never cached across a theme flip.
function tok(name, fallback) {
  if (typeof getComputedStyle !== 'function') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

function palette() {
  return {
    green:  tok('--green', '#059669'),
    red:    tok('--red',   '#DC2626'),
    blue:   tok('--blue',  '#1D4ED8'),
    amber:  tok('--amber', '#B45309'),
    text:   tok('--text-2', '#475569'),
    faint:  tok('--text-4', '#94A3B8'),
    line:   tok('--border', '#E2E8F0'),
  }
}

// Translucent variant of a hex token, for bar fills under a solid border
function alpha(hex, a) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim())
  if (!m) return hex
  return `rgba(${parseInt(m[1],16)}, ${parseInt(m[2],16)}, ${parseInt(m[3],16)}, ${a})`
}

// ── Number parsing ────────────────────────────────────────────────
// Table cells carry rendered strings: "30.0%", "+5.9 pp", "6,971", "−7.0%".
// That minus is U+2212, not a hyphen — parseFloat returns NaN on it. Normalise the
// dash family, strip separators and units, and surface failure as null so callers
// can drop a broken series instead of charting NaN.
function num(raw) {
  if (raw == null) return null
  const cleaned = String(raw)
    .replace(/[−–—]/g, '-')   // minus sign, en dash, em dash
    .replace(/\(.*?\)/g, '')                 // trailing "(1,061)" sample-size notes
    .replace(/[,%\s]/g, '')
    .replace(/pp$/i, '')
    .trim()
  if (!cleaned || cleaned === '-') return null
  const n = parseFloat(cleaned)
  return Number.isFinite(n) ? n : null
}

// Read a table into rows of cell text. Returns [] if the table isn't present.
function readTable(id) {
  const table = document.getElementById(id)
  if (!table) return []
  return [...table.querySelectorAll('tbody tr')].map(tr =>
    [...tr.children].map(td => td.textContent.trim())
  )
}

// Shorten the long strategy labels so an axis tick stays readable.
// Parentheticals and "← Best" markers belong in the table, not on a bar.
function shortLabel(s) {
  return s
    .replace(/Technical composite/i, 'Tech')
    .replace(/Fundamental hard-rejection filter only/i, 'Fund reject only')
    .replace(/Fundamental/gi, 'Fund')
    .replace(/top-quartile/i, 'Q75')
    .replace(/\([^)]*\)/g, '')     // "(score >= 44)", "(no tech filter)"
    .replace(/[←→]\s*Best/gi, '')  // callout marker from the table
    .replace(/ of 12/i, '')
    .replace(/—.*$/, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+\+\s*$/, '')
    .trim()
}

// ── Chart factory ─────────────────────────────────────────────────
function mount(canvasId, build) {
  if (!CHARTS_OK) return

  // Resolve the canvas on every paint rather than closing over it. The element is
  // replaced whenever its tab re-renders, so a captured reference goes stale.
  const render = () => {
    const canvas = document.getElementById(canvasId)
    if (!canvas) { registry.delete(canvasId); return }

    const p = palette()
    const cfg = build(p)
    if (!cfg) {                       // nothing plottable — hide the frame, keep the table
      const box = canvas.closest('.chart-box')
      if (box) box.hidden = true
      registry.delete(canvasId)
      return
    }

    Chart.defaults.color       = p.text
    Chart.defaults.borderColor = p.line
    Chart.defaults.font.family =
      getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif'

    Chart.getChart(canvas)?.destroy()   // release any chart already bound to this canvas
    new Chart(canvas, cfg)
  }

  try {
    render()
    registry.set(canvasId, render)
  } catch (err) {
    // A broken chart must never take the tab down with it.
    console.warn(`[charts] ${canvasId} failed to render:`, err)
    registry.delete(canvasId)
  }
}

// Re-read tokens and repaint when the OS theme flips. Without this the chart keeps
// the previous theme's text and grid colors over the new background.
if (CHARTS_OK && window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const onFlip = () => registry.forEach(fn => { try { fn() } catch (_) {} })
  if (mq.addEventListener) mq.addEventListener('change', onFlip)
  else if (mq.addListener) mq.addListener(onFlip)
}

// Shared axis/grid scaffolding
function grid(p) {
  return { color: alpha(p.line, 0.55), drawBorder: false }
}
function pctAxis(p, opts = {}) {
  return {
    grid: grid(p),
    ticks: { color: p.faint, callback: v => v + '%', ...(opts.ticks || {}) },
    ...opts,
  }
}

// ══════════════════════════════════════════════════════════════════
// Research tab — charts read from the tables already rendered on the page,
// so the numbers have exactly one source and cannot drift.
// ══════════════════════════════════════════════════════════════════

const BASELINE_WR = 30.0

function initResearchCharts() {
  if (!CHARTS_OK) return

  // ── Strategy variants: win rate, horizontal, baseline reference ──
  mount('chart-variants', p => {
    const rows = readTable('tbl-variants')
      .map(c => ({ label: shortLabel(c[0]), wr: num(c[1]), n: num(c[3]) }))
      .filter(r => r.wr != null)
    if (rows.length < 2) return null

    rows.sort((a, b) => a.wr - b.wr)

    return {
      type: 'bar',
      data: {
        labels: rows.map(r => r.label),
        datasets: [{
          label: 'Win rate',
          data: rows.map(r => r.wr),
          backgroundColor: rows.map(r =>
            r.wr >= BASELINE_WR ? alpha(p.green, 0.75) : alpha(p.red, 0.6)),
          borderColor: rows.map(r => r.wr >= BASELINE_WR ? p.green : p.red),
          borderWidth: 1,
          borderRadius: 3,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        layout: { padding: { right: 14 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                const r = rows[ctx.dataIndex]
                const lift = (r.wr - BASELINE_WR).toFixed(1)
                const sign = r.wr >= BASELINE_WR ? '+' : ''
                return `${r.wr.toFixed(1)}%  (${sign}${lift} pp vs baseline)` +
                       (r.n ? `  ·  n=${r.n.toLocaleString('en-IN')}` : '')
              },
            },
          },
          annotationLine: { value: BASELINE_WR, color: p.faint, label: 'baseline 30.0%' },
        },
        scales: {
          x: { ...pctAxis(p), beginAtZero: true, suggestedMax: 50 },
          y: { grid: { display: false }, ticks: { color: p.text, font: { size: 11 } } },
        },
      },
      plugins: [baselinePlugin],
    }
  })

  // ── Year-stratified win rates ────────────────────────────────────
  mount('chart-years', p => {
    const table = document.getElementById('tbl-years')
    if (!table) return null
    const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim())
    const rows  = readTable('tbl-years')
    if (rows.length < 2 || heads.length < 3) return null

    const years = rows.map(r => r[0])
    const series = []
    for (let col = 1; col < heads.length; col++) {
      const vals = rows.map(r => num(r[col]))
      if (vals.some(v => v == null)) continue          // drop an incomplete series
      series.push({ name: heads[col], vals })
    }
    if (!series.length) return null

    const hues = [p.faint, p.blue, p.amber, p.green, p.red, '#7C3AED']
    return {
      type: 'line',
      data: {
        labels: years,
        datasets: series.map((s, i) => ({
          label: s.name,
          data: s.vals,
          borderColor: hues[i % hues.length],
          backgroundColor: alpha(hues[i % hues.length], 0.12),
          borderWidth: s.name.toLowerCase().includes('baseline') ? 2.5 : 1.8,
          borderDash: s.name.toLowerCase().includes('baseline') ? [5, 4] : [],
          pointRadius: 3, pointHoverRadius: 5, tension: 0.25,
        })),
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: p.text, boxWidth: 12, font: { size: 11 } } },
          tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y.toFixed(1)}%` } },
        },
        scales: {
          y: { ...pctAxis(p), beginAtZero: true },
          x: { grid: { display: false }, ticks: { color: p.text } },
        },
      },
    }
  })

  // ── Volume factor ────────────────────────────────────────────────
  mount('chart-volume', p => {
    const rows = readTable('tbl-volume')
      .map(c => ({ label: shortLabel(c[0]), wr: num(c[1]), n: num(c[3]) }))
      .filter(r => r.wr != null)
    if (rows.length < 2) return null

    const isLow  = s => /low/i.test(s)
    const isHigh = s => /high/i.test(s)
    return {
      type: 'bar',
      data: {
        labels: rows.map(r => r.label),
        datasets: [{
          label: 'Win rate',
          data: rows.map(r => r.wr),
          backgroundColor: rows.map(r =>
            isLow(r.label)  ? alpha(p.green, 0.75) :
            isHigh(r.label) ? alpha(p.amber, 0.7)  : alpha(p.blue, 0.45)),
          borderColor: rows.map(r =>
            isLow(r.label) ? p.green : isHigh(r.label) ? p.amber : p.blue),
          borderWidth: 1, borderRadius: 3,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                const r = rows[ctx.dataIndex]
                return `${r.wr.toFixed(1)}%` + (r.n ? `  ·  n=${r.n.toLocaleString('en-IN')}` : '')
              },
            },
          },
          annotationLine: { value: BASELINE_WR, color: p.faint, label: 'baseline 30.0%' },
        },
        scales: {
          x: { ...pctAxis(p), beginAtZero: true, suggestedMax: 50 },
          y: { grid: { display: false }, ticks: { color: p.text, font: { size: 11 } } },
        },
      },
      plugins: [baselinePlugin],
    }
  })

  // ── Return distribution: Q10 → Q90 per strategy ──────────────────
  mount('chart-distribution', p => {
    const rows = readTable('tbl-distribution')
      .map(c => ({
        label:  shortLabel(c[0]),
        q10:    num(c[3]), q25: num(c[4]), median: num(c[5]),
        q75:    num(c[7]), q90: num(c[8]),
      }))
      .filter(r => r.q10 != null && r.q90 != null && r.median != null)
    if (rows.length < 2) return null

    return {
      type: 'bar',
      data: {
        labels: rows.map(r => r.label),
        datasets: [
          {
            label: 'Q10 → Q90 range',
            data: rows.map(r => [r.q10, r.q90]),
            backgroundColor: alpha(p.blue, 0.28),
            borderColor: alpha(p.blue, 0.75),
            borderWidth: 1, borderRadius: 3, borderSkipped: false,
          },
          {
            label: 'Median',
            data: rows.map(r => [r.median - 0.9, r.median + 0.9]),
            backgroundColor: p.amber,
            borderColor: p.amber,
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: p.text, boxWidth: 12, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: ctx => {
                const r = rows[ctx.dataIndex]
                return ctx.datasetIndex === 1
                  ? `Median ${r.median.toFixed(1)}%`
                  : `Q10 ${r.q10.toFixed(1)}%  →  Q90 ${r.q90.toFixed(1)}%`
              },
            },
          },
        },
        scales: {
          y: { ...pctAxis(p), grid: { ...grid(p), color: alpha(p.line, 0.55) } },
          x: { grid: { display: false }, ticks: { color: p.text, font: { size: 10 }, maxRotation: 34, minRotation: 0 } },
        },
      },
    }
  })
}

// Draws the baseline reference line. Registered per-chart via `plugins:`.
const baselinePlugin = {
  id: 'annotationLine',
  afterDatasetsDraw(chart, args, opts) {
    if (!opts || opts.value == null) return
    const { ctx, chartArea, scales } = chart
    const x = scales.x?.getPixelForValue(opts.value)
    if (x == null || Number.isNaN(x)) return

    ctx.save()
    ctx.beginPath()
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = opts.color || '#94A3B8'
    ctx.lineWidth = 1.5
    ctx.moveTo(x, chartArea.top)
    ctx.lineTo(x, chartArea.bottom)
    ctx.stroke()

    if (opts.label) {
      ctx.setLineDash([])
      ctx.font = '10px system-ui, sans-serif'
      ctx.fillStyle = opts.color || '#94A3B8'
      ctx.textAlign = 'center'
      ctx.fillText(opts.label, x, chartArea.top - 4)
    }
    ctx.restore()
  },
}

// ══════════════════════════════════════════════════════════════════
// Returns tab — charts built from live /api/returns data
// ══════════════════════════════════════════════════════════════════

// Fixed buckets with clamped ends. GC→DC returns are heavily right-skewed
// (multi-baggers), so linear bucketing would pile ~99% of trades into two bars and
// stretch the axis past +400%. The end buckets are explicit overflow bins.
// Bands widen geometrically above +50%. Over a 10-year window a GC→DC hold can
// return several thousand percent, so an even ladder capped at +100% puts ~85% of
// trades in the overflow bar and shows nothing.
const BUCKETS = [
  { lo: -Infinity, hi: -50, label: '≤ −50%' },
  { lo: -50,  hi: -30, label: '−50 to −30' },
  { lo: -30,  hi: -20, label: '−30 to −20' },
  { lo: -20,  hi: -10, label: '−20 to −10' },
  { lo: -10,  hi:   0, label: '−10 to 0' },
  { lo:   0,  hi:  10, label: '0 to +10' },
  { lo:  10,  hi:  20, label: '+10 to +20' },
  { lo:  20,  hi:  30, label: '+20 to +30' },
  { lo:  30,  hi:  50, label: '+30 to +50' },
  { lo:  50,  hi: 100, label: '+50 to +100' },
  { lo: 100,  hi:  250, label: '+100 to +250' },
  { lo: 250,  hi:  500, label: '+250 to +500' },
  { lo: 500,  hi: 1000, label: '+500 to +1000' },
  { lo: 1000, hi: Infinity, label: '≥ +1000%' },
]

function renderReturnsCharts(trades) {
  if (!CHARTS_OK) return
  const withRet = (trades || []).filter(t => t.return_pct != null)
  if (withRet.length < 5) {                 // too few to be worth a distribution
    const box = document.getElementById('chartbox-returns')
    if (box) box.hidden = true
    return
  }
  const box = document.getElementById('chartbox-returns')
  if (box) box.hidden = false

  // ── Distribution histogram ───────────────────────────────────────
  mount('chart-returns-dist', p => {
    const counts = BUCKETS.map(b => withRet.filter(t =>
      t.return_pct >= b.lo && t.return_pct < b.hi).length)
    if (!counts.some(c => c > 0)) return null

    return {
      type: 'bar',
      data: {
        labels: BUCKETS.map(b => b.label),
        datasets: [{
          label: 'Trades',
          data: counts,
          backgroundColor: BUCKETS.map(b =>
            b.hi <= 0 ? alpha(p.red, 0.65) : alpha(p.green, 0.7)),
          borderColor: BUCKETS.map(b => b.hi <= 0 ? p.red : p.green),
          borderWidth: 1, borderRadius: 3,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                const pct = (ctx.parsed.y / withRet.length * 100).toFixed(1)
                return `${ctx.parsed.y} trades  (${pct}% of ${withRet.length})`
              },
            },
          },
        },
        scales: {
          y: { grid: grid(p), beginAtZero: true, ticks: { color: p.faint, precision: 0 },
               title: { display: true, text: 'Number of trades', color: p.faint, font: { size: 11 } } },
          x: { grid: { display: false }, ticks: { color: p.text, font: { size: 10 }, maxRotation: 45 } },
        },
      },
    }
  })

  // ── Median return by sector ──────────────────────────────────────
  // Median, not mean. Over long windows a single multi-bagger drags a sector's
  // mean into the thousands of percent (Healthcare showed +5,489% on all-time
  // data), which is neither comparable across sectors nor plottable on a shared
  // axis. The median describes the typical trade, which is the actual question.
  // Sectors with a handful of trades produce noise, so require a real sample and
  // show only the strongest and weakest ends.
  mount('chart-returns-sector', p => {
    const median = xs => {
      const s = [...xs].sort((a, b) => a - b)
      const m = Math.floor(s.length / 2)
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
    }

    const bySector = {}
    for (const t of withRet) {
      const s = t.sector || 'Unclassified'
      ;(bySector[s] = bySector[s] || []).push(t.return_pct)
    }
    let rows = Object.entries(bySector)
      .filter(([, v]) => v.length >= 5)
      .map(([name, v]) => ({ name, n: v.length, med: median(v) }))
    if (rows.length < 2) return null

    rows.sort((a, b) => b.med - a.med)
    if (rows.length > 16) rows = [...rows.slice(0, 8), ...rows.slice(-8)]
    rows.sort((a, b) => a.med - b.med)

    return {
      type: 'bar',
      data: {
        labels: rows.map(r => `${r.name}  (n=${r.n})`),
        datasets: [{
          label: 'Median return',
          data: rows.map(r => r.med),
          backgroundColor: rows.map(r => r.med >= 0 ? alpha(p.green, 0.72) : alpha(p.red, 0.62)),
          borderColor: rows.map(r => r.med >= 0 ? p.green : p.red),
          borderWidth: 1, borderRadius: 3,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                const r = rows[ctx.dataIndex]
                const sign = r.med >= 0 ? '+' : ''
                return `median ${sign}${r.med.toFixed(1)}% across ${r.n} trades`
              },
            },
          },
        },
        scales: {
          x: { ...pctAxis(p), grid: grid(p) },
          y: { grid: { display: false }, ticks: { color: p.text, font: { size: 11 } } },
        },
      },
    }
  })
}

window.NSECharts = { initResearchCharts, renderReturnsCharts, CHARTS_OK }
