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
  s.setAgentState({ tool: s.tool, status: 'idle' }) // people typing by hand; their edits are not claimed for them
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

// A merge "AI" for tests: QUILT_MERGE_CMD runs this script, which answers
// CONFLICT unless MERGE_FAKE_ANSWER names a file whose content to return
// (after MERGE_FAKE_DELAY_MS, if set).
const FAKE_MERGE = path.join(tmp('merge-cli'), 'fake-merge.mjs')
fs.writeFileSync(FAKE_MERGE, `
import fs from 'node:fs'
const file = process.env.MERGE_FAKE_ANSWER
let input = ''
process.stdin.on('data', (d) => { input += d })
process.stdin.on('end', () => {
  if (process.env.MERGE_FAKE_LOG) fs.appendFileSync(process.env.MERGE_FAKE_LOG, input + '\\n----\\n')
  setTimeout(() => {
    if (!file) { process.stdout.write('CONFLICT: the test says no\\n'); return }
    process.stdout.write('\`\`\`\\n' + fs.readFileSync(file, 'utf8') + '\`\`\`\\n')
  }, Number(process.env.MERGE_FAKE_DELAY_MS) || 0)
})
`)
process.env.QUILT_MERGE_CMD = `${process.execPath} ${FAKE_MERGE}`

/** Bob leaves, both sides edit, bob returns. Returns bob's new session. */
async function rejoinAfter (t, { A, B, dirA, dirB, room }, { bob = {}, alice = {} } = {}) {
  await close(B)
  for (const [rel, text] of Object.entries(bob)) text === null ? fs.rmSync(path.join(dirB, rel)) : write(dirB, rel, text)
  for (const [rel, text] of Object.entries(alice)) text === null ? fs.rmSync(path.join(dirA, rel)) : write(dirA, rel, text)
  for (const rel of Object.keys(alice)) await waitFor(() => A.sharedKey(rel) === (alice[rel] === null ? undefined : alice[rel]))
  return open(t, dirB, 'bob', { room })
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

test('offline edits to different lines merge when a client comes back', async (t) => {
  const p = await pair(t)
  const { A, dirA, dirB } = p
  write(dirA, 'offline.txt', 'top\nmiddle\nbottom\n')
  await waitFor(() => read(dirB, 'offline.txt') === 'top\nmiddle\nbottom\n')
  await close(p.B)
  const note = path.join(tmp('note'), 'while-away.txt')
  fs.writeFileSync(note, 'sent while bob was offline')
  const sentAway = await A.sendFile(note, { to: 'bob' })
  write(dirB, 'offline.txt', 'top (bob offline)\nmiddle\nbottom\n')
  write(dirB, 'bob-only.txt', 'made on a plane\n')
  write(dirA, 'offline.txt', 'top\nmiddle\nbottom (alice)\n')
  await waitFor(() => A.files.get('offline.txt').toString() === 'top\nmiddle\nbottom (alice)\n')
  const B = await open(t, dirB, 'bob', { room: p.room })
  const expected = 'top (bob offline)\nmiddle\nbottom (alice)\n'
  await waitFor(() => read(dirA, 'offline.txt') === expected && read(dirB, 'offline.txt') === expected)
  await waitFor(() => read(dirA, 'bob-only.txt') === 'made on a plane\n')
  assert.deepEqual(B.mergeList(), [], 'a clean merge opens no record')
  const got = await waitFor(() => B.messages({ markRead: false }).find((m) => m.id === sentAway.id)?.file.localPath)
  assert.equal(read(dirB, got), 'sent while bob was offline')
})

test('offline edits to the same lines open a merge conflict and keep the session version', async (t) => {
  const p = await pair(t, { 'same.txt': 'top\nmiddle\nbottom\n' })
  await waitFor(() => read(p.dirB, 'same.txt') === 'top\nmiddle\nbottom\n')
  const B = await rejoinAfter(t, p, { bob: { 'same.txt': 'top\nmiddle (bob)\nbottom\n' }, alice: { 'same.txt': 'top\nmiddle (alice)\nbottom\n' } })
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'same.txt'))
  assert.equal(rec.kind, 'conflict')
  assert.equal(rec.state, 'open')
  assert.equal(rec.by, 'bob')
  assert.deepEqual(rec.others, ['alice'])
  assert.equal(rec.ours, 'top\nmiddle (bob)\nbottom\n')
  assert.equal(rec.base, 'top\nmiddle\nbottom\n')
  assert.match(rec.reason, /the test says no/)
  assert.equal(read(p.dirB, 'same.txt'), 'top\nmiddle (alice)\nbottom\n', "the session's version is on bob's disk")
  assert.equal(read(p.dirA, 'same.txt'), 'top\nmiddle (alice)\nbottom\n', 'alice is not disturbed')
  assert.equal(read(path.join(p.dirB, '.quilt', 'merges', rec.id), 'ours'), 'top\nmiddle (bob)\nbottom\n')
  await waitFor(() => p.A.mergeList().some((m) => m.id === rec.id)) // alice sees the record too
})

