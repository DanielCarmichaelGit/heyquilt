// Webhook subscriptions: what an agent may subscribe to, how a POST is signed, and how a
// failed delivery is tried again.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWebhookUrl, parseWebhookEvents, makeSubscription, describeSubscription, webhookPayload, signWebhook, verifyWebhook, deliverWebhook, deliverEvents, WEBHOOK_EVENTS, isPrivateAddress, publicWebhookHost } from '../src/webhooks.js'

test('a webhook URL must be https and public; the local session also takes http to this computer', () => {
  assert.equal(parseWebhookUrl(' https://hooks.example.com/quilt?x=1 '), 'https://hooks.example.com/quilt?x=1')
  assert.throws(() => parseWebhookUrl(''), /Give the URL/)
  assert.throws(() => parseWebhookUrl('not a url'), /not a valid URL/)
  assert.throws(() => parseWebhookUrl('ftp://x.example.com/'), /https/)
  assert.throws(() => parseWebhookUrl('http://hooks.example.com/'), /https/)
  assert.throws(() => parseWebhookUrl('https://user:pw@hooks.example.com/'), /user name or password/)
  for (const h of ['https://localhost/', 'https://127.0.0.1/', 'https://10.0.0.5/', 'https://192.168.1.2/', 'https://172.16.0.1/', 'https://[::1]/', 'https://169.254.1.1/', 'https://me.localhost/']) {
    assert.throws(() => parseWebhookUrl(h), /local or private/, h)
  }
  assert.equal(parseWebhookUrl('http://localhost:8787/hook', { allowLocal: true }), 'http://localhost:8787/hook')
  assert.equal(parseWebhookUrl('http://127.0.0.1:8787/hook', { allowLocal: true }), 'http://127.0.0.1:8787/hook')
  assert.throws(() => parseWebhookUrl('http://hooks.example.com/', { allowLocal: true }), /https/)
  assert.throws(() => parseWebhookUrl('https://x.example.com/' + 'a'.repeat(2000)), /too long/)
})

test('events default to all three; unknown ones are refused; duplicates are dropped', () => {
  assert.deepEqual(parseWebhookEvents(), WEBHOOK_EVENTS)
  assert.deepEqual(parseWebhookEvents(['chat.dm', 'chat.dm', 'chat.mention']), ['chat.dm', 'chat.mention'])
  assert.throws(() => parseWebhookEvents(['chat.everything']), /Unknown event "chat.everything"/)
  assert.throws(() => parseWebhookEvents([]), /at least one/)
  assert.throws(() => parseWebhookEvents('chat.dm'), /give a list/)
})

test('a subscription keeps the secret the agent chose, or makes one and shows it once', () => {
  const mine = makeSubscription({ url: 'https://h.example.com/a', secret: 'sixteen-chars-ok', events: ['chat.dm'] }, { now: () => 5 })
  assert.deepEqual(mine, { url: 'https://h.example.com/a', secret: 'sixteen-chars-ok', events: ['chat.dm'], since: 5, made: false })
  const made = makeSubscription({ url: 'https://h.example.com/a' })
  assert.equal(made.made, true)
  assert.match(made.secret, /^[a-f0-9]{48}$/)
  assert.deepEqual(made.events, WEBHOOK_EVENTS)
  assert.throws(() => makeSubscription({ url: 'https://h.example.com/a', secret: 'short' }), /16 to 200/)
  const keyed = makeSubscription({ url: 'https://h.example.com/a', bearer: ' crsr_abc123 ' })
  assert.equal(keyed.bearer, 'crsr_abc123', 'a receiver key of its own, trimmed')
  assert.equal('bearer' in made, false)
  assert.throws(() => makeSubscription({ url: 'https://h.example.com/a', bearer: 'a\nb' }), /one line/)
  assert.match(describeSubscription(keyed), /with your bearer key in the Authorization header/)
  assert.match(describeSubscription(made, { showSecret: true }), new RegExp(`Secret \\(shown once.*: ${made.secret}`))
  assert.doesNotMatch(describeSubscription(made), new RegExp(made.secret))
  assert.match(describeSubscription(made), /POSTs to https:\/\/h.example.com\/a on chat.mention, chat.dm, task.assigned/)
  assert.match(describeSubscription(null), /No webhook/)
})

