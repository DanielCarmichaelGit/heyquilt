// Branch documents on the relay: a connection syncs the room's document and
// the one branch it joined; branches are kept apart, saved and reloaded, and a
// key that isn't a branch name is refused.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import * as Y from 'yjs'
import { startServer } from '../../src/server.js'
import { Connection, REMOTE } from '../../src/connection.js'
import { generateIdentity } from '../../src/identity.js'
import { validBranchKey, branchFileName, covers, MAX_BRANCHES, DETACHED_TTL_MS } from '../../src/branchdocs.js'

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

test('a session over its total size across branches refuses a new branch in plain English, and nobody is disconnected', { timeout: 15000 }, async (t) => {
  // Each document has the size limit of its own; all of a room's documents together may take ten
  // times it. Past that, a new branch is refused the way an invalid key is (see the test above):
  // waitForSync rejects rather than hangs, and the apps already in the session stay connected.
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, maxRoomBytes: 1000 })
  t.after(() => srv.close())
  const seed = open(t, srv, 'rb7b', 'seed', 'main')
  await seed.c.waitForSync()
  put(seed.bdoc, 'big.txt', 'x'.repeat(11000))
  const room = srv.rooms.get('rb7b')
  await waitFor(() => room.totalBytes() > 10000)
  const a = open(t, srv, 'rb7b', 'a', 'brand-new-branch')
  await assert.rejects(a.c.waitForSync(), /size limit across all its branches, so it can't take another branch/)
  assert.equal(a.c.branchKey, null, 'the refused branch was let go, so room-only sync could settle')
  assert.equal(room.meta.branches['brand-new-branch'], undefined)
  await wait(200)
  assert.equal(a.c.closed, false, 'refused a branch, not disconnected')
  assert.equal(seed.c.connected, true)
  a.doc.getArray('chat').push([{ text: 'still here' }])
  await waitFor(() => seed.doc.getArray('chat').length === 1)
})

test('branches whose sizes add up past the limit all stay connected and syncing: the limit is per document', { timeout: 15000 }, async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, maxRoomBytes: 3000 })
  t.after(() => srv.close())
  const apps = {}
  for (const k of ['main', 'one', 'two']) {
    apps[k] = [open(t, srv, 'rbsz', `${k}-a`, k), open(t, srv, 'rbsz', `${k}-b`, k)]
    await Promise.all(apps[k].map((x) => x.c.waitForSync()))
    put(apps[k][0].bdoc, 'part.txt', k.repeat(2000 / k.length))
    await waitFor(() => text(apps[k][1].bdoc, 'part.txt') === k.repeat(2000 / k.length))
  }
  const room = srv.rooms.get('rbsz')
  assert.ok(room.totalBytes() > 3000, `the documents together are over the limit (${room.totalBytes()})`)
  for (const k of ['main', 'one', 'two']) {
    put(apps[k][0].bdoc, 'more.txt', `more on ${k}\n`)
    await waitFor(() => text(apps[k][1].bdoc, 'more.txt') === `more on ${k}\n`)
    assert.equal(apps[k][1].c.connected, true)
  }
  assert.equal(room.full, false)
  assert.deepEqual(room.branchList().filter((b) => b.full), [])
})

test('one branch over the limit is full on its own: it takes nothing new and its members hear it; the other branches and the room carry on', { timeout: 15000 }, async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, maxRoomBytes: 3000 })
  t.after(() => srv.close())
  const big = open(t, srv, 'rbfull', 'big', 'big')
  const big2 = open(t, srv, 'rbfull', 'big2', 'big')
  const m = open(t, srv, 'rbfull', 'm', 'main')
  const m2 = open(t, srv, 'rbfull', 'm2', 'main')
  await Promise.all([big, big2, m, m2].map((x) => x.c.waitForSync()))
  let heard = null
  big2.c.on('branches', (list) => { heard = list })
  put(big.bdoc, 'huge.txt', 'h'.repeat(4000))
  await waitFor(() => text(big2.bdoc, 'huge.txt'))
  await waitFor(() => heard && heard.find((b) => b.key === 'big')?.full === true)
  assert.equal(heard.find((b) => b.key === 'main').full, undefined, 'main is not full')
  const room = srv.rooms.get('rbfull')
  put(big.bdoc, 'after.txt', 'refused\n')
  await wait(400)
  assert.equal(text(room.store.get('big').doc, 'after.txt'), undefined, 'the full branch took nothing new')
  assert.equal(text(big2.bdoc, 'after.txt'), undefined)
  assert.equal(big.c.connected, true, 'nobody is disconnected for a full branch')
  assert.equal(big.c.closed, false)
  put(m.bdoc, 'fine.txt', 'main carries on\n')
  await waitFor(() => text(m2.bdoc, 'fine.txt') === 'main carries on\n')
  big.doc.getArray('chat').push([{ text: 'chat still works' }])
  await waitFor(() => m2.doc.getArray('chat').length === 1)
})

