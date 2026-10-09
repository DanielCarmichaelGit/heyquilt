// The conversation between two members: what one said to the other (direct messages either
// way, and messages in the room that @mention the other). An agent woken by one message
// (a webhook, a channel event, quilt_inbox) is often a fresh session that knows nothing of
// what came before: "is that tool live?" means nothing without the ten messages above it.
// So every wake carries the recent conversation with whoever woke it (contextFor), and
// quilt_conversation reads further back, searches it, or lists everything the reader can see.
//
// Pure: messages in, messages out. The local daemon, the hosted relay MCP and the webhooks
// all use it, so every agent, whatever tool it runs in, gets the same context.
import { mentioned, ALL_AGENTS, messageLine, renderContext, CONTEXT_MESSAGE_CHARS } from './inbox.js'

export { messageLine, renderContext }

// What a wake carries: the last few messages, each cut short, within a budget for the whole.
export const CONTEXT_MESSAGES = 10
export const CONTEXT_CHARS = 4000
export { CONTEXT_MESSAGE_CHARS }
export const MAX_QUERY = 200

const lower = (names) => new Set((names || []).filter(Boolean).map((n) => String(n).toLowerCase()))

/**
 * Whether `m` passes between `me` (the reader's names) and `other` (the other member's names):
 * a direct message from one to the other, or a room message by one that @mentions the other
 * (@Agents counts for an agent reader). `of` (the person an AI session works for) counts as the
 * sender too, so "Daniel · fix bug" writing for Daniel is Daniel's side of the conversation.
 */
export function between (m, me, other, { agent = false } = {}) {
  if (!m || typeof m.text !== 'string') return false
  const mine = lower(me)
  const theirs = lower(other)
  const by = String(m.by || '').toLowerCase()
  const of = String(m.of || '').toLowerCase()
  const to = m.to ? String(m.to).toLowerCase() : ''
  const fromThem = theirs.has(by) || (of && theirs.has(of))
  const fromMe = mine.has(by)
  if (fromThem && !fromMe) return to ? mine.has(to) : mentioned(m.text, [...me, ...(agent ? [ALL_AGENTS] : [])]).length > 0
  if (fromMe && !fromThem) return to ? theirs.has(to) : mentioned(m.text, other).length > 0
  return false
}

const cut = (text, max) => {
  const t = String(text || '').trim()
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t
}

const slim = (m, max) => ({ id: m.id, by: m.by, ...(m.to ? { to: m.to } : {}), text: cut(m.text, max), ts: m.ts })

/**
 * The conversation between `me` and `other` before the message `before` (an id or a timestamp):
 * at most `max` messages and `chars` characters, oldest first. `earlier` counts what is left out.
 */
export function contextFor (messages, { me, other, before = null, max = CONTEXT_MESSAGES, chars = CONTEXT_CHARS, each = CONTEXT_MESSAGE_CHARS, agent = false } = {}) {
  const list = messages || []
  let end = list.length
  const i = typeof before === 'string' ? list.findIndex((m) => m && m.id === before)
    : typeof before === 'number' ? list.findIndex((m) => m && (m.ts || 0) >= before) : -1
  if (i >= 0) end = i
  const all = []
  for (let i = 0; i < end; i++) if (between(list[i], me, other, { agent })) all.push(list[i])
  const out = []
  let used = 0
  for (let i = all.length - 1; i >= 0 && out.length < max; i--) {
    const s = slim(all[i], each)
    if (out.length && used + s.text.length > chars) break
    used += s.text.length
    out.unshift(s)
  }
  return { messages: out, earlier: all.length - out.length }
}

/**
 * Adds `context` (contextFor) to each message or task event: the conversation with whoever it is
 * from, before it. `reader`: { names, agent }. Events are inbox events ({ id, kind, by, ts }).
 */
export function withContext (events, messages, reader, opts = {}) {
  return (events || []).map((e) => {
    if (!e || !e.by || e.context) return e
    const before = e.kind === 'dm' || e.kind === 'mention' ? e.id : (e.ts || null)
    const c = contextFor(messages, { me: reader.names, other: [e.by], before, agent: !!reader.agent, ...opts })
    return c.messages.length ? { ...e, context: c.messages, earlier: c.earlier } : e
  })
}

/**
 * Reads the chat a member can see: everything, or only the conversation `with` someone; only
 * what contains `q` (any case, in the text or the sender's name); only before message `before`.
 * Newest `limit`, oldest first. { messages, more }: more says older matches exist (ask with
 * before: the first id).
 */
export function queryConversation (messages, { me = [], with: other = null, q = '', before = null, limit = 30, agent = false } = {}) {
  let list = (messages || []).filter((m) => m && typeof m.id === 'string')
  if (before) {
    const i = list.findIndex((m) => m.id === before)
    if (i >= 0) list = list.slice(0, i)
  }
  if (other) list = list.filter((m) => between(m, me, [other], { agent }))
  const needle = String(q || '').trim().toLowerCase()
  if (needle) list = list.filter((m) => String(m.text || '').toLowerCase().includes(needle) || String(m.by || '').toLowerCase().includes(needle))
  const n = Math.max(1, Math.min(Number(limit) || 30, MAX_QUERY))
  return { messages: list.slice(-n), more: list.length > n }
}

/** quilt_conversation's answer. */
export function renderConversation ({ messages, more }, { me = [], with: other = null, q = '', now = Date.now() } = {}) {
  const what = `${other ? `between you and ${other}` : 'you can see'}${q ? ` containing "${q}"` : ''}`
  if (!messages.length) return `No messages ${what}${other ? ' (Quilt keeps the session\'s recent chat; older messages may be gone)' : ''}.`
  const lines = messages.map((m) => messageLine(m, { me, now }))
  const older = more ? `\nOlder messages ${what}: call again with before: "${messages[0].id}".` : ''
  return `Messages ${what}, oldest first:\n${lines.join('\n')}${older}`
}

/** What quilt_conversation does, the same for the local and the hosted tool. */
export const CONVERSATION_DESCRIPTION = 'Read back through the chat, further than quilt_read_messages: the whole conversation between you and one person or agent ' +
  '(direct messages either way, and messages that @mention one of you), or everything you can see; search it for some text; page back with before. ' +
  'Read it whenever a message refers to something earlier ("that tool", "the fix", "is it live?") that you do not have in front of you: ask, do not guess.'
