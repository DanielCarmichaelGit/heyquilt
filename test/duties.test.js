// The rules every agent is held to, whatever tool it runs in (src/duties.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { namesPath, requestsAbout, unanswered, renderUnanswered, renderRequests, heldRefusal } from '../src/duties.js'

test('a message names a file by its path, or by a file name with an extension, as its own word', () => {
  assert.ok(namesPath('please leave src/app.js alone', 'src/app.js'))
  assert.ok(namesPath('is `app.js` free?', 'src/app.js'))
  assert.ok(namesPath('app.js?', 'src/app.js'))
  assert.ok(namesPath('look at lib/app.js.', 'src/app.js'), 'a name ends a sentence')
  assert.ok(!namesPath('myapp.js is mine', 'src/app.js'))
  assert.ok(!namesPath('see app.json', 'src/app.js'))
  assert.ok(!namesPath('the app is slow', 'src/app.js'))
  assert.ok(!namesPath('the Makefile', 'docs/Makefile'), 'a bare name without an extension is too vague')
  assert.ok(namesPath('touching docs/Makefile', 'docs/Makefile'))
})

const now = 1_000_000_000
const msgs = [
  { id: '1', by: 'sam', to: 'helper', text: 'please leave src/app.js alone', ts: now - 5000 },
  { id: '2', by: 'sam', to: 'dana', text: 'src/app.js is yours, dana', ts: now - 4000 }, // not to me
  { id: '3', by: 'kim', to: null, text: 'I am rewriting src/app.js', ts: now - 3000 },
  { id: '4', by: 'helper', to: 'kim', text: 'ok, all yours', ts: now - 2000 },
  { id: '5', by: 'sam', to: null, text: 'old news about src/app.js', ts: now - 3 * 24 * 3600 * 1000 }
]

test('requests about a file: from others, to me or everyone, recent, and not answered yet', () => {
  const r = requestsAbout(['src/app.js', 'src/other.js'], { messages: msgs, me: 'helper', now })
  assert.deepEqual(r.map((x) => x.id), ['1'])
  assert.equal(r[0].path, 'src/app.js')
  assert.match(renderRequests(r), /sam \(to you\) about src\/app\.js: "please leave src\/app\.js alone"/)
  assert.equal(renderRequests([]), '')
  // A message to everyone answers every earlier one.
  const later = [...msgs, { id: '6', by: 'helper', to: null, text: 'noted', ts: now - 1000 }]
  assert.deepEqual(requestsAbout(['src/app.js'], { messages: later, me: 'helper', now }), [])
})

test('unanswered: direct messages and mentions with no later reply to that person or everyone', () => {
  const events = [
    { id: '1', kind: 'dm', by: 'sam', text: 'when?', ts: now - 5000 },
    { id: '3', kind: 'mention', by: 'kim', text: '@helper hi', ts: now - 3000 },
    { id: 't', kind: 'task', by: 'kim', text: 'Fix it', ts: now - 3000 }
  ]
  assert.deepEqual(unanswered(events, { messages: msgs, me: 'helper' }).map((e) => e.id), ['1'], 'kim was answered; tasks are not messages')
  assert.match(renderUnanswered(unanswered(events, { messages: msgs, me: 'helper' })), /^Not yet:.*\n- sam sent you a direct message: "when\?"/)
  assert.equal(renderUnanswered([]), '')
})

test('a refusal names the holder, the covering claim, and what to do instead', () => {
  const t = heldRefusal('src/auth/login.js', { by: 'dana', pattern: 'src/auth', note: 'refactoring' })
  assert.match(t, /^src\/auth\/login\.js is claimed by dana \(refactoring\), as part of their claim on src\/auth/)
  assert.match(t, /Do not retry/)
  assert.match(t, /quilt_message \(to: "dana"\)/)
})