test('a room whose move to branch documents failed on disk stays read-only: nobody edits empty branch documents', { timeout: 15000 }, async (t) => {
  const dataDir = tmp('migrate-fail')
  legacyRoom(dataDir, 'rbmf')
  fs.writeFileSync(path.join(dataDir, 'branches'), 'not a folder') // the branch file can't be written
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir })
  t.after(() => srv.close())
  const a = open(t, srv, 'rbmf', 'a', 'main')
  await assert.rejects(a.c.waitForSync())
  const room = srv.rooms.get('rbmf')
  assert.equal(room.unsavable, true)
  assert.equal(room.full, true, 'read-only')
  assert.notEqual(room.meta.layout, 2)
  assert.deepEqual(Object.keys(room.meta.branches), [], 'no branch document was started')
  assert.throws(() => room.branchDoc('main'), /read-only until the relay is fixed/)
  assert.equal(room.doc.getMap('files').get('app.js').toString(), 'old\n', 'the old files are still where they were')
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

/** A room as a relay from before branch documents saved it: one document with files, chat and tasks. */
function legacyRoom (dataDir, room) {
  const legacy = new Y.Doc()
  put(legacy, 'app.js', 'old\n')
  legacy.getArray('chat').push([{ id: 'aaaaaaaaaaaaaaaa', by: 'x', text: 'old chat', ts: 1 }])
  legacy.getMap('tasks').set('t1', { id: 't1', title: 'old task' })
  legacy.getMap('taskComments').set('t1', [{ id: 'bbbbbbbbbbbbbbbb', by: 'x', text: 'old comment', ts: 1 }])
  fs.writeFileSync(path.join(dataDir, `${room}.ydoc`), Y.encodeStateAsUpdate(legacy))
  fs.writeFileSync(path.join(dataDir, `${room}.json`), JSON.stringify({ secretHash: crypto.createHash('sha256').update('s').digest('hex'), createdAt: Date.now(), lastActive: Date.now() }))
  return legacy
}

test('an old room\'s document becomes its default branch, taken by the first branch that joins; apps\' saved copies still match', async (t) => {
  const dataDir = tmp('legacy')
  const legacy = legacyRoom(dataDir, 'rb6')
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir })
  t.after(() => srv.close())
  const a = open(t, srv, 'rb6', 'a', 'main')
  await a.c.waitForSync()
  assert.equal(text(a.bdoc, 'app.js'), 'old\n')
  assert.equal(a.doc.getArray('chat').get(0).text, 'old chat')
  assert.equal(a.doc.getMap('tasks').get('t1').title, 'old task')
  assert.equal(a.doc.getMap('taskComments').get('t1')[0].text, 'old comment', 'task comments also left the branch document')
  assert.equal(a.bdoc.getArray('chat').length, 0, 'the room-wide parts left the branch document')
  const room = srv.rooms.get('rb6')
  assert.equal(room.meta.layout, 2)
  assert.equal(room.defaultKey, 'main')
  assert.ok(fs.existsSync(path.join(dataDir, 'branches', 'rb6', branchFileName('main'))))
  // An app's saved copy of the old document edits the same text, not a copy of it.
  const saved = new Y.Doc()
  Y.applyUpdate(saved, Y.encodeStateAsUpdate(legacy))
  saved.getMap('files').get('app.js').insert(0, '// ')
  Y.applyUpdate(a.bdoc, Y.encodeStateAsUpdate(saved))
  await waitFor(() => text(room.store.get('main').doc, 'app.js') === '// old\n')
})

