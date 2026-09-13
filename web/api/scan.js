const crypto = require('crypto')
const { db, must, send, sendErr } = require('./_utils')

// Manual data update.
//   GET  — progress of the latest scanner run, whether the weekday cron or a
//          manual one started it.
//   POST — starts the "NSE Scanner" GitHub Actions workflow now, the same job
//          the 4:30 PM IST schedule runs.
//
// Starting a run needs GITHUB_SCAN_TOKEN: a fine-grained GitHub token with
// "Actions: Read and write" on this repository. If SCAN_TRIGGER_KEY is also set,
// POST must send it as the x-scan-key header, so a visitor to the public site
// can't start a 15-minute job.

const REPO     = process.env.GITHUB_REPO || 'ivyan26733/Automated_Strategy_Notifier'
const BRANCH   = process.env.SCAN_BRANCH || 'main'
const WORKFLOW = 'scanner.yml'

// Phase lengths measured on a real run (11 Sep 2026, 903s inside the scanner):
// ~35s GitHub setup, ~175s downloading prices, ~490s checking stocks, ~235s saving.
const SETUP_S    = 35
const DOWNLOAD_S = 175
const STALE_MS   = 100 * 60 * 1000   // the workflow times out at 90 min; a "running" row older than this was abandoned
const ACTIVE     = new Set(['queued', 'waiting', 'requested', 'pending', 'in_progress'])

const round1 = v => Math.round(v * 10) / 10

