// The file tree's change card: a changed file's +/- in this session, who made them and when.
import { test } from 'node:test'
import assert from 'node:assert/strict'

globalThis.location = { search: '' }
globalThis.sessionStorage = { getItem () { return null }, setItem () {} }
globalThis.history = { replaceState () {} }
globalThis.window = { addEventListener () {} }

const { changeCardHtml } = await import('../../src/ui/tree.js')
const now = Date.now()
const file = (over) => ({ path: 'src/auth/login.ts', added: 14, removed: 3, kind: 'edited', ts: now, by: [], ...over })

test('the total, the path and a pointer to the diff', () => {
  const html = changeCardHtml(file({ by: [{ name: 'Dana', added: 14, removed: 3, ts: now }] }))
  assert.match(html, /<div class="tcard-path">src\/auth\/login\.ts<\/div>/)
  assert.match(html, /<div class="tcard-total"><span class="add">\+14<\/span> <span class="del">−3<\/span><span class="tcard-in">in this session<\/span>/)
  assert.match(changeCardHtml(file({ kind: 'created' })), /in this session · new file/)
})

test('the hint says what its Changes tab has: the diff, the latest diffs, or none kept', () => {
  const f = file({ by: [{ name: 'Dana', added: 14, removed: 3, ts: now }] })
  assert.match(changeCardHtml(f, { kept: 'all' }), /Click to open · its <b>Changes<\/b> tab shows the diff</)
  assert.match(changeCardHtml(f, { kept: 'some' }), /its <b>Changes<\/b> tab shows the latest diffs</)
  assert.match(changeCardHtml(f, { kept: 'none' }), /its line-by-line diff is no longer kept</)
  // Not read yet: promise nothing.
  assert.match(changeCardHtml(f), /<div class="tcard-foot">Click to open<\/div>/)
})

test('each person with their share, "you" for me, and their own edits before git pulls', () => {
  const html = changeCardHtml(file({
    by: [
      { name: 'Sam', added: 40, removed: 0, ts: now, pulled: true },
      { name: 'Mo', added: 2, removed: 2, ts: now - 60000 },
      { name: 'Dana', added: 12, removed: 1, ts: now - 120000 }
    ]
  }), { who: (n) => n === 'Mo' ? 'you' : n, colorOf: (n) => n === 'Dana' ? '#123456' : null })
  const people = [...html.matchAll(/<span class="tcard-who">([^<]*)/g)].map((m) => m[1].trim())
  assert.deepEqual(people, ['you', 'Dana', 'Sam'])
  assert.match(html, /Sam <i>pulled from git<\/i>/)
  assert.match(html, /--c:#123456/)
  assert.match(html, /<span class="tcard-delta"><span class="add">\+12<\/span> <span class="del">−1<\/span><\/span>/)
  assert.match(html, /<span class="tcard-ago">1m<\/span>/) // as the Changes panel says it
})

test('at most four people, then how many more', () => {
  const by = ['A', 'B', 'C', 'D', 'E', 'F'].map((name) => ({ name, added: 1, removed: 0, ts: now }))
  const html = changeCardHtml(file({ by }))
  assert.equal(html.match(/class="tcard-who"/g).length, 4)
  assert.match(html, /<li class="tcard-more">and 2 more<\/li>/)
  assert.doesNotMatch(changeCardHtml(file({ by: by.slice(0, 4) })), /tcard-more/)
})

test('names and paths from the shared room are escaped', () => {
  const html = changeCardHtml(file({ path: 'a/<img src=x>.js', by: [{ name: '<b>Eve</b>', added: 1, removed: 0, ts: now }] }))
  assert.doesNotMatch(html, /<img|<b>Eve/)
  assert.match(html, /a\/&lt;img src=x&gt;\.js/)
  assert.match(html, /&lt;b&gt;Eve&lt;\/b&gt;/)
})