test('an app that synced the old document names its branch; other branches start empty; a folder without git gets the default', async (t) => {
  const dataDir = tmp('adopt')
  legacyRoom(dataDir, 'rb7')
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir })
  t.after(() => srv.close())
  const f = open(t, srv, 'rb7', 'f', 'feature', { adopt: 'main' })
  await f.c.waitForSync()
  assert.equal(text(f.bdoc, 'app.js'), undefined, 'feature is a branch of its own')
  const m = open(t, srv, 'rb7', 'm', 'main')
  await m.c.waitForSync()
  assert.equal(text(m.bdoc, 'app.js'), 'old\n')
  const n = open(t, srv, 'rb7', 'n', '∅')
  await n.c.waitForSync()
  assert.equal(text(n.bdoc, 'app.js'), 'old\n')
  put(n.bdoc, 'from-plain.txt', 'p\n')
  await waitFor(() => text(m.bdoc, 'from-plain.txt') === 'p\n')
})

test('a branch nobody is on leaves memory and comes back with its files', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir: tmp('idle'), branchIdleMs: 50 })
  t.after(() => srv.close())
  const a = open(t, srv, 'rb8', 'a', 'main')
  await a.c.waitForSync()
  put(a.bdoc, 'kept.txt', 'kept\n')
  await a.c.confirmBranch()
  await a.c.joinBranch('side', new Y.Doc())
  const room = srv.rooms.get('rb8')
  await waitFor(() => !room.store.get('main'))
  const back = new Y.Doc()
  await a.c.joinBranch('main', back)
  await a.c.waitForBranchSync()
  assert.equal(text(back, 'kept.txt'), 'kept\n')
})

test('claims are per branch: the same path on two branches never blocks; each app hears its own branch\'s', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  t.after(() => srv.close())
  const a = open(t, srv, 'rb9', 'a', 'main')
  await a.c.waitForSync()
  const b = open(t, srv, 'rb9', 'b', 'feature-x')
  await b.c.waitForSync()
  await a.c.claimRequest({ op: 'claim', pattern: 'src/a.js', note: 'main work' })
  await b.c.claimRequest({ op: 'claim', pattern: 'src/a.js', note: 'feature work' })
  const room = srv.rooms.get('rb9')
  assert.deepEqual(room.claimList('main').map((c) => c.by), ['a'])
  assert.deepEqual(room.claimList('feature-x').map((c) => c.by), ['b'])
  assert.ok(room.meta.claims['src/a.js'] && room.meta.claims['feature-x\0src/a.js'], 'the default branch keeps bare paths')
  let heard = null
  b.c.on('claims', (list) => { heard = list })
  await a.c.claimRequest({ op: 'claim', pattern: 'docs/**' })
  await waitFor(() => heard)
  assert.deepEqual(heard.map((c) => c.pattern), ['src/a.js'])
  assert.deepEqual(await b.c.claimRequest({ op: 'release', pattern: 'docs/**' }).then((r) => r.released), 0, 'a claim on main is not there to release on feature-x')
})

test('a viewer\'s change to a branch\'s files is undone there, and nobody else sees it', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  t.after(() => srv.close())
  const owner = open(t, srv, 'rb10', 'olive', 'main', { conn: { viewSecret: 'v' } })
  await owner.c.waitForSync()
  while (!owner.c.access || !owner.c.access.owner) await new Promise((resolve) => owner.c.once('access', resolve))
  put(owner.bdoc, 'a.txt', 'safe\n')
  const vid = generateIdentity()
  const asked = new Promise((resolve) => owner.c.on('members', (m) => { if ((m.pending || []).some((p) => p.key === vid.publicKey)) resolve() }))
  const v = open(t, srv, 'rb10', 'vic', 'main', { identity: vid, conn: { secret: 'v' } })
  await asked
  await owner.c.adminRequest({ op: 'approve', key: vid.publicKey, role: 'viewer' })
  await v.c.waitForSync()
  await waitFor(() => text(v.bdoc, 'a.txt') === 'safe\n')
  v.bdoc.getMap('files').get('a.txt').insert(0, 'EVIL ')
  await waitFor(() => text(v.bdoc, 'a.txt') === 'safe\n')
  await wait(200)
  assert.equal(text(owner.bdoc, 'a.txt'), 'safe\n')
})

