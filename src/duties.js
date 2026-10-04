// What an agent owes the people it works with, whatever tool it runs in. Quilt's
// rules used to live in Claude Code hooks (before an edit, after one, before
// finishing); these pure checks are the same rules for every agent, so the local
// MCP, the hosted MCP and the hooks all enforce them alike:
//
// - before editing a file: who holds it, and whether someone asked about it
//   (a message naming the file that this agent has not answered);
// - before finishing: every direct message and mention since it started is
//   answered (a message back to that person, or to everyone, after theirs).
//
// Messages are chat entries ({ id, by, to, text, ts }) the reader can see.

// How far back a message naming a file still counts as a request about it.
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
 * Messages from others that name one of `paths` and that `me` has not answered:
 * people asking about, or warning off, a file this agent is about to change.
 * Each is { path, id, by, to, text, ts }, oldest first.
 */
export function requestsAbout (paths, { messages = [], me, now = Date.now(), windowMs = REQUEST_WINDOW_MS } = {}) {
  const out = []
  for (const m of messages) {
    if (!m || !m.by || m.by === me || typeof m.text !== 'string') continue
    if (m.to && m.to !== me) continue
    if ((m.ts || 0) < now - windowMs) continue
    const hit = (paths || []).find((p) => namesPath(m.text, p))
    if (!hit || answered(messages, me, m.by, m.ts)) continue
    out.push({ path: hit, id: m.id, by: m.by, to: m.to || null, text: m.text, ts: m.ts })
  }
  return out
}

/** Direct messages and mentions among inbox `events` that `me` has not answered yet. */
export function unanswered (events, { messages = [], me } = {}) {
  return (events || []).filter((e) => e && (e.kind === 'dm' || e.kind === 'mention') && e.by !== me && !answered(messages, me, e.by, e.ts))
}

const quote = (t) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim()
  return s.length > 300 ? s.slice(0, 300) + '…' : s
}

/** The lines an agent reads before editing files someone asked about, or '' when nobody did. */
export function renderRequests (requests) {
  if (!requests || !requests.length) return ''
  const lines = requests.map((r) => `- ${r.by}${r.to ? ' (to you)' : ''} about ${r.path}: "${quote(r.text)}"`)
  return 'Before you change these files, read what was asked about them:\n' + lines.join('\n') + '\n' +
    'If someone asked you to leave a file alone, or to change it a certain way, do that, and answer them with quilt_message (to: their name) before or as you edit.'
}

/** Why an agent may not finish yet: the messages it still owes an answer, or '' when it owes none. */
export function renderUnanswered (events) {
  if (!events || !events.length) return ''
  const lines = events.map((e) => `- ${e.by} ${e.kind === 'dm' ? 'sent you a direct message' : 'mentioned you'}: "${quote(e.text)}"`)
  return 'Not yet: these people are still waiting for an answer from you:\n' + lines.join('\n') + '\n' +
    'Answer each with quilt_message (to: their name), even if only to say when you will get to it, then finish again.'
}

/** One refusal for an edit to a file someone else holds: who, and what to do instead of retrying. */
export function heldRefusal (rel, claim, error) {
  const holder = claim ? claim.by : 'someone else'
  const why = claim ? (claim.note ? ` (${claim.note})` : '') : error ? ` (${error})` : ''
  const covered = claim && claim.pattern && claim.pattern !== rel ? `, as part of their claim on ${claim.pattern}` : ''
  return `${rel} is claimed by ${holder}${why}${covered}, so Quilt refuses edits to it and would undo them. Do not retry or work around it. ` +
    `Send ${holder} a direct message with quilt_message (to: "${holder}") saying what you wanted to change in ${rel} and why, ` +
    'and ask them to make the change or hand the file over. Then carry on with other work.'
}
