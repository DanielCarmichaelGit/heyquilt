// The relay reports presence to the accounts API: a visit starts when an account is
// let into a session and ends when it leaves. The owner names the session.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { startServer, relayConfig } from '../src/server.js'
import { generateIdentity, signChallenge } from '../src/identity.js'
import { Connection } from '../src/connection.js'
import { MSG_AUTH, MSG_ACCESS, MSG_ADMIN, MSG_MEMBERS, decoding, bytesMessage, jsonMessage } from '../src/protocol.js'
import { PRESENCE_FILE } from '../src/presence.js'
import { PASS_KEYS, makePass, testPasses } from './pass-helpers.js'
import { startTestApi } from './api-helpers.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { signPass, PASS_TTL_MS } from '../src/passes.js'

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-presence-home-'))
const SECRET = 'relay-api-secret-for-tests'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor (fn, ms = 5000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await wait(25) }
  throw new Error('timed out')
}
let rooms = 0
const room = () => `pr-${++rooms}`

/** A stand-in accounts API: every event the relay sends, in order. */
function collector () {
  const events = []
  const fetch = async (url, init) => {
    assert.equal(init.headers.authorization, `Bearer ${SECRET}`)
    events.push(...JSON.parse(init.body).events)
    return { ok: true, status: 200 }
  }
  return { fetch, events }
}

async function relay (t, opts = {}) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: PASS_KEYS.publicKey, apiUrl: 'http://api.test', relayApiSecret: SECRET, ...opts })
  t.after(() => srv.close())
  return srv
}