test('payloads carry the event, who, what and the room; tasks bring their card', () => {
  const m = webhookPayload({ id: 'm1', kind: 'mention', by: 'Brandon', text: '@Grok look', ts: 10 }, { room: 'r1', to: 'Grok' })
  assert.deepEqual(m, { event: 'chat.mention', id: 'm1', room: 'r1', to: 'Grok', by: 'Brandon', text: '@Grok look', ts: 10 })
  const d = webhookPayload({ id: 'm2', kind: 'dm', by: 'Brandon', text: 'psst', ts: 11 }, { room: 'r1', to: 'Grok' })
  assert.equal(d.event, 'chat.dm')
  const t = webhookPayload({ id: 't1', kind: 'task', by: 'Brandon', text: 'Fix login', ts: 12, task: { id: 't1', title: 'Fix login', column: 'todo', assignee: 'Grok', forAi: false, tool: '', files: ['src/a.js'] } }, { room: 'r1', to: 'Grok' })
  assert.equal(t.event, 'task.assigned')
  assert.deepEqual(t.task, { id: 't1', title: 'Fix login', column: 'todo', assignee: 'Grok', forAi: false, tool: '', files: ['src/a.js'] })
})

test('signatures are HMAC-SHA256 over "<timestamp>.<body>" and verify in constant time', () => {
  const sig = signWebhook('secret-secret-secret', '1700000000000', '{"a":1}')
  assert.match(sig, /^sha256=[a-f0-9]{64}$/)
  assert.equal(verifyWebhook('secret-secret-secret', '1700000000000', '{"a":1}', sig), true)
  assert.equal(verifyWebhook('secret-secret-secret', '1700000000001', '{"a":1}', sig), false, 'another timestamp')
  assert.equal(verifyWebhook('other-secret-other-s', '1700000000000', '{"a":1}', sig), false)
  assert.equal(verifyWebhook('secret-secret-secret', '1700000000000', '{"a":1}', 'sha256=short'), false)
})

const sub = { url: 'https://h.example.com/hook', secret: 'secret-secret-secret', events: WEBHOOK_EVENTS }
const fakeFetch = (answers) => {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    const a = answers.shift()
    if (a instanceof Error) throw a
    return { ok: a >= 200 && a < 300, status: a }
  }
  return { fetch, calls }
}
const noSleep = { sleep: async () => {}, delays: [1, 1, 1], now: () => 1700000000000 }

test('a delivery is one signed JSON POST, with the event in headers', async () => {
  const f = fakeFetch([200])
  const r = await deliverWebhook(sub, { event: 'chat.dm', id: 'm1', text: 'hi' }, { fetch: f.fetch, ...noSleep })
  assert.deepEqual({ ok: r.ok, status: r.status, attempts: r.attempts }, { ok: true, status: 200, attempts: 1 })
  assert.equal(f.calls.length, 1)
  const { url, init } = f.calls[0]
  assert.equal(url, sub.url)
  assert.equal(init.method, 'POST')
  assert.equal(init.redirect, 'manual')
  assert.equal(init.headers['content-type'], 'application/json')
  assert.equal(init.headers['x-quilt-event'], 'chat.dm')
  assert.equal(init.headers['x-quilt-delivery'], r.delivery)
  assert.equal(init.headers['x-quilt-timestamp'], '1700000000000')
  assert.equal(JSON.parse(init.body).id, 'm1')
  assert.equal(verifyWebhook(sub.secret, '1700000000000', init.body, init.headers['x-quilt-signature']), true)
  assert.equal('authorization' in init.headers, false, 'no bearer unless asked')
  const g = fakeFetch([200])
  await deliverWebhook({ ...sub, bearer: 'crsr_key' }, { event: 'chat.dm' }, { fetch: g.fetch, ...noSleep })
  assert.equal(g.calls[0].init.headers.authorization, 'Bearer crsr_key')
})

