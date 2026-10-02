import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { isSafeRelPath, globMatcher } from '../src/fsutil.js'
import { generateIdentity } from '../src/identity.js'
import WebSocket from 'ws'

let srv, server
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-${name}-`))
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), text)
}

async function waitFor (fn, ms = 5000) {
  const start = Date.now()
  let last
  while (Date.now() - start < ms) {
    try { last = await fn(); if (last) return last } catch (err) { last = err }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out; last value: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}

// One key per person, kept across reconnects like ~/.quilt/identity.json.
const identities = new Map()
const identityOf = (name) => { if (!identities.has(name)) identities.set(name, generateIdentity()); return identities.get(name) }

const stopped = new Set()
const close = async (s) => { if (!stopped.has(s)) { stopped.add(s); await s.stop() } }

/** Joins a room; the session is stopped when the test ends. */
async function open (t, dir, name, extra) {
  const s = new Session({ dir, server, secret: 'pw', name, identity: identityOf(name), ...extra })
  t.after(() => close(s))
  await s.start({ waitTimeoutMs: 5000 })
  return s
}

let rooms = 0
/** Alice and Bob in a room of their own. `seed` is put in Alice's folder before she joins. */
async function pair (t, seed = {}) {
  const room = `room${++rooms}`
  const dirA = tmp('a')
  const dirB = tmp('b')
  for (const [rel, text] of Object.entries(seed)) write(dirA, rel, text)
  const A = await open(t, dirA, 'alice', { room, tool: 'claude' })
  const B = await open(t, dirB, 'bob', { room, tool: 'cursor' })
  return { A, B, dirA, dirB, room }
}

before(async () => {
  // Every test opens a room of its own, more than the relay lets one address start per hour.
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, maxNewRoomsPerHour: 0 })
  server = `ws://127.0.0.1:${srv.port}`
})

after(async () => {
  await srv.close()
})

test('first joiner seeds the room, second joiner receives files', async (t) => {
  const { dirB } = await pair(t, {
    'README.md': '# hello\n',
    'src/app.js': 'console.log(1)\n',
    '.env': 'SECRET=1\n',
    'node_modules/x/index.js': 'x',
    '.claude/worktrees/wt/src/app.js': 'worktree copy'
  })
  assert.equal(read(dirB, 'README.md'), '# hello\n')
  assert.equal(read(dirB, 'src/app.js'), 'console.log(1)\n')
  assert.equal(read(dirB, '.env'), null, '.env must never sync')
  assert.equal(read(dirB, 'node_modules/x/index.js'), null)
  assert.equal(read(dirB, '.claude/worktrees/wt/src/app.js'), null, 'Claude Code worktrees must never sync')
})

test('edits propagate live in both directions', async (t) => {
  const { dirA, dirB } = await pair(t, { 'src/app.js': 'console.log(1)\n' })
  write(dirA, 'src/new.ts', 'export const a = 1\n')
  await waitFor(() => read(dirB, 'src/new.ts') === 'export const a = 1\n')
  write(dirB, 'src/new.ts', 'export const a = 2\n')
  await waitFor(() => read(dirA, 'src/new.ts') === 'export const a = 2\n')
})

test('concurrent edits to different parts of a file merge', async (t) => {
  const { A, B, dirA, dirB } = await pair(t)
  const base = 'line1\nline2\nline3\nline4\nline5\n'
  write(dirA, 'merge.txt', base)
  await waitFor(() => read(dirB, 'merge.txt') === base)
  // Both write before seeing each other's change. Each side takes in its own
  // edit in the same tick (as its watcher would a moment later), so the
  // other's update can't reach it first, whatever the watcher's timing.
  write(dirA, 'merge.txt', 'LINE1 by alice\nline2\nline3\nline4\nline5\n')
  write(dirB, 'merge.txt', 'line1\nline2\nline3\nline4\nLINE5 by bob\n')
  A.ingest('merge.txt')
  B.ingest('merge.txt')
  const expected = 'LINE1 by alice\nline2\nline3\nline4\nLINE5 by bob\n'
  await waitFor(() => read(dirA, 'merge.txt') === expected && read(dirB, 'merge.txt') === expected)
})

test('deletes and folder removals propagate', async (t) => {
  const { dirA, dirB } = await pair(t)
  write(dirA, 'tmp/a.txt', 'a')
  write(dirA, 'tmp/b.txt', 'b')
  await waitFor(() => read(dirB, 'tmp/a.txt') === 'a' && read(dirB, 'tmp/b.txt') === 'b')
  fs.rmSync(path.join(dirA, 'tmp'), { recursive: true })
  await waitFor(() => read(dirB, 'tmp/a.txt') === null && read(dirB, 'tmp/b.txt') === null)
})