function connect (srv, r, { identity = generateIdentity(), pass, viewSecret } = {}) {
  const q = new URLSearchParams({ secret: 's', name: 'n', key: identity.publicKey, kind: 'human', features: 'large-files' })
  if (pass) q.set('pass', pass)
  if (viewSecret) q.set('viewSecret', viewSecret)
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/${r}?${q}`)
  ws.binaryType = 'arraybuffer'
  const c = { ws, access: [], members: [] }
  c.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)))
  return new Promise((resolve, reject) => {
    c.closed.then((code) => reject(new Error(`closed with ${code}`)))
    ws.on('error', () => {})
    ws.on('message', (data) => {
      const dec = decoding.createDecoder(new Uint8Array(data))
      const type = decoding.readVarUint(dec)
      if (type === MSG_AUTH) ws.send(bytesMessage(MSG_AUTH, signChallenge(identity, r, decoding.readVarUint8Array(dec))))
      else if (type === MSG_ACCESS) { c.access.push(JSON.parse(decoding.readVarString(dec))); resolve(c) } else if (type === MSG_MEMBERS) c.members.push(JSON.parse(decoding.readVarString(dec)))
    })
  })
}
const as = (name, sub, kind = 'person') => { const identity = generateIdentity(); return { identity, pass: makePass({ identity, name, sub, kind }) } }
let adminIds = 0
function admin (c, req) {
  const id = ++adminIds
  c.ws.send(jsonMessage(MSG_ADMIN, { id, ...req }))
  return waitFor(() => c.members.find((m) => m.reply && m.reply.id === id)?.reply)
}
const leave = async (c) => { c.ws.close(); await c.closed.catch(() => {}) }

test('presence is off unless both QUILT_API_URL and RELAY_API_SECRET are set', async (t) => {
  for (const opts of [{ apiUrl: '', relayApiSecret: '' }, { apiUrl: 'http://api.test', relayApiSecret: '' }, { apiUrl: '', relayApiSecret: SECRET }]) {
    const srv = await relay(t, opts)
    assert.equal(srv.presence, null, JSON.stringify(opts))
  }
  assert.deepEqual([relayConfig({}).apiUrl, relayConfig({}).relayApiSecret], ['', ''])
})

test('an account let in starts a visit, and leaving ends it', async (t) => {
  const api = collector()
  const srv = await relay(t, { presenceOptions: { fetch: api.fetch } })
  const r = room()
  const olive = as('Olive', 'user-olive')
  const o = await connect(srv, r, { ...olive, viewSecret: 'v' })
  const bot = as('Larry', 'agent-1', 'agent')
  const b = await connect(srv, r, bot)
  assert.equal(b.access[0].state, 'pending')
  await admin(o, { op: 'approve', key: 'agent:agent-1' })
  await leave(b)
  await waitFor(() => srv.presence.open.size === 1)
  await srv.presence.flush()
  assert.deepEqual(api.events.map((e) => [e.type, e.room, e.account, e.name, e.owner]), [
    ['start', r, 'person:user-olive', 'Olive', true],
    ['start', r, 'agent:agent-1', 'Larry', undefined],
    ['end', r, 'agent:agent-1', undefined, undefined]
  ])
  assert.equal(api.events[2].start, api.events[1].id)
})

test("the owner's visit reaches the accounts API at once, so they can give people access straight away", async (t) => {
  const api = collector()
  const srv = await relay(t, { presenceOptions: { fetch: api.fetch, flushMs: 60 * 60 * 1000 } })
  const r = room()
  await connect(srv, r, { ...as('Olive', 'user-olive'), viewSecret: 'v' })
  await waitFor(() => api.events.some((e) => e.type === 'start' && e.owner && e.room === r))
})

test('someone waiting for the owner records nothing, and nothing if they are turned away', async (t) => {
  const api = collector()
  const srv = await relay(t, { presenceOptions: { fetch: api.fetch } })
  const r = room()
  const o = await connect(srv, r, { ...as('Olive', 'user-olive'), viewSecret: 'v' })
  const gus = await connect(srv, r, as('Gus', 'user-gus'))
  assert.equal(gus.access[0].state, 'pending')
  await admin(o, { op: 'deny', key: 'person:user-gus' })
  await srv.presence.flush()
  assert.deepEqual(api.events.map((e) => e.account), ['person:user-olive'])
})

test('connections without a pass are never reported', async (t) => {
  const api = collector()
  const srv = await relay(t, { passPublicKey: '', presenceOptions: { fetch: api.fetch } })
  await connect(srv, room())
  await srv.presence.flush()
  assert.deepEqual(api.events, [])
})

test('only the owner names the session; the name reaches everyone in it, and the API', async (t) => {
  const api = collector()
  const srv = await relay(t, { presenceOptions: { fetch: api.fetch } })
  const r = room()
  const o = await connect(srv, r, { ...as('Olive', 'user-olive'), viewSecret: 'v' })
  const gus = await connect(srv, r, as('Gus', 'user-gus'))
  await admin(o, { op: 'approve', key: 'person:user-gus' })
  for (const bad of ['', '   ', 'x'.repeat(81), 'two\nlines', 42]) {
    const reply = await admin(o, { op: 'name', name: bad })
    assert.deepEqual(reply, { id: reply.id, ok: false, error: 'Give the session a name of 1 to 80 characters.' }, JSON.stringify(bad))
  }
  assert.equal((await admin(gus, { op: 'name', name: 'Mine' })).error, 'only the session owner can do that')
  assert.equal((await admin(o, { op: 'name', name: '  quilt-site  ' })).ok, true)
  await waitFor(() => gus.members.some((m) => m.sessionName === 'quilt-site'))
  assert.equal(srv.rooms.get(r).meta.name, 'quilt-site')
  await srv.presence.flush()
  assert.deepEqual(api.events.filter((e) => e.type === 'name').map((e) => [e.room, e.name]), [[r, 'quilt-site']])
})

test('the queue file survives a crash, and the next start ends the visits left open', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-presence-data-'))
  const down = { fetch: async () => ({ ok: false, status: 503 }) }
  const first = await relay(t, { dataDir: dir, presenceOptions: down })
  const r = room()
  await connect(first, r, as('Olive', 'user-olive'))
  first.presence.persist()
  // A crash: the next relay finds the file as this one left it.
  const crashed = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-presence-data-'))
  fs.copyFileSync(path.join(dir, PRESENCE_FILE), path.join(crashed, PRESENCE_FILE))
  const api = collector()
  const second = await relay(t, { dataDir: crashed, presenceOptions: { fetch: api.fetch } })
  await second.presence.flush()
  assert.deepEqual(api.events.map((e) => [e.type, e.account]), [['start', 'person:user-olive'], ['end', 'person:user-olive']])
})

test('shutting down ends open visits and sends them', async (t) => {
  const api = collector()
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: PASS_KEYS.publicKey, apiUrl: 'http://api.test', relayApiSecret: SECRET, presenceOptions: { fetch: api.fetch } })
  await connect(srv, room(), as('Olive', 'user-olive'))
  await srv.close()
  assert.deepEqual(api.events.map((e) => e.type), ['start', 'end'])
})

test('a room is saved even if presence.close() never resolves', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-presence-data-'))
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, dataDir: dir, passPublicKey: PASS_KEYS.publicKey, apiUrl: 'http://api.test', relayApiSecret: SECRET })
  const r = room()
  const doc = new Y.Doc()
  const identity = generateIdentity()
  const c = new Connection({ server: `ws://127.0.0.1:${srv.port}`, room: r, secret: 's', name: 'Olive', identity, doc, passes: testPasses(identity, { name: 'Olive', sub: 'user-olive' }) })
  t.after(() => { if (!c.closed) c.close() })
  await c.waitForSync()
  // A real edit: something only the shutdown save (not the one admit already did) can have written.
  doc.getText('t').insert(0, 'kept')
  await waitFor(() => srv.rooms.get(r)?.doc.getText('t').toString() === 'kept')
  const ydocPath = path.join(dir, `${r}.ydoc`)
  assert.equal(fs.existsSync(ydocPath), false, 'not on disk yet: only the debounced save or shutdown writes it')
  // Stand in for a hung accounts API without waiting out any real timeout: a promise
  // only this test resolves, once it has already checked what it came to check.
  let resolveClose
  srv.presence.close = () => new Promise((resolve) => { resolveClose = resolve })
  const closing = srv.close()
  assert.ok(fs.existsSync(ydocPath), "the room's edit was saved before presence.close() got a chance to resolve")
  resolveClose()
  await closing
})

