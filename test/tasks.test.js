// The shared task board: three columns on the session document, so two people
// see the same list.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { Session } from '../src/session.js'
import { renderStatus } from '../src/status.js'
import { addTask, updateTask, deleteTask, readTasks, publicTask, formatTasks, MAX_TASKS } from '../src/tasks.js'

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-tasks-'))

function person (name) {
  return new Session({ dir: dir(), server: 'ws://127.0.0.1:9', room: 'room', secret: 'pw', name })
}

function link (a, b) {
  a.doc.on('update', (u, origin) => { if (origin !== 'remote') Y.applyUpdate(b.doc, u, 'remote') })
  b.doc.on('update', (u, origin) => { if (origin !== 'remote') Y.applyUpdate(a.doc, u, 'remote') })
}

test('add, rename, move, reorder and delete', () => {
  const alice = person('alice')
  assert.throws(() => alice.addTask('   '), /say what the task is/)
  const fix = alice.addTask('  Fix   login  ')
  assert.equal(fix.title, 'Fix login')
  assert.equal(fix.column, 'todo')
  assert.equal(fix.by, 'alice')
  const notes = alice.addTask('Write notes')
  assert.deepEqual(alice.taskList().map((t) => t.title), ['Fix login', 'Write notes'])

  alice.updateTask({ id: fix.id, title: 'Fix the login form' })
  alice.updateTask({ id: fix.id, column: 'doing' })
  alice.updateTask({ id: notes.id, column: 'doing', before: fix.id })
  const doing = alice.taskList().filter((t) => t.column === 'doing')
  assert.deepEqual(doing.map((t) => t.title), ['Write notes', 'Fix the login form'])

  alice.updateTask({ id: fix.id, column: 'done' })
  assert.equal(alice.taskList().find((t) => t.id === fix.id).column, 'done')
  alice.deleteTask(notes.id)
  assert.equal(alice.taskList().length, 1)
  assert.throws(() => alice.deleteTask(notes.id), /no such task/)
  assert.throws(() => alice.updateTask({ id: fix.id, column: 'later' }), /To do, In progress, or Done/)
})

test('a task added on one side shows up on the other', () => {
  const alice = person('alice')
  const bob = person('bob')
  link(alice, bob)
  const task = alice.addTask('Ship the invite page')
  assert.equal(bob.taskList()[0].title, 'Ship the invite page')
  bob.updateTask({ id: task.id, column: 'done' })
  assert.equal(alice.taskList()[0].column, 'done')
  assert.equal(alice.taskList()[0].by, 'alice')
})

test('a malformed task is skipped, and a full board drops the oldest done task', () => {
  const doc = new Y.Doc()
  const map = doc.getMap('tasks')
  map.set('junk', { title: 'nope' })
  map.set('abcdabcdabcdabcd', { id: 'abcdabcdabcdabcd', title: 'ok', column: 'nope', by: 'a', order: 1, ts: 1 })
  assert.equal(readTasks(map).length, 0)
  assert.equal(publicTask(map.get('junk')), null)

  const alice = person('alice')
  for (let i = 0; i < MAX_TASKS; i++) alice.addTask(`task ${i}`)
  assert.throws(() => alice.addTask('one more'), /board is full/)
  const oldest = alice.taskList()[0]
  alice.updateTask({ id: oldest.id, column: 'done' })
  const extra = alice.addTask('one more')
  const left = alice.taskList()
  assert.equal(left.length, MAX_TASKS)
  assert.equal(left.some((t) => t.id === oldest.id), false)
  assert.equal(left.some((t) => t.id === extra.id), true)
})

