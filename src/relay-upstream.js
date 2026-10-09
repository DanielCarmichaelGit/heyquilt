// Commits pushed to GitHub reach a session through a member's folder (Session.checkUpstream).
// When no folder that can bring them in is online on a branch (none with git, or only ones
// that can't: held, diverged, a viewer's, or whose fetch fails) and members still work there
// (hosted agents over HTTP, chat links, CLI agents or apps without git), nothing would bring
// them in, and they would work on stale files.
// So the relay does it for that branch: it learns from members' presence which repository
// and upstream branch the branch follows, and the last commit a folder on it was at while
// in step with the session; then, every so often, it asks GitHub whether that upstream
// moved on, and if it is strictly ahead, merges its files into the branch document the
// same way a folder would (upstream.js planCatchUp). All or nothing: a clash is handed to
// one hosted agent on that branch as a task (clash.js), and lands once its writes make the
// merge clean. Never a history merge, never anything written to GitHub.
//
// The relay has no git: the commit it records is "the session's files are this commit plus
// the session's work". A folder that comes back behind its upstream follows it like a
// member already at that commit (Session.memberAt), moving git without writing files.
import * as Y from 'yjs'
import { planCatchUp } from './upstream.js'
import { applyTextDiff } from './textdiff.js'
import { looksBinary, sha1 } from './fsutil.js'
import { LARGE_FILE_BYTES, MAX_TEXT_BYTES, makeIgnore, scopeIgnore, isIgnored, isSafeRelPath } from './pathrules.js'
import { mergeAdditive } from './merge3.js'
import { readTasks, addTask, updateTask } from './tasks.js'
import { addComment, MAX_COMMENT } from './task-comments.js'
import { changeRefusal } from './session-access.js'
import { HistoryLog, lineDiff } from './history.js'
import { clashTaskId, clashTitle, clashFiles, relayClashBrief } from './clash.js'
import { RELAY_BY } from './branches.js'

/** How often the relay asks GitHub about a branch nobody's folder is on (per branch). */
export const UPSTREAM_CHECK_MS = 10 * 60 * 1000
/** A branch counts as worked on by hosted agents this long after one of their calls on it. */
export const HOSTED_RECENT_MS = 30 * 60 * 1000
/** The longest the relay waits after GitHub says to slow down, and the first wait without a hint. */
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000
export const FIRST_BACKOFF_MS = 15 * 60 * 1000
/** GitHub's compare lists at most this many files: more and the relay leaves it to a folder. */
const COMPARE_FILES = 300
/** quilt_sync_branch asks GitHub at most this often per branch (Room.syncUpstreamNow). */
export const SYNC_EVERY_MS = 60 * 1000
/** The most files the relay loads to start a branch from GitHub (loadBranch). */
export const LOAD_FILES = 1000
const API = 'https://api.github.com'
const RAW = 'https://raw.githubusercontent.com'
const SHA = /^[0-9a-f]{40,64}$/
const ORIGIN = 'relay-upstream' // transaction origin: not a connection, so never guarded or undone
const TOKEN = /^[A-Za-z0-9_]{20,255}$/

/** Whether `t` looks like a GitHub token (classic ghp_…, fine-grained github_pat_…, or the older bare kind). */
export const validToken = (t) => typeof t === 'string' && TOKEN.test(t)

/**
 * A git remote URL as host/owner/name, without any user name or password it carried:
 * { host, owner, name, github, slug } or null. https, ssh:// and scp-like git@host:owner/name.
 */
export function parseRepo (url) {
  if (typeof url !== 'string' || !url || url.length > 500) return null
  let host, rest
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(?!\/)(.+)$/.exec(url)
  if (scp) { host = scp[1]; rest = scp[2] } else {
    let u
    try { u = new URL(url) } catch { return null }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(u.protocol)) return null
    host = u.hostname
    rest = u.pathname.replace(/^\/+/, '')
  }
  const parts = rest.replace(/\/+$/, '').replace(/\.git$/, '').split('/')
  if (parts.length !== 2 || !parts.every((p) => /^[A-Za-z0-9._-]+$/.test(p) && p !== '.' && p !== '..')) return host ? { host: host.toLowerCase(), owner: null, name: null, github: false, slug: host.toLowerCase() } : null
  host = host.toLowerCase()
  const github = host === 'github.com' || host === 'www.github.com'
  return { host: github ? 'github.com' : host, owner: parts[0], name: parts[1], github, slug: `${github ? 'github.com' : host}/${parts[0]}/${parts[1]}` }
}

/** The branch on the remote an upstream like "origin/main" names ("main"), given the remote's name when known. */
export function upstreamRef (name, remote = null) {
  if (typeof name !== 'string' || !name.includes('/')) return null
  const ref = remote && name.startsWith(`${remote}/`) ? name.slice(remote.length + 1) : name.slice(name.indexOf('/') + 1)
  return ref && !ref.startsWith('/') && !ref.includes('..') && ref.length <= 200 ? ref : null
}

