// test/report.test.js
// The app's issue reporter: it scrubs, batches, backs off and never throws.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scrub, createReporter } from '../../src/report.js'

test('scrub reduces paths to basenames and hides tokens and invite links', () => {
  assert.equal(scrub('Could not open /Users/dana/Code/my app/src: ENOENT'), 'Could not open src: ENOENT')
  assert.equal(scrub('spawn C:\\Users\\Mo\\AppData\\Local\\Programs\\cursor\\Cursor.exe ENOENT'), 'spawn Cursor.exe ENOENT')
  assert.equal(scrub('saved to ~/quilt/proj'), 'saved to proj')
  assert.equal(scrub('Bearer qd_abcDEF123-_x failed'), 'Bearer [secret] failed')
  assert.equal(scrub('key qa_1 and qr_2 and dc_3'), 'key [secret] and [secret] and [secret]')
  assert.equal(scrub('open https://join.heyquilt.com/room-x#s=abc now'), 'open [invite] now')
  assert.equal(scrub('quilt://join?invite=xyz'), '[invite]')
  assert.equal(scrub('plain message 42'), 'plain message 42')
  assert.equal(scrub(null), '')
  assert.equal(scrub('open /Users/dana/My Documents and Settings/file.txt now'), 'open file.txt now')
  assert.equal(scrub('C:\\Program Files (x86)\\Quilt\\app.exe crashed'), 'app.exe crashed')
  assert.equal(scrub('a /Users/a/x failed, see /home/b/y'), 'a x failed, see y')
})

test('scrub covers every token prefix Quilt mints, even right after an underscore', () => {
  assert.equal(scrub('invite token qi_abcDEF123 for the org'), 'invite token [secret] for the org')
  assert.equal(scrub('agent join qj_xyz789 pasted'), 'agent join [secret] pasted')
  // '_' is a word character, so a naive \b boundary would miss this; the character right
  // before the prefix only has to be non-alphanumeric, and it's kept in the output.
  assert.equal(scrub('key=_qd_abc123'), 'key=_[secret]')
  assert.equal(scrub('qd_leading'), '[secret]')
  // A letter right before the prefix means it's part of a longer word, not a token: no match.
  assert.equal(scrub('xqd_not_a_token'), 'xqd_not_a_token')
})

test('scrub hides the relay/older form of an invite link, any host, where the secret follows a #', () => {
  assert.equal(scrub('open wss://relay.heyquilt.com/join/room-9#s3cr3t now'), 'open wss://relay.heyquilt.com[invite] now')
  assert.equal(scrub('see /join/room-1#abc for details'), 'see [invite] for details')
})

test('scrub hides credentials embedded in a URL, and GitHub tokens and JWTs anywhere', () => {
  assert.equal(scrub('fatal: unable to access https://x-access-token:ghp_abc123@github.com/x/y.git'), 'fatal: unable to access https://[secret]@github.com/x/y.git')
  assert.equal(scrub('clone failed for https://user:ghp_abcDEF456@github.com/org/repo'), 'clone failed for https://[secret]@github.com/org/repo')
  assert.equal(scrub('token github_pat_11ABCDEFG0123456789 rejected'), 'token [secret] rejected')
  assert.equal(scrub('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'), 'Authorization: Bearer [secret]')
})

test('scrub covers the Linux roots and Windows UNC shares PATH used to miss', () => {
  assert.equal(scrub('wrote /srv/app/data/out.json'), 'wrote out.json')
  assert.equal(scrub('reading /data/sets/train.csv'), 'reading train.csv')
  assert.equal(scrub('synced to /workspace/proj/build'), 'synced to build')
  assert.equal(scrub('copy to \\\\fileserver\\share\\docs\\report.pdf failed'), 'copy to report.pdf failed')
})

/** A reporter over fake time and a fake fetch that records every request. */
function harness ({ status = 200, token = 'qd_tok', enabled = true, fail = false } = {}) {
  let t = 1_000_000
  const timers = []
  const sent = []
  const fetch = async (url, opts) => {
    sent.push({ url, headers: opts.headers, body: JSON.parse(opts.body) })
    if (fail) throw new Error('offline')
    return { ok: status < 400, status }
  }
  const r = createReporter({
    token: () => token, enabled: () => enabled, fetch, api: 'https://api.test', version: '0.3.2', platform: 'darwin',
    now: () => t,
    setTimer: (fn, ms) => { const id = { fn, at: t + ms }; timers.push(id); return id },
    clearTimer: (id) => { const i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1) }
  })
  // Moves time forward and fires due timers, then lets promises settle.
  const advance = async (ms) => {
    t += ms
    for (const id of timers.filter((x) => x.at <= t)) { clearTimer(id); id.fn() }
    await new Promise((res) => setImmediate(res))
  }
  const clearTimer = (id) => { const i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1) }
  return { r, sent, advance, timers, now: () => t }
}

test('events wait up to 10 s, then go in one batch with the account token', async () => {
  const h = harness()
  h.r.record({ kind: 'action', name: 'open-in', outcome: 'ok', durationMs: 40, context: { app: 'cursor' } })
  h.r.record({ kind: 'action', name: 'open-in', outcome: 'error', message: 'Could not open /Users/x/y: nope', context: { dir: '/Users/x/y' } })
  assert.equal(h.sent.length, 0)
  await h.advance(9_999)
  assert.equal(h.sent.length, 0)
  await h.advance(1)
  assert.equal(h.sent.length, 1)
  const { url, headers, body } = h.sent[0]
  assert.equal(url, 'https://api.test/v1/issues')
  assert.equal(headers.authorization, 'Bearer qd_tok')
  assert.deepEqual([body.surface, body.appVersion, body.platform], ['app', '0.3.2', 'darwin'])
  assert.equal(body.events.length, 2)
  assert.equal(body.events[0].occurredAt, 1_000_000)
  assert.equal(body.events[1].message, 'Could not open y: nope')
  assert.equal(body.events[1].context.dir, 'y')
  assert.equal(h.r.waiting(), 0)
})

