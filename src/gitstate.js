// What git is doing to a synced folder, read-only. Quilt never writes to git:
// it asks git whether a burst of file changes was an edit, a discard (stash,
// reset, restore), new commits (pull, merge, rebase) or a branch switch, and
// what a file looked like at a commit, so the shared work can be kept apart
// from what git did.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { watch } from 'chokidar'

export const GIT_TIMEOUT_MS = 5000
export const SETTLE_MS = 2000
export const BURST_PATHS = 20

const MARKERS = [
  ['index.lock', 'index-lock'], ['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect']
]

function run (root, args) {
  try {
    // QUILT_GIT lets tests point at a git binary that doesn't exist, to exercise
    // the "git is unreachable" path without touching the real PATH.
    return execFileSync(process.env.QUILT_GIT || 'git', args, { cwd: root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
  } catch { return null }
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

/** True when every one of `paths` is clean (matches HEAD) according to git. */
function allClean (root, paths) {
  if (!paths.length) return false
  const out = run(root, ['status', '--porcelain=v2', '-z', '--', ...paths])
  if (out === null) return false
  // Any entry at all means a change or an untracked file; clean paths print nothing,
  // and so does a path git has never heard of (outside the repo, or nonexistent).
  return out.replace(/\0/g, '').trim() === ''
}

/**
 * What a burst of changes to `changed` was, given the head seen `before` it.
 * busy: a merge/rebase/... is mid-way. switch: HEAD names another branch (or
 * commit). advance: HEAD moved on the same branch (pull, merge, rebase done,
 * commit). discard: HEAD unchanged and every changed path is clean now (stash,
 * reset --hard, restore). Otherwise edit.
 */
export function classify (root, { changed = [], before = null } = {}) {
  const head = headKey(root)
  if (!head) return { kind: 'edit', head: null, prevHead: before }
  if (busy(root)) return { kind: 'busy', head, prevHead: before }
  if (before && head.key !== before.key) return { kind: 'switch', head, prevHead: before }
  if (before && head.sha !== before.sha) return { kind: 'advance', head, prevHead: before }
  if (changed.length && allClean(root, changed)) return { kind: 'discard', head, prevHead: before }
  return { kind: 'edit', head, prevHead: before }
}

/** The file's text at a commit, or null when it did not exist there. */
export function fileAt (root, sha, rel) {
  return run(root, ['show', `${sha}:${rel}`])
}

/** Paths that differ between two commits. */
export function changedBetween (root, shaA, shaB) {
  const out = run(root, ['diff', '--name-only', '-z', shaA, shaB])
  return out ? out.split('\0').filter(Boolean) : []
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
