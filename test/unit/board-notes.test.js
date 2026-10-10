// Eye icon opens a modal with the full ticket notes (QA and Done), escaped and not clipped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

globalThis.location = { search: '' }
globalThis.sessionStorage = { getItem () { return null }, setItem () {} }
globalThis.history = { replaceState () {} }
globalThis.window = { addEventListener () {} }

const { renderBoard, taskNotesModalHtml } = await import('../../src/ui/board.js')
const task = (over) => ({ id: 'abcdef0123456789', title: 'Ship it', column: 'qa', by: 'Duncan', assignee: '', forAi: false, tool: '', files: [], order: 1, ts: 1, verified: '', qaNotes: '', ...over })

test('every card has a notes-and-comments button: an eye with notes, a count with comments, dimmed with neither', () => {
  const withNotes = renderBoard([task({ qaNotes: 'added the modal' })], 'Dana')
  assert.match(withNotes, /data-task-notes/)
  assert.match(withNotes, /Notes and comments on Ship it/)
  assert.match(withNotes, /task-notes-btn on/)
  const bare = renderBoard([task()], 'Dana')
  assert.match(bare, /data-task-notes/, 'so the first comment can be added')
  assert.doesNotMatch(bare, /task-notes-btn on/)
  assert.doesNotMatch(bare, /task-count/)
  const talked = renderBoard([task({ comments: [{ id: 'a'.repeat(16), by: 'ChatGPT', text: 'Gave it to Duncan', ts: 1 }] })], 'Dana')
  assert.match(talked, /Notes and comments \(1\) on Ship it/)
  assert.match(talked, /<span class="task-count">1<\/span>/)
})

test('the modal lists comments with who wrote them, escaped, and a box to add one', () => {
  const html = taskNotesModalHtml(task({ comments: [{ id: 'a'.repeat(16), by: 'Chat<GPT>', text: 'Gave it to **Duncan**: he wrote the <parser>', ts: Date.now() }] }))
  assert.match(html, /<b>Chat&lt;GPT&gt;<\/b>/)
  assert.match(html, /<strong>Duncan<\/strong>/)
  assert.match(html, /he wrote the &lt;parser&gt;/)
  assert.match(html, /class="task-comment-form"/)
  assert.match(html, /aria-label="Comment on Ship it"/)
})

test('the notes modal shows the full text, keeps newlines, and escapes markup', () => {
  const notes = 'line one\nadded <script> and a "quote"\n' + 'y'.repeat(400)
  const html = taskNotesModalHtml(task({ title: 'See <notes>', qaNotes: notes, verified: 'npm test passed' }))
  assert.match(html, /id="task-notes-title">See &lt;notes&gt;/)
  assert.match(html, /QA notes/)
  assert.match(html, /Done notes/)
  assert.match(html, /class="task-notes-body md"/)
  assert.match(html, /<p>line one<br>added &lt;script&gt; and a &quot;quote&quot;<br>/)
  assert.match(html, new RegExp('y'.repeat(400)))
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /role="dialog"/)
  assert.match(html, /data-close-notes/)
})

test('a ticket with no notes or comments says so instead of inventing any', () => {
  const html = taskNotesModalHtml(task({ column: 'todo', title: 'Empty' }))
  assert.match(html, /No comments yet/)
  assert.doesNotMatch(html, /task-notes-body/)
  assert.doesNotMatch(html, /QA notes|Done notes/)
})

test('notes render markdown links and images, and do not run raw html', () => {
  const html = taskNotesModalHtml(task({
    qaNotes: 'See [Quilt](https://quilt.example/docs)\n\n![shot](https://cdn.example/shot.png)\n\n<img src=x onerror=alert(1)>'
  }))
  assert.match(html, /<a href="https:\/\/quilt\.example\/docs" target="_blank" rel="noopener noreferrer">Quilt<\/a>/)
  assert.match(html, /<img class="md-img" alt="shot" src="https:\/\/cdn\.example\/shot\.png" loading="lazy">/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(html, /<img src=x/)
})

test('only a repeating card shows the repeat icon (the ⋯ menu turns it on); it shows a readable schedule', () => {
  const off = renderBoard([task()], 'Dana')
  assert.doesNotMatch(off, /data-task-recur/)
  assert.doesNotMatch(off, /task-cron-form/)
  const on = renderBoard([task({ recurring: true, cron: '0 9 * * 1-5' })], 'Dana')
  assert.match(on, /aria-pressed="true"/)
  assert.match(on, /Weekdays at 9am/)
  assert.match(on, /value="0 9 \* \* 1-5"/)
  assert.match(on, /task-cron-form/)
  const midnight = renderBoard([task({ recurring: true, cron: '0 0 * * *' })], 'Dana')
  assert.match(midnight, /Every day at 12am/)
  assert.doesNotMatch(midnight, /<script>/)
})

test('the notes modal is wide and opens and closes with a transition', () => {
  const css = fs.readFileSync(new URL('../../src/ui/app.css', import.meta.url), 'utf8')
  const session = fs.readFileSync(new URL('../../src/ui/session.js', import.meta.url), 'utf8')
  assert.match(css, /\.task-notes-modal \{ width: min\(960px/)
  assert.match(css, /\.task-notes-back \{ opacity: 0; transition: opacity/)
  assert.match(css, /prefers-reduced-motion: reduce/)
  assert.match(session, /classList\.add\('is-open'\)/)
  assert.match(session, /prefers-reduced-motion/)
  assert.match(session, /transitionend/)
})

test('archived tasks leave the columns; the toggle shows them with Restore and Remove', () => {
  const live = task({ id: '1111111111111111', title: 'Live one', column: 'todo' })
  const old = task({ id: '2222222222222222', title: 'Shelved <one>', column: 'done', archived: true })
  const board = renderBoard([live, old], 'Dana')
  assert.match(board, /Live one/)
  assert.doesNotMatch(board, /Shelved/)
  // Rename, Archive and Remove live in the card's ⋯ menu, so the title keeps the row.
  assert.match(board, /data-task-more[^>]*aria-label="More for Live one"/)
  assert.doesNotMatch(board, /data-task-edit|data-task-archive|class="task-icon task-x"/)
  assert.match(board, /data-archived-toggle[^>]*>.*Archived.*board-n">1</s)
  assert.doesNotMatch(renderBoard([live], 'Dana'), /data-archived-toggle/, 'no toggle with nothing archived')

  const shelf = renderBoard([live, old], 'Dana', [], '', { archived: true })
  assert.doesNotMatch(shelf, /board-cols/)
  assert.doesNotMatch(shelf, /Live one/)
  assert.match(shelf, /Shelved &lt;one&gt;/)
  assert.match(shelf, /data-group="finished"/) // it was in Done (board-archive.test.js has the layout)
  assert.match(shelf, /Restore to Done/)
  assert.match(shelf, /data-task="2222222222222222"/)
  assert.match(shelf, /data-task-unarchive/)
  assert.match(shelf, /data-task-delete/)
  assert.match(shelf, /Back to the board/)
  // Asking for the archive with nothing in it shows the board.
  assert.match(renderBoard([live], 'Dana', [], '', { archived: true }), /board-cols/)
})

test('notes render a ---- line as a horizontal rule', () => {
  const html = taskNotesModalHtml(task({ qaNotes: 'Above\n\n----\n\nBelow' }))
  assert.match(html, /Above/)
  assert.match(html, /<hr class="md-hr">/)
  assert.match(html, /Below/)
})
