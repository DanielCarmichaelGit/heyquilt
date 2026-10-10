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
 * A message's text as HTML: escaped, with lightweight markdown (**bold**, *italic*,
 * ## headings, ---- rules) and every @Name of `names` (the session's members, any
 * case, whole names only) marked up as a mention, and one of `me` marked as mine.
 * The mention rule is the one agents wake on (`mentioned` in src/inbox.js): the @
 * starts a word, so an email address is not a mention, and the name ends one.
 * `meAgent`: the reader is an agent, so an @Agents mention is theirs too.
 */
const PH_OPEN = '\uE000'
const PH_CLOSE = '\uE001'

/** One line: escape, **bold** / *italic*, then restore @mention placeholders. */
function formatLine (line, names, me, { meAgent = false } = {}) {
  const list = [...new Set((names || []).map((n) => String(n || '').trim()).filter(Boolean))].sort((a, b) => b.length - a.length)
  const placeholders = []
  let work = line
  if (list.length && line.includes('@')) {
    const re = new RegExp(`(^|[^\\w@])(@(?:${list.map(escapeRe).join('|')}))(?![\\w-])`, 'giu')
    work = line.replace(re, (full, pre, mention) => {
      const name = mention.slice(1)
      const mine = (!!me && name.toLowerCase() === String(me).toLowerCase()) || (meAgent && name.toLowerCase() === ALL_AGENTS.toLowerCase())
      const i = placeholders.length
      placeholders.push(`<span class="mention${mine ? ' me' : ''}">${esc(mention)}</span>`)
      return `${pre}${PH_OPEN}${i}${PH_CLOSE}`
    })
  }
  let s = esc(work)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
  if (placeholders.length) {
    s = s.replace(new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, 'g'), (_, i) => placeholders[Number(i)] || '')
  }
  return s
}