test('the AI merges overlapping edits when it can, and the result is listed for review', async (t) => {
  const p = await pair(t, { 'ai.txt': 'top\nmiddle\nbottom\n' })
  await waitFor(() => read(p.dirB, 'ai.txt') === 'top\nmiddle\nbottom\n')
  const answer = path.join(tmp('answer'), 'merged.txt')
  fs.writeFileSync(answer, 'top\nmiddle (bob and alice)\nbottom\n')
  const log = path.join(tmp('log'), 'calls.txt')
  process.env.MERGE_FAKE_ANSWER = answer
  process.env.MERGE_FAKE_LOG = log
  t.after(() => { delete process.env.MERGE_FAKE_ANSWER; delete process.env.MERGE_FAKE_LOG })
  const B = await rejoinAfter(t, p, { bob: { 'ai.txt': 'top\nmiddle (bob)\nbottom\n' }, alice: { 'ai.txt': 'top\nmiddle (alice)\nbottom\n' } })
  await waitFor(() => read(p.dirA, 'ai.txt') === 'top\nmiddle (bob and alice)\nbottom\n' && read(p.dirB, 'ai.txt') === 'top\nmiddle (bob and alice)\nbottom\n')
  const rec = B.mergeList().find((m) => m.path === 'ai.txt')
  assert.equal(rec.kind, 'ai')
  assert.equal(rec.state, 'open')
  const prompt = fs.readFileSync(log, 'utf8')
  assert.match(prompt, /middle \(bob\)/)
  assert.match(prompt, /middle \(alice\)/)
  assert.match(prompt, /alice/)
})

test('an AI merge is still applied when its local copies cannot be written, so its record is true', async (t) => {
  const p = await pair(t, { 'aidisk.txt': 'top\nmiddle\nbottom\n' })
  await waitFor(() => read(p.dirB, 'aidisk.txt') === 'top\nmiddle\nbottom\n')
  const answer = path.join(tmp('answer'), 'merged.txt')
  fs.writeFileSync(answer, 'top\nmiddle (bob and alice)\nbottom\n')
  process.env.MERGE_FAKE_ANSWER = answer
  const real = Session.prototype.writeMergeFiles
  Session.prototype.writeMergeFiles = function () { throw new Error('disk full (test)') }
  t.after(() => { delete process.env.MERGE_FAKE_ANSWER; Session.prototype.writeMergeFiles = real })
  const B = await rejoinAfter(t, p, { bob: { 'aidisk.txt': 'top\nmiddle (bob)\nbottom\n' }, alice: { 'aidisk.txt': 'top\nmiddle (alice)\nbottom\n' } })
  await waitFor(() => read(p.dirA, 'aidisk.txt') === 'top\nmiddle (bob and alice)\nbottom\n' && read(p.dirB, 'aidisk.txt') === 'top\nmiddle (bob and alice)\nbottom\n')
  const rec = B.mergeList().find((m) => m.path === 'aidisk.txt')
  assert.equal(rec.kind, 'ai')
  assert.equal(rec.ours, 'top\nmiddle (bob)\nbottom\n', 'the record still has the offline version for review')
  assert.equal(fs.existsSync(path.join(p.dirB, '.quilt', 'conflicts')), false, 'not set aside as a failed merge')
})

