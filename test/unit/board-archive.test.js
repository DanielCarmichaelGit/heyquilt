// The archived tasks view: a filter in the head, Finished and Set aside groups,
// newest archived first, and a removal that asks first.
import { test } from 'node:test'
import assert from 'node:assert/strict'

globalThis.location = { search: '' }
globalThis.sessionStorage = { getItem () { return null }, setItem () {} }
globalThis.history = { replaceState () {} }
globalThis.window = { addEventListener () {} }

const { renderBoard, archivedWhen } = await import('../../src/ui/board.js')

let n = 0
const task = (over) => ({ id: (++n).toString(16).padStart(16, '0'), title: 'Task', column: 'todo', by: 'Dana', assignee: '', forAi: false, tool: '', files: [], order: n, ts: n, verified: '', qaNotes: '', archived: true, ...over })
const now = Date.now()
const shelf = (tasks, o = {}) => renderBoard([task({ archived: false, title: 'Live' }), ...tasks], 'Dana', [{ name: 'Sam', color: '#123456' }], '', { archived: true, ...o })

test('the head is for the archive: its count and a filter, not the add form', () => {
  const html = shelf([task({ title: 'Old', column: 'done' }), task({ title: 'Older', column: 'qa' })])
  assert.match(html, /<div class="board archived">/)
  assert.match(html, /<h2 class="board-title">Archived <span class="board-n">2<\/span><\/h2>/)
  assert.match(html, /<input id="archive-filter" type="search"[^>]*placeholder="Filter archived tasks"/)
  assert.doesNotMatch(html, /task-add-form/)
  assert.match(html, /Back to the board/)
  assert.match(html, /<p class="board-archive-none" hidden>No archived tasks match\.<\/p>/)
  // The board itself keeps its add form.
  assert.match(renderBoard([task({ archived: false })], 'Dana'), /task-add-form/)
})

test('Finished (archived from Done) before Set aside, each newest archived first', () => {
  const html = shelf([
    task({ title: 'Done long ago', column: 'done', archivedAt: now - 86400e3 * 3 }),
    task({ title: 'Done just now', column: 'done', archivedAt: now }),
    task({ title: 'Idea', column: 'todo', archivedAt: now - 60e3 }),
    task({ title: 'Half done', column: 'doing', archivedAt: now - 120e3 }),
    task({ title: 'Archived before dates were kept', column: 'qa' })
  ])
  const finished = html.slice(html.indexOf('data-group="finished"'), html.indexOf('data-group="aside"'))
  const aside = html.slice(html.indexOf('data-group="aside"'))
  assert.ok(html.indexOf('data-group="finished"') < html.indexOf('data-group="aside"'))
  assert.ok(finished.indexOf('Done just now') < finished.indexOf('Done long ago'), 'newest archived first')
  assert.ok(aside.indexOf('Idea') < aside.indexOf('Half done') && aside.indexOf('Half done') < aside.indexOf('before dates were kept'), 'one without a date last')
  assert.match(finished, /<span class="board-n" data-group-count>2<\/span>/)
  assert.match(aside, /<span class="board-n" data-group-count>3<\/span>/)
  // A group with nothing in it isn't shown.
  assert.doesNotMatch(shelf([task({ column: 'todo' })]), /data-group="finished"/)
})

test('a row: column chip or Verified, who it was for, who made it, when, and where Restore puts it', () => {
  const html = shelf([
    task({ title: 'Half done', column: 'doing', assignee: 'Sam', forAi: true, tool: 'Cursor', archivedAt: now - 120e3 }),
    task({ title: 'Shipped', column: 'done', verified: 'npm test passes', by: 'Sam' })
  ])
  assert.match(html, /<span class="arch-col" data-column="doing">In progress<\/span>/)
  assert.match(html, /<span class="arch-who"><i style="--c:#123456"><\/i>Sam&#39;s Cursor<\/span>|<span class="arch-who"><i style="--c:#123456"><\/i>Sam's Cursor<\/span>/)
  assert.match(html, /<span>by you<\/span>/)
  assert.match(html, /archived 2m ago/)
  assert.match(html, /Restore to In progress/)
  assert.match(html, /class="arch-verified" title="npm test passes"/)
  assert.match(html, /<span>by Sam<\/span>/)
  assert.match(html, /data-title="half done"/)
})

test('Remove asks first: the × only opens the question, which defaults to keeping it', () => {
  const html = shelf([task({ title: 'Shelved <one>' })])
  assert.match(html, /<button type="button" class="task-icon task-x" data-task-remove-ask[^>]*aria-label="Remove Shelved &lt;one&gt; for good"/)
  const confirm = html.slice(html.indexOf('class="arch-confirm"'))
  assert.match(confirm, /Remove for good\? It can't be brought back\./)
  assert.match(confirm, /data-task-delete>Remove<\/button>/)
  assert.match(confirm, /data-task-remove-cancel>Keep it<\/button>/)
  assert.equal(html.match(/data-task-delete/g).length, 1, 'the only delete is inside the question')
})

test('folded groups stay folded', () => {
  const html = shelf([task({ column: 'done' }), task({ column: 'todo' })], { closedGroups: ['finished'] })
  assert.match(html, /<details class="archive-group" data-group="finished">/)
  assert.match(html, /<details class="archive-group" data-group="aside" open>/)
})

test('when it was archived, in words', () => {
  assert.equal(archivedWhen(0), '')
  assert.equal(archivedWhen(undefined), '')
  assert.equal(archivedWhen(now), 'archived just now')
  assert.equal(archivedWhen(now - 5 * 60e3), 'archived 5m ago')
  assert.equal(archivedWhen(now - 3 * 3600e3), 'archived 3h ago')
  assert.equal(archivedWhen(Date.parse('2026-10-02T12:00:00Z')), `archived ${new Date(Date.parse('2026-10-02T12:00:00Z')).toLocaleDateString()}`)
})
