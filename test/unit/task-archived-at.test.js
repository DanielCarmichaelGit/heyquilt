// A task remembers when it was archived: the archived list shows it and sorts by it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { addTask, updateTask, readTasks, publicTask, MAX_TASKS } from '../../src/tasks.js'

const board = () => {
  const doc = new Y.Doc()
  return { doc, map: doc.getMap('tasks') }
}

test('archiving stamps the time; restoring or moving it back clears it', () => {
  const { doc, map } = board()
  const t = addTask(doc, map, { title: 'Old idea', by: 'Mo' })
  assert.equal(t.archivedAt, undefined)
  const before = Date.now()
  const shelved = updateTask(doc, map, { id: t.id, archived: true })
  assert.ok(shelved.archivedAt >= before && shelved.archivedAt <= Date.now())
  assert.equal(readTasks(map).find((x) => x.id === t.id).archivedAt, shelved.archivedAt, 'kept in the shared doc')
  // Other edits while archived keep the original time.
  assert.equal(updateTask(doc, map, { id: t.id, title: 'Old idea, renamed' }).archivedAt, shelved.archivedAt)
  assert.equal(updateTask(doc, map, { id: t.id, archived: false }).archivedAt, undefined)
  updateTask(doc, map, { id: t.id, archived: true })
  assert.equal(updateTask(doc, map, { id: t.id, column: 'doing' }).archivedAt, undefined, 'moving it brings it back')
})

test('a task archived before times were kept, or with a bad time, is still shown, without one', () => {
  const base = { id: 'abcdef0123456789', title: 'Ship it', column: 'done', by: 'Mo', order: 1, ts: 1, assignee: '', forAi: false, tool: '', files: [], conv: '', verified: '', qaNotes: '', recurring: false, cron: '' }
  assert.equal(publicTask({ ...base, archived: true }).archivedAt, undefined)
  assert.equal(publicTask({ ...base, archived: true, archivedAt: 'yesterday' }).archivedAt, undefined)
  assert.equal(publicTask({ ...base, archived: true, archivedAt: -5 }).archivedAt, undefined)
  assert.equal(publicTask({ ...base, archived: true, archivedAt: 1700000000000 }).archivedAt, 1700000000000)
  assert.equal(publicTask({ ...base, archived: false, archivedAt: 1700000000000 }).archivedAt, undefined, 'only an archived task has one')
})

test('a full board drops the task archived longest ago first', () => {
  const { doc, map } = board()
  const ids = []
  for (let i = 0; i < MAX_TASKS; i++) ids.push(addTask(doc, map, { title: `Task ${i}`, by: 'Mo' }).id)
  // The newest task archived first, the oldest one archived last.
  updateTask(doc, map, { id: ids[ids.length - 1], archived: true })
  const later = Date.now() + 5
  while (Date.now() < later) { /* a later archive time */ }
  updateTask(doc, map, { id: ids[0], archived: true })
  addTask(doc, map, { title: 'One more', by: 'Mo' })
  const left = readTasks(map).map((t) => t.id)
  assert.ok(!left.includes(ids[ids.length - 1]), 'archived longest ago: dropped')
  assert.ok(left.includes(ids[0]), 'archived just now: kept')
})