test('renaming to the same name again saves nothing new and reports nothing new', async (t) => {
  const api = collector()
  const srv = await relay(t, { presenceOptions: { fetch: api.fetch } })
  const r = room()
  const o = await connect(srv, r, { ...as('Olive', 'user-olive'), viewSecret: 'v' })
  assert.equal((await admin(o, { op: 'name', name: 'quilt-site' })).ok, true)
  assert.equal((await admin(o, { op: 'name', name: '  quilt-site  ' })).ok, true) // same name, just re-trimmed
  await srv.presence.flush()
  assert.deepEqual(api.events.filter((e) => e.type === 'name').map((e) => e.name), ['quilt-site'])
})

test('a room takes at most one rename every 2 seconds; its first name and repeats of the current name are never refused', async (t) => {
  const api = collector()
  const srv = await relay(t, { presenceOptions: { fetch: api.fetch } })
  const r = room()
  const o = await connect(srv, r, { ...as('Olive', 'user-olive'), viewSecret: 'v' })
  assert.equal((await admin(o, { op: 'name', name: 'quilt-site' })).ok, true, 'a new session is named after its folder')
  assert.equal((await admin(o, { op: 'name', name: 'first' })).ok, true, 'and its owner may rename it straight away')
  const refused = await admin(o, { op: 'name', name: 'second' })
  assert.deepEqual(refused, { id: refused.id, ok: false, error: 'Renaming too fast; try again in a moment' })
  assert.equal(srv.rooms.get(r).meta.name, 'first', 'a refused rename saves nothing')
  assert.equal((await admin(o, { op: 'name', name: 'first' })).ok, true, 'repeating the current name changes nothing')
  srv.rooms.get(r).lastRenameAt -= 2000 // as if 2 seconds had passed
  assert.equal((await admin(o, { op: 'name', name: 'second' })).ok, true)
  await srv.presence.flush()
  // The earlier names were still waiting to be sent: each newer one took their place.
  assert.deepEqual(api.events.filter((e) => e.type === 'name').map((e) => e.name), ['second'])
})

