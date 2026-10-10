// The inbox: mentions, direct messages and handed-over tasks that wake an agent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mentioned, scanInbox, describeEvent, renderInbox, Inbox, INBOX_CAP } from '../../src/inbox.js'

const msg = (id, by, text, to = null) => ({ id, by, to, text, ts: 1000 + Number(id.replace(/\D/g, '')) })
const task = (id, title, over = {}) => ({ id, title, column: 'todo', by: 'dana', assignee: '', forAi: false, tool: '', files: [], ...over })

test('mentions: @Name anywhere in the text, case-insensitive, whole names only', () => {
  assert.deepEqual(mentioned('@helper please look at src/app.js', ['helper', 'dana']), ['helper'])
  assert.deepEqual(mentioned('cc @Helper and @dana', ['helper', 'dana']), ['helper', 'dana'])
  assert.deepEqual(mentioned('mail dan@helper.dev', ['helper']), [], 'an email address is not a mention')
  assert.deepEqual(mentioned('@helpers unite', ['helper']), [], '@helpers is not @helper')
  assert.deepEqual(mentioned('(@helper)', ['helper']), ['helper'])
  assert.deepEqual(mentioned('@Grok Bot: go', ['Grok Bot']), ['Grok Bot'], 'names with spaces')
  assert.deepEqual(mentioned('@a.b-c?', ['a.b-c']), ['a.b-c'], 'regex characters in names are literal')
  assert.deepEqual(mentioned('nothing here', ['helper']), [])
  assert.deepEqual(mentioned('@helper', ['', null]), [])
})

test('the first scan takes stock without waking anyone', () => {
  const r = scanInbox({ messages: [msg('m1', 'dana', '@helper hi')], tasks: [task('t1', 'Fix login', { assignee: 'helper' })], reader: { name: 'helper', asAi: false } })
  assert.deepEqual(r.events, [])
  assert.deepEqual(r.state, { messages: ['m1'], assigned: ['t1'] })
})

test('mentions and direct messages to the reader fire once; own and unrelated messages never', () => {
  const reader = { name: 'helper', asAi: false }
  let { state } = scanInbox({ messages: [], tasks: [], reader })
  const messages = [
    msg('m1', 'dana', 'hello everyone'),
    msg('m2', 'dana', '@helper can you take the login bug?'),
    msg('m3', 'dana', 'when will you be done?', 'helper'),
    msg('m4', 'helper', '@helper talking to myself'),
    msg('m5', 'dana', 'private to sam', 'sam')
  ]
  const r = scanInbox({ messages, tasks: [], reader }, state)
  assert.deepEqual(r.events.map((e) => [e.id, e.kind, e.by]), [['m2', 'mention', 'dana'], ['m3', 'dm', 'dana']])
  assert.equal(r.events[0].text, '@helper can you take the login bug?')
  state = r.state
  assert.deepEqual(scanInbox({ messages, tasks: [], reader }, state).events, [], 'seen messages do not fire again')
  const more = [...messages, msg('m6', 'sam', 'ping @HELPER')]
  assert.deepEqual(scanInbox({ messages: more, tasks: [], reader }, state).events.map((e) => e.id), ['m6'])
})

test('a task fires when it becomes the reader\'s while open, and again after it is handed away and back', () => {
  const reader = { name: 'helper', asAi: false }
  let { state } = scanInbox({ messages: [], tasks: [task('t0', 'Old one', { assignee: 'helper' })], reader })
  const t1 = task('t1', 'Fix login', { assignee: 'helper', files: ['src/login.js'] })
  let r = scanInbox({ messages: [], tasks: [task('t0', 'Old one', { assignee: 'helper' }), t1, task('t2', 'Not mine', { assignee: 'dana' })], reader }, state)
  assert.deepEqual(r.events.map((e) => [e.id, e.kind, e.by, e.text]), [['t1', 'task', 'dana', 'Fix login']])
  assert.deepEqual(r.events[0].task, { id: 't1', title: 'Fix login', column: 'todo', assignee: 'helper', forAi: false, tool: '', files: ['src/login.js'] })
  state = r.state
  // Moving it along does not fire again; nor does an assigned task that is already done.
  r = scanInbox({ messages: [], tasks: [{ ...t1, column: 'doing' }, task('t3', 'Finished', { assignee: 'helper', column: 'done' })], reader }, state)
  assert.deepEqual(r.events, [])
  state = r.state
  // Handed to dana, then back to helper: fires again.
  state = scanInbox({ messages: [], tasks: [{ ...t1, assignee: 'dana' }], reader }, state).state
  r = scanInbox({ messages: [], tasks: [t1], reader }, state)
  assert.deepEqual(r.events.map((e) => e.id), ['t1'])
  // Done and reopened: fires again.
  state = scanInbox({ messages: [], tasks: [{ ...t1, column: 'done' }], reader }, r.state).state
  assert.deepEqual(scanInbox({ messages: [], tasks: [t1], reader }, state).events.map((e) => e.id), ['t1'])
})