test('a receiver that is down or answers 5xx/429 is tried again; 4xx is not; the last failure is logged', async () => {
  const logs = []
  const f = fakeFetch([new Error('ECONNREFUSED'), 503, 429, 200])
  const r = await deliverWebhook(sub, { event: 'chat.dm' }, { fetch: f.fetch, ...noSleep, log: (l) => logs.push(l) })
  assert.deepEqual({ ok: r.ok, attempts: r.attempts }, { ok: true, attempts: 4 })
  assert.deepEqual(logs, [])
  const g = fakeFetch([500, 500, 500, 500, 500])
  const bad = await deliverWebhook(sub, { event: 'chat.dm' }, { fetch: g.fetch, ...noSleep, log: (l) => logs.push(l) })
  assert.deepEqual({ ok: bad.ok, status: bad.status, attempts: bad.attempts, error: bad.error }, { ok: false, status: 500, attempts: 4, error: 'HTTP 500' })
  assert.equal(g.calls.length, 4)
  assert.match(logs[0], /webhook to https:\/\/h.example.com\/hook failed \(chat.dm\): HTTP 500/)
  const h = fakeFetch([404, 200])
  const nope = await deliverWebhook(sub, { event: 'chat.dm' }, { fetch: h.fetch, ...noSleep })
  assert.deepEqual({ ok: nope.ok, status: nope.status, attempts: nope.attempts }, { ok: false, status: 404, attempts: 1 })
  assert.equal(h.calls.length, 1)
})

test('deliverEvents sends only the events the subscription asks for, in order', async () => {
  const f = fakeFetch([200, 200, 200])
  const only = { ...sub, events: ['chat.mention', 'task.assigned'] }
  const events = [
    { id: 'm1', kind: 'mention', by: 'B', text: '@G', ts: 1 },
    { id: 'm2', kind: 'dm', by: 'B', text: 'x', ts: 2 },
    { id: 't1', kind: 'task', by: 'B', text: 'T', ts: 3, task: { id: 't1', title: 'T', column: 'todo' } }
  ]
  const rs = await deliverEvents(only, events, { room: 'r', to: 'G' }, { fetch: f.fetch, ...noSleep })
  assert.equal(rs.length, 2)
  assert.deepEqual(f.calls.map((c) => JSON.parse(c.init.body).event), ['chat.mention', 'task.assigned'])
  assert.deepEqual(f.calls.map((c) => JSON.parse(c.init.body).to), ['G', 'G'])
})

test('isPrivateAddress: loopback, private, link-local, unique-local and mapped addresses; public ones are not', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fd12::3', 'fe80::1', 'febf::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '[::1]', 'fe80::1%en0', 'not-an-ip']) {
    assert.equal(isPrivateAddress(a), true, a)
  }
  for (const a of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:2800:220:1::1', '::ffff:8.8.8.8']) assert.equal(isPrivateAddress(a), false, a)
})

test('publicWebhookHost: every resolved address must be public; a trailing dot is the same host', async () => {
  const table = { 'pub.example.com': ['8.8.8.8', '2606:2800:220:1::1'], 'mixed.example.com': ['8.8.8.8', '192.168.0.2'], 'empty.example.com': [] }
  const asked = []
  const lookup = async (host, o) => {
    asked.push([host, o])
    if (!table[host]) throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' })
    return table[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
  assert.deepEqual(await publicWebhookHost('https://pub.example.com/x', { lookup }), { ok: true })
  assert.deepEqual(asked, [['pub.example.com', { all: true, verbatim: true }]])
  assert.deepEqual(await publicWebhookHost('https://pub.example.com./x', { lookup }), { ok: true })
  assert.equal(asked[1][0], 'pub.example.com')
  for (const url of ['https://mixed.example.com/x', 'https://empty.example.com/x', 'https://missing.example.com/x', 'https://localhost./x', 'https://a.localhost./x', 'https://127.0.0.1./x', 'https://[::1]/x', 'https://10.0.0.1/x', 'not a url']) {
    const r = await publicWebhookHost(url, { lookup })
    assert.equal(r.ok, false, url)
    assert.ok(r.reason, url)
  }
  // Literal addresses and local names never reach DNS.
  assert.deepEqual(asked.map(([h]) => h), ['pub.example.com', 'pub.example.com', 'mixed.example.com', 'empty.example.com', 'missing.example.com'])
  assert.deepEqual(await publicWebhookHost('https://8.8.8.8/x', { lookup }), { ok: true })
})
