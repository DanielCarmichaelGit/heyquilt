// What is waiting for a member of a session: mentions of them in chat, direct
// messages to them, and tasks handed to them. Agents wake on these: Claude Code
// gets them pushed as channel events by `quilt mcp`, every tool can read them
// with quilt_inbox, and the Claude Code hooks show them while Claude works.
//
// `scanInbox` is pure (state in, state out) so the local daemon, the hosted
// relay MCP and tests all find the same events the same way.
import { assignedToReader } from './tasks.js'

export const INBOX_CAP = 100

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Which of `names` are mentioned as @Name in `text`. Case-insensitive; the @
 * must start a word (so an email address is not a mention) and the name must
 * end one (so @Dan is not a mention of Dan inside @Daniel). @Daniel's AI is not a mention of Daniel.
 */
export function mentioned (text, names) {
  const t = String(text || '')
  const out = []
  for (const name of names || []) {
    const n = String(name || '').trim()
    if (!n) continue
    // "@Daniel's AI" is for Daniel's AI, not for Daniel.
    const re = new RegExp(`(^|[^\\w@])@${escapeRe(n)}(?![\\w-])(?!'s AI(?![\\w-]))`, 'iu')
    if (re.test(t)) out.push(n)
  }
  return out
}

/** Typing @Agents in chat mentions every agent in the session at once. */
export const ALL_AGENTS = 'Agents'

/**
 * Whether `text` mentions `me`: @me, or @Agents when `agent` (the reader joined as an agent).
 * A member actually named "Agents" is still mentioned by name, like anyone else.
 */
export function mentionsMe (text, me, { agent = false } = {}) {
  return mentioned(text, agent ? [me, ALL_AGENTS] : [me]).length > 0
}

/**
 * Events for `reader` that `state` has not seen. Pure: returns { events, state }.
 * - messages: chat the reader can see, oldest first ({ id, by, to, text, ts }).
 * - tasks: the board ({ id, title, column, by, assignee, forAi, tool, files }).
 * - reader: { name, asAi, agent, aliases, of }: agent means the reader joined as an
 *   agent, so @Agents mentions it too. asAi means the reader is that person's AI, so
 *   tasks for "their AI" are the reader's and tasks for the person are not. One of
 *   several AI sessions working through a person's app (persona.js) has its own name,
 *   the names it had before (`aliases`), and `of`, its person: tasks for "their AI" are its.
 *   `own`: names of the reader's own AI sessions. What they say never wakes the reader: a
 *   session writing to its own person is talking to the person, not to their other sessions.
 * The first scan (no state) only takes stock: nothing that is already there
 * wakes anyone. A task fires once when it becomes the reader's while open;
 * handing it away and back fires again.
 */
export function scanInbox ({ messages = [], tasks = [], reader, now = Date.now() }, state = null) {
  const me = reader && reader.name
  const names = me ? [me, ...((reader && reader.aliases) || [])] : []
  const own = new Set((reader && reader.own) || [])
  const seed = !state
  const seenMsgs = new Set(state?.messages || [])
  const assigned = new Set(state?.assigned || [])
  const events = []
  const msgIds = []
  for (const m of messages) {
    if (!m || typeof m.id !== 'string' || !m.id) continue
    msgIds.push(m.id)
    if (seed || seenMsgs.has(m.id) || !me || names.includes(m.by) || own.has(m.by)) continue
    const text = typeof m.text === 'string' ? m.text : ''
    // File queue messages (a request for a file the reader holds, or a file handed to them) wake
    // them like a direct message, but ask for a handoff rather than a reply (duties.js).
    const queue = m.kind === 'queue' || m.kind === 'handoff' ? { queue: m.kind, file: typeof m.path === 'string' ? m.path : '' } : {}
    if (names.includes(m.to)) events.push({ id: m.id, kind: 'dm', by: m.by, text, ts: m.ts, ...queue })
    else if (!m.to && names.some((n) => mentionsMe(text, n, { agent: !!reader.agent }))) events.push({ id: m.id, kind: 'mention', by: m.by, text, ts: m.ts })
  }
  const mine = []
  for (const t of tasks) {
    // An AI session's tasks: given to it by name (as a member), or to its person's AI.
    const its = assignedToReader(t, reader) || names.slice(1).some((n) => assignedToReader(t, { ...reader, name: n })) ||
      (reader && reader.of && (t.assignee === me || assignedToReader(t, { name: reader.of, asAi: true })))
    if (!t || typeof t.id !== 'string' || !its) continue
    mine.push(t.id)
    if (seed || assigned.has(t.id) || t.column === 'done') continue
    events.push({
      id: t.id,
      kind: 'task',
      by: t.by,
      text: t.title,
      ts: now,
      task: { id: t.id, title: t.title, column: t.column, assignee: t.assignee, forAi: !!t.forAi, tool: t.tool || '', files: t.files || [] }
    })
  }
  // A task that is done, or no longer the reader's, can wake them again later.
  const open = new Set(tasks.filter((t) => t && t.column !== 'done').map((t) => t.id))
  return { events, state: { messages: msgIds.slice(-500), assigned: mine.filter((id) => open.has(id)) } }
}