test('a merge interrupted by quitting keeps its base, and the next start merges from it', async (t) => {
  const p = await pair(t, { 'quit.txt': 'top\nmiddle\nbottom\n' })
  await waitFor(() => read(p.dirB, 'quit.txt') === 'top\nmiddle\nbottom\n')
  const log = path.join(tmp('log'), 'calls.txt')
  process.env.MERGE_FAKE_LOG = log
  process.env.MERGE_FAKE_DELAY_MS = '1500'
  t.after(() => { delete process.env.MERGE_FAKE_LOG; delete process.env.MERGE_FAKE_DELAY_MS })
  const B1 = await rejoinAfter(t, p, { bob: { 'quit.txt': 'top\nmiddle (bob)\nbottom\n' }, alice: { 'quit.txt': 'top\nmiddle (alice)\nbottom\n' } })
  // The relay has synced and the AI is thinking: bob quits now.
  await waitFor(() => fs.existsSync(log))
  await close(B1)
  const held = JSON.parse(read(path.join(p.dirB, '.quilt'), 'merging.json'))
  assert.deepEqual(held, { 'quit.txt': 'top\nmiddle\nbottom\n' })
  delete process.env.MERGE_FAKE_DELAY_MS
  const B2 = await open(t, p.dirB, 'bob', { room: p.room })
  const rec = await waitFor(() => B2.mergeList().find((m) => m.path === 'quit.txt'))
  assert.equal(rec.base, 'top\nmiddle\nbottom\n', 'the base from before, not the session version the saved doc took')
  assert.equal(rec.ours, 'top\nmiddle (bob)\nbottom\n')
  assert.equal(read(p.dirA, 'quit.txt'), 'top\nmiddle (alice)\nbottom\n', "bob's edit was not pushed raw over alice's")
  await waitFor(() => read(path.join(p.dirB, '.quilt'), 'merging.json') === null)
})

test('an AI merge is not applied when the session changed the file again while the AI ran', async (t) => {
  const p = await pair(t, { 'moving.txt': 'top\nmiddle\nbottom\n' })
  await waitFor(() => read(p.dirB, 'moving.txt') === 'top\nmiddle\nbottom\n')
  const answer = path.join(tmp('answer'), 'merged.txt')
  fs.writeFileSync(answer, 'top\nmiddle (bob and alice)\nbottom\n')
  const log = path.join(tmp('log'), 'calls.txt')
  process.env.MERGE_FAKE_ANSWER = answer
  process.env.MERGE_FAKE_LOG = log
  process.env.MERGE_FAKE_DELAY_MS = '1500'
  t.after(() => { delete process.env.MERGE_FAKE_ANSWER; delete process.env.MERGE_FAKE_LOG; delete process.env.MERGE_FAKE_DELAY_MS })
  const B = await rejoinAfter(t, p, { bob: { 'moving.txt': 'top\nmiddle (bob)\nbottom\n' }, alice: { 'moving.txt': 'top\nmiddle (alice)\nbottom\n' } })
  await waitFor(() => fs.existsSync(log)) // the AI is thinking
  const latest = 'top\nmiddle (alice, again)\nbottom\n'
  write(p.dirA, 'moving.txt', latest)
  await waitFor(() => B.sharedKey('moving.txt') === latest)
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'moving.txt'), 5000)
  assert.equal(rec.kind, 'conflict')
  assert.match(rec.reason, /changed it again while the AI was merging/)
  assert.equal(rec.ours, 'top\nmiddle (bob)\nbottom\n')
  await waitFor(() => read(p.dirB, 'moving.txt') === latest)
  assert.equal(read(p.dirA, 'moving.txt'), latest, "alice's latest edit is not undone")
  assert.equal(p.A.sharedKey('moving.txt'), latest)
})

test('a large file the session deleted while away is not downloaded, and nothing crashes', async (t) => {
  const p = await pair(t)
  assert.equal(p.B.blobs.get('gone.bin'), undefined)
  await p.B.mergeOffline({ entries: [], take: [], downloads: ['gone.bin'] })
  await new Promise((resolve) => setImmediate(resolve)) // an unhandled rejection would surface here
})

test('a merge that fails part way keeps ours in conflicts, puts the session version back, and forgets its base', async (t) => {
  const p = await pair(t, { 'boom.txt': 'top\nmiddle\nbottom\n' })
  await waitFor(() => read(p.dirB, 'boom.txt') === 'top\nmiddle\nbottom\n')
  const real = Session.prototype.writeMergeFiles
  Session.prototype.writeMergeFiles = function () { throw new Error('disk full (test)') }
  t.after(() => { Session.prototype.writeMergeFiles = real })
  const B = await rejoinAfter(t, p, { bob: { 'boom.txt': 'top\nmiddle (bob)\nbottom\n' }, alice: { 'boom.txt': 'top\nmiddle (alice)\nbottom\n' } })
  await waitFor(() => read(p.dirB, 'boom.txt') === 'top\nmiddle (alice)\nbottom\n')
  const conflicts = path.join(p.dirB, '.quilt', 'conflicts')
  const kept = fs.readdirSync(conflicts).map((d) => read(path.join(conflicts, d), 'boom.txt'))
  assert.deepEqual(kept, ['top\nmiddle (bob)\nbottom\n'])
  // Set aside, it no longer waits to be merged: no stale base is left for the next start.
  assert.equal(read(path.join(p.dirB, '.quilt'), 'merging.json'), null)
  assert.equal(read(p.dirA, 'boom.txt'), 'top\nmiddle (alice)\nbottom\n', "bob's version was not pushed")
  assert.equal(B.merging.size, 0)
})

