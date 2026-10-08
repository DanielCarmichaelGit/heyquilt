// Branch documents on the relay: a connection syncs the room's document and
// the one branch it joined; branches are kept apart, saved and reloaded, and a
// key that isn't a branch name is refused.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { startServer } from '../src/server.js'
import { Connection, REMOTE } from '../src/connection.js'
import { generateIdentity } from '../src/identity.js'
import { validBranchKey, branchFileName, covers, MAX_BRANCHES } from '../src/branchdocs.js'

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-rb-${n}-`))
const quiet = () => {}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor (fn, ms = 5000) {
  const t = Date.now()
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await wait(25) }
  throw new Error('timed out')
}
// Sessions without an identity create one in ~/.quilt; keep that out of the real home.
process.env.HOME = process.env.USERPROFILE = tmp('home')

/** An app on `key` (no branch when null): its room document, its branch document and its connection. */
function open (t, srv, room, name, key, extra = {}) {
  const doc = new Y.Doc()
  const bdoc = new Y.Doc()
  const c = new Connection({
    server: `ws://127.0.0.1:${srv.port}`, room, secret: 's', name, identity: extra.identity || generateIdentity(), doc,
    ...(key ? { branch: { key, doc: bdoc, ...(extra.adopt ? { adopt: extra.adopt } : {}) } } : {}),
    ...(extra.conn || {})
  })
  t.after(() => { if (!c.closed) c.close() })
  return { c, doc, bdoc }
}
const text = (doc, rel) => doc.getMap('files').get(rel)?.toString()
const put = (doc, rel, s) => doc.transact(() => { const y = new Y.Text(); y.insert(0, s); doc.getMap('files').set(rel, y) })

test('branch keys are git branch names, a detached commit or ∅, and their files are safe names', () => {
  for (const ok of ['main', 'feature/x', 'fix-1.2', '∅', '@0123456789ab', 'ünïcode']) assert.equal(validBranchKey(ok), true, ok)
  for (const bad of ['', '-x', 'a b', 'a:b', 'a/', '/a', '.a', 'a/.b', 'a.lock', 'a..b', 'a//b', 'HEAD', '@', 'a@{1}', 'a.', 'x'.repeat(201), 'tab\there']) assert.equal(validBranchKey(bad), false, bad)
  assert.equal(branchFileName('feature/x'), `${Buffer.from('feature/x').toString('base64url')}.ydoc`)
  const a = new Y.Doc(); a.getText('t').insert(0, 'x')
  const b = new Y.Doc(); Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  assert.equal(covers(Y.encodeStateVector(b), Y.encodeStateVector(a)), true)
  a.getText('t').insert(0, 'y')
  assert.equal(covers(Y.encodeStateVector(b), Y.encodeStateVector(a)), false)
})

test('two apps on one branch share its files; an app on another branch never sees them; the room document is shared by all', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  t.after(() => srv.close())
  const a = open(t, srv, 'rb1', 'a', 'main')
  const b = open(t, srv, 'rb1', 'b', 'main')
  const f = open(t, srv, 'rb1', 'f', 'feature-x')
  await Promise.all([a.c.waitForSync(), b.c.waitForSync(), f.c.waitForSync()])
  put(a.bdoc, 'app.js', 'main\n')
  put(f.bdoc, 'app.js', 'feature\n')
  await waitFor(() => text(b.bdoc, 'app.js') === 'main\n')
  await wait(300)
  assert.equal(text(f.bdoc, 'app.js'), 'feature\n')
  assert.equal(text(a.bdoc, 'app.js'), 'main\n')
  const room = srv.rooms.get('rb1')
  assert.equal(room.doc.getMap('files').size, 0, 'files are not in the room document')
  a.doc.getArray('chat').push([{ text: 'hi' }])
  await waitFor(() => f.doc.getArray('chat').length === 1)
  assert.deepEqual(room.branchList().map((x) => x.key).sort(), ['feature-x', 'main'])
  assert.equal(room.defaultKey, 'main', 'the first branch anyone joined')
  let heard = null
  b.c.on('branches', (list) => { heard = list })
  open(t, srv, 'rb1', 'g', 'third')
  await waitFor(() => heard && heard.some((x) => x.key === 'third'))
})

test('joining another branch leaves the first: one branch at a time', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  t.after(() => srv.close())
  const a = open(t, srv, 'rb2', 'a', 'main')
  const b = open(t, srv, 'rb2', 'b', 'main')
  await Promise.all([a.c.waitForSync(), b.c.waitForSync()])
  const other = new Y.Doc()
  const r = await a.c.joinBranch('feature-x', other)
  assert.equal(r.branch, 'feature-x')
  assert.equal(r.created, true)
  await a.c.waitForBranchSync()
  assert.equal(a.c.branchKey, 'feature-x')
  put(b.bdoc, 'x.txt', 'main only\n')
  await wait(300)
  assert.equal(text(other, 'x.txt'), undefined)
  assert.equal(text(a.bdoc, 'x.txt'), undefined, 'the branch it left gets nothing more')
  put(other, 'y.txt', 'feature\n')
  await waitFor(() => text(srv.rooms.get('rb2').store.get('feature-x').doc, 'y.txt') === 'feature\n')
})

test('confirm says whether the relay holds every change the app has on its branch', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  t.after(() => srv.close())
  const a = open(t, srv, 'rb3', 'a', 'main')
  await a.c.waitForSync()
  put(a.bdoc, 'a.txt', 'x\n')
  await a.c.confirmBranch()
  // A change the connection never sent (applied as if it came from the relay).
  const elsewhere = new Y.Doc()
  put(elsewhere, 'b.txt', 'y\n')
  Y.applyUpdate(a.bdoc, Y.encodeStateAsUpdate(elsewhere), REMOTE)
  await assert.rejects(a.c.confirmBranch(), /not all of your changes on main have reached the relay yet/)
})