const plural = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`

/** The room's record of each branch's upstream, as the relay keeps it (meta.upstreams, key -> record). */
export function upstreamsOf (room) {
  if (!room.meta.upstreams || typeof room.meta.upstreams !== 'object') room.meta.upstreams = {}
  return room.meta.upstreams
}

/**
 * What members' presence says about each branch's upstream, recorded per branch document:
 * the repository, the upstream branch, and the commit a folder on it was at while in step
 * with the session (not held, not diverged). Once the relay itself moved the session to a
 * commit, a folder still behind it (or that hasn't fetched yet) is not taken as newer:
 * only a folder at that commit, or one that sees the same upstream and is not behind it.
 * Returns whether anything changed (the caller saves and tells everyone).
 */
export function noteFolders (room) {
  const recs = upstreamsOf(room)
  const states = room.awareness.getStates()
  let changed = false
  for (const [ws, ids] of room.conns) {
    const key = ws.branch
    if (!key || !room.meta.branches[key]) continue
    for (const id of ids) {
      const g = states.get(id)?.git
      if (!g || typeof g !== 'object' || typeof g.branch !== 'string') continue
      const u = g.upstream && typeof g.upstream === 'object' ? g.upstream : null
      const rec = recs[key] || {}
      const next = { ...rec }
      if (u && typeof u.name === 'string') {
        const repo = parseRepo(u.url)
        const ref = upstreamRef(u.name, typeof u.remote === 'string' ? u.remote : null)
        if (repo && ref) { next.repo = repo.slug; next.name = u.name.slice(0, 200); next.ref = ref }
      }
      const sha = typeof g.sha === 'string' && SHA.test(g.sha) ? g.sha : null
      const inStep = sha && !g.held && !(u && u.diverged)
      if (inStep && sha !== rec.sha) {
        const relayMoved = !!rec.relayHead
        const seesSame = u && typeof u.sha === 'string' && u.sha === rec.head && !(u.behind > 0)
        if (!relayMoved || sha === rec.relayHead || seesSame) {
          next.sha = sha
          if (sha === rec.relayHead || seesSame) delete next.relayHead // folders are past what the relay brought in
        }
      } else if (inStep && sha === rec.relayHead) delete next.relayHead
      if (JSON.stringify(next) !== JSON.stringify(rec)) { recs[key] = next; changed = true }
    }
  }
  return changed
}

/**
 * Whether a member's folder (its presence `g` on connection `ws`) can bring commits in itself:
 * git on a branch with an upstream, in step (not held, not diverged), its last fetch worked,
 * and its member may change files. Any other folder leaves the branch to the relay.
 */
export function canBringIn (room, ws, g) {
  if (!g || typeof g !== 'object' || typeof g.branch !== 'string' || !g.branch || g.held) return false
  const u = g.upstream && typeof g.upstream === 'object' ? g.upstream : null
  if (!u || typeof u.name !== 'string' || !u.name || u.diverged || u.fetchOk === false) return false
  const a = room.access && room.access.get ? room.access.get(ws) : null
  return !(a && a.role === 'viewer')
}

/** The member whose folder on branch `key` brings commits in itself (canBringIn), or null. */
export function folderAble (room, key) {
  const states = room.awareness.getStates()
  for (const [ws, ids] of room.conns) {
    if (ws.branch !== key) continue
    for (const id of ids) {
      const st = states.get(id)
      if (st && canBringIn(room, ws, st.git)) return (room.names && room.names.get(ws)) || st.name || 'a member'
    }
  }
  return null
}

/** Whether a folder that can bring commits in is connected on branch `key` (then the relay leaves it to that folder). */
export function folderOn (room, key) { return folderAble(room, key) !== null }

/** Whether any member's app or CLI is connected on branch `key` (with or without git). */
export function connectedOn (room, key) {
  for (const ws of room.conns.keys()) if (ws.branch === key) return true
  return false
}

/** Hosted agents on branch `key` right now: [{ id, name, seen, role, scopes, scopesExcept, chat? }], the most recently active first. */
export function hostedOn (room, key) {
  return room.hostedOnline()
    .filter((h) => room.hostedBranch(h.id) === key)
    .map((h) => ({ ...h, ...(room.meta.members[h.id] || {}), name: h.name, seen: h.seen }))
    .sort((a, b) => b.seen - a.seen || (a.name < b.name ? -1 : 1))
}

/**
 * Whether the relay should look at branch `key` now: members work there (hosted agents now or in
 * the last 30 minutes, chat links, or apps and CLI agents connected on it) and no folder on it
 * can bring commits in itself (folderAble).
 */
export function relayLooks (room, key, now = Date.now()) {
  if (!room.exists || room.ended || !room.meta.branches[key]) return false
  const rec = upstreamsOf(room)[key]
  if (!rec || !rec.repo) return false
  if (folderOn(room, key)) return false
  return connectedOn(room, key) || hostedOn(room, key).length > 0 || now - (rec.hostedAt || 0) < HOSTED_RECENT_MS
}

/** The branches due a look (only `keys` when given): looked at by the relay, last checked `everyMs` ago or more, and not told to wait by GitHub. */
export function dueBranches (room, { now = Date.now(), everyMs = UPSTREAM_CHECK_MS, keys = null } = {}) {
  const recs = upstreamsOf(room)
  return Object.keys(recs).filter((key) => (!keys || keys.includes(key)) && relayLooks(room, key, now) && now - (recs[key].checkedAt || 0) >= everyMs && !(recs[key].backoffUntil > now))
}

/** What members see of the relay's record in the branch list (never the token, an ETag or a URL with credentials). */
export function relayEntry (rec) {
  if (!rec || !rec.sha) return null
  return {
    sha: rec.sha,
    upstream: rec.name || null,
    repo: rec.repo || null,
    checkedAt: rec.checkedAt || 0,
    brought: rec.brought ? { count: rec.brought.count || 0, files: rec.brought.files || 0, at: rec.brought.at || 0 } : null,
    problem: rec.problem || null,
    clashTask: rec.clash ? rec.clash.task : null
  }
}

/** An HTTP failure from GitHub, with what the back-off needs. */
class GitHubError extends Error {
  constructor (status, headers, what) {
    super(`GitHub answered ${status} for ${what}`)
    this.status = status
    this.headers = headers
  }
}

/** The few GitHub calls the relay makes, read only. The token (when set) goes in a header, never a URL. */
function github ({ fetch, token, owner, name }) {
  const auth = token ? { authorization: `Bearer ${token}` } : {}
  const base = { 'user-agent': 'quilt-relay', 'x-github-api-version': '2022-11-28', ...auth }
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/')
  const get = async (url, headers, what) => {
    const res = await fetch(url, { headers: { ...base, ...headers }, redirect: 'follow' })
    if (res.status === 304) return { res, notModified: true }
    if (!res.ok) throw new GitHubError(res.status, res.headers, what)
    return { res }
  }
  return {
    /** The ref's head commit, conditional on the ETag from last time: { sha, etag } (sha null: unchanged). */
    async head (ref, etag) {
      const { res, notModified } = await get(`${API}/repos/${owner}/${name}/commits/${enc(ref)}`, { accept: 'application/vnd.github.sha', ...(etag ? { 'if-none-match': etag } : {}) }, `${owner}/${name} ${ref}`)
      if (notModified) return { sha: null, etag }
      const sha = (await res.text()).trim()
      if (!SHA.test(sha)) throw new Error(`GitHub gave no commit for ${ref}`)
      return { sha, etag: res.headers.get('etag') || null }
    },
    /** The repository itself: whether it can be read at all (a 404 on a branch: no such branch, or no access). */
    async repo () {
      const { res } = await get(`${API}/repos/${owner}/${name}`, { accept: 'application/vnd.github+json' }, `${owner}/${name}`)
      return res.json()
    },
    /** Every file at a commit: { tree: [{ path, type, mode, size }], truncated }. */
    async tree (sha) {
      const { res } = await get(`${API}/repos/${owner}/${name}/git/trees/${sha}?recursive=1`, { accept: 'application/vnd.github+json' }, `${owner}/${name} tree`)
      return res.json()
    },
    async compare (base, head) {
      const { res } = await get(`${API}/repos/${owner}/${name}/compare/${base}...${head}`, { accept: 'application/vnd.github+json' }, `${owner}/${name} compare`)
      return res.json()
    },
    /** A file at a commit: its bytes, null when it isn't there, or { tooLarge } past `max` bytes. */
    async file (sha, path, max) {
      const url = token ? `${API}/repos/${owner}/${name}/contents/${enc(path)}?ref=${sha}` : `${RAW}/${owner}/${name}/${sha}/${enc(path)}`
      const res = await fetch(url, { headers: { ...base, accept: 'application/vnd.github.raw' }, redirect: 'follow' })
      if (res.status === 404) return null
      if (!res.ok) throw new GitHubError(res.status, res.headers, `${path} at ${sha.slice(0, 7)}`)
      const len = Number(res.headers.get('content-length'))
      if (Number.isFinite(len) && len > max) return { tooLarge: true }
      const buf = Buffer.from(await res.arrayBuffer())
      return buf.length > max ? { tooLarge: true } : buf
    }
  }
}

/** How long GitHub asked to wait: Retry-After, the rate limit's reset, or twice the last wait. */
export function backoffFor (err, rec, now = Date.now()) {
  const h = err.headers
  const after = Number(h && h.get && h.get('retry-after'))
  if (Number.isFinite(after) && after > 0) return Math.min(after * 1000, MAX_BACKOFF_MS)
  const reset = Number(h && h.get && h.get('x-ratelimit-reset'))
  if (h && h.get && h.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset) && reset * 1000 > now) return Math.min(reset * 1000 - now + 1000, MAX_BACKOFF_MS)
  return Math.min(Math.max((rec.backoffMs || 0) * 2, FIRST_BACKOFF_MS), MAX_BACKOFF_MS)
}

/** A file in the branch document as planCatchUp keys it: text, "bin:<sha1>", null when absent, undefined for a stored large file. */
function docKey (e, rel) {
  const t = e.files.get(rel)
  if (t) return t.toString()
  const b = e.blobs.get(rel)
  if (b) return b.stored ? undefined : `bin:${b.hash}`
  return null
}

const fingerprint = (k) => k === null ? 'none' : k === undefined ? 'unread' : sha1(Buffer.from(k, 'utf8'))
const hasMarkers = (k) => typeof k === 'string' && !k.startsWith('bin:') && k.split('\n').some((l) => /^(<{7}|>{7})( |$)/.test(l))

const IGNORE_NAMES = ['.gitignore', '.quiltignore', '.cowoveignore']
const isIgnoreFile = (rel) => IGNORE_NAMES.some((n) => rel === n || rel.endsWith(`/${n}`))
const dirOf = (rel) => rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''

/**
 * What the session doesn't sync: Quilt's built-ins, the project's .gitignore files as the branch
 * document has them, and `extra`: [[path, text]] of ignore files read from the commit itself. A
 * .quiltignore never syncs (it is a built-in ignore), so a committed one is read from GitHub.
 */
function ignoreOf (e, extra = []) {
  const texts = []
  for (const [rel, t] of e ? e.files : []) if (isIgnoreFile(rel)) texts.push(scopeIgnore(t.toString(), dirOf(rel)))
  for (const [rel, t] of extra) if (typeof t === 'string') texts.push(scopeIgnore(t, dirOf(rel)))
  return makeIgnore(texts)
}

/** The .quiltignore a commit has at its root, and any other .quiltignore the change list names: [[path, text]]. */
async function quiltignoresAt (gh, sha, list) {
  const paths = new Set(['.quiltignore'])
  for (const f of list) if (f && typeof f.filename === 'string' && /(^|\/)\.(quilt|cowove)ignore$/.test(f.filename) && isSafeRelPath(f.filename)) paths.add(f.filename)
  const out = []
  for (const rel of paths) {
    const r = await gh.file(sha, rel, 64 * 1024)
    if (r && !r.tooLarge) out.push([rel, r.toString('utf8')])
  }
  return out
}

const isText = (k) => typeof k === 'string' && !k.startsWith('bin:')
const regionKey = (lines) => sha1(Buffer.from(lines.join('\n'), 'utf8'))
/** The session's side of each region of a file that clashes with upstream, by fingerprint (a rewrite of those lines is the merge). */
const clashRegions = (b, o, t) => isText(b) && isText(o) && isText(t) ? mergeAdditive(b, o, t).conflicts.map((c) => regionKey(c.ours)) : null

/**
 * One look at branch `key` (the caller checked relayLooks). Asks GitHub for the upstream's
 * head; when it is strictly ahead of the recorded commit, reads every changed file at both
 * ends and merges them into the branch document, or hands the clash to a hosted agent.
 * Returns what happened: { state, ... } for tests and the log. Never throws.
 */
export async function checkBranch (room, key, { fetch, now = () => Date.now(), log = () => {} } = {}) {
  const recs = upstreamsOf(room)
  const rec = recs[key]
  if (!rec || !rec.repo || !rec.ref || !rec.sha) return { state: 'unknown' }
  const started = now()
  rec.checkedAt = started
  const said = (problem) => {
    if (problem && rec.problem !== problem) log(`[${room.name}] ${key}: ${problem}`)
    if (problem) rec.problem = problem; else delete rec.problem
  }
  const done = (out) => { if (!room.destroyed) { room.saveMeta(); room.broadcastBranches() } return out }
  const repo = parseRepo(`https://${rec.repo}`)
  if (!repo || !repo.github) { said(`the relay only brings in commits from GitHub, and ${rec.repo.split('/')[0]} isn't GitHub: a member's folder on ${key} brings them in`); return done({ state: 'not-github' }) }
  const token = validToken(room.meta.githubToken) ? room.meta.githubToken : null
  const gh = github({ fetch, token, owner: repo.owner, name: repo.name })
  const base = rec.sha
  let head, cmp
  const files = new Map() // path -> { base, head } as planCatchUp keys them, with binaries' bytes
  const bins = new Map() // "bin:<sha1>" -> bytes
  const tooLarge = new Set()
  try {
    const h = await gh.head(rec.ref, rec.head ? rec.etag : null)
    head = h.sha || rec.head
    rec.head = head
    rec.etag = h.etag
    delete rec.backoffMs
    delete rec.backoffUntil
    if (!head) return done({ state: 'unknown' })
    if (head === base) {
      said(null)
      closeLanded(room, key, rec, `Brought in at ${head.slice(0, 7)}: the session on ${key} is at ${rec.name} ${head.slice(0, 7)}.`)
      return done({ state: 'up-to-date', head })
    }
    cmp = await gh.compare(base, head)
    if (cmp.status !== 'ahead') {
      said(cmp.status === 'diverged'
        ? `${rec.name} was rewritten or moved apart from ${base.slice(0, 7)} (the session's commit on ${key}): a member's folder on ${key} has to bring it in`
        : null)
      return done({ state: cmp.status || 'unknown', head })
    }
    const list = Array.isArray(cmp.files) ? cmp.files : []
    if (list.length >= COMPARE_FILES) {
      said(`${rec.name} changed ${COMPARE_FILES} files or more since ${base.slice(0, 7)}: too many for the relay; a member's folder on ${key} brings them in`)
      return done({ state: 'too-many', head })
    }
    const e = room.branchDoc(key)
    const ig = ignoreOf(e, await quiltignoresAt(gh, head, list))
    const want = (rel) => typeof rel === 'string' && isSafeRelPath(rel) && !isIgnored(ig, rel)
    const changes = new Map()
    for (const f of list) {
      if (!f || typeof f.filename !== 'string') continue
      const st = f.status
      if (st === 'renamed' && typeof f.previous_filename === 'string') {
        if (want(f.previous_filename)) changes.set(f.previous_filename, 'D')
        if (want(f.filename)) changes.set(f.filename, 'A')
      } else if (want(f.filename)) changes.set(f.filename, st === 'added' || st === 'copied' ? 'A' : st === 'removed' ? 'D' : 'M')
    }
    const read = async (sha, rel) => {
      const r = await gh.file(sha, rel, MAX_TEXT_BYTES)
      if (r === null) return null
      if (r.tooLarge) { tooLarge.add(rel); return undefined }
      if (looksBinary(r)) {
        if (r.length > LARGE_FILE_BYTES) { tooLarge.add(rel); return undefined }
        const k = `bin:${sha1(r)}`
        bins.set(k, r)
        return k
      }
      return r.toString('utf8')
    }
    for (const [rel, kind] of changes) {
      files.set(rel, {
        base: kind === 'A' ? null : await read(base, rel),
        head: kind === 'D' ? null : await read(head, rel),
        kind
      })
    }
  } catch (err) {
    if (err instanceof GitHubError && (err.status === 403 || err.status === 429)) {
      const wait = backoffFor(err, rec, now())
      rec.backoffMs = wait
      rec.backoffUntil = now() + wait
      said(`GitHub asked the relay to slow down; it looks at ${rec.name} again after ${new Date(rec.backoffUntil).toISOString().slice(11, 16)} UTC`)
      return done({ state: 'backoff', wait })
    }
    if (err instanceof GitHubError && (err.status === 404 || err.status === 401)) {
      said(token ? tokenRefused(rec.repo) : noToken(rec.repo))
      return done({ state: token ? 'token-refused' : 'private' })
    }
    said(`the relay couldn't reach GitHub for ${rec.name} (${String(err.message).slice(0, 120)}); it tries again later`)
    return done({ state: 'error' })
  }
  // Everything is read: from here on nothing waits, so the document can't change under the plan.
  if (room.ended || room.destroyed || !room.meta.branches[key] || recs[key] !== rec || rec.sha !== base || folderOn(room, key)) return done({ state: 'moved-on' })
  const e = room.branchDoc(key)
  const behind = Number.isFinite(cmp.ahead_by) ? cmp.ahead_by : Number.isFinite(cmp.total_commits) ? cmp.total_commits : 0
  const changes = new Map([...files].map(([rel, f]) => [rel, f.kind]))
  const baseMap = new Map([...files].map(([rel, f]) => [rel, f.base]))
  const theirs = new Map([...files].map(([rel, f]) => [rel, f.head]))
  const disk = (rel) => docKey(e, rel)
  let plan = planCatchUp({ changes, base: baseMap, theirs, disk })
  const why = (c) => tooLarge.has(c.path) ? { ...c, why: `too large for the relay to bring in (binaries over ${LARGE_FILE_BYTES / 1024} KB, text over ${MAX_TEXT_BYTES / 1024 / 1024} MB): a member's folder brings it in` } : c
  let resolved = []
  if (plan.conflicts.length && rec.clash) {
    // The files handed out with the clash that count as merged: all of them once its assignee
    // moved the task to QA or Done (for this commit); otherwise each one rewritten since in the
    // lines that clashed (no markers left), so it merges cleanly with the new commit around them.
    // The session keeps the merged lines, takes the commit's other changes, and the rest is planned again.
    const was = rec.clash.files || {}
    const regions = rec.clash.regions || {}
    const settled = !!(rec.clash.settled && rec.clash.sha === head)
    resolved = plan.conflicts.map((c) => c.path).filter((rel) => {
      const d = disk(rel)
      if (!(rel in was) || d === undefined) return false
      if (settled) return true
      if (was[rel] === fingerprint(d) || hasMarkers(d)) return false
      const b = baseMap.get(rel)
      const t = theirs.get(rel)
      if (!isText(b) || !isText(d) || !isText(t)) return true // a deletion or a binary: changed since is all there is to go on
      const old = regions[rel]
      return !old || mergeAdditive(b, d, t).conflicts.every((c) => !old.includes(regionKey(c.ours)))
    })
    if (resolved.length) {
      plan = planCatchUp({ changes: new Map([...changes].filter(([rel]) => !resolved.includes(rel))), base: baseMap, theirs, disk })
      if (!plan.conflicts.length) {
        for (const rel of resolved) {
          const b = baseMap.get(rel)
          const d = disk(rel)
          const t = theirs.get(rel)
          if (!isText(b) || !isText(d) || !isText(t)) continue
          const merged = mergeAdditive(b, d, t).text
          if (merged !== d) plan.writes.set(rel, merged)
        }
      }
    }
  }
  if (plan.conflicts.length) {
    const conflicts = plan.conflicts.map(why)
    const r = handClash(room, key, rec, { head, base, behind, conflicts, disk, baseMap, theirs, now: now() })
    said(r.problem || null)
    return done({ state: 'clash', head, conflicts, task: r.task || null, resolved })
  }
  // A file someone holds is never written under them (as a folder's bring-in waits, Session.bringIn):
  // only the clash's files, held for its merge. The bring-in waits until they let go of it.
  for (const rel of plan.writes.keys()) {
    const c = room.claimFor ? room.claimFor(rel, key) : null
    if (c && !(rec.clash && c.clash === rec.clash.task)) {
      said(`${c.by} holds ${rel}: the relay brings ${rec.name} in once they let go of it (quilt_release, or quilt_handoff)`)
      return done({ state: 'waiting', head, held: rel, by: c.by })
    }
  }
  // Clean: the whole bring-in in one transaction from the relay, with one line in the activity log.
  const history = e.historyLog || (e.historyLog = new HistoryLog(e.doc, e.doc.getArray('history'), { origin: ORIGIN }))
  let written = 0
  e.doc.transact(() => {
    for (const [rel, k] of plan.writes) {
      const before = e.files.get(rel)?.toString()
      const existed = e.files.has(rel) || e.blobs.has(rel)
      if (k === null) {
        e.files.delete(rel)
        e.blobs.delete(rel)
        history.record({ by: RELAY_BY, path: rel, kind: 'deleted', before, after: '', pulled: true })
      } else if (k.startsWith('bin:')) {
        const buf = bins.get(k)
        e.files.delete(rel)
        e.blobs.set(rel, { hash: k.slice(4), data: buf.toString('base64') })
        history.record({ by: RELAY_BY, path: rel, kind: existed ? 'edited' : 'created', detail: `${buf.length} bytes`, pulled: true })
      } else {
        e.blobs.delete(rel)
        let y = e.files.get(rel)
        if (!y) { y = new Y.Text(); e.files.set(rel, y) }
        applyTextDiff(y, k)
        history.record({ by: RELAY_BY, path: rel, kind: existed ? 'edited' : 'created', before: before ?? '', after: k, pulled: true })
      }
      written++
    }
  }, ORIGIN)
  const detail = `${plural(behind, 'commit')} from ${rec.name} · ${plural(written, 'file')}`
  room.doc.transact(() => {
    room.activity.push([{ by: RELAY_BY, path: '', kind: 'brought', detail, branch: key, ts: now() }])
    if (room.activity.length > 300) room.activity.delete(0, room.activity.length - 300)
  }, ORIGIN)
  log(`[${room.name}] ${key}: ${RELAY_BY} brought in ${detail} (${base.slice(0, 7)}..${head.slice(0, 7)}; no folder on it is online)`)
  rec.sha = head
  rec.relayHead = head
  rec.brought = { count: behind, files: written, at: now(), head }
  said(null)
  closeLanded(room, key, rec, `Brought in at ${head.slice(0, 7)}: ${RELAY_BY} merged ${plural(behind, 'commit')} from ${rec.name} into ${key}${resolved.length ? `, keeping the merged ${resolved.join(', ')}` : ''}.`)
  return done({ state: 'brought', head, count: behind, files: written, resolved })
}