test('a file claimed while bob was away becomes a claimed merge', async (t) => {
  const p = await pair(t, { 'later.txt': 'original\n' })
  await waitFor(() => read(p.dirB, 'later.txt') === 'original\n')
  await close(p.B)
  await p.A.claim('later.txt', 'mine now')
  const B = await rejoinAfter(t, { ...p, B: p.B }, { bob: { 'later.txt': 'original\nbob\n' }, alice: { 'later.txt': 'original, alice\n' } })
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'later.txt'))
  assert.equal(rec.kind, 'claimed')
  assert.equal(rec.claimedBy, 'alice')
  assert.equal(read(p.dirB, 'later.txt'), 'original, alice\n')
})

test('a file claimed while bob was away, but not changed, still becomes a claimed merge', async (t) => {
  const p = await pair(t, { 'quiet.txt': 'original\n' })
  await waitFor(() => read(p.dirB, 'quiet.txt') === 'original\n')
  await close(p.B)
  await p.A.claim('quiet.txt', 'about to work on it')
  const B = await rejoinAfter(t, p, { bob: { 'quiet.txt': 'original\nbob\n' } })
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'quiet.txt'))
  assert.equal(rec.kind, 'claimed')
  assert.equal(rec.claimedBy, 'alice')
  assert.equal(rec.ours, 'original\nbob\n')
  assert.equal(read(p.dirB, 'quiet.txt'), 'original\n')
  assert.equal(read(p.dirA, 'quiet.txt'), 'original\n')
  assert.equal(fs.existsSync(path.join(p.dirB, '.quilt', 'rejected')), false, 'not dumped in rejected')
})

test('a file deleted offline but changed in the session is a conflict, and stays', async (t) => {
  const p = await pair(t, { 'gone.txt': 'keep me\n' })
  await waitFor(() => read(p.dirB, 'gone.txt') === 'keep me\n')
  const B = await rejoinAfter(t, p, { bob: { 'gone.txt': null }, alice: { 'gone.txt': 'keep me, edited\n' } })
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'gone.txt'))
  assert.equal(rec.kind, 'conflict')
  assert.equal(rec.ours, null)
  assert.equal(read(p.dirB, 'gone.txt'), 'keep me, edited\n')
  assert.equal(read(p.dirA, 'gone.txt'), 'keep me, edited\n')
})

test('a file changed offline but deleted in the session is a conflict; ours waits in .quilt/merges', async (t) => {
  const p = await pair(t, { 'bye.txt': 'original\n' })
  await waitFor(() => read(p.dirB, 'bye.txt') === 'original\n')
  const B = await rejoinAfter(t, p, { bob: { 'bye.txt': 'original, plus bob\n' }, alice: { 'bye.txt': null } })
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'bye.txt'))
  assert.equal(rec.ours, 'original, plus bob\n')
  assert.equal(rec.theirsHash, null)
  assert.equal(read(p.dirB, 'bye.txt'), null, 'the session deleted it, so it is gone until someone chooses it')
  assert.equal(read(path.join(p.dirB, '.quilt', 'merges', rec.id), 'ours'), 'original, plus bob\n')
})

test('a binary changed on both sides is a conflict without asking the AI', async (t) => {
  const bin = (n) => Buffer.from([0, 1, 2, n, 0, 255])
  const p = await pair(t)
  fs.writeFileSync(path.join(p.dirA, 'pic.bin'), bin(3))
  await waitFor(() => fs.existsSync(path.join(p.dirB, 'pic.bin')))
  await close(p.B)
  fs.writeFileSync(path.join(p.dirB, 'pic.bin'), bin(4))
  fs.writeFileSync(path.join(p.dirA, 'pic.bin'), bin(5))
  await waitFor(() => p.A.blobs.get('pic.bin')?.hash !== undefined && Buffer.from(p.A.blobs.get('pic.bin').data, 'base64').equals(bin(5)))
  const B = await open(t, p.dirB, 'bob', { room: p.room })
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'pic.bin'))
  assert.equal(rec.binary, true)
  assert.equal(rec.ours, null)
  assert.ok(fs.readFileSync(path.join(p.dirB, 'pic.bin')).equals(bin(5)))
  assert.ok(fs.readFileSync(path.join(p.dirB, '.quilt', 'merges', rec.id, 'ours')).equals(bin(4)))
})