test('branch documents are saved and come back after the relay restarts', async (t) => {
  const dataDir = tmp('saved')
  let srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir })
  const a = open(t, srv, 'rb4', 'a', 'feature/x')
  await a.c.waitForSync()
  put(a.bdoc, 'saved.txt', 'kept\n')
  const file = path.join(dataDir, 'branches', 'rb4', branchFileName('feature/x'))
  await waitFor(() => fs.existsSync(file))
  a.c.close()
  await srv.close()
  srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir })
  t.after(() => srv.close())
  const b = open(t, srv, 'rb4', 'b', 'feature/x')
  await b.c.waitForSync()
  assert.equal(text(b.bdoc, 'saved.txt'), 'kept\n')
})

test('a key that is not a branch name is refused, and the app stays where it was', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  t.after(() => srv.close())
  const a = open(t, srv, 'rb5', 'a', 'main')
  await a.c.waitForSync()
  await assert.rejects(a.c.joinBranch('bad..name', new Y.Doc()), /isn't a branch name/)
  await assert.rejects(a.c.joinBranch('x'.repeat(201), new Y.Doc()), /isn't a branch name/)
  assert.equal(a.c.branchKey, 'main')
  const refused = open(t, srv, 'rb5', 'z', 'no good')
  assert.match(await new Promise((resolve) => refused.c.once('branch-refused', resolve)), /isn't a branch name/)
})

test('a branch\'s "last used" time is refreshed by edits and by leaving, and saved to disk each time', async (t) => {
  const dataDir = tmp('seen')
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir })
  t.after(() => srv.close())
  const a = open(t, srv, 'rb6', 'a', 'main')
  await a.c.waitForSync()
  const room = srv.rooms.get('rb6')
  const metaFile = path.join(dataDir, 'rb6.json')
  const savedSeen = () => JSON.parse(fs.readFileSync(metaFile, 'utf8')).branches.main.seen
  const afterJoin = room.meta.branches.main.seen
  assert.ok(afterJoin, 'seen is stamped on join')
  assert.equal(savedSeen(), afterJoin, 'and saved to disk right away')
  put(a.bdoc, 'x.txt', 'hi\n')
  await waitFor(() => room.meta.branches.main.seen > afterJoin && savedSeen() === room.meta.branches.main.seen)
  const afterEdit = room.meta.branches.main.seen
  a.c.close()
  await waitFor(() => room.meta.branches.main.seen > afterEdit && savedSeen() === room.meta.branches.main.seen)
})

test('an auto-join that is refused makes waitForSync reject instead of hanging, and nothing more is sent for that branch', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  t.after(() => srv.close())
  // An invalid key refuses the automatic join (startSync), the same as a full session would:
  // either way the connection must not wait forever for a branch that will never sync.
  const a = open(t, srv, 'rb7', 'a', 'no good')
  await assert.rejects(a.c.waitForSync(), /isn't a branch name/)
  assert.equal(a.c.branchKey, null, 'the refused branch was let go, so room-only sync can complete')
  put(a.bdoc, 'x.txt', 'should not be sent\n')
  await wait(200)
  assert.equal(srv.rooms.get('rb7').store.get('no good'), null, 'no document was created for the refused branch')
})

test('an edit sent for the branch just left, still in flight when the switch landed, still reaches the relay', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  t.after(() => srv.close())
  const a = open(t, srv, 'rb8', 'a', 'main')
  await a.c.waitForSync()
  const other = new Y.Doc()
  const joined = a.c.joinBranch('feature-z', other)
  // Sent on the same tick as the join request, before the relay's reply arrives: still an
  // edit to the branch being left (`a.c.branchKey` only changes once the join is confirmed).
  put(a.bdoc, 'late.txt', 'still mine\n')
  await joined
  await waitFor(() => text(srv.rooms.get('rb8').store.get('main').doc, 'late.txt') === 'still mine\n')
})

test(`a room may not have more than ${MAX_BRANCHES} branches, but may still join one that exists`, async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  t.after(() => srv.close())
  const a = open(t, srv, 'rb9', 'a', 'main')
  await a.c.waitForSync()
  const room = srv.rooms.get('rb9')
  let i = 0
  while (Object.keys(room.meta.branches).length < MAX_BRANCHES) room.noteBranch(`filler-${i++}`)
  await assert.rejects(a.c.joinBranch('one-too-many', new Y.Doc()), new RegExp(`${MAX_BRANCHES} branches, its limit`))
  assert.equal(room.store.get('one-too-many'), null, 'no document was created for the refused branch')
  const r = await a.c.joinBranch('filler-0', new Y.Doc())
  assert.equal(r.created, false, 'joining one that already exists is still allowed at the cap')
})

test('only editors may start a new branch; a viewer may still join one that exists', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  t.after(() => srv.close())
  const a = open(t, srv, 'rb10', 'a', 'main')
  await a.c.waitForSync()
  const room = srv.rooms.get('rb10')
  const [ws] = room.conns.keys()
  room.setAccess(ws, { ...room.access.get(ws), role: 'viewer' })
  await assert.rejects(a.c.joinBranch('new-feature', new Y.Doc()), /you can only view this session/)
  assert.equal(room.store.get('new-feature'), null, 'no document was created for the refused branch')
  const r = await a.c.joinBranch('main', new Y.Doc())
  assert.equal(r.created, false, 'joining an existing branch is still allowed')
})