/** The relay's clash task on `key` is done: the session is at or past its commit. */
function closeLanded (room, key, rec, verified) {
  if (!rec.clash) return
  const t = readTasks(room.tasks).find((x) => x.id === rec.clash.task)
  if (t && t.column !== 'done') {
    try { updateTask(room.doc, room.tasks, { id: t.id, column: 'done', verified }, ORIGIN) } catch {}
  }
  delete rec.clash
}

/**
 * A clash on `key`, handed to ONE hosted agent on that branch as a task: the same id a
 * member's Quilt would give it (clash.js), assigned by name, its description listing each
 * file and why, then the change from upstream for each file. Returns { task } or { problem }.
 */
function handClash (room, key, rec, { head, base, behind, conflicts, disk, baseMap, theirs, now }) {
  const upstream = rec.name
  const n = plural(conflicts.length, 'file')
  const paths = conflicts.map((c) => c.path)
  const mayTake = (a) => paths.every((rel) => !changeRefusal(a, rel))
  const tasks = readTasks(room.tasks)
  let task = rec.clash ? tasks.find((t) => t.id === rec.clash.task) || null : null
  if (!task) task = tasks.find((t) => t.id === clashTaskId(key, head)) || null
  // Hosted agents first (not a chat link: it can only add new files), then CLI agents connected on the branch.
  const cli = [...room.conns.keys()]
    .filter((ws) => ws.branch === key && ws.pass && ws.pass.kind === 'agent' && room.names && room.names.get(ws))
    .map((ws) => ({ ...(room.access.get(ws) || {}), name: room.names.get(ws), who: room.claimant(ws) }))
    .filter((a) => a.role)
  const hosted = hostedOn(room, key).filter((a) => !a.chat).map((a) => ({ ...a, who: { name: a.name, id: a.id, talk: a.talk !== false, branch: key } }))
  const agents = [...hosted, ...cli].filter(mayTake)
    .filter((a, i, all) => all.findIndex((x) => x.name === a.name) === i)
  const id = task ? task.id : clashTaskId(key, head)
  // Taken off the board for this commit: not again (a newer commit may be handed out).
  if (!task && rec.clash && rec.clash.sha === head) return { problem: `${n} clash with the session's work on ${key} (task ${rec.clash.task} was taken off the board): a member's folder on ${key} has to bring ${upstream} in` }
  if (!task && !agents.length) return { problem: `${behind} commit${behind === 1 ? '' : 's'} from ${upstream} clash with the session's work on ${key} in ${paths.slice(0, 4).join(', ')}${paths.length > 4 ? ' and more' : ''}, and no agent that may change them is on ${key} to merge them` }
  const same = rec.clash && rec.clash.task === id
  const files = { ...(same ? rec.clash.files : {}) }
  const regions = { ...(same ? rec.clash.regions || {} : {}) }
  for (const rel of paths) {
    if (rel in files) continue
    files[rel] = fingerprint(disk(rel))
    const r = clashRegions(baseMap.get(rel), disk(rel), theirs.get(rel))
    if (r) regions[rel] = r
  }
  const brief = () => relayClashBrief({ branch: key, upstream, sha: head, base, behind, conflicts, compare: `https://${rec.repo}/compare/${base.slice(0, 12)}...${head.slice(0, 12)}` })
  const post = (text) => { try { addComment(room.doc, room.taskComments, readTasks(room.tasks), { taskId: id, by: RELAY_BY, text }, ORIGIN) } catch {} }
  const diffs = () => {
    for (const c of conflicts.slice(0, 8)) {
      const b = baseMap.get(c.path)
      const t = theirs.get(c.path)
      const head7 = head.slice(0, 7)
      const intro = `What ${upstream} changed in ${c.path} (${base.slice(0, 7)} → ${head7}):`
      if (typeof b !== 'string' && b !== null) { post(`${intro} not readable by the relay; see https://${rec.repo}/blob/${head7}/${c.path}`); continue }
      if (typeof t !== 'string' && t !== null) { post(`${intro} not readable by the relay; see https://${rec.repo}/blob/${head7}/${c.path}`); continue }
      if ((b && b.startsWith('bin:')) || (t && t.startsWith('bin:'))) { post(`${intro} a binary file; see https://${rec.repo}/blob/${head7}/${c.path}`); continue }
      const room4 = MAX_COMMENT - intro.length - 20
      const d = t === null ? `(deleted in ${upstream})` : lineDiff(b || '', t, { max: room4 })
      post(`${intro}\n\`\`\`diff\n${d.slice(0, room4)}\n\`\`\``)
    }
  }
  if (!task) {
    const to = agents[0]
    task = addTask(room.doc, room.tasks, { id, title: clashTitle({ upstream, behind, conflicts }), by: RELAY_BY, assignee: to.name, forAi: false, tool: '', files: clashFiles(conflicts) }, ORIGIN)
    room.log(`[${room.name}] ${key}: the clash with ${upstream} ${head.slice(0, 7)} went to ${to.name} (task ${id})`)
    post(brief())
    diffs()
  } else {
    const fresh = !rec.clash || rec.clash.sha !== head
    const patch = { id: task.id }
    if (fresh) { patch.title = clashTitle({ upstream, behind, conflicts }); patch.files = clashFiles(conflicts) }
    // Its assignee left the branch (no longer a hosted agent on it) and another is there: theirs now.
    const assigneeHere = agents.some((a) => a.name === task.assignee)
    if (!assigneeHere && agents.length) { patch.assignee = agents[0].name; patch.forAi = false; patch.tool = '' }
    // Moved to Done while it still clashes (by someone else, or for an older commit): open again.
    if (task.column === 'done') patch.column = 'doing'
    if (Object.keys(patch).length > 1) {
      try { task = updateTask(room.doc, room.tasks, patch, ORIGIN) } catch {}
    }
    if (!rec.clash || rec.clash.task !== task.id) {
      // A task a member's Quilt wrote for this commit, its folder now offline: the relay carries it on.
      post(`${patch.assignee ? `Handed to ${patch.assignee}: no folder on \`${key}\` is online, so the relay carries this merge on in the session.\n\n` : ''}${brief()}`)
      diffs()
    } else if (fresh) {
      post(`${upstream} moved on to ${head.slice(0, 7)}.\n\n${brief()}`)
      diffs()
    } else if (patch.assignee) {
      post(`Handed to ${patch.assignee}: the last assignee is no longer on \`${key}\`.\n\n${brief()}`)
    } else if (patch.column) {
      post(`Open again: ${head.slice(0, 7)} from ${upstream} still clashes with the session's work on \`${key}\`. Quilt closes this task by itself once the merge lands: no need to move it.`)
    }
  }
  const keep = rec.clash && rec.clash.task === task.id
  // Its assignee holds the clashing files while it merges (asked for in their queues when someone
  // else holds one), so nobody else edits them meanwhile; let go of when the task is done (Room.dropClashClaims).
  const holder = agents.find((a) => a.name === task.assignee)
  const had = keep && rec.clash.claims && rec.clash.claims.by === task.assignee ? rec.clash.claims : { by: task.assignee, paths: [] }
  const toClaim = paths.filter((rel) => !had.paths.includes(rel))
  if (holder && toClaim.length && room.claimClashFiles) {
    const r = room.claimClashFiles(holder.who, task.id, toClaim, { upstream })
    had.paths = [...had.paths, ...r.claimed, ...r.asked.map((x) => x.path)]
    if (r.asked.length) post(`${r.asked.map((x) => `${x.holder} holds ${x.path}`).join('; ')}: asked for ${r.asked.length === 1 ? 'it' : 'them'} in the file queue for ${task.assignee}, who gets ${r.asked.length === 1 ? 'it' : 'them'} with their context when they hand ${r.asked.length === 1 ? 'it' : 'them'} over.`)
  }
  rec.clash = { task: task.id, sha: head, base, files, regions, claims: had, at: keep ? rec.clash.at : now, ...(keep && rec.clash.settled && rec.clash.sha === head ? { settled: rec.clash.settled } : {}) }
  // The room's clash record, as a member's Quilt keeps it: a folder that comes back finds the same task.
  try { room.doc.transact(() => room.doc.getMap('clashes').set(key, { task: task.id, sha: head, upstream, ts: now }), ORIGIN) } catch {}
  return { task: task.id }
}

