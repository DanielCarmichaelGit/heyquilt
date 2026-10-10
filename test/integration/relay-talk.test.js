// "May chat and post to the feed": someone whose access says no can still read and (if
// they may) edit, but the relay undoes their chat messages and feed entries, tells them
// why, and refuses the files they try to send in chat.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { startServer } from '../../src/server.js'
import { Session } from '../../src/session.js'
import { generateIdentity } from '../../src/identity.js'
import { PASS_KEYS, makePass, testPasses } from '../helpers/pass-helpers.js'

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-rt-home-'))
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-rt-${n}-`))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor (fn, ms = 6000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await wait(25) }
  throw new Error('timed out')
}
const QUIET = { files: 'edit', folders: [], foldersExcept: [], talk: false }

let srv, server, owner, quiet, quietDir, quietId
const room = 'rt-1'
before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, passPublicKey: PASS_KEYS.publicKey })
  server = `ws://127.0.0.1:${srv.port}`
  const oid = generateIdentity()
  const ownerDir = tmp('owner')
  fs.writeFileSync(path.join(ownerDir, 'README.md'), 'hello\n')
  owner = new Session({ dir: ownerDir, server, room, secret: 'e', viewSecret: 'v', name: 'Olive', identity: oid, passes: testPasses(oid, { name: 'Olive', sub: 'olive' }) })
  await owner.start({ waitTimeoutMs: 5000 })
  await waitFor(() => owner.isOwner)
  quietId = generateIdentity()
  quietDir = tmp('quiet')
  quiet = new Session({ dir: quietDir, server, room, secret: 'e', name: 'Quinn', identity: quietId, passes: testPasses(quietId, { name: 'Quinn', sub: 'quinn', room, access: QUIET }) })
  await quiet.start({ waitTimeoutMs: 5000 })
  await waitFor(() => quiet.access?.state === 'approved')
})
after(async () => { await quiet.stop(); await owner.stop(); await srv.close() })

test('their chat messages and feed entries are undone, and they are told why', async () => {
  assert.equal(quiet.access.talk, false)
  quiet.doc.transact(() => quiet.chat.push([{ id: 'm1', by: 'Quinn', to: null, text: 'psst', ts: Date.now() }]))
  quiet.doc.transact(() => quiet.agentFeed.push([{ id: 'f1', by: 'Quinn', kind: 'prompt', text: 'secret plan', ts: Date.now() }]))
  await waitFor(() => quiet.chat.length === 0 && quiet.agentFeed.length === 0)
  await wait(150)
  assert.equal(owner.chat.length, 0, 'the owner never saw the message')
  assert.equal(owner.agentFeed.length, 0)
  const rm = srv.rooms.get(room)
  assert.equal(rm.chat.length, 0)
  assert.deepEqual([quiet.access.why, quiet.access.refused], ["you can't post in this session", ['the feed']])
})