// A message's id, which quilt_inbox no_reply takes to settle it.
const idOf = (e) => e.id ? ` (id ${e.id})` : ''

/** One event as a line an agent can act on. */
export function describeEvent (e) {
  const who = e.by || 'someone'
  if (e.queue === 'queue') return `${who} asked for ${e.file} in its file queue: ${e.text} Finish what you are doing in it, then hand it off with quilt_handoff and your context.`
  if (e.queue === 'handoff') return `${who} handed you ${e.file}, which you asked for: it is yours to edit now. ${e.text}`
  if (e.kind === 'dm') return `${who} sent you a direct message${idOf(e)}: ${e.text}`
  if (e.kind === 'mention') return `${who} mentioned you in chat${idOf(e)}: ${e.text}`
  if (e.kind === 'task') {
    const t = e.task || {}
    const files = t.files && t.files.length ? ` Files: ${t.files.join(', ')}.` : ''
    return `${who} handed you a task: "${e.text}" (id ${e.id}).${files} Pick it up with quilt_move_task (doing) when you start.`
  }
  return `${who}: ${e.text || ''}`
}

export const INBOX_HOW = 'Answer a message that asks something of you with quilt_message (set "to", or start with @their name). ' +
  'One that needs nothing back (thanks, a greeting, an FYI, a status report) gets no reply: settle it with quilt_inbox (no_reply: [its id]). Take a task with quilt_move_task.'

/** Several events as the text a tool returns, or '' when there are none. */
export function renderInbox (events) {
  if (!events || !events.length) return ''
  return `Waiting for you:\n${events.map((e) => `- ${describeEvent(e)}`).join('\n')}\n${INBOX_HOW}`
}

/** Keeps the events a member has not been shown yet, each with a sequence number. */
export class Inbox {
  constructor () {
    this.state = null
    this.events = []
    this.seq = 0
  }

  /** Scans for new events. `quiet` takes stock without waking anyone (our own changes). */
  scan (input, { quiet = false } = {}) {
    const r = scanInbox(input, this.state)
    this.state = r.state
    if (quiet) return []
    for (const e of r.events) this.events.push({ ...e, seq: ++this.seq })
    if (this.events.length > INBOX_CAP) this.events.splice(0, this.events.length - INBOX_CAP)
    return r.events
  }

  /** Forgets that task `id` was already the reader's, so the next scan wakes them for it (a task they took quietly). */
  forget (id) {
    if (this.state && Array.isArray(this.state.assigned)) this.state = { ...this.state, assigned: this.state.assigned.filter((x) => x !== id) }
  }

  /** Events after sequence number `after`, and the latest number to pass next time. */
  since (after = 0) {
    const from = Number(after) || 0
    return { events: this.events.filter((e) => e.seq > from), seq: this.seq }
  }
}
