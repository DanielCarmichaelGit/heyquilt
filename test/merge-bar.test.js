// The merge bar: a file someone else holds can't be settled or sent to an AI, so the bar
// offers to ask for it (or keep their version).
import { test } from 'node:test'
import assert from 'node:assert/strict'

globalThis.location = { search: '' }
globalThis.sessionStorage = { getItem () { return null }, setItem () {} }
globalThis.history = { replaceState () {} }
globalThis.window = { addEventListener () {} } // common.js installs the error reporter at load
globalThis.document = { activeElement: null }

const { mergeActionsHtml, renderMergeBar } = await import('../src/ui/merges.js')
const editors = [{ id: 'claude', name: 'Claude Code' }, { id: 'cursor', name: 'Cursor' }]
const merge = (over) => ({ id: 'e60dfd344811a6a8', path: 'RELEASES.md', by: 'Dana', others: ['Duncan'], via: 'pull', kind: 'claimed', claimedBy: 'Duncan', state: 'open', theirsHash: 'x', ...over })

test('a merge whose file someone else holds offers to ask for it, not to edit or send', () => {
  const html = mergeActionsHtml(merge({ heldBy: 'Duncan', asked: false }), 'Dana', editors)
  assert.match(html, /data-ask="RELEASES.md"[^>]*>Ask Duncan for it</)
  assert.match(html, /data-how="theirs"[^>]*>Keep Duncan's</)
  assert.doesNotMatch(html, /Edit by hand|Keep mine|Send to/)
})

test('once asked, the bar says so instead of asking again', () => {
  const html = mergeActionsHtml(merge({ heldBy: 'Duncan', asked: true }), 'Dana', editors)
  assert.match(html, /Asked Duncan for it/)
  assert.doesNotMatch(html, /data-ask=/)
})

test('once it is handed over (or nobody holds it), every way of settling is back', () => {
  const html = mergeActionsHtml(merge({}), 'Dana', editors)
  assert.match(html, /Keep mine/)
  assert.match(html, /Edit by hand/)
  assert.match(html, /Send to Claude Code/)
  assert.doesNotMatch(html, /data-ask=/)
})

test('a claimed merge says who holds the file now, and stops saying so once it is handed over', () => {
  const bar = (m) => { const el = { hidden: true, innerHTML: '', contains: () => false }; renderMergeBar(el, { merges: [m], me: 'Dana', editors }); return el.innerHTML }
  assert.match(bar(merge({ heldBy: 'Duncan' })), /but Duncan has it claimed/)
  assert.match(bar(merge({})), /while Duncan had it claimed/)
})
