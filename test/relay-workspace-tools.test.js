// Hosted agents and the workspace library: when the accounts API says workspaces are on, the
// relay's hosted MCP offers the library tools, which reach the API with the agent's own pass.
// Driven the way a cloud AI uses it: through the API's /mcp with the agent's access key.
// With the flag off, no API, or an API that can't be reached, the tool list is as before.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startTestApi, makeAgent } from './api-helpers.js'
import { startServer } from '../src/server.js'
import { watchFeatures, HOSTED_INSTRUCTIONS } from '../src/relay-mcp.js'
import { WORKSPACE_GUIDE } from '../src/workspace-tools.js'
import { newPassKeys, signPass, PASS_TTL_MS } from '../src/passes.js'

process.env.HOME = process.env.USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-rwt-home-'))
const keys = newPassKeys()
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
const out = (r) => r.content.map((c) => c.text).join('\n')
const LIBRARY = ['quilt_workspace_delete_file', 'quilt_workspace_files', 'quilt_workspace_move_file', 'quilt_workspace_read_file', 'quilt_workspace_webhook', 'quilt_workspace_webhook_off', 'quilt_workspace_write_file', 'quilt_workspaces']
const closers = []
after(async () => { for (const c of closers.reverse()) await c() })

/** An accounts API and a relay that know each other, like production. */
async function stack ({ workspaces = true, apiUrl } = {}) {
  const relayPort = await freePort()
  const api = await startTestApi({ passKey: keys.privateKey, workspaces, relayUrl: `ws://127.0.0.1:${relayPort}` })
  const logs = []
  const relay = await startServer({ port: relayPort, host: '127.0.0.1', log: (...m) => logs.push(m.join(' ')), passPublicKey: keys.publicKey, apiUrl: apiUrl ?? api.api.url })
  closers.push(() => relay.close(), () => api.close())
  return { api, relay, logs }
}

async function connect (url, headers) {
  const c = new Client({ name: 'cloud-ai', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }))
  closers.push(() => c.close())
  return c
}
/** A cloud AI on the API's /mcp, signed in with its access key. */
const viaApi = (api, accessKey) => connect(`${api.api.url}/mcp`, { authorization: `Bearer ${accessKey}` })
/** Straight at the relay with a pass (as the API forwards it). */
const viaRelay = (relay, over = {}) => connect(`http://127.0.0.1:${relay.port}/mcp`, {
  'x-quilt-pass': signPass({ v: 1, sub: '00000000-0000-4000-8000-000000000001', kind: 'agent', name: 'Plain', key: '', exp: Date.now() + PASS_TTL_MS, ...over }, keys.privateKey)
})
const names = async (c) => (await c.listTools()).tools.map((t) => t.name).sort()

let baseline
async function baselineTools () {
  if (baseline) return baseline
  const relayPort = await freePort()
  const relay = await startServer({ port: relayPort, host: '127.0.0.1', log: () => {}, passPublicKey: keys.publicKey })
  closers.push(() => relay.close())
  assert.equal(relay.features, null, 'no API: no probe at all')
  baseline = await names(await viaRelay(relay))
  for (const t of LIBRARY) assert.ok(!baseline.includes(t), t)
  return baseline
}

