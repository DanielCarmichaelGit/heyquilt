// What git is doing to a synced folder, read-only. Quilt never writes to git:
// it asks git whether a burst of file changes was an edit, a discard (stash,
// reset, restore), new commits (pull, merge, rebase) or a branch switch, and
// what a file looked like at a commit, so the shared work can be kept apart
// from what git did.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { watch } from 'chokidar'
import { looksBinary, sha1, MAX_STORED_BINARY_BYTES } from './fsutil.js'

export const GIT_TIMEOUT_MS = 5000
export const SETTLE_MS = 2000
export const BURST_PATHS = 20

const MARKERS = [
  ['index.lock', 'index-lock'], ['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect']
]

// Output read in one go: a listing of a big repository, or a batch of files (see filesAt).
const MAX_OUTPUT = 256 * 1024 * 1024
// More paths than this are not passed on the command line: the whole tree is asked, and filtered.
const MAX_PATHSPECS = 200

/** Runs git: its output (a string, or a Buffer with `buffer`), or null when it fails. */
function run (root, args, opts) {
  return call(root, args, opts).out
}

const gitBinary = () => process.env.QUILT_GIT || 'git'

let timedOut = false // whether the last git call was stopped at GIT_TIMEOUT_MS

/**
 * Runs git: { out } or, when it fails, { out: null, missing, timedOut }
 * (missing: the git binary could not be started at all; timedOut: it ran
 * past GIT_TIMEOUT_MS and was stopped).
 */
function call (root, args, { buffer = false, input } = {}) {
  try {
    // QUILT_GIT lets tests point at a git binary that doesn't exist, to exercise
    // the "git is unreachable" path without touching the real PATH.
    const out = execFileSync(gitBinary(), args, {
      cwd: root,
      encoding: buffer ? undefined : 'utf8', // undefined: a Buffer
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    })
    runs.add(gitBinary())
    timedOut = false
    return { out, missing: false, timedOut }
  } catch (err) {
    const missing = err.code === 'ENOENT' || err.code === 'EACCES'
    if (!missing) runs.add(gitBinary()) // it started, then failed or ran too long: git is there
    timedOut = err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM'
    return { out: null, missing, timedOut }
  }
}

const runs = new Set() // git binaries seen to run

/** Whether the last git call ran past GIT_TIMEOUT_MS: asking again would stall the app as long again. */
export function lastCallTimedOut () { return timedOut }

/**
 * `ask()` (a read of git's that is null when git fails), asked once more when
 * it failed, unless that call timed out or git can't be run at all.
 */
export function askTwice (root, ask) {
  const r = ask()
  return r !== null || timedOut || !gitRuns(root) ? r : ask()
}

/**
 * Whether git itself can be run here (`git --version`), as against one call
 * of it failing (a timeout, a filter, a big read). Remembered once it has run.
 */
export function gitRuns (root) {
  const bin = gitBinary()
  if (runs.has(bin)) return true
  if (run(root, ['--version']) === null) return false
  runs.add(bin)
  return true
}

/** The branch .git/HEAD names (even one with no commits yet), or null (detached, or not a repo). No git call. */
export function headRef (root) {
  const dir = gitDir(root)
  if (!dir) return null
  try {
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim())
    return m ? m[1] : null
  } catch { return null }
}

/** A file's bytes as Quilt keys them (lastKnown, sharedKey): its text, or "bin:<sha1>". */
function keyOf (buf) {
  return looksBinary(buf) ? `bin:${sha1(buf)}` : buf.toString('utf8')
}

/** The folder's .git directory (a worktree's .git file points at it), or null. */
export function gitDir (root) {
  const dot = path.join(root, '.git')
  let st
  try { st = fs.statSync(dot) } catch { return null }
  if (st.isDirectory()) return dot
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, 'utf8'))
    if (!m) return null
    const dir = path.resolve(root, m[1].trim())
    return fs.existsSync(dir) ? dir : null
  } catch { return null }
}

/**
 * Where HEAD points: a branch, or a detached commit. Null when the folder is not a
 * repo, when git is unreachable (sha lookup fails), or on an unborn branch (a fresh
 * `git init` with no commits yet) — in every case there's nothing to compare against.
 */
export function headKey (root) {
  const dir = gitDir(root)
  if (!dir) return null
  let head
  try { head = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim() } catch { return null }
  const sha = (run(root, ['rev-parse', '--verify', '-q', 'HEAD']) || '').trim() || null
  if (!sha) return null
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
  if (ref) return { key: ref[1], branch: ref[1], sha }
  return { key: `@${sha.slice(0, 12)}`, branch: null, sha }
}

/** The git operation in progress in this folder, or null. `dir` lets a caller that already has it skip re-resolving it. */
export function busy (root, dir = gitDir(root)) {
  if (!dir) return null
  for (const [file, kind] of MARKERS) if (fs.existsSync(path.join(dir, file))) return kind
  return null
}

