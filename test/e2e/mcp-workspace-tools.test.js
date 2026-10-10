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
import { startTestApi, API_URL, linkDevice } from '../helpers/api-helpers.js'
import { agentJoin } from '../../src/agent-join.js'
import { WORKSPACE_GUIDE } from '../../src/workspace-tools.js'
import { agentAnnouncer } from '../../src/mcp.js'
import { announceWhenReported } from '../../src/account.js'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'quilt.js')
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-mcpws-${n}-`))
const WS_TOOLS = ['quilt_workspace_delete_file', 'quilt_workspace_files', 'quilt_workspace_make_folder', 'quilt_workspace_move_file', 'quilt_workspace_read_file', 'quilt_workspace_webhook', 'quilt_workspace_webhook_off', 'quilt_workspace_write_file', 'quilt_workspaces']
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
async function startMcp ({ home, apiUrl, env = {} }) {
  const cwd = tmp('cwd')
  const client = new Client({ name: 'claude-code', version: '1.0.0' })
  const changes = []
  client.setNotificationHandler(ToolListChangedNotificationSchema, (n) => { changes.push(n) })
  const started = Date.now()
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], cwd, env: { ...process.env, HOME: home, QUILT_API_URL: apiUrl, ...env }, stderr: 'ignore' }))
  clients.push(client)
  return { client, changes, cwd, connectMs: Date.now() - started }
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

let baseline, instructions
test('flag off: the tool list is the one without workspaces', async () => {
  const { home } = await homeWithAgent(off)
  const { client } = await startMcp({ home, apiUrl: off.api.url })
  await sleep(500) // past the probe's answer
  baseline = await names(client)
  assert.ok(baseline.includes('quilt_status'))
  for (const n of WS_TOOLS) assert.equal(baseline.includes(n), false, n)
  // No library guide anywhere: not in the instructions, not in any tool.
  instructions = client.getInstructions()
  assert.ok(!instructions.includes(WORKSPACE_GUIDE))
  for (const t of (await client.listTools()).tools) assert.ok(!String(t.description).includes(WORKSPACE_GUIDE), t.name)
})

test('flag on with an agent: the nine tools appear, and work over MCP', async () => {
  const { home, saved } = await homeWithAgent(on)
  const ws = await on.store.createWorkspace({ ownerUserId: 'mem', name: 'Launch', createdBy: 'person:mem' })
  await on.store.putAgentPlacement({ agentId: saved.agentId, reach: 'all', access: 'edit', sessions: 'invited', updatedBy: 'person:mem' })
  // Its own temp folder, so the test's temp folder counts as elsewhere on this computer.
  const childTmp = tmp('childtmp')
  const { client, changes, cwd } = await startMcp({ home, apiUrl: on.api.url, env: { TMPDIR: childTmp } })
  await waitFor(() => changes.length > 0)
  const listed = await names(client)
  assert.deepEqual(listed, [...baseline, ...WS_TOOLS].sort(), 'the same tools plus the library tools')

  const list = await client.callTool({ name: 'quilt_workspaces', arguments: {} })
  assert.equal(list.isError, undefined, text(list))
  assert.match(text(list), /Launch/)
  // The tools arrive after the instructions were sent, so the guide comes with quilt_workspaces:
  // in its description and at the top of its answer. The instructions are as before.
  assert.equal(client.getInstructions(), instructions)
  const desc = (await client.listTools()).tools.find((t) => t.name === 'quilt_workspaces').description
  assert.ok(desc.includes(WORKSPACE_GUIDE), desc)
  assert.ok(text(list).startsWith(WORKSPACE_GUIDE), text(list))
  const wrote = await client.callTool({ name: 'quilt_workspace_write_file', arguments: { workspace: 'Launch', path: 'brief.md', text: 'hello from the agent', note: 'brief' } })
  assert.equal(wrote.isError, undefined, text(wrote))
  const read = await client.callTool({ name: 'quilt_workspace_read_file', arguments: { workspace: ws.id, path: 'brief.md' } })
  assert.match(text(read), /hello from the agent/)
  // fromPath reads from the project (a relative path is the project's) or the temp folder.
  fs.writeFileSync(path.join(cwd, 'clip.bin'), Buffer.from([1, 2, 3, 4]))
  const fromDisk = await client.callTool({ name: 'quilt_workspace_write_file', arguments: { workspace: 'Launch', path: 'clip.bin', fromPath: 'clip.bin' } })
  assert.equal(fromDisk.isError, undefined, text(fromDisk))
  fs.writeFileSync(path.join(childTmp, 'render.txt'), 'rendered')
  const fromTmp = await client.callTool({ name: 'quilt_workspace_write_file', arguments: { workspace: 'Launch', path: 'render.txt', fromPath: path.join(childTmp, 'render.txt') } })
  assert.equal(fromTmp.isError, undefined, text(fromTmp))
  // Anywhere else (like ~/.ssh) is refused, even through a symlink in the project.
  const ssh = path.join(home, '.ssh')
  fs.mkdirSync(ssh)
  fs.writeFileSync(path.join(ssh, 'id_ed25519'), 'PRIVATE KEY')
  const outside = await client.callTool({ name: 'quilt_workspace_write_file', arguments: { workspace: 'Launch', path: 'id', fromPath: path.join(ssh, 'id_ed25519') } })
  assert.equal(outside.isError, true)
  assert.match(text(outside), /outside this project\. Copy it into the project folder first/)
  fs.symlinkSync(ssh, path.join(cwd, 'keys'))
  const linked = await client.callTool({ name: 'quilt_workspace_write_file', arguments: { workspace: 'Launch', path: 'id', fromPath: 'keys/id_ed25519' } })
  assert.equal(linked.isError, true)
  assert.match(text(linked), /outside this project/)
  fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=1')
  assert.equal((await client.callTool({ name: 'quilt_workspace_write_file', arguments: { workspace: 'Launch', path: 'env', fromPath: '.env' } })).isError, true)
  // Binary reads are saved under ~/.quilt/workspaces/<workspace id>/.
  const bin = await client.callTool({ name: 'quilt_workspace_read_file', arguments: { workspace: 'Launch', path: 'clip.bin' } })
  const savedTo = path.join(home, '.quilt', 'workspaces', ws.id, 'clip.bin')
  assert.ok(text(bin).includes(savedTo), text(bin))
  assert.deepEqual([...fs.readFileSync(savedTo)], [1, 2, 3, 4])
  // The agent's own keys are never sent to the library.
  const keys = await client.callTool({ name: 'quilt_workspace_write_file', arguments: { workspace: 'Launch', path: 'keys.json', fromPath: path.join(home, '.quilt', 'agents', 'helper.json') } })
  assert.equal(keys.isError, true)
  assert.match(text(keys), /outside this project/)
})

test('flag on, but no agent on this computer: nothing new', async () => {
  const { client, changes } = await startMcp({ home: tmp('empty'), apiUrl: on.api.url })
  await sleep(500)
  assert.deepEqual(await names(client), baseline)
  assert.equal(changes.length, 0, 'the client is never told the list changed')
})

/** Signs `userId` in on the computer whose home is `home`, as the app does. */
async function signIn (api, home, userId) {
  const { token } = await linkDevice(api, userId)
  fs.mkdirSync(path.join(home, '.quilt'), { recursive: true })
  fs.writeFileSync(path.join(home, '.quilt', 'account.json'), JSON.stringify({ token, account: { id: userId, name: 'Mo' }, signedInAt: Date.now() }), { mode: 0o600 })
}

test('no agent, but a person signed in: their AI gets the library, as them, and makes folders', async () => {
  const home = tmp('person')
  await signIn(on, home, 'mem')
  const ws = await on.store.createWorkspace({ ownerUserId: 'mem', name: 'Mine', createdBy: 'person:mem' })
  const { client, changes } = await startMcp({ home, apiUrl: on.api.url })
  await waitFor(() => changes.length > 0)
  assert.deepEqual(await names(client), [...baseline, ...WS_TOOLS].sort())
  assert.match(text(await client.callTool({ name: 'quilt_workspaces', arguments: {} })), /Mine/)
  const made = await client.callTool({ name: 'quilt_workspace_make_folder', arguments: { workspace: 'Mine', path: 'cuts/raw' } })
  assert.equal(made.isError, undefined, text(made))
  assert.match(text(made), /Made the folder cuts\/raw\/ in Mine/)
  const wrote = await client.callTool({ name: 'quilt_workspace_write_file', arguments: { workspace: 'Mine', path: 'cuts/raw/notes.md', text: 'by the AI' } })
  assert.equal(wrote.isError, undefined, text(wrote))
  const files = (await on.store.listWorkspaceFiles(ws.id)).map((f) => [f.path, f.kind, f.uploadedBy])
  assert.deepEqual(files.sort(), [['cuts', 'folder', 'person:mem'], ['cuts/raw', 'folder', 'person:mem'], ['cuts/raw/notes.md', 'file', 'person:mem']])
})

test('several agents on this computer: an agent folder acts as its agent; elsewhere the signed-in person', async () => {
  const { home, saved } = await homeWithAgent(on)
  // A second agent, so "the only agent" no longer decides.
  const link = (await on.call('POST', '/v1/agent-invites', {}, 'lim')).body.link.replace(API_URL, on.api.url)
  await agentJoin({ link, name: 'other', dir: path.join(home, '.quilt'), log: () => {} })
  const ws = await on.store.createWorkspace({ ownerUserId: 'mem', name: 'Shared', createdBy: 'person:mem' })
  await on.store.putWorkspaceMember({ workspaceId: ws.id, account: `agent:${saved.agentId}`, access: 'edit', addedBy: 'person:mem' })
  // Nobody to act as: no agent folder, nobody signed in.
  const none = await startMcp({ home, apiUrl: on.api.url })
  await sleep(500)
  assert.deepEqual(await names(none.client), baseline)

  // The agent's own copy of a session: its config names it.
  const agentDir = tmp('agentdir')
  fs.mkdirSync(path.join(agentDir, '.quilt'))
  fs.writeFileSync(path.join(agentDir, '.quilt', 'config.json'), JSON.stringify({ server: 'ws://x', room: 'r1', name: 'helper', kind: 'agent' }))
  const asAgent = new Client({ name: 'cursor', version: '1.0.0' })
  const changes = []
  asAgent.setNotificationHandler(ToolListChangedNotificationSchema, (n) => { changes.push(n) })
  await asAgent.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], cwd: agentDir, env: { ...process.env, HOME: home, QUILT_API_URL: on.api.url }, stderr: 'ignore' }))
  clients.push(asAgent)
  await waitFor(() => changes.length > 0)
  const wrote = await asAgent.callTool({ name: 'quilt_workspace_write_file', arguments: { workspace: 'Shared', path: 'from-helper.md', text: 'hi' } })
  assert.equal(wrote.isError, undefined, text(wrote))
  assert.equal((await on.store.listWorkspaceFiles(ws.id)).find((f) => f.path === 'from-helper.md').uploadedBy, `agent:${saved.agentId}`)

  // Signed in, outside any agent folder: the person.
  await signIn(on, home, 'mem')
  const person = await startMcp({ home, apiUrl: on.api.url })
  await waitFor(() => person.changes.length > 0)
  assert.match(text(await person.client.callTool({ name: 'quilt_workspaces', arguments: {} })), /Shared/)
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

test('fromPath never sends ~/.quilt, even when the project is the home folder', async () => {
  const { readLocalFile } = await import('../../src/mcp.js')
  const home = tmp('ownhome')
  fs.mkdirSync(path.join(home, '.quilt', 'agents'), { recursive: true })
  fs.writeFileSync(path.join(home, '.quilt', 'agents', 'k.json'), '{}')
  fs.writeFileSync(path.join(home, '..notes.md'), 'a name, not a way out')
  const was = process.env.HOME
  process.env.HOME = home
  try {
    await assert.rejects(readLocalFile(path.join(home, '.quilt', 'agents', 'k.json'), [home]), /Quilt's own files/)
    assert.equal(String(await readLocalFile('..notes.md', [home])), 'a name, not a way out')
  } finally {
    process.env.HOME = was
  }
})

test('an agent\'s session.started hand-off reads its access key afresh on every try, so a retry never sends one that ran out', async () => {
  let n = 0
  const access = async ({ name }) => ({ accessKey: `qa_key${++n}`, api: `https://api.example/${name}` })
  const sent = []
  const announce = async (o) => {
    sent.push([o.token, o.api, o.id, o.room, o.link])
    if (sent.length < 3) throw Object.assign(new Error('not yet'), { status: 409 })
    return { notified: [], withoutWebhook: [] }
  }
  const fn = agentAnnouncer({ name: 'starter', workspace: 'w1', room: 'r1', link: 'https://join.heyquilt.com/r1#s', access, announce })
  const r = await announceWhenReported(fn, { delays: [0, 0, 0], sleep: async () => {} })
  assert.deepEqual(r, { notified: [], withoutWebhook: [] })
  assert.deepEqual(sent.map((x) => x[0]), ['qa_key1', 'qa_key2', 'qa_key3'])
  assert.deepEqual(sent[0].slice(1), ['https://api.example/starter', 'w1', 'r1', 'https://join.heyquilt.com/r1#s'])
})