test('workspaces on: a hosted agent gets the library through the API\'s /mcp, without joining a session', async () => {
  const { api, relay, logs } = await stack()
  assert.equal(await relay.features.ready, true)
  assert.equal(relay.features.on(), true)
  const launch = await api.store.createWorkspace({ ownerUserId: 'mem', name: 'Launch', createdBy: 'person:mem' })
  const archive = await api.store.createWorkspace({ ownerUserId: 'mem', name: 'Archive', createdBy: 'person:mem' })
  const { agent, accessKey } = await makeAgent(api, { name: 'Cloudy', provider: 'xAI', ownerUserId: 'mem' })
  await api.store.putAgentPlacement({ agentId: agent.id, reach: 'workspaces', workspaceIds: [launch.id], access: 'edit', sessions: 'invited', updatedBy: 'person:mem' })
  await api.store.putWorkspaceMember({ workspaceId: archive.id, account: `agent:${agent.id}`, access: 'view', addedBy: 'person:mem' })

  const c = await viaApi(api, accessKey)
  assert.deepEqual(await names(c), [...await baselineTools(), ...LIBRARY].sort(), 'the session tools plus exactly the library')
  // The library's guide rides the instructions only where the tools are offered.
  assert.equal(c.getInstructions(), `${HOSTED_INSTRUCTIONS}\n\n${WORKSPACE_GUIDE}`)
  const call = (name, args = {}) => c.callTool({ name, arguments: args })

  // Not in any session: session tools still say to join, the library works.
  assert.match(out(await call('quilt_status')), /quilt_join_session/)
  const list = await call('quilt_workspaces')
  assert.equal(list.isError, undefined, out(list))
  assert.match(out(list), /Launch/)
  assert.match(out(list), /Archive/)

  const wrote = await call('quilt_workspace_write_file', { workspace: 'launch', path: 'notes/plan.md', text: '# Plan\nShip it.\n', note: 'first draft' })
  assert.equal(wrote.isError, undefined, out(wrote))
  assert.match(out(wrote), /notes\/plan\.md/)
  const read = await call('quilt_workspace_read_file', { workspace: 'Launch', path: 'notes/plan.md' })
  assert.equal(read.isError, undefined, out(read))
  assert.match(out(read), /# Plan\nShip it\./)
  assert.doesNotMatch(out(read), /savedTo/, 'a hosted agent has no disk to save to')
  // People see it as the agent's, through the API as usual.
  const files = (await api.call('GET', `/v1/workspaces/${launch.id}/files`, null, 'mem')).body.files
  const plan = files.find((f) => f.path === 'notes/plan.md')
  assert.ok(plan, JSON.stringify(files))
  assert.equal(plan.uploadedBy, `agent:${agent.id}`)

  // Up to 2 MB of base64 goes through both hops; a binary read answers a link.
  const big = Buffer.alloc(2 * 1024 * 1024, 7)
  const bin = await call('quilt_workspace_write_file', { workspace: launch.id, path: 'clip.bin', base64: big.toString('base64') })
  assert.equal(bin.isError, undefined, out(bin))
  const link = out(await call('quilt_workspace_read_file', { workspace: launch.id, path: 'clip.bin' }))
  const url = link.match(/https?:\/\/\S+/)?.[0]
  assert.ok(url, link)
  assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), big)
  const tooBig = await call('quilt_workspace_write_file', { workspace: launch.id, path: 'huge.txt', text: 'x'.repeat(2 * 1024 * 1024 + 1) })
  assert.equal(tooBig.isError, true)
  assert.match(out(tooBig), /too large to send in a call/)

  // The API's own refusals come back as the tool's error, word for word.
  const viewOnly = await call('quilt_workspace_write_file', { workspace: 'Archive', path: 'x.md', text: 'no' })
  assert.equal(viewOnly.isError, true)
  assert.match(out(viewOnly), /^Error: you can only view this workspace/)
  const missing = await call('quilt_workspace_files', { workspace: '11111111-1111-4111-8111-111111111111' })
  assert.equal(missing.isError, true)
  assert.match(out(missing), /no such workspace/)

  // Move, delete and the webhook (an API route the pass also reaches).
  assert.equal((await call('quilt_workspace_move_file', { workspace: 'Launch', path: 'notes/plan.md', to: 'notes/plan-v1.md' })).isError, undefined)
  assert.equal((await call('quilt_workspace_delete_file', { workspace: 'Launch', path: 'notes/plan-v1.md' })).isError, undefined)
  const off = await call('quilt_workspace_webhook_off')
  assert.equal(off.isError, undefined, out(off))

  // The pass is never written to the relay's log.
  assert.ok(!logs.some((l) => /QuiltPass|eyJ[A-Za-z0-9_-]{20,}\./.test(l)), logs.join('\n'))
})

test('a revoked agent loses the library at once: its next pass is refused', async () => {
  const { api, relay } = await stack()
  await relay.features.ready
  const { agent } = await makeAgent(api, { name: 'Soon gone', ownerUserId: 'mem' })
  // Its pass reaches the relay (as the API's /mcp would forward it), then the agent is revoked.
  const c = await viaRelay(relay, { sub: agent.id, name: 'Soon gone' })
  assert.ok((await names(c)).includes('quilt_workspaces'))
  assert.equal((await c.callTool({ name: 'quilt_workspaces', arguments: {} })).isError, undefined)
  await api.store.revokeAgent(agent.id)
  const r = await c.callTool({ name: 'quilt_workspaces', arguments: {} })
  assert.equal(r.isError, true)
  assert.match(out(r), /revoked/)
})

