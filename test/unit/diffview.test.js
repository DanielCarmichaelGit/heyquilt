// A file's Changes tab: history entries as coloured diffs, escaped, newest first as given.
import { test } from 'node:test'
import assert from 'node:assert/strict'

globalThis.location = { search: '' }
globalThis.sessionStorage = { getItem () { return null }, setItem () {} }
globalThis.history = { replaceState () {} }
globalThis.window = { addEventListener () {} }

const { diffLines, historyMarkup, rolledOff, changeCount } = await import('../../src/ui/diffview.js')

test('diff lines: added, removed and context lines, hunks read "Line N"', () => {
  const html = diffLines('@@ -3,3 +3,3 @@\n keep\n-old\n+new\n… (diff truncated)')
  assert.match(html, /<span class="ln hunk">Line 3<\/span>/)
  assert.match(html, /<span class="ln ctx"><i> <\/i>keep<\/span>/)
  assert.match(html, /<span class="ln del"><i>−<\/i>old<\/span>/)
  assert.match(html, /<span class="ln add"><i>\+<\/i>new<\/span>/)
  assert.match(html, /<span class="ln hunk">… \(diff truncated\)<\/span>/)
  // A new file's hunk starts at line 0 of the old text: it reads as line 1.
  assert.match(diffLines('@@ -0,0 +1,2 @@\n+a\n+b'), /Line 1</)
})

test('diff text is escaped', () => {
  const html = diffLines('@@ -1,1 +1,1 @@\n-<b>x</b>\n+<img src=x onerror=alert(1)>')
  assert.doesNotMatch(html, /<img|<b>/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
})

test('history: who, task, pulled and binary entries; nothing kept says so', () => {
  const entries = [
    { by: 'Dana', path: 'a.js', kind: 'edited', ts: Date.now(), added: 1, removed: 1, diff: '@@ -1,1 +1,1 @@\n-a\n+b', task: { id: 't1', title: 'Fix <login>' } },
    { by: 'Mo', path: 'a.js', kind: 'edited', ts: Date.now() - 1000, added: 0, removed: 0, diff: '', detail: '12 bytes' },
    { by: 'Mo', path: 'a.js', kind: 'created', ts: Date.now() - 2000, added: 1, removed: 0, diff: '@@ -0,0 +1,1 @@\n+a', pulled: true }
  ]
  const html = historyMarkup(entries, { who: (n) => n === 'Mo' ? 'you' : n })
  assert.equal(html.match(/class="chg-entry"/g).length, 3)
  assert.ok(html.indexOf('Dana') < html.indexOf('you'), 'in the order given (newest first)')
  assert.match(html, /For “Fix &lt;login&gt;”/)
  assert.match(html, /Not a text file \(12 bytes\)/)
  assert.match(html, /pulled from git/)
  assert.match(html, /<span class="add">\+1<\/span> <span class="del">−1<\/span>/)
  assert.match(historyMarkup([]), /No changes to this file are kept/)
})

// The history keeps a session's latest changes; the per-file totals count them all.
const old = Date.parse('2026-10-02T15:46:45Z')
const summary = { path: 'src/admit-policy.js', added: 40, removed: 2, by: [
  { name: 'Mo', added: 8, removed: 2, ts: Date.now() },
  { name: 'Duncan', added: 32, removed: 0, ts: old },
  { name: 'Duncan', added: 5, removed: 0, ts: old, pulled: true }
] }
const kept = [{ by: 'Mo', path: 'src/admit-policy.js', kind: 'edited', ts: Date.now(), added: 3, removed: 1, diff: '@@ -1,1 +1,1 @@\n-a\n+b' }]

test('who changed a file but has no history left for it: by person, and a git pull apart', () => {
  assert.deepEqual(rolledOff(kept, summary).map((b) => [b.name, !!b.pulled]), [['Duncan', false], ['Duncan', true]])
  // Line counts aren't compared: totals add up every save, the history keeps a burst's net diff.
  assert.deepEqual(rolledOff(kept, { by: [{ name: 'Mo', added: 99, removed: 99, ts: 1 }] }), [])
  assert.deepEqual(rolledOff([], null), [])
  assert.equal(changeCount(kept, summary), 3)
  assert.equal(changeCount([], summary), 3)
  assert.equal(changeCount(kept, null), 1)
})

test('the Changes tab lists what rolled off after the kept diffs, with its totals and no diff', () => {
  const html = historyMarkup(kept, { summary, who: (n) => n === 'Mo' ? 'you' : n })
  assert.ok(html.indexOf('class="chg-entry"') < html.indexOf('class="chg-gone"'), 'kept diffs first')
  assert.match(html, /<h4>Earlier changes without a diff<\/h4>/)
  const gone = html.slice(html.indexOf('class="chg-gone"'))
  assert.equal(gone.match(/<li>/g).length, 2)
  assert.match(gone, /<b>Duncan<\/b>[\s\S]*?<span class="add">\+32<\/span> <span class="del">−0<\/span>/)
  assert.match(gone, /<b>Duncan<\/b><span class="chg-kind pulled">pulled from git<\/span>/)
  assert.match(gone, /no longer kept/)
  // Nothing kept at all: no "no changes" note, the totals instead.
  const none = historyMarkup([], { summary })
  assert.doesNotMatch(none, /No changes to this file are kept/)
  assert.match(none, /<h4>Changes without a diff<\/h4>/)
  assert.equal(none.match(/<li>/g).length, 3)
})
