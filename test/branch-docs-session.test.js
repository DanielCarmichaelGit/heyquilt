// A session keeps two documents: the room's (chat, tasks, the feed, commit
// requests, activity) and its branch's (files and what goes with them). Each
// folder syncs the branch git is on, so folders on different branches never mix.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { generateIdentity } from '../src/identity.js'
import { sha1 } from '../src/fsutil.js'

let srv, server
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-bd-${n}-`))
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV }).trim()
async function waitFor (fn, ms = 8000) {
  const start = Date.now(); let last
  while (Date.now() - start < ms) { try { last = await fn(); if (last) return last } catch (e) { last = e }; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error(`timed out; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}
async function never (fn, ms = 1500) {
  const start = Date.now()
  while (Date.now() - start < ms) { assert.ok(!(await fn()), 'happened but must not'); await new Promise((r) => setTimeout(r, 25)) }
}
process.env.HOME = process.env.USERPROFILE = tmp('home')
const ids = new Map()
const identityOf = (n) => { if (!ids.has(n)) ids.set(n, generateIdentity()); return ids.get(n) }
const stopped = new Set()
const close = async (s) => { if (!stopped.has(s)) { stopped.add(s); await s.stop() } }
async function open (t, dir, name, extra) {
  const s = new Session({ dir, server, secret: 'pw', name, identity: identityOf(name), ...extra })
  t.after(() => close(s))
  await s.start({ waitTimeoutMs: 5000 })
  s.setAgentState({ tool: s.tool, status: 'idle' })
  return s
}
let rooms = 0
/** A remote with main and feature (feature changes README.md), and two clones on main. */
function clones () {
  const bare = tmp('bare'); git(bare, 'init', '-q', '--bare', '-b', 'main')
  const seed = tmp('seed'); git(seed, 'clone', '-q', bare, '.')
  write(seed, 'README.md', 'hello\n'); write(seed, 'src/app.js', 'app\n')
  git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'one'); git(seed, 'push', '-q', 'origin', 'main')
  git(seed, 'checkout', '-qb', 'feature'); write(seed, 'README.md', 'feature readme\n'); git(seed, 'commit', '-qam', 'f'); git(seed, 'push', '-q', 'origin', 'feature')
  const dirA = tmp('a'); git(dirA, 'clone', '-q', bare, '.')
  const dirB = tmp('b'); git(dirB, 'clone', '-q', bare, '.')
  return { dirA, dirB }
}

before(async () => { srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, maxNewRoomsPerHour: 0 }); server = `ws://127.0.0.1:${srv.port}` })
after(async () => { await srv.close() })

test('files live in the branch document; chat and activity in the room document', async (t) => {
  const { dirA } = clones()
  const room = `bd${++rooms}`
  const A = await open(t, dirA, 'alice', { room })
  assert.notEqual(A.bdoc, A.doc)
  assert.equal(A.files.doc, A.bdoc)
  assert.equal(A.chat.doc, A.doc)
  assert.equal(A.status().branch, 'main')
  write(dirA, 'src/app.js', 'edited\n')
  const r = srv.rooms.get(room)
  await waitFor(() => r.store.get('main')?.files.get('src/app.js')?.toString() === 'edited\n')
  assert.equal(r.doc.getMap('files').size, 0)
  await waitFor(() => r.doc.getArray('activity').toArray().some((x) => x.path === 'src/app.js'))
  A.say('hello everyone', { everyone: true })
  await waitFor(() => r.doc.getArray('chat').length === 1)
})

test('two folders on different branches at start never mix; chat reaches both', async (t) => {
  const { dirA, dirB } = clones()
  git(dirB, 'checkout', '-q', 'feature')
  const room = `bd${++rooms}`
  const A = await open(t, dirA, 'alice', { room })
  const B = await open(t, dirB, 'bob', { room })
  assert.equal(B.status().branch, 'feature')
  assert.equal(read(dirB, 'README.md'), 'feature readme\n')
  write(dirA, 'README.md', 'main work\n')
  write(dirB, 'src/app.js', 'feature work\n')
  await never(() => read(dirB, 'README.md') !== 'feature readme\n' || read(dirA, 'src/app.js') !== 'app\n', 2000)
  A.say('hi bob', { everyone: true })
  await waitFor(() => B.messages({ markRead: false }).some((m) => m.text === 'hi bob'))
})

test('local state: state.bin is the branch document, room.bin the room\'s, and state.json names the branch', async (t) => {
  const { dirA } = clones()
  const room = `bd${++rooms}`
  const A = await open(t, dirA, 'alice', { room })
  A.say('kept in the room', { everyone: true })
  await close(A)
  const state = JSON.parse(fs.readFileSync(path.join(dirA, '.quilt', 'state.json'), 'utf8'))
  assert.equal(state.layout, 2)
  assert.equal(state.branch, 'main')
  const bdoc = new Y.Doc(); Y.applyUpdate(bdoc, fs.readFileSync(path.join(dirA, '.quilt', 'state.bin')))
  assert.equal(bdoc.getMap('files').get('README.md').toString(), 'hello\n')
  const rdoc = new Y.Doc(); Y.applyUpdate(rdoc, fs.readFileSync(path.join(dirA, '.quilt', 'room.bin')))
  assert.ok(rdoc.getArray('chat').toArray().some((m) => m.text === 'kept in the room'))
})

test('a folder from before branch documents rejoins its old room: its offline edit merges into the default branch', async (t) => {
  const dataDir = tmp('legacy-relay')
  const relay = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: () => {}, maxNewRoomsPerHour: 0 })
  t.after(() => relay.close())
  const url = `ws://127.0.0.1:${relay.port}`
  const legacy = new Y.Doc()
  legacy.transact(() => { const y = new Y.Text(); y.insert(0, 'shared\n'); legacy.getMap('files').set('notes.txt', y) })
  legacy.getArray('chat').push([{ id: 'aaaaaaaaaaaaaaaa', by: 'carl', text: 'from before', ts: 1 }])
  fs.writeFileSync(path.join(dataDir, 'old-room.ydoc'), Y.encodeStateAsUpdate(legacy))
  fs.writeFileSync(path.join(dataDir, 'old-room.json'), JSON.stringify({ secretHash: crypto.createHash('sha256').update('pw').digest('hex'), createdAt: Date.now(), lastActive: Date.now() }))
  // The folder as an app from before saved it: the one document, no layout, and an edit made offline.
  const dir = tmp('legacy-folder')
  write(dir, 'notes.txt', 'shared\nedited offline\n')
  fs.mkdirSync(path.join(dir, '.quilt'))
  fs.writeFileSync(path.join(dir, '.quilt', 'state.bin'), Y.encodeStateAsUpdate(legacy))
  fs.writeFileSync(path.join(dir, '.quilt', 'state.json'), JSON.stringify({ room: 'old-room', server: url, storedOnDisk: {}, known: { 'notes.txt': sha1('shared\n') } }))
  const A = await open(t, dir, 'alice', { room: 'old-room', server: url })
  const r = relay.rooms.get('old-room')
  await waitFor(() => r.store.get(r.defaultKey)?.files.get('notes.txt')?.toString() === 'shared\nedited offline\n')
  assert.ok(A.messages({ markRead: false }).some((m) => m.text === 'from before'))
  const other = tmp('fresh')
  await open(t, other, 'bob', { room: 'old-room', server: url })
  await waitFor(() => read(other, 'notes.txt') === 'shared\nedited offline\n')
})
