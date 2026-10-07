// Task board overflow: each column scrolls vertically inside a fixed board
// viewport; the column row scrolls horizontally when columns hit their min width.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const css = fs.readFileSync(path.join(root, 'src/ui/app.css'), 'utf8')
const boardJs = fs.readFileSync(path.join(root, 'src/ui/board.js'), 'utf8')
const sessionJs = fs.readFileSync(path.join(root, 'src/ui/session.js'), 'utf8')

function rule (selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${esc}\\s*\\{([^}]*)\\}`)
  const m = css.match(re)
  assert.ok(m, `missing CSS rule ${selector}`)
  return m[1]
}

test('board markup keeps a per-column scroll container', () => {
  assert.match(boardJs, /class="board"/)
  assert.match(boardJs, /class="board-cols"/)
  assert.match(boardJs, /class="board-col"/)
  assert.match(boardJs, /class="board-list"/)
  // Cards are rendered inside .board-list so column overflow scrolls there.
  assert.match(boardJs, /class="board-list">\$\{body\}/)
})

test('CSS pins the board viewport and lets each column list scroll', () => {
  const board = rule('.board')
  assert.match(board, /flex:\s*1/)
  assert.match(board, /min-height:\s*0/)
  assert.match(board, /overflow:\s*hidden/)

  assert.match(rule('.board-head'), /flex:\s*none/)

  const cols = rule('.board-cols')
  assert.match(cols, /min-height:\s*0/)
  assert.match(cols, /grid-template-rows:\s*minmax\(0,\s*1fr\)/)
  assert.match(cols, /grid-template-columns:\s*repeat\(4,\s*minmax\(320px,\s*1fr\)\)/)
  assert.match(cols, /overflow-x:\s*auto/)
  assert.match(cols, /overflow-y:\s*hidden/)

  const col = rule('.board-col')
  assert.match(col, /min-width:\s*320px/)
  assert.match(col, /min-height:\s*0/)
  assert.match(col, /overflow:\s*hidden/)

  const list = rule('.board-list')
  assert.match(list, /flex:\s*1/)
  assert.match(list, /min-height:\s*0/)
  assert.match(list, /overflow-y:\s*auto/)
  // Sideways gestures over cards must chain to .board-cols, so lists never
  // trap x: hidden overflow and y-only overscroll containment.
  assert.match(list, /overflow-x:\s*hidden/)
  assert.match(list, /overscroll-behavior-y:\s*contain/)
  assert.doesNotMatch(list, /overscroll-behavior:\s*contain/)

  assert.match(rule('.ws'), /overflow:\s*hidden/)
})

test('columns keep a min width and the board scrolls horizontally', () => {
  const cols = rule('.board-cols')
  assert.match(cols, /minmax\(320px,\s*1fr\)/)
  assert.match(cols, /overflow-x:\s*auto/)
  assert.match(rule('.board-col'), /min-width:\s*320px/)
  // Narrow phones still stack and may shrink below the desktop min width.
  assert.match(css, /@media \(max-width:\s*900px\)[^{]*\{[\s\S]*?\.board-col\s*\{[^}]*min-width:\s*0/)
})


test('repainting the board keeps horizontal and per-column scroll', () => {
  // Status ticks repaint the board every few seconds; without this the row
  // snapped back to the first column mid-scroll.
  const m = sessionJs.match(/if \(w\.mode === 'tasks'\) \{([\s\S]*?)\n  \}/)
  assert.ok(m, 'tasks branch of renderMain')
  const branch = m[1]
  assert.match(branch, /html === lastBoard\.html/)
  assert.ok(branch.indexOf('boardScroll(el)') < branch.indexOf('el.innerHTML = html'), 'scroll saved before repaint')
  assert.ok(branch.indexOf('restoreBoardScroll(el, scroll)') > branch.indexOf('el.innerHTML = html'), 'scroll restored after repaint')
  assert.match(sessionJs, /function boardScroll[\s\S]*?cols\.scrollLeft[\s\S]*?list\.scrollTop/)
  assert.match(sessionJs, /function restoreBoardScroll[\s\S]*?cols\.scrollLeft = scroll\.left[\s\S]*?list\.scrollTop = top/)
})

test('a plain mouse wheel can move the column row sideways', () => {
  assert.match(sessionJs, /el\.addEventListener\('wheel', boardWheel, \{ passive: false \}\)/)
  const fn = sessionJs.match(/function boardWheel \(e\) \{([\s\S]*?)\n\}/)
  assert.ok(fn, 'boardWheel')
  // Leaves scrollable lists, pinch-zoom, shift-wheel and the stacked layout alone.
  assert.match(fn[1], /e\.ctrlKey/)
  assert.match(fn[1], /e\.shiftKey/)
  assert.match(fn[1], /list\.scrollHeight > list\.clientHeight/)
  assert.match(fn[1], /cols\.scrollHeight > cols\.clientHeight/)
  assert.match(fn[1], /cols\.scrollLeft \+= dy/)
})