test('binary files sync byte for byte', async (t) => {
  const { dirA, dirB } = await pair(t)
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255, 254])
  fs.writeFileSync(path.join(dirA, 'logo.png'), buf)
  await waitFor(() => fs.existsSync(path.join(dirB, 'logo.png')) && fs.readFileSync(path.join(dirB, 'logo.png')).equals(buf))
})

test('unsafe paths from a peer are never written', async (t) => {
  const { A, dirA, dirB } = await pair(t)
  const evil = path.join(path.dirname(dirB), 'quilt-escape.txt')
  fs.rmSync(evil, { force: true })
  A.doc.transact(() => {
    A.files.set('../quilt-escape.txt', new Y.Text('pwned'))
    A.files.set('.git/hooks/pre-commit', new Y.Text('pwned'))
    A.files.set('.env', new Y.Text('pwned'))
  })
  write(dirA, 'marker.txt', 'after')
  await waitFor(() => read(dirB, 'marker.txt') === 'after')
  assert.equal(fs.existsSync(evil), false)
  assert.equal(read(dirB, '.git/hooks/pre-commit'), null)
  assert.equal(read(dirB, '.env'), null)
  assert.equal(isSafeRelPath('a/../../b'), false)
  assert.equal(isSafeRelPath('src/ok.js'), true)
})

