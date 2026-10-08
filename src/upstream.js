// Catching a folder's branch up with commits it doesn't have yet (pushed from
// a worktree, merged on GitHub, moved by another worktree), without anyone
// running git pull. Quilt never merges git history: the branch only ever moves
// forward to a commit it is behind. What it merges is the session's
// uncommitted work into those commits' files, file by file, the way
// `git pull --autostash` would, except nothing is written unless every file
// merges cleanly.
//
// planCatchUp is pure: session.js reads git and the disk, asks for a plan,
// and applies it (bringIn there).
import { merge3 } from './merge3.js'

const isText = (k) => typeof k === 'string' && !k.startsWith('bin:')

/**
 * How the folder at commit `from` (its files on disk: the commit plus the
 * session's uncommitted work) becomes the folder at `to` with that work kept.
 *
 * - changes: Map path -> git status letter (A, M, D, T...) between the commits.
 * - base / theirs: Map path -> the file at `from` / at `to` (text, "bin:<sha1>",
 *   null when absent, undefined when git couldn't read it).
 * - disk(rel): the file in the folder now (same keys).
 * - moved: candidates for a file the session moved: Map path -> its text, for
 *   files on disk that `from` didn't have (new or moved here).
 * - emptied: folders the session emptied (had files at `from`, none on disk now).
 *
 * Returns { writes: Map path -> key (null: delete), moves: [{ from, to }],
 * conflicts: [{ path, why }], strays: [path] }. With conflicts, writes is empty:
 * a catch-up is all or nothing.
 */
export function planCatchUp ({ changes, base, theirs, disk, moved = new Map(), emptied = new Set() }) {
  const writes = new Map()
  const conflicts = []
  const moves = []
  const strays = []
  const taken = new Set()
  for (const rel of changes.keys()) {
    const b = base.get(rel)
    const t = theirs.get(rel)
    const o = disk(rel)
    if (b === undefined || t === undefined || o === undefined) {
      conflicts.push({ path: rel, why: 'git could not read it (too large, or behind a filter such as Git LFS)' })
      continue
    }
    if (o === b) { // untouched here: the commits' version
      if (t !== o) writes.set(rel, t)
      if (b === null && t !== null && emptied.has(dirOf(rel))) strays.push(rel)
      continue
    }
    if (o === t) continue // the session already has it
    if (o === null && isText(b) && isText(t)) {
      // Gone here, changed there: the session may have moved it. Followed by content, as git
      // follows a rename, into the moved copy, which takes the commits' change.
      const to = findMove(rel, b, moved, taken)
      if (to) {
        const r = merge3(b, moved.get(to), t)
        if (!r.conflicts.length) { taken.add(to); moves.push({ from: rel, to }); if (r.text !== moved.get(to)) writes.set(to, r.text); continue }
        conflicts.push({ path: rel, why: `moved to ${to} here, and changed in the same lines there` })
        continue
      }
      conflicts.push({ path: rel, why: 'deleted here, changed in the new commits' })
      continue
    }
    if (t === null) { conflicts.push({ path: rel, why: 'changed here, deleted in the new commits' }); continue }
    if (b === null) { conflicts.push({ path: rel, why: 'added both here and in the new commits, differently' }); continue }
    if (!isText(b) || !isText(o) || !isText(t)) { conflicts.push({ path: rel, why: 'a binary file changed both here and in the new commits' }); continue }
    const r = merge3(b, o, t)
    if (r.conflicts.length) { conflicts.push({ path: rel, why: 'changed in the same lines here and in the new commits' }); continue }
    if (r.text !== o) writes.set(rel, r.text)
  }
  if (conflicts.length) return { writes: new Map(), moves: [], conflicts, strays: [] }
  return { writes, moves, conflicts, strays }
}

const dirOf = (rel) => rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
const nameOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1)

/** The moved copy of a file: same name, and at least half its lines the same. */
function findMove (rel, text, moved, taken) {
  let best = null
  let score = 0.5
  for (const [to, t] of moved) {
    if (taken.has(to) || nameOf(to) !== nameOf(rel) || !isText(t)) continue
    const s = similarity(text, t)
    if (s >= score) { best = to; score = s }
  }
  return best
}

/** Share of lines in common (multiset), against the longer file. */
export function similarity (a, b) {
  const count = new Map()
  const la = a.split('\n')
  const lb = b.split('\n')
  for (const l of la) count.set(l, (count.get(l) || 0) + 1)
  let same = 0
  for (const l of lb) { const n = count.get(l); if (n) { same++; count.set(l, n - 1) } }
  return same / Math.max(la.length, lb.length, 1)
}

/** One line for the AI and the log about why a catch-up waits. */
export function catchUpAdvice ({ branch, upstream, behind, conflicts, diverged, ahead }) {
  const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`
  if (diverged) return `${branch} and ${upstream} have both moved on (${n(ahead, 'commit')} here, ${n(behind, 'commit')} there). Quilt never merges git history: pull or rebase it yourself in this folder, and the session takes in whatever that changes.`
  const list = conflicts.slice(0, 4).map((c) => `${c.path} (${c.why})`).join('; ') + (conflicts.length > 4 ? `; and ${conflicts.length - 4} more` : '')
  return `${branch} is ${n(behind, 'commit')} behind ${upstream}, and the session's uncommitted work clashes with them in ${list}. Quilt brought nothing in. Run git pull in this folder and resolve those; the session takes in the result.`
}
