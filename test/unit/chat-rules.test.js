// Chat rules for every AI, whatever tool it runs in (src/duties.js): a message says who it is
// for, and AI sessions working as the same member answer each person once.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addressees, unaddressed, sentByAnother, renderRepeat, answered, waitingOn, renderUnanswered } from '../../src/duties.js'
import { describeEvent } from '../../src/inbox.js'

const names = ['Sam', 'Sriram', 'Duncan', 'Daniel Carmichael']

test('a message is for who it @mentions, or its direct recipient', () => {
  assert.deepEqual(addressees('@Sam can you check this?', null, names), ['Sam'])
  assert.deepEqual(addressees('@sam and @Sriram, QA please', null, names), ['Sam', 'Sriram'])
  assert.deepEqual(addressees('@Agents do you copy?', null, names), ['Agents'])
  assert.deepEqual(addressees('hello', 'Sam', names), ['Sam'])
  assert.deepEqual(addressees('Thanks sam, noted', null, names), [], 'a bare name is not a mention')
})

test('a message that names nobody is refused, unless it is a direct message or an announcement', () => {
  const why = unaddressed('Thanks sam, noted.', { names })
  assert.match(why, /^Not sent: this message names nobody/)
  assert.match(why, /@Sam/)
  assert.match(why, /everyone: true/)
  assert.equal(unaddressed('@Sam thanks', { names }), '')
  assert.equal(unaddressed('thanks', { to: 'Sam', names }), '')
  assert.equal(unaddressed('Release 0.3.14 is out', { everyone: true, names }), '')
})

const now = 10_000_000
test('another AI session working as the same member already wrote to them: a repeat is refused', () => {
  const sent = [{ via: 'A', targets: ['Sam'], text: 'Thanks sam, noted.', ts: now - 60_000 }]
  const messages = [{ id: 'm1', by: 'Sam', to: 'Daniel', text: 'Hey Daniel! I am all set now.', ts: now - 120_000 }]
  const hit = sentByAnother(sent, { via: 'B', targets: ['Sam'], messages, now })
  assert.deepEqual(hit, { to: 'Sam', text: 'Thanks sam, noted.', ts: now - 60_000 })
  assert.match(renderRepeat(hit, now), /another AI session working as you already wrote to Sam 1m ago: "Thanks sam, noted."/)
  assert.equal(sentByAnother(sent, { via: 'A', targets: ['Sam'], messages, now }), null, 'the same session may write again')
  assert.equal(sentByAnother(sent, { via: 'B', targets: ['Sriram'], messages, now }), null, 'someone else is fine')
  assert.equal(sentByAnother(sent, { via: null, targets: ['Sam'], messages, now }), null, 'a person, not a session')
  const later = [...messages, { id: 'm2', by: 'Sam', to: 'Daniel', text: 'one more thing?', ts: now - 30_000 }]
  assert.equal(sentByAnother(sent, { via: 'B', targets: ['Sam'], messages: later, now }), null, 'they wrote again since: a new answer is due')
  assert.equal(sentByAnother(sent, { via: 'B', targets: ['Sam'], messages, now: now + 31 * 60_000 }), null, 'after half an hour it no longer stands in')
})

test('a message @mentioning only others does not answer someone', () => {
  const msgs = [
    { id: '1', by: 'Sam', to: null, text: '@Daniel are you there?', ts: 1 },
    { id: '2', by: 'Daniel', to: null, text: '@Duncan please QA ticket 12', ts: 2 }
  ]
  assert.equal(answered(msgs, 'Daniel', 'Sam', 1), false)
  assert.equal(answered([...msgs, { id: '3', by: 'Daniel', to: null, text: '@Sam yes', ts: 3 }], 'Daniel', 'Sam', 1), true)
  assert.equal(answered([...msgs, { id: '3', by: 'Daniel', to: null, text: 'yes, here', ts: 3 }], 'Daniel', 'Sam', 1), true, 'a message to everyone that names nobody still answers')
})

test('a message settled as needing no reply waits on nobody, and the gate says how to settle one', () => {
  const msgs = [{ id: 'x1', by: 'Sam', to: 'Daniel', text: 'Thanks, all set!', ts: now - 1000 }]
  assert.equal(waitingOn(msgs, 'Daniel', { now }).length, 1)
  assert.equal(waitingOn(msgs, 'Daniel', { now, settled: new Set(['x1']) }).length, 0)
  const text = renderUnanswered(waitingOn(msgs, 'Daniel', { now }))
  assert.match(text, /\(id x1\)/)
  assert.match(text, /no_reply/)
  assert.match(text, /needs nothing back \(thanks, a greeting/)
  assert.match(describeEvent({ id: 'x1', kind: 'dm', by: 'Sam', text: 'hi' }), /\(id x1\)/)
})
