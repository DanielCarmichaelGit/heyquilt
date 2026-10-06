// A hosted agent waiting to be let in stays on the owner's list across a relay restart
// (a Fly deploy, a machine stop/start): the waiting list lives in memory, but the relay's
// record of hosted agents is on disk.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { generateIdentity } from '../src/identity.js'
import { signPass, PASS_TTL_MS } from '../src/passes.js'
import { PASS_KEYS, testPasses } from './pass-helpers.js'

process.env.HOME = process.env.USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-hr-home-'))
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-hr-${n}-`))
async function waitFor (fn, ms = 8000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}
const out = (r) => r.content.map((c) => c.text).join('\n')
const pass = (sub, name) => signPass({ v: 1, sub, kind: 'agent', name, key: '', exp: Date.now() + PASS_TTL_MS }, PASS_KEYS.privateKey)

const dataDir = tmp('relay')
const ownerId = generateIdentity()
const ownerDir = tmp('owner')
fs.writeFileSync(path.join(ownerDir, 'README.md'), '# Project\n')
let srv, owner
const clients = []
const start = async (port = 0) => {
  srv = await startServer({ port, host: '127.0.0.1', dataDir, log: () => {}, passPublicKey: PASS_KEYS.publicKey })
  return srv.port
}
const openOwner = async (port) => {
  owner = new Session({ dir: ownerDir, server: `ws://127.0.0.1:${port}`, room: 'hr-1', secret: 's', viewSecret: 'v', name: 'Olive', tool: 'Claude Code', identity: ownerId, passes: testPasses(ownerId, { name: 'Olive', sub: 'user-olive' }) })
  await owner.start({ waitTimeoutMs: 5000 })
  await waitFor(() => owner.isOwner)
}
const agent = async (port, sub, name) => {
  const c = new Client({ name: 'chat', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { 'x-quilt-pass': pass(sub, name) } } }))
  clients.push(c)
  return (tool, args = {}) => c.callTool({ name: tool, arguments: args })
}
// Agents' HTTP connections don't outlive the relay; closing them lets the server close.
const stop = async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  await owner.stop()
  await srv.close()
}
const restart = async () => {
  const port = srv.port
  await stop()
  await start(port)
  await openOwner(port)
  return port
}
after(stop)

test('after a restart the owner still sees a waiting hosted agent, before it calls a tool, and can let it in', async () => {
  const port = await start()
  await openOwner(port)
  const call = await agent(port, 'agent-wren', 'Wren')
  assert.match(out(await call('quilt_join_session', { invite: 'https://join.heyquilt.com/hr-1#v' })), /Asked to join room hr-1 as a viewer/)
  await waitFor(() => owner.waiting.some((p) => p.key === 'agent:agent-wren'))

  await restart()
  // The owner's member message lists the agent as waiting, without it calling anything.
  const w = await waitFor(() => owner.waiting.find((p) => p.key === 'agent:agent-wren'))
  assert.deepEqual([w.name, w.kind, w.invitedAs], ['Wren', 'agent', 'viewer'])

  const again = await agent(srv.port, 'agent-wren', 'Wren')
  assert.match(out(await again('quilt_session_info')), /not let you in yet/)
  assert.equal(owner.waiting.filter((p) => p.key === 'agent:agent-wren').length, 1, 'not listed twice')
  await owner.approve('agent:agent-wren', { role: 'viewer' })
  await waitFor(() => owner.members.some((m) => m.key === 'agent:agent-wren'))
  assert.match(out(await again('quilt_session_info')), /you are Wren, a viewer/)
})

test('an agent waiting from an older record (no invitedAs) is put back on the list on its next tool call', async () => {
  const call = await agent(srv.port, 'agent-finch', 'Finch')
  assert.match(out(await call('quilt_join_session', { invite: 'https://join.heyquilt.com/hr-1#s' })), /as an editor/)
  await waitFor(() => owner.waiting.some((p) => p.key === 'agent:agent-finch'))
  await stop()
  // What an older relay wrote: no invitedAs, name or kind.
  const file = path.join(dataDir, 'hosted-agents.json')
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const k of ['invitedAs', 'name', 'kind']) delete rec['agent:agent-finch'][k]
  fs.writeFileSync(file, JSON.stringify(rec))
  const port = await start(srv.port)
  await openOwner(port)
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(!owner.waiting.some((p) => p.key === 'agent:agent-finch'), 'nothing to restore it from yet')
  const again = await agent(port, 'agent-finch', 'Finch')
  assert.match(out(await again('quilt_status')), /not let you in yet/)
  await waitFor(() => owner.waiting.some((p) => p.key === 'agent:agent-finch'))
})

test('an agent the owner turns away is told so, and is not put back after a restart', async () => {
  const call = await agent(srv.port, 'agent-jay', 'Jay')
  await call('quilt_join_session', { invite: 'https://join.heyquilt.com/hr-1#s' })
  await waitFor(() => owner.waiting.some((p) => p.key === 'agent:agent-jay'))
  await owner.deny('agent:agent-jay')
  await waitFor(() => !owner.waiting.some((p) => p.key === 'agent:agent-jay'))
  await restart()
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(!owner.waiting.some((p) => p.key === 'agent:agent-jay'))
  const again = await agent(srv.port, 'agent-jay', 'Jay')
  assert.match(out(await again('quilt_status')), /did not let you in/)
  assert.ok(!owner.waiting.some((p) => p.key === 'agent:agent-jay'))
  assert.match(out(await again('quilt_session_info')), /not in a session/i)
})
