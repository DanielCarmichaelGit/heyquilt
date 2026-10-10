// Searching the task board: what a card's search text holds, and how a query matches it.
import { test } from 'node:test'
import assert from 'node:assert/strict'

globalThis.location = { search: '' }
globalThis.sessionStorage = { getItem () { return null }, setItem () {} }
globalThis.history = { replaceState () {} }
globalThis.window = { addEventListener () {} }

const { renderBoard, searchText, matchesSearch } = await import('../../src/ui/board.js')

const task = (over) => ({ id: 'abcdef0123456789', title: 'Fix the Login form', column: 'todo', by: 'Dana', assignee: '', forAi: false, tool: '', files: [], order: 1, ts: 1, verified: '', qaNotes: '', archived: false, ...over })

test('a card is searched by title, id, who it is for, who made it, files and notes', () => {
  const t = task({ assignee: 'Sam', forAi: true, tool: 'Cursor', files: ['src/auth/login.ts'], qaNotes: 'Checked on Safari', verified: 'npm test passes' })
  const text = searchText(t, 'Dana')
  for (const bit of ['fix the login form', 'abcdef0123456789', "sam's cursor", 'sam', 'cursor', 'you', 'dana', 'src/auth/login.ts', 'checked on safari', 'npm test passes']) {
    assert.ok(text.includes(bit), bit)
  }
  assert.equal(text, text.toLowerCase())
  assert.ok(searchText(task({ assignee: 'Dana' }), 'Dana').includes('you'), 'my tasks are found by "you"')
})

test('every word must match, in any order, any case', () => {
  const text = searchText(task({ assignee: 'Sam' }), 'Dana')
  assert.ok(matchesSearch(text, 'login'))
  assert.ok(matchesSearch(text, 'LOGIN sam'))
  assert.ok(matchesSearch(text, 'sam   form'), 'extra spaces are fine')
  assert.ok(matchesSearch(text, 'abcdef'), 'a ticket id prefix')
  assert.ok(!matchesSearch(text, 'login safari'))
  assert.ok(matchesSearch(text, ''), 'an empty search matches everything')
  assert.ok(matchesSearch(text, '   '))
})

test('the board has a search box, and every card carries its search text, escaped', () => {
  const html = renderBoard([task({ title: 'Fix <b>bold</b> "quotes"' })], 'Dana')
  assert.match(html, /<input id="board-search" type="search"[^>]*placeholder="Search tickets"/)
  assert.match(html, /<span class="board-search-n" aria-live="polite"><\/span>/)
  assert.match(html, /data-search="fix &lt;b&gt;bold&lt;\/b&gt; &quot;quotes&quot; abcdef0123456789/)
  // The archive has its own filter instead.
  const archived = renderBoard([task({ archived: true })], 'Dana', [], '', { archived: true })
  assert.doesNotMatch(archived, /id="board-search"/)
  assert.match(archived, /id="archive-filter"/)
})
