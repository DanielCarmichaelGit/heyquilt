// The workspace library tools agents use (registerWorkspaceTools), driven end to end against
// a real test API with the flag on, through a fake MCP server that only collects the tools.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestApi, makeAgent } from './api-helpers.js'
import { registerWorkspaceTools, WORKSPACE_GUIDE, globMatch } from '../src/workspace-tools.js'

let t, ws, other, editor, viewer, saveDir

/** The `call` a host gives the tools: the agent's own key on every request. */
const caller = (key) => async (method, p, body) => {
  const res = await fetch(t.api.url + p, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw Object.assign(new Error(data?.error || `Quilt answered ${res.status}.`), { status: res.status })
  return data
}
const fetchBytes = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`download failed (${r.status})`); return Buffer.from(await r.arrayBuffer()) }
const put = async (url, bytes, headers) => (await fetch(url, { method: 'PUT', headers, body: bytes })).status

/** The tools as an MCP server would hold them: name -> handler. */
function collect (opts) {
  const tools = new Map()
  const server = { registerTool: (name, def, fn) => { tools.set(name, { def, fn }) } }
  registerWorkspaceTools(server, { fetchBytes, put, ...opts })
  const run = async (name, args = {}) => {
    const r = await tools.get(name).fn(args)
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError }
  }
  return { tools, run }
}

before(async () => {
  t = await startTestApi({ workspaces: true })
  ws = await t.store.createWorkspace({ ownerUserId: 'mem', name: 'Launch', createdBy: 'person:mem' })
  other = await t.store.createWorkspace({ ownerUserId: 'out', name: 'Elsewhere', createdBy: 'person:out' })
  editor = await makeAgent(t, { name: 'Larry', ownerUserId: 'mem' })
  await t.store.putAgentPlacement({ agentId: editor.agent.id, reach: 'all', access: 'edit', sessions: 'invited', updatedBy: 'person:mem' })
  viewer = await makeAgent(t, { name: 'Vee', ownerUserId: 'mem' })
  await t.store.putWorkspaceMember({ workspaceId: ws.id, account: `agent:${viewer.agent.id}`, access: 'view', addedBy: 'person:mem' })
  saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ws-tools-'))
})
after(() => t.close())

test('registers the eight library tools, each with a description', () => {
  const { tools } = collect({ call: caller(editor.accessKey) })
  assert.deepEqual([...tools.keys()].sort(), ['quilt_workspace_delete_file', 'quilt_workspace_files', 'quilt_workspace_move_file', 'quilt_workspace_read_file', 'quilt_workspace_webhook', 'quilt_workspace_webhook_off', 'quilt_workspace_write_file', 'quilt_workspaces'])
  for (const [name, { def }] of tools) {
    assert.ok(def.description && def.description.length > 20, name)
    assert.doesNotMatch(def.description, /—/, `${name}: no em dashes`)
  }
  assert.match(WORKSPACE_GUIDE, /quilt_workspace_read_file/)
  assert.match(WORKSPACE_GUIDE, /quilt_workspace_write_file/)
  assert.match(WORKSPACE_GUIDE, /quilt_workspace_webhook/)
  assert.doesNotMatch(WORKSPACE_GUIDE, /—/)
})

test('without fromPath support, write_file does not offer it', () => {
  const { tools } = collect({ call: caller(editor.accessKey) })
  assert.equal('fromPath' in tools.get('quilt_workspace_write_file').def.inputSchema, false)
  const local = collect({ call: caller(editor.accessKey), readLocal: async () => Buffer.from('') })
  assert.equal('fromPath' in local.tools.get('quilt_workspace_write_file').def.inputSchema, true)
})

