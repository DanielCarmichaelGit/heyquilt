// A clash between commits from outside and the session's uncommitted work is
// handed to ONE AI, as a task on the board, instead of every folder behind on
// that branch telling its AI to pull and resolve (several AIs starting the same
// merge). Each folder that reports the clash works out the same owner from
// presence; only the owner's Quilt writes the task, under an id derived from
// the branch and the upstream commit, so two that race write the same task.
// Pure: Session (reviewClash) reads presence and the board and applies these.
import crypto from 'node:crypto'
import { MAX_FILES, MAX_TITLE } from './tasks.js'

const HEX_ID = /^[0-9a-f]{16}$/
const SHA = /^[0-9a-f]{7,64}$/

/** The task id for a clash on `branch` with upstream commit `sha`: the same in every member's Quilt. */
export function clashTaskId (branch, sha) {
  return crypto.createHash('sha256').update(`quilt-clash\n${branch}\n${sha}`).digest('hex').slice(0, 16)
}

/** A clash record from the room's "clashes" map (branch -> record), or null for anything else. */
export function readClash (value, branch) {
  if (!value || typeof value !== 'object') return null
  if (typeof value.task !== 'string' || !HEX_ID.test(value.task)) return null
  if (typeof value.sha !== 'string' || !SHA.test(value.sha)) return null
  if (typeof value.upstream !== 'string' || !value.upstream || value.upstream.length > 200) return null
  const ts = Number.isFinite(value.ts) ? value.ts : 0
  return { branch, task: value.task, sha: value.sha, upstream: value.upstream, ts }
}

/** Whether a member's presence shows a live AI session working through its app (persona.js). */
export function hasAi (st) {
  return !!st && Array.isArray(st.personas) && st.personas.some((p) => p && typeof p.name === 'string' && p.name)
}

/**
 * The members who may take this clash: their folder is on `branch` with `upstream` as its
 * upstream and reports clashing files (not a diverged branch: that history is the folder's own),
 * their Quilt hands clashes out (git.clash 1), and they may change the clashing files.
 * `states`: [[clientID, presence state]], this member's own included.
 * Each: { id, name, kind, ai, rank } (rank 0 an agent member, 1 a person with an AI session, 2 a person).
 */
export function clashCandidates (states, { branch, upstream }) {
  const out = []
  for (const [id, st] of states) {
    if (!st || typeof st.name !== 'string' || !st.name || !st.git || typeof st.git !== 'object') continue
    const g = st.git
    const u = g.upstream
    if (g.clash !== 1 || g.branch !== branch || !u || u.name !== upstream) continue
    if (!(u.conflicts > 0) || u.diverged || u.mayWrite !== true) continue
    const agent = st.kind === 'agent'
    const ai = !agent && hasAi(st)
    out.push({ id, name: st.name, kind: agent ? 'agent' : 'human', ai, rank: agent ? 0 : ai ? 1 : 2 })
  }
  return out
}

/** The candidates in the order they take the clash: an agent member first, then a person with an AI, then anyone; the lowest client id among equals. */
export function clashOrder (candidates) {
  return [...candidates].sort((a, b) => a.rank - b.rank || a.id - b.id)
}

/** Who takes the clash (the first in clashOrder not in `except`), or null. */
export function pickClashOwner (candidates, { except = [] } = {}) {
  return clashOrder(candidates.filter((c) => !except.includes(c.name)))[0] || null
}

/**
 * The presence state of whoever `assignee` is (a member, or one of a member's AI sessions),
 * counted only when that member's folder is on `branch`; null when they are not here.
 */
export function holderOf (states, assignee, branch) {
  for (const [id, st] of states) {
    if (!st || !st.git || st.git.branch !== branch) continue
    if (st.name === assignee || (Array.isArray(st.personas) && st.personas.some((p) => p && p.name === assignee))) return { id, st, rank: st.kind === 'agent' ? 0 : hasAi(st) ? 1 : 2 }
  }
  return null
}

