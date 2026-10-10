// Sounds: which live events chime (mentions and direct messages to me, requests to join
// I may answer, tasks handed to me), and the settings that switch each one off.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { mentions, messageSound, letInSound, taskSound, soundOn, playSound, SOUND_EVENTS } = await import('../../src/ui/sounds.js')

test('mentions: @name as chat marks it, any case, whole names only, not an email or the AI', () => {
  assert.equal(mentions('hey @Daniel Carmichael can you look', 'Daniel Carmichael'), true)
  assert.equal(mentions('@daniel carmichael', 'Daniel Carmichael'), true)
  assert.equal(mentions('mail daniel@Daniel Carmichael', 'Daniel Carmichael'), false)
  assert.equal(mentions('@Daniel Carmichaels', 'Daniel Carmichael'), false)
  assert.equal(mentions("@Daniel Carmichael's AI fix it", 'Daniel Carmichael'), false)
  assert.equal(mentions('@Dan', 'Daniel'), false)
  assert.equal(mentions('', 'Daniel'), false)
  assert.equal(mentions('@Daniel', ''), false)
})

test('messageSound: a mention or a direct message to me, never my own or someone else\'s DM', () => {
  assert.equal(messageSound({ by: 'Duncan', text: '@Me done' }, 'Me'), 'mention')
  assert.equal(messageSound({ by: 'Duncan', to: 'Me', text: 'psst' }, 'Me'), 'mention')
  assert.equal(messageSound({ by: 'Duncan', to: 'Sriram', text: '@Me in a DM to Sriram' }, 'Me'), null)
  assert.equal(messageSound({ by: 'Duncan', text: 'hello all' }, 'Me'), null)
  assert.equal(messageSound({ by: 'Me', text: '@Me note to self' }, 'Me'), null)
  assert.equal(messageSound(null, 'Me'), null)
  assert.equal(messageSound({ by: 'Duncan', text: '@Me' }, ''), null)
})

test('letInSound: only when someone new is waiting', () => {
  const a = { key: 'k1', name: 'Ana' }
  const b = { key: 'k2', name: 'Bo' }
  assert.equal(letInSound(undefined, [a]), 'letIn')
  assert.equal(letInSound([a], [a, b]), 'letIn')
  assert.equal(letInSound([a, b], [a]), null, 'someone let in or denied')
  assert.equal(letInSound([a], [a]), null)
  assert.equal(letInSound([a], undefined), null, 'no waiting list: I may not let people in')
})

test('taskSound: a task newly assigned to me or my AI, not my own new task or a done one', () => {
  const t = (o) => ({ id: 't1', column: 'todo', by: 'Dana', assignee: '', ...o })
  assert.equal(taskSound([t()], [t({ assignee: 'Me' })], 'Me'), 'task')
  assert.equal(taskSound([t({ assignee: 'Me' })], [t({ assignee: 'Me', forAi: true })], 'Me'), 'task', 'handed to my AI')
  assert.equal(taskSound([], [t({ assignee: 'Me' })], 'Me'), 'task', 'a new task for me')
  assert.equal(taskSound([], [t({ assignee: 'Me', by: 'Me' })], 'Me'), null, 'my own new task')
  assert.equal(taskSound([t({ assignee: 'Me' })], [t({ assignee: 'Me', column: 'doing' })], 'Me'), null, 'just moved')
  assert.equal(taskSound([t()], [t({ assignee: 'Bo' })], 'Me'), null)
  assert.equal(taskSound([t()], [t({ assignee: 'Me', column: 'done' })], 'Me'), null)
  assert.equal(taskSound([t()], [t({ assignee: 'Me', archived: true })], 'Me'), null)
  assert.equal(taskSound([t()], [t({ assignee: 'Me' })], ''), null)
})

test('soundOn: every sound is on until its setting is switched off', () => {
  for (const ev of SOUND_EVENTS) {
    assert.equal(soundOn({}, ev.kind), true, ev.kind)
    assert.equal(soundOn(undefined, ev.kind), true, ev.kind)
    assert.equal(soundOn({ [ev.setting]: true }, ev.kind), true, ev.kind)
    assert.equal(soundOn({ [ev.setting]: false }, ev.kind), false, ev.kind)
  }
  assert.equal(soundOn({}, 'nope'), false)
  assert.deepEqual(SOUND_EVENTS.map((e) => e.setting), ['soundMentions', 'soundLetIn', 'soundTasks'])
  for (const ev of SOUND_EVENTS) assert.ok(!/\u2014/.test(ev.label + ev.hint), 'no em dashes in UI copy')
})

test('playSound: plays a chime through Web Audio, once per burst', () => {
  const started = []
  class FakeParam { setValueAtTime () {} exponentialRampToValueAtTime () {} }
  class FakeNode { constructor () { this.gain = new FakeParam(); this.frequency = {} } connect (n) { return n } start (t) { started.push(t) } stop () {} }
  globalThis.AudioContext = class { constructor () { this.state = 'running'; this.currentTime = 0; this.destination = {} } createOscillator () { return new FakeNode() } createGain () { return new FakeNode() } }
  try {
    assert.equal(playSound('nope'), false)
    assert.equal(playSound('mention'), true)
    const n = started.length
    assert.ok(n > 0)
    assert.equal(playSound('task'), false, 'a second event right after stays quiet')
    assert.equal(started.length, n)
    assert.equal(playSound('letIn', { force: true }), true, 'the Settings preview always plays')
  } finally { delete globalThis.AudioContext }
})