export function textHtml (text, names = [], me = '', opts = {}) {
  const t = String(text ?? '')
  if (!t) return ''
  return t.split('\n').map((line) => {
    if (/^-{3,}\s*$/.test(line)) return '<hr class="md-hr">'
    const head = line.match(/^(#{1,6})\s+(.*)$/)
    if (head) return `<span class="md-h">${formatLine(head[2], names, me, opts)}</span>`
    return formatLine(line, names, me, opts)
  }).join('\n')
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

// One name for all of a person's AI sessions. People see "Daniel's AI" rather than each chat
// ("Daniel · file-queue", "Daniel · Claude Code 3"), and can write to it: the session of theirs
// active most recently answers (src/session.js leadPersona).
export const AI_SUFFIX = '\'s AI'

/** "Daniel's AI": every AI session working through Daniel's app, as one name. */
export const aiName = (person) => `${String(person || '').trim()}${AI_SUFFIX}`

/**
 * Peers as people see them: the AI sessions of each person (persona: true, of: person) folded
 * into one "<person>'s AI" entry listing them under `sessions`. Order is kept (first seen wins).
 */
export function foldPersonas (peers) {
  const out = []
  const groups = new Map()
  for (const p of peers || []) {
    if (!p || !p.persona || !p.of) { out.push(p); continue }
    let g = groups.get(p.of)
    if (!g) {
      g = { name: aiName(p.of), kind: 'agent', aiOf: p.of, ...(p.mine ? { mine: true } : {}), tool: '', agents: [], focus: '', editing: [], sessions: [] }
      groups.set(p.of, g)
      out.push(g)
    }
    g.sessions.push({ name: p.name, tool: p.tool || '', focus: p.focus || '' })
    if (p.tool && !g.agents.includes(p.tool)) g.agents.push(p.tool)
  }
  return out
}

const PERSONA_SEP = ' · ' // src/persona.js: "Daniel · file-queue"
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || ''

/**
 * Whose AI session each name is, for showing it as "<person>'s AI": from the session's peers
 * (persona: true, of), messages that say (m.of), and, for older messages, a name of the form
 * "<first name> · <label>" whose first name is one of `people`. Returns name -> person.
 */
export function aiOwners ({ peers = [], messages = [], people = [] } = {}) {
  const owners = new Map()
  for (const p of peers || []) if (p && p.persona && typeof p.of === 'string' && p.of) owners.set(p.name, p.of)
  // Messages come from the room, so m.of is believed only for a name its person's AI sessions get.
  for (const m of messages || []) if (m && typeof m.of === 'string' && m.of && typeof m.by === 'string' && m.by.startsWith(firstName(m.of) + PERSONA_SEP)) owners.set(m.by, m.of)
  const byFirst = new Map()
  for (const n of people || []) if (typeof n === 'string' && n && !n.includes(PERSONA_SEP)) byFirst.set(firstName(n), byFirst.has(firstName(n)) ? null : n)
  const guess = (name) => {
    if (typeof name !== 'string' || owners.has(name) || !name.includes(PERSONA_SEP)) return
    const person = byFirst.get(name.split(PERSONA_SEP)[0].trim())
    if (person) owners.set(name, person)
  }
  for (const m of messages || []) { guess(m && m.by); guess(m && m.to) }
  return owners
}

/** A name as people see it: one of someone's AI sessions is "<person>'s AI". */
export const shownName = (name, owners) => owners && owners.has(name) ? aiName(owners.get(name)) : name

/**
 * True when a message is one of a person's AI sessions writing to another of their own (by
 * name, or as "<person>'s AI"): their working out among themselves, which the chat leaves out.
 */
export function ownAiChatter (m, owners) {
  const of = owners && m && owners.get(m.by)
  if (!of) return false
  const sibling = (n) => n === aiName(of) || (owners.get(n) === of && n !== m.by)
  if (m.to) return sibling(m.to)
  const text = String(m.text || '')
  // Longest names first, so "@Daniel · y" is that session and not a mention of Daniel.
  const names = [...new Set([...owners.keys(), ...owners.values(), aiName(of)])].sort((a, b) => b.length - a.length)
  const re = new RegExp(`(^|[^\\w@])@(${names.map(escapeRe).join('|')})(?![\\w-])`, 'giu')
  const hit = [...text.matchAll(re)].map((x) => names.find((n) => n.toLowerCase() === x[2].toLowerCase()))
  return hit.length > 0 && hit.every(sibling)
}

// ---------------------------------------------------------------- typing --
// Who is typing travels in presence (each member's awareness state, field `typing`):
// { [name]: { ts, ms, to } }, one entry per name the member speaks for (themselves and
// their AI sessions). `ms` is how long the signal lasts unless refreshed: a person's
// keystrokes refresh it every few seconds; an AI says it once before it writes.

/** How long "is typing" lasts after a person's last keystroke. */
export const TYPING_MS = 6000
/** How long an AI's "is typing" lasts at most, unless it says it again or sends. */
export const AGENT_TYPING_MS = 30000

/** A typing entry from the room as { ms, to }, or null when it is not one. Peer-controlled. */
export function cleanTyping (v) {
  if (!v || typeof v !== 'object' || typeof v.ts !== 'number') return null
  const ms = Math.min(Math.max(Number(v.ms) || TYPING_MS, 1000), AGENT_TYPING_MS)
  const to = typeof v.to === 'string' && v.to ? v.to.slice(0, 80) : null
  return { ts: v.ts, ms, to }
}

/**
 * The names typing to `me` now, in order: `peers` from status (each with `typing`
 * true and maybe `typingTo`), without me and without direct messages to someone else.
 */
export function typingNames (peers, me = '') {
  const out = []
  for (const p of Array.isArray(peers) ? peers : []) {
    if (!p || !p.typing || typeof p.name !== 'string' || !p.name || p.name === me) continue
    if (p.typingTo && p.typingTo !== me) continue
    if (!out.includes(p.name)) out.push(p.name)
  }
  return out
}

/** "Dana is typing…", "Dana and Bob are typing…", "Dana, Bob and 2 others are typing…", or ''. */
export function typingText (names) {
  const n = (names || []).filter(Boolean)
  if (!n.length) return ''
  if (n.length === 1) return `${n[0]} is typing…`
  if (n.length === 2) return `${n[0]} and ${n[1]} are typing…`
  if (n.length === 3) return `${n[0]}, ${n[1]} and ${n[2]} are typing…`
  return `${n[0]}, ${n[1]} and ${n.length - 2} others are typing…`
}

/** The chat's typing line as HTML: three bouncing dots and who is typing. '' when nobody is. */
export function typingHtml (names) {
  const t = typingText(names)
  if (!t) return ''
  return `<span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="typing-text">${esc(t)}</span>`
}
