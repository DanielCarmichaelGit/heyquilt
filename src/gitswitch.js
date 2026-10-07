// The one kind of git write Quilt makes, and only for a member's own switch
// (the branch menu, quilt_switch_branch) or one they just made in git: moving
// a folder from one branch to another. A copy of the work it moves off disk
// goes to refs/quilt/parked/<branch> (a commit made with a scratch index, never
// a stash entry); the session's paths go back to HEAD; then `git switch`,
// fetching that one branch first when this repo hasn't got it. Never a commit
// on a branch, a pull, a push or a merge.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { checkBranchName, shortError } from './git.js'

// A fetch of one branch can take a while on a slow network; a switch of a big tree too.
export const SWITCH_TIMEOUT_MS = 60 * 1000
// Never stop to ask for a password or open an editor.
const ENV = { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' }
// A parked commit is Quilt's, not yours: it needs no identity from your git config.
const PARK_ID = { GIT_AUTHOR_NAME: 'Quilt', GIT_AUTHOR_EMAIL: 'quilt@localhost', GIT_COMMITTER_NAME: 'Quilt', GIT_COMMITTER_EMAIL: 'quilt@localhost' }

/** Runs git in `root`: { ok, out, err } (err: git's first useful line). Never rejects. */
function git (root, args, { input = '', env = {} } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = execFile(process.env.QUILT_GIT || 'git', args, { cwd: root, env: { ...process.env, ...ENV, ...env }, timeout: SWITCH_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, out: String(stdout), err: '' })
        resolve({ ok: false, out: String(stdout || ''), err: err.code === 'ENOENT' ? 'git is not installed' : shortError(stderr || err.message) })
      })
    } catch (err) { return resolve({ ok: false, out: '', err: err.message }) }
    child.stdin.on('error', () => {}) // git may exit before reading all of it
    child.stdin.end(input)
  })
}

/** git's output, or an Error with git's message. */
async function must (running) {
  const r = await running
  if (!r.ok) throw new Error(r.err)
  return r.out
}

/** Where the uncommitted work last moved off disk on branch `key` is kept. */
export const parkedRef = (key) => `refs/quilt/parked/${key}`

/** Why a switch can't run while git is mid-operation (busy() in gitstate.js names it). */
export function busyRefusal (kind) {
  return kind === 'index-lock' ? 'git is busy in this folder; try again when it finishes' : `Finish the git ${kind} first`
}

/**
 * Keeps the folder as it is on disk (tracked or untracked, what .gitignore
 * doesn't ignore) in refs/quilt/parked/<key>: a commit on top of HEAD, made
 * with a scratch index so the real one is untouched, replacing the one parked
 * for that branch before. Returns its sha, or null when there was nothing to
 * keep (the tree is HEAD's). Throws with git's message when git fails, so the
 * caller can refuse the switch before clearing anything.
 */
export async function park (root, key) {
  const index = path.join(os.tmpdir(), `quilt-park-${crypto.randomBytes(6).toString('hex')}`)
  const env = { GIT_INDEX_FILE: index }
  try {
    await must(git(root, ['rev-parse', '--git-dir'])) // throws when `root` isn't a repo at all
    const headCheck = await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])
    const head = headCheck.ok ? headCheck.out.trim() : null // no commits yet: not a failure, just nothing to diff against
    if (head) await must(git(root, ['read-tree', 'HEAD'], { env }))
    await must(git(root, ['add', '-A', '--', '.'], { env }))
    const tree = (await must(git(root, ['write-tree'], { env }))).trim()
    if (head) {
      const headTree = (await must(git(root, ['rev-parse', 'HEAD^{tree}']))).trim()
      if (tree === headTree) return null // the tree is clean: nothing to park
    }
    const sha = (await must(git(root, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', `Quilt: uncommitted work on ${key}`], { env: PARK_ID }))).trim()
    await must(git(root, ['update-ref', '-m', `quilt: parked ${key}`, parkedRef(key), sha]))
    return sha
  } finally { fs.rmSync(index, { force: true }) }
}

/**
 * Puts `paths` back as HEAD has them: those in HEAD are restored (index and
 * disk); the rest are taken out of the index and deleted, with any folder they
 * leave empty. Other paths are left alone. Throws with git's message.
 */
export async function clear (root, paths) {
  if (!paths.length) return { restored: 0, removed: 0 }
  const listed = await git(root, ['ls-tree', '-r', '-z', '--name-only', 'HEAD'])
  const inHead = new Set(listed.ok ? listed.out.split('\0').filter(Boolean) : []) // a branch with no commits has nothing
  const back = paths.filter((rel) => inHead.has(rel))
  const gone = paths.filter((rel) => !inHead.has(rel))
  if (back.length) {
    await must(git(root, ['--literal-pathspecs', 'restore', '--source=HEAD', '--staged', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: back.join('\0') }))
  }
  if (gone.length) {
    // Added but not committed: out of the index first, so git has nothing left of them either.
    await must(git(root, ['--literal-pathspecs', 'rm', '-q', '--cached', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: gone.join('\0') }))
    for (const rel of gone) {
      const abs = path.join(root, ...rel.split('/'))
      fs.rmSync(abs, { force: true })
      for (let dir = path.dirname(abs); dir !== root && dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
        try { fs.rmdirSync(dir) } catch { break } // not empty: the rest stays
      }
    }
  }
  return { restored: back.length, removed: gone.length }
}

/**
 * Moves HEAD to `branch`: this repo's branch when there is one; otherwise the
 * remote's (fetched now, and tracked); otherwise a new branch from `base` (the
 * commit the session's branch started from) when this repo has that commit,
 * else from HEAD. The caller has put the session's paths back to HEAD first.
 * A detached key (@<12 hex>) checks that commit out. Throws with git's message.
 */
export async function switchTo (root, branch, { base = null } = {}) {
  if (/^@[0-9a-f]{12}$/.test(branch)) {
    await must(git(root, ['switch', '--detach', branch.slice(1)]))
    return { how: 'local' }
  }
  if ((await git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`])).ok) {
    await must(git(root, ['switch', '--no-guess', branch]))
    return { how: 'local' }
  }
  if ((await git(root, ['remote', 'get-url', 'origin'])).ok &&
      (await git(root, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`])).ok) {
    await must(git(root, ['switch', '--track', `origin/${branch}`]))
    return { how: 'remote' }
  }
  const from = base && /^[0-9a-f]{40,64}$/.test(base) && (await git(root, ['cat-file', '-e', `${base}^{commit}`])).ok ? base : null
  await must(git(root, ['switch', '-c', branch, ...(from ? [from] : [])]))
  return { how: 'created', from }
}

/** New branch… : `git switch -c <name>` from HEAD, carrying the work in the folder. Returns the name. */
export async function startBranch (root, name) {
  name = await checkBranchName(name)
  await must(git(root, ['switch', '-c', name]))
  return name
}

/** This repo's own branches (refs/heads), or [] when git can't say. */
export async function localBranches (root) {
  const r = await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  return r.ok ? r.out.split('\n').map((s) => s.trim()).filter(Boolean) : []
}
