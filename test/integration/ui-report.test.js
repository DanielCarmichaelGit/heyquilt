// test/ui-report.test.js
// What the app tells Quilt about itself: each action's outcome and timing, renderer
// errors, unknown routes, and nothing at all when reporting is turned off.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ui-report-'))
process.env.HOME = home

const { startUi } = await import('../../src/ui-server.js')
const { createReporter } = await import('../../src/report.js')
const { saveSettings, getSettings } = await import('../../src/settings.js')

const sent = []
const reporter = createReporter({
  token: () => null, enabled: () => getSettings().report !== false, fetch: async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, status: 200 } },
  api: 'https://api.test', version: '0.3.2', platform: 'darwin', batchSize: 1, delayMs: 0
})
let ui
let uiSlow
before(async () => {
  // A signed-in computer, so routes answer (the token is never used: the reporter's fetch is fake and the relay isn't needed).
  fs.mkdirSync(path.join(home, '.quilt'), { recursive: true })
  fs.writeFileSync(path.join(home, '.quilt', 'account.json'), JSON.stringify({ token: 'qd_test', account: { id: 'u1', name: 'Dana', email: '' }, signedInAt: Date.now() }), { mode: 0o600 })
  ui = await startUi({ port: 0, reporter })
  // Everything is "slow" on this one, so a handler's outcome is always 'slow', never 'ok'.
  uiSlow = await startUi({ port: 0, reporter, slowMs: -1 })
})
after(async () => { await ui.close(); await uiSlow.close() })

const callOn = (target, method, p, body) => fetch(`http://127.0.0.1:${target.port}${p}`, {
  method, headers: { 'x-quilt-token': target.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
}).then(async (r) => ({ status: r.status, body: await r.json() }))
const call = (method, p, body) => callOn(ui, method, p, body)
const settle = () => new Promise((r) => setTimeout(r, 30))
const events = () => sent.flatMap((b) => b.events)
const last = (name) => events().filter((e) => e.name === name).at(-1)

test('a successful GET is not recorded: reads happen constantly and are not worth a row', async () => {
  const before = events().length
  const r = await call('GET', '/api/settings')
  assert.equal(r.status, 200)
  assert.equal(r.body.report, true, 'reporting is on by default')
  await settle()
  assert.equal(events().length, before, 'nothing new was recorded for a successful read')
})

test('a successful POST is recorded ok, with its duration and the context fields the route keeps', async () => {
  const r = await call('POST', '/api/settings', { report: true })
  assert.equal(r.status, 200)
  assert.equal(r.body.report, true)
  await settle()
  const e = last('POST /api/settings')
  assert.equal(e.kind, 'action'); assert.equal(e.outcome, 'ok'); assert.equal(e.status, 200)
  assert.equal(typeof e.durationMs, 'number'); assert.deepEqual(e.context, {})
})

test('a slow POST is recorded as slow, even though a successful GET is skipped', async () => {
  const r = await callOn(uiSlow, 'POST', '/api/settings', { report: true })
  assert.equal(r.status, 200)
  await settle()
  const e = last('POST /api/settings')
  assert.equal(e.outcome, 'slow'); assert.equal(e.status, 200)
})

test('a handler that fails is recorded as an error with the message the person saw, and the session id is not in the name', async () => {
  const r = await call('POST', '/api/sessions/abc123/open-in', { app: 'cursor' })
  assert.equal(r.status, 404)
  await settle()
  const e = last('POST /api/sessions/:id/open-in')
  assert.equal(e.outcome, 'error'); assert.equal(e.status, 404)
  assert.equal(e.message, 'That session is not running.')
  assert.deepEqual(e.context, { app: 'cursor' })
})

test('an unknown route is a 404 event', async () => {
  assert.equal((await call('GET', '/api/nothing-here')).status, 404)
  await settle()
  const e = last('GET /api/nothing-here')
  assert.equal(e.kind, 'http404'); assert.equal(e.outcome, 'error')
})

test('the renderer reports its own errors through /api/report', async () => {
  const r = await call('POST', '/api/report', { name: 'renderer', message: 'TypeError: x is not a function at /Users/dana/app.js', context: { view: 'home' } })
  assert.deepEqual([r.status, r.body], [200, { ok: true }])
  await settle()
  const e = last('renderer')
  assert.equal(e.kind, 'error'); assert.equal(e.outcome, 'error')
  assert.equal(e.message, 'TypeError: x is not a function at app.js')
  assert.deepEqual(e.context, { view: 'home' })
  assert.equal(events().filter((x) => x.name === 'POST /api/report').length, 0, 'reporting a report is not itself recorded')
})

test('the setting turns reporting off and on, and is saved', async () => {
  assert.equal((await call('POST', '/api/settings', { report: false })).body.report, false)
  const before = events().length
  await call('GET', '/api/settings')
  await settle()
  assert.equal(events().length, before, 'nothing recorded while off')
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.quilt', 'settings.json'), 'utf8')).report, false)
  assert.equal((await call('POST', '/api/settings', { report: true })).body.report, true)
  assert.equal('report' in JSON.parse(fs.readFileSync(path.join(home, '.quilt', 'settings.json'), 'utf8')), false, 'on is the default, so it is not written')
})

test('report() and flushReports() are there for the desktop shell', async () => {
  ui.report({ kind: 'crash', name: 'main', outcome: 'error', message: 'boom' })
  await ui.flushReports()
  assert.equal(last('main').kind, 'crash')
})
