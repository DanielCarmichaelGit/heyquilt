// The session's branches: which branch each member's folder is on, how it
// stands against its upstream, and every branch and worktree of the
// repository with who last worked on it. Each folder tells the room about its
// own git (Session.gitSummary, in presence); this folds those into one list.
// Pure: Session.status() and the hosted relay both call it.

// Who the relay is in the activity log, the chronology and the branch list, when it brings
// commits in itself for a branch no folder is online on (relay-upstream.js).
export const RELAY_BY = 'the relay'

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
    upstream: u ? { name: str(u.name, 200), url: str(u.url, 500), behind: num(u.behind), ahead: num(u.ahead), diverged: !!u.diverged, conflicts: num(u.conflicts), waiting: str(u.waiting, 300), mergedBy: str(u.mergedBy, 120), clashTask: typeof u.clashTask === 'string' && /^[0-9a-f]{16}$/.test(u.clashTask) ? u.clashTask : null, ...(u.fetchOk === false ? { fetchOk: false, fetchError: str(u.fetchError, 200) || 'git fetch failed' } : {}) } : null,
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
 * ais: [names] (AI sessions named after it), worktrees: [names], hosted: [names] (hosted agents
 * working on it, from the room's branch list), upstream: { name, url,
 * behind, ahead, diverged, conflicts, waiting } | null, last: { author, ts, subject } | null,
 * session: true when the branch has a live document in this session (a copy, whether or not
 * anyone is on it right now), default: true for the room's default branch, full: true when its
 * document is over the session's size limit (it takes no new changes), relay: what the relay
 * brought in itself while no folder was on it, and when it last looked (relayLine) | null }.
 * Branches someone is on come first, then the rest by last commit. `members`: [{ name, git, persona? }].
 * `sessionBranches`: the room's own branch list (Session.branchList / the relay's), [{ key, default, full }].
 */
