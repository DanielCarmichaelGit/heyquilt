// @Agents in chat mentions every agent in the session at once: each agent wakes on it
// (inbox), owes an answer to it (duties), and sees it marked as theirs in the app.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ALL_AGENTS, mentionsMe, scanInbox } from '../src/inbox.js'
import { waitingOn } from '../src/duties.js'

const ui = await import('../src/ui/chat.js')
const msg = (id, by, text, to = null, ts = Date.now()) => ({ id, by, to, text, ts })

test('@Agents is the same word in the app and for agents', () => {
  assert.equal(ALL_AGENTS, 'Agents')
  assert.equal(ui.ALL_AGENTS, ALL_AGENTS)
})

test('mentionsMe: @Agents (any case, whole word) mentions an agent, never a person', () => {
  assert.ok(mentionsMe('@Agents status please', 'Duncan', { agent: true }))
  assert.ok(mentionsMe('hey @agents, pull main', 'Duncan', { agent: true }), 'any case')
  assert.ok(!mentionsMe('@Agents status please', 'Dana'), 'a person is not an agent')
  assert.ok(!mentionsMe('@Agentsmith look', 'Duncan', { agent: true }), 'whole word only')
  assert.ok(!mentionsMe('mail ops@agents.dev', 'Duncan', { agent: true }), 'an email address')
  assert.ok(mentionsMe('@Duncan hi', 'Duncan', { agent: true }), 'its own name still works')
  assert.ok(mentionsMe('@Duncan hi', 'Duncan'))
})

test('every agent wakes on one @Agents message; people and the sender do not', () => {
  const readers = [
    { name: 'Duncan', asAi: false, agent: true },
    { name: 'Martha', asAi: false, agent: true },
    { name: 'Dana', asAi: true } // a person (their AI reads as them): not an agent
  ]
  const before = Object.fromEntries(readers.map((r) => [r.name, scanInbox({ messages: [], tasks: [], reader: r }).state]))
  const messages = [msg('m1', 'Dana', '@Agents please pull main and rerun tests'), msg('m2', 'Martha', '@Agents done on my side')]
  const woke = Object.fromEntries(readers.map((r) => [r.name, scanInbox({ messages, tasks: [], reader: r }, before[r.name]).events.map((e) => `${e.kind}:${e.id}`)]))
  assert.deepEqual(woke.Duncan, ['mention:m1', 'mention:m2'])
  assert.deepEqual(woke.Martha, ['mention:m1'], 'not woken by its own @Agents message')
  assert.deepEqual(woke.Dana, [], 'people are not agents')
})

test('a direct message with @Agents in it is still only for its recipient', () => {
  const reader = { name: 'Martha', asAi: false, agent: true }
  const { state } = scanInbox({ messages: [], tasks: [], reader })
  const r = scanInbox({ messages: [msg('m1', 'Dana', 'tell @Agents later', 'Duncan')], tasks: [], reader }, state)
  assert.deepEqual(r.events, [])
})

test('an agent owes an answer to @Agents until it replies; a person does not', () => {
  const now = Date.now()
  const asked = [msg('m1', 'Dana', '@Agents what are you each on?', null, now - 1000)]
  assert.deepEqual(waitingOn(asked, 'Duncan', { agent: true, now }).map((e) => e.kind), ['mention'])
  assert.deepEqual(waitingOn(asked, 'Duncan', { now }), [], 'without agent, only its name counts')
  assert.deepEqual(waitingOn(asked, 'Dana', { agent: true, now }), [], 'not its own message')
  const answered = [...asked, msg('m2', 'Duncan', 'On the @Agents ticket', null, now - 500)]
  assert.deepEqual(waitingOn(answered, 'Duncan', { agent: true, now }), [], 'a reply to everyone answers it')
})

test('the app marks @Agents as a mention, and as mine only for an agent', () => {
  const names = ['Dana', 'Duncan', 'Agents']
  assert.equal(ui.textHtml('@Agents go', names, 'Dana'), '<span class="mention">@Agents</span> go')
  assert.equal(ui.textHtml('@agents go', names, 'Duncan', { meAgent: true }), '<span class="mention me">@agents</span> go')
  assert.deepEqual(ui.mentionCandidates(['Dana', 'Duncan', 'Agents'], 'ag'), ['Agents'])
})