test('end to end: two accounts in one session see each other on their dashboards', async (t) => {
  const accounts = await startTestApi({ relaySecret: SECRET })
  t.after(() => accounts.close())
  const srv = await relay(t, { apiUrl: accounts.api.url })
  const r = room()
  const mo = await connect(srv, r, { ...as('Mo', 'mem'), viewSecret: 'v' })
  const ada = await connect(srv, r, as('Ada', 'admin'))
  await admin(mo, { op: 'approve', key: 'person:admin' })
  await admin(mo, { op: 'name', name: 'quilt-site' })
  await wait(50)
  await leave(ada)
  await waitFor(() => srv.presence.open.size === 1)
  assert.equal(await srv.presence.flush(), true)
  const mine = (await accounts.call('GET', '/v1/me/sessions', null, 'mem')).body.sessions.find((s) => s.room === r)
  assert.deepEqual([mine.name, mine.mine, mine.people.map((p) => p.name)], ['quilt-site', true, ['Ada']])
  const hers = (await accounts.call('GET', '/v1/me/sessions', null, 'admin')).body.sessions.find((s) => s.room === r)
  assert.deepEqual([hers.name, hers.mine, hers.owner.name, hers.people.map((p) => p.name)], ['quilt-site', false, 'Mo', ['Mo']])
  assert.ok(hers.people[0].togetherMs > 0)
})

test('a hosted agent (HTTP only, no connection) has a visit from its first call once let in, with what it did, ended when it is removed', async (t) => {
  const api = collector()
  const srv = await relay(t, { presenceOptions: { fetch: api.fetch } })
  const r = room()
  const o = await connect(srv, r, { ...as('Olive', 'user-olive'), viewSecret: 'v' })
  const pass = signPass({ v: 1, sub: 'agent-grok', kind: 'agent', name: 'Grok-Bot', key: '', exp: Date.now() + PASS_TTL_MS }, PASS_KEYS.privateKey)
  const grok = new Client({ name: 'grok', version: '1.0.0' })
  await grok.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), { requestInit: { headers: { 'x-quilt-pass': pass } } }))
  try {
    const call = async (name, args = {}) => (await grok.callTool({ name, arguments: args })).content.map((c) => c.text).join('\n')
    assert.match(await call('quilt_join_session', { invite: `https://join.heyquilt.com/${r}#s` }), /Asked to join/)
    await admin(o, { op: 'approve', key: 'agent:agent-grok' })
    assert.match(await call('quilt_write_file', { path: 'a.txt', content: 'a' }), /Created a.txt/)
    assert.equal((await admin(o, { op: 'name', name: 'hosted' })).ok, true)
    await admin(o, { op: 'remove', key: 'agent:agent-grok' })
    assert.match(await call('quilt_leave_session'), /Left room/)
    await srv.presence.flush()
    // Its visit starts with its first call once let in, lists what it did (never contents), and ends when it is removed.
    const seen = api.events.map((e) => [e.type, e.account || e.name, e.via || e.action || e.reason || '', e.target || ''])
    assert.deepEqual(seen, [
      ['start', 'person:user-olive', 'app', ''],
      ['start', 'agent:agent-grok', 'hosted', ''],
      ['act', 'agent:agent-grok', 'tool', 'quilt_write_file a.txt'],
      ['act', 'agent:agent-grok', 'claimed', 'a.txt'],
      ['act', 'agent:agent-grok', 'created', 'a.txt'],
      ['name', 'hosted', '', ''],
      ['end', 'agent:agent-grok', 'removed', '']
    ])
    const grokStart = api.events.find((e) => e.type === 'start' && e.account === 'agent:agent-grok')
    assert.ok(api.events.filter((e) => e.type === 'act').every((e) => e.start === grokStart.id), 'acts belong to its visit')
    assert.ok(api.events.every((e) => !('content' in e)), 'no contents')
  } finally { await grok.close() }
})

test("a hosted agent's claims show it present, and go when it leaves the session", async (t) => {
  const srv = await relay(t)
  const r = room()
  const o = await connect(srv, r, { ...as('Olive', 'user-olive'), viewSecret: 'v' })
  const pass = signPass({ v: 1, sub: 'agent-duncan', kind: 'agent', name: 'Duncan', key: '', exp: Date.now() + PASS_TTL_MS }, PASS_KEYS.privateKey)
  const duncan = new Client({ name: 'duncan', version: '1.0.0' })
  await duncan.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), { requestInit: { headers: { 'x-quilt-pass': pass } } }))
  try {
    const call = async (name, args = {}) => (await duncan.callTool({ name, arguments: args })).content.map((c) => c.text).join('\n')
    assert.match(await call('quilt_join_session', { invite: `https://join.heyquilt.com/${r}#s` }), /Asked to join/)
    await admin(o, { op: 'approve', key: 'agent:agent-duncan' })
    assert.match(await call('quilt_claim', { pattern: 'src/mcp.js' }), /Claimed/)
    const rm = srv.rooms.get(r)
    assert.deepEqual(rm.claimList().map((c) => [c.byId, c.active]), [['agent:agent-duncan', true]])
    assert.match(await call('quilt_leave_session'), /Left room/)
    assert.deepEqual(rm.claimList(), [])
  } finally { await duncan.close() }
})

