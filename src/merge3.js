// Three-way merge of text, line by line, the way git does it: changes to
// different lines combine on their own; the same lines changed on both sides
// are a conflict. Used when someone comes back to a session after editing
// offline (base: what they last had; ours: their disk; theirs: the session).
import { diff3Merge } from 'node-diff3'

export const MARK = { start: '<<<<<<< mine', mid: '=======', end: '>>>>>>> session' }

const lines = (s) => s.split('\n')

/**
 * Merges ours and theirs against base. `conflicts` is empty when the merge
 * is clean; `text` then holds the merged file. With conflicts, `text` holds
 * the merge with ours taken for each conflicted region (callers decide what
 * to do with it; see withMarkers).
 */
export function merge3 (base, ours, theirs) {
  const regions = diff3Merge(lines(ours), lines(base), lines(theirs), { excludeFalseConflicts: true })
  const out = []
  const conflicts = []
  for (const r of regions) {
    if (r.ok) { out.push(...r.ok); continue }
    const c = r.conflict
    conflicts.push({ base: c.o, ours: c.a, theirs: c.b })
    out.push(...c.a)
  }
  return { text: out.join('\n'), conflicts }
}

/** The merge written out with git-style markers around each conflict, labelled with people's names. */
export function withMarkers (base, ours, theirs, names) {
  const regions = diff3Merge(lines(ours), lines(base), lines(theirs), { excludeFalseConflicts: true })
  const out = []
  for (const r of regions) {
    if (r.ok) { out.push(...r.ok); continue }
    out.push(`${MARK.start} (${names.mine})`, ...r.conflict.a, MARK.mid, ...r.conflict.b, `${MARK.end} (${names.theirs})`)
  }
  return out.join('\n')
}

/** True when the text still holds markers that withMarkers put there. */
export function hasMarkers (text) {
  return typeof text === 'string' && text.split('\n').some((l) => l.startsWith(`${MARK.start} (`) || l.startsWith(`${MARK.end} (`))
}

/**
 * merge3, plus the clashes where neither side lost anything, resolved the way a person would:
 * - both sides only added lines in the same place (base had nothing there): ours, then theirs,
 *   with lines both start (or end) with written once, so two new sections under the same
 *   heading become one heading with both sections' lines;
 * - both sides changed the same one-line `import { … } from '…'` of the same module: one import
 *   with every name either side has (a name either side removed stays removed).
 * Anything else stays a conflict. Used where commits from elsewhere come in (upstream.js).
 */
export function mergeAdditive (base, ours, theirs) {
  const regions = diff3Merge(lines(ours), lines(base), lines(theirs), { excludeFalseConflicts: true })
  const out = []
  const conflicts = []
  for (const r of regions) {
    if (r.ok) { out.push(...r.ok); continue }
    const c = r.conflict
    const both = c.o.length === 0 ? addedBoth(c.a, c.b) : sameImport(c.o, c.a, c.b)
    if (both) { out.push(...both); continue }
    conflicts.push({ base: c.o, ours: c.a, theirs: c.b })
    out.push(...c.a)
  }
  return { text: out.join('\n'), conflicts }
}

/** Two blocks inserted at one place, as one: shared leading and trailing lines once, the middles in order. */
function addedBoth (a, b) {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let post = 0
  while (post < a.length - pre && post < b.length - pre && a[a.length - 1 - post] === b[b.length - 1 - post]) post++
  return [...a.slice(0, pre), ...a.slice(pre, a.length - post), ...b.slice(pre, b.length - post), ...a.slice(a.length - post)]
}

const IMPORT = /^(\s*import\s*\{)([^}]*)(\}\s*from\s*(['"][^'"]+['"]).*)$/

/** Both sides changed the same one-line import of the same module: the union of its names, or null. */
function sameImport (o, a, b) {
  if (o.length !== 1 || a.length !== 1 || b.length !== 1) return null
  const [mo, ma, mb] = [IMPORT.exec(o[0]), IMPORT.exec(a[0]), IMPORT.exec(b[0])]
  if (!mo || !ma || !mb || mo[4] !== ma[4] || ma[4] !== mb[4]) return null
  const names = (m) => m[2].split(',').map((s) => s.trim()).filter(Boolean)
  const [no, na, nb] = [names(mo), names(ma), names(mb)]
  const gone = new Set(no.filter((n) => !na.includes(n) || !nb.includes(n)))
  const all = [...na, ...nb.filter((n) => !na.includes(n))].filter((n) => !gone.has(n))
  return [`${ma[1]} ${all.join(', ')} ${ma[3]}`]
}