async function github(path, { method = 'GET', body, token } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    return await fetch(`https://api.github.com${path}`, {
      method,
      signal: ctrl.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'nse-stock-screener',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  } finally {
    clearTimeout(timer)
  }
}

// Best effort: the repository is public, so this also works without a token,
// at GitHub's lower anonymous rate limit. Progress falls back to the database.
async function latestWorkflowRun(token) {
  try {
    const r = await github(`/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=1`, { token })
    if (!r.ok) return null
    const run = (await r.json()).workflow_runs?.[0]
    return run
      ? { id: run.id, status: run.status, conclusion: run.conclusion, event: run.event, createdAt: run.created_at, updatedAt: run.updated_at, url: run.html_url }
      : null
  } catch {
    return null
  }
}

// Where a running scan is, from the counts the scanner writes as it goes
// (update_scanner_run_progress). The price download reports nothing, so that
// phase is estimated from its usual length.
function scannerProgress(row, prevSignals, now) {
  const requested = row.stocks_requested || 0
  const done      = (row.stocks_processed || 0) + (row.stocks_failed || 0)
  const counts    = { done, requested, signals: row.signals_created || 0 }
  const elapsed   = (now - Date.parse(row.started_at)) / 1000

  if (!done)             return { phase: 'download', progress: 5 + 18 * Math.min(elapsed / DOWNLOAD_S, 0.95), counts }
  if (done < requested)  return { phase: 'process',  progress: 23 + 52 * (done / requested), counts }
  const saved = prevSignals ? Math.min(counts.signals / prevSignals, 0.97) : 0.5
  return { phase: 'save', progress: 75 + 24 * saved, counts }
}

async function readStatus() {
  const token = process.env.GITHUB_SCAN_TOKEN
  const [{ data: rows }, run] = await Promise.all([
    db.from('scanner_runs')
      .select('id, started_at, finished_at, status, stocks_requested, stocks_processed, stocks_failed, signals_created')
      .order('started_at', { ascending: false })
      .limit(6)
      .then(r => must(r, 'scanner_runs recent')),
    latestWorkflowRun(token),
  ])

  const now      = Date.now()
  const row      = rows?.[0] || null
  const rowStart = row ? Date.parse(row.started_at) : 0
  const finished = (rows || []).filter(r => r.status === 'success' && r.finished_at)
  const durations = finished.slice(0, 5).map(r => (Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000)
  const typicalSec = Math.round(SETUP_S + (durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 900))
  const prevSignals = finished.find(r => r.id !== row?.id)?.signals_created || 0

  const base = {
    configured: Boolean(token),
    needsKey:   Boolean(process.env.SCAN_TRIGGER_KEY),
    typicalSec,
    run,
    lastRun: row ? { status: row.status, startedAt: row.started_at, finishedAt: row.finished_at } : null,
  }

  // A row can outlive its job (crash, cancel): if the workflow run that began
  // before it has already completed, nothing is writing to it any more.
  const orphaned = Boolean(row?.status === 'running' && run && run.status === 'completed'
    && Date.parse(run.createdAt) <= rowStart && Date.parse(run.updatedAt) >= rowStart)

  if (row && row.status === 'running' && now - rowStart < STALE_MS && !orphaned) {
    const p = scannerProgress(row, prevSignals, now)
    const elapsedSec = (now - rowStart) / 1000 + SETUP_S
    return {
      ...base, active: true, phase: p.phase, progress: round1(p.progress), counts: p.counts,
      elapsedSec: Math.round(elapsedSec), etaSec: Math.max(30, Math.round(typicalSec - elapsedSec)), startedAt: row.started_at,
    }
  }

  // Asked for on GitHub, but the scanner hasn't created its row yet.
  if (run && ACTIVE.has(run.status) && (!row || rowStart < Date.parse(run.createdAt))) {
    const elapsedSec = (now - Date.parse(run.createdAt)) / 1000
    const setup = run.status === 'in_progress'
    return {
      ...base, active: true, phase: setup ? 'setup' : 'queued',
      progress: round1(setup ? 2 + 3 * Math.min(elapsedSec / SETUP_S, 0.95) : Math.min(1 + elapsedSec / 60, 2)),
      counts: null, elapsedSec: Math.round(elapsedSec), etaSec: Math.max(30, Math.round(typicalSec - elapsedSec)), startedAt: run.createdAt,
    }
  }

  const recent = t => t && now - Date.parse(t) < 30 * 60 * 1000
  const failedRun = run && run.status === 'completed' && run.conclusion !== 'success' && recent(run.updatedAt)
  if (failedRun || orphaned || (row?.status === 'failed' && recent(row.finished_at))) {
    return { ...base, active: false, phase: 'failed', progress: null, finishedAt: row?.finished_at || run?.updatedAt || null }
  }
  const ok = row?.status === 'success'
  return { ...base, active: false, phase: ok ? 'done' : 'idle', progress: ok ? 100 : 0, finishedAt: row?.finished_at || null }
}

function sameSecret(given, expected) {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given), b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    if (req.method === 'GET') return send(res, await readStatus())
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST')
      return send(res, { error: 'method_not_allowed' }, 405)
    }

    const token = process.env.GITHUB_SCAN_TOKEN
    if (!token) {
      return send(res, {
        error: 'not_configured',
        message: 'Manual updates need a GitHub token. Add GITHUB_SCAN_TOKEN in Vercel (Settings → Environment Variables), then redeploy. The daily 4:30 PM update keeps working without it.',
      }, 501)
    }
    const key = process.env.SCAN_TRIGGER_KEY
    if (key && !sameSecret(req.headers['x-scan-key'], key)) {
      return send(res, { error: 'bad_key', message: 'That update key is not right.' }, 401)
    }

    // One run at a time; also absorbs a double click before GitHub lists the new run.
    const status = await readStatus()
    const justAsked = status.run && Date.now() - Date.parse(status.run.createdAt) < 90 * 1000
    if (status.active || justAsked) {
      return send(res, { error: 'already_running', message: 'An update is already running.' }, 409)
    }

    const r = await github(`/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST', token, body: { ref: BRANCH, inputs: { refresh_data: 'true' } },
    })
    if (r.status !== 204) {
      console.error(`[api] scan dispatch ${r.status}: ${(await r.text()).slice(0, 300)}`)
      const refused = [401, 403, 404, 422].includes(r.status)
      return send(res, {
        error: 'dispatch_failed',
        message: refused
          ? 'GitHub refused to start the job. The token needs "Actions: Read and write" access to this repository.'
          : 'GitHub did not accept the request. Please try again in a minute.',
      }, 502)
    }
    return send(res, { ok: true, requestedAt: new Date().toISOString() }, 202)
  } catch (e) {
    sendErr(res, e.message)
  }
}