test('the file queue between two hosted agents: ask, be told, hand off with context, then edit', async (t) => {
  const srv = await relay(t)
  const r = room()
  const o = await connect(srv, r, { ...as('Olive', 'user-olive'), viewSecret: 'v' })
  const clients = []
  const agentClient = async (sub, name) => {
    const pass = signPass({ v: 1, sub, kind: 'agent', name, key: '', exp: Date.now() + PASS_TTL_MS }, PASS_KEYS.privateKey)
    const c = new Client({ name: sub, version: '1.0.0' })
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), { requestInit: { headers: { 'x-quilt-pass': pass } } }))
    clients.push(c)
    const call = async (tool, args = {}) => {
      const res = await c.callTool({ name: tool, arguments: args })
      return { text: res.content.map((x) => x.text).join('\n'), error: !!res.isError }
    }
    assert.match((await call('quilt_join_session', { invite: `https://join.heyquilt.com/${r}#s` })).text, /Asked to join/)
    await admin(o, { op: 'approve', key: `agent:${sub}` })
    return call
  }
  const ann = await agentClient('agent-ann', 'Ann')
  const bob = await agentClient('agent-bob', 'Bob')
  assert.match((await ann('quilt_write_file', { path: 'src/mcp.js', content: 'v1' })).text, /Created src\/mcp\.js/)
  const refused = await bob('quilt_write_file', { path: 'src/mcp.js', content: 'bob' })
  assert.equal(refused.error, true)
  assert.match(refused.text, /claimed by Ann.*quilt_request_file \(path "src\/mcp\.js"/s)
  const asked = await bob('quilt_request_file', { path: 'src/mcp.js', title: 'Working on handoff for task 7', description: 'Add the tool and its tests.' })
  assert.match(asked.text, /number 1 in the queue for src\/mcp\.js \(held by Ann\)/)
  // Every answer Ann gets now says Bob is waiting, and she can't let go of the file or finish.
  const told = await ann('quilt_write_file', { path: 'src/mcp.js', content: 'v2' })
  assert.match(told.text, /📥 Waiting in the file queue for files you hold:\n- src\/mcp\.js: Bob \(for src\/mcp\.js\): "Working on handoff for task 7" — Add the tool and its tests\./)
  const rel = await ann('quilt_release', { pattern: 'src/mcp.js' })
  assert.equal(rel.error, true)
  assert.match(rel.text, /Not yet: people are waiting/)
  assert.match((await ann('quilt_inbox')).text, /Bob asked for src\/mcp\.js in its file queue/)
  // Ann's inbox message from Bob asks for no reply: her other tools aren't held up.
  assert.equal((await ann('quilt_claim', { pattern: 'docs/**' })).error, false)
  const h = await ann('quilt_handoff', { path: 'src/mcp.js', context: 'v2 adds the tool; tests still to write.' })
  assert.match(h.text, /Handed src\/mcp\.js to Bob with your context/)
  assert.doesNotMatch(h.text, /📥/, 'nobody waiting any more')
  assert.match((await bob('quilt_inbox')).text, /Ann handed you src\/mcp\.js, which you asked for: it is yours to edit now\. .*My context: v2 adds the tool; tests still to write\./s)
  assert.match((await bob('quilt_write_file', { path: 'src/mcp.js', content: 'bob v3' })).text, /Updated src\/mcp\.js/)
  assert.equal((await bob('quilt_move_task', { id: 'nope', column: 'doing' })).error, true) // not blocked by a reply owed to Ann
  assert.doesNotMatch((await bob('quilt_move_task', { id: 'nope', column: 'doing' })).text, /waiting for an answer/)
  await Promise.all(clients.map((c) => c.close()))
})
