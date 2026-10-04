// A member joined from a computer subscribes a webhook: its session POSTs each mention,
// direct message and handed-over task there, keeps the subscription in .quilt/webhook.json,
// and stops when told to.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { generateIdentity } from '../src/identity.js'
import { verifyWebhook } from '../src/webhooks.js'

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-wh-${n}-`))
async function waitFor (fn, ms = 5000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let srv, server, dana, helper, helperDir
const posts = []
const transport = { fetch: async (url, init) => { posts.push({ url, init }); return { ok: true, status: 200 } }, delays: [1, 1, 1] }
const identity = generateIdentity()

before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {} })
  server = `ws://127.0.0.1:${srv.port}`
  const danaDir = tmp('dana')
  fs.writeFileSync(path.join(danaDir, 'README.md'), '# hi\n')
  dana = new Session({ dir: danaDir, server, room: 'wh', secret: 'pw', name: 'dana', identity: generateIdentity() })
  await dana.start({ waitTimeoutMs: 5000 })
  helperDir = tmp('helper')
  helper = new Session({ dir: helperDir, server, room: 'wh', secret: 'pw', name: 'helper', kind: 'agent', identity, webhookTransport: transport })
  await helper.start({ waitTimeoutMs: 5000 })
})
after(async () => { await helper?.stop(); await dana?.stop(); await srv?.close() })

test('subscribing is checked and kept on disk; nothing already there is POSTed', async () => {
  assert.throws(() => helper.setWebhook({ url: 'ftp://x' }), /https/)
  assert.throws(() => helper.setWebhook({ url: 'https://h.example.com/x', events: ['nope'] }), /Unknown event/)
  dana.say('@helper before the webhook')
  await waitFor(() => helper.inbox().events.length === 1)
  const sub = helper.setWebhook({ url: 'http://127.0.0.1:1/hook', secret: 'local-secret-sixteen', bearer: 'crsr_key' })
  assert.deepEqual([sub.url, sub.secret, sub.events, sub.made, sub.bearer], ['http://127.0.0.1:1/hook', 'local-secret-sixteen', ['chat.mention', 'chat.dm', 'task.assigned'], false, 'crsr_key'])
  assert.equal(JSON.parse(fs.readFileSync(path.join(helperDir, '.quilt', 'webhook.json'), 'utf8')).bearer, 'crsr_key')
  assert.deepEqual(helper.webhookInfo(), { url: sub.url, events: sub.events, since: sub.since, bearer: true })
  await sleep(50)
  assert.equal(posts.length, 0)
})

test('mentions, direct messages and tasks are POSTed as they happen, signed, in order', async () => {
  dana.say('@helper now')
  dana.say('just you', { to: 'helper' })
  dana.say('not for helper')
  helper.say('@helper me')
  const task = dana.addTask({ title: 'Webhook task', assignee: 'helper', toAi: false })
  await waitFor(() => posts.length === 3)
  await sleep(50)
  assert.equal(posts.length, 3)
  const bodies = posts.map((p) => JSON.parse(p.init.body))
  assert.deepEqual(bodies.map((b) => [b.event, b.by, b.to, b.room, b.text]), [
    ['chat.mention', 'dana', 'helper', 'wh', '@helper now'],
    ['chat.dm', 'dana', 'helper', 'wh', 'just you'],
    ['task.assigned', 'dana', 'helper', 'wh', 'Webhook task']
  ])
  assert.equal(bodies[2].task.id, task.id)
  for (const p of posts) assert.equal(verifyWebhook('local-secret-sixteen', p.init.headers['x-quilt-timestamp'], p.init.body, p.init.headers['x-quilt-signature']), true)
  for (const p of posts) assert.equal(p.init.headers.authorization, 'Bearer crsr_key')
  assert.equal(helper.inbox().events.length, 4, 'the inbox keeps them too')
})

test('the subscription survives a restart of the session, and clearing it stops the POSTs', async () => {
  await helper.stop()
  helper = new Session({ dir: helperDir, server, room: 'wh', secret: 'pw', name: 'helper', kind: 'agent', identity, webhookTransport: transport })
  await helper.start({ waitTimeoutMs: 5000 })
  assert.equal(helper.webhook?.url, 'http://127.0.0.1:1/hook')
  dana.say('after restart', { to: 'helper' })
  await waitFor(() => posts.length === 4)
  assert.equal(JSON.parse(posts[3].init.body).text, 'after restart')
  assert.equal(helper.clearWebhook(), true)
  assert.equal(helper.clearWebhook(), false)
  assert.equal(fs.existsSync(path.join(helperDir, '.quilt', 'webhook.json')), false)
  dana.say('@helper silent')
  await waitFor(() => helper.inbox().events.some((e) => e.text === '@helper silent'))
  await sleep(50)
  assert.equal(posts.length, 4)
})
