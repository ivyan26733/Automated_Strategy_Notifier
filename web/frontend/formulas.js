/* NSE Stock Screener — Formula Sheet interactives.
 *
 * Every worked example uses M&M's golden-cross week (week ending 19 Jun 2020),
 * taken from the scanner's own candle, EMA and ATR code. The widgets only
 * recompute those published formulas in the browser; nothing here calls the API.
 * All numbers a widget shows are also written as text on the page.
 */
(function () {
  const $ = (sel, root = document) => root.querySelector(sel)
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]
  const MINUS = '−'

  // ── M&M, week ending 19 Jun 2020 (4-decimal values from the scanner code) ──
  const MM = {
    prev9: 433.8564, prev20: 437.8541,
    atr: 50.1721, close: 500.05,
    volAvg: 8438285, vol: 9811021,
  }
  const A9 = 2 / 10, A20 = 2 / 21, K = 0.05

  const VOL_DAYS = [
    ['2020-05-21', 6249309], ['2020-05-22', 10016203], ['2020-05-26', 5895376], ['2020-05-27', 7591278],
    ['2020-05-28', 7449375], ['2020-05-29', 9539035], ['2020-06-01', 9668047], ['2020-06-02', 8520940],
    ['2020-06-03', 9873294], ['2020-06-04', 5829493], ['2020-06-05', 6265829], ['2020-06-08', 5955200],
    ['2020-06-09', 7656301], ['2020-06-10', 4849036], ['2020-06-11', 4331683], ['2020-06-12', 18368009],
    ['2020-06-15', 17605860], ['2020-06-16', 6712936], ['2020-06-17', 9273745], ['2020-06-18', 7114752],
    ['2020-06-19', 9811021],
  ]

  // Quartile breakpoints of all 2016–2022 research signals (illustrative: the research
  // itself used expanding windows, so each signal was scored against earlier ones only)
  const BREAKS = {
    pos:   [0.447, 0.581, 0.717],
    diff:  [0.177, 0.423, 0.864],
    mom:   [6.375, 12.133, 20.4],
    slope: [0.481, 1.23, 2.231],
  }
  // [score, win rate %, signals] — win = +10% or more, 0–10% left out, 2016–2022, after burn-in
  const LADDER = [[0, 20.6, 126], [1, 18.7, 267], [2, 24.3, 519], [3, 23.8, 618], [4, 26.4, 673],
    [5, 26.0, 619], [6, 29.0, 701], [7, 28.7, 637], [8, 29.2, 586], [9, 33.2, 585],
    [10, 37.2, 473], [11, 37.9, 351], [12, 36.9, 350]]

  // ── Formatting ────────────────────────────────────────────────────
  const neg = v => (v < 0 ? MINUS : '')
  const n2 = v => `${neg(v)}${Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const rs = v => `${neg(v)}₹${Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const pct = (v, d = 1) => `${neg(v)}${Math.abs(v).toFixed(d)}%`
  const spct = (v, d = 1) => `${v > 0 ? '+' : neg(v)}${Math.abs(v).toFixed(d)}%`
  const lakh = v => `${(v / 1e5).toLocaleString('en-IN', { maximumFractionDigits: 1 })} lakh`
  const date = iso => new Date(iso + 'T00:00:00Z')
    .toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })

  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'text') el.textContent = v
      else el.setAttribute(k, v)
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid instanceof Node ? kid : document.createTextNode(kid))
    return el
  }

  function checkRow(name, ok, detail) {
    const st = ok === null ? 'skip' : ok ? 'pass' : 'fail'
    return h('li', { class: `rx-check-row rx-${st}` },
      h('span', { class: 'rx-check-icon', 'aria-hidden': 'true', text: { pass: '✓', fail: '✗', skip: '–' }[st] }),
      h('span', { class: 'rx-check-body' },
        h('span', { class: 'rx-check-name' }, name,
          h('span', { class: 'rx-check-word', text: ` · ${{ pass: 'Pass', fail: 'Fail', skip: 'Not reached' }[st]}` })),
        h('span', { class: 'rx-check-detail', text: detail })))
  }

  // ══════════════════════════════════════════════════════════════════
  // Signal simulator: move M&M's closing price and volume for the week
  // ══════════════════════════════════════════════════════════════════
  function initSimulator() {
    const closeIn = $('#fx-sim-close'), volIn = $('#fx-sim-vol')
    if (!closeIn || !volIn) return

    // Closing prices at which each rule starts to pass (ATR held at this week's value)
    const slope = A9 - A20
    const base = (1 - A9) * MM.prev9 - (1 - A20) * MM.prev20      // gap = base + slope × close
    const needCross = -base / slope
    const needGap = (K * MM.atr - base) / slope
    const needRise = MM.prev20                                     // EMA20 rises iff close > previous EMA20

    $('#fx-sim-thresholds').replaceChildren(
      h('li', {}, 'EMA9 moves above EMA20 once the close is above ', h('b', { text: rs(needCross) })),
      h('li', {}, 'EMA20 keeps rising as long as the close is above ', h('b', { text: rs(needRise) })),
      h('li', {}, 'The gap reaches 5% of ATR once the close is at least ', h('b', { text: rs(needGap) })),
      h('li', {}, 'Volume must beat the 20-day average of ', h('b', { text: lakh(MM.volAvg) })))

    const render = () => {
      const c = +closeIn.value, vol = +volIn.value * 1e5
      const e9 = MM.prev9 + A9 * (c - MM.prev9)
      const e20 = MM.prev20 + A20 * (c - MM.prev20)
      const gap = e9 - e20, need = K * MM.atr
      const crossed = e9 > e20
      const rising = e20 > MM.prev20
      const gapOk = gap >= need
      const volOk = vol > MM.volAvg
      const chg = (c / 508.45 - 1) * 100   // previous week's close

      $('#fx-sim-close-val').textContent = rs(c)
      $('#fx-sim-vol-val').textContent = lakh(vol)
      closeIn.setAttribute('aria-valuetext', rs(c))
      volIn.setAttribute('aria-valuetext', lakh(vol))

      $('#fx-sim-math').replaceChildren(
        h('div', {}, h('span', { class: 'fx-lbl', text: 'EMA9' }),
          `433.86 + 0.20 × (${n2(c)} − 433.86) = `, h('b', { text: n2(e9) })),
        h('div', {}, h('span', { class: 'fx-lbl', text: 'EMA20' }),
          `437.85 + 0.0952 × (${n2(c)} − 437.85) = `, h('b', { text: n2(e20) })),
        h('div', {}, h('span', { class: 'fx-lbl', text: 'Gap' }),
          `${n2(e9)} − ${n2(e20)} = `, h('b', { text: n2(gap) }), `  (needs ${n2(need)})`),
        h('div', { class: 'fx-muted' }, `This close is ${spct(chg)} versus last week's ₹508.45.`))

      const reached = crossed   // the scanner only looks at rules 2–5 once there is a cross
      $('#fx-sim-rules').replaceChildren(
        checkRow('Fast line crosses above slow line', crossed,
          `EMA9 ${n2(e9)} ${crossed ? '>' : '≤'} EMA20 ${n2(e20)}; last week 433.86 ≤ 437.85`),
        checkRow('Slow line rose 4 weeks in a row', reached ? rising : null,
          `423.54 → 424.76 → 430.42 → 437.85 → ${n2(e20)}`),
        checkRow('Gap is big enough', reached && rising ? gapOk : null,
          `${n2(gap)} vs ${n2(need)} needed (0.05 × ATR ${n2(MM.atr)})`),
        checkRow('Volume above its 20-day average', reached && rising && gapOk ? volOk : null,
          `${lakh(vol)} vs ${lakh(MM.volAvg)}`),
        checkRow('At least 6 weeks of history', true, 'M&M has decades of weekly prices'))

      const signal = crossed && rising && gapOk && volOk
      const why = !crossed ? 'no cross yet: EMA9 is still at or below EMA20.'
        : !rising ? 'EMA20 fell this week, so the trend rule fails.'
        : !gapOk ? 'the lines crossed, but only by a hairline.'
        : 'the cross is valid, but volume was not above normal.'
      const v = $('#fx-sim-verdict')
      v.className = `fx-verdict ${signal ? 'is-yes' : 'is-no'}`
      v.textContent = signal
        ? '✓ Signal: all rules pass, so M&M would appear in Fresh EMA Crossovers.'
        : `✗ No signal: ${why}`
    }

    closeIn.addEventListener('input', render)
    volIn.addEventListener('input', render)
    $('#fx-sim-reset').addEventListener('click', () => {
      closeIn.value = MM.close
      volIn.value = (MM.vol / 1e5).toFixed(1)
      render()
    })
    render()
  }

  // ══════════════════════════════════════════════════════════════════
  // How much each past week counts in EMA9 vs EMA20
  // ══════════════════════════════════════════════════════════════════
  function initWeights() {
    const box = $('#fx-weights')
    if (!box) return
    const rows = Array.from({ length: 10 }, (_, k) => ({
      k, w9: A9 * (1 - A9) ** k * 100, w20: A20 * (1 - A20) ** k * 100,
    }))
    const label = k => k === 0 ? 'This week' : k === 1 ? '1 week ago' : `${k} weeks ago`
    box.replaceChildren(...rows.map(r => h('div', { class: 'fx-w-row' },
      h('span', { class: 'fx-w-label', text: label(r.k) }),
      h('span', { class: 'fx-w-bars' },
        h('span', { class: 'fx-w-line' },
          h('span', { class: 'fx-w-bar fx-w-a', style: `--w:${r.w9 / 20}` }),
          h('span', { class: 'fx-w-val', text: pct(r.w9) })),
        h('span', { class: 'fx-w-line' },
          h('span', { class: 'fx-w-bar fx-w-b', style: `--w:${r.w20 / 20}` }),
          h('span', { class: 'fx-w-val', text: pct(r.w20) }))))))
    const last4 = [1 - (1 - A9) ** 4, 1 - (1 - A20) ** 4].map(x => pct(x * 100, 0))
    $('#fx-weights-sum').textContent =
      `The last 4 weeks make up ${last4[0]} of EMA9 but only ${last4[1]} of EMA20. That is why EMA9 turns first.`
  }

  // ══════════════════════════════════════════════════════════════════
  // 20-day volume bars for the volume rule
  // ══════════════════════════════════════════════════════════════════
  function initVolume() {
    const box = $('#fx-volbars')
    if (!box) return
    const max = Math.max(...VOL_DAYS.map(d => d[1]))
    const avg = VOL_DAYS.slice(0, 20).reduce((a, d) => a + d[1], 0) / 20
    box.style.setProperty('--avgf', String(avg / max))
    box.replaceChildren(...VOL_DAYS.map(([d, v], i) => {
      const today = i === VOL_DAYS.length - 1
      return h('li', {
        class: `fx-vol${today ? ' is-today' : ''}`,
        title: `${date(d)}: ${lakh(v)}`,
        'aria-label': `${date(d)}${today ? ' (signal day)' : ''}: ${lakh(v)} shares`,
      }, h('span', { class: 'fx-vol-bar', style: `height:${v / max * 100}%` },
        today ? h('span', { class: 'fx-vol-val', text: lakh(v) }) : null))
    }))
    $('#fx-vol-table tbody')?.replaceChildren(...VOL_DAYS.map(([d, v], i) => h('tr', {},
      h('td', { text: date(d) + (i === 20 ? ' (signal day)' : '') }),
      h('td', { class: 'r', text: v.toLocaleString('en-IN') }))))
  }

  // ══════════════════════════════════════════════════════════════════
  // Trade-list calculator: every backtest statistic from your own numbers
  // ══════════════════════════════════════════════════════════════════
  const TRADE_PRESETS = {
    five: '-12, -9, -6, +18, +160',
    mm: '+52.8, -10.4',
    coin: '+10, -10, +10, -10',
    streak: '-8, -11, -14, -6, -9, -12, +95',
  }

  function parseTrades(text) {
    return String(text).replace(/[−–—]/g, '-').split(/[\s,;]+/)
      .map(s => parseFloat(s)).filter(Number.isFinite).slice(0, 200)
  }

  function renderTrades() {
    const rets = parseTrades($('#fx-trades-input').value)
    const out = $('#fx-trades-out'), chain = $('#fx-trades-chain')
    if (!rets.length) {
      out.replaceChildren(h('p', { class: 'fx-muted', text: 'Type trade returns in %, separated by commas.' }))
      chain.textContent = ''
      return
    }
    const nT = rets.length
    const wins = rets.filter(r => r > 0), losses = rets.filter(r => r <= 0)
    const big = rets.filter(r => r >= 10).length, lost = rets.filter(r => r < 0).length
    const sorted = [...rets].sort((a, b) => a - b)
    const mid = Math.floor(nT / 2)
    const median = nT % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    const sum = xs => xs.reduce((a, b) => a + b, 0)
    const mean = sum(rets) / nT
    const avgWin = wins.length ? sum(wins) / wins.length : null
    const avgLoss = losses.length ? sum(losses) / losses.length : null
    const pf = losses.length && sum(losses) !== 0 ? sum(wins) / -sum(losses) : null
    let capital = 100
    const steps = ['₹100']
    for (const r of rets.slice(0, 12)) { capital *= 1 + r / 100; steps.push(rs(capital)) }
    for (const r of rets.slice(12)) capital *= 1 + r / 100

    const row = (label, value, how) => h('tr', {},
      h('th', { scope: 'row', text: label }), h('td', { class: 'r', text: value }), h('td', { class: 'fx-how', text: how }))
    out.replaceChildren(h('table', { class: 'rx-table fx-trades-table' },
      h('thead', {}, h('tr', {}, h('th', { text: 'Statistic' }), h('th', { class: 'r', text: 'Value' }), h('th', { text: 'How it was worked out' }))),
      h('tbody', {},
        row('Win rate (any profit)', pct(wins.length / nT * 100), `${wins.length} trades above 0% ÷ ${nT} trades`),
        row('Win rate (research rule)', big + lost ? pct(big / (big + lost) * 100) : '—',
          `${big} trades ≥ +10% ÷ (${big} + ${lost} below 0%); ${nT - big - lost} trades between 0% and 10% left out`),
        row('Median (typical) trade', spct(median), `middle value of ${sorted.map(v => spct(v, 1)).join(', ')}`),
        row('Average trade', spct(mean), `sum ${spct(sum(rets))} ÷ ${nT}`),
        row('Average win / average loss', `${avgWin == null ? '—' : spct(avgWin)} / ${avgLoss == null ? '—' : spct(avgLoss)}`, 'mean of the winning trades / mean of the rest'),
        row('Profit factor', pf == null ? 'no losses' : `${pf.toFixed(2)}×`,
          losses.length ? `${spct(sum(wins))} won ÷ ${pct(-sum(losses))} lost` : 'needs at least one losing trade'),
        row('₹100 compounded through all trades', rs(capital), 'multiply by (1 + return) trade after trade, as on the Returns tab'))))
    chain.textContent = steps.join(' → ') + (rets.length > 12 ? ' → …' : '')
  }

  function initTrades() {
    const input = $('#fx-trades-input')
    if (!input) return
    input.addEventListener('input', () => {
      $$('[data-trades]').forEach(b => b.setAttribute('aria-pressed', 'false'))
      renderTrades()
    })
    $$('[data-trades]').forEach(b => b.addEventListener('click', () => {
      input.value = TRADE_PRESETS[b.dataset.trades]
      $$('[data-trades]').forEach(x => x.setAttribute('aria-pressed', String(x === b)))
      renderTrades()
    }))
    renderTrades()
  }

  // ══════════════════════════════════════════════════════════════════
  // Score a cross (research composite score)
  // ══════════════════════════════════════════════════════════════════
  const SCORE_PRESETS = {
    mm:     { pos: 0.573, diff: 0.75, mom: 17.29, slope: 4.78 },
    strong: { pos: 0.92, diff: 1.10, mom: 24.0, slope: 3.10 },
    weak:   { pos: 0.30, diff: 0.10, mom: 3.0, slope: 0.20 },
  }
  const FEATURES = [
    ['pos', 'Position in 52-week range', v => v.toFixed(3)],
    ['diff', 'EMA gap %', v => `${v.toFixed(2)}%`],
    ['mom', '4-week momentum', v => spct(v)],
    ['slope', 'EMA20 slope over 4 weeks', v => spct(v, 2)],
  ]

  function points(v, [q25, q50, q75]) { return v < q25 ? 0 : v < q50 ? 1 : v < q75 ? 2 : 3 }

  function renderScore() {
    const vals = Object.fromEntries(FEATURES.map(([k]) => [k, parseFloat($(`#fx-sc-${k}`).value)]))
    if (FEATURES.some(([k]) => !Number.isFinite(vals[k]))) return
    let total = 0
    const BAND = ['bottom quarter', '2nd quarter', '3rd quarter', 'top quarter']
    $('#fx-sc-points').replaceChildren(...FEATURES.map(([k, label, f]) => {
      const p = points(vals[k], BREAKS[k]); total += p
      const [a, b, c] = BREAKS[k]
      return h('tr', {},
        h('th', { scope: 'row', text: label }),
        h('td', { class: 'r', text: f(vals[k]) }),
        h('td', { text: `${BAND[p]} (quarters split at ${a} / ${b} / ${c})` }),
        h('td', { class: 'r', text: `${p} pt${p === 1 ? '' : 's'}` }))
    }))
    const [, wr, nS] = LADDER[total]
    $('#fx-sc-total').replaceChildren(
      h('b', { text: `Score ${total} of 12` }),
      ` — in 2016–2022, crosses with exactly this score gained 10% or more ${pct(wr)} of the time (${nS.toLocaleString('en-IN')} signals, 0–10% trades left out).`)
    $$('#fx-sc-ladder li').forEach((li, i) => li.classList.toggle('is-current', i === total))
  }

  function initScore() {
    const ladder = $('#fx-sc-ladder')
    if (!ladder) return
    const MAX = 40
    ladder.replaceChildren(...LADDER.map(([s, wr, nS]) => h('li', {
      class: 'fx-ladder-col', 'aria-label': `Score ${s}: ${pct(wr)} won, ${nS} signals`, title: `${nS} signals`,
    }, h('span', { class: 'fx-ladder-bar', style: `height:${wr / MAX * 100}%` },
      h('span', { class: 'fx-ladder-val', text: `${Math.round(wr)}%` })),
    h('span', { class: 'fx-ladder-label', text: String(s) }))))
    $('#fx-sc-table tbody')?.replaceChildren(...LADDER.map(([s, wr, nS]) => h('tr', {},
      h('td', { text: String(s) }), h('td', { class: 'r', text: pct(wr) }), h('td', { class: 'r', text: nS.toLocaleString('en-IN') }))))

    FEATURES.forEach(([k]) => $(`#fx-sc-${k}`).addEventListener('input', () => {
      $$('[data-score-preset]').forEach(b => b.setAttribute('aria-pressed', 'false'))
      renderScore()
    }))
    $$('[data-score-preset]').forEach(b => b.addEventListener('click', () => {
      const p = SCORE_PRESETS[b.dataset.scorePreset]
      FEATURES.forEach(([k]) => { $(`#fx-sc-${k}`).value = p[k] })
      $$('[data-score-preset]').forEach(x => x.setAttribute('aria-pressed', String(x === b)))
      renderScore()
    }))
    renderScore()
  }

  // ══════════════════════════════════════════════════════════════════
  // Section switching helpers (the pill nav itself lives in app.js)
  // ══════════════════════════════════════════════════════════════════
  function initJumps() {
    const nav = $('#panel-formulas .formula-nav')
    const go = section => {
      $(`#panel-formulas .formula-nav-btn[data-section="${section}"]`)?.click()
    }
    $$('#panel-formulas [data-goto]').forEach(b => b.addEventListener('click', () => go(b.dataset.goto)))
    // After switching sections from far down the page, bring the new section's top into
    // view. The nav is sticky, so measure the section container, not the nav itself.
    const wrap = $('#panel-formulas .formula-wrap')
    $$('#panel-formulas .formula-nav-btn').forEach(b => b.addEventListener('click', () => {
      $$('#panel-formulas .formula-nav-btn').forEach(x => x.setAttribute('aria-pressed', String(x === b)))
      if (!wrap || !nav) return
      // The sticky chrome is 108px with the tab bar and 112px with the phone
      // drawer; read the token rather than hardcode one of them.
      const shellTop = parseInt(getComputedStyle(document.documentElement)
        .getPropertyValue('--shell-top'), 10) || 108
      const top = wrap.getBoundingClientRect().top + window.scrollY - (shellTop + 2)
      if (window.scrollY > top) window.scrollTo({ top: Math.max(top, 0) })
    }))
  }

  let started = false
  function init() {
    if (started) return
    started = true
    for (const step of [initJumps, initSimulator, initWeights, initVolume, initTrades, initScore]) {
      try { step() } catch (err) { console.warn('[formulas]', step.name, 'failed:', err) }
    }
  }

  window.NSEFormulas = { init }
})()