test('offline edits to a file someone else claimed wait as a claimed merge', async (t) => {
  const p = await pair(t, { 'locked.txt': 'original\n' })
  await waitFor(() => read(p.dirB, 'locked.txt') === 'original\n')
  await p.A.claim('locked.txt', 'mine for now')
  await waitFor(() => p.B.claimFor('locked.txt'))
  const B = await rejoinAfter(t, p, { bob: { 'locked.txt': 'original\nbob added this\n' }, alice: { 'locked.txt': 'original, alice\n' } })
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'locked.txt'))
  assert.equal(rec.kind, 'claimed')
  assert.equal(rec.claimedBy, 'alice')
  assert.equal(read(p.dirB, 'locked.txt'), 'original, alice\n')
  assert.equal(fs.existsSync(path.join(p.dirB, '.quilt', 'rejected')), false, 'not dumped in rejected any more')
})

test('a file only bob changed offline is pushed, not merged', async (t) => {
  const p = await pair(t, { 'solo.txt': 'one\n' })
  await waitFor(() => read(p.dirB, 'solo.txt') === 'one\n')
  const B = await rejoinAfter(t, p, { bob: { 'solo.txt': 'one\ntwo\n' } })
  await waitFor(() => read(p.dirA, 'solo.txt') === 'one\ntwo\n')
  assert.deepEqual(B.mergeList(), [])
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
  assert.equal(fs.existsSync(path.join(dirB, '.quilt', 'conflicts')), false, 'the stale copy is not kept as a conflict')
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
  assert.equal(notes.removed, 1, 'deleting a file removes its lines')
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

/** A room where bob has an open conflict on same.txt. */
async function conflicted (t) {
  const p = await pair(t, { 'same.txt': 'top\nmiddle\nbottom\n' })
  await waitFor(() => read(p.dirB, 'same.txt') === 'top\nmiddle\nbottom\n')
  const B = await rejoinAfter(t, p, { bob: { 'same.txt': 'top\nmiddle (bob)\nbottom\n' }, alice: { 'same.txt': 'top\nmiddle (alice)\nbottom\n' } })
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'same.txt'))
  return { ...p, B, rec }
}

test('keep mine writes my version everywhere and closes the record', async (t) => {
  const { A, B, dirA, dirB, rec } = await conflicted(t)
  const done = B.resolveMerge(rec.id, { how: 'mine' })
  assert.equal(done.state, 'done')
  assert.equal(done.how, 'mine')
  assert.equal(done.resolvedBy, 'bob')
  await waitFor(() => read(dirA, 'same.txt') === 'top\nmiddle (bob)\nbottom\n' && read(dirB, 'same.txt') === 'top\nmiddle (bob)\nbottom\n')
  await waitFor(() => A.mergeList().find((m) => m.id === rec.id)?.state === 'done')
  assert.throws(() => B.resolveMerge(rec.id, { how: 'theirs' }), /already/)
})

test('keep theirs leaves the session version and closes the record', async (t) => {
  const { B, dirB, rec } = await conflicted(t)
  B.resolveMerge(rec.id, { how: 'theirs' })
  assert.equal(read(dirB, 'same.txt'), 'top\nmiddle (alice)\nbottom\n')
  assert.equal(B.mergeList().find((m) => m.id === rec.id).state, 'done')
})

test('the other person can resolve it too, from the record alone', async (t) => {
  const { A, B, dirA, rec } = await conflicted(t)
  await waitFor(() => A.mergeList().some((m) => m.id === rec.id))
  A.resolveMerge(rec.id, { how: 'mine' })
  await waitFor(() => read(dirA, 'same.txt') === 'top\nmiddle (bob)\nbottom\n')
  await waitFor(() => B.mergeList().find((m) => m.id === rec.id)?.resolvedBy === 'alice')
})