test('workspaces on: a person\'s pass on the relay gets no library tools', async () => {
  const { relay } = await stack()
  await relay.features.ready
  assert.deepEqual(await names(await viaRelay(relay, { kind: 'person', sub: 'mem', name: 'Mo' })), await baselineTools())
})

test('workspaces off: the hosted tool list is exactly as before', async () => {
  const { api, relay } = await stack({ workspaces: false })
  assert.equal(await relay.features.ready, false)
  const { accessKey } = await makeAgent(api, { name: 'Offline', ownerUserId: 'mem' })
  const c = await viaApi(api, accessKey)
  assert.deepEqual(await names(c), await baselineTools())
  assert.equal(c.getInstructions(), HOSTED_INSTRUCTIONS, 'no library guide without the library')
  await assert.rejects(c.callTool({ name: 'quilt_workspaces', arguments: {} }).then((r) => { if (r.isError) throw new Error(out(r)) }), /not found|quilt_workspaces/)
})

test('an API that cannot be reached: the relay starts at once, the tools stay out, and it closes cleanly', async () => {
  const dead = await freePort()
  const started = Date.now()
  const { relay } = await stack({ apiUrl: `http://127.0.0.1:${dead}` })
  assert.ok(Date.now() - started < 2000, 'start never waits on the probe')
  assert.equal(await relay.features.ready, false)
  assert.deepEqual(await names(await viaRelay(relay)), await baselineTools())
})

test('watchFeatures: off until the API says on, keeps the last answer through a failure, never throws', async () => {
  const answers = []
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'http://api.test/v1/features')
    assert.ok(init.signal, 'every probe has a timeout')
    const next = answers.shift()
    if (next instanceof Error) throw next
    return next
  }
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const logs = []
  answers.push(new Error('down'))
  const w = watchFeatures({ apiUrl: 'http://api.test/', fetch: fetchImpl, everyMs: 60 * 60 * 1000, log: (m) => logs.push(m) })
  try {
    assert.equal(await w.ready, false, 'a first failure is off')
    answers.push(json({ workspaces: true }))
    assert.equal(await w.probe(), true)
    answers.push(new Error('blip'))
    assert.equal(await w.probe(), true, 'a later failure keeps the last answer')
    answers.push(json({ error: 'boom' }, 503))
    assert.equal(await w.probe(), true, 'so does a server error')
    answers.push(new Response('not json', { status: 200 }))
    assert.equal(await w.probe(), true, 'and an answer that is not JSON')
    answers.push(json({ error: 'not found' }, 404))
    assert.equal(await w.probe(), false, 'an API without the route has no workspaces')
    answers.push(json({ workspaces: true }))
    assert.equal(await w.probe(), true)
    answers.push(json({ workspaces: false }))
    assert.equal(await w.probe(), false, 'the flag turned off')
    assert.deepEqual(logs, ['hosted agents: workspace tools on', 'hosted agents: workspace tools off', 'hosted agents: workspace tools on', 'hosted agents: workspace tools off'])
  } finally { w.stop() }

  // A probe that hangs is given up on (and stop() ends one in flight), so nothing holds the process open.
  const hung = watchFeatures({ apiUrl: 'http://api.test', fetch: (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))), timeoutMs: 50 })
  assert.equal(await hung.ready, false)
  const pending = hung.probe()
  hung.stop()
  assert.equal(await pending, false)
  // The repeat runs on its own and its timer never keeps the process alive.
  let calls = 0
  const ticking = watchFeatures({ apiUrl: 'http://api.test', fetch: async () => { calls++; return json({ workspaces: true }) }, everyMs: 20 })
  await new Promise((resolve) => setTimeout(resolve, 120))
  ticking.stop()
  const seen = calls
  assert.ok(seen >= 3, `probed ${seen} times`)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(calls, seen, 'stop() ends the repeat')
  // Until the API answers once (it may still be starting), it is asked again sooner; then only every everyMs.
  let tries = 0
  const early = watchFeatures({ apiUrl: 'http://api.test', fetch: async () => { if (++tries < 3) throw new Error('down'); return json({ workspaces: true }) }, everyMs: 60 * 60 * 1000, retryMs: 20 })
  assert.equal(await early.ready, false)
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(early.on(), true, 'on once the API answered')
  const after = tries
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(tries, after, 'no more early tries after an answer')
  early.stop()
})