test('write text, read it back, list, move, delete, by workspace name or id', async () => {
  const { run } = collect({ call: caller(editor.accessKey), saveDir })
  const list = await run('quilt_workspaces')
  assert.equal(list.isError, false, list.text)
  assert.match(list.text, /Launch/)
  assert.match(list.text, new RegExp(ws.id))
  assert.match(list.text, /edit/)
  assert.doesNotMatch(list.text, /Elsewhere/, 'only workspaces the agent reaches')

  const wrote = await run('quilt_workspace_write_file', { workspace: 'Launch', path: 'notes/plan.md', text: '# Plan\nShip it.\n', note: 'first draft' })
  assert.equal(wrote.isError, false, wrote.text)
  assert.match(wrote.text, /notes\/plan\.md/)
  assert.match(wrote.text, /version 1/)

  const read = await run('quilt_workspace_read_file', { workspace: ws.id, path: 'notes/plan.md' })
  assert.equal(read.isError, false, read.text)
  assert.match(read.text, /# Plan\nShip it\./)

  const again = await run('quilt_workspace_write_file', { workspace: 'launch', path: 'notes/plan.md', text: '# Plan v2\n' })
  assert.match(again.text, /version 2/)
  const old = await run('quilt_workspace_read_file', { workspace: 'Launch', path: 'notes/plan.md', version: 1 })
  assert.match(old.text, /Ship it\./)

  const files = await run('quilt_workspace_files', { workspace: 'Launch' })
  assert.match(files.text, /notes\/plan\.md/)
  assert.match(files.text, /Larry/, 'the uploader by name')
  assert.match(files.text, /v2/)
  const globbed = await run('quilt_workspace_files', { workspace: 'Launch', glob: '**/*.png' })
  assert.doesNotMatch(globbed.text, /plan\.md/)
  const inFolder = await run('quilt_workspace_files', { workspace: 'Launch', folder: 'notes' })
  assert.match(inFolder.text, /plan\.md/)

  const moved = await run('quilt_workspace_move_file', { workspace: 'Launch', path: 'notes/plan.md', to: 'done/plan.md' })
  assert.equal(moved.isError, false, moved.text)
  assert.match(moved.text, /done\/plan\.md/)
  assert.match((await run('quilt_workspace_read_file', { workspace: 'Launch', path: 'done/plan.md' })).text, /Plan v2/)

  const gone = await run('quilt_workspace_delete_file', { workspace: 'Launch', path: 'done/plan.md' })
  assert.equal(gone.isError, false, gone.text)
  const missing = await run('quilt_workspace_read_file', { workspace: 'Launch', path: 'done/plan.md' })
  assert.equal(missing.isError, true)
  assert.match(missing.text, /No file at done\/plan\.md/)
})

test('a binary read answers a link, and saves a copy when it can', async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])
  const plain = collect({ call: caller(editor.accessKey) })
  const wrote = await plain.run('quilt_workspace_write_file', { workspace: 'Launch', path: 'art/logo.png', base64: bytes.toString('base64') })
  assert.equal(wrote.isError, false, wrote.text)
  const hosted = await plain.run('quilt_workspace_read_file', { workspace: 'Launch', path: 'art/logo.png' })
  assert.equal(hosted.isError, false, hosted.text)
  assert.match(hosted.text, /https?:\/\/\S+\/v1\/file-data\//)
  assert.match(hosted.text, /expires/i)
  assert.doesNotMatch(hosted.text, /savedTo/)

  const local = collect({ call: caller(editor.accessKey), saveDir })
  const saved = await local.run('quilt_workspace_read_file', { workspace: 'Launch', path: 'art/logo.png' })
  const file = path.join(saveDir, ws.id, 'art', 'logo.png')
  assert.match(saved.text, new RegExp(`savedTo: ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.deepEqual(fs.readFileSync(file), bytes)

  // A text file over the inline limit comes back as a link too.
  const small = collect({ call: caller(editor.accessKey), maxInline: 10 })
  const big = await small.run('quilt_workspace_write_file', { workspace: 'Launch', path: 'big.txt', text: 'x'.repeat(11) })
  assert.equal(big.isError, true)
  assert.match(big.text, /too large/i)
  await plain.run('quilt_workspace_write_file', { workspace: 'Launch', path: 'big.txt', text: 'x'.repeat(11) })
  assert.match((await small.run('quilt_workspace_read_file', { workspace: 'Launch', path: 'big.txt' })).text, /file-data/)
})

test('fromPath reads a local file through readLocal; exactly one source', async () => {
  const src = path.join(saveDir, 'clip.bin')
  fs.writeFileSync(src, Buffer.from('local bytes'))
  const asked = []
  const { run } = collect({ call: caller(editor.accessKey), readLocal: async (p) => { asked.push(p); return fs.promises.readFile(p) } })
  const wrote = await run('quilt_workspace_write_file', { workspace: 'Launch', path: 'clips/clip.bin', fromPath: src, note: 'from disk' })
  assert.equal(wrote.isError, false, wrote.text)
  assert.deepEqual(asked, [src])
  const none = await run('quilt_workspace_write_file', { workspace: 'Launch', path: 'x.txt' })
  assert.equal(none.isError, true)
  assert.match(none.text, /exactly one/)
  const two = await run('quilt_workspace_write_file', { workspace: 'Launch', path: 'x.txt', text: 'a', base64: 'YQ==' })
  assert.equal(two.isError, true)
  const hosted = collect({ call: caller(editor.accessKey) })
  const noLocal = await hosted.run('quilt_workspace_write_file', { workspace: 'Launch', path: 'x.txt', fromPath: src })
  assert.equal(noLocal.isError, true)
  assert.match(noLocal.text, /fromPath/)
})

test('a viewer reads but its write answers the API\'s refusal; strangers get not found', async () => {
  const { run } = collect({ call: caller(viewer.accessKey) })
  const list = await run('quilt_workspaces')
  assert.match(list.text, /Launch/)
  assert.match(list.text, /view/)
  const w = await run('quilt_workspace_write_file', { workspace: 'Launch', path: 'v.txt', text: 'nope' })
  assert.equal(w.isError, true)
  assert.match(w.text, /you can only view this workspace/)
  const unknown = await run('quilt_workspace_files', { workspace: other.id })
  assert.equal(unknown.isError, true)
  assert.match(unknown.text, /no such workspace|No workspace/i)
  const byName = await run('quilt_workspace_files', { workspace: 'Elsewhere' })
  assert.equal(byName.isError, true)
  assert.match(byName.text, /No workspace/)
})

test('the agent webhook: on answers the secret once, off removes it', async () => {
  const { run } = collect({ call: caller(editor.accessKey) })
  const on = await run('quilt_workspace_webhook', { url: 'https://hooks.example.com/quilt' })
  assert.equal(on.isError, false, on.text)
  assert.match(on.text, /session\.started/)
  const hook = await t.store.agentWebhook(editor.agent.id)
  assert.ok(hook.secret && on.text.includes(hook.secret))
  const bad = await run('quilt_workspace_webhook', { url: 'ftp://nope' })
  assert.equal(bad.isError, true)
  const off = await run('quilt_workspace_webhook_off')
  assert.equal(off.isError, false, off.text)
  assert.equal(await t.store.agentWebhook(editor.agent.id), null)
})

test('globMatch: * stays in a folder, ** crosses folders', () => {
  assert.equal(globMatch('*.md', 'a.md'), true)
  assert.equal(globMatch('*.md', 'notes/a.md'), false)
  assert.equal(globMatch('**/*.md', 'notes/deep/a.md'), true)
  assert.equal(globMatch('**/*.md', 'a.md'), true)
  assert.equal(globMatch('notes/**', 'notes/deep/a.md'), true)
  assert.equal(globMatch('notes/*', 'notes/deep/a.md'), false)
  assert.equal(globMatch('a.b', 'axb'), false, 'dots are literal')
})
