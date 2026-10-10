import { test } from 'node:test'
import assert from 'node:assert/strict'

const { conversations, pickConversation } = await import('../../src/ui/feed-convs.js')

const e = (conv, kind, text, ts, tool = 'Claude Code') => ({ id: `${conv}-${ts}`, conv, tool, kind, text, ts })

test('conversations: one per conv id, named after the first prompt, newest activity first', () => {
  const entries = [
    e('a', 'prompt', 'Fix the login bug\nmore detail', 100),
    e('a', 'reply', 'On it', 110),
    e('b', 'prompt', 'Write release notes', 120, 'Cursor'),
    e('a', 'action', 'Edited src/login.js', 130),
    { id: 'p', conv: null, tool: null, kind: 'paused', text: '', ts: 140 }
  ]
  assert.deepEqual(conversations(entries), [
    { conv: 'a', tool: 'Claude Code', label: 'Fix the login bug', ts: 130, count: 3 },
    { conv: 'b', tool: 'Cursor', label: 'Write release notes', ts: 120, count: 1 }
  ])
})

test('conversations: entries without a conv id form one bucket; long names are cut', () => {
  const long = 'x'.repeat(80)
  const list = conversations([e(null, 'reply', 'hi', 1), e(null, 'prompt', long, 2)])
  assert.equal(list.length, 1)
  assert.equal(list[0].conv, '')
  assert.equal(list[0].label.length, 49) // 48 chars + ellipsis
  assert.ok(list[0].label.endsWith('…'))
})

test('conversations: without a prompt the tool name is the label', () => {
  assert.equal(conversations([e('c', 'reply', 'hello', 1, 'Cursor')])[0].label, 'Cursor')
})

test('pickConversation: follows the newest unless one was pinned and still exists', () => {
  const list = [{ conv: 'b', ts: 2 }, { conv: 'a', ts: 1 }]
  assert.equal(pickConversation(list, undefined), 'b')
  assert.equal(pickConversation(list, 'a'), 'a')
  assert.equal(pickConversation(list, 'gone'), 'b')
  assert.equal(pickConversation([], 'a'), null)
})
