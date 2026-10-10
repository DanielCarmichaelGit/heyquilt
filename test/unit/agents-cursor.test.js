import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { startCursorReader, findWorkspace, findWorkspaces } from '../../src/agents/cursor.js'

let sqlite = null
try { sqlite = await import('node:sqlite') } catch {}
const skip = !sqlite && 'node:sqlite not available'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function makeCursor () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-cursor-'))
  const userDir = path.join(root, 'User')
  const project = path.join(root, 'proj')
  const otherProject = path.join(root, 'other')
  fs.mkdirSync(project)
  const mkWs = (name, folder) => {
    const d = path.join(userDir, 'workspaceStorage', name)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(folder).href }))
    const db = new sqlite.DatabaseSync(path.join(d, 'state.vscdb'))
    db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
    return db
  }
  const wsDb = mkWs('aaa', project)
  const otherDb = mkWs('bbb', otherProject)
  fs.mkdirSync(path.join(userDir, 'globalStorage'), { recursive: true })
  const g = new sqlite.DatabaseSync(path.join(userDir, 'globalStorage', 'state.vscdb'))
  g.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
  g.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')

  const put = (db, table, key, value) => db.prepare(`INSERT INTO ${table} (key, value) VALUES (?, ?)`).run(key, JSON.stringify(value))
  const convs = {}
  const setComposers = (db, list) => put(db, 'ItemTable', 'composer.composerData', { allComposers: list })
  function addBubble (cid, bubbleId, bubble, db = wsDb) {
    convs[cid] = convs[cid] || []
    if (!convs[cid].includes(bubbleId)) convs[cid].push(bubbleId)
    put(g, 'cursorDiskKV', `bubbleId:${cid}:${bubbleId}`, { bubbleId, ...bubble })
    put(g, 'cursorDiskKV', `composerData:${cid}`, { _v: 3, composerId: cid, fullConversationHeadersOnly: convs[cid].map((b) => ({ bubbleId: b, type: 1 })) })
  }
  return { root, userDir, project, otherProject, wsDb, otherDb, g, put, setComposers, addBubble, mkWs }
}

test('finds the workspace for a folder', { skip }, () => {
  const c = makeCursor()
  assert.equal(findWorkspace(c.userDir, c.project), path.join(c.userDir, 'workspaceStorage', 'aaa'))
  assert.equal(findWorkspace(c.userDir, path.join(c.root, 'nope')), null)
})

test('maps bubbles for this folder only, then follows live updates', { skip }, async () => {
  const c = makeCursor()
  const t0 = Date.now()
  c.addBubble('c1', 'b1', { type: 1, text: 'Make the header sticky' })
  c.addBubble('c1', 'b2', { type: 2, text: 'Done, I updated the CSS.', toolFormerData: { name: 'edit_file', rawArgs: JSON.stringify({ target_file: 'src/header.css' }) } })
  c.setComposers(c.wsDb, [{ composerId: 'c1', lastUpdatedAt: t0 }])
  c.addBubble('x1', 'bx', { type: 1, text: 'other project secret' }, c.otherDb)
  c.setComposers(c.otherDb, [{ composerId: 'x1', lastUpdatedAt: t0 }])

  const entries = []
  const states = []
  let clock = t0
  const r = startCursorReader({ dir: c.project, userDir: c.userDir, pollMs: 20, now: () => clock, onEntries: (e) => entries.push(...e), onState: (s) => states.push(s) })
  await wait(100)
  assert.deepEqual(entries.map((e) => [e.kind, e.text]), [
    ['prompt', 'Make the header sticky'],
    ['reply', 'Done, I updated the CSS.'],
    ['action', 'Edited src/header.css']
  ])
  assert.ok(entries.every((e) => e.conv === 'c1' && e.tool === 'Cursor'))

  // A new prompt and a streaming reply: the reply is only shared once it settles.
  clock += 1000
  c.addBubble('c1', 'b3', { type: 1, text: 'Now make it blue' })
  c.addBubble('c1', 'b4', { type: 2, text: 'Work' })
  c.setComposers(c.wsDb, [{ composerId: 'c1', lastUpdatedAt: clock }])
  await wait(100)
  assert.equal(entries.at(-1).text, 'Now make it blue')
  assert.equal(states.at(-1).status, 'working')
  c.addBubble('c1', 'b4', { type: 2, text: 'Working on it: made it blue.' })
  c.setComposers(c.wsDb, [{ composerId: 'c1', lastUpdatedAt: clock + 1 }])
  await wait(100)
  assert.equal(entries.at(-1).text, 'Now make it blue', 'still streaming')
  clock += 5000
  await wait(100)
  assert.equal(entries.at(-1).text, 'Working on it: made it blue.')
  clock += 20000
  await wait(100)
  assert.equal(states.at(-1).status, 'idle')
  r.stop()
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length)
})

