// The add form can name who a task is for before the card exists.
import { test } from 'node:test'
import assert from 'node:assert/strict'

globalThis.location = { search: '' }
globalThis.sessionStorage = { getItem () { return null }, setItem () {} }
globalThis.history = { replaceState () {} }
globalThis.window = { addEventListener () {} } // common.js installs the error reporter at load

const { renderBoard } = await import('../../src/ui/board.js')

function addAssign (html) {
  const start = html.indexOf('id="task-add-assign"')
  assert.ok(start > -1, 'add form has an assignee select')
  return html.slice(start, html.indexOf('</select>', start))
}

const people = [
  { name: 'Ada', tool: 'Cursor' },
  { name: 'Bea', tool: 'Claude Code' },
  { name: 'Bot', tool: 'Cursor', agent: true }
]

test('the add form lists you, your AI, and everyone else', () => {
  const sel = addAssign(renderBoard([], 'Ada', people))
  assert.match(sel, /<option value="" selected>Unassigned<\/option>/)
  assert.match(sel, /<option value="p:Ada">You<\/option>/)
  assert.match(sel, /<option value="a:Ada">Your Cursor<\/option>/)
  assert.match(sel, /<option value="p:Bea">Bea<\/option>/)
  assert.match(sel, /<option value="a:Bea">Bea&#39;s Claude Code<\/option>/)
  assert.match(sel, /<option value="p:Bot">Bot<\/option>/)
  assert.doesNotMatch(sel, /value="a:Bot"/)
})

test('a choice made before Add stays selected across a redraw', () => {
  const sel = addAssign(renderBoard([], 'Ada', people, 'a:Bea'))
  assert.match(sel, /<option value="a:Bea" selected>/)
  assert.doesNotMatch(sel, /<option value="" selected>/)
})

test('a name is escaped in the add form', () => {
  const sel = addAssign(renderBoard([], 'Ada', [{ name: 'A<da', tool: 'Cursor' }, { name: 'Ada', tool: 'Cursor' }]))
  assert.match(sel, /value="p:A&lt;da"/)
  assert.match(sel, />A&lt;da</)
})

// Show: whose tasks the board lists.
const { showsTask } = await import('../../src/ui/board.js')
const task = (id, title, over = {}) => ({ id: id.padEnd(16, '0'), title, column: 'todo', by: 'Ada', assignee: '', forAi: false, tool: '', files: [], order: 1, ts: 1, ...over })
const board = [
  task('a1', 'Nobody has this'),
  task('a2', 'Ada does this', { assignee: 'Ada' }),
  task('a3', 'Ada\'s Cursor does this', { assignee: 'Ada', forAi: true, tool: 'Cursor', column: 'doing' }),
  task('a4', 'Bea does this', { assignee: 'Bea', column: 'qa' }),
  task('a5', 'Duncan is away but has this', { assignee: 'Duncan' }),
  task('a6', 'Shelved, unassigned', { archived: true })
]
// The Show choices in the Filter panel: [value, label, count, picked].
const showSelect = (html) => html.slice(html.indexOf('class="board-filter-show"'), html.indexOf('</div>', html.indexOf('class="board-filter-show"')))
const opt = (value, label, n, picked = false) => `data-show-pick="${value}" aria-checked="${picked}"><span class="bf-name">${label}</span><span class="bf-n">${n}</span>`
const titles = (html) => [...html.matchAll(/class="task-title"[^>]*>([^<]*)</g)].map((m) => m[1].replace(/&#39;/g, "'"))

test('Show lists everyone, unassigned, each person and their AI, and anyone away who still has tasks, with counts', () => {
  const sel = showSelect(renderBoard(board, 'Ada', people))
  assert.ok(sel.includes(opt('', 'Everyone', 5, true)), 'archived tasks are not counted')
  assert.ok(sel.includes(opt('none', 'Unassigned', 1)))
  assert.ok(sel.includes(opt('p:Ada', 'You', 1)))
  assert.ok(sel.includes(opt('a:Ada', 'Your Cursor', 1)))
  assert.ok(sel.includes(opt('p:Bea', 'Bea', 1)))
  assert.ok(sel.includes(opt('a:Bea', 'Bea&#39;s Claude Code', 0)))
  assert.ok(sel.includes(opt('p:Duncan', 'Duncan', 1)))
  assert.doesNotMatch(sel, /data-show-pick="a:Bot"/, 'an agent has no AI of its own')
})

test('Show keeps only the chosen tasks, and the column counts follow', () => {
  assert.deepEqual(titles(renderBoard(board, 'Ada', people, '', { show: 'none' })), ['Nobody has this'])
  assert.deepEqual(titles(renderBoard(board, 'Ada', people, '', { show: 'p:Ada' })), ['Ada does this'])
  assert.deepEqual(titles(renderBoard(board, 'Ada', people, '', { show: 'a:Ada' })), ['Ada\'s Cursor does this'])
  assert.deepEqual(titles(renderBoard(board, 'Ada', people, '', { show: 'p:Duncan' })), ['Duncan is away but has this'])
  assert.equal(titles(renderBoard(board, 'Ada', people)).length, 5)
  const bea = renderBoard(board, 'Ada', people, '', { show: 'p:Bea' })
  assert.match(bea, /data-column="qa"[^]*?board-n">1</)
  assert.match(bea, /data-column="todo"[^]*?board-n">0</)
  assert.match(bea, /class="board-filter on"[^>]*data-show-label="Bea"/, 'the Filter button says it is hiding tasks, and whose it shows')
  assert.match(bea, /<span class="board-filter-label">Bea<\/span>/)
  assert.doesNotMatch(renderBoard(board, 'Ada', people), /board-filter on/)
  assert.ok(showSelect(bea).includes(opt('p:Bea', 'Bea', 1, true)))
})

test('Show of someone with no tasks and no longer here stays chosen, at 0', () => {
  const html = renderBoard(board, 'Ada', people, '', { show: 'p:Gone' })
  assert.ok(showSelect(html).includes(opt('p:Gone', 'Gone', 0, true)))
  assert.deepEqual(titles(html), [])
})

test('showsTask: a person is not their AI, and the reverse', () => {
  const mine = board[1]; const myAi = board[2]
  assert.equal(showsTask(mine, 'p:Ada'), true)
  assert.equal(showsTask(mine, 'a:Ada'), false)
  assert.equal(showsTask(myAi, 'a:Ada'), true)
  assert.equal(showsTask(myAi, 'p:Ada'), false)
  assert.equal(showsTask(board[0], 'none'), true)
  assert.equal(showsTask(mine, 'none'), false)
  assert.equal(showsTask(mine, ''), true)
})

test('a name in Show is escaped', () => {
  const sel = showSelect(renderBoard([task('b1', 'x', { assignee: 'A<b' })], 'Ada', []))
  assert.ok(sel.includes(opt('p:A&lt;b', 'A&lt;b', 1)))
})