test('a task can be assigned to a person or their AI, with the files it touches', () => {
  const alice = person('alice')
  alice.tool = 'Cursor'
  const fix = alice.addTask({ title: 'Fix login', assignee: 'me', files: ['./src/ui/session.js', 'src/ui/session.js'] })
  assert.equal(fix.assignee, 'alice')
  assert.equal(fix.forAi, false)
  assert.deepEqual(fix.files, ['src/ui/session.js'])

  const page = alice.addTask({ title: 'Pricing page', assignee: 'bob', forAi: true, tool: 'Claude Code', files: ['src/ui/home.js'] })
  assert.equal(page.assignee, 'bob')
  assert.equal(page.forAi, true)
  assert.equal(page.tool, 'Claude Code')

  const bob = person('bob')
  link(alice, bob)
  Y.applyUpdate(bob.doc, Y.encodeStateAsUpdate(alice.doc), 'remote')
  const seen = bob.taskList().find((t) => t.id === page.id)
  assert.equal(seen.assignee, 'bob')
  assert.equal(seen.forAi, true)
  assert.deepEqual(seen.files, ['src/ui/home.js'])
  bob.updateTask({ id: page.id, column: 'doing' })
  assert.equal(alice.taskList().find((t) => t.id === page.id).assignee, 'bob')
  assert.equal(alice.taskList().find((t) => t.id === page.id).column, 'doing')

  alice.updateTask({ id: page.id, assignee: '', files: [] })
  const cleared = bob.taskList().find((t) => t.id === page.id)
  assert.equal(cleared.assignee, '')
  assert.equal(cleared.forAi, false)
  assert.deepEqual(cleared.files, [])

  assert.throws(() => alice.addTask({ title: 'Nope', files: ['../secrets'] }), /not a project file/)
  alice.updateTask({ id: fix.id, assignee: 'me', forAi: true })
  const mine = alice.taskList().find((t) => t.id === fix.id)
  assert.equal(mine.assignee, 'alice')
  assert.equal(mine.forAi, true)
  assert.equal(mine.tool, 'Cursor')
})

test('an old task with no assignee still shows, and a bad one is skipped', () => {
  const doc = new Y.Doc()
  const map = doc.getMap('tasks')
  const old = { id: '0123456789abcdef', title: 'Legacy', column: 'todo', by: 'a', order: 1, ts: 1 }
  map.set(old.id, old)
  const read = readTasks(map)[0]
  assert.equal(read.assignee, '')
  assert.deepEqual(read.files, [])
  map.set('bbbbbbbbbbbbbbbb', { ...old, id: 'bbbbbbbbbbbbbbbb', files: ['../x'] })
  map.set('cccccccccccccccc', { ...old, id: 'cccccccccccccccc', assignee: 'bob', forAi: 'yes' })
  assert.equal(readTasks(map).length, 1)
})

test('agents are told which open tasks are theirs', () => {
  const alice = person('alice')
  alice.tool = 'Cursor'
  alice.addTask({ title: 'For me', assignee: 'alice' })
  const ai = alice.addTask({ title: 'For Cursor', assignee: 'alice', forAi: true, files: ['src/app.js'] })
  alice.addTask({ title: 'For bob', assignee: 'bob' })
  alice.updateTask({ id: ai.id, column: 'doing' })

  const forAi = formatTasks(alice.taskList(), { name: 'alice', tool: 'Cursor', asAi: true })
  assert.match(forAi, /^Yours — open tasks assigned to you \(your Cursor\):/)
  assert.match(forAi, new RegExp(`${ai.id}  For Cursor  \\(In progress\\)  \\[src/app.js\\]`))
  assert.match(forAi, /Open, but assigned to alice, not to you:/)
  assert.match(forAi, /For me/)
  assert.doesNotMatch(forAi.split('Open, but assigned')[0], /For bob/)

  const forAlice = formatTasks(alice.taskList(), { name: 'alice', tool: 'Cursor', asAi: false })
  assert.match(forAlice, /^Yours — open tasks assigned to you:/)
  assert.match(forAlice, /For me/)
  assert.match(forAlice, /Open, but assigned to your Cursor, not to you:/)

  const md = renderStatus(alice.status(), { asAi: true, mentionYours: true })
  assert.match(md, /\*\*Yours\*\* — your Cursor\n- For Cursor \(In progress\) · `src\/app.js`/)
  assert.match(md, /→ your Cursor/)
  const empty = renderStatus(person('bob').status(), { mentionYours: true })
  assert.match(empty, /No open tasks are assigned to you/)
})