test('a branch is removed from the session once nobody is on it; the default branch stays', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  t.after(() => srv.close())
  const a = open(t, srv, 'rb11', 'a', 'main')
  await a.c.waitForSync()
  const b = open(t, srv, 'rb11', 'b', 'gone')
  await b.c.waitForSync()
  await assert.rejects(a.c.branchRequest({ op: 'remove', branch: 'gone' }), /b is on gone/)
  await b.c.joinBranch('main', new Y.Doc())
  await a.c.branchRequest({ op: 'remove', branch: 'gone' })
  const room = srv.rooms.get('rb11')
  assert.deepEqual(room.branchList().map((x) => x.key), ['main'])
  await assert.rejects(a.c.branchRequest({ op: 'remove', branch: 'main' }), /default branch/)
})

test('branches nobody was on for 30 days are dropped when the room loads; the active branch has the most people', async (t) => {
  const dataDir = tmp('ttl')
  const old = Date.now() - 31 * 86400e3
  fs.writeFileSync(path.join(dataDir, 'rb12.json'), JSON.stringify({ secretHash: crypto.createHash('sha256').update('s').digest('hex'), layout: 2, defaultBranch: 'main', branches: { main: { by: 'a', at: old, seen: old }, stale: { by: 'a', at: old, seen: old }, fresh: { by: 'a', at: old, seen: Date.now() } }, lastActive: Date.now() }))
  fs.mkdirSync(path.join(dataDir, 'branches', 'rb12'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'branches', 'rb12', branchFileName('stale')), Y.encodeStateAsUpdate(new Y.Doc()))
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir })
  t.after(() => srv.close())
  const a = open(t, srv, 'rb12', 'a', 'fresh')
  const b = open(t, srv, 'rb12', 'b', 'fresh')
  const c = open(t, srv, 'rb12', 'c', 'main')
  await Promise.all([a.c.waitForSync(), b.c.waitForSync(), c.c.waitForSync()])
  const room = srv.rooms.get('rb12')
  assert.deepEqual(room.branchList().map((x) => x.key).sort(), ['fresh', 'main'])
  assert.equal(fs.existsSync(path.join(dataDir, 'branches', 'rb12', branchFileName('stale'))), false)
  assert.equal(room.activeBranch(), 'fresh')
})

test('a detached checkout nobody has been on leaves the session sooner than a named branch (DETACHED_TTL_MS, not BRANCH_TTL_MS)', async (t) => {
  const dataDir = tmp('ttl-detached')
  const old = Date.now() - 2 * 86400e3 // 2 days: past DETACHED_TTL_MS (1 day), well under BRANCH_TTL_MS (30 days)
  assert.ok(2 * 86400e3 > DETACHED_TTL_MS, 'the scenario is actually past the detached TTL')
  const detached = `@${'1'.repeat(12)}`
  fs.writeFileSync(path.join(dataDir, 'rb14.json'), JSON.stringify({ secretHash: crypto.createHash('sha256').update('s').digest('hex'), layout: 2, defaultBranch: 'main', branches: { main: { by: 'a', at: old, seen: old }, [detached]: { by: 'a', at: old, seen: old } }, lastActive: Date.now() }))
  fs.mkdirSync(path.join(dataDir, 'branches', 'rb14'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'branches', 'rb14', branchFileName(detached)), Y.encodeStateAsUpdate(new Y.Doc()))
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir })
  t.after(() => srv.close())
  const a = open(t, srv, 'rb14', 'a', 'main')
  await a.c.waitForSync()
  const room = srv.rooms.get('rb14')
  assert.deepEqual(room.branchList().map((x) => x.key).sort(), ['main'], 'the detached checkout is gone, but a named branch of the same age stays')
  assert.equal(fs.existsSync(path.join(dataDir, 'branches', 'rb14', branchFileName(detached))), false)
})

