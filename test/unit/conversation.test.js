// What an agent woken by one message knows of the conversation before it, and how it reads back
// further (conversation.js, chat-archive.js, inbox.js, webhooks.js): the same for every tool.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { between, contextFor, withContext, queryConversation, renderConversation } from '../../src/conversation.js'
import { ChatArchive } from '../../src/chat-archive.js'
import { renderInbox, scanInbox, describeEvent } from '../../src/inbox.js'
import { webhookPayload } from '../../src/webhooks.js'
import { waitingOn, unanswered } from '../../src/duties.js'

let n = 0
const msg = (by, text, extra = {}) => ({ id: `m${++n}`, by, text, ts: 1000 * n, ...extra })

// Daniel asks Duncan for a tool, others talk meanwhile, then "is that tool live?"
const chat = [
  msg('Daniel', '@Duncan please build a quilt_request_commit tool'),
  msg('Brandon', '@Sriram can you QA the board?'),
  msg('Duncan', 'On it: building quilt_request_commit', { to: 'Daniel' }),
  msg('Sriram', 'QA passed, @Brandon'),
  msg('Daniel · fix bug', 'FYI Duncan, the relay restarted', { to: 'Duncan', of: 'Daniel' }),
  msg('Daniel', 'Hi @Agents, back online'),
  msg('Daniel', 'is that tool live?', { to: 'Duncan' })
]
const last = chat.at(-1)

test('between: direct messages either way, @mentions either way, an AI session speaking for its person; not other people\'s talk', () => {
  const me = ['Duncan']
  const got = chat.filter((m) => between(m, me, ['Daniel'], { agent: true })).map((m) => m.id)
  assert.deepEqual(got, [chat[0].id, chat[2].id, chat[4].id, chat[5].id, last.id])
  assert.ok(!between(chat[5], me, ['Daniel'], { agent: false }), '@Agents is only for agents')
  assert.ok(!between(chat[1], me, ['Brandon']), 'Brandon talking to Sriram is not Duncan\'s conversation')
})

test('a wake carries the conversation before it with its sender, newest last, within a budget', () => {
  const c = contextFor(chat, { me: ['Duncan'], other: ['Daniel'], before: last.id, agent: true })
  assert.deepEqual(c.messages.map((m) => m.text), [chat[0].text, chat[2].text, chat[4].text, chat[5].text])
  assert.equal(c.earlier, 0)
  const small = contextFor(chat, { me: ['Duncan'], other: ['Daniel'], before: last.id, agent: true, max: 2 })
  assert.deepEqual([small.messages.length, small.earlier], [2, 2])
  const long = [msg('Daniel', `@Duncan ${'x'.repeat(5000)}`), msg('Daniel', '@Duncan and?')]
  const cut = contextFor(long, { me: ['Duncan'], other: ['Daniel'], before: long[1].id })
  assert.ok(cut.messages[0].text.length <= 600 && cut.messages[0].text.endsWith('…'))

  const [e] = withContext([{ id: last.id, kind: 'dm', by: 'Daniel', text: last.text, ts: last.ts }], chat, { names: ['Duncan'], agent: true })
  assert.equal(e.context.length, 4)
  // quilt_inbox shows it under the event; ids, "you", oldest first; and each sender's only once.
  const text = renderInbox([e, { ...e, id: 'other', text: 'and?' }], { me: ['Duncan'] })
  assert.match(text, /Daniel sent you a direct message \(id m\d+\): is that tool live\?\n {2}Earlier between you and Daniel \(oldest first\):\n {4}- \[m\d+\] .* Daniel: @Duncan please build a quilt_request_commit tool\n {4}- \[m\d+\] .* you → Daniel: On it: building quilt_request_commit/)
  assert.equal(text.match(/Earlier between you and Daniel/g).length, 1)
  // The webhook carries it as data.
  const p = webhookPayload(e, { room: 'r', to: 'Duncan' })
  assert.deepEqual(p.context.map((m) => m.by), ['Daniel', 'Duncan', 'Daniel · fix bug', 'Daniel'])
  assert.ok(!('context' in webhookPayload({ id: 'x', kind: 'dm', by: 'A', text: 't' }, {})))
})

test('reading back: one conversation, a search, paging before an id; said plainly when there is nothing', () => {
  const r = queryConversation(chat, { me: ['Duncan'], with: 'Daniel', agent: true, limit: 2 })
  assert.deepEqual(r.messages.map((m) => m.id), [chat[5].id, last.id])
  assert.ok(r.more)
  const shown = renderConversation(r, { me: ['Duncan'], with: 'Daniel' })
  assert.match(shown, new RegExp(`call again with before: "${chat[5].id}"`))
  const older = queryConversation(chat, { me: ['Duncan'], with: 'Daniel', agent: true, before: chat[5].id })
  assert.deepEqual(older.messages.map((m) => m.id), [chat[0].id, chat[2].id, chat[4].id])
  assert.deepEqual(queryConversation(chat, { me: ['Duncan'], q: 'REQUEST_COMMIT' }).messages.map((m) => m.id), [chat[0].id, chat[2].id])
  assert.match(renderConversation(queryConversation(chat, { me: ['Duncan'], with: 'Nobody' }), { with: 'Nobody' }), /^No messages between you and Nobody/)
})

test('the chat is kept past the room\'s newest 500, on disk, and read with the room\'s', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-arch-')), 'chat.jsonl')
  const a = new ChatArchive(file, { cap: 50 })
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `a${i}`, by: 'A', text: `t${i}`, ts: i }))
  assert.equal(a.add(many.slice(0, 30)), 30)
  assert.equal(a.add(many.slice(0, 30)), 0, 'kept once')
  a.add(many.slice(30))
  assert.equal(a.list.length, 50, 'the oldest go past the cap')
  const b = new ChatArchive(file, { cap: 50 })
  assert.deepEqual(b.list.map((m) => m.id), many.slice(10).map((m) => m.id), 'read back from disk')
  fs.appendFileSync(file, '{"id":"cut')
  assert.equal(new ChatArchive(file, { cap: 50 }).list.length, 50, 'a line cut off by a crash is skipped')
  const live = [{ id: 'a59', by: 'A', text: 'edited', ts: 59 }, { id: 'new', by: 'B', text: 'n', ts: 70 }]
  const all = b.with(live)
  assert.deepEqual([all.length, all.at(-2).text, all.at(-1).id], [51, 'edited', 'new'])
})

test('a note that work someone asked to commit was committed wakes them and asks for no reply', () => {
  const note = { id: 'c1', by: 'Daniel', to: 'Duncan', text: 'Committed abc1234 on main', ts: 5, kind: 'commit' }
  const { events } = scanInbox({ messages: [note], reader: { name: 'Duncan', agent: true } }, { messages: [], assigned: [] })
  assert.equal(events[0].commit, true)
  assert.match(describeEvent(events[0]), /committed work you asked for \(no reply needed\)/)
  assert.deepEqual(waitingOn([note], 'Duncan', { now: 10 }), [])
  assert.deepEqual(unanswered(events, { messages: [note], me: 'Duncan' }), [])
  assert.equal(webhookPayload(events[0], {}).commit, true)
})
