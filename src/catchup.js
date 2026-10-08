// "While you were away": what the session did between this folder's last stop
// and its rejoin. Built from the shared history (history.js) by comparing the
// entries the saved doc already had with the ones the relay brought, so it
// needs no clocks to agree and nothing new on the relay. Shown in the app and
// in every tool's quilt_status until the person dismisses it.

/** id -> ts of every history entry the doc has now (a folded entry keeps its id but moves its ts). */
export function historyMarks (entries) {
  const marks = new Map()
  for (const e of entries || []) if (e && e.id) marks.set(e.id, e.ts)
  return marks
}

/**
 * The changes others made that `marks` (taken before syncing) hadn't seen,
 * grouped by person, newest first. `partial`: the history was trimmed past
 * where we left off, so older changes may be missing from the list.
 */
export function awayChanges (entries, marks, me) {
  const list = (entries || []).filter((e) => e && e.id && e.path && (!marks.has(e.id) || marks.get(e.id) !== e.ts))
  const people = new Map()
  for (const e of list) {
    if (e.by === me) continue
    const p = people.get(e.by) || { name: e.by, added: 0, removed: 0, ts: 0, files: new Map() }
    // A folded entry we had seen as "created" was already there for us: it's an edit now.
    const kind = e.kind === 'created' && marks.has(e.id) ? 'edited' : e.kind
    const f = p.files.get(e.path) || { path: e.path, kind, added: 0, removed: 0, ts: 0 }
    // Created then edited is still new; deleted last is gone.
    if (kind === 'deleted') f.kind = 'deleted'
    else if (f.kind === 'deleted' || (f.kind !== 'created' && kind === 'created')) f.kind = kind
    f.added += e.added || 0; f.removed += e.removed || 0; f.ts = Math.max(f.ts, e.ts || 0)
    if (e.pulled) f.pulled = true
    p.added += e.added || 0; p.removed += e.removed || 0; p.ts = Math.max(p.ts, e.ts || 0)
    p.files.set(e.path, f)
    people.set(e.by, p)
  }
  const newest = (a, b) => b.ts - a.ts
  const out = [...people.values()].map((p) => ({ ...p, files: [...p.files.values()].sort(newest) })).sort(newest)
  const partial = marks.size > 0 && entries.length > 0 && !entries.some((e) => e && marks.has(e.id))
  return { people: out, partial }
}

/**
 * Folds a new catch-up into one not yet dismissed (the person left and came
 * back again before reading it): changes add up, notes are kept once.
 */
export function mergeCatchUp (prev, next) {
  if (!prev) return next
  const people = new Map(prev.people.map((p) => [p.name, { ...p, files: new Map(p.files.map((f) => [f.path, { ...f }])) }]))
  for (const p of next.people) {
    const q = people.get(p.name) || { name: p.name, added: 0, removed: 0, ts: 0, files: new Map() }
    q.fileCount = Math.max(q.fileCount || 0, p.fileCount || 0)
    q.added += p.added; q.removed += p.removed; q.ts = Math.max(q.ts, p.ts)
    for (const f of p.files) {
      const g = q.files.get(f.path)
      if (!g) { q.files.set(f.path, { ...f }); continue }
      g.added += f.added; g.removed += f.removed; g.ts = Math.max(g.ts, f.ts)
      g.kind = f.kind === 'deleted' ? 'deleted' : g.kind === 'created' && f.kind !== 'deleted' ? 'created' : f.kind
      if (f.pulled) g.pulled = true
    }
    people.set(p.name, q)
  }
  const newest = (a, b) => b.ts - a.ts
  const uniq = (xs, key) => [...new Map(xs.map((x) => [key(x), x])).values()]
  return {
    ...next,
    since: prev.since ?? next.since,
    first: prev.first || next.first,
    pulled: (prev.pulled || 0) + (next.pulled || 0),
    partial: prev.partial || next.partial,
    people: [...people.values()].map((p) => ({ ...p, fileCount: Math.max(p.fileCount || 0, p.files.size), files: [...p.files.values()].sort(newest) })).sort(newest),
    backups: uniq([...(prev.backups || []), ...(next.backups || [])], (b) => b.copy),
    mine: {
      shared: (prev.mine?.shared || 0) + (next.mine?.shared || 0),
      merged: uniq([...(prev.mine?.merged || []), ...(next.mine?.merged || [])], (p) => p),
      conflicts: uniq([...(prev.mine?.conflicts || []), ...(next.mine?.conflicts || [])], (p) => p)
    }
  }
}

/** True when there's nothing worth showing. */
export function emptyCatchUp (c) {
  return !c || (!c.people.length && !c.pulled && !(c.backups || []).length && !c.mine?.shared && !(c.mine?.merged || []).length && !(c.mine?.conflicts || []).length)
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const kindWord = (k) => k === 'created' ? 'new' : k === 'deleted' ? 'deleted' : null

/** The catch-up as Markdown lines, for quilt_status / STATUS.md / `quilt status`. */
export function catchUpMarkdown (c, { ago = () => '' } = {}) {
  if (emptyCatchUp(c)) return []
  const out = [`## While you were away${c.since ? ` (you left ${ago(c.since)})` : ''}`]
  if (c.first && c.pulled) out.push(`- The session put ${plural(c.pulled, 'file')} in this folder when you joined.`)
  for (const p of c.people) {
    const files = p.files.slice(0, 12).map((f) => {
      const k = kindWord(f.kind)
      return `\`${f.path}\` (${k || `+${f.added} -${f.removed}`}${f.pulled ? ', pulled from git' : ''})`
    })
    const n = Math.max(p.fileCount || 0, p.files.length)
    if (n > files.length) files.push(`and ${n - files.length} more`)
    out.push(`- **${p.name}** changed ${plural(n, 'file')}, +${p.added} -${p.removed}: ${files.join(', ')}`)
  }
  if (c.partial) out.push('- Older changes from while you were away are no longer in the history.')
  const m = c.mine || {}
  if (m.shared) out.push(`- Your ${plural(m.shared, 'change')} from while you were away went into the session.`)
  if (m.merged?.length) out.push(`- Combined with the session's changes: ${m.merged.map((p) => `\`${p}\``).join(', ')}.`)
  if (m.conflicts?.length) out.push(`- Clashed with the session's changes (the session's version is in the file, yours is in the merge; see quilt_merges): ${m.conflicts.map((p) => `\`${p}\``).join(', ')}.`)
  if (c.backups?.length) out.push(`- Your copies of ${plural(c.backups.length, 'file')} differed from the session's and were replaced; they are kept: ${c.backups.map((b) => `\`${b.path}\` → \`${b.copy}\``).join(', ')}.`)
  out.push('Read quilt_history for the diffs before you change these files.')
  return out
}
