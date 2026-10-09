// `quilt workspace ...`: the library from a shell, run for real against a test API, as the
// person signed in on the computer and as an agent in its own folder.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startTestApi, API_URL, linkDevice } from './api-helpers.js'
import { agentJoin } from '../src/agent-join.js'
import { toolCall, WORKSPACE_USAGE } from '../src/workspace-cli.js'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'quilt.js')
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-wscli-${n}-`))
let t
before(async () => { t = await startTestApi({ workspaces: true }) })
after(() => t.close())

const quilt = (args, { home, cwd }) => new Promise((resolve) => {
  execFile(process.execPath, [BIN, 'workspace', ...args], { cwd, env: { ...process.env, HOME: home, USERPROFILE: home, QUILT_API_URL: t.api.url, QUILT_DIR: '' } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout, err: stderr }))
})

test('commands map to the library tools; anything else is the usage', () => {
  assert.deepEqual(toolCall('files', ['Launch', 'cuts', '--glob', '*.mp4']), ['quilt_workspace_files', { workspace: 'Launch', folder: 'cuts', glob: '*.mp4' }])
  assert.deepEqual(toolCall('put', ['Launch', 'a.png', './a.png', '--note=the logo']), ['quilt_workspace_write_file', { workspace: 'Launch', path: 'a.png', fromPath: './a.png', note: 'the logo' }])
  assert.deepEqual(toolCall('write', ['Launch', 'n.md', 'hello', 'there']), ['quilt_workspace_write_file', { workspace: 'Launch', path: 'n.md', text: 'hello there' }])
  assert.deepEqual(toolCall('get', ['Launch', 'n.md', '--version', '2']), ['quilt_workspace_read_file', { workspace: 'Launch', path: 'n.md', version: 2 }])
  assert.deepEqual(toolCall('mkdir', ['Launch', 'cuts/raw']), ['quilt_workspace_make_folder', { workspace: 'Launch', path: 'cuts/raw' }])
  assert.throws(() => toolCall('mv', ['Launch', 'a']), (e) => e.message === WORKSPACE_USAGE)
  assert.throws(() => toolCall('nope', []), (e) => e.message === WORKSPACE_USAGE)
  assert.throws(() => toolCall('put', ['W', 'a', 'b', '--note']), /--note needs a value/)
})

test('a signed-in person: list, mkdir, write, put, files, get, mv, rm', async () => {
  const home = tmp('home')
  const cwd = tmp('proj')
  const { token } = await linkDevice(t, 'mem')
  fs.mkdirSync(path.join(home, '.quilt'))
  fs.writeFileSync(path.join(home, '.quilt', 'account.json'), JSON.stringify({ token, account: { id: 'mem', name: 'Mo' } }))
  const ws = await t.store.createWorkspace({ ownerUserId: 'mem', name: 'Launch', createdBy: 'person:mem' })
  assert.match((await quilt(['list'], { home, cwd })).out, /Launch \(id /)
  assert.match((await quilt(['mkdir', 'Launch', 'cuts/raw'], { home, cwd })).out, /Made the folder cuts\/raw\//)
  assert.match((await quilt(['write', 'Launch', 'notes.md', 'hello', 'world', '--note', 'notes'], { home, cwd })).out, /Saved notes\.md in Launch/)
  fs.writeFileSync(path.join(cwd, 'logo.svg'), '<svg/>')
  const put = await quilt(['put', 'Launch', 'cuts/logo.svg', 'logo.svg'], { home, cwd })
  assert.equal(put.code, 0, put.err)
  const files = (await quilt(['files', 'Launch'], { home, cwd })).out
  for (const p of ['cuts/', 'cuts/raw/', 'cuts/logo.svg', 'notes.md  ']) assert.ok(files.includes(p), `${p} in\n${files}`)
  assert.match((await quilt(['get', 'Launch', 'notes.md'], { home, cwd })).out, /hello world/)
  assert.equal((await quilt(['mv', ws.id, 'notes.md', 'docs/notes.md'], { home, cwd })).code, 0)
  assert.equal((await quilt(['rm', 'Launch', 'cuts'], { home, cwd })).code, 0)
  assert.deepEqual((await t.store.listWorkspaceFiles(ws.id)).map((f) => f.path).sort(), ['docs', 'docs/notes.md'])
  const missing = await quilt(['get', 'Launch', 'nope.md'], { home, cwd })
  assert.equal(missing.code, 1)
  assert.match(missing.err, /No file at nope\.md in Launch/)
  const usage = await quilt([], { home, cwd })
  assert.match(usage.out, /quilt workspace put/)
})

test('an agent in its own folder acts as that agent, whatever else is saved here', async () => {
  const home = tmp('ahome')
  const join = async (who, name) => agentJoin({ link: (await t.call('POST', '/v1/agent-invites', {}, who)).body.link.replace(API_URL, t.api.url), name, dir: path.join(home, '.quilt'), log: () => {} })
  const larry = await join('mem', 'larry')
  await join('lim', 'other')
  const ws = await t.store.createWorkspace({ ownerUserId: 'mem', name: 'Agents', createdBy: 'person:mem' })
  await t.store.putWorkspaceMember({ workspaceId: ws.id, account: `agent:${larry.agentId}`, access: 'edit', addedBy: 'person:mem' })
  const cwd = tmp('acopy')
  fs.mkdirSync(path.join(cwd, '.quilt'))
  fs.writeFileSync(path.join(cwd, '.quilt', 'config.json'), JSON.stringify({ server: 'ws://x', room: 'r1', name: 'larry', kind: 'agent' }))
  const r = await quilt(['write', 'Agents', 'report.md', 'done'], { home, cwd })
  assert.equal(r.code, 0, r.err)
  assert.equal((await t.store.listWorkspaceFiles(ws.id))[0].uploadedBy, `agent:${larry.agentId}`)
  const nobody = await quilt(['list'], { home, cwd: tmp('elsewhere') })
  assert.equal(nobody.code, 1)
  assert.match(nobody.err, /Sign in to Quilt on this computer/)
})