test('edit by hand puts markers in the file; saving it without them closes the record', async (t) => {
  const { A, B, dirA, dirB, rec } = await conflicted(t)
  B.resolveMerge(rec.id, { how: 'hand' })
  const marked = 'top\n<<<<<<< mine (bob)\nmiddle (bob)\n=======\nmiddle (alice)\n>>>>>>> session (alice)\nbottom\n'
  await waitFor(() => read(dirB, 'same.txt') === marked && read(dirA, 'same.txt') === marked)
  assert.equal(B.mergeList().find((m) => m.id === rec.id).state, 'editing')
  write(dirB, 'same.txt', 'top\nmiddle (both)\nbottom\n')
  await waitFor(() => B.mergeList().find((m) => m.id === rec.id)?.state === 'done')
  assert.equal(B.mergeList().find((m) => m.id === rec.id).how, 'hand')
  await waitFor(() => read(dirA, 'same.txt') === 'top\nmiddle (both)\nbottom\n')
})

test('send to a tool writes the three versions and a prompt; the agent then marks it resolved', async (t) => {
  const { B, dirB, rec } = await conflicted(t)
  const { prompt, dir } = B.prepareMergeSend(rec.id)
  assert.equal(dir, path.join(dirB, '.quilt', 'merges', rec.id))
  assert.equal(read(dir, 'base'), 'top\nmiddle\nbottom\n')
  assert.equal(read(dir, 'ours'), 'top\nmiddle (bob)\nbottom\n')
  assert.equal(read(dir, 'theirs'), 'top\nmiddle (alice)\nbottom\n')
  assert.equal(read(dir, 'PROMPT.md'), prompt)
  assert.match(prompt, /same\.txt/)
  assert.match(prompt, /quilt_resolve_merge/)
  assert.match(prompt, new RegExp(rec.id))
  write(dirB, 'same.txt', 'top\nmiddle (agent)\nbottom\n')
  const done = B.resolveMerge(rec.id, { how: 'agent' })
  assert.equal(done.state, 'done')
})

test('keep mine on a file someone else claimed is refused', async (t) => {
  const p = await pair(t, { 'locked.txt': 'original\n' })
  await waitFor(() => read(p.dirB, 'locked.txt') === 'original\n')
  await p.A.claim('locked.txt', 'mine')
  await waitFor(() => p.B.claimFor('locked.txt'))
  const B = await rejoinAfter(t, p, { bob: { 'locked.txt': 'bob\n' }, alice: { 'locked.txt': 'alice\n' } })
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'locked.txt'))
  assert.throws(() => B.resolveMerge(rec.id, { how: 'mine' }), /claimed by alice/)
  await p.A.release('*')
  await waitFor(() => B.claims.size === 0)
  B.resolveMerge(rec.id, { how: 'mine' })
  await waitFor(() => read(p.dirA, 'locked.txt') === 'bob\n')
})

test('an AI merge listed for review is closed with "review"', async (t) => {
  const p = await pair(t, { 'ai.txt': 'top\nmiddle\nbottom\n' })
  await waitFor(() => read(p.dirB, 'ai.txt') === 'top\nmiddle\nbottom\n')
  const answer = path.join(tmp('answer'), 'merged.txt')
  fs.writeFileSync(answer, 'top\nmiddle (both)\nbottom\n')
  process.env.MERGE_FAKE_ANSWER = answer
  t.after(() => { delete process.env.MERGE_FAKE_ANSWER })
  const B = await rejoinAfter(t, p, { bob: { 'ai.txt': 'top\nmiddle (bob)\nbottom\n' }, alice: { 'ai.txt': 'top\nmiddle (alice)\nbottom\n' } })
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'ai.txt' && m.kind === 'ai'))
  assert.equal(B.resolveMerge(rec.id, { how: 'review' }).state, 'done')
})

test('a viewer sees a merge but cannot settle it, not even as reviewed', async (t) => {
  const { B, dirB, rec } = await conflicted(t)
  B.access = { state: 'approved', role: 'viewer' } // as the relay sets it for a view-only member
  for (const how of ['mine', 'theirs', 'hand', 'agent', 'review']) assert.throws(() => B.resolveMerge(rec.id, { how }), /only view/)
  assert.equal(B.mergeList().find((m) => m.id === rec.id).state, 'open')
  assert.equal(read(dirB, 'same.txt'), 'top\nmiddle (alice)\nbottom\n')
})

