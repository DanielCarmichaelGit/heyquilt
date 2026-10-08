// The branch menu's markup (src/ui/branches.js): a branch over its size limit is marked
// "full" the same way "default" and "in the session" are.
import { test } from 'node:test'
import assert from 'node:assert/strict'

globalThis.location = { search: '' }
globalThis.sessionStorage = { getItem () { return null }, setItem () {} }
globalThis.history = { replaceState () {} }
globalThis.window = { addEventListener () {} } // common.js installs the error reporter at load

const { branchMenuHtml } = await import('../src/ui/branches.js')

const branch = (over) => ({ name: 'main', folders: [], ais: [], worktrees: [], hosted: [], upstream: null, last: null, session: true, default: true, ...over })

test('a full branch gets a "full" tag in the menu; one that is not stays plain', () => {
  const full = branchMenuHtml({ git: null, branches: [branch({ full: true })] })
  assert.match(full, /class="br-tag warn"[^>]*>full</)
  const notFull = branchMenuHtml({ git: null, branches: [branch({ full: false })] })
  assert.doesNotMatch(notFull, />full</)
})

test('the full tag sits alongside the default and in-the-session tags, not instead of them', () => {
  const html = branchMenuHtml({ git: null, branches: [branch({ full: true, session: true, default: true })] })
  assert.match(html, /<span class="br-tag">default<\/span>/)
  assert.match(html, /<span class="br-tag">in the session<\/span>/)
  assert.match(html, /<span class="br-tag warn"[^>]*>full<\/span>/)
})

test('a branch with no `full` field (older callers) renders with no full tag, not a crash', () => {
  const html = branchMenuHtml({ git: null, branches: [{ name: 'main', folders: [], ais: [], worktrees: [], hosted: [], upstream: null, last: null, session: false, default: false }] })
  assert.doesNotMatch(html, />full</)
})
