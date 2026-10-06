// Merge records: a file whose offline and in-session edits could not be
// combined on their own. Kept as plain objects in the shared doc so everyone
// in the session (and every AI) sees the same list and anyone can settle it.
import crypto from 'node:crypto'
import { isSafeRelPath } from './pathrules.js'

export const MAX_RECORD_TEXT = 200_000
export const MAX_MERGES = 50
export const DONE_TTL_MS = 24 * 60 * 60 * 1000
export const KINDS = ['conflict', 'ai', 'claimed']
export const STATES = ['open', 'editing', 'done']
export const HOWS = ['mine', 'theirs', 'hand', 'agent', 'review']
// How the opener's side came about: pulled commits, an edit during a git command, or (null) offline.
export const VIAS = ['pull', 'hold']

/** What the opener did to the file, for agents and status text ("changed it offline"…). */
export function mergeAction (m, deleted = !!m.oursDeleted) {
  if (m.via === 'pull') return deleted ? 'pulled commits that delete it' : 'pulled commits that change it'
  if (m.via === 'hold') return deleted ? 'deleted it during a git command' : 'changed it during a git command'
  return deleted ? 'deleted it offline' : 'changed it offline'
}

const HEX_ID = /^[0-9a-f]{16}$/i
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
// eslint-disable-next-line no-control-regex
const CONTROL_RUN = /[\u0000-\u001f\u007f]+/g
const str = (v, max) => typeof v === 'string' && v.length <= max
const optStr = (v, max) => v == null || str(v, max)
// Names, paths and reasons go verbatim into logs and into the prompt a coding
// tool gets for Send to…: one line each, no control characters.
const line = (v, max) => str(v, max) && !CONTROL.test(v)
const optLine = (v, max) => v == null || line(v, max)

/**
 * A peer-written name (from an activity entry or a claim), made safe to put
 * in a merge record: control characters and newlines become a space,
 * whitespace is collapsed, and it's trimmed and capped at 80 characters.
 * Falls back to 'someone' when that leaves nothing, so a stray control
 * character in a name never suppresses the merge record itself.
 */
