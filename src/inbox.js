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
 * end one (so @Dan is not a mention of Dan inside @Daniel).
 */
export function mentioned (text, names) {
  const t = String(text || '')
  const out = []
  for (const name of names || []) {
    const n = String(name || '').trim()
    if (!n) continue
    const re = new RegExp(`(^|[^\\w@])@${escapeRe(n)}(?![\\w-])`, 'iu')
    if (re.test(t)) out.push(n)
  }
  return out
}

/**
 * Events for `reader` that `state` has not seen. Pure: returns { events, state }.
 * - messages: chat the reader can see, oldest first ({ id, by, to, text, ts }).
 * - tasks: the board ({ id, title, column, by, assignee, forAi, tool, files }).
 * - reader: { name, asAi }: asAi means the reader is that person's AI, so tasks
 *   for "their AI" are the reader's and tasks for the person are not.
 * The first scan (no state) only takes stock: nothing that is already there
 * wakes anyone. A task fires once when it becomes the reader's while open;
 * handing it away and back fires again.
 */
export function scanInbox ({ messages = [], tasks = [], reader, now = Date.now() }, state = null) {
  const me = reader && reader.name
  const seed = !state
  const seenMsgs = new Set(state?.messages || [])
  const assigned = new Set(state?.assigned || [])
  const events = []
  const msgIds = []
  for (const m of messages) {
    if (!m || typeof m.id !== 'string' || !m.id) continue
    msgIds.push(m.id)
    if (seed || seenMsgs.has(m.id) || !me || m.by === me) continue
    const text = typeof m.text === 'string' ? m.text : ''
    // File queue messages (a request for a file the reader holds, or a file handed to them) wake
    // them like a direct message, but ask for a handoff rather than a reply (duties.js).
    const queue = m.kind === 'queue' || m.kind === 'handoff' ? { queue: m.kind, file: typeof m.path === 'string' ? m.path : '' } : {}
    if (m.to === me) events.push({ id: m.id, kind: 'dm', by: m.by, text, ts: m.ts, ...queue })
    else if (!m.to && mentioned(text, [me]).length) events.push({ id: m.id, kind: 'mention', by: m.by, text, ts: m.ts })
  }
  const mine = []
  for (const t of tasks) {
    if (!t || typeof t.id !== 'string' || !assignedToReader(t, reader)) continue
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

/** One event as a line an agent can act on. */
export function describeEvent (e) {
  const who = e.by || 'someone'
  if (e.queue === 'queue') return `${who} asked for ${e.file} in its file queue: ${e.text} Finish what you are doing in it, then hand it off with quilt_handoff and your context.`
  if (e.queue === 'handoff') return `${who} handed you ${e.file}, which you asked for: it is yours to edit now. ${e.text}`
  if (e.kind === 'dm') return `${who} sent you a direct message: ${e.text}`
  if (e.kind === 'mention') return `${who} mentioned you in chat: ${e.text}`
  if (e.kind === 'task') {
    const t = e.task || {}
    const files = t.files && t.files.length ? ` Files: ${t.files.join(', ')}.` : ''
    return `${who} handed you a task: "${e.text}" (id ${e.id}).${files} Pick it up with quilt_move_task (doing) when you start.`
  }
  return `${who}: ${e.text || ''}`
}

export const INBOX_HOW = 'Answer a message with quilt_message (set "to" for a direct reply). Take a task with quilt_move_task.'

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

  /** Events after sequence number `after`, and the latest number to pass next time. */
  since (after = 0) {
    const from = Number(after) || 0
    return { events: this.events.filter((e) => e.seq > from), seq: this.seq }
  }
}
