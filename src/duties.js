// What an agent owes the people it works with, and what it should know before it acts,
// whatever tool it runs in. Pure checks shared by the local MCP, the hosted MCP and the
// Claude Code hooks, so every agent gets the same rules:
//
// - before editing a file: who holds it (claims are what keep agents off each other's
//   files), and what was said about it in chat lately, as context;
// - before moving work on (claims, tasks, commits, "done"): every direct message and
//   mention is answered (a message back to that person, or to everyone, after theirs);
// - before finishing or letting go of a file: anyone waiting for it in its file queue is
//   handed it, with the holder's context (quilt_handoff). A file someone else holds is
//   asked for in its queue (quilt_request_file), not taken.
//
// Chat never blocks a file: Quilt can't tell "don't touch it" from "is it done?". A file
// is held by a claim; a message about it is something the agent reads.
//
// Messages are chat entries ({ id, by, to, text, ts }) the reader can see.
import { mentioned } from './inbox.js'

// How far back chat about a file is still worth reading before editing it.
export const REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Does `text` name `rel`? The whole path counts, and so does a file name with an
 * extension (app.js), as its own word: "src/app.js", "`app.js`" and "app.js?" do,
 * "myapp.js" and "app.json" don't.
 */
export function namesPath (text, rel) {
  const t = String(text || '')
  const p = String(rel || '').replace(/^\.\//, '')
  if (!t || !p) return false
  const base = p.split('/').pop()
  const tokens = [p]
  if (base !== p && /\.\w/.test(base)) tokens.push(base)
  return tokens.some((tok) => new RegExp(`(^|[^\\w.-])${escapeRe(tok)}(?![\\w-]|\\.\\w)`, 'u').test(t))
}

/** Did `me` write back to `who` (directly, or to everyone) after `ts`? */
export function answered (messages, me, who, ts) {
  return (messages || []).some((m) => m && m.by === me && (m.ts || 0) > (ts || 0) && (!m.to || m.to === who))
}

/**
 * Recent chat from others that names one of `paths`: what people said about the files this
 * agent is about to change (asked for, warned off, planned). Each is
 * { path, id, by, to, text, ts, answered }, oldest first; `answered` is whether `me` wrote
 * back to that person (or everyone) since.
 */
export function chatAbout (paths, { messages = [], me, now = Date.now(), windowMs = REQUEST_WINDOW_MS } = {}) {
  const out = []
  for (const m of messages) {
    if (!m || !m.by || m.by === me || typeof m.text !== 'string') continue
    if (m.to && m.to !== me) continue
    if ((m.ts || 0) < now - windowMs) continue
    const hit = (paths || []).find((p) => namesPath(m.text, p))
    if (!hit) continue
    out.push({ path: hit, id: m.id, by: m.by, to: m.to || null, text: m.text, ts: m.ts, answered: answered(messages, me, m.by, m.ts) })
  }
  return out
}

/**
 * Straight from the chat: direct messages to `me` and mentions of `me` (recent, from others)
 * with no later message from `me` to that person or everyone, as inbox-like events.
 */
export function waitingOn (messages, me, { now = Date.now(), windowMs = REQUEST_WINDOW_MS } = {}) {
  const out = []
  for (const m of messages || []) {
    if (!m || !m.by || m.by === me || typeof m.text !== 'string' || (m.ts || 0) < now - windowMs) continue
    if (fileQueueMessage(m)) continue // a file queue request or a handoff: handled by handing off, not by a reply
    const kind = m.to === me ? 'dm' : !m.to && mentioned(m.text, [me]).length ? 'mention' : null
    if (kind && !answered(messages, me, m.by, m.ts)) out.push({ id: m.id, kind, by: m.by, text: m.text, ts: m.ts })
  }
  return out
}

/** A message the relay wrote for the file queue: someone asking for a file, or a file handed over. */
export const fileQueueMessage = (m) => !!m && (m.kind === 'queue' || m.kind === 'handoff')

/** Direct messages and mentions among inbox `events` that `me` has not answered yet. */
export function unanswered (events, { messages = [], me } = {}) {
  return (events || []).filter((e) => e && (e.kind === 'dm' || e.kind === 'mention') && !e.queue && e.by !== me && !answered(messages, me, e.by, e.ts))
}

/**
 * Files `me` holds that someone is waiting for: [{ pattern, queue: [{ id, path, by, title,
 * description, task }] }], from the relay's claim list.
 */
export function queuedFor (claims, me) {
  return (claims || []).filter((c) => c && c.by === me && Array.isArray(c.queue) && c.queue.length).map((c) => ({ pattern: c.pattern, queue: c.queue }))
}

const requestLine = (r) => `${r.by}${r.path ? ` (for ${r.path})` : ''}: "${quote(r.title)}"${r.description ? ` — ${quote(r.description)}` : ''}${r.task ? ` (task ${r.task})` : ''}`

/** Who is waiting for the files `me` holds, as lines an agent reads with every answer; '' when nobody is. */
export function renderQueueNotice (held) {
  if (!held || !held.length) return ''
  const lines = held.map((h) => `- ${h.pattern}: ${h.queue.map(requestLine).join('; then ')}`)
  return 'Waiting in the file queue for files you hold:\n' + lines.join('\n') + '\n' +
    'Finish the change you are making to each, then hand it off with quilt_handoff (path, and context: what you changed, what is left, anything they should know). ' +
    'You cannot finish or release these files until you do.'
}

/** Why an agent may not finish (or let go of files) yet: files it holds that someone is waiting for. '' when none. */
export function renderQueued (held, then = 'finish again') {
  if (!held || !held.length) return ''
  return 'Not yet: ' + renderQueueNotice(held).replace(/^Waiting/, 'people are waiting') + ` Then ${then}.`
}

const quote = (t) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim()
  return s.length > 300 ? s.slice(0, 300) + '…' : s
}