export function cleanName (name) {
  const flat = String(name == null ? '' : name).replace(CONTROL_RUN, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
  return flat || 'someone'
}

/** A record we'll show. Anything a modified client pushed that isn't this shape is ignored. */
export function publicMerge (v) {
  if (!v || typeof v !== 'object') return null
  if (typeof v.id !== 'string' || !HEX_ID.test(v.id)) return null
  // A path any member could be made to write: inside the project, never .git or .quilt.
  if (!line(v.path, 1024) || !isSafeRelPath(v.path)) return null
  if (!line(v.by, 80) || !optStr(v.byId, 128)) return null
  if (!Array.isArray(v.others) || v.others.length > 20 || !v.others.every((n) => line(n, 80))) return null
  if (typeof v.ts !== 'number' || !Number.isFinite(v.ts)) return null
  if (!KINDS.includes(v.kind) || !STATES.includes(v.state)) return null
  if (!optStr(v.ours, MAX_RECORD_TEXT) || !optStr(v.base, MAX_RECORD_TEXT) || !optStr(v.theirsHash, 64)) return null
  if (!optLine(v.claimedBy, 80) || !optLine(v.resolvedBy, 80) || !optLine(v.reason, 500)) return null
  if (v.how != null && !HOWS.includes(v.how)) return null
  if (v.doneTs != null && typeof v.doneTs !== 'number') return null
  // Deleted offline: ours is gone, not merely too big to share (records from before this field have none).
  if (v.oursDeleted != null && typeof v.oursDeleted !== 'boolean') return null
  if (v.oursDeleted && v.ours != null) return null
  if (v.via != null && !VIAS.includes(v.via)) return null
  return {
    id: v.id, path: v.path, by: v.by, byId: v.byId ?? null, others: v.others, ts: v.ts,
    kind: v.kind, state: v.state, ours: v.ours ?? null, base: v.base ?? null, theirsHash: v.theirsHash ?? null,
    binary: !!v.binary, local: !!v.local, oursDeleted: !!v.oursDeleted, claimedBy: v.claimedBy ?? null, resolvedBy: v.resolvedBy ?? null,
    how: v.how ?? null, doneTs: v.doneTs ?? null, reason: v.reason ?? null, via: v.via ?? null
  }
}

const rank = (s) => (s === 'done' ? 1 : 0)
const order = (a, b) => rank(a.state) - rank(b.state) || a.ts - b.ts || (a.id < b.id ? -1 : 1)

function split (map) {
  const valid = []
  const junk = []
  map.forEach((v, key) => {
    const m = publicMerge(v)
    if (m && m.id === key) valid.push(m)
    else junk.push(key)
  })
  valid.sort(order)
  return { valid, junk }
}

export function readMerges (map) {
  return split(map).valid
}

/** Opens a record. Text beyond the cap stays on the opener's disk only (`local`); `oursDeleted`: the opener deleted the file. */
export function openMerge (doc, map, { path, by, byId = null, others = [], kind, ours = null, oursDeleted = false, base = null, theirsHash = null, binary = false, claimedBy = null, reason = null, via = null }, origin) {
  if (!KINDS.includes(kind)) throw new Error('bad merge kind')
  const fits = (t) => t == null || t.length <= MAX_RECORD_TEXT
  const local = !fits(ours) || !fits(base)
  const rec = {
    id: crypto.randomBytes(8).toString('hex'),
    path, by, byId, others: others.filter((n) => n && n !== by).slice(0, 20), ts: Date.now(),
    kind, state: 'open',
    ours: fits(ours) ? ours : null, base: fits(base) ? base : null, theirsHash, binary: !!binary, local, oursDeleted: !!oursDeleted,
    claimedBy, resolvedBy: null, how: null, doneTs: null, reason, via
  }
  const out = publicMerge(rec)
  if (!out) throw new Error('bad merge record') // never write what readers would drop as junk
  doc.transact(() => {
    for (const key of split(map).junk) map.delete(key)
    map.set(rec.id, rec)
  }, origin)
  return out
}

/** Changes state, how, resolvedBy or reason. Setting state to done stamps doneTs. */
export function updateMerge (doc, map, id, patch, origin) {
  const cur = publicMerge(map.get(id))
  if (!cur) throw new Error('no such merge')
  const next = { ...cur }
  if (patch.state !== undefined) {
    if (!STATES.includes(patch.state)) throw new Error('bad merge state')
    next.state = patch.state
    if (patch.state === 'done') next.doneTs = Date.now()
  }
  if (patch.how !== undefined) {
    if (patch.how != null && !HOWS.includes(patch.how)) throw new Error('bad merge how')
    next.how = patch.how
  }
  if (patch.resolvedBy !== undefined) next.resolvedBy = patch.resolvedBy
  if (patch.reason !== undefined) next.reason = patch.reason
  const out = publicMerge(next)
  if (!out) throw new Error('bad merge record')
  doc.transact(() => map.set(id, next), origin)
  return out
}

/** Drops done records older than a day, and the oldest done ones beyond MAX_MERGES. Open ones are kept. */
export function pruneMerges (doc, map, origin, now = Date.now()) {
  const { valid, junk } = split(map)
  const drop = new Set(junk)
  const done = valid.filter((m) => m.state === 'done').sort((a, b) => (a.doneTs || 0) - (b.doneTs || 0))
  for (const m of done) if (m.doneTs && now - m.doneTs > DONE_TTL_MS) drop.add(m.id)
  let count = valid.length - drop.size
  for (const m of done) {
    if (count <= MAX_MERGES) break
    if (!drop.has(m.id)) { drop.add(m.id); count-- }
  }
  if (!drop.size) return
  doc.transact(() => { for (const id of drop) map.delete(id) }, origin)
}