test('presence, focus, claims and chat are shared', async (t) => {
  const { A, B } = await pair(t)
  A.setFocus('building login page')
  await A.claim('src/auth/**', 'rewriting auth')
  B.say('hey, I will take the CSS')
  await waitFor(() => {
    const st = B.status()
    return st.peers.some((p) => p.name === 'alice' && p.focus === 'building login page') &&
      st.claims.some((c) => c.pattern === 'src/auth/**' && c.by === 'alice')
  })
  await waitFor(() => A.status().chat.some((m) => m.by === 'bob'))
  await assert.rejects(B.claim('src/auth/**'), /already claimed by alice/)
  assert.equal(B.claimFor('src/auth/login.ts').by, 'alice')
  await assert.rejects(B.claim('src/auth/login.ts'), /overlaps alice's claim on src\/auth\/\*\*/)
  await assert.rejects(B.claim('src'), /overlaps alice's claim/)
  assert.equal(await A.release('*'), 1)
  await waitFor(() => B.claims.size === 0)
})

test('claims are enforced: others\' edits are undone locally and never shared', async (t) => {
  const { A, B, dirA, dirB } = await pair(t)
  write(dirA, 'locked/a.txt', 'original\n')
  await waitFor(() => read(dirB, 'locked/a.txt') === 'original\n')
  await A.claim('locked/**', 'mine')
  await waitFor(() => B.claimFor('locked/a.txt'))

  // Edit: bob's disk goes back to the shared text; his version is kept aside.
  write(dirB, 'locked/a.txt', 'bob was here\n')
  await waitFor(() => read(dirB, 'locked/a.txt') === 'original\n')
  const saved = fs.readdirSync(path.join(dirB, '.quilt', 'rejected'))
  assert.ok(saved.some((ts) => read(path.join(dirB, '.quilt', 'rejected', ts), 'locked/a.txt') === 'bob was here\n'))
  // New file inside the claim: removed. Delete: restored.
  write(dirB, 'locked/new.txt', 'sneaky')
  await waitFor(() => read(dirB, 'locked/new.txt') === null)
  fs.rmSync(path.join(dirB, 'locked/a.txt'))
  await waitFor(() => read(dirB, 'locked/a.txt') === 'original\n')

  // The claimer can still edit, and it reaches bob.
  write(dirA, 'locked/a.txt', 'alice edit\n')
  await waitFor(() => read(dirB, 'locked/a.txt') === 'alice edit\n')
  assert.equal(read(dirA, 'locked/new.txt'), null)
  assert.equal(A.files.get('locked/a.txt').toString(), 'alice edit\n')

  // Released: bob's edits go through again.
  await A.release('locked/**')
  await waitFor(() => !B.claimFor('locked/a.txt'))
  write(dirB, 'locked/a.txt', 'bob again\n')
  await waitFor(() => read(dirA, 'locked/a.txt') === 'bob again\n')
})

test('a claim on a folder that does not exist yet covers files created later', async (t) => {
  const { A, B, dirA, dirB } = await pair(t)
  await B.claim('brand-new', 'starting a module')
  await waitFor(() => A.claimFor('brand-new/deep/x.js'))
  write(dirA, 'brand-new/deep/x.js', 'nope')
  await waitFor(() => read(dirA, 'brand-new/deep/x.js') === null)
  write(dirB, 'brand-new/deep/x.js', 'bob owns this')
  await waitFor(() => read(dirA, 'brand-new/deep/x.js') === 'bob owns this')
  await B.release('brand-new')
  await waitFor(() => !A.claimFor('brand-new/deep/x.js'))
})

test('the claimer reverts changes from clients that do not enforce claims', async (t) => {
  const { A, B, dirA, dirB } = await pair(t)
  write(dirA, 'guarded.txt', 'safe\n')
  await waitFor(() => read(dirB, 'guarded.txt') === 'safe\n')
  await A.claim('guarded.txt')
  await waitFor(() => B.claimFor('guarded.txt'))
  // An old or misbehaving client writes straight into the shared doc.
  B.doc.transact(() => B.files.get('guarded.txt').insert(0, 'hacked '), 'rogue')
  await waitFor(() => B.files.get('guarded.txt').toString() === 'safe\n')
  assert.equal(read(dirA, 'guarded.txt'), 'safe\n')
  await waitFor(() => read(dirB, 'guarded.txt') === 'safe\n')
  const saved = fs.readdirSync(path.join(dirA, '.quilt', 'rejected'))
  assert.ok(saved.some((ts) => read(path.join(dirA, '.quilt', 'rejected', ts), 'guarded.txt') === 'hacked safe\n'))
  // Creating a file under someone's claim is reverted too.
  await A.claim('fort')
  await waitFor(() => B.claimFor('fort/a.txt'))
  B.doc.transact(() => B.files.set('fort/a.txt', new Y.Text('sneaky')), 'rogue')
  await waitFor(() => !B.files.has('fort/a.txt'))
  assert.equal(read(dirA, 'fort/a.txt'), null)
  await A.release('*')
})

test('globs that start overlapping through a new file resolve to the earliest claim everywhere', async (t) => {
  const { A, B, dirA, dirB } = await pair(t)
  await A.claim('mix/*.js')
  await B.claim('mix/a.*')
  await waitFor(() => A.claims.size === 2 && B.claims.size === 2)
  write(dirA, 'mix/b.css', 'x')
  await waitFor(() => read(dirB, 'mix/b.css') === 'x')
  assert.equal(A.claimFor('mix/a.js').by, 'alice')
  assert.equal(B.claimFor('mix/a.js').by, 'alice')
  assert.equal(B.claimFor('mix/a.css').by, 'bob')
  await A.release('*'); await B.release('*')
  await waitFor(() => A.claims.size === 0 && B.claims.size === 0)
})

test('only the claimer can release a claim', async (t) => {
  const { A, B } = await pair(t)
  await A.claim('mine-only', 'hands off')
  await waitFor(() => B.claimFor('mine-only/x'))
  await assert.rejects(B.release('mine-only'), /claimed by alice; only they can release it/)
  assert.equal(await B.release('*'), 0)
  assert.equal(A.claimFor('mine-only/x').by, 'alice')
  await A.release('mine-only')
})

test('claims written straight into the shared doc are ignored', async (t) => {
  const { A, B, dirA, dirB } = await pair(t)
  B.doc.transact(() => B.doc.getMap('claims').set('forged', { by: 'alice', pattern: 'forged', note: '', ts: 1 }))
  write(dirB, 'forged/x.txt', 'bob can write here')
  await waitFor(() => read(dirA, 'forged/x.txt') === 'bob can write here')
  assert.equal(A.claimFor('forged/x.txt'), null)
  assert.equal(B.claimFor('forged/x.txt'), null)
})

test('nobody can connect under a name that belongs to someone else', async (t) => {
  const { room } = await pair(t)
  const s = new Session({ dir: tmp('m'), server, room, secret: 'pw', name: 'alice', identity: generateIdentity() })
  await assert.rejects(s.start({ waitTimeoutMs: 3000 }), /belongs to someone else/)
  await s.stop().catch(() => {})
})

test('a client that cannot prove its key is refused', async (t) => {
  const { room } = await pair(t)
  // Uses alice's public key but signs with a different private key.
  const fake = { publicKey: identityOf('alice').publicKey, privateKey: generateIdentity().privateKey }
  const s = new Session({ dir: tmp('m'), server, room, secret: 'pw', name: 'alice', identity: fake })
  await assert.rejects(s.start({ waitTimeoutMs: 3000 }), /Could not verify who you are/)
  await s.stop().catch(() => {})
})

test('clients without an identity (older quilt) are told to update', async () => {
  const ws = new WebSocket(`${server}/legacy?secret=pw`)
  ws.on('error', () => {})
  const status = await new Promise((resolve) => {
    ws.on('unexpected-response', (req, res) => resolve(`${res.statusCode} ${res.statusMessage}`))
    ws.on('open', () => resolve('open'))
  })
  ws.terminate()
  assert.match(status, /^400 .*newer quilt/)
})

test('presence under someone else\'s name is dropped', async (t) => {
  const { A, B, room } = await pair(t)
  const rogue = await open(t, tmp('r'), 'rogue', { room })
  await waitFor(() => A.status().peers.some((p) => p.name === 'rogue') && B.status().peers.some((p) => p.name === 'rogue'))
  rogue.conn.awareness.setLocalStateField('name', 'alice')
  // The relay handles rogue's messages in order and bob receives them in
  // order, so once this later message reaches bob, the fake presence would have too.
  rogue.say('sent after the fake presence')
  await waitFor(() => B.messages({ markRead: false }).some((m) => m.text === 'sent after the fake presence'))
  assert.ok(B.status().peers.some((p) => p.name === 'rogue'), 'bob still sees the real name')
  assert.ok(!B.status().peers.some((p) => p.name === 'alice' && p.tool === 'unknown'), 'the fake alice never reached bob')
})

test('direct messages are only shown to sender and recipient', async (t) => {
  const { A, B } = await pair(t)
  const r = B.say('psst alice', { to: 'alice' })
  assert.equal(r.recipientOnline, true)
  B.say('note to carol', { to: 'carol' })
  await waitFor(() => A.messages({ markRead: false }).some((m) => m.text === 'psst alice' && m.to === 'alice'))
  assert.ok(!A.messages({ markRead: false }).some((m) => m.text === 'note to carol'), 'alice must not see a DM to carol')
  assert.ok(B.messages({ markRead: false }).some((m) => m.text === 'note to carol'), 'sender sees their own DM')
  assert.throws(() => B.say(''), /empty/)
})

test('unread tracking', async (t) => {
  const { A, B } = await pair(t)
  B.say('hello')
  await waitFor(() => A.unreadCount() === 1)
  A.messages() // mark everything read
  assert.equal(A.unreadCount(), 0)
  B.say('are you there?')
  await waitFor(() => A.unreadCount() === 1)
  const unread = A.messages({ unreadOnly: true })
  assert.equal(unread.length, 1)
  assert.equal(unread[0].text, 'are you there?')
  assert.equal(A.unreadCount(), 0)
})

test('files sent in chat are delivered without touching the project', async (t) => {
  const { A, B, dirB } = await pair(t)
  const outside = tmp('outside')
  const payload = Buffer.concat([Buffer.from('screenshot'), Buffer.from([0, 1, 2, 255])])
  fs.writeFileSync(path.join(outside, 'shot.png'), payload)
  const received = []
  B.on('log', (m) => received.push(m))
  const sent = await A.sendFile(path.join(outside, 'shot.png'), { text: 'look at this' })
  assert.equal(sent.file.name, 'shot.png')
  // Bob's session downloads it into .quilt/inbox automatically.
  const inboxFile = await waitFor(() => {
    const m = B.messages({ markRead: false }).find((x) => x.id === sent.id)
    return m && m.file.localPath
  })
  assert.ok(fs.readFileSync(path.join(dirB, inboxFile)).equals(payload))
  assert.ok(inboxFile.startsWith('.quilt/inbox/'))
  assert.equal(read(dirB, 'shot.png'), null, 'shared files must not land in the project tree')
  await waitFor(() => received.some((l) => l.includes('received shot.png')))
  // Fetch it again somewhere else.
  const dest = await B.fetchFile(sent.id, outside + '/copy.png')
  assert.ok(fs.readFileSync(dest).equals(payload))
  // Direct file: carol-only file is invisible to bob.
  const dm = await A.sendFile(path.join(outside, 'shot.png'), { to: 'carol' })
  await waitFor(() => B.chat.toArray().some((m) => m.id === dm.id))
  await assert.rejects(B.fetchFile(dm.id), /no such file/)
})

test('relay rejects file access with the wrong secret', async (t) => {
  const { room } = await pair(t)
  const res = await fetch(`http://127.0.0.1:${srv.port}/files/${room}`, { method: 'POST', headers: { 'x-quilt-secret': 'nope' }, body: 'x' })
  assert.equal(res.status, 401)
})

test('offline edits merge when a client comes back', async (t) => {
  let { A, B, dirA, dirB, room } = await pair(t)
  write(dirA, 'offline.txt', 'top\nmiddle\nbottom\n')
  await waitFor(() => read(dirB, 'offline.txt') === 'top\nmiddle\nbottom\n')
  await close(B)
  const note = path.join(tmp('note'), 'while-away.txt')
  fs.writeFileSync(note, 'sent while bob was offline')
  const sentAway = await A.sendFile(note, { to: 'bob' })
  write(dirB, 'offline.txt', 'top (bob offline)\nmiddle\nbottom\n')
  write(dirB, 'bob-only.txt', 'made on a plane\n')
  write(dirA, 'offline.txt', 'top\nmiddle\nbottom (alice)\n')
  // Alice's edit is in the shared doc before bob returns, so both sides really diverged.
  await waitFor(() => A.files.get('offline.txt').toString() === 'top\nmiddle\nbottom (alice)\n')
  B = await open(t, dirB, 'bob', { room })
  const expected = 'top (bob offline)\nmiddle\nbottom (alice)\n'
  await waitFor(() => read(dirA, 'offline.txt') === expected && read(dirB, 'offline.txt') === expected)
  await waitFor(() => read(dirA, 'bob-only.txt') === 'made on a plane\n')
  const got = await waitFor(() => B.messages({ markRead: false }).find((m) => m.id === sentAway.id)?.file.localPath)
  assert.equal(read(dirB, got), 'sent while bob was offline')
})

test('first join backs up conflicting local files and takes the session version', async (t) => {
  const { room } = await pair(t, { 'README.md': '# hello\n' })
  const dirC = tmp('c')
  write(dirC, 'README.md', 'my own readme\n')
  await open(t, dirC, 'carol', { room })
  assert.equal(read(dirC, 'README.md'), '# hello\n')
  const conflicts = path.join(dirC, '.quilt', 'conflicts')
  const [stamp] = fs.readdirSync(conflicts)
  assert.equal(read(path.join(conflicts, stamp), 'README.md'), 'my own readme\n')
})

test('wrong secret is rejected', async (t) => {
  const { room } = await pair(t)
  const s = new Session({ dir: tmp('d'), server, room, secret: 'nope', name: 'mallory', identity: generateIdentity() })
  await assert.rejects(s.start({ waitTimeoutMs: 3000 }), /Wrong room secret|refused/)
  await s.stop()
})

test('glob matching', () => {
  assert.ok(globMatcher('src/**/*.ts')('src/a/b.ts'))
  assert.ok(globMatcher('src/**/*.ts')('src/b.ts'))
  assert.ok(!globMatcher('src/*.ts')('src/a/b.ts'))
  assert.ok(globMatcher('src/auth')('src/auth/x.js'))
  assert.ok(!globMatcher('src/auth')('src/authz.js'))
})

test('AI feed entries reach the other side, deduped by id', async (t) => {
  const { A, B } = await pair(t)
  const base = { tool: 'Claude Code', conv: 'c1', ts: Date.now() }
  assert.equal(A.pushAgentEntries([
    { ...base, id: 'p1', kind: 'prompt', text: 'add a navbar' },
    { ...base, id: 'r1', kind: 'reply', text: 'Sure.' }
  ]), 2)
  assert.equal(A.pushAgentEntries([{ ...base, id: 'p1', kind: 'prompt', text: 'add a navbar' }]), 0, 'same id is skipped')
  await waitFor(() => B.agentFeedFor('alice').length === 2)
  assert.deepEqual(B.agentFeedFor('alice').map((e) => [e.by, e.kind, e.text]), [['alice', 'prompt', 'add a navbar'], ['alice', 'reply', 'Sure.']])
  assert.equal(B.agentFeedFor('bob').length, 0)
})

test('AI feed keeps each person\'s newest 300 entries', async (t) => {
  const { A, B } = await pair(t)
  const many = Array.from({ length: 320 }, (_, i) => ({ id: `bulk${i}`, tool: 'Cursor', conv: 'c2', kind: 'action', text: `step ${i}`, ts: Date.now() + i }))
  B.pushAgentEntries([{ id: 'bob1', kind: 'prompt', text: 'bob stays', ts: Date.now() }])
  A.pushAgentEntries(many)
  const feed = A.agentFeedFor('alice')
  assert.equal(feed.length, 300)
  assert.equal(feed.at(-1).text, 'step 319')
  assert.equal(feed[0].text, 'step 20')
  await waitFor(() => B.agentFeedFor('alice').length === 300 && A.agentFeedFor('bob').length === 1)
})

test('pausing AI sharing stops entries and leaves markers', async (t) => {
  const { A, B } = await pair(t)
  A.pushAgentEntries([{ id: 'before', kind: 'prompt', text: 'shared' }])
  A.setAgentSharing(false)
  assert.equal(A.pushAgentEntries([{ id: 'hidden', kind: 'prompt', text: 'private thought' }]), 0)
  A.setAgentSharing(true)
  A.pushAgentEntries([{ id: 'after', kind: 'prompt', text: 'back again' }])
  await waitFor(() => B.agentFeedFor('alice').at(-1)?.text === 'back again')
  const kinds = B.agentFeedFor('alice').slice(-3).map((e) => e.kind)
  assert.deepEqual(kinds, ['paused', 'resumed', 'prompt'])
  assert.ok(!B.agentFeedFor('alice').some((e) => e.text === 'private thought'))
  await waitFor(() => B.status().peers.find((p) => p.name === 'alice')?.agent?.sharing === true)
})

test('agent status is shared through presence', async (t) => {
  const { A, B } = await pair(t)
  A.setAgentState({ tool: 'Claude Code', status: 'working' })
  await waitFor(() => B.status().peers.find((p) => p.name === 'alice')?.agent?.status === 'working')
  A.setAgentSharing(false)
  await waitFor(() => B.status().peers.find((p) => p.name === 'alice')?.agent?.sharing === false)
  assert.equal(B.status().peers.find((p) => p.name === 'alice').agent.status, 'idle', 'a paused person\'s activity is hidden')
})

test('file-changed fires for local and remote edits', async (t) => {
  const { A, B, dirA } = await pair(t)
  const seenA = []
  const seenB = []
  A.on('file-changed', (e) => seenA.push(e))
  B.on('file-changed', (e) => seenB.push(e))
  write(dirA, 'watched.txt', 'v1')
  await waitFor(() => seenB.some((e) => e.path === 'watched.txt'))
  assert.ok(seenA.some((e) => e.path === 'watched.txt' && e.by === 'alice'))
  assert.equal(seenB.find((e) => e.path === 'watched.txt').by, 'alice')
})

test('changes the file watcher never reports still sync', async (t) => {
  const { A, dirA, dirB } = await pair(t, { 'README.md': '# hello\n', 'watched.txt': 'v1' })
  // macOS can drop fs events outright; simulate that by silencing A's watcher.
  await A.watcher.close()
  write(dirA, 'unseen/deep/new.txt', 'created unseen\n')
  write(dirA, 'watched.txt', 'v2')
  fs.rmSync(path.join(dirA, 'README.md'))
  await waitFor(() => read(dirB, 'unseen/deep/new.txt') === 'created unseen\n')
  await waitFor(() => read(dirB, 'watched.txt') === 'v2')
  await waitFor(() => read(dirB, 'README.md') === null)
})

// ------------------------------------------------------------- issue 032 --

test('a file that cannot be written never blocks the rest of a remote update, nor is it pushed back', async (t) => {
  const files = ['a.txt', 'locked.txt', 'b.txt', 'c.txt']
  const { A, dirA, dirB } = await pair(t, Object.fromEntries(files.map((f) => [f, 'v1\n'])))
  for (const f of files) assert.equal(read(dirB, f), 'v1\n')
  fs.chmodSync(path.join(dirB, 'locked.txt'), 0o444)
  for (const f of files) write(dirA, f, 'v2\n')
  // One transaction, so all four changes travel in one update, like a multi-file edit flushed at once.
  A.doc.transact(() => { for (const f of files) A.ingest(f) })
  await waitFor(() => files.every((f) => read(dirB, f) === 'v2\n'))
  // By the time a later change of bob's reaches alice, bob's re-scan has seen the chmod and reacted.
  write(dirB, 'after.txt', 'bob')
  await waitFor(() => read(dirA, 'after.txt') === 'bob')
  assert.equal(A.sharedKey('locked.txt'), 'v2\n', "bob's stale copy must not revert alice's edit")
  assert.equal(read(dirA, 'locked.txt'), 'v2\n')
  assert.equal(fs.existsSync(path.join(dirB, '.quilt', 'conflicts')), false, 'no conflict copy: nothing was edited')
})

test('on rejoin, a shared change that never reached the disk is taken, not pushed back', async (t) => {
  let { A, B, dirA, dirB, room } = await pair(t, { 'stale.txt': 'v1\n' })
  assert.equal(read(dirB, 'stale.txt'), 'v1\n')
  await close(B)
  // Bob's saved document took a partner's update whose write failed, so the folder still has v1.
  const saved = new Y.Doc()
  Y.applyUpdate(saved, fs.readFileSync(path.join(dirB, '.quilt', 'state.bin')))
  const text = saved.getMap('files').get('stale.txt')
  saved.transact(() => { text.delete(0, text.length); text.insert(0, 'v2\n') })
  fs.writeFileSync(path.join(dirB, '.quilt', 'state.bin'), Y.encodeStateAsUpdate(saved))
  B = await open(t, dirB, 'bob', { room })
  await waitFor(() => read(dirB, 'stale.txt') === 'v2\n' && read(dirA, 'stale.txt') === 'v2\n')
  write(dirB, 'after.txt', 'bob')
  await waitFor(() => read(dirA, 'after.txt') === 'bob')
  assert.equal(A.sharedKey('stale.txt'), 'v2\n')
  assert.equal(read(dirA, 'stale.txt'), 'v2\n')
})

test('on rejoin, a shared file that could not be written is written, not deleted from the room', async (t) => {
  let { A, B, dirA, dirB, room } = await pair(t)
  write(dirB, 'build', 'a file called build\n')
  await waitFor(() => read(dirA, 'build') === 'a file called build\n')
  // A partner (an older client, or one whose ignore file differs) shares a file under that name.
  A.doc.transact(() => A.files.set('build/x.js', new Y.Text('z')))
  await waitFor(() => B.writeFailed.has('build/x.js'))
  assert.equal(read(dirB, 'build'), 'a file called build\n')
  await close(B)
  fs.rmSync(path.join(dirB, 'build'))
  B = await open(t, dirB, 'bob', { room })
  await waitFor(() => read(dirB, 'build/x.js') === 'z')
  await waitFor(() => read(dirA, 'build') === null)
  assert.ok(A.files.has('build/x.js'), 'the file bob never had must not be deleted from the room')
  assert.equal(B.writeFailed.size, 0)
})

test('first join moves a local folder or file aside when the room has the other kind at that path', async (t) => {
  const { A, dirA, room } = await pair(t, { build: 'a file called build\n' })
  const dirC = tmp('c')
  write(dirC, 'build/out.js', 'local output')
  await open(t, dirC, 'carol', { room })
  assert.equal(read(dirC, 'build'), 'a file called build\n')
  const conflictsC = path.join(dirC, '.quilt', 'conflicts')
  const [stampC] = fs.readdirSync(conflictsC)
  assert.equal(read(path.join(conflictsC, stampC), 'build/out.js'), 'local output')
  // The reverse: the room has a folder where dave has a file.
  write(dirA, 'lib/x.js', 'shared module')
  await waitFor(() => A.files.has('lib/x.js'))
  const dirD = tmp('d')
  write(dirD, 'lib', 'a file called lib')
  await open(t, dirD, 'dave', { room })
  assert.equal(read(dirD, 'lib/x.js'), 'shared module')
  const conflictsD = path.join(dirD, '.quilt', 'conflicts')
  const [stampD] = fs.readdirSync(conflictsD)
  assert.equal(read(path.join(conflictsD, stampD), 'lib'), 'a file called lib')
})

test('paths that cannot exist on every member\'s disk are rejected', () => {
  for (const p of ['aux', 'AUX.txt', 'src/con.js', 'nul', 'com1.log', 'LPT9', 'prn.', 'Con.tar.gz', 'dir/ends.', 'ends./x', 'trailing /y', 'ok/trailing ']) {
    assert.equal(isSafeRelPath(p), false, p)
  }
  assert.equal(isSafeRelPath('a/' + 'x'.repeat(256) + '.txt'), false, 'a name over 255 bytes')
  assert.equal(isSafeRelPath('é'.repeat(128)), false, '256 bytes of UTF-8')
  for (const p of ['console.js', 'aux1.txt', 'com0', 'lpt10', 'src/null.js', 'x'.repeat(255), 'a. b', 'conf/x', 'é'.repeat(127), '.hidden']) {
    assert.equal(isSafeRelPath(p), true, p)
  }
})

// ------------------------------------------------------------- issue 033 --

test('a shared path under a local symlink to outside the project is never read, live or on rejoin', async (t) => {
  let { A, B, dirA, dirB, room } = await pair(t, { 'README.md': 'hi\n' })
  const outside = tmp('outside')
  write(outside, 'private.txt', 'bob-private-data\n')
  fs.symlinkSync(outside, path.join(dirB, 'link'))
  const logs = []
  B.on('log', (m) => logs.push(m))
  write(dirA, 'link/private.txt', 'from alice\n')
  await waitFor(() => logs.some((m) => /outside/.test(m)))
  assert.equal(read(outside, 'private.txt'), 'bob-private-data\n')
  // The claimer's revert reads the disk too.
  await B.claim('link/**')
  await waitFor(() => A.claimFor('link/private.txt'))
  A.doc.transact(() => A.files.get('link/private.txt').insert(0, 'rogue '), 'rogue')
  write(dirA, 'marker1.txt', '1')
  await waitFor(() => read(dirB, 'marker1.txt') === '1')
  assert.equal(A.sharedKey('link/private.txt'), 'rogue from alice\n')
  await B.release('*')
  // Rejoin: the saved document has the path, the folder (as walked) doesn't.
  await close(B)
  write(dirB, 'marker2.txt', '2')
  B = await open(t, dirB, 'bob', { room })
  await waitFor(() => read(dirA, 'marker2.txt') === '2')
  assert.equal(A.sharedKey('link/private.txt'), 'rogue from alice\n')
  assert.equal(read(dirA, 'link/private.txt'), 'rogue from alice\n')
  assert.equal(read(outside, 'private.txt'), 'bob-private-data\n')
})

// ------------------------------------------------------------- issue 034 --

test('a chat message with a crafted id cannot put its attachment outside the inbox', async (t) => {
  const { A, B, dirB } = await pair(t)
  const outside = tmp('outside')
  fs.writeFileSync(path.join(outside, 'note.txt'), 'attached\n')
  const sent = await A.sendFile(path.join(outside, 'note.txt'), { text: 'here' })
  // A modified client can push any message object.
  A.doc.transact(() => A.chat.push([{ id: '../../', by: 'alice', to: null, text: 'evil', ts: Date.now(), file: { id: sent.file.id, name: 'evil.txt', size: 9 } }]))
  const again = await A.sendFile(path.join(outside, 'note.txt'), { text: 'and again' })
  await waitFor(() => B.messages({ markRead: false }).find((m) => m.id === again.id)?.file.localPath)
  assert.deepEqual(fs.readdirSync(dirB), ['.quilt'], 'nothing lands in the project tree')
  assert.ok(fs.readdirSync(path.join(dirB, '.quilt', 'inbox')).every((n) => !n.includes('evil')))
  assert.ok(!B.messages({ markRead: false }).some((m) => m.text === 'evil'))
  assert.ok(!A.messages({ markRead: false }).some((m) => m.text === 'evil'))
})

test('a malformed chat message is skipped without breaking status or the messages after it', async (t) => {
  const { A, B } = await pair(t)
  const got = []
  B.on('message', (m) => got.push(m.text))
  A.doc.transact(() => {
    A.chat.push([
      { id: 123, by: 'alice', to: null, text: 'numeric id with file', ts: Date.now(), file: { id: 'x', name: 'a', size: 1 } },
      { id: 'abcd1234abcd1234', by: 'alice', to: null, text: 'normal message after it', ts: Date.now() }
    ])
  })
  await waitFor(() => got.includes('normal message after it'))
  assert.ok(!got.includes('numeric id with file'))
  assert.ok(B.status().chat.some((m) => m.text === 'normal message after it'))
  assert.ok(!B.messages({ markRead: false }).some((m) => m.text === 'numeric id with file'))
  assert.equal(B.unreadCount(), 1)
  // A file id that is not hex is skipped too, and never reaches the relay URL.
  A.doc.transact(() => A.chat.push([{ id: 'abcd1234abcd1235', by: 'alice', to: null, text: 'bad file id', ts: Date.now(), file: { id: '../x', name: 'a', size: 1 } }]))
  A.say('last')
  await waitFor(() => got.includes('last'))
  assert.ok(!got.includes('bad file id'))
  assert.equal(B.unreadCount(), 2)
})

test('each person\'s changes are tallied per file, and everyone sees the same breakdown', async (t) => {
  const { A, B, dirA, dirB } = await pair(t, { 'src/app.js': 'a\nb\nc\n' })
  await waitFor(() => read(dirB, 'src/app.js') === 'a\nb\nc\n')
  // Alice edits twice in quick succession: both edits count, even though the
  // activity log folds them into one entry.
  write(dirA, 'src/app.js', 'a\nb\nc\nd\n')
  A.ingest('src/app.js')
  write(dirA, 'src/app.js', 'a\nb\nc\nd\ne\nf\n')
  A.ingest('src/app.js')
  write(dirA, 'notes.md', 'hello\n')
  await waitFor(() => read(dirB, 'src/app.js') === 'a\nb\nc\nd\ne\nf\n' && read(dirB, 'notes.md') === 'hello\n')
  write(dirB, 'src/app.js', 'b\nc\nd\ne\nf\n')
  await waitFor(() => read(dirA, 'src/app.js') === 'b\nc\nd\ne\nf\n')
  fs.rmSync(path.join(dirA, 'notes.md'))
  await waitFor(() => read(dirB, 'notes.md') === null)

  const seenByBob = await waitFor(() => {
    const c = B.changes()
    return c.files.length === 2 && c.files.find((f) => f.path === 'notes.md')?.by[0]?.kind === 'deleted' && c
  })
  const app = seenByBob.files.find((f) => f.path === 'src/app.js')
  const alice = app.by.find((p) => p.name === 'alice')
  const bob = app.by.find((p) => p.name === 'bob')
  assert.equal(alice.added, 3, 'alice\'s two quick edits both count')
  assert.equal(alice.removed, 0)
  assert.equal(alice.edits, 2, 'seeding the room with the folder is the starting point, not a change')
  assert.equal(bob.added, 0)
  assert.equal(bob.removed, 1)
  assert.equal(bob.edits, 1)
  const notes = seenByBob.files.find((f) => f.path === 'notes.md')
  assert.equal(notes.kind, 'deleted')
  assert.equal(app.kind, 'edited')
  assert.deepEqual(notes.by.map((p) => [p.name, p.kind]), [['alice', 'deleted']])

  const people = seenByBob.people
  assert.deepEqual(people.map((p) => p.name), ['alice', 'bob'], 'most recent first')
  assert.equal(people[0].files.length, 2)
  assert.equal(people[0].added, 4)
  assert.equal(people[1].files.length, 1)
  assert.equal(people[1].removed, 1)

  // The same breakdown from Alice's side, and in the status every tool reads.
  assert.deepEqual(A.changes().people.map((p) => [p.name, p.added, p.removed]), people.map((p) => [p.name, p.added, p.removed]))
  const st = A.status()
  assert.equal(st.changes.find((p) => p.name === 'bob').files[0].path, 'src/app.js')
})
