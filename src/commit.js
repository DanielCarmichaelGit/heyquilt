// Commit requests, committed in a person's folder with git: exactly the files a request names
// (those that differ from HEAD), with its message, then pushed to the branch's upstream. This is
// the way in when the relay can't commit for the asker (relay-commit.js: no GitHub token, a
// repository not on GitHub, or the owner keeps agents from committing): a person commits it from
// the app's commit panel (session.js: commitRequest).
//
// Committing touches no file: `git commit --only -- <paths>` moves the branch and the index
// entries of those paths, and leaves everything else (other people's uncommitted work, files
// someone staged by hand) as it was. Quilt never merges history: a push git refuses (the
// remote moved on) is reported, not forced.
//
// The pure parts (who changed which uncommitted file, what a person should know before
// committing a request, the commit message) are here too, so the app, the daemon and tests agree.
import { execFile } from 'node:child_process'
import { isSafeRelPath, globMatcher } from './pathrules.js'

export const COMMIT_TIMEOUT_MS = 60 * 1000 // a pre-commit hook may run tests
export const PUSH_TIMEOUT_MS = 90 * 1000
export const MAX_REQUEST_FILES = 500
export const MAX_MESSAGE = 500
// How long a request is left alone after it is made: the asker's AI may still be saving its files.
export const REQUEST_SETTLE_MS = 60 * 1000

const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0' }

/** Runs git: { ok, out, err }. Never rejects. */
function git (root, args, { timeout = 15000, env = {} } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = execFile(process.env.QUILT_GIT || 'git', args, { cwd: root, timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...NO_PROMPT, ...env } },
        (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }))
    } catch (err) { return resolve({ ok: false, out: '', err: err.message }) }
    child.stdin.end()
  })
}