const ago = (ts, now) => {
  const m = Math.max(0, Math.round((now - (ts || now)) / 60000))
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`
}

/** What was said about the files an agent is about to change, newest last, or '' when nothing was. */
export function renderChatAbout (said, { now = Date.now(), max = 8 } = {}) {
  if (!said || !said.length) return ''
  const shown = said.slice(-max)
  const lines = shown.map((r) => `- ${r.by}${r.to ? ' (to you)' : ''}, ${ago(r.ts, now)}, about ${r.path}: "${quote(r.text)}"${r.answered ? '' : ' (you have not replied)'}`)
  const more = said.length > shown.length ? `\n(and ${said.length - shown.length} earlier: quilt_read_messages)` : ''
  return 'What people said in chat about these files:\n' + lines.join('\n') + more + '\n' +
    'Take it into account: if they asked you to leave a file alone or to change it a certain way, do that, and reply to anyone you have not replied to with quilt_message.'
}

/**
 * Why an agent may not go on yet: the messages it still owes an answer, or '' when it owes none.
 * `then` says what to do once they're answered ("finish again", "call quilt_claim again").
 */
export function renderUnanswered (events, then = 'finish again') {
  if (!events || !events.length) return ''
  const lines = events.map((e) => `- ${e.by} ${e.kind === 'dm' ? 'sent you a direct message' : 'mentioned you'}: "${quote(e.text)}"`)
  return 'Not yet: these people are still waiting for an answer from you:\n' + lines.join('\n') + '\n' +
    `Answer each with quilt_message (to: their name), even if only to say when you will get to it, then ${then}. ` +
    'Reading, messaging and checking files work meanwhile.'
}

/** One refusal for an edit to a file someone else holds: who, and what to do instead of retrying. */
export function heldRefusal (rel, claim, error) {
  const holder = claim ? claim.by : 'someone else'
  const why = claim ? (claim.note ? ` (${claim.note})` : '') : error ? ` (${error})` : ''
  const covered = claim && claim.pattern && claim.pattern !== rel ? `, as part of their claim on ${claim.pattern}` : ''
  return `${rel} is claimed by ${holder}${why}${covered}, so Quilt refuses edits to it and would undo them. ${askForIt(rel, claim)}`
}

/** What to do about a file someone else holds: ask for it in its file queue, and carry on. */
export function askForIt (rel, claim) {
  const holder = claim ? claim.by : 'its holder'
  const waiting = claim && Array.isArray(claim.queue) && claim.queue.length ? ` ${claim.queue.length} already waiting for it.` : ''
  return `Do not retry or work around it.${waiting} ` +
    `Ask for it in its file queue with quilt_request_file (path "${rel}", a title like "Working on <what> for <task>", and a description of up to 300 characters: what you plan to change and why). ` +
    `${holder} is told, and hands it to you with their context when they are done; you are woken when it is yours. Carry on with other work meanwhile.`
}
