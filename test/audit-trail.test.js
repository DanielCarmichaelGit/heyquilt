// The audit trail: how each member came into a session (the app or a hosted agent, and its
// tool), why it left, and what it did meanwhile (paths and task ids; never contents).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { startServer, endReasonFor, HOSTED_ONLINE_MS } from '../src/server.js'
import { generateIdentity, signChallenge } from '../src/identity.js'
import { MSG_AUTH, MSG_ACCESS, MSG_ADMIN, MSG_MEMBERS, MSG_CLAIM, decoding, bytesMessage, jsonMessage, updateMessage, CLOSE_DENIED, CLOSE_ENDED, CLOSE_PASS_EXPIRED } from '../src/protocol.js'
import { PASS_KEYS, makePass } from './pass-helpers.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { signPass, PASS_TTL_MS } from '../src/passes.js'

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-audit-home-'))
const SECRET = 'relay-api-secret-for-tests'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor (fn, ms = 5000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await wait(25) }
  throw new Error('timed out')
}
let rooms = 0
const room = () => `audit-${++rooms}`

function collector () {
  const events = []
  const fetch = async (url, init) => { events.push(...JSON.parse(init.body).events); return { ok: true, status: 200 } }
  return { fetch, events }
}

async function relay (t, api) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: PASS_KEYS.publicKey, apiUrl: 'http://api.test', relayApiSecret: SECRET, presenceOptions: { fetch: api.fetch } })
  t.after(() => srv.close())
  return srv
}