test('a crafted merge record for an ignored or unsafe path never touches the disk', async (t) => {
  const { A, B, dirB } = await pair(t)
  write(dirB, '.env', 'SECRET=mine\n')
  const crafted = (id, fields) => ({ id, by: 'alice', byId: null, others: [], ts: Date.now(), kind: 'conflict', state: 'open', ours: null, base: null, theirsHash: null, binary: false, local: false, oursDeleted: false, claimedBy: null, resolvedBy: null, how: null, doneTs: null, reason: null, ...fields })
  A.doc.transact(() => {
    A.merges.set('a000000000000001', crafted('a000000000000001', { path: '.env', ours: 'SECRET=pwned\n' }))
    A.merges.set('a000000000000002', crafted('a000000000000002', { path: '.env.local', oursDeleted: true }))
    A.merges.set('a000000000000003', crafted('a000000000000003', { path: '.git/hooks/pre-commit', ours: '#!/bin/sh\necho pwned\n' }))
  })
  await waitFor(() => B.mergeList().length === 2)
  assert.deepEqual(B.mergeList().map((m) => m.path).sort(), ['.env', '.env.local'], 'a .git path is not even listed')
  for (const how of ['mine', 'theirs', 'hand']) {
    assert.throws(() => B.resolveMerge('a000000000000001', { how }), /not synced/)
    assert.throws(() => B.resolveMerge('a000000000000002', { how }), /not synced/)
  }
  assert.throws(() => B.resolveMerge('a000000000000003', { how: 'mine' }), /no such merge/)
  assert.throws(() => B.prepareMergeSend('a000000000000001'), /not synced/)
  assert.equal(read(dirB, '.env'), 'SECRET=mine\n')
  assert.equal(fs.existsSync(path.join(dirB, '.git')), false)
  // It can still be dismissed, which only closes the record.
  assert.equal(B.resolveMerge('a000000000000001', { how: 'review' }).state, 'done')
  assert.equal(read(dirB, '.env'), 'SECRET=mine\n')
})

const readBuf =(dir, rel) => { try { return fs.readFileSync(path.join(dir, rel)) } catch { return null } }
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel))
/** rejoinAfter for one binary file (rejoinAfter compares the shared text, which a binary has none of). */
async function rejoinAfterBinary (t, p, rel, bob, alice) {
  const before = p.A.sharedKey(rel)
  await close(p.B)
  bob === null ? fs.rmSync(path.join(p.dirB, rel)) : write(p.dirB, rel, bob)
  write(p.dirA, rel, alice)
  await waitFor(() => p.A.sharedKey(rel) !== before)
  return rejoinAfter(t, p)
}

test('keep mine on a file deleted offline deletes it everywhere (and its empty folder)', async (t) => {
  const p = await pair(t, { 'sub/gone.txt': 'one\ntwo\n' })
  await waitFor(() => read(p.dirB, 'sub/gone.txt') === 'one\ntwo\n')
  const B = await rejoinAfter(t, p, { bob: { 'sub/gone.txt': null }, alice: { 'sub/gone.txt': 'one\ntwo (alice)\n' } })
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'sub/gone.txt'))
  assert.equal(rec.oursDeleted, true)
  assert.match(B.mergePromptFor(rec), /offline\) — deleted/)
  assert.throws(() => B.resolveMerge(rec.id, { how: 'hand' }), /markers only work/)
  await waitFor(() => read(p.dirB, 'sub/gone.txt') === 'one\ntwo (alice)\n') // the session's version came back
  assert.equal(B.resolveMerge(rec.id, { how: 'mine' }).state, 'done')
  assert.ok(!exists(p.dirB, 'sub'), 'the emptied folder goes too')
  await waitFor(() => !exists(p.dirA, 'sub/gone.txt'))
  assert.equal(B.sharedKey('sub/gone.txt'), undefined)
})

test('keep mine on a large text file deleted offline deletes it, though its base was too big for the record', async (t) => {
  const big = 'line\n'.repeat(50_000) // 250 KB: over the record's 200 KB cap
  const p = await pair(t, { 'big.txt': big })
  await waitFor(() => read(p.dirB, 'big.txt') === big)
  const B = await rejoinAfter(t, p, { bob: { 'big.txt': null }, alice: { 'big.txt': big + 'more\n' } })
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'big.txt'))
  assert.equal(rec.local, true)
  assert.equal(rec.oursDeleted, true)
  B.resolveMerge(rec.id, { how: 'mine' })
  await waitFor(() => !exists(p.dirA, 'big.txt') && !exists(p.dirB, 'big.txt'))
})

