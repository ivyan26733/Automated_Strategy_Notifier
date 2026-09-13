/* NSE Stock Screener — "Update data" button and live progress panel.
 *
 * The button asks /api/scan to start the same GitHub Actions scanner the
 * weekday 4:30 PM job runs, then polls its progress into a floating panel.
 * The panel also opens by itself when a scheduled run is already underway.
 */
(function () {
  const $ = id => document.getElementById(id)
  const btn = $('scan-btn'), panel = $('scan-panel')
  if (!btn || !panel) return

  // Playful status words, the kind shown while thinking. Some fit the current phase.
  const WORDS = {
    any: ['Percolating', 'Cogitating', 'Noodling', 'Combobulating', 'Ruminating', 'Marinating', 'Moseying',
      'Simmering', 'Flibbertigibbeting', 'Finagling', 'Schlepping', 'Vibing', 'Pondering', 'Musing', 'Conjuring',
      'Brewing', 'Reticulating splines', 'Discombobulating, then recombobulating', 'Honking thoughtfully',
      'Shimmying', 'Boondoggling', 'Puttering', 'Mulling it over', 'Hatching a plan'],
    queued:   ['Waving at GitHub', 'Politely queueing', 'Bribing a runner with cookies', 'Warming up the hamsters'],
    setup:    ['Unpacking Python', 'Installing good vibes', 'Stretching before the sprint', 'Summoning pandas'],
    download: ['Whispering to Yahoo Finance', 'Fetching fresh candles', 'Slurping price history', 'Hoovering up tickers'],
    process:  ['Herding every NSE stock', 'Untangling candlesticks', 'Consulting the moving averages',
      'Hunting golden crosses', 'Interrogating EMA9', 'Measuring the wiggles with ATR'],
    save:     ['Tucking signals into the database', 'Filing the paperwork', 'Stacking rows neatly', 'Polishing the numbers'],
  }
  const DONE_WORDS = ['Ta-da! Freshly baked', "Chef's kiss", 'Done and dusted', 'Fresh out of the oven']
  const STEPS = ['queued', 'setup', 'download', 'process', 'save']
  const PHASE_TEXT = {
    queued:   'Waiting for a GitHub runner to pick up the job',
    setup:    'Setting up Python and the scanner',
    download: 'Downloading the latest prices for every stock',
    process:  'Checking every stock against the strategy rules',
    save:     'Saving signals and indicators to the database',
    done:     'Fresh numbers are in, and this page has been refreshed.',
    failed:   'The update stopped before finishing.',
  }
  const TITLES = { done: 'Data updated', failed: 'Update failed', 'setup-needed': 'Manual update isn’t set up yet', error: 'Could not start the update' }
  const KEY_STORE = 'nse_scan_key'

  let status = null        // last GET /api/scan answer
  let requestedAt = 0      // when this page asked for a run; GitHub takes a few seconds to list it
  let tracking = false     // a run is in progress and the panel is following it
  let lastProgress = 0
  let pollTimer = 0, wordTimer = 0, clockTimer = 0, clock = null

  const store = {
    get: () => { try { return localStorage.getItem(KEY_STORE) || '' } catch { return '' } },
    set: v => { try { v ? localStorage.setItem(KEY_STORE, v) : localStorage.removeItem(KEY_STORE) } catch { /* private mode */ } },
  }
  const pick = list => list[Math.floor(Math.random() * list.length)]
  const mmss = s => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
  const num = v => Number(v || 0).toLocaleString('en-IN')

  // ── Words ─────────────────────────────────────────────────────────
  function setWord(text) {
    const w = $('scan-word')
    w.textContent = text
    w.classList.remove('is-in')
    void w.offsetWidth          // restart the entrance animation
    w.classList.add('is-in')
  }
  function startWords() {
    if (wordTimer) return
    const next = () => {
      const pool = WORDS[panel.dataset.phase] && Math.random() < 0.55 ? WORDS[panel.dataset.phase] : WORDS.any
      let word
      do { word = `${pick(pool)}…` } while (word === $('scan-word').textContent && pool.length > 1)
      setWord(word)
    }
    next()
    wordTimer = setInterval(next, 2600)
  }
  function stopWords() { clearInterval(wordTimer); wordTimer = 0 }

  // ── Clock: counts up locally between polls ─────────────────────────
  function tick() {
    if (!clock) return
    const d = (Date.now() - clock.at) / 1000
    const eta = clock.eta == null ? null : clock.eta - d
    $('scan-time').textContent = `${mmss(clock.elapsed + d)} elapsed · ` +
      (eta == null ? 'working out how long' : eta > 45 ? `about ${Math.round(eta / 60)} min left` : 'almost there')
  }
  function startClock(elapsedSec, etaSec) {
    clock = { at: Date.now(), elapsed: elapsedSec || 0, eta: etaSec }
    if (!clockTimer) clockTimer = setInterval(tick, 1000)
    tick()
  }
  function stopClock(text = '') { clearInterval(clockTimer); clockTimer = 0; clock = null; $('scan-time').textContent = text }

  // ── Panel ─────────────────────────────────────────────────────────
  function render(s) {
    const phase = s.phase
    panel.dataset.phase = phase
    const pct = Math.max(0, Math.min(100, s.progress ?? lastProgress))
    if (phase !== 'failed') lastProgress = pct

    $('scan-fill').style.width = `${pct}%`
    $('scan-bar').setAttribute('aria-valuenow', String(Math.round(pct)))
    $('scan-pct').textContent = `${Math.floor(pct)}%`
    $('scan-title').textContent = TITLES[phase] || 'Updating data'

    let text = s.message || PHASE_TEXT[phase] || ''
    if (!s.message && phase === 'process' && s.counts?.requested) text = `Checked ${num(s.counts.done)} of ${num(s.counts.requested)} stocks`
    if (!s.message && phase === 'save' && s.counts?.signals) text = `Saved ${num(s.counts.signals)} signals so far`
    $('scan-phase').textContent = text

    const at = STEPS.indexOf(phase)
    document.querySelectorAll('#scan-steps li').forEach((li, k) => {
      li.classList.toggle('is-done', phase === 'done' || (at >= 0 && k < at))
      li.classList.toggle('is-active', k === at)
    })

    const log = $('scan-log')
    if (s.run?.url) { log.href = s.run.url; log.hidden = false } else log.hidden = true

    const running = at >= 0
    btn.classList.toggle('is-running', running)
    $('scan-btn-text').textContent = running ? `Updating ${Math.floor(pct)}%` : 'Update data'
    if (running) {
      const rt = $('run-text'), dot = $('run-dot')
      if (rt) rt.textContent = `Updating… ${Math.floor(pct)}%`
      if (dot) dot.className = 'dot run'
    }
  }

  function showMessage(phase, message) {
    panel.hidden = false
    stopWords()
    stopClock()
    render({ phase, message })
  }

  // Reload the header numbers and the open data tab once new data has landed.
  function refreshData() {
    try { if (typeof loadSummary === 'function') loadSummary().catch(() => {}) } catch { /* app.js not ready */ }
    try {
      for (const k of ['crossovers', 'active', 'history', 'perf', 'watchlist']) loaded[k] = false
      const tab = document.querySelector('.tab-btn.active')?.dataset.tab
      if (tab && TAB_BODY[tab]) switchTab(tab)
    } catch { /* app.js not ready */ }
  }

  // ── Polling ───────────────────────────────────────────────────────
  async function poll() {
    clearTimeout(pollTimer)
    try {
      const r = await fetch('/api/scan', { cache: 'no-store' })
      if (!r.ok) throw new Error(`scan status ${r.status}`)
      status = await r.json()
    } catch {
      if (tracking || requestedAt) {
        $('scan-phase').textContent = 'Lost touch with the server, trying again…'
        pollTimer = setTimeout(poll, 8000)
      }
      return
    }
    const s = status

    if (s.active) {
      requestedAt = 0
      if (!tracking) { tracking = true; panel.hidden = false }
      render(s)
      startWords()
      startClock(s.elapsedSec, s.etaSec)
      pollTimer = setTimeout(poll, document.hidden ? 15000 : 4000)
      return
    }

    if (requestedAt && Date.now() - requestedAt < 120 * 1000) {   // GitHub hasn't listed the new run yet
      render({ phase: 'queued', progress: 1 })
      pollTimer = setTimeout(poll, 3000)
      return
    }

    if (tracking || requestedAt) {
      const neverStarted = Boolean(requestedAt) && !tracking
      tracking = false
      requestedAt = 0
      stopWords()
      if (s.phase === 'failed' || neverStarted) {
        stopClock()
        render({ ...s, phase: 'failed', progress: lastProgress,
          message: neverStarted ? 'GitHub did not start the job. Check the Actions tab on GitHub.' : undefined })
        $('scan-word').textContent = 'Well, that was anticlimactic'
        try { if (typeof loadSummary === 'function') loadSummary().catch(() => {}) } catch { /* app.js not ready */ }   // header status shows the real last run again
      } else {
        stopClock(s.finishedAt ? `Finished at ${new Date(s.finishedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : '')
        render({ ...s, phase: 'done', progress: 100 })
        setWord(pick(DONE_WORDS))
        refreshData()
        setTimeout(() => { if (!tracking && panel.dataset.phase === 'done') panel.hidden = true }, 10000)
      }
      return
    }

    render({ phase: 'idle', progress: 0 })
  }

  // ── Button ────────────────────────────────────────────────────────
  btn.addEventListener('click', async () => {
    if (tracking || requestedAt) { panel.hidden = false; return }   // already running: bring the panel back

    if (status && !status.configured) {
      showMessage('setup-needed', 'Add a GitHub token named GITHUB_SCAN_TOKEN in Vercel (Settings → Environment Variables), then redeploy. The daily 4:30 PM update keeps working without it.')
      return
    }

    let key = store.get()
    if (status?.needsKey && !key) {
      key = (window.prompt('Enter the update key') || '').trim()
      if (!key) return
    }

    btn.disabled = true
    try {
      const r = await fetch('/api/scan', { method: 'POST', headers: key ? { 'x-scan-key': key } : {} })
      const body = await r.json().catch(() => ({}))
      if (r.status === 202) {
        if (key) store.set(key)
        requestedAt = Date.now()
        lastProgress = 0
        panel.hidden = false
        render({ phase: 'queued', progress: 1 })
        startWords()
        startClock(0, status?.typicalSec)
        pollTimer = setTimeout(poll, 3000)
      } else if (r.status === 409) {
        panel.hidden = false
        poll()
      } else {
        if (r.status === 401) store.set('')
        showMessage(r.status === 501 ? 'setup-needed' : 'error', body.message || 'The server could not start the update. Please try again.')
      }
    } catch {
      showMessage('error', "Couldn't reach the server. Check your connection and try again.")
    } finally {
      btn.disabled = false
    }
  })

  $('scan-close').addEventListener('click', () => { panel.hidden = true })
  document.addEventListener('visibilitychange', () => { if (!document.hidden && tracking) poll() })

  poll()
})()
