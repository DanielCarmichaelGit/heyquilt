// A finished card shows what the agent verified; open cards never do, and the text is escaped.
import { test } from 'node:test'
import assert from 'node:assert/strict'

globalThis.location = { search: '' }
globalThis.sessionStorage = { getItem () { return null }, setItem () {} }
globalThis.history = { replaceState () {} }
globalThis.window = { addEventListener () {} } // common.js installs the error reporter at load

const { renderBoard } = await import('../../src/ui/board.js')
const task = (over) => ({ id: 'abcdef0123456789', title: 'Ship it', column: 'done', by: 'Duncan', assignee: '', forAi: false, tool: '', files: [], order: 1, ts: 1, verified: '', ...over })

test('the Done card carries the evidence line, escaped and clipped', () => {
  const html = renderBoard([task({ verified: 'npm test passed (612); launched the app, <board> rendered' })], 'Dana')
  const m = html.match(/<p class="task-verified"[^>]*>([^<]*)<\/p>/)
  assert.ok(m, 'evidence line present')
  assert.equal(m[1], 'npm test passed (612); launched the app, &lt;board&gt; rendered')
  const long = renderBoard([task({ verified: 'x'.repeat(300) })], 'Dana').match(/<p class="task-verified"[^>]*>([^<]*)<\/p>/)[1]
  assert.equal(long, `${'x'.repeat(157)}…`)
})

test('open cards and Done cards without evidence show nothing', () => {
  assert.doesNotMatch(renderBoard([task({ column: 'doing', verified: 'stale' })], 'Dana'), /task-verified/)
  assert.doesNotMatch(renderBoard([task()], 'Dana'), /task-verified/)
})

test('a QA card shows qaNotes; other columns never do, and the text is escaped', () => {
  const html = renderBoard([task({ column: 'qa', qaNotes: 'added <QA> column; npm test passed' })], 'Dana')
  const m = html.match(/<p class="task-qa-notes"[^>]*>([^<]*)<\/p>/)
  assert.ok(m, 'qa notes paragraph present')
  assert.match(m[1], /added &lt;QA&gt; column/)
  assert.doesNotMatch(renderBoard([task({ column: 'doing', qaNotes: 'stale' })], 'Dana'), /task-qa-notes/)
  assert.doesNotMatch(renderBoard([task({ column: 'done', verified: 'ok', qaNotes: 'stale' })], 'Dana'), /task-qa-notes/)
  assert.match(renderBoard([task({ column: 'qa' })], 'Dana'), /data-column="qa"/)
  assert.doesNotMatch(renderBoard([task({ column: 'qa' })], 'Dana'), /task-qa-notes/)
})

test('the board renders four columns including QA', () => {
  const html = renderBoard([], 'Dana')
  assert.match(html, /data-column="todo"/)
  assert.match(html, /data-column="doing"/)
  assert.match(html, /data-column="qa"/)
  assert.match(html, /data-column="done"/)
})