test('an AI file edit becomes an in-progress task, and later edits extend it', () => {
  const alice = person('alice')
  const bob = person('bob')
  link(alice, bob)
  alice.tool = 'Cursor'
  alice.autoTasks = true
  const now = Date.now()

  assert.equal(alice.pushAgentEntries([
    { id: 'p', tool: 'Cursor', conv: 'c1', kind: 'prompt', text: 'Add a dark mode toggle\nUse the existing colors.', ts: now },
    { id: 'read', tool: 'Cursor', conv: 'c1', kind: 'action', text: 'Read src/ui/app.css', ts: now }
  ]), 2)
  assert.equal(alice.taskList().length, 0, 'a question or a read is not a task')

  alice.pushAgentEntries([
    { id: 'edit', tool: 'Cursor', conv: 'c1', kind: 'action', text: 'Edited src/ui/app.css', ts: now },
    { id: 'edit2', tool: 'Cursor', conv: 'c1', kind: 'action', text: 'Created src/ui/theme.js', ts: now }
  ])
  const task = alice.taskList()[0]
  assert.equal(task.title, 'Add a dark mode toggle')
  assert.equal(task.column, 'doing')
  assert.equal(task.by, 'alice')
  assert.equal(task.assignee, 'alice')
  assert.equal(task.forAi, true)
  assert.equal(task.tool, 'Cursor')
  assert.equal(task.conv, 'c1')
  assert.deepEqual(task.files, ['src/ui/app.css', 'src/ui/theme.js'])
  assert.equal(bob.taskList()[0].title, 'Add a dark mode toggle')

  alice.pushAgentEntries([{ id: 'edit3', tool: 'Cursor', conv: 'c1', kind: 'action', text: 'Deleted src/ui/old.css', ts: now }])
  const extended = alice.taskList().find((t) => t.id === task.id)
  assert.deepEqual(extended.files, ['src/ui/app.css', 'src/ui/theme.js', 'src/ui/old.css'])
  assert.equal(alice.taskList().length, 1)

  alice.updateTask({ id: task.id, title: 'Dark mode' })
  assert.equal(alice.taskList()[0].conv, 'c1', 'renaming keeps the chat attached')

  alice.addTask({ title: 'Fix login', files: ['src/login.js'] })
  alice.pushAgentEntries([
    { id: 'p2', tool: 'Cursor', conv: 'c2', kind: 'prompt', text: 'Fix the login form', ts: now },
    { id: 'e2', tool: 'Cursor', conv: 'c2', kind: 'action', text: 'Edited src/login.js', ts: now }
  ])
  assert.equal(alice.taskList().some((t) => t.conv === 'c2'), false, 'a file already on an open task is not a new task')

  alice.addTask({ title: 'Rename the button' })
  alice.pushAgentEntries([
    { id: 'p3', tool: 'Cursor', conv: 'c3', kind: 'prompt', text: 'Rename the button', ts: now },
    { id: 'e3', tool: 'Cursor', conv: 'c3', kind: 'action', text: 'Edited src/ui/button.js', ts: now }
  ])
  assert.equal(alice.taskList().filter((t) => t.title === 'Rename the button').length, 1)

  alice.pushAgentEntries([
    { id: 'p4', tool: 'Cursor', conv: 'c4', kind: 'prompt', text: 'Ancient request', ts: now - 60 * 60 * 1000 },
    { id: 'e4', tool: 'Cursor', conv: 'c4', kind: 'action', text: 'Edited src/old.js', ts: now - 60 * 60 * 1000 }
  ])
  assert.equal(alice.taskList().some((t) => t.conv === 'c4'), false, 'backfill does not create a task')
  alice.pushAgentEntries([{ id: 'e5', tool: 'Cursor', conv: 'c4', kind: 'action', text: 'Edited src/old.js', ts: now }])
  assert.equal(alice.taskList().find((t) => t.conv === 'c4').title, 'Ancient request')

  alice.updateTask({ id: alice.taskList().find((t) => t.conv === 'c4').id, column: 'done' })
  alice.pushAgentEntries([{ id: 'e6', tool: 'Cursor', conv: 'c4', kind: 'action', text: 'Edited src/newer.js', ts: now }])
  assert.equal(alice.taskList().filter((t) => t.conv === 'c4' && t.column === 'doing').length, 1)

  alice.setAgentSharing(false)
  alice.pushAgentEntries([
    { id: 'p5', tool: 'Cursor', conv: 'c5', kind: 'prompt', text: 'Private request', ts: now },
    { id: 'e7', tool: 'Cursor', conv: 'c5', kind: 'action', text: 'Edited src/secret.js', ts: now }
  ])
  assert.equal(alice.taskList().some((t) => t.conv === 'c5'), false)
  alice.setAgentSharing(true)
  alice.pushAgentEntries([{ id: 'e8', tool: 'Cursor', conv: 'c5', kind: 'action', text: 'Edited src/secret.js', ts: now }])
  assert.equal(alice.taskList().find((t) => t.conv === 'c5').title, 'Private request')
})

