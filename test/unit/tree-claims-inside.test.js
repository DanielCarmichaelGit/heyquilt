// A collapsed folder in the file tree shows the claims inside it, so a claim deep in the
// tree is seen in the sidebar without opening every folder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
globalThis.location = { search: '' }
globalThis.sessionStorage = { getItem () { return null }, setItem () {} }
globalThis.history = { replaceState () {} }
globalThis.window = { addEventListener () {} }

const { claimsInside, insideBadge } = await import('../../src/ui/tree.js')

const claims = [
  { by: 'Brandon', pattern: 'src/ui/loom.js', note: 'editing' },
  { by: 'Duncan', pattern: 'src/session.js', note: '' },
  { by: 'Brandon', pattern: 'src/ui', note: 'whole folder' }
]

test('claims inside a folder are the ones below it, not the folder claim itself', () => {
  assert.deepEqual(claimsInside(claims, 'src/ui').map((c) => c.pattern), ['src/ui/loom.js'])
  assert.deepEqual(claimsInside(claims, 'src').map((c) => c.pattern), ['src/ui/loom.js', 'src/session.js', 'src/ui'])
  assert.deepEqual(claimsInside(claims, 'test'), [])
  assert.deepEqual(claimsInside(claims, 'sr'), [])
})

test('the badge names one holder and counts the rest, with every claim in its tooltip', () => {
  const html = insideBadge(claimsInside(claims, 'src'), 'Duncan')
  assert.match(html, /class="t-badge claim inside"/)
  assert.match(html, /Brandon \+1/)
  assert.match(html, /src\/session\.js: you/)
  assert.equal(insideBadge([], 'Duncan'), '')
})
