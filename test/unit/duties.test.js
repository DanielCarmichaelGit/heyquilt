// The rules every agent is held to, whatever tool it runs in (src/duties.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { namesPath, chatAbout, unanswered, waitingOn, renderUnanswered, renderChatAbout, heldRefusal, replyFor, renderReplied } from '../../src/duties.js'

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

test('chat about a file: from others, to me or everyone, recent; answered or not', () => {
  const r = chatAbout(['src/app.js', 'src/other.js'], { messages: msgs, me: 'helper', now })
  assert.deepEqual(r.map((x) => [x.id, x.answered]), [['1', false], ['3', true]], 'not to someone else, not too old; helper answered kim, not sam')
  assert.equal(r[0].path, 'src/app.js')
  const fresh = [...msgs, { id: '7', by: 'sam', to: 'helper', text: 'and src/other.js too', ts: now - 500 }]
  const said = chatAbout(['src/other.js'], { messages: fresh, me: 'helper', now })
  assert.deepEqual(said.map((x) => [x.id, x.answered]), [['7', false]])
  const text = renderChatAbout(said, { now })
  assert.match(text, /^What people said in chat about these files:\n- sam \(to you\), just now, about src\/other\.js: "and src\/other\.js too" \(you have not replied\)/)
  assert.match(text, /Take it into account/)
  assert.equal(renderChatAbout([]), '')
})

test('waiting on: direct messages and mentions from the chat that were not answered', () => {
  const chat = [
    { id: 'a', by: 'sam', to: 'helper', text: 'got a minute?', ts: now - 3000 },
    { id: 'b', by: 'kim', to: null, text: '@helper look at this', ts: now - 2000 },
    { id: 'c', by: 'helper', to: 'kim', text: 'on it', ts: now - 1000 },
    { id: 'd', by: 'sam', to: null, text: 'no mention here', ts: now - 900 }
  ]
  assert.deepEqual(waitingOn(chat, 'helper', { now }).map((e) => [e.id, e.kind]), [['a', 'dm']])
})

test('unanswered: direct messages and mentions with no later reply to that person or everyone', () => {
  const events = [
    { id: '1', kind: 'dm', by: 'sam', text: 'when?', ts: now - 5000 },
    { id: '3', kind: 'mention', by: 'kim', text: '@helper hi', ts: now - 3000 },
    { id: 't', kind: 'task', by: 'kim', text: 'Fix it', ts: now - 3000 }
  ]
  assert.deepEqual(unanswered(events, { messages: msgs, me: 'helper' }).map((e) => e.id), ['1'], 'kim was answered; tasks are not messages')
  assert.match(renderUnanswered(unanswered(events, { messages: msgs, me: 'helper' })), /^Not yet:.*\n- sam sent you a direct message \(id 1\): "when\?"/)
  assert.equal(renderUnanswered([]), '')
})

test('a refusal names the holder, the covering claim, and what to do instead', () => {
  const t = heldRefusal('src/auth/login.js', { by: 'dana', pattern: 'src/auth', note: 'refactoring' })
  assert.match(t, /^src\/auth\/login\.js is claimed by dana \(refactoring\), as part of their claim on src\/auth/)
  assert.match(t, /Do not retry/)
  assert.match(t, /quilt_request_file \(path "src\/auth\/login\.js"/)
})

test('replyFor: a direct message answers the latest one its recipient sent us, by id', () => {
  const now = 100000
  const msgs = [
    { id: 'a1', by: 'Ann', to: "Dan's AI", text: 'old', ts: 1 },
    { id: 'a2', by: 'Ann', to: 'Dan · bugs', text: 'can you check?', ts: 2 },
    { id: 'b1', by: 'Bo', text: '@Dan hi', ts: 3 }
  ]
  const names = ['Dan', "Dan's AI", 'Dan · bugs']
  assert.deepEqual(replyFor(msgs, { names, to: 'Ann', now }), { to: 'Ann', re: 'a2', repeat: null })
  assert.deepEqual(replyFor(msgs, { names, to: 'Bo', now }), { to: 'Bo', re: '', repeat: null }, 'Bo sent us no direct message')
  assert.deepEqual(replyFor(msgs, { names, to: null, now }), { to: null, re: '', repeat: null })
  // An explicit id answers that message, and a direct one goes back to its sender.
  assert.deepEqual(replyFor(msgs, { names, re: 'a1', now }), { to: 'Ann', re: 'a1', repeat: null })
  assert.match(replyFor(msgs, { names, re: 'zz', now }).error, /No message with id zz/)
  assert.match(replyFor([...msgs, { id: 'd1', by: 'Dan · bugs', text: 'x', ts: 4 }], { names, re: 'd1', now }).error, /your own/)
})

test('replyFor: a message already answered is not answered again, by any of the person\'s AI sessions', () => {
  const now = 100000
  const names = ['Dan', "Dan's AI", 'Dan · bugs', 'Dan · docs']
  const msgs = [
    { id: 'a2', by: 'Ann', to: "Dan's AI", text: 'can you check?', ts: 2 },
    { id: 'r1', by: 'Dan · docs', to: 'Ann', re: 'a2', text: 'Checked: all good.', ts: 3 }
  ]
  const twice = replyFor(msgs, { names, to: 'Ann', now })
  assert.deepEqual(twice.repeat, { re: 'a2', to: 'Ann', text: 'Checked: all good.', ts: 3 })
  assert.match(renderReplied(twice.repeat, now), /^Not sent: Ann's message a2 was already answered .*"Checked: all good\."/)
  assert.ok(replyFor(msgs, { names, re: 'a2', now }).repeat, 'naming the id again is refused too')
  // Ann wrote again (not a direct message): a new message to her is not a second answer.
  const after = [...msgs, { id: 'a3', by: 'Ann', text: '@Bo thanks', ts: 4 }]
  assert.deepEqual(replyFor(after, { names, to: 'Ann', now }), { to: 'Ann', re: '', repeat: null })
  // Long after the answer, a new message to her is something new.
  assert.deepEqual(replyFor(msgs, { names, to: 'Ann', now: 3 + 31 * 60 * 1000 }), { to: 'Ann', re: '', repeat: null })
  // Her next direct message gets its own answer.
  const next = [...msgs, { id: 'a4', by: 'Ann', to: 'Dan · bugs', text: 'and this?', ts: 5 }]
  assert.deepEqual(replyFor(next, { names, to: 'Ann', now }), { to: 'Ann', re: 'a4', repeat: null })
})