/** The paths a request may name: relative, inside the folder, no duplicates. */
export function cleanFiles (files) {
  const out = []
  for (const f of Array.isArray(files) ? files : []) {
    const p = String(f || '').trim().replace(/\\/g, '/').replace(/^\.\//, '')
    if (!isSafeRelPath(p) || out.includes(p)) continue
    out.push(p)
    if (out.length >= MAX_REQUEST_FILES) break
  }
  return out
}

/**
 * Which of `files` differ from HEAD (changed, new or deleted, not ignored): Map path -> 'M' | 'A' | 'D'.
 * Null when git can't say.
 */
export async function uncommitted (root, files = null) {
  const args = ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all']
  if (files) {
    if (!files.length) return new Map()
    args.push('--', ...files.map((f) => `:(literal)${f}`))
  }
  const r = await git(root, args)
  if (!r.ok) return null
  const out = new Map()
  for (const rec of r.out.split('\0')) {
    if (rec.length < 4) continue
    const xy = rec.slice(0, 2)
    const rel = rec.slice(3)
    if (xy === '!!') continue
    out.set(rel, xy === '??' || xy.includes('A') ? 'A' : xy.includes('D') ? 'D' : 'M')
  }
  return out
}

/** When each path was last committed (ms), from the newest `depth` commits: Map path -> ts. */
export async function lastCommitted (root, { depth = 2000 } = {}) {
  const r = await git(root, ['-c', 'core.quotePath=false', 'log', `-n${depth}`, '--format=%x00%ct', '--name-only', 'HEAD'])
  const out = new Map()
  if (!r.ok) return out
  let ts = 0
  for (const line of r.out.split('\n')) {
    if (line.startsWith('\0')) { ts = Number(line.slice(1)) * 1000 || 0; continue }
    if (line && !out.has(line)) out.set(line, ts)
  }
  return out
}

/**
 * Commits the request's files that differ from HEAD, and pushes. Resolves
 * { hash, files, pushed, pushError, nothing } or throws with a plain reason (git refused, a hook failed).
 * `push` false only commits. `upstream` is { remote, name } (gitstate.upstreamOf); without one nothing is pushed.
 */
export async function commitFiles (root, { files, message, push = true, upstream = null, branch = '' } = {}) {
  const wanted = cleanFiles(files)
  const changed = await uncommitted(root, wanted)
  if (!changed) throw new Error('git could not read this folder')
  const paths = wanted.filter((f) => changed.has(f))
  if (!paths.length) return { hash: null, files: [], pushed: false, pushError: null, nothing: true }
  const spec = paths.map((f) => `:(literal)${f}`)
  // New files must be known to git before `commit --only` takes them; deletions are taken as they are.
  const added = paths.filter((f) => changed.get(f) === 'A')
  if (added.length) {
    const a = await git(root, ['add', '--', ...added.map((f) => `:(literal)${f}`)])
    if (!a.ok) throw new Error(`git add failed: ${firstLine(a.err)}`)
  }
  const c = await git(root, ['commit', '--only', '--no-edit', '-m', message, '--', ...spec], { timeout: COMMIT_TIMEOUT_MS })
  if (!c.ok) {
    // Leave nothing half-done: what was added for this commit goes back to untracked.
    if (added.length) await git(root, ['reset', '-q', '--', ...added.map((f) => `:(literal)${f}`)])
    throw new Error(`git commit failed: ${firstLine(c.err || c.out)}`)
  }
  const hash = (await git(root, ['rev-parse', 'HEAD'])).out.trim()
  if (!push || !upstream || !upstream.remote || upstream.remote === '.') return { hash, files: paths, pushed: false, pushError: upstream ? null : 'this branch has no upstream to push to', nothing: false }
  const target = String(upstream.name || '').startsWith(`${upstream.remote}/`) ? upstream.name.slice(upstream.remote.length + 1) : branch
  const p = await git(root, ['-c', 'core.askPass=', 'push', '--quiet', upstream.remote, `HEAD:refs/heads/${target}`], {
    timeout: PUSH_TIMEOUT_MS,
    env: { GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' }
  })
  return { hash, files: paths, pushed: p.ok, pushError: p.ok ? null : pushProblem(p.err, upstream.remote, target), nothing: false }
}

const firstLine = (s) => String(s || '').split('\n').map((l) => l.replace(/^(fatal|error):\s*/i, '').trim()).find(Boolean)?.slice(0, 200) || 'unknown error'

/** Why a push failed, in plain words (never a URL: it may carry credentials). */
export function pushProblem (stderr, remote = 'origin', branch = '') {
  const e = String(stderr || '').toLowerCase()
  if (/non-fast-forward|fetch first|rejected/.test(e)) return `${remote}/${branch} has commits this folder doesn't have yet: the commit is made here and will be pushed after Quilt catches the branch up`
  if (/could not read (username|password)|terminal prompts disabled|authentication failed|permission denied|repository not found|could not read from remote|access denied|returned error: 40[13]/.test(e)) return `git can't sign in to ${remote} from this folder to push`
  if (/could not resolve host|failed to connect|unable to access|network is unreachable|timed out/.test(e)) return `can't reach ${remote} (no network?)`
  return `git push failed: ${firstLine(stderr).replace(/[a-z]+:\/\/[^\s'"]*@/gi, '')}`
}

/** The commit message: what the request says, and who asked (and for which task). */
export function commitMessage (r) {
  const first = String(r.message || '').trim().split('\n')[0].slice(0, 120) || 'Changes from the Quilt session'
  const rest = String(r.message || '').trim().split('\n').slice(1).join('\n').trim()
  const by = r.by ? `Asked for by ${r.by} in Quilt${r.task ? ` (task ${r.task.id}: ${r.task.title})` : ''}.` : ''
  return [first, rest, by].filter(Boolean).join('\n\n')
}

/**
 * Who made each uncommitted change, from the session's history: for each path in `dirty`, the
 * people whose own edits (not pulls from git) to it came after it was last committed.
 * Returns Map path -> [names], newest editor last. `history`: entries, oldest first.
 */
export function editorsSince (dirty, history, committedAt = new Map()) {
  const out = new Map()
  for (const rel of dirty) out.set(rel, [])
  for (const e of history || []) {
    if (!e || !out.has(e.path) || e.pulled || !e.by) continue
    if ((e.ts || 0) <= (committedAt.get(e.path) || 0)) continue
    const list = out.get(e.path)
    const i = list.indexOf(e.by)
    if (i >= 0) list.splice(i, 1)
    list.push(e.by)
  }
  return out
}

/**
 * Uncommitted work grouped by who made it: [{ by, files }], most files first. A file several
 * people changed is listed under each. Files no history entry explains go under ''.
 */
export function uncommittedByPerson (editors) {
  const groups = new Map()
  for (const [rel, names] of editors) {
    for (const n of names.length ? names : ['']) {
      if (!groups.has(n)) groups.set(n, [])
      groups.get(n).push(rel)
    }
  }
  return [...groups].map(([by, files]) => ({ by, files: files.sort() })).sort((a, b) => b.files.length - a.files.length || a.by.localeCompare(b.by))
}

/**
 * What the person committing a request should know first, or '': a file with conflict markers,
 * one that also holds others' uncommitted changes (they would go in too), one someone else holds,
 * or an asker still at work.
 */
export function requestWarning (r, { editors, claims = [], markers = new Set(), taskEditors = new Set(), busy = [], now = Date.now() } = {}) {
  if (now - (r.ts || 0) < REQUEST_SETTLE_MS) return 'just asked'
  if (busy.includes(r.by)) return `${r.by} is still working`
  for (const [rel, names] of editors) {
    if (markers.has(rel)) return `${rel} has conflict markers`
    const others = names.filter((n) => n !== r.by && !taskEditors.has(n))
    if (others.length) return `${rel} also has uncommitted changes by ${others.join(', ')}`
    const held = claims.find((c) => c && c.by && c.by !== r.by && globMatcher(String(c.pattern || ''))(rel))
    if (held) return `${held.by} holds ${rel}`
  }
  return ''
}

// ------------------------------------------------------------- words --
// The same for the local and the hosted tools, and the HTTP routes' docs.

export const REQUEST_COMMIT_DESCRIPTION = 'Ask a person to commit your finished work, when quilt_commit can\'t (the owner keeps agents from committing, the session has no GitHub token, or the repository is not on GitHub). ' +
  'A person with git on this branch commits exactly these files (those that differ from git) with your message, from their app, and you are told the commit. ' +
  'Give the files you changed; without them, the task\'s changes (task) or every change of yours on record are asked for.'

/** Open requests (with ids, files and what holds them up) and recent commits, as lines for an agent. */
export function describeCommitRequests (c, { canCommit = false } = {}) {
  const lines = []
  const open = c.open || []
  if (open.length) {
    lines.push('Open commit requests:')
    for (const r of open) {
      const files = Array.isArray(r.files) && r.files.length ? ` (${r.files.length} file${r.files.length === 1 ? '' : 's'}: ${r.files.slice(0, 8).join(', ')}${r.files.length > 8 ? ', …' : ''})` : ''
      lines.push(`- [${r.id}] ${r.by}${r.branch ? ` on \`${r.branch}\`` : ''}: ${r.message}${r.task ? ` (task ${r.task.id})` : ''}${files}${r.error ? `. Last try: ${r.error}` : ''}`)
    }
    lines.push(canCommit ? 'This folder has git: its app commits a request with its Commit button.' : 'A person with git on that branch commits them from their app; the asker is told the commit.')
  } else lines.push('No open commit requests.')
  const recent = (c.recent || []).filter((r) => r.hash)
  if (recent.length) lines.push('Committed lately:', ...recent.map((r) => `- ${r.hash.slice(0, 7)} ${r.message} (${r.by}${r.pushed === false ? `; not pushed${r.pushError ? `: ${r.pushError}` : ''}` : ''})`))
  return lines.join('\n')
}