export function branchBoard (members, sessionBranches = []) {
  const byName = new Map()
  const entry = (name) => {
    if (!byName.has(name)) byName.set(name, { name, folders: [], ais: [], worktrees: [], hosted: [], upstream: null, last: null, session: false, default: false, full: false, relay: null })
    return byName.get(name)
  }
  for (const m of members) {
    const g = m.git
    if (!g) continue
    if (g.branch || g.key) {
      const e = entry(g.on || g.key || g.branch)
      e.folders.push({ name: m.name, held: g.held === 'switching' ? null : g.held, upstream: g.upstream })
      // The folder that sees the most: one whose fetch works over one whose doesn't, then the least behind.
      const better = (a, b) => !b || ((a.fetchOk === false) !== (b.fetchOk === false) ? b.fetchOk === false : a.behind < b.behind)
      if (g.upstream && better(g.upstream, e.upstream)) e.upstream = g.upstream
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
  // Every branch with a live copy in the session, whether or not anyone is on it right now
  // (it still appears here), and which one is the room's default.
  for (const b of (Array.isArray(sessionBranches) ? sessionBranches : [])) {
    if (!b || typeof b.key !== 'string') continue
    const e = entry(b.key)
    e.session = true
    if (b.default) e.default = true
    if (b.full) e.full = true
    if (b.relay && typeof b.relay === 'object') e.relay = b.relay
    for (const n of (Array.isArray(b.hosted) ? b.hosted : [])) if (!e.hosted.includes(n)) e.hosted.push(n)
  }
  const active = (e) => e.folders.length + e.ais.length + e.worktrees.length + e.hosted.length
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
  // A fetch that failed: what git last knew is stale, so never "up to date".
  if (u.fetchOk === false) return `can't fetch ${u.name}: ${u.fetchError || 'git fetch failed'}${u.behind ? ` (${u.behind} behind at the last fetch that worked)` : ''}`
  // A clash is handed to one AI as a task (clash.js): who, when it is.
  const by = u.mergedBy ? `; being merged by ${u.mergedBy}${u.clashTask ? ` (task ${u.clashTask})` : ''}` : ''
  if (u.diverged) return `diverged from ${u.name} (${u.ahead} ahead, ${u.behind} behind)${by}`
  const n = Array.isArray(u.conflicts) ? u.conflicts.length : u.conflicts
  if (n) return `${u.behind} behind ${u.name}; ${n} file${n === 1 ? '' : 's'} clash with the session's work${by}`
  if (u.waiting) return `${u.behind} behind ${u.name}; waiting: ${u.waiting}`
  if (u.behind) return `${u.behind} behind ${u.name}`
  if (u.ahead) return `${u.ahead} ahead of ${u.name}`
  return `up to date with ${u.name}`
}

/**
 * One line on what the relay does for a branch no folder is online on: brought in by the relay
 * (when, how many commits), a clash it handed out, why it can't, and when it last looked; or ''.
 */
export function relayLine (r, now = Date.now()) {
  if (!r || !(r.checkedAt || (r.brought && r.brought.at))) return ''
  const up = r.upstream || 'its upstream'
  const bits = []
  if (r.brought && r.brought.at) bits.push(`brought in by the relay ${ago(r.brought.at, now)} (${r.brought.count} commit${r.brought.count === 1 ? '' : 's'} from ${up}, ${r.brought.files} file${r.brought.files === 1 ? '' : 's'})`)
  if (r.clashTask) bits.push(`the relay handed a clash with ${up} to task ${r.clashTask}`)
  if (r.problem) bits.push(r.problem)
  if (r.checkedAt) bits.push(`the relay last checked ${up} ${ago(r.checkedAt, now)}`)
  return bits.join('; ')
}

/** The board as markdown for an AI (quilt_status, quilt_branches). `mine`: the caller's own branch, marked "(yours)". */
export function branchesMarkdown (board, { now = Date.now(), limit = 12, mine = null } = {}) {
  if (!board.length) return '_No git branches: the folders in this session are not git repositories._'
  const out = []
  for (const b of board.slice(0, limit)) {
    const who = [
      ...b.folders.map((f) => `${f.name}'s folder${f.held ? ` (${f.held})` : ''}${f.upstream && (f.upstream.conflicts || f.upstream.diverged || f.upstream.fetchOk === false) ? ` (${upstreamLine(f.upstream)})` : ''}`),
      ...b.ais.map((n) => `AI session ${n}`),
      ...b.hosted.map((n) => `hosted agent ${n}`),
      ...b.worktrees.map((w) => `worktree \`${w}\``)
    ]
    const line = upstreamLine(b.upstream)
    const bits = [
      b.default ? 'default' : '',
      b.session ? 'in the session' : '',
      who.length ? `on it: ${who.join(', ')}` : '',
      who.some((w) => w.includes(`(${line})`)) ? '' : line,
      relayLine(b.relay, now),
      b.last ? `last commit ${ago(b.last.ts, now)} by ${b.last.author}: ${b.last.subject}` : ''
    ].filter(Boolean)
    out.push(`- \`${b.name}\`${b.name === mine ? ' (yours)' : ''}${bits.length ? ` · ${bits.join(' · ')}` : ''}`)
  }
  if (board.length > limit) out.push(`- …and ${board.length - limit} more`)
  return out.join('\n')
}

/** What the relay said when asked to look at GitHub now (Room.syncUpstreamNow), for an AI; '' when it wasn't asked. */
export function describeRelaySync (r, branch = '') {
  if (!r) return ''
  if (r.error) return `The relay couldn't be asked to look at GitHub for \`${branch}\` (${r.error}).`
  return r.said || ''
}

/** What quilt_sync_branch did, for the AI that asked. */
export function describeBranchSync (r) {
  if (!r || !r.git) {
    const relay = r && r.relay && !r.relay.error && r.relay.state !== 'unknown-repo' ? describeRelaySync(r.relay) : ''
    return `This folder is not a git repository, so it can't bring commits in itself: clone the repository into this folder (\`git clone <url> .\`, with credentials that work without a prompt) and join again from there.${relay ? `\n\nMeanwhile the relay brings commits in for this branch from GitHub: ${relay}` : ' Until then, the relay brings commits in for this branch from GitHub once a member\'s folder on it has told it which repository the branch follows.'}`
  }
  if (!r.branch) return 'This folder is not on a branch (detached HEAD): check out a branch first.'
  if (r.busy) return `Not now: ${r.busy === 'switching' ? 'this folder is moving to the branch you checked out' : r.busy === 'busy' || r.busy === 'settling' ? 'git is at work in this folder' : r.busy}. Quilt looks again by itself in a minute.`
  const u = r.upstream
  if (!u || !u.name) return `\`${r.branch}\` has no upstream (git branch --set-upstream-to sets one), so there is nothing to bring in.`
  if (u.fetchOk === false) {
    const relay = describeRelaySync(r.relay, r.branch)
    return `Couldn't fetch ${u.name}: ${u.fetchError || 'git fetch failed'}. Nothing new could be looked for through this folder, so \`${r.branch}\` may be behind ${u.name}. Give git in this folder credentials that work without a prompt (a credential helper, an SSH key, or a token in the remote's URL) and call quilt_sync_branch again.${relay ? `\n\nThe relay brings commits in for \`${r.branch}\` from GitHub while no folder on it can: ${relay}` : ''}`
  }
  if (r.moved) {
    const b = u.brought
    return `Brought ${b && b.count ? `${b.count} commit${b.count === 1 ? '' : 's'}` : 'the new commits'} from ${u.name} into the session (${b ? b.files : 0} file${b && b.files === 1 ? '' : 's'}), merged with its uncommitted work. \`${r.branch}\` is up to date.`
  }
  if (u.conflicts && u.conflicts.length) {
    return `Nothing brought in: ${u.behind} commit${u.behind === 1 ? '' : 's'} on ${u.name} clash with the session's uncommitted work in:\n${u.conflicts.map((c) => `- ${c.path}: ${c.why}`).join('\n')}\n${u.mergedBy && !u.clashMine ? `${u.mergedBy} is merging them (task ${u.clashTask}): leave those files to them.` : `Run git pull in this folder and resolve those; the session takes in the result.${u.clashTask ? ` This merge is yours: task ${u.clashTask} on the board.` : ''}`}`
  }
  return `\`${r.branch}\`: ${upstreamLine(u)}.${u.diverged ? ' Quilt never merges git history: pull or rebase it yourself, and the session takes in whatever that changes.' : ''}`
}