function connect (srv, r, { name, sub, kind = 'person', tool = '', viewSecret }) {
  const identity = generateIdentity()
  const pass = makePass({ identity, name, sub, kind })
  const q = new URLSearchParams({ secret: 's', name: 'n', key: identity.publicKey, kind: kind === 'agent' ? 'agent' : 'human', features: 'large-files,branches', pass })
  if (viewSecret) q.set('viewSecret', viewSecret)
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/${r}?${q}`, { headers: tool ? { 'x-quilt-tool': tool } : {} })
  ws.binaryType = 'arraybuffer'
  const c = { ws, access: [], members: [], doc: new Y.Doc() }
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
let adminIds = 0
function admin (c, req) {
  const id = ++adminIds
  c.ws.send(jsonMessage(MSG_ADMIN, { id, ...req }))
  return waitFor(() => c.members.find((m) => m.reply && m.reply.id === id)?.reply)
}
/** Makes a change in the client's copy of the session and sends it to the relay. */
function change (c, fn) {
  const before = Y.encodeStateVector(c.doc)
  c.doc.transact(() => fn(c.doc))
  c.ws.send(updateMessage(Y.encodeStateAsUpdate(c.doc, before)))
}
const eventsOf = (api, account) => api.events.filter((e) => e.account === account)

test('close codes the relay did not send map to a reason: a clean close is leaving, anything else a drop', () => {
  for (const code of [1000, 1001, 1005]) assert.equal(endReasonFor(code), 'left')
  assert.equal(endReasonFor(1006), 'disconnected')
  assert.equal(endReasonFor(CLOSE_DENIED), 'removed')
  assert.equal(endReasonFor(CLOSE_ENDED), 'session_ended')
  assert.equal(endReasonFor(CLOSE_PASS_EXPIRED), 'pass_expired')
})

test("an app's visit says which tool it is, lists the files, messages and tasks it touched, and ends as left", async (t) => {
  const api = collector()
  const srv = await relay(t, api)
  const r = room()
  const o = await connect(srv, r, { name: 'Olive', sub: 'user-olive', viewSecret: 'v' })
  const c = await connect(srv, r, { name: 'Coder', sub: 'agent-coder', kind: 'agent', tool: 'Cursor' })
  await admin(o, { op: 'approve', key: 'agent:agent-coder' })
  await waitFor(() => srv.presence.open.size === 2)
  change(c, (d) => {
    d.getMap('files').set('src/a.js', new Y.Text('secret contents'))
    d.getArray('activity').push([{ by: 'Coder', path: 'src/a.js', kind: 'created', ts: Date.now() }])
  })
  change(c, (d) => d.getArray('activity').push([{ by: 'Coder', path: 'src/a.js', kind: 'edited', ts: Date.now() }]))
  change(c, (d) => d.getArray('activity').push([{ by: 'Coder', path: 'src/a.js', kind: 'edited', ts: Date.now() }])) // within the minute: not again
  change(c, (d) => d.getArray('chat').push([{ id: 'm1', by: 'Coder', text: 'private words', to: 'Olive', ts: Date.now() }]))
  change(c, (d) => d.getMap('tasks').set('t-1', { id: 't-1', title: 'Ship it', column: 'doing' }))
  await wait(100)
  c.ws.close()
  await c.closed.catch(() => {})
  await waitFor(() => srv.presence.open.size === 1)
  await srv.presence.flush()
  const mine = eventsOf(api, 'agent:agent-coder')
  const start = mine.find((e) => e.type === 'start')
  assert.deepEqual([start.via, start.tool], ['app', 'Cursor'])
  assert.deepEqual(mine.filter((e) => e.type === 'act').map((e) => [e.action, e.target || '']), [
    ['created', 'src/a.js'], ['edited', 'src/a.js'], ['messaged', 'to Olive'], ['task', 't-1']
  ])
  assert.ok(mine.filter((e) => e.type !== 'start').every((e) => e.start === start.id))
  assert.equal(mine.find((e) => e.type === 'end').reason, 'left')
  assert.doesNotMatch(JSON.stringify(api.events), /secret contents|private words|Ship it/, 'no contents, chat or task text')
})

test('removed by the owner, dropped, and the session ended: each ends the visit with its reason', async (t) => {
  const api = collector()
  const srv = await relay(t, api)
  const r = room()
  const o = await connect(srv, r, { name: 'Olive', sub: 'user-olive', viewSecret: 'v' })
  const a = await connect(srv, r, { name: 'Ann', sub: 'user-ann' })
  const b = await connect(srv, r, { name: 'Ben', sub: 'user-ben' })
  await admin(o, { op: 'approve', key: 'person:user-ann' })
  await admin(o, { op: 'approve', key: 'person:user-ben' })
  await waitFor(() => srv.presence.open.size === 3)
  await admin(o, { op: 'remove', key: 'person:user-ann' })
  assert.equal(await a.closed, CLOSE_DENIED)
  b.ws.terminate() // the connection drops with no close handshake
  await waitFor(() => srv.presence.open.size === 1)
  o.ws.send(jsonMessage(MSG_ADMIN, { id: ++adminIds, op: 'end' }))
  assert.equal(await o.closed, CLOSE_ENDED)
  await waitFor(() => srv.presence.open.size === 0)
  await srv.presence.flush()
  const reason = (acc) => api.events.find((e) => e.type === 'end' && e.account === acc).reason
  assert.deepEqual([reason('person:user-ann'), reason('person:user-ben'), reason('person:user-olive')], ['removed', 'disconnected', 'session_ended'])
})

test("a hosted agent's visit ends at its last call when it goes quiet, and as left when it leaves", async (t) => {
  const api = collector()
  const srv = await relay(t, api)
  const r = room()
  const o = await connect(srv, r, { name: 'Olive', sub: 'user-olive', viewSecret: 'v' })
  const pass = signPass({ v: 1, sub: 'agent-grok', kind: 'agent', name: 'Grok-Bot', key: '', exp: Date.now() + PASS_TTL_MS }, PASS_KEYS.privateKey)
  const grok = new Client({ name: 'grok', version: '1.0.0' })
  await grok.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), { requestInit: { headers: { 'x-quilt-pass': pass } } }))
  t.after(() => grok.close())
  const call = async (name, args = {}) => (await grok.callTool({ name, arguments: args })).content.map((c) => c.text).join('\n')
  await call('quilt_join_session', { invite: `https://join.heyquilt.com/${r}#s` })
  await admin(o, { op: 'approve', key: 'agent:agent-grok' })
  await call('quilt_status')
  const h = srv.hosted.get('agent:agent-grok')
  const quietSince = Date.now() - 2 * HOSTED_ONLINE_MS
  h.seenAt = quietSince // quiet for twice as long as a check-in lasts
  srv.sweepHosted()
  await call('quilt_status') // back: a new visit
  assert.match(await call('quilt_leave_session'), /Left room/)
  await srv.presence.flush()
  const mine = eventsOf(api, 'agent:agent-grok')
  assert.deepEqual(mine.filter((e) => e.type !== 'act').map((e) => [e.type, e.reason || e.via]), [['start', 'hosted'], ['end', 'idle'], ['start', 'hosted'], ['end', 'left']])
  assert.equal(mine.find((e) => e.reason === 'idle').at, quietSince, 'ended at its last call')
  assert.deepEqual(mine.filter((e) => e.type === 'act').map((e) => e.target), ['quilt_status', 'quilt_status'])
})

test("an app's claims, requests and releases are in its visit", async (t) => {
  const api = collector()
  const srv = await relay(t, api)
  const r = room()
  const o = await connect(srv, r, { name: 'Olive', sub: 'user-olive', viewSecret: 'v' })
  await waitFor(() => srv.presence.open.size === 1)
  o.ws.send(jsonMessage(MSG_CLAIM, { id: 1, op: 'claim', pattern: 'LICENSE', note: 'x' }))
  o.ws.send(jsonMessage(MSG_CLAIM, { id: 2, op: 'release', pattern: 'LICENSE' }))
  await waitFor(() => srv.presence.queue.filter((x) => x.ev.type === 'act').length === 2)
  await srv.presence.flush()
  assert.deepEqual(api.events.filter((e) => e.type === 'act').map((e) => [e.action, e.target]), [['claimed', 'LICENSE'], ['released', 'LICENSE']])
})
