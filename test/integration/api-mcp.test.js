// The accounts API's /mcp: a hosted agent signs in with its access key, and the API
// hands each request to the relay with a pass for the agent. A cloud AI needs nothing
// but that URL and its key to take part in sessions.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startTestApi, makeAgent } from '../helpers/api-helpers.js'
import { startServer } from '../../src/server.js'
import { joiningRoom } from '../../src/api/server.js'
import { Session } from '../../src/session.js'
import { generateIdentity } from '../../src/identity.js'
import crypto from 'node:crypto'
import { newPassKeys } from '../../src/passes.js'
import { testPasses } from '../helpers/pass-helpers.js'

process.env.HOME = process.env.USERPROFILE = process.env.USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-am-home-'))
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-am-${n}-`))
async function waitFor (fn, ms = 8000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}
const out = (r) => r.content.map((c) => c.text).join('\n')

let t, relay, dana, danaDir
const keys = newPassKeys()
before(async () => {
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: keys.publicKey })
  t = await startTestApi({ passKey: keys.privateKey, relayUrl: `ws://127.0.0.1:${relay.port}` })
  const id = generateIdentity()
  danaDir = tmp('dana')
  dana = new Session({ dir: danaDir, server: `ws://127.0.0.1:${relay.port}`, room: 'am-1', secret: 's', name: 'Dana', identity: id, passes: testPasses(id, { keys }) })
  await dana.start({ waitTimeoutMs: 5000 })
})
after(async () => { await dana.stop(); await t.close(); await relay.close() })

async function client (accessKey) {
  const c = new Client({ name: 'cloud-ai', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(`${t.api.url}/mcp`), { requestInit: { headers: accessKey ? { authorization: `Bearer ${accessKey}` } : {} } }))
  return c
}

test('/mcp needs an agent access key', async () => {
  await assert.rejects(client(''), /send your agent access key/)
  await assert.rejects(client('qa_nope'), /sign the agent in first/)
})