/** How a task's assignee is named in a notice and on the branch list: an agent by name, a person as "<name>'s AI". */
export function ownerLabel ({ assignee, forAi }) {
  return forAi ? `${assignee}'s AI` : assignee
}

const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`

/** The task's title: "Bring 4 commits from origin/main into the session: src/a.js, src/b.js clash". */
export function clashTitle ({ upstream, behind, conflicts = [] }) {
  const head = `Bring ${n(behind, 'commit')} from ${upstream} into the session: `
  const paths = conflicts.map((c) => c.path)
  const tail = paths.length === 1 ? ' clashes' : ' clash'
  const text = (shown) => {
    const rest = paths.length - shown.length
    return head + shown.join(', ') + (rest ? ` and ${rest} more` : '') + tail
  }
  let shown = []
  for (const p of paths) {
    const next = [...shown, p]
    if (shown.length && text(next).length > MAX_TITLE) break
    shown = next
  }
  return text(shown).slice(0, MAX_TITLE)
}

/** The files the task lists (the board keeps at most MAX_FILES). */
export function clashFiles (conflicts = []) {
  return [...new Set(conflicts.map((c) => c.path))].slice(0, MAX_FILES)
}

/** The task's description, as its first comment: each file and why, and what to do. */
export function clashBrief ({ branch, upstream, sha, behind, conflicts = [] }) {
  const lines = [`${n(behind, 'commit')} on ${upstream} (up to ${sha.slice(0, 7)}) clash with the session's uncommitted work, so Quilt brought nothing in:`]
  for (const c of conflicts.slice(0, 30)) lines.push(`- ${c.path}: ${c.why}`)
  if (conflicts.length > 30) lines.push(`- and ${conflicts.length - 30} more`)
  lines.push('', `In your folder on \`${branch}\`: run git pull, resolve those files and git add them. Quilt takes in the result and every other folder on \`${branch}\` follows yours, without merging again. Quilt closes this task by itself once the merge lands (a folder at ${sha.slice(0, 7)} or later with nothing clashing): no need to move it.`)
  return lines.join('\n')
}

/** The notice for a member whose folder is behind but who is not merging: leave it to the owner. */
export function leaveItNotice ({ label, upstream, task, facts }) {
  return `${label} is merging the commits from ${upstream} (task ${task}); leave those files to them.${facts ? ` ${facts}` : ''}`
}

/** What a folder that reports the clash knows about it, without the advice to pull. */
export function clashFacts ({ branch, upstream, behind, conflicts = [] }) {
  const list = conflicts.slice(0, 4).map((c) => `${c.path} (${c.why})`).join('; ') + (conflicts.length > 4 ? `; and ${conflicts.length - 4} more` : '')
  return `${branch} is ${n(behind, 'commit')} behind ${upstream}, and the session's uncommitted work clashes with them in ${list}.`
}

/**
 * The description of a clash the relay hands to a hosted agent (relay-upstream.js): no folder on
 * the branch is online, so the agent merges in the session itself, file by file. The change from
 * upstream for each file follows in the next comments.
 */
export function relayClashBrief ({ branch, upstream, sha, base, behind, conflicts = [], compare = '' }) {
  const lines = [`${n(behind, 'commit')} on ${upstream} (${base.slice(0, 7)} → ${sha.slice(0, 7)}) clash with the session's uncommitted work on \`${branch}\`, and no folder on \`${branch}\` is online, so the relay brought nothing in:`]
  for (const c of conflicts.slice(0, 20)) lines.push(`- ${c.path}: ${c.why}`)
  if (conflicts.length > 20) lines.push(`- and ${conflicts.length - 20} more`)
  lines.push('', `For each file: read it with quilt_read_file, fold in what ${upstream} changed (the next comments${compare ? `, or ${compare}` : ''}) while keeping the session's work, and write the merged file with quilt_write_file, without conflict markers. The relay looks again about every 10 minutes and brings the rest of the commits in once every file merges; Quilt closes this task by itself then: no need to move it.`)
  return lines.join('\n').slice(0, 2000)
}
