// The session's branches: which branch each member's folder is on, how it
// stands against its upstream, and every branch and worktree of the
// repository with who last worked on it. Each folder tells the room about its
// own git (Session.gitSummary, in presence); this folds those into one list.
// Pure: Session.status() and the hosted relay both call it.

const str = (v, n) => typeof v === 'string' ? v.slice(0, n) : null
const num = (v) => Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0

/** A member's git summary as it came over presence (anyone's to write), trimmed to its shape. */
export function cleanGit (g) {
  if (!g || typeof g !== 'object') return null
  const u = g.upstream && typeof g.upstream === 'object' ? g.upstream : null
  const r = g.repo && typeof g.repo === 'object' ? g.repo : null
  return {
    branch: str(g.branch, 200),
    key: str(g.key, 200),
    on: str(g.on, 200),
    held: str(g.held, 20),
    upstream: u ? { name: str(u.name, 200), url: str(u.url, 500), behind: num(u.behind), ahead: num(u.ahead), diverged: !!u.diverged, conflicts: num(u.conflicts), waiting: str(u.waiting, 300) } : null,
    repo: r ? {
      worktrees: (Array.isArray(r.worktrees) ? r.worktrees : []).slice(0, 50).map((w) => ({ name: str(w && w.name, 200), branch: str(w && w.branch, 200) })),
      branches: (Array.isArray(r.branches) ? r.branches : []).slice(0, 30).map((b) => ({
        name: str(b && b.name, 200), upstream: str(b && b.upstream, 200), ahead: num(b && b.ahead), behind: num(b && b.behind),
        author: str(b && b.author, 100), ts: num(b && b.ts), subject: str(b && b.subject, 200)
      })).filter((b) => b.name)
    } : null
  }
}

/**
 * One entry per branch: { name, folders: [{ name, held }] (members whose folder is on it),
 * ais: [names] (AI sessions named after it), worktrees: [names], upstream: { name, url,
 * behind, ahead, diverged, conflicts, waiting } | null, last: { author, ts, subject } | null }.
 * Branches someone is on come first, then the rest by last commit. `members`: [{ name, git, persona? }].
 */
export function branchBoard (members) {
  const byName = new Map()
  const entry = (name) => {
    if (!byName.has(name)) byName.set(name, { name, folders: [], ais: [], worktrees: [], upstream: null, last: null })
    return byName.get(name)
  }
  for (const m of members) {
    const g = m.git
    if (!g) continue
    if (g.branch || g.key) {
      const e = entry(g.on || g.key || g.branch)
      e.folders.push({ name: m.name, held: g.held === 'switching' ? null : g.held, upstream: g.upstream })
      if (g.upstream && (!e.upstream || g.upstream.behind < e.upstream.behind)) e.upstream = g.upstream
    }
    if (!g.repo) continue
    for (const b of g.repo.branches) {
      const e = entry(b.name)
      if (!e.last || b.ts > e.last.ts) e.last = { author: b.author, ts: b.ts, subject: b.subject }
      if (!e.upstream && b.upstream) e.upstream = { name: b.upstream, url: null, behind: b.behind, ahead: b.ahead, diverged: b.ahead > 0 && b.behind > 0, conflicts: 0, waiting: null }
    }
    for (const w of g.repo.worktrees) if (w.branch && w.name !== '.' && !entry(w.branch).worktrees.includes(w.name)) entry(w.branch).worktrees.push(w.name)
  }
  // An AI session is named after its work, its git branch when it has one (persona.js).
  for (const m of members) {
    if (!m.persona) continue
    const label = m.name.includes(' · ') ? m.name.slice(m.name.indexOf(' · ') + 3) : null
    if (label && byName.has(label)) byName.get(label).ais.push(m.name)
  }
  const active = (e) => e.folders.length + e.ais.length + e.worktrees.length
  return [...byName.values()].sort((a, b) => (active(b) > 0) - (active(a) > 0) || (b.last?.ts || 0) - (a.last?.ts || 0) || (a.name < b.name ? -1 : 1))
}

const ago = (ts, now) => {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 129600) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

/** One line on how a branch stands against its upstream, or ''. */
export function upstreamLine (u) {
  if (!u || !u.name) return ''
  if (u.diverged) return `diverged from ${u.name} (${u.ahead} ahead, ${u.behind} behind)`
  if (u.conflicts) return `${u.behind} behind ${u.name}; ${u.conflicts} file${u.conflicts === 1 ? '' : 's'} clash with the session's work`
  if (u.waiting) return `${u.behind} behind ${u.name}; waiting: ${u.waiting}`
  if (u.behind) return `${u.behind} behind ${u.name}`
  if (u.ahead) return `${u.ahead} ahead of ${u.name}`
  return `up to date with ${u.name}`
}

/** The board as markdown for an AI (quilt_status, quilt_branches). */
export function branchesMarkdown (board, { now = Date.now(), limit = 12 } = {}) {
  if (!board.length) return '_No git branches: the folders in this session are not git repositories._'
  const out = []
  for (const b of board.slice(0, limit)) {
    const who = [
      ...b.folders.map((f) => `${f.name}'s folder${f.held ? ` (${f.held})` : ''}${f.upstream && (f.upstream.conflicts || f.upstream.diverged) ? ` (${upstreamLine(f.upstream)})` : ''}`),
      ...b.ais.map((n) => `AI session ${n}`),
      ...b.worktrees.map((w) => `worktree \`${w}\``)
    ]
    const line = upstreamLine(b.upstream)
    const bits = [who.length ? `on it: ${who.join(', ')}` : '', who.some((w) => w.includes(`(${line})`)) ? '' : line, b.last ? `last commit ${ago(b.last.ts, now)} by ${b.last.author}: ${b.last.subject}` : ''].filter(Boolean)
    out.push(`- \`${b.name}\`${bits.length ? ` · ${bits.join(' · ')}` : ''}`)
  }
  if (board.length > limit) out.push(`- …and ${board.length - limit} more`)
  return out.join('\n')
}

/** What quilt_sync_branch did, for the AI that asked. */
export function describeBranchSync (r) {
  if (!r || !r.git) return 'This folder is not a git repository: there is no branch to bring commits into.'
  if (!r.branch) return 'This folder is not on a branch (detached HEAD): check out a branch first.'
  if (r.busy) return `Not now: ${r.busy === 'switching' ? 'this folder is moving to the branch you checked out' : r.busy === 'busy' || r.busy === 'settling' ? 'git is at work in this folder' : r.busy}. Quilt looks again by itself in a minute.`
  const u = r.upstream
  if (!u || !u.name) return `\`${r.branch}\` has no upstream (git branch --set-upstream-to sets one), so there is nothing to bring in.`
  if (r.moved) {
    const b = u.brought
    return `Brought ${b && b.count ? `${b.count} commit${b.count === 1 ? '' : 's'}` : 'the new commits'} from ${u.name} into the session (${b ? b.files : 0} file${b && b.files === 1 ? '' : 's'}), merged with its uncommitted work. \`${r.branch}\` is up to date.`
  }
  if (u.conflicts && u.conflicts.length) {
    return `Nothing brought in: ${u.behind} commit${u.behind === 1 ? '' : 's'} on ${u.name} clash with the session's uncommitted work in:\n${u.conflicts.map((c) => `- ${c.path}: ${c.why}`).join('\n')}\nRun git pull in this folder and resolve those; the session takes in the result.`
  }
  return `\`${r.branch}\`: ${upstreamLine(u)}.${u.diverged ? ' Quilt never merges git history: pull or rebase it yourself, and the session takes in whatever that changes.' : ''}`
}