test('a key-less (hosted) agent joins a session through /mcp and works on its files', async () => {
  const { agent, accessKey } = await makeAgent(t, { name: 'Grok-Bot', provider: 'xAI', ownerUserId: 'mem' })
  const me = (await t.call('GET', '/v1/agents/me', null, null, { authorization: `Bearer ${accessKey}` })).body
  assert.equal(me.agent.hosted, true)
  assert.equal(me.agent.canJoinSessions, true)
  assert.equal(me.mcp, 'https://api.quilt.test/mcp')

  const c = await client(accessKey)
  try {
    const tools = (await c.listTools()).tools.map((x) => x.name)
    assert.ok(tools.includes('quilt_join_session') && tools.includes('quilt_write_file'))
    const r = await c.callTool({ name: 'quilt_join_session', arguments: { invite: 'https://join.heyquilt.com/am-1#s' } })
    assert.equal(r.isError, undefined, out(r))
    assert.match(out(r), /Joined room am-1 as Grok-Bot \(editor\)/)
    await c.callTool({ name: 'quilt_write_file', arguments: { path: 'from-cloud.txt', content: 'hi from the cloud' } })
    await waitFor(() => { try { return fs.readFileSync(path.join(danaDir, 'from-cloud.txt'), 'utf8') === 'hi from the cloud' } catch { return false } })
    assert.match(out(await c.callTool({ name: 'quilt_status', arguments: {} })), /- Dana \(/)
    assert.ok(agent.id)
    // A hosted agent's answer to a direct message carries its id, and it answers it once.
    const ask = dana.say('did the file land?', { to: 'Grok-Bot' })
    await waitFor(async () => out(await c.callTool({ name: 'quilt_read_messages', arguments: {} })).includes(`id ${ask.id}`))
    assert.match(out(await c.callTool({ name: 'quilt_message', arguments: { text: 'Yes, it is there.', to: 'Dana' } })), /Sent to Dana/)
    const answer = await waitFor(() => dana.messages({ markRead: false }).find((m) => m.by === 'Grok-Bot' && m.text === 'Yes, it is there.'))
    assert.equal(answer.re, ask.id)
    const again = await c.callTool({ name: 'quilt_message', arguments: { text: 'It landed.', re: ask.id } })
    assert.equal(again.isError, true)
    assert.match(out(again), /already answered/)
  } finally { await c.close() }
})

test('a revoked agent is turned away at /mcp', async () => {
  const { agent, accessKey } = await makeAgent(t, { name: 'Gone', ownerUserId: 'mem' })
  await t.store.revokeAgent(agent.id)
  await assert.rejects(client(accessKey), /revoked/)
})

test('an agent the owner granted joins straight in through /mcp, and its grant holds for its later calls', async () => {
  // Mo owns a session with an owner (a view secret); heyquilt.com knows he owns it.
  const id = generateIdentity()
  const moDir = tmp('mo')
  const mo = new Session({ dir: moDir, server: `ws://127.0.0.1:${relay.port}`, room: 'am-2', secret: 's', viewSecret: 'v', name: 'Mo', identity: id, passes: testPasses(id, { keys, sub: 'mem', name: 'Mo' }) })
  await mo.start({ waitTimeoutMs: 5000 })
  await t.store.ingestPresence([{ id: crypto.randomUUID(), type: 'start', room: 'am-2', account: 'person:mem', name: 'Mo', owner: true, at: Date.now() }], Date.now())
  const { agent, accessKey } = await makeAgent(t, { name: 'Gem', ownerUserId: 'mem' })
  const granted = await t.call('PUT', `/v1/sessions/am-2/grants/agent:${agent.id}`, { typeId: 'builtin:edit', tighten: { talk: false } }, 'mem')
  assert.equal(granted.status, 200)
  const c = await client(accessKey)
  try {
    assert.match(out(await c.callTool({ name: 'quilt_join_session', arguments: { invite: 'https://join.heyquilt.com/am-2#v' } })), /Joined room am-2 as Gem \(editor\)/)
    assert.equal(mo.waiting.length, 0)
    // Later calls name no room: the API passes the one the relay said the agent is in (x-quilt-room).
    assert.equal(out(await c.callTool({ name: 'quilt_message', arguments: { text: 'hi' } })), "You can't post in this session.")
    await c.callTool({ name: 'quilt_write_file', arguments: { path: 'gem.txt', content: 'from Gem' } })
    await waitFor(() => { try { return fs.readFileSync(path.join(moDir, 'gem.txt'), 'utf8') === 'from Gem' } catch { return false } })
    // quilt-api restarts: it no longer knows which room Gem is in. Gem's next call still works,
    // the API asking the relay again with a pass for the room the relay names.
    // The agent's client was set up before the restart, so its first call is a tool call.
    const restarted = await startTestApi({ passKey: keys.privateKey, relayUrl: `ws://127.0.0.1:${relay.port}`, store: t.store })
    try {
      const res = await fetch(`${restarted.api.url}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessKey}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'quilt_write_file', arguments: { path: 'gem2.txt', content: 'after a restart' } } })
      })
      const text = await res.text()
      assert.equal(res.status, 200)
      assert.match(text, /Created gem2\.txt/)
      await waitFor(() => { try { return fs.readFileSync(path.join(moDir, 'gem2.txt'), 'utf8') === 'after a restart' } catch { return false } })
    } finally { await restarted.close() }
  } finally { await c.close(); await mo.stop() }
})

test('the pass for a quilt_join_session call is for the room it joins', () => {
  const call = (name, args) => Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }))
  assert.equal(joiningRoom(call('quilt_join_session', { invite: 'https://join.heyquilt.com/am-9#s' })), 'am-9')
  assert.equal(joiningRoom(call('quilt_status', {})), '')
  assert.equal(joiningRoom(call('quilt_join_session', { invite: 'nonsense' })), '')
  assert.equal(joiningRoom(Buffer.from('not json')), '')
  assert.equal(joiningRoom(undefined), '')
})