/** What a hosted agent (or a member's AI) is told when the relay can't read a private repository. */
export const noToken = (repo) => `the relay can't read ${repo}: ask the session owner to add a read-only GitHub token (session settings, or quilt_github_token)`
export const tokenRefused = (repo) => `the relay's GitHub token can't read ${repo}: ask the session owner to give it read access to that repository's contents (session settings, or quilt_github_token)`

const ago = (ts, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`
}

/**
 * What one look at branch `key` (checkBranch's result `r`) means, for an AI that asked for it
 * (quilt_sync_branch): in the words describeBranchSync uses for a folder.
 */
export function describeRelayCheck (r, rec, key, room = null) {
  const up = (rec && rec.name) || 'its upstream'
  if (!r) return `The relay didn't look at ${up} for \`${key}\`.`
  if (r.state === 'brought') return `Brought ${plural(r.count, 'commit')} from ${up} into \`${key}\` (${plural(r.files, 'file')}), merged with the session's uncommitted work${r.resolved && r.resolved.length ? `, keeping the merged ${r.resolved.join(', ')}` : ''}. \`${key}\` is up to date with ${up} (${r.head.slice(0, 7)}).`
  if (r.state === 'up-to-date') return `\`${key}\`: up to date with ${up} (${r.head.slice(0, 7)}).`
  if (r.state === 'clash') {
    const t = room && r.task ? readTasks(room.tasks).find((x) => x.id === r.task) : null
    return `Nothing brought in: ${up} (${r.head.slice(0, 7)}) clashes with the session's uncommitted work on \`${key}\` in:\n${(r.conflicts || []).map((c) => `- ${c.path}: ${c.why}`).join('\n')}\n${r.task ? `Task ${r.task} on the board${t && t.assignee ? ` (${t.assignee})` : ''}: write each merged file (quilt_write_file, or in your folder), then move the task to QA. The merge lands as soon as the relay sees it.` : (rec && rec.problem) || ''}`
  }
  if (r.state === 'moved-on') return `A folder on \`${key}\` that brings commits in itself came online, so the relay left it to that folder.`
  if (rec && rec.problem) return `Nothing brought in: ${rec.problem}.`
  return `The relay couldn't tell where ${up} is now; it looks again by itself.`
}

