// The task board always fits: columns that can't sit side by side fold to a strip.
// foldPlan decides which stay open for a width, your choices and the task counts.
import { test } from 'node:test'
import assert from 'node:assert/strict'

globalThis.location = { search: '' }
globalThis.sessionStorage = { getItem () { return null }, setItem () {} }
globalThis.history = { replaceState () {} }
globalThis.window = { addEventListener () {} }

const { foldPlan, renderBoard, BOARD_COL, BOARD_STRIP, BOARD_GAP } = await import('../../src/ui/board.js')

// The room needed for n open columns beside 4 - n strips.
const room = (n) => n * BOARD_COL + (4 - n) * BOARD_STRIP + 3 * BOARD_GAP
const busy = { todo: 11, doing: 2, qa: 3, done: 3 }

test('as many columns open as fit beside the strips; all four when there is room', () => {
  assert.deepEqual(foldPlan({ room: room(4), counts: busy }).open, ['doing', 'qa', 'todo', 'done'])
  assert.equal(foldPlan({ room: room(4) - 1, counts: busy }).open.length, 3)
  assert.equal(foldPlan({ room: room(2), counts: busy }).open.length, 2)
  assert.equal(foldPlan({ room: room(2) - 1, counts: busy }).open.length, 1)
  assert.equal(foldPlan({ room: room(1), counts: busy }).layout, 'row')
})

test('too narrow for one column beside three strips, the board stacks with one open', () => {
  const plan = foldPlan({ room: room(1) - 1, counts: busy })
  assert.equal(plan.layout, 'stack')
  assert.deepEqual(plan.open, ['doing'])
})

test('before you choose, the work in flight stays open, and empty columns give way', () => {
  assert.deepEqual(foldPlan({ room: room(2), counts: busy }).open, ['doing', 'qa'])
  // Nothing in progress or in QA: To do and Done get the room instead.
  assert.deepEqual(foldPlan({ room: room(2), counts: { todo: 4, doing: 0, qa: 0, done: 1 } }).open, ['todo', 'done'])
  // An empty board still opens the in-flight order.
  assert.deepEqual(foldPlan({ room: room(1), counts: {} }).open, ['doing'])
})

test('the columns you opened last stay open; the least recent folds first', () => {
  assert.deepEqual(foldPlan({ room: room(1), counts: busy, picked: ['todo'] }).open, ['todo'])
  assert.deepEqual(foldPlan({ room: room(2), counts: busy, picked: ['done', 'todo'] }).open, ['done', 'todo'])
  // Opened ones come first, then the in-flight order fills the rest.
  assert.deepEqual(foldPlan({ room: room(3), counts: busy, picked: ['done'] }).open, ['done', 'doing', 'qa'])
})

test('a column you fold stays folded at any width, but one is always open', () => {
  const wide = foldPlan({ room: room(4) + 500, counts: busy, folded: ['done'] })
  assert.deepEqual(wide.open, ['doing', 'qa', 'todo'])
  assert.deepEqual(wide.folded, ['done'])
  const all = foldPlan({ room: room(4), counts: busy, picked: ['qa'], folded: ['todo', 'doing', 'qa', 'done'] })
  assert.deepEqual(all.open, ['qa'], 'everything folded: the most recent one opens')
})

test('unknown column ids from an old save are ignored', () => {
  const plan = foldPlan({ room: room(2), counts: busy, picked: ['backlog', 'qa'], folded: ['archive'] })
  assert.deepEqual(plan.open, ['qa', 'doing'])
  assert.deepEqual(plan.folded, [])
  assert.deepEqual(plan.order, ['qa', 'doing', 'todo', 'done'])
})

test('each column carries its strip (name and count, opens it) and a fold button', () => {
  const html = renderBoard([
    { id: 'a1', title: 'One', column: 'qa', order: 1 },
    { id: 'a2', title: 'Two', column: 'qa', order: 2 }
  ], 'Dana')
  const qa = html.match(/<section class="board-col" data-column="qa"[\s\S]*?<\/section>/)[0]
  assert.match(qa, /tabindex="-1"/)
  assert.match(qa, /<button type="button" class="board-strip" data-unfold="qa" title="Open QA" aria-label="Open QA, 2 tasks">/)
  assert.match(qa, /<span class="board-strip-n" data-n="2">2<\/span><span class="board-strip-name">QA<\/span>/)
  assert.match(qa, /data-fold="qa"[^>]*aria-label="Fold QA"/)
  assert.match(html, /aria-label="Open To do, 0 tasks"/)
})
