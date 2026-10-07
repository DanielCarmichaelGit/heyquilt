// Chat messages come from the shared room, so every field is peer-controlled.
// Pure helpers (no DOM) so the UI's handling of them can be tested in node.

// Message ids are made locally from random bytes (src/session.js); nothing else is ours.
export const MESSAGE_ID = /^[a-f0-9]{8,32}$/

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const optionalString = (v) => v == null || typeof v === 'string'

/** True when a message from the room has the shape the UI renders; anything else is dropped. */
export function validMessage (m) {
  if (!m || typeof m !== 'object') return false
  if (typeof m.id !== 'string' || !MESSAGE_ID.test(m.id)) return false
  if (typeof m.by !== 'string' || !optionalString(m.to) || !optionalString(m.text)) return false
  if (m.file != null && (typeof m.file !== 'object' || typeof m.file.name !== 'string' || typeof m.file.size !== 'number')) return false
  return true
}

/** The messages of a session the UI will render, in order. */
export const renderable = (list) => (Array.isArray(list) ? list : []).filter(validMessage)

/** The link that downloads the file a message carries, from the local UI server. Safe in an attribute. */
export function fileCardHref (session, id, token) {
  return esc(`/api/sessions/${encodeURIComponent(session)}/files/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`)
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** @Agents mentions every agent in the session at once (ALL_AGENTS in src/inbox.js). */
export const ALL_AGENTS = 'Agents'

/**
 * A message's text as HTML: escaped, with every @Name of `names` (the session's
 * members, any case, whole names only) marked up as a mention, and one of `me` marked
 * as mine. The rule is the one agents wake on (`mentioned` in src/inbox.js): the @
 * starts a word, so an email address is not a mention, and the name ends one.
 * `meAgent`: the reader is an agent, so an @Agents mention is theirs too.
 */
export function textHtml (text, names = [], me = '', { meAgent = false } = {}) {
  const t = String(text ?? '')
  const list = [...new Set((names || []).map((n) => String(n || '').trim()).filter(Boolean))].sort((a, b) => b.length - a.length)
  if (!list.length || !t.includes('@')) return esc(t)
  const re = new RegExp(`(^|[^\\w@])(@(?:${list.map(escapeRe).join('|')}))(?![\\w-])`, 'giu')
  let out = ''
  let last = 0
  for (const m of t.matchAll(re)) {
    const start = m.index + m[1].length
    const name = m[2].slice(1)
    const mine = (!!me && name.toLowerCase() === String(me).toLowerCase()) || (meAgent && name.toLowerCase() === ALL_AGENTS.toLowerCase())
    out += esc(t.slice(last, start)) + `<span class="mention${mine ? ' me' : ''}">${esc(m[2])}</span>`
    last = start + m[2].length
  }
  return out + esc(t.slice(last))
}

/**
 * The @mention being typed just before `caret` in `text`: { start, query } (start is
 * the @'s index), or null when the caret is not in one. The query has no spaces, so a
 * name with spaces is found by its first word.
 */
export function mentionAt (text, caret) {
  const before = String(text ?? '').slice(0, caret)
  const m = before.match(/(^|[^\w@])@([^\s@]*)$/u)
  if (!m) return null
  return { start: before.length - m[2].length - 1, query: m[2] }
}

/** The names that complete `query` (any case; a name's start, or the start of a word in it), at most 8. */
export function mentionCandidates (names, query) {
  const q = String(query ?? '').toLowerCase()
  const seen = new Set()
  const out = []
  for (const n of names || []) {
    const name = String(n || '').trim()
    const key = name.toLowerCase()
    if (!name || seen.has(key)) continue
    seen.add(key)
    if (!q || key.startsWith(q) || key.split(/\s+/).some((w) => w.startsWith(q))) out.push(name)
  }
  return out.sort((a, b) => a.localeCompare(b)).slice(0, 8)
}

/** `text` with the mention at `at` (from mentionAt) completed to `@name `, and where the caret goes. */
export function completeMention (text, at, name) {
  const t = String(text ?? '')
  const end = at.start + 1 + at.query.length
  const rest = t.slice(end)
  const head = `${t.slice(0, at.start)}@${name}${rest.startsWith(' ') ? '' : ' '}`
  return { text: head + rest, caret: head.length + (rest.startsWith(' ') ? 1 : 0) }
}