test('twenty events send at once; more than fifty waiting drops the oldest', async () => {
  const h = harness()
  for (let i = 0; i < 20; i++) h.r.record({ kind: 'action', name: `n${i}` })
  await h.advance(0)
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].body.events.length, 20)
  // While a send is in flight and failing, events pile up and are capped.
  const f = harness({ fail: true })
  for (let i = 0; i < 70; i++) f.r.record({ kind: 'action', name: `n${i}` })
  assert.ok(f.r.waiting() <= 50)
})

test('no token means no authorization header; disabled means nothing is kept or sent', async () => {
  const h = harness({ token: null })
  h.r.record({ kind: 'error', name: 'sign-in', outcome: 'error', message: 'x' })
  await h.advance(10_000)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].headers.authorization, undefined)
  const off = harness({ enabled: false })
  off.r.record({ kind: 'error', name: 'x' })
  assert.equal(off.r.waiting(), 0)
  await off.advance(10_000)
  assert.equal(off.sent.length, 0)
})

test('a failed send drops the batch and waits a minute before trying again', async () => {
  const h = harness({ fail: true })
  h.r.record({ kind: 'error', name: 'a' })
  await h.advance(10_000)
  assert.equal(h.sent.length, 1)
  assert.equal(h.r.waiting(), 0, 'the failed batch is dropped, not retried')
  h.r.record({ kind: 'error', name: 'b' })
  await h.advance(10_000)
  assert.equal(h.sent.length, 1, 'backing off')
  await h.advance(50_000)
  assert.equal(h.sent.length, 2)
  // A 4xx reply counts as a failure too.
  const bad = harness({ status: 401 })
  bad.r.record({ kind: 'error', name: 'c' })
  await bad.advance(10_000); bad.r.record({ kind: 'error', name: 'd' }); await bad.advance(10_000)
  assert.equal(bad.sent.length, 1)
})

test('flush sends what is waiting now and gives up after the timeout', async () => {
  const h = harness()
  h.r.record({ kind: 'crash', name: 'main', outcome: 'error', message: 'boom' })
  await h.r.flush()
  assert.equal(h.sent.length, 1)
  let resolveFetch
  const hang = createReporter({ token: () => null, fetch: () => new Promise((res) => { resolveFetch = res }), api: 'x', version: '0', platform: 'p', setTimer: (fn, ms) => setTimeout(fn, Math.min(ms, 5)), clearTimer: clearTimeout })
  hang.record({ kind: 'crash', name: 'main' })
  const started = Date.now()
  await hang.flush({ timeoutMs: 20 })
  assert.ok(Date.now() - started < 1000, 'flush returned without the fetch finishing')
  resolveFetch({ ok: true, status: 200 })
})

test('send never throws even if token() throws; the batch is dropped and it backs off', async () => {
  let t = 1_000_000
  const timers = []
  const sent = []
  let calls = 0
  const token = () => { calls += 1; if (calls === 2) throw new Error('keychain locked'); return 'qd_tok' }
  const fetch = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200 } }
  const setTimer = (fn, ms) => { const id = { fn, at: t + ms }; timers.push(id); return id }
  const clearTimer = (id) => { const i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1) }
  const r = createReporter({ token, fetch, api: 'https://api.test', version: '0.3.2', platform: 'darwin', now: () => t, setTimer, clearTimer })
  const advance = async (ms) => {
    t += ms
    for (const id of timers.filter((x) => x.at <= t)) { clearTimer(id); id.fn() }
    await new Promise((res) => setImmediate(res))
  }
  r.record({ kind: 'error', name: 'a' })
  await advance(10_000)
  assert.equal(sent.length, 1)
  r.record({ kind: 'error', name: 'b' })
  await advance(10_000)
  assert.equal(sent.length, 1, 'the second attempt threw inside token() and was dropped, not sent')
  assert.equal(r.waiting(), 0)
})

test('flush drains every waiting batch, and close leaves no timer armed', async () => {
  const h = harness()
  for (let i = 0; i < 45; i++) h.r.record({ kind: 'action', name: `n${i}` })
  await h.r.close()
  assert.equal(h.sent.reduce((n, s) => n + s.body.events.length, 0), 45)
  assert.equal(h.r.waiting(), 0)
  assert.equal(h.timers.length, 0)
})

test('flush gives up as soon as a send fails, without spinning', async () => {
  const fetch = async () => { throw new Error('offline') }
  const r = createReporter({ token: () => null, fetch, api: 'https://api.test', version: '0', platform: 'p', delayMs: 0 })
  for (let i = 0; i < 25; i++) r.record({ kind: 'error', name: `n${i}` })
  let ticks = 0
  const iv = setInterval(() => { ticks++ }, 0)
  const t0 = Date.now()
  await r.flush({ timeoutMs: 1000 })
  assert.ok(Date.now() - t0 < 500, 'flush gave up instead of spinning to the deadline')
  await new Promise((res) => setTimeout(res, 20))
  assert.ok(ticks > 0, 'the event loop kept ticking instead of being starved')
  clearInterval(iv)
  await r.close() // leaves no real timer dangling past this test
})

test('record after close keeps nothing', async () => {
  const h = harness()
  await h.r.close()
  h.r.record({ kind: 'error', name: 'late' })
  assert.equal(h.r.waiting(), 0)
})
