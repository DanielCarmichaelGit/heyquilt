// "… is typing" in the app's chat: who shows, the line's wording, and its markup.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { typingNames, typingText, typingHtml, cleanTyping, TYPING_MS, AGENT_TYPING_MS } = await import('../../src/ui/chat.js')

test('typingNames: partners typing to everyone or to me, never me or a direct message to someone else', () => {
  const peers = [
    { name: 'Dana', typing: true },
    { name: 'Bob' },
    { name: 'Duncan', typing: true, typingTo: 'Me' },
    { name: 'Sriram', typing: true, typingTo: 'Dana' },
    { name: 'Me', typing: true },
    { name: 'Dana', typing: true },
    null,
    { typing: true }
  ]
  assert.deepEqual(typingNames(peers, 'Me'), ['Dana', 'Duncan'])
  assert.deepEqual(typingNames([], 'Me'), [])
  assert.deepEqual(typingNames(undefined), [])
})

test('typingText names one, two or three people, then counts the rest', () => {
  assert.equal(typingText([]), '')
  assert.equal(typingText(['Dana']), 'Dana is typing…')
  assert.equal(typingText(['Dana', 'Bob']), 'Dana and Bob are typing…')
  assert.equal(typingText(['Dana', 'Bob', 'Lee']), 'Dana, Bob and Lee are typing…')
  assert.equal(typingText(['Dana', 'Bob', 'Lee', 'Mo', 'Al']), 'Dana, Bob and 3 others are typing…')
})

test('typingHtml: three animated dots and the escaped line, or nothing', () => {
  assert.equal(typingHtml([]), '')
  const html = typingHtml(['<b>Eve</b>'])
  assert.match(html, /class="typing-dots" aria-hidden="true"><i><\/i><i><\/i><i><\/i>/)
  assert.match(html, /&lt;b&gt;Eve&lt;\/b&gt; is typing…/)
  assert.doesNotMatch(html, /<b>Eve/)
})

test('cleanTyping keeps only a sane entry from the room: a number ts, ms within bounds, a short to', () => {
  assert.equal(cleanTyping(null), null)
  assert.equal(cleanTyping({ ts: 'x' }), null)
  assert.deepEqual(cleanTyping({ ts: 5 }), { ts: 5, ms: TYPING_MS, to: null })
  assert.equal(cleanTyping({ ts: 5, ms: 1e9 }).ms, AGENT_TYPING_MS, 'a peer cannot pin "typing" on for good')
  assert.equal(cleanTyping({ ts: 5, ms: 1 }).ms, 1000)
  assert.equal(cleanTyping({ ts: 5, to: 'x'.repeat(200) }).to.length, 80)
  assert.equal(cleanTyping({ ts: 5, to: 7 }).to, null)
})