/** A cheap signal that git wrote the index (stash, reset, checkout, add...). Editors never do. */
export function indexStamp (root) {
  const dir = gitDir(root)
  if (!dir) return null
  try { const st = fs.statSync(path.join(dir, 'index')); return `${st.mtimeMs}:${st.size}` } catch { return null }
}

/**
 * What a burst of changes to `changed` was, given the head seen `before` it.
 * busy: a merge/rebase/... is mid-way. switch: HEAD names another branch (or
 * commit). advance: HEAD moved on the same branch (pull, merge, rebase done,
 * commit). discard: HEAD unchanged and every changed path is clean now (stash,
 * reset, restore). Otherwise edit, with `putBack`: the changed paths git may
 * have put back all the same (clean, and tracked or gone), so a discard that
 * shares its burst with an unrelated save (an untracked file, an autosave) can
 * still be told apart from an edit.
 */
export function classify (root, { changed = [], before = null } = {}) {
  const head = headKey(root)
  if (!head) return { kind: 'edit', head: null, prevHead: before, putBack: [] }
  if (busy(root)) return { kind: 'busy', head, prevHead: before }
  if (before && head.key !== before.key) return { kind: 'switch', head, prevHead: before }
  if (before && head.sha !== before.sha) return { kind: 'advance', head, prevHead: before }
  if (!changed.length) return { kind: 'edit', head, prevHead: before, putBack: [] }
  const tree = treeState(root, changed)
  // git could not say (a timeout in a big repo): held as busy, and asked again when it settles.
  if (!tree) return { kind: 'busy', head, prevHead: before }
  // Clean paths print nothing, and so does a path git has never heard of (outside the repo, or nonexistent).
  const clean = changed.filter((rel) => !tree.dirty.has(rel))
  if (clean.length === changed.length) return { kind: 'discard', head, prevHead: before }
  // As the settle tells them (planSettle): an untracked file git calls clean is still an edit.
  const putBack = clean.filter((rel) => tree.tracked.has(rel) || !exists(root, rel))
  return { kind: 'edit', head, prevHead: before, putBack }
}

function exists (root, rel) {
  try { fs.lstatSync(path.join(root, ...rel.split('/'))); return true } catch { return false }
}

/**
 * The file at a commit as Quilt keys it (its text, or "bin:<sha1>" for a
 * binary), as checkout would write it (--filters), or null when it did not
 * exist there (or git failed).
 */
export function fileAt (root, sha, rel) {
  const out = filesAt(root, sha, [rel])
  return out ? out.get(rel) ?? null : null
}

/**
 * Several files at one commit, in a few git calls whatever their number:
 * rel -> key (as fileAt), null (not there), or undefined (not read: bigger
 * than Quilt shares, behind a filter such as Git LFS, or a git call failed).
 * `out.failed` counts the files a failed git call left unread. Null only
 * when git itself can't be run.
 */
export function filesAt (root, sha, rels) {
  const out = new Map()
  out.failed = 0
  if (!rels.length) return out
  const unread = (list) => { for (const rel of list) out.set(rel, undefined); out.failed += list.length }
  // Sizes first, so a huge file can't overflow the read of the contents.
  const check = call(root, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: rels.map((r) => `${sha}:${r}\n`).join('') })
  if (check.missing) return null
  const lines = check.out === null ? [] : check.out.split('\n').slice(0, rels.length)
  if (lines.length !== rels.length) { unread(rels); return out }
  // A path with a filter (Git LFS, say) is never read: its smudged size is unknown (the blob is
  // a pointer), and running the filter can be slow or fail. The attributes are asked in one call.
  const filtered = filterOf(root, rels)
  if (filtered === null) { unread(rels); return out }
  const fetch = [] // [rel, blob id, size]
  rels.forEach((rel, i) => {
    const [id, type, size] = lines[i].split(' ')
    if (type !== 'blob' || !/^\d+$/.test(size)) out.set(rel, null) // "<name> missing", or a folder there
    else if (Number(size) > MAX_STORED_BINARY_BYTES || filtered.has(rel)) out.set(rel, undefined)
    else fetch.push([rel, id, Number(size)])
  })
  // With --filters each line is "<blob> <path>": the path picks the line-ending conversion, as
  // checkout would. That can change a size, so each file's own size is read from the batch's headers.
  const read = (chunk) => {
    const buf = call(root, ['cat-file', '--batch', '--filters'], { buffer: true, input: chunk.map(([rel, id]) => `${id} ${rel}\n`).join('') })
    if (buf.missing) return false
    if (buf.out === null) { unread(chunk.map(([rel]) => rel)); return true }
    let at = 0
    for (let i = 0; i < chunk.length; i++) {
      const rel = chunk[i][0]
      const nl = buf.out.indexOf(10, at)
      const header = nl < 0 ? '' : buf.out.subarray(at, nl).toString('utf8')
      if (/ missing$/.test(header)) { out.set(rel, null); at = nl + 1; continue }
      const size = Number(header.split(' ')[2])
      if (nl < 0 || !Number.isInteger(size)) { unread(chunk.slice(i).map(([r]) => r)); return true }
      const key = keyOf(buf.out.subarray(nl + 1, nl + 1 + size))
      out.set(rel, key.startsWith(LFS_POINTER) ? undefined : key) // an LFS pointer is not the file
      at = nl + 1 + size + 1
    }
    return true
  }
  let chunk = []; let bytes = 0
  for (const f of fetch) {
    if (chunk.length && bytes + f[2] > MAX_OUTPUT / 4) {
      if (!read(chunk)) return null
      chunk = []; bytes = 0
    }
    chunk.push(f); bytes += f[2]
  }
  if (chunk.length && !read(chunk)) return null
  return out
}

