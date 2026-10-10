// Task board overflow: each column scrolls vertically inside a fixed board
// viewport; columns that don't fit side by side fold to a strip (board-fold.test.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
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
  assert.match(boardJs, /class="board\$\{showArchived \? ' archived' : ''\}"/)
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
  assert.match(cols, /display:\s*flex/)
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

test('open columns share the width at 320px or more; a folded one is a 44px strip', () => {
  const col = rule('.board-col')
  assert.match(col, /flex:\s*1 1 0/)
  assert.match(col, /min-width:\s*320px/)
  assert.match(col, /transition:[^;]*flex-grow/)
  const folded = rule('.board-col.folded')
  assert.match(folded, /flex:\s*0 0 44px/)
  assert.match(folded, /min-width:\s*44px/)
  // The sizes session.js lays out by (foldPlan) are the ones the CSS draws.
  assert.match(boardJs, /export const BOARD_COL = 320\b/)
  assert.match(boardJs, /export const BOARD_STRIP = 44\b/)
  assert.match(boardJs, /export const BOARD_GAP = 10\b/)
  assert.match(rule('.board-cols'), /gap:\s*10px/)
  // A folded column shows its strip; an open one its heading and cards.
  assert.match(rule('.board-col.folded > .board-list, .board-col.folded > h3'), /visibility:\s*hidden/)
  assert.match(rule('.board-col.folded > .board-strip'), /visibility:\s*visible/)
})

test('stacked when narrow: one column open, the others as bars', () => {
  assert.match(rule('.board[data-layout="stack"] .board-cols'), /flex-direction:\s*column/)
  assert.match(rule('.board[data-layout="stack"] .board-col'), /min-width:\s*0/)
  assert.match(rule('.board[data-layout="stack"] .board-col.folded'), /flex:\s*0 0 40px/)
  // The board's head wraps by the board's own width, not the window's.
  assert.match(rule('.board'), /container:\s*board \/ inline-size/)
  // Search and Show sit behind Filter, so the head keeps one row until phone-narrow, then wraps.
  assert.match(css, /@container board \(max-width:\s*560px\)\s*\{\s*\.board-head\s*\{[^}]*flex-wrap:\s*wrap/)
  assert.match(css, /@container board \(max-width:\s*900px\)\s*\{[^}]*\.board-add-assign > label\s*\{\s*display:\s*none/)
  for (const [, block] of css.matchAll(/@media[^{]*width[^{]*\{([\s\S]*?)\n\}/g)) {
    assert.doesNotMatch(block, /\.board-(head|add|cols|col|list)\b[^{]*\{/, 'no window-width rules for the board')
  }
})

test('layout runs after every render and on resize; only your own open or fold animates', () => {
  const m = sessionJs.match(/if \(w\.mode === 'tasks'\) \{([\s\S]*?)\n  \}/)
  assert.ok(m, 'tasks branch of renderMain')
  assert.ok(m[1].indexOf('layoutBoard(el)') > m[1].indexOf('el.innerHTML = html'), 'laid out after the render')
  assert.ok(m[1].indexOf('layoutBoard(el)') < m[1].indexOf('restoreBoardScroll(el, scroll)'), 'before list scroll is restored')
  assert.match(sessionJs, /new ResizeObserver\([^\n]*layoutBoard\(el\)/)
  assert.match(sessionJs, /function layoutBoard \(root = \$\('#main'\), \{ animate = false \} = \{\}\)/)
  assert.match(sessionJs, /if \(!animate\) cols\.classList\.add\('still'\)/)
  assert.match(rule('.board-cols.still .board-col, .board-cols.still .board-col > *, .board-cols.still .board-col.folded > *'), /transition:\s*none/)
  assert.match(sessionJs, /function openColumn[\s\S]*?layoutBoard\(undefined, \{ animate: true \}\)/)
  assert.match(sessionJs, /function foldColumn[\s\S]*?layoutBoard\(undefined, \{ animate: true \}\)/)
  // A card dragged onto a strip opens that column after a moment; dropping on it moves the card there.
  assert.match(sessionJs, /col\.classList\.contains\('folded'\) && !unfoldTimer/)
  assert.match(sessionJs, /dragend[\s\S]*?cancelUnfold\(\)/)
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
