/* NSE Stock Screener — Research & Backtests guide.
 *
 * The interactive parts of the plain-English guide: the trade replay, the rule
 * checker, the "100 trades" picture, the win-rate calculator, the year chart and
 * the quiz. Everything reads window.RESEARCH_DATA (research-data.js), a static file
 * generated offline, so this tab never touches the database.
 *
 * Every number drawn here is also printed as text or in a table, so a failed
 * chart library or script leaves the page readable.
 */
(function () {
  const DATA = window.RESEARCH_DATA
  const $ = (sel, root = document) => root.querySelector(sel)
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

  // ── Formatting ────────────────────────────────────────────────────
  const MINUS = '−'
  const sign = v => (v > 0 ? '+' : v < 0 ? MINUS : '')
  const pct = (v, d = 1) => `${v < 0 ? MINUS : ''}${Math.abs(v).toFixed(d)}%`
  const spct = (v, d = 1) => `${sign(v)}${Math.abs(v).toFixed(d)}%`
  const int = v => Math.round(v).toLocaleString('en-IN')
  const rupees = v => `${v < 0 ? MINUS : ''}₹${Math.round(Math.abs(v)).toLocaleString('en-IN')}`
  const price = v => `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const date = iso => new Date(iso + 'T00:00:00Z')
    .toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

  const FMT = { pct, spct, int, x: v => `${v.toFixed(1)}×`, wk: v => `${v} weeks`, raw: v => String(v) }

  function h(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue
      if (k === 'class') n.className = v
      else if (k === 'text') n.textContent = v
      else n.setAttribute(k, v)
    }
    for (const k of kids.flat()) if (k != null) n.append(k instanceof Node ? k : document.createTextNode(k))
    return n
  }

  // ── [data-stat] fill: numbers in the prose come from the data file ──
  function fillStats() {
    $$('[data-stat]').forEach(el => {
      const [key, field] = el.dataset.stat.split(':')
      const v = DATA.stats[key]?.[field]
      if (v == null) return
      el.textContent = (FMT[el.dataset.fmt] || FMT.raw)(v)
    })
  }

  // ══════════════════════════════════════════════════════════════════
  // 1. Trade replay
  // ══════════════════════════════════════════════════════════════════
  const replay = { key: 'M&M', i: 0, timer: null }

  const tradePlugin = {
    id: 'rxTrade',
    beforeDatasetsDraw(chart) {
      const T = DATA.walk[replay.key]
      const { ctx, chartArea: a, scales: { x } } = chart
      const won = T.close[T.exit_idx] > T.close[T.entry_idx]
      const x0 = x.getPixelForValue(T.entry_idx), x1 = x.getPixelForValue(T.exit_idx)
      ctx.save()
      const o = chart.options.plugins.rxTrade
      ctx.fillStyle = won ? o.bandWin : o.bandLoss
      ctx.fillRect(x0, a.top, x1 - x0, a.bottom - a.top)
      ctx.restore()
    },
    afterDatasetsDraw(chart) {
      const T = DATA.walk[replay.key]
      const o = chart.options.plugins.rxTrade
      const { ctx, chartArea: a, scales: { x, y } } = chart
      ctx.save()
      ctx.font = '600 11px Inter, system-ui, sans-serif'
      ctx.textBaseline = 'top'
      for (const [idx, label] of [[T.entry_idx, `Buy ${price(T.close[T.entry_idx])}`],
                                  [T.exit_idx,  `Sell ${price(T.close[T.exit_idx])}`]]) {
        const px = x.getPixelForValue(idx)
        ctx.strokeStyle = o.ink; ctx.lineWidth = 1; ctx.setLineDash([])
        ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke()
        ctx.fillStyle = o.ink
        ctx.textAlign = px > a.right - 90 ? 'right' : 'left'
        ctx.fillText(label, px + (ctx.textAlign === 'left' ? 5 : -5), a.top + 4)
      }
      // Cursor for the week slider, with ringed dots on each line
      const cx = x.getPixelForValue(replay.i)
      ctx.strokeStyle = o.faint; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(cx, a.top); ctx.lineTo(cx, a.bottom); ctx.stroke()
      chart.data.datasets.forEach(ds => {
        const cy = y.getPixelForValue(ds.data[replay.i])
        ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2)
        ctx.fillStyle = ds.borderColor; ctx.fill()
        ctx.lineWidth = 2; ctx.strokeStyle = o.surface; ctx.stroke()
      })
      ctx.restore()
    },
  }

  function mountReplay() {
    const NC = window.NSECharts
    if (!NC?.CHARTS_OK) { $('#rx-replay-chartwrap')?.setAttribute('hidden', ''); return }
    NC.mount('chart-replay', p => {
      const T = DATA.walk[replay.key]
      const tick = iso => new Date(iso + 'T00:00:00Z')
        .toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' })
      return {
        type: 'line',
        data: {
          labels: T.dates,
          datasets: [
            { label: 'Weekly closing price', data: T.close, borderColor: p.muted, borderWidth: 1.5 },
            { label: 'EMA9 — fast line', data: T.ema9, borderColor: p.vizA, borderWidth: 2 },
            { label: 'EMA20 — slow line', data: T.ema20, borderColor: p.vizB, borderWidth: 2 },
          ].map(d => ({ ...d, pointRadius: 0, pointHoverRadius: 4, tension: 0, borderJoinStyle: 'round', borderCapStyle: 'round' })),
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: { mode: 'index', intersect: false },
          layout: { padding: { top: 6 } },
          plugins: {
            legend: { position: 'top', align: 'start',
              labels: { color: p.text, usePointStyle: true, pointStyle: 'line', boxWidth: 22, font: { size: 12 } } },
            tooltip: {
              callbacks: {
                title: items => date(T.dates[items[0].dataIndex]),
                label: c => ` ${price(c.parsed.y)}  ${c.dataset.label}`,
              },
            },
            // Plain values only: Chart.js treats functions in plugin options as
            // scriptable and calls them with its own context.
            rxTrade: {
              bandWin: NC.alpha(p.win, 0.09), bandLoss: NC.alpha(p.loss, 0.09),
              ink: p.text, faint: p.faint, surface: p.surface,
            },
          },
          scales: {
            x: { grid: { display: false }, ticks: { color: p.faint, maxTicksLimit: 7, maxRotation: 0,
                 callback: (v, i) => tick(T.dates[i]) } },
            y: { grid: { color: NC.alpha(p.line, 0.7) }, border: { display: false },
                 ticks: { color: p.faint, callback: v => '₹' + Number(v).toLocaleString('en-IN') } },
          },
        },
        plugins: [tradePlugin],
      }
    })
  }

  function replayStory(T, i) {
    const e = T.entry_idx, x = T.exit_idx
    const buy = T.close[e], sell = T.close[x]
    const result = (sell / buy - 1) * 100
    const weeks = x - e
    const above = T.ema9[i] > T.ema20[i]
    if (i < e) return {
      tag: 'Waiting', tone: 'wait',
      text: above
        ? 'EMA9 is above EMA20 here, but this is not a fresh cross that passed all six rules, so there is no signal.'
        : 'EMA9 (fast) is below EMA20 (slow): recent prices are weaker than the longer trend. No trade.',
    }
    if (i === e) return {
      tag: 'Golden cross — buy', tone: 'buy',
      text: `EMA9 has just moved above EMA20 and all six rules pass, so the scanner signals. We buy at this week's close of ${price(buy)}.`,
    }
    if (i < x) {
      const now = (T.close[i] / buy - 1) * 100
      return {
        tag: `Holding · ${spct(now)} so far`, tone: now >= 0 ? 'up' : 'down',
        text: 'We stay in. Dips do not matter to this strategy; the only sell trigger is EMA9 falling back below EMA20.',
      }
    }
    if (i === x) return {
      tag: `Death cross — sell · ${spct(result)}`, tone: result >= 0 ? 'up' : 'down',
      text: `EMA9 has fallen below EMA20, so we sell at ${price(sell)}. Result: ${spct(result)} after ${weeks} weeks.` +
        (result < 0 ? ' A loss like this is the most common outcome, and the exit rule is what keeps it small.' : ''),
    }
    const after = (T.close[i] / sell - 1) * 100
    return {
      tag: `Trade closed · ${spct(result)}`, tone: 'wait',
      text: `The trade is over. The price is now ${spct(after)} from where we sold. The strategy waits for the next fresh golden cross.`,
    }
  }

  function renderReplay() {
    const T = DATA.walk[replay.key]
    const i = replay.i
    const slider = $('#rx-week')
    slider.max = T.dates.length - 1
    slider.value = i
    slider.setAttribute('aria-valuetext', `Week of ${date(T.dates[i])}`)

    const s = replayStory(T, i)
    const out = $('#rx-readout')
    out.replaceChildren(
      h('div', { class: 'rx-readout-top' },
        h('span', { class: 'rx-readout-date', text: `Week ending ${date(T.dates[i])}` }),
        h('span', { class: `rx-pill rx-pill-${s.tone}`, text: s.tag })),
      h('div', { class: 'rx-readout-vals' },
        h('span', {}, h('i', { class: 'rx-key rx-key-price' }), 'Price ', h('b', { text: price(T.close[i]) })),
        h('span', {}, h('i', { class: 'rx-key rx-key-a' }), 'EMA9 ', h('b', { text: price(T.ema9[i]) })),
        h('span', {}, h('i', { class: 'rx-key rx-key-b' }), 'EMA20 ', h('b', { text: price(T.ema20[i]) }))),
      h('p', { class: 'rx-readout-text', text: s.text }))

    window.Chart?.getChart('chart-replay')?.draw()
  }

  function setTrade(key) {
    stopPlay()
    replay.key = key
    replay.i = 0
    $$('[data-trade]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.trade === key)))
    const T = DATA.walk[key]
    const result = (T.close[T.exit_idx] / T.close[T.entry_idx] - 1) * 100
    $('#rx-replay-summary').textContent =
      `${key}: bought ${date(T.entry)} at ${price(T.close[T.entry_idx])}, sold ${date(T.exit)} at ` +
      `${price(T.close[T.exit_idx])} — ${spct(result)} in ${T.exit_idx - T.entry_idx} weeks.`
    mountReplay()
    renderReplay()
    renderReplayTable()
  }

  function stopPlay() {
    if (replay.timer) clearInterval(replay.timer)
    replay.timer = null
    const b = $('#rx-play')
    if (b) { b.textContent = '▶ Play'; b.setAttribute('aria-pressed', 'false') }
  }

  function togglePlay() {
    if (replay.timer) return stopPlay()
    const T = DATA.walk[replay.key]
    if (replay.i >= T.dates.length - 1) replay.i = 0
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      replay.i = replay.i < T.entry_idx ? T.entry_idx : replay.i < T.exit_idx ? T.exit_idx : T.dates.length - 1
      return renderReplay()
    }
    const b = $('#rx-play')
    b.textContent = '❚❚ Pause'; b.setAttribute('aria-pressed', 'true')
    replay.timer = setInterval(() => {
      replay.i++
      // Pause briefly on the two moments that matter
      if (replay.i === T.entry_idx || replay.i === T.exit_idx) {
        renderReplay(); stopPlay(); return
      }
      if (replay.i >= T.dates.length - 1) { replay.i = T.dates.length - 1; stopPlay() }
      renderReplay()
    }, 110)
  }

  function renderReplayTable() {
    const T = DATA.walk[replay.key]
    const body = $('#rx-replay-table tbody')
    if (!body) return
    body.replaceChildren(...T.dates.map((d, i) => h('tr', {},
      h('td', { text: date(d) }),
      h('td', { class: 'r', text: price(T.close[i]) }),
      h('td', { class: 'r', text: price(T.ema9[i]) }),
      h('td', { class: 'r', text: price(T.ema20[i]) }),
      h('td', { text: i === T.entry_idx ? 'Buy (golden cross)' : i === T.exit_idx ? 'Sell (death cross)'
        : i > T.entry_idx && i < T.exit_idx ? 'Holding' : '' }))))
  }

  function initReplay() {
    if (!$('#rx-replay') || !DATA.walk) return
    $$('[data-trade]').forEach(b => b.addEventListener('click', () => setTrade(b.dataset.trade)))
    $('#rx-week').addEventListener('input', e => { stopPlay(); replay.i = +e.target.value; renderReplay() })
    $('#rx-play').addEventListener('click', togglePlay)
    $$('[data-jump]').forEach(b => b.addEventListener('click', () => {
      stopPlay()
      const T = DATA.walk[replay.key]
      replay.i = b.dataset.jump === 'entry' ? T.entry_idx : T.exit_idx
      renderReplay()
    }))
    setTrade('M&M')
  }

  // ══════════════════════════════════════════════════════════════════
  // 2. Rule checker — the 32 crosses of 10–11 Sep 2026
  // ══════════════════════════════════════════════════════════════════
  const GROUPS = [
    { k: 'short',   label: 'Too new to judge' },
    { k: 'above',   label: 'Not a fresh cross' },
    { k: 'checked', label: 'Fresh cross, failed the trend rules' },
  ]

  function checkRows(c) {
    const n = v => v.toLocaleString('en-IN', { maximumFractionDigits: 3 })
    const rising = c.e20 && c.e20.every((v, i) => i === 0 || v > c.e20[i - 1])
    const skip = 'Not checked — the scanner stops at an earlier rule'
    const rows = [
      ['The fast line crosses above the slow line', 'pass', 'EMA9 moved above EMA20 on this day'],
      ['It is a fresh cross',
        c.k === 'short' ? 'skip' : c.k === 'above' ? 'fail' : 'pass',
        c.k === 'short' ? skip : c.k === 'above' ? 'EMA9 was already above EMA20 the week before' : 'The week before, EMA9 was still at or below EMA20'],
      ['The slow line rose 4 weeks in a row',
        c.k === 'short' ? 'skip' : rising ? 'pass' : 'fail',
        c.k === 'short' ? skip : `EMA20, 4 weeks ago → now: ${c.e20.map(n).join(' → ')}`],
      ['The gap is big enough',
        c.k === 'short' ? 'skip' : c.gap ? 'pass' : 'fail',
        c.k === 'short' ? skip : `Gap ${n(c.sp)} vs ${n(c.need)} needed (5% of the stock's typical weekly swing)`],
      ['Volume above its 20-day average',
        c.k === 'short' ? 'skip' : c.vol ? 'pass' : 'fail',
        c.k === 'short' ? skip : c.vol ? "The day's volume was above its 20-day average" : "The day's volume was not above its 20-day average"],
      ['At least 6 weeks of price history',
        c.k === 'short' ? 'fail' : 'pass',
        c.k === 'short' ? `Only ${c.w} weeks of prices — a recent listing` : 'Enough history'],
    ]
    return rows
  }

  function renderCheck(c) {
    $$('#rx-checker-picks button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.sym === c.s)))
    const verdict = {
      short: 'No signal — the stock is too new. Moving averages need at least 6 weeks of prices; with fewer, a "cross" is just noise from the first few prices.',
      above: 'No signal — this was not a fresh cross. EMA9 was already above EMA20 last week, so the move had started earlier. Rules 3–5 are shown only for learning.',
      checked: 'No signal — the cross was fresh, but the trend was not strong enough to pass the rules marked below.',
    }[c.k]
    const ICON = { pass: '✓', fail: '✗', skip: '–' }
    const WORD = { pass: 'Pass', fail: 'Fail', skip: 'Skipped' }
    $('#rx-checker-result').replaceChildren(
      h('div', { class: 'rx-check-head' },
        h('span', { class: 'rx-check-sym', text: c.s }),
        h('span', { class: 'rx-check-date', text: date(c.d) })),
      h('p', { class: 'rx-check-verdict', text: verdict }),
      h('ol', { class: 'rx-check-list' }, checkRows(c).map(([name, st, detail]) =>
        h('li', { class: `rx-check-row rx-${st}` },
          h('span', { class: 'rx-check-icon', 'aria-hidden': 'true', text: ICON[st] }),
          h('span', { class: 'rx-check-body' },
            h('span', { class: 'rx-check-name' }, name, h('span', { class: 'rx-check-word', text: ` · ${WORD[st]}` })),
            h('span', { class: 'rx-check-detail', text: detail }))))))
  }

  function initChecker() {
    const picks = $('#rx-checker-picks')
    if (!picks || !DATA.checker) return
    for (const g of GROUPS) {
      const items = DATA.checker.filter(c => c.k === g.k)
      picks.append(h('div', { class: 'rx-pick-group' },
        h('div', { class: 'rx-pick-label' }, g.label, h('span', { class: 'rx-pick-count', text: ` ${items.length}` })),
        h('div', { class: 'rx-pick-row' }, items.map(c => {
          const b = h('button', { type: 'button', class: 'rx-pick', 'data-sym': c.s, 'aria-pressed': 'false', text: c.s })
          b.addEventListener('click', () => renderCheck(c))
          return b
        }))))
    }
    renderCheck(DATA.checker.find(c => c.s === 'SBIN') || DATA.checker[0])
  }

  // ══════════════════════════════════════════════════════════════════
  // 3. 100 trades picture
  // ══════════════════════════════════════════════════════════════════
  const BUCKETS = [
    { cls: 'loss-big',   label: 'lost more than 10%' },
    { cls: 'loss-small', label: 'lost up to 10%' },
    { cls: 'win-small',  label: 'gained up to 50%' },
    { cls: 'win-big',    label: 'gained more than 50%' },
  ]

  // Largest-remainder rounding so the four groups always add up to exactly 100
  function per100(counts) {
    const total = counts.reduce((a, b) => a + b, 0)
    const raw = counts.map(c => c / total * 100)
    const out = raw.map(Math.floor)
    const order = raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0])
    for (let k = 0; out.reduce((a, b) => a + b, 0) < 100; k++) out[order[k][1]]++
    return out
  }

  function renderWaffle(mode) {
    const key = mode === 'every' ? 'since2016.every' : 'since2016.current'
    const s = DATA.stats[key]
    const n = per100(s.buckets4)
    $$('[data-waffle]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.waffle === mode)))

    const grid = $('#rx-waffle')
    if (!grid.children.length) for (let i = 0; i < 100; i++) grid.append(h('span', { class: 'rx-dot' }))
    let i = 0
    n.forEach((count, b) => { for (let k = 0; k < count; k++) grid.children[i++].className = `rx-dot ${BUCKETS[b].cls}` })

    const lost = n[0] + n[1], won = n[2] + n[3]
    grid.setAttribute('aria-label',
      `Out of 100 trades: ${n.map((c, b) => `${c} ${BUCKETS[b].label}`).join(', ')}.`)
    $('#rx-waffle-legend').replaceChildren(...n.map((c, b) =>
      h('li', {}, h('span', { class: `rx-dot ${BUCKETS[b].cls}`, 'aria-hidden': 'true' }),
        h('b', { text: String(c) }), ` ${BUCKETS[b].label}`)))
    $('#rx-waffle-caption').replaceChildren(
      h('b', { text: `${lost} lose money` }), ', ', h('b', { text: `${won} make money` }),
      mode === 'every'
        ? ` — the old rule took every crossover (${int(s.per_year)} a year). Far more small losses, and only ${n[3]} big winners in 100.`
        : ` — yet the ${n[3]} big winners are large enough to pay for all the losers, as the next section shows.`)
  }

  function initWaffle() {
    if (!$('#rx-waffle')) return
    $$('[data-waffle]').forEach(b => b.addEventListener('click', () => renderWaffle(b.dataset.waffle)))
    renderWaffle('current')
  }

  // ══════════════════════════════════════════════════════════════════
  // 4. Win-rate calculator
  // ══════════════════════════════════════════════════════════════════
  function presets() {
    const c = DATA.stats['since2016.current'], e = DATA.stats['since2016.every']
    return {
      avg:     { wr: c.win, win: c.avg_win, loss: -c.avg_loss, note: "Today's 6 rules, average winner and loser since 2016." },
      typical: { wr: c.win, win: c.med_win, loss: -c.med_loss, note: "Today's 6 rules using the typical (median) winner and loser — this ignores the rare huge winners, so it is the cautious view." },
      old:     { wr: e.win, win: e.avg_win, loss: -e.avg_loss, note: 'The old rule that bought every crossover.' },
      coin:    { wr: 50, win: 10, loss: 10, note: 'A coin-flip trader who wins and loses the same amount breaks even before costs, however often they are "right".' },
    }
  }

  function renderCalc() {
    const wr = +$('#calc-wr').value, win = +$('#calc-win').value, loss = +$('#calc-loss').value
    $('#calc-wr-val').textContent = `${wr}%`
    $('#calc-win-val').textContent = `+${win}%`
    $('#calc-loss-val').textContent = `${MINUS}${loss}%`

    const stake = 10000, trades = 100
    const winners = wr, losers = trades - wr
    const won = winners * stake * win / 100
    const lost = losers * stake * loss / 100
    const net = won - lost
    const perTrade = net / trades
    const breakeven = loss / (win + loss) * 100

    const max = Math.max(won, lost, 1)
    $('#calc-bar-won').style.width = `${won / max * 100}%`
    $('#calc-bar-lost').style.width = `${lost / max * 100}%`
    $('#calc-won').textContent = `${winners} winners make ${rupees(won)}`
    $('#calc-lost').textContent = `${losers} losers lose ${rupees(lost)}`
    const out = $('#calc-net')
    out.textContent = `${net >= 0 ? 'Net profit' : 'Net loss'}: ${rupees(net)} — ${rupees(perTrade)} per trade on average`
    out.className = `rx-calc-net ${net > 0 ? 'is-up' : net < 0 ? 'is-down' : ''}`
    $('#calc-breakeven').textContent =
      `With winners of +${win}% and losers of ${MINUS}${loss}%, you only need to be right ${breakeven.toFixed(1)}% of the time to break even.`
  }

  function initCalc() {
    if (!$('#calc-wr')) return
    const P = presets()
    const apply = key => {
      const v = P[key]
      $('#calc-wr').value = Math.round(v.wr)
      $('#calc-win').value = Math.round(v.win)
      $('#calc-loss').value = Math.round(v.loss * 2) / 2
      $('#calc-note').textContent = v.note
      $$('[data-preset]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.preset === key)))
      renderCalc()
    }
    $$('[data-preset]').forEach(b => b.addEventListener('click', () => apply(b.dataset.preset)))
    ;['#calc-wr', '#calc-win', '#calc-loss'].forEach(id => $(id).addEventListener('input', () => {
      $$('[data-preset]').forEach(b => b.setAttribute('aria-pressed', 'false'))
      $('#calc-note').textContent = 'Your own numbers.'
      renderCalc()
    }))
    apply('avg')
  }

  // ══════════════════════════════════════════════════════════════════
  // 5. Win rate by year (HTML columns, labelled; table view below)
  // ══════════════════════════════════════════════════════════════════
  function initYears() {
    const box = $('#rx-years')
    if (!box || !DATA.yearly) return
    const avg = DATA.stats['since2016.current'].win
    const MAX = 70
    box.style.setProperty('--avgf', String(avg / MAX))
    $('#rx-years-avg').textContent = `Average ${pct(avg)}`
    const cols = DATA.yearly.map(y => {
      const early = y.open > y.closed         // most of the year's trades still running
      const label = early ? 'too early' : pct(y.win, 0)
      return h('li', {
        class: `rx-year${early ? ' is-early' : ''}`,
        'aria-label': early
          ? `${y.year}: ${y.open} of ${y.entries} trades still open, too early to judge`
          : `${y.year}: ${pct(y.win)} of ${y.closed} finished trades made money`,
      },
        h('span', { class: 'rx-year-bar', style: `height:${early ? 100 : Math.max(y.win / MAX * 100, 1)}%` },
          h('span', { class: 'rx-year-val', text: label })),
        h('span', { class: 'rx-year-label', text: String(y.year) }),
        h('span', { class: 'rx-year-n', text: `n=${y.closed}` }))
    })
    box.replaceChildren(...cols)

    $('#rx-years-table tbody')?.replaceChildren(...DATA.yearly.map(y => h('tr', {},
      h('td', { text: String(y.year) }),
      h('td', { class: 'r', text: int(y.entries) }),
      h('td', { class: 'r', text: int(y.closed) }),
      h('td', { class: 'r', text: int(y.open) }),
      h('td', { class: 'r', text: y.win == null ? '—' : pct(y.win) }),
      h('td', { class: 'r', text: y.median == null ? '—' : spct(y.median) }))))
  }

  // ══════════════════════════════════════════════════════════════════
  // 6. Rule versions compared
  // ══════════════════════════════════════════════════════════════════
  function initVariants() {
    const t = $('#rx-variants')
    if (!t) return
    const cols = ['since2016.every', 'since2016.no_volume', 'since2016.current'].map(k => DATA.stats[k])
    const rows = [
      ['Signals per year', s => `~${int(s.per_year)}`],
      ['Trades that made money', s => pct(s.win)],
      ['Trades that gained 10% or more', s => pct(s.big10)],
      ['Typical winner (median)', s => spct(s.med_win)],
      ['Typical loser (median)', s => spct(s.med_loss)],
      ['Average result per trade', s => spct(s.mean)],
      ['Money won ÷ money lost', s => `${s.pf.toFixed(2)}×`],
      ['Typical holding time', s => `${s.hold} weeks`],
      ['Finished trades in the test', s => int(s.closed)],
    ]
    t.querySelector('tbody').replaceChildren(...rows.map(([label, f]) =>
      h('tr', {}, h('th', { scope: 'row', text: label }), ...cols.map((s, i) =>
        h('td', { class: i === 2 ? 'r is-live' : 'r', text: f(s) })))))
  }

  // ══════════════════════════════════════════════════════════════════
  // Quiz, chapter nav, deep-dive charts
  // ══════════════════════════════════════════════════════════════════
  function initQuiz() {
    $$('.rx-quiz-q').forEach(q => {
      const fb = $('.rx-quiz-fb', q)
      $$('.rx-quiz-opt', q).forEach(opt => opt.addEventListener('click', () => {
        $$('.rx-quiz-opt', q).forEach(o => o.classList.remove('is-right', 'is-wrong'))
        const ok = opt.dataset.ok === '1'
        opt.classList.add(ok ? 'is-right' : 'is-wrong')
        if (!ok) $('.rx-quiz-opt[data-ok="1"]', q)?.classList.add('is-right')
        fb.textContent = `${ok ? '✓ Correct. ' : '✗ Not quite. '}${q.dataset.explain}`
        fb.className = `rx-quiz-fb ${ok ? 'is-right' : 'is-wrong'}`
      }))
    })
  }

  function initChapterNav() {
    const links = $$('#panel-research .rx-chapnav a')
    if (!links.length || !('IntersectionObserver' in window)) return
    const byId = new Map(links.map(a => [a.getAttribute('href').slice(1), a]))
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (!e.isIntersecting) return
        links.forEach(a => a.removeAttribute('aria-current'))
        const a = byId.get(e.target.id)
        if (a) { a.setAttribute('aria-current', 'true'); a.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }) }
      })
    }, { rootMargin: '-180px 0px -65% 0px' })
    byId.forEach((_, id) => { const s = document.getElementById(id); if (s) io.observe(s) })
  }

  // Charts inside a closed <details> are laid out at zero size; resize them on open.
  function initDeepDive() {
    $$('details.rx-deep').forEach(d => d.addEventListener('toggle', () => {
      if (!d.open || typeof Chart === 'undefined') return
      $$('canvas', d).forEach(c => Chart.getChart(c)?.resize())
    }))
  }

  let started = false
  function init() {
    if (started || !DATA) return
    started = true
    const steps = [fillStats, initReplay, initChecker, initWaffle, initCalc, initYears, initVariants, initQuiz, initChapterNav, initDeepDive]
    for (const step of steps) {
      try { step() } catch (err) { console.warn('[research]', step.name, 'failed:', err) }
    }
  }

  window.NSEResearch = { init }
})()