const LFS_POINTER = 'version https://git-lfs'

/** The paths with a `filter` attribute set (in .gitattributes), or null when git failed. */
function filterOf (root, rels) {
  const out = run(root, ['check-attr', '-z', '--stdin', 'filter'], { input: rels.join('\0') + '\0' })
  if (out === null) return null
  const f = out.split('\0')
  const filtered = new Set()
  for (let i = 0; i + 2 < f.length; i += 3) if (f[i + 2] !== 'unspecified' && f[i + 2] !== 'unset') filtered.add(f[i])
  return filtered
}

/** The commit a branch points at (wherever HEAD is), or null. */
export function branchTip (root, branch) {
  if (!branch || !gitDir(root)) return null
  return (run(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]) || '').trim() || null
}

/** Paths that differ between two commits, each with git's status letter (A added, M modified, D deleted...); null when git fails. */
export function changesBetween (root, shaA, shaB) {
  const out = run(root, ['diff', '--no-renames', '--no-ext-diff', '--name-status', '-z', shaA, shaB])
  if (out === null) return null
  const f = out.split('\0')
  const changes = new Map()
  for (let i = 0; i + 1 < f.length; i += 2) if (f[i + 1]) changes.set(f[i + 1], f[i][0])
  return changes
}

/** Paths that differ between two commits. */
export function changedBetween (root, shaA, shaB) {
  const changes = changesBetween(root, shaA, shaB)
  return changes ? [...changes.keys()] : []
}

/**
 * What git says about `paths` now, in two git calls whatever their number:
 * `dirty` (changed, staged, untracked or conflicted) and `tracked` (in the
 * index). Null when git fails.
 */
export function treeState (root, paths) {
  const spec = paths.length <= MAX_PATHSPECS ? ['--', ...paths] : []
  const status = run(root, ['--literal-pathspecs', 'status', '--porcelain=v2', '-z', '--untracked-files=all', ...spec])
  if (status === null) return null // not asking for the second when the first failed (or timed out)
  const listed = run(root, ['--literal-pathspecs', 'ls-files', '-z', ...spec])
  if (listed === null) return null
  const dirty = new Set()
  const f = status.split('\0')
  for (let i = 0; i < f.length; i++) {
    const e = f[i]
    if (e[0] === '1') dirty.add(e.split(' ').slice(8).join(' '))
    else if (e[0] === '2') dirty.add(e.split(' ').slice(9).join(' ')).add(f[++i]) // renamed: both paths
    else if (e[0] === 'u') dirty.add(e.split(' ').slice(10).join(' '))
    else if (e[0] === '?' || e[0] === '!') dirty.add(e.slice(2))
  }
  return { dirty, tracked: new Set(listed.split('\0').filter(Boolean)) }
}

/** Watches HEAD, the index and the in-progress markers; events: head, index, busy, idle. */
export function watchGit (root, onEvent) {
  const dir = gitDir(root)
  if (!dir) return { close: async () => {} }
  const names = new Set(['HEAD', 'index', ...MARKERS.map(([f]) => f)])
  let wasBusy = !!busy(root, dir)
  const watcher = watch(dir, { ignoreInitial: true, depth: 0, followSymlinks: false })
  const onAny = (p) => {
    const name = path.basename(p)
    if (!names.has(name)) return
    if (name === 'HEAD') onEvent({ type: 'head' })
    else if (name === 'index') onEvent({ type: 'index' })
    else {
      const now = !!busy(root, dir)
      if (now !== wasBusy) { wasBusy = now; onEvent({ type: now ? 'busy' : 'idle' }) }
    }
  }
  watcher.on('add', onAny).on('change', onAny).on('unlink', onAny).on('addDir', onAny).on('unlinkDir', onAny)
  return { close: () => watcher.close() }
}