/**
 * The files of `ref` on GitHub at its head, for starting a session branch from it (a hosted
 * agent's quilt_switch_branch). Ignored paths (built-ins, the commit's .gitignore and
 * .quiltignore files) and unsafe ones are left out, and so are files too large for the relay.
 * Returns { state: 'loaded', head, texts: Map, blobs: Map, skipped: [path], bytes } or
 * { state: 'no-branch' | 'private' | 'token-refused' | 'too-many' | 'backoff' | 'error', ... }.
 */
export async function loadBranch ({ repo, ref, token = null, fetch, maxFiles = LOAD_FILES }) {
  const r = parseRepo(`https://${repo}`)
  if (!r || !r.github) return { state: 'not-github' }
  const gh = github({ fetch, token, owner: r.owner, name: r.name })
  try {
    let head
    try { head = (await gh.head(ref)).sha } catch (err) {
      if (!(err instanceof GitHubError) || (err.status !== 404 && err.status !== 422)) throw err
      try { await gh.repo() } catch (e2) {
        if (e2 instanceof GitHubError && (e2.status === 404 || e2.status === 401)) return { state: token ? 'token-refused' : 'private' }
        throw e2
      }
      return { state: 'no-branch' }
    }
    const tree = await gh.tree(head)
    const all = (Array.isArray(tree.tree) ? tree.tree : []).filter((x) => x && x.type === 'blob' && typeof x.path === 'string' && x.mode !== '120000' && isSafeRelPath(x.path))
    if (tree.truncated || all.length > maxFiles) return { state: 'too-many', head, count: all.length }
    const ignores = []
    for (const x of all) {
      if (!isIgnoreFile(x.path)) continue
      const b = await gh.file(head, x.path, 64 * 1024)
      if (b && !b.tooLarge) ignores.push([x.path, b.toString('utf8')])
    }
    const ig = ignoreOf(null, ignores)
    const wanted = all.filter((x) => !isIgnored(ig, x.path))
    const texts = new Map()
    const blobs = new Map()
    const skipped = []
    let bytes = 0
    for (let i = 0; i < wanted.length; i += 8) {
      await Promise.all(wanted.slice(i, i + 8).map(async (x) => {
        if (Number.isFinite(x.size) && x.size > MAX_TEXT_BYTES) { skipped.push(x.path); return }
        const buf = await gh.file(head, x.path, MAX_TEXT_BYTES)
        if (!buf) return
        if (buf.tooLarge) { skipped.push(x.path); return }
        if (looksBinary(buf)) {
          if (buf.length > LARGE_FILE_BYTES) { skipped.push(x.path); return }
          blobs.set(x.path, { hash: sha1(buf), data: buf.toString('base64') })
        } else texts.set(x.path, buf.toString('utf8'))
        bytes += buf.length
      }))
    }
    return { state: 'loaded', head, texts, blobs, skipped: skipped.sort(), bytes }
  } catch (err) {
    if (err instanceof GitHubError && (err.status === 403 || err.status === 429)) return { state: 'backoff' }
    if (err instanceof GitHubError && (err.status === 404 || err.status === 401)) return { state: token ? 'token-refused' : 'private' }
    return { state: 'error', message: String(err.message).slice(0, 160) }
  }
}