test('a person\'s AI gets the tasks for their AI, not the ones for the person; an agent gets its own', () => {
  const tasks = [task('t1', 'For Dana herself', { assignee: 'dana' }), task('t2', 'For Dana\'s AI', { assignee: 'dana', forAi: true, tool: 'Claude Code' }), task('t3', 'For the agent', { assignee: 'helper' })]
  const ai = { name: 'dana', asAi: true }
  const agent = { name: 'helper', asAi: false }
  const seedAi = scanInbox({ messages: [], tasks: [], reader: ai }).state
  const seedAgent = scanInbox({ messages: [], tasks: [], reader: agent }).state
  assert.deepEqual(scanInbox({ messages: [], tasks, reader: ai }, seedAi).events.map((e) => e.id), ['t2'])
  assert.deepEqual(scanInbox({ messages: [], tasks, reader: agent }, seedAgent).events.map((e) => e.id), ['t3'])
})

test('malformed messages and tasks are skipped', () => {
  const reader = { name: 'helper', asAi: false }
  const { state } = scanInbox({ messages: [], tasks: [], reader })
  const r = scanInbox({ messages: [null, {}, { id: 7 }, { id: 'm1', by: 'dana', text: 42 }, msg('m2', 'dana', '@helper ok')], tasks: [null, { title: 'x' }], reader }, state)
  assert.deepEqual(r.events.map((e) => e.id), ['m2'])
})

test('events are described as lines an agent can act on', () => {
  assert.equal(describeEvent({ kind: 'dm', by: 'dana', text: 'hi' }), 'dana sent you a direct message: hi')
  assert.equal(describeEvent({ kind: 'mention', by: 'dana', text: '@helper hi' }), 'dana mentioned you in chat: @helper hi')
  assert.match(describeEvent({ kind: 'task', by: 'dana', id: 'abc', text: 'Fix login', task: { files: ['src/a.js'] } }), /dana handed you a task: "Fix login" \(id abc\)\. Files: src\/a\.js\. Pick it up with quilt_move_task/)
  assert.equal(renderInbox([]), '')
  assert.match(renderInbox([{ kind: 'dm', by: 'dana', text: 'hi' }]), /^Waiting for you:\n- dana sent you a direct message: hi\n.*quilt_message/)
})

test('Inbox keeps numbered events, takes stock quietly, and caps what it keeps', () => {
  const inbox = new Inbox()
  const reader = { name: 'helper', asAi: false }
  assert.deepEqual(inbox.scan({ messages: [msg('m0', 'dana', '@helper old')], tasks: [], reader }), [], 'first scan seeds')
  assert.deepEqual(inbox.since(), { events: [], seq: 0 })
  const messages = [msg('m0', 'dana', '@helper old'), msg('m1', 'dana', '@helper one')]
  assert.equal(inbox.scan({ messages, tasks: [], reader }).length, 1)
  assert.deepEqual(inbox.since(0).events.map((e) => [e.seq, e.id]), [[1, 'm1']])
  assert.equal(inbox.since(0).seq, 1)
  // Our own changes update the state but wake nobody.
  const quiet = [...messages, msg('m2', 'dana', '@helper two')]
  assert.deepEqual(inbox.scan({ messages: quiet, tasks: [], reader }, { quiet: true }), [])
  assert.deepEqual(inbox.scan({ messages: quiet, tasks: [], reader }), [], 'and are then seen')
  assert.deepEqual(inbox.since(1).events, [])
  // The cap.
  const many = [...quiet]
  for (let i = 0; i < INBOX_CAP + 10; i++) many.push(msg(`x${i}`, 'dana', `@helper ${i}`))
  inbox.scan({ messages: many, tasks: [], reader })
  assert.equal(inbox.events.length, INBOX_CAP)
  assert.equal(inbox.since(0).events[0].id, 'x10')
  assert.equal(inbox.since(inbox.seq).events.length, 0)
})