test('AI chats do not make tasks while auto tasks are paused', () => {
  const alice = person('alice')
  const now = Date.now()
  alice.pushAgentEntries([
    { id: 'p', tool: 'Cursor', conv: 'c1', kind: 'prompt', text: 'Add a dark mode toggle', ts: now },
    { id: 'e', tool: 'Cursor', conv: 'c1', kind: 'action', text: 'Edited src/ui/app.css', ts: now }
  ])
  assert.equal(alice.taskList().length, 0)
})

test('a full board does not swallow the AI chat entry', () => {
  const alice = person('alice')
  alice.autoTasks = true
  for (let i = 0; i < MAX_TASKS; i++) alice.addTask(`task ${i}`)
  const n = alice.pushAgentEntries([
    { id: 'p', tool: 'Cursor', conv: 'c', kind: 'prompt', text: 'One more', ts: Date.now() },
    { id: 'a', tool: 'Cursor', conv: 'c', kind: 'action', text: 'Edited src/x.js', ts: Date.now() }
  ])
  assert.equal(n, 2)
  assert.equal(alice.taskList().some((t) => t.conv === 'c'), false)
})

test('a bad chat id on a task is ignored', () => {
  const doc = new Y.Doc()
  const map = doc.getMap('tasks')
  const good = { id: '0123456789abcdef', title: 'Ok', column: 'todo', by: 'a', order: 1, ts: 1, conv: 'chat-1' }
  map.set(good.id, good)
  assert.equal(readTasks(map)[0].conv, 'chat-1')
  map.set('bbbbbbbbbbbbbbbb', { ...good, id: 'bbbbbbbbbbbbbbbb', conv: 'has\nnewline' })
  assert.equal(readTasks(map).length, 1)
})

test('status shows the three columns', () => {
  const alice = person('alice')
  const task = alice.addTask('Fix login')
  alice.updateTask({ id: task.id, column: 'doing' })
  const md = renderStatus(alice.status())
  assert.match(md, /## Tasks/)
  assert.match(md, /\*\*In progress\*\*\n- Fix login _\(you\)_/)
  assert.match(md, /\*\*To do\*\*\n_Nothing\._/)
  assert.match(md, /\*\*Done\*\*\n_Nothing\._/)
  const empty = person('bob')
  assert.match(renderStatus(empty.status()), /## Tasks\n_No tasks yet\._/)
})

test('verified: kept on a Done task, cleaned, shown to agents and people, cleared when the task leaves Done', () => {
  const alice = person('alice')
  const t = alice.addTask('Ship it')
  assert.equal(t.verified, '')
  alice.updateTask({ id: t.id, column: 'done', verified: '  npm test\r\npassed\u200b  (3 tests)\n\n\n\nopened the app ' })
  let now = alice.taskList().find((x) => x.id === t.id)
  assert.equal(now.verified, 'npm test\npassed (3 tests)\n\nopened the app')
  assert.match(formatTasks(alice.taskList(), { name: 'alice' }), /Ship it[^\n]*\n    verified: npm test passed \(3 tests\) opened the app/)
  assert.match(renderStatus(alice.status()), /verified: npm test passed/)
  // Reopening drops the old evidence; a fresh Done needs fresh evidence.
  alice.updateTask({ id: t.id, column: 'doing' })
  now = alice.taskList().find((x) => x.id === t.id)
  assert.equal(now.verified, '')
  assert.doesNotMatch(formatTasks(alice.taskList(), { name: 'alice' }), /verified:/)
  // A peer cannot push junk: an over-long or uncleaned value makes the task invalid.
  assert.equal(publicTask({ ...now, verified: 'x'.repeat(1001) }), null)
  assert.equal(publicTask({ ...now, verified: ' padded' }), null)
  assert.ok(publicTask({ ...now, verified: 'clean' }))
  assert.ok(publicTask((({ verified, ...rest }) => rest)(now)), 'older tasks without the field still read')
})