test('they are not shown sharing their AI chat, and cannot turn it on', () => {
  assert.equal(quiet.conn.awareness.getLocalState().agent.sharing, false)
  assert.throws(() => quiet.setAgentSharing(true), /can't post/)
})

test('they can still change files their access allows', async () => {
  fs.writeFileSync(path.join(quietDir, 'notes.md'), 'from Quinn\n')
  await waitFor(() => owner.files.get('notes.md')?.toString() === 'from Quinn\n')
})

test('everyone else may still post', async () => {
  owner.say('hi Quinn')
  await waitFor(() => quiet.chat.toArray().some((m) => m.text === 'hi Quinn'))
})

test('a file sent in chat is refused', async () => {
  const pass = makePass({ identity: quietId, name: 'Quinn', sub: 'quinn', room, access: QUIET })
  const res = await fetch(`http://127.0.0.1:${srv.port}/files/${room}`, { method: 'POST', headers: { 'x-quilt-secret': 'e', 'x-quilt-pass': pass }, body: 'hi' })
  assert.deepEqual([res.status, await res.text()], [403, "You can't post in this session."])
  const ownerPass = makePass({ identity: owner.identity, name: 'Olive', sub: 'olive' })
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/files/${room}`, { method: 'POST', headers: { 'x-quilt-secret': 'e', 'x-quilt-pass': ownerPass }, body: 'hi' })).status, 201)
})

// Decision 11: several changes from one connection can arrive in a single network read.
// They're applied here straight into the relay's doc, one after another in the same tick,
// with the connection as their origin, just as the relay applies messages from one read.
test('changes that arrive together: only the refused ones are undone', async () => {
  const rm = srv.rooms.get(room)
  const ws = [...rm.access].find(([, a]) => a.name === 'Quinn')[0]
  // Files are in the branch's document, chat and the activity log in the room's: each has its own fork.
  const be = rm.store.get(ws.branch)
  const fork = new Y.Doc()
  Y.applyUpdate(fork, Y.encodeStateAsUpdate(rm.doc))
  const bfork = new Y.Doc()
  Y.applyUpdate(bfork, Y.encodeStateAsUpdate(be.doc))
  const changeOf = (d) => (fn) => { const sv = Y.encodeStateVector(d); d.transact(fn); return Y.encodeStateAsUpdate(d, sv) }
  const change = changeOf(fork)
  const bchange = changeOf(bfork)
  const post = (id) => () => fork.getArray('chat').push([{ id, by: 'Quinn', to: null, text: id, ts: Date.now() }])
  // A log entry (no id of its own, as apps write them): told apart by its ts.
  const logged = (ts) => () => fork.getArray('activity').push([{ by: 'Quinn', path: 'README.md', kind: 'edited', detail: '+1 -0', ts }])
  const hasLog = (arr, ts) => arr.toArray().some((x) => x && x.ts === ts && x.by === 'Quinn')
  const mine = (arr, id) => arr.toArray().some((x) => x && x.id === id)
  const edit = (text) => () => bfork.getMap('files').get('README.md').insert(0, text)

  // Two refused changes.
  const a = change(post('a1'))
  const b = change(() => fork.getArray('agentFeed').push([{ id: 'b1', by: 'Quinn', kind: 'prompt', text: 'b', ts: Date.now() }]))
  Y.applyUpdate(rm.doc, a, ws)
  Y.applyUpdate(rm.doc, b, ws)
  await waitFor(() => !mine(rm.chat, 'a1') && !mine(rm.feed, 'b1'))
  assert.equal(rm.guard.undoStack.length, 0)

  // One refused and one allowed, as two updates (the edit is the branch document's).
  Y.applyUpdate(rm.doc, change(post('c1')), ws)
  Y.applyUpdate(be.doc, bchange(edit('one ')), ws)
  await waitFor(() => owner.files.get('README.md')?.toString().startsWith('one '))
  await wait(50)
  assert.equal(mine(rm.chat, 'c1'), false)
  assert.equal(be.files.get('README.md').toString().startsWith('one '), true, 'the allowed edit stays')
  assert.equal(rm.guard.undoStack.length, 0)

  // One refused and one allowed, combined into one update: a post and the log entry for their edit.
  const ts = Date.now() + 12345
  Y.applyUpdate(rm.doc, change(() => { post('d1')(); logged(ts)() }), ws)
  await waitFor(() => hasLog(owner.activity, ts))
  await wait(50)
  assert.equal(mine(rm.chat, 'd1'), false, 'the post is undone')
  assert.equal(mine(owner.chat, 'd1'), false)
  assert.equal(hasLog(rm.doc.getArray('activity'), ts), true, 'the allowed log entry stays')
  assert.equal(rm.guard.undoStack.length, 0)
})

test('a claim keeps its pattern but not its note', async () => {
  await quiet.claim('docs/**', 'read this, everyone')
  const c = srv.rooms.get(room).meta.claims['docs/**']
  assert.deepEqual([c.by, c.note], ['Quinn', ''])
  await quiet.release('docs/**')
})

test('the activity log takes their file changes, but not words of their own', async () => {
  const rm = srv.rooms.get(room)
  fs.writeFileSync(path.join(quietDir, 'log-me.md'), 'a line\n')
  await waitFor(() => rm.doc.getArray('activity').toArray().some((x) => x.by === 'Quinn' && x.path === 'log-me.md'))
  quiet.doc.transact(() => quiet.activity.push([{ by: 'Quinn', path: 'README.md', kind: 'edited', detail: 'everyone, read this', ts: Date.now() }]))
  await waitFor(() => !quiet.activity.toArray().some((x) => x.detail === 'everyone, read this'))
  assert.equal(rm.doc.getArray('activity').toArray().some((x) => x.detail === 'everyone, read this'), false)
  assert.equal(owner.activity.toArray().some((x) => x.detail === 'everyone, read this'), false)
  assert.equal(rm.doc.getArray('activity').toArray().some((x) => x.path === 'log-me.md'), true, 'their real entry stays')
})

test('they cannot ask for a commit, which is a message too', async () => {
  assert.throws(() => quiet.requestCommit('ship it'), /can't post/)
  const rm = srv.rooms.get(room)
  quiet.doc.transact(() => quiet.commitRequests.set('c1', { id: 'c1', by: 'Quinn', message: 'hello all', ts: Date.now(), state: 'open' }))
  await waitFor(() => !quiet.commitRequests.has('c1'))
  assert.equal(rm.doc.getMap('commitRequests').has('c1'), false)
})

test('someone who may only view cannot use up the room\'s storage, even with the edit link', async () => {
  const vid = generateIdentity()
  const pass = makePass({ identity: vid, name: 'Vic', sub: 'vic', room, access: { ...QUIET, files: 'view', talk: true } })
  const res = await fetch(`http://127.0.0.1:${srv.port}/blobs/${room}/${'b'.repeat(32)}/upload`, { method: 'POST', headers: { 'x-quilt-secret': 'e', 'x-quilt-pass': pass, 'content-type': 'application/json' }, body: JSON.stringify({ size: 4 }) })
  assert.equal(res.status, 403)
})