test('a relay restarted mid-migration (branch file written, room file swapped, meta not yet saved) keeps the default branch\'s stored files out of the sweep', async (t) => {
  const dataDir = tmp('migrate-restart')
  const DAY = 24 * 60 * 60 * 1000
  const id = 'c'.repeat(32)
  // What migrateLegacy leaves behind if it crashes right after the room file is swapped,
  // before `layout`/`branches` are saved: the branch file already has the old files and blobs...
  const branch = new Y.Doc()
  put(branch, 'app.js', 'old\n')
  branch.getMap('blobs').set('big.bin', { size: 999, stored: { id } })
  fs.mkdirSync(path.join(dataDir, 'branches', 'rb13'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'branches', 'rb13', branchFileName('∅')), Y.encodeStateAsUpdate(branch))
  // ...and the room file already holds only the room-wide parts (empty files/blobs of its own).
  fs.writeFileSync(path.join(dataDir, 'rb13.ydoc'), Y.encodeStateAsUpdate(new Y.Doc()))
  // The room's meta still has no `layout`/`branches`, but already lists the stored file (as the
  // normal upload path would have, before the crash) with a `ts` old enough for the sweep.
  fs.writeFileSync(path.join(dataDir, 'rb13.json'), JSON.stringify({
    secretHash: crypto.createHash('sha256').update('s').digest('hex'),
    createdAt: Date.now(),
    lastActive: Date.now(),
    blobs: { [id]: { size: 999, ts: Date.now() - 2 * DAY } }
  }))
  fs.mkdirSync(path.join(dataDir, 'blobs', 'rb13'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'blobs', 'rb13', id), Buffer.from('stored bytes'))
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir, idleUnloadMs: 50 })
  t.after(() => srv.close())
  // Nobody ever joins a branch: the room is only touched over HTTP (as a presence check, or a
  // chat-file request, would), the same as the crash-recovery scenario the review describes.
  const res = await fetch(`http://127.0.0.1:${srv.port}/files/rb13`, { headers: { 'x-quilt-secret': 's' } })
  await res.text()
  const room = srv.rooms.get('rb13')
  assert.ok(room, 'the room was loaded, running the migration\'s recovery path')
  assert.deepEqual(room.meta.branches['∅'].stored, [id], 'the recovered entry records the branch\'s stored ids')
  // Nothing is connected: simulate the room going idle right after that request, the same way
  // the relay's own HTTP handlers do when they finish with nobody left in the room.
  room.onEmpty()
  await waitFor(() => !srv.rooms.has('rb13'), 3000)
  assert.equal(fs.existsSync(path.join(dataDir, 'blobs', 'rb13', id)), true, 'the stored file survives the sweep because it is still a known stored id')
})

test('when the first real branch takes the default branch over, everyone hears the new list', async (t) => {
  const dataDir = tmp('adopt-broadcast')
  legacyRoom(dataDir, 'rb14')
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir })
  t.after(() => srv.close())
  const n = open(t, srv, 'rb14', 'n', '∅')
  await n.c.waitForSync()
  let heard = null
  n.c.on('branches', (list) => { heard = list })
  const m = open(t, srv, 'rb14', 'm', 'main')
  await m.c.waitForSync()
  await waitFor(() => heard && heard.some((b) => b.key === 'main' && b.default))
  assert.equal(heard.some((b) => b.key === '∅'), false)
})

test('a claim pattern or path with a control character is refused, so a branch claim\'s key can never be forged', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  t.after(() => srv.close())
  const a = open(t, srv, 'rb15', 'a', 'main')
  await a.c.waitForSync()
  const b = open(t, srv, 'rb15', 'b', 'feature-x')
  await b.c.waitForSync()
  await b.c.claimRequest({ op: 'claim', pattern: 'src/a.js' })
  // On main, bare keys: 'feature-x\0src/a.js' would be feature-x's claim.
  await assert.rejects(a.c.claimRequest({ op: 'claim', pattern: 'feature-x\0src/a.js' }), /control characters/)
  await assert.rejects(a.c.claimRequest({ op: 'claim', pattern: 'x\ny' }), /control characters/)
  await assert.rejects(a.c.claimRequest({ op: 'request', path: 'feature-x\0src/a.js', title: 't' }), /control characters/)
  const room = srv.rooms.get('rb15')
  assert.equal(room.meta.claims['feature-x\0src/a.js'].by, 'b', 'feature-x\'s claim is untouched')
})
