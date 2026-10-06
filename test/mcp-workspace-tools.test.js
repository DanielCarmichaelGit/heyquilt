// The local MCP (`quilt mcp`, run for real over stdio) offers the workspace library tools only
// when the agent's API says workspaces are on and this computer has an agent identity. Off,
// unreachable, slow or without an agent, its tool list is exactly what it was before.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { startTestApi, API_URL } from './api-helpers.js'
import { agentJoin } from '../src/agent-join.js'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'quilt.js')
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-mcpws-${n}-`))
const WS_TOOLS = ['quilt_workspace_delete_file', 'quilt_workspace_files', 'quilt_workspace_move_file', 'quilt_workspace_read_file', 'quilt_workspace_webhook', 'quilt_workspace_webhook_off', 'quilt_workspace_write_file', 'quilt_workspaces']
const text = (r) => r.content.map((c) => c.text).join('\n')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor (fn, ms = 8000) {
  const t = Date.now()
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(50) }
  throw new Error('timed out')
}

let on, off, hang
const clients = []

/** A HOME with one agent joined through `api` (its saved keys name that API). */
async function homeWithAgent (api) {
  const home = tmp('home')
  const link = (await api.call('POST', '/v1/agent-invites', {}, 'mem')).body.link.replace(API_URL, api.api.url)
  const saved = await agentJoin({ link, name: 'helper', dir: path.join(home, '.quilt'), log: () => {} })
  return { home, saved }
}

/** Starts `quilt mcp` with HOME and QUILT_API_URL, and connects an MCP client to it. */
async function startMcp ({ home, apiUrl }) {
  const client = new Client({ name: 'claude-code', version: '1.0.0' })
  const changes = []
  client.setNotificationHandler(ToolListChangedNotificationSchema, (n) => { changes.push(n) })
  const started = Date.now()
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], cwd: tmp('cwd'), env: { ...process.env, HOME: home, QUILT_API_URL: apiUrl }, stderr: 'ignore' }))
  clients.push(client)
  return { client, changes, connectMs: Date.now() - started }
}
const names = async (client) => (await client.listTools()).tools.map((t) => t.name).sort()

before(async () => {
  on = await startTestApi({ workspaces: true })
  off = await startTestApi({ workspaces: false })
  // An API that never answers: the probe must give up on its own, without holding anything up.
  hang = http.createServer(() => {})
  await new Promise((resolve) => hang.listen(0, '127.0.0.1', resolve))
})
after(async () => {
  for (const c of clients) await c.close().catch(() => {})
  hang.closeAllConnections?.()
  hang.close()
  await on.close()
  await off.close()
})

let baseline
test('flag off: the tool list is the one without workspaces', async () => {
  const { home } = await homeWithAgent(off)
  const { client } = await startMcp({ home, apiUrl: off.api.url })
  await sleep(500) // past the probe's answer
  baseline = await names(client)
  assert.ok(baseline.includes('quilt_status'))
  for (const n of WS_TOOLS) assert.equal(baseline.includes(n), false, n)
})

test('flag on with an agent: the eight tools appear, and work over MCP', async () => {
  const { home, saved } = await homeWithAgent(on)
  const ws = await on.store.createWorkspace({ ownerUserId: 'mem', name: 'Launch', createdBy: 'person:mem' })
  await on.store.putAgentPlacement({ agentId: saved.agentId, reach: 'all', access: 'edit', sessions: 'invited', updatedBy: 'person:mem' })
  const { client, changes } = await startMcp({ home, apiUrl: on.api.url })
  await waitFor(() => changes.length > 0)
  const listed = await names(client)
  assert.deepEqual(listed, [...baseline, ...WS_TOOLS].sort(), 'the same tools plus the library tools')

  const list = await client.callTool({ name: 'quilt_workspaces', arguments: {} })
  assert.equal(list.isError, undefined, text(list))
  assert.match(text(list), /Launch/)
  const wrote = await client.callTool({ name: 'quilt_workspace_write_file', arguments: { workspace: 'Launch', path: 'brief.md', text: 'hello from the agent', note: 'brief' } })
  assert.equal(wrote.isError, undefined, text(wrote))
  const read = await client.callTool({ name: 'quilt_workspace_read_file', arguments: { workspace: ws.id, path: 'brief.md' } })
  assert.match(text(read), /hello from the agent/)
  // fromPath reads from this computer.
  const src = path.join(tmp('src'), 'clip.bin')
  fs.writeFileSync(src, Buffer.from([1, 2, 3, 4]))
  const fromDisk = await client.callTool({ name: 'quilt_workspace_write_file', arguments: { workspace: 'Launch', path: 'clip.bin', fromPath: src } })
  assert.equal(fromDisk.isError, undefined, text(fromDisk))
  // Binary reads are saved under ~/.quilt/workspaces/<workspace id>/.
  const bin = await client.callTool({ name: 'quilt_workspace_read_file', arguments: { workspace: 'Launch', path: 'clip.bin' } })
  const savedTo = path.join(home, '.quilt', 'workspaces', ws.id, 'clip.bin')
  assert.ok(text(bin).includes(savedTo), text(bin))
  assert.deepEqual([...fs.readFileSync(savedTo)], [1, 2, 3, 4])
  // The agent's own keys are never sent to the library.
  const keys = await client.callTool({ name: 'quilt_workspace_write_file', arguments: { workspace: 'Launch', path: 'keys.json', fromPath: path.join(home, '.quilt', 'agents', 'helper.json') } })
  assert.equal(keys.isError, true)
})

test('flag on, but no agent on this computer: nothing new', async () => {
  const { client, changes } = await startMcp({ home: tmp('empty'), apiUrl: on.api.url })
  await sleep(500)
  assert.deepEqual(await names(client), baseline)
  assert.equal(changes.length, 0, 'the client is never told the list changed')
})

test('an API that never answers neither delays startup nor adds tools', async () => {
  const { home, saved } = await homeWithAgent(off)
  // Point the agent's saved keys at the silent API.
  const file = path.join(home, '.quilt', 'agents', 'helper.json')
  const hangUrl = `http://127.0.0.1:${hang.address().port}`
  fs.writeFileSync(file, JSON.stringify({ ...saved, api: hangUrl }), { mode: 0o600 })
  const { client, connectMs } = await startMcp({ home, apiUrl: hangUrl })
  assert.ok(connectMs < 2000, `connected in ${connectMs}ms`)
  assert.deepEqual(await names(client), baseline)
  await sleep(2300) // past the probe's 2-second timeout
  assert.deepEqual(await names(client), baseline)
  assert.match(text(await client.callTool({ name: 'quilt_status', arguments: {} })), /quilt_join_session/, 'still answers')
})

test('an unreachable API adds nothing', async () => {
  const { home, saved } = await homeWithAgent(off)
  const file = path.join(home, '.quilt', 'agents', 'helper.json')
  fs.writeFileSync(file, JSON.stringify({ ...saved, api: 'http://127.0.0.1:9' }), { mode: 0o600 })
  const { client } = await startMcp({ home, apiUrl: 'http://127.0.0.1:9' })
  await sleep(500)
  assert.deepEqual(await names(client), baseline)
})