test('old conversations are not backfilled', { skip }, async () => {
  const c = makeCursor()
  c.addBubble('old', 'o1', { type: 1, text: 'from last week' })
  c.setComposers(c.wsDb, [{ composerId: 'old', lastUpdatedAt: Date.now() - 7 * 86400e3 }])
  const entries = []
  const r = startCursorReader({ dir: c.project, userDir: c.userDir, pollMs: 20, onEntries: (e) => entries.push(...e), onState: () => {} })
  await wait(80)
  r.stop()
  assert.equal(entries.length, 0)
})

test('an unrecognized layout reports unavailable instead of crashing', { skip }, async () => {
  const c = makeCursor()
  c.g.exec('DROP TABLE cursorDiskKV')
  c.setComposers(c.wsDb, [{ composerId: 'c1', lastUpdatedAt: Date.now() }])
  const states = []
  const logs = []
  startCursorReader({ dir: c.project, userDir: c.userDir, pollMs: 20, onEntries: () => {}, onState: (s) => states.push(s), onLog: (l) => logs.push(l) })
  await wait(80)
  assert.equal(states.at(-1).status, 'unavailable')
  assert.match(states.at(-1).reason, /layout isn't recognized/)
  assert.equal(logs.length, 1)
})

test('no Cursor install: stays idle quietly', { skip }, async () => {
  const states = []
  const r = startCursorReader({ dir: os.tmpdir(), userDir: path.join(os.tmpdir(), 'no-cursor-here'), pollMs: 20, onEntries: () => {}, onState: (s) => states.push(s) })
  await wait(60)
  r.stop()
  assert.deepEqual(states.map((s) => s.status), ['idle'])
})

function collect (c, opts = {}) {
  const entries = []
  const states = []
  const logs = []
  const r = startCursorReader({ dir: c.project, userDir: c.userDir, pollMs: 20, settleMs: 60, onEntries: (e) => entries.push(...e), onState: (s) => states.push(s), onLog: (l) => logs.push(l), ...opts })
  return { r, entries, states, logs, texts: () => entries.map((e) => e.text) }
}

test('keeps following a conversation when the workspace list is not rewritten', { skip }, async () => {
  const c = makeCursor()
  c.addBubble('c1', 'b1', { type: 1, text: 'first' })
  c.setComposers(c.wsDb, [{ composerId: 'c1', lastUpdatedAt: Date.now() }])
  const f = collect(c)
  await wait(100)
  // Cursor streams a whole turn without touching composer.composerData.
  c.addBubble('c1', 'b2', { type: 2, text: 'Looking at it.' })
  c.addBubble('c1', 'b3', { type: 2, text: '', toolFormerData: { name: 'read_file', params: { target_file: 'a.ts' } } })
  c.addBubble('c1', 'b4', { type: 2, text: 'All done.' })
  await wait(250)
  f.r.stop()
  assert.deepEqual(f.texts(), ['first', 'Looking at it.', 'Read a.ts', 'All done.'])
})

test('a bubble listed before it is written is picked up once it exists', { skip }, async () => {
  const c = makeCursor()
  c.addBubble('c1', 'b1', { type: 1, text: 'hi' })
  c.setComposers(c.wsDb, [{ composerId: 'c1', lastUpdatedAt: Date.now() }])
  const f = collect(c)
  await wait(80)
  c.put(c.g, 'cursorDiskKV', 'composerData:c1', { _v: 3, fullConversationHeadersOnly: [{ bubbleId: 'b1' }, { bubbleId: 'b2' }, { bubbleId: 'b3' }] })
  c.put(c.g, 'cursorDiskKV', 'bubbleId:c1:b3', { bubbleId: 'b3', type: 2, text: 'second part' })
  await wait(150)
  c.put(c.g, 'cursorDiskKV', 'bubbleId:c1:b2', { bubbleId: 'b2', type: 2, text: 'first part' })
  await wait(200)
  f.r.stop()
  assert.deepEqual(f.texts().sort(), ['first part', 'hi', 'second part'])
})

test('a locked database is retried, not treated as a broken layout', { skip }, async () => {
  const c = makeCursor()
  c.addBubble('c1', 'b1', { type: 1, text: 'before' })
  c.setComposers(c.wsDb, [{ composerId: 'c1', lastUpdatedAt: Date.now() }])
  const f = collect(c)
  await wait(80)
  c.g.exec('BEGIN EXCLUSIVE')
  c.put(c.g, 'cursorDiskKV', 'bubbleId:c1:b2', { bubbleId: 'b2', type: 2, text: 'during the lock' })
  await wait(300)
  c.put(c.g, 'cursorDiskKV', 'composerData:c1', { _v: 3, fullConversationHeadersOnly: [{ bubbleId: 'b1' }, { bubbleId: 'b2' }, { bubbleId: 'b3' }] })
  c.put(c.g, 'cursorDiskKV', 'bubbleId:c1:b3', { bubbleId: 'b3', type: 1, text: 'after' })
  c.g.exec('COMMIT')
  await wait(250)
  f.r.stop()
  assert.ok(f.states.every((s) => s.status !== 'unavailable'), JSON.stringify(f.states))
  assert.deepEqual(f.texts(), ['before', 'during the lock', 'after'])
})

test('finds conversations in the global list (newer Cursor) and ignores other folders', { skip }, async () => {
  const c = makeCursor()
  c.addBubble('g1', 'b1', { type: 1, text: 'from the global list' })
  c.addBubble('x1', 'bx', { type: 1, text: 'other project secret' })
  c.put(c.g, 'ItemTable', 'composer.composerHeaders', {
    allComposers: [
      { composerId: 'g1', lastUpdatedAt: Date.now(), workspaceIdentifier: { id: 'aaa' } },
      { composerId: 'x1', lastUpdatedAt: Date.now(), workspaceIdentifier: { id: 'bbb' } }
    ]
  })
  const f = collect(c)
  await wait(100)
  f.r.stop()
  assert.deepEqual(f.texts(), ['from the global list'])
})

test('reads every Cursor workspace for the folder, not just the first one found', { skip }, async () => {
  const c = makeCursor()
  const stale = c.mkWs('000', c.project + path.sep)
  c.addBubble('s1', 'b1', { type: 1, text: 'old window' })
  c.setComposers(stale, [{ composerId: 's1', lastUpdatedAt: Date.now() }])
  c.addBubble('c1', 'b2', { type: 1, text: 'current window' })
  c.setComposers(c.wsDb, [{ composerId: 'c1', lastUpdatedAt: Date.now() }])
  assert.equal(findWorkspaces(c.userDir, c.project).length, 2)
  const f = collect(c)
  await wait(100)
  f.r.stop()
  assert.deepEqual(f.texts().sort(), ['current window', 'old window'])
})

test('quilt doctor reports what it sees without printing chat text', { skip }, async () => {
  const { doctor } = await import('../../src/doctor.js')
  const c = makeCursor()
  c.addBubble('c1', 'b1', { type: 1, text: 'my secret prompt' })
  c.addBubble('c1', 'b2', { type: 2, text: 'reply', toolFormerData: { name: 'edit_file' } })
  c.setComposers(c.wsDb, [{ composerId: 'c1', lastUpdatedAt: Date.now() }])
  const lines = []
  await doctor({ dir: c.project, cursorDir: c.userDir, print: (l) => lines.push(l) })
  const out = lines.join('\n')
  assert.match(out, /workspace folder\(s\) for this project: aaa/)
  assert.match(out, /1 conversation\(s\) in the workspace list/)
  assert.match(out, /2 message\(s\)/)
  assert.match(out, /you: 16 chars/)
  assert.match(out, /AI: 5 chars \(tool edit_file\)/)
  assert.doesNotMatch(out, /secret/)

  lines.length = 0
  await doctor({ dir: path.join(c.root, 'elsewhere'), cursorDir: c.userDir, print: (l) => lines.push(l) })
  assert.match(lines.join('\n'), /never opened this exact folder[\s\S]*proj/)
})

function addHeader (c, id, workspaceId, value, archived = 0) {
  c.g.exec(`CREATE TABLE IF NOT EXISTS composerHeaders (
    composerId TEXT, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER,
    isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER,
    value TEXT, subagentTypeName TEXT
  )`)
  c.g.prepare(`DELETE FROM composerHeaders WHERE composerId = ?`).run(id)
  const ts = Date.now()
  c.g.prepare(`INSERT INTO composerHeaders
    (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value, subagentTypeName)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, '')`).run(id, workspaceId, ts, ts, archived, ts, ts, JSON.stringify(value))
}

test('an unfinished run stays working through a long think', { skip }, async () => {
  const c = makeCursor()
  addHeader(c, 'live', 'aaa', { unfinishedRunAt: Date.now() })
  addHeader(c, 'elsewhere', 'bbb', { unfinishedRunAt: Date.now() })
  addHeader(c, 'archived', 'aaa', { unfinishedRunAt: Date.now() }, 1)
  const t0 = Date.now()
  let clock = t0
  const states = []
  const r = startCursorReader({
    dir: c.project, userDir: c.userDir, pollMs: 20, now: () => clock,
    onEntries: () => {}, onState: (s) => states.push(s.status)
  })
  await wait(120)
  assert.equal(states.at(-1), 'working')
  clock += 60000
  await wait(80)
  assert.equal(states.at(-1), 'working', 'a quiet think is still work')
  c.g.prepare(`UPDATE composerHeaders SET value = ? WHERE composerId = 'live'`).run(JSON.stringify({ composerId: 'live' }))
  clock += 15000
  await wait(120)
  r.stop()
  assert.equal(states.at(-1), 'idle')
})

test('growing thinking counts as work until it goes quiet', { skip }, async () => {
  const c = makeCursor()
  const t0 = Date.now()
  c.addBubble('c1', 'b1', { type: 1, text: 'think hard' })
  c.setComposers(c.wsDb, [{ composerId: 'c1', lastUpdatedAt: t0 }])
  let clock = t0
  const states = []
  const r = startCursorReader({
    dir: c.project, userDir: c.userDir, pollMs: 20, now: () => clock,
    onEntries: () => {}, onState: (s) => states.push(s.status)
  })
  await wait(80)
  clock += 1000
  c.addBubble('c1', 'b2', { type: 2, text: '', thinking: { text: 'starting' } })
  c.setComposers(c.wsDb, [{ composerId: 'c1', lastUpdatedAt: clock }])
  await wait(80)
  assert.equal(states.at(-1), 'working')
  clock += 1000
  c.addBubble('c1', 'b2', { type: 2, text: '', thinking: { text: 'starting to plan the change' } })
  await wait(80)
  assert.equal(states.at(-1), 'working', 'more thinking is still work')
  clock += 30000
  await wait(80)
  r.stop()
  assert.equal(states.at(-1), 'idle')
})