test('keep mine on a binary writes my bytes everywhere; elsewhere it is refused, as are markers', async (t) => {
  const p = await pair(t, { 'pic.bin': Buffer.from([0, 1, 2, 3]) })
  await waitFor(() => readBuf(p.dirB, 'pic.bin')?.equals(Buffer.from([0, 1, 2, 3])))
  const mine = Buffer.from([0, 9, 9, 9])
  const B = await rejoinAfterBinary(t, p, 'pic.bin', mine, Buffer.from([0, 7, 7, 7]))
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'pic.bin'))
  assert.equal(rec.binary, true)
  assert.equal(rec.oursDeleted, false)
  await waitFor(() => p.A.mergeList().some((m) => m.id === rec.id))
  assert.throws(() => p.A.resolveMerge(rec.id, { how: 'mine' }), /bob's version of pic\.bin is only in the merge folder on their computer/)
  assert.throws(() => B.resolveMerge(rec.id, { how: 'hand' }), /markers only work/)
  B.resolveMerge(rec.id, { how: 'mine' })
  await waitFor(() => readBuf(p.dirA, 'pic.bin')?.equals(mine) && readBuf(p.dirB, 'pic.bin')?.equals(mine))
})

test('keep mine on a binary deleted offline deletes it on both machines', async (t) => {
  const p = await pair(t, { 'pic.bin': Buffer.from([0, 1, 2, 3]) })
  await waitFor(() => readBuf(p.dirB, 'pic.bin')?.equals(Buffer.from([0, 1, 2, 3])))
  const B = await rejoinAfterBinary(t, p, 'pic.bin', null, Buffer.from([0, 7, 7, 7]))
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'pic.bin'))
  assert.equal(rec.binary, true)
  assert.equal(rec.oursDeleted, true)
  B.resolveMerge(rec.id, { how: 'mine' })
  await waitFor(() => !exists(p.dirA, 'pic.bin') && !exists(p.dirB, 'pic.bin'))
})

test('keep theirs when the session deleted the file leaves it deleted; markers are refused', async (t) => {
  const p = await pair(t, { 'old.txt': 'a\nb\n' })
  await waitFor(() => read(p.dirB, 'old.txt') === 'a\nb\n')
  const B = await rejoinAfter(t, p, { bob: { 'old.txt': 'a\nb (bob)\n' }, alice: { 'old.txt': null } })
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'old.txt'))
  assert.equal(rec.theirsHash, null)
  assert.throws(() => B.resolveMerge(rec.id, { how: 'hand' }), /markers only work/)
  assert.equal(B.resolveMerge(rec.id, { how: 'theirs' }).state, 'done')
  assert.ok(!exists(p.dirB, 'old.txt') && !exists(p.dirA, 'old.txt'))
  assert.equal(read(path.join(B.mergeDir(rec.id)), 'ours'), 'a\nb (bob)\n', 'mine is still in the merge folder')
})

test('while a file is being edited by hand, keep theirs, markers again and Send to are refused; keep mine is not', async (t) => {
  const { A, B, dirA, rec } = await conflicted(t)
  B.resolveMerge(rec.id, { how: 'hand' })
  await waitFor(() => A.mergeList().find((m) => m.id === rec.id)?.state === 'editing')
  for (const s of [A, B]) {
    assert.throws(() => s.resolveMerge(rec.id, { how: 'theirs' }), /conflict markers in it/)
    assert.throws(() => s.resolveMerge(rec.id, { how: 'hand' }), /conflict markers in it/)
    assert.throws(() => s.prepareMergeSend(rec.id), /conflict markers in it/)
  }
  assert.equal(A.resolveMerge(rec.id, { how: 'mine' }).state, 'done')
  await waitFor(() => read(dirA, 'same.txt') === 'top\nmiddle (bob)\nbottom\n')
})

test('deleting a file being edited by hand settles its merge', async (t) => {
  const { B, dirB, rec } = await conflicted(t)
  B.resolveMerge(rec.id, { how: 'hand' })
  await waitFor(() => (read(dirB, 'same.txt') || '').includes('<<<<<<< mine (bob)'))
  fs.rmSync(path.join(dirB, 'same.txt'))
  await waitFor(() => B.mergeList().find((m) => m.id === rec.id)?.state === 'done')
  assert.equal(B.mergeList().find((m) => m.id === rec.id).how, 'hand')
})
