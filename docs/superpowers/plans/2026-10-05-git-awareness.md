# Git Awareness (phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quilt recognises git operations in a synced folder (stash, reset, checkout, pull, rebase) and handles them instead of broadcasting them as edits, and stops performing git itself.

**Architecture:** A read-only `src/gitstate.js` asks git what a burst of file changes was. `Session` holds a folder's sync while git is busy or after a discard, writes the room's work back once the tree settles, merges pulled commits through the existing three-way engine, and pauses a folder that moved to another branch. The in-session Git popover, host commits and `quilt_commit` are removed; commit requests stay as a conversation.

**Tech Stack:** Node 22 ESM, `git` CLI (read-only), chokidar, Yjs, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-05-branch-documents-design.md` (this plan is its phase 1; phase 2 adds branch documents).

## Global Constraints

- Quilt never writes to git: no `git commit/stash/checkout/reset/pull/push/branch` anywhere in `src/` after this plan, except `cloneRepo` for New session.
- Every `git` call has a 5 s timeout and treats failure as "not git".
- Burst condition (any one): a `.git/index` change since the last flush; `.git/HEAD` changed within 2 s; an in-progress marker exists; ≥ 20 paths in one flush.
- Classification is by git's answers (`HEAD`, `rev-parse`, `status --porcelain=v2 -z`, `diff --name-only`), never by timing alone.
- Settle = no in-progress marker, no `index.lock`, no file change for 2 s (`SETTLE_MS = 2000`).
- Discard write-back log line, verbatim: `Quilt kept the session's work; your stash still has your copy.`
- Switch pause line, verbatim: `You're on <new>; this session syncs <old>. Sync resumes when you're back on <old>.`
- Commit requests (`quilt_request_commit`, `quilt_commit_status`, `quilt_wait_until_idle`, the chip, "Ask for a commit…") keep working; people mark them done.
- Folders without git behave exactly as today.
- ESM, StandardJS style, plain-English copy and log lines with the existing emoji style.
- Work in the worktree `.claude/worktrees/branch-docs` on branch `branch-docs`; commit after every task; never `npm install` from the worktree.

---

## File map

| File | Responsibility |
|---|---|
| `src/gitstate.js` (new) | Read git: head key, busy markers, classify a burst, file at a commit, changed paths between commits, watch `.git` |
| `src/session.js` | Burst detection in `flushPending`, holds, settle, discard write-back, advance merge, switch pause, `status().git` |
| `src/git.js` | Keep `checkBranchName`, `isRepo`, `ghStatus`, `listRepos`, `listBranches`, `cloneRepo`; remove `status`, `pull`, `hostsGit`, `commit`, `pushAndOpenPr` |
| `src/control.js`, `src/mcp.js`, `src/ui-server.js` | Remove `/commit`, `quilt_commit`, `/api/sessions/:id/git*`, `gitAction`, `gitDir`; add "mark commit request done" |
| `src/ui/session.js`, `src/ui/git.js` (deleted), `src/ui/app.css` | Branch label and hold note where the Git button was; commit chip lists open requests with a Done button |
| `test/gitstate.test.js` (new), `test/git-awareness.test.js` (new), `test/git.test.js`, `test/commits.test.js`, `test/ui.test.js`, `test/mcp.test.js` | Tests |
| `RELEASES.md` | Release note |

---

### Task 1: `src/gitstate.js`, reading git

**Files:**
- Create: `src/gitstate.js`
- Test: `test/gitstate.test.js`

**Interfaces:**
- Produces:
  - `gitDir(root) → string | null` (the `.git` directory, following a worktree's `.git` file)
  - `headKey(root) → { key, branch, sha } | null` (`key` = branch name, or `@<sha12>` when detached; null when not git or `git` is missing)
  - `busy(root) → 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | 'index-lock' | null`
  - `indexStamp(root) → string | null` (mtime+size of `.git/index`, cheap change signal)
  - `classify(root, { changed, before }) → { kind: 'edit' | 'discard' | 'advance' | 'switch' | 'busy', head, prevHead }`
  - `fileAt(root, sha, rel) → string | null`
  - `changedBetween(root, shaA, shaB) → string[]`
  - `watchGit(root, onEvent) → { close() }` with events `{ type: 'head' | 'busy' | 'idle' | 'index' }`
  - `GIT_TIMEOUT_MS = 5000`, `SETTLE_MS = 2000`, `BURST_PATHS = 20`

- [ ] **Step 1: Write the failing tests**

`test/gitstate.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { gitDir, headKey, busy, indexStamp, classify, fileAt, changedBetween, watchGit } from '../src/gitstate.js'

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-git-${n}-`))
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }

/** A repo with one commit on main holding a.txt and b.txt. */
function repo () {
  const dir = tmp('repo')
  git(dir, 'init', '-q', '-b', 'main')
  write(dir, 'a.txt', 'a1\na2\na3\n'); write(dir, 'b.txt', 'b1\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'one')
  return dir
}

test('no git: everything says so', () => {
  const dir = tmp('plain')
  assert.equal(gitDir(dir), null)
  assert.equal(headKey(dir), null)
  assert.equal(busy(dir), null)
  assert.equal(indexStamp(dir), null)
  assert.equal(classify(dir, { changed: ['x'], before: null }).kind, 'edit')
})

test('head key: branch, detached, and a worktree', () => {
  const dir = repo()
  const h = headKey(dir)
  assert.equal(h.branch, 'main'); assert.equal(h.key, 'main'); assert.match(h.sha, /^[0-9a-f]{40}$/)
  git(dir, 'checkout', '-q', '--detach')
  assert.equal(headKey(dir).key, `@${h.sha.slice(0, 12)}`)
  git(dir, 'checkout', '-q', 'main')
  const wt = path.join(tmp('wt'), 'w')
  git(dir, 'worktree', 'add', '-q', wt, '-b', 'feature')
  assert.ok(gitDir(wt).includes('worktrees'))
  assert.equal(headKey(wt).key, 'feature')
})

test('busy markers', () => {
  const dir = repo()
  assert.equal(busy(dir), null)
  fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '')
  assert.equal(busy(dir), 'index-lock')
  fs.rmSync(path.join(dir, '.git', 'index.lock'))
  fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), 'x')
  assert.equal(busy(dir), 'merge')
  fs.rmSync(path.join(dir, '.git', 'MERGE_HEAD'))
  fs.mkdirSync(path.join(dir, '.git', 'rebase-merge'))
  assert.equal(busy(dir), 'rebase')
})

test('classify: edit, discard, advance, switch', () => {
  const dir = repo()
  const before = headKey(dir)
  write(dir, 'a.txt', 'a1\nEDIT\na3\n')
  assert.equal(classify(dir, { changed: ['a.txt'], before }).kind, 'edit')
  git(dir, 'stash', '-q')
  const d = classify(dir, { changed: ['a.txt'], before })
  assert.equal(d.kind, 'discard'); assert.equal(d.head.sha, before.sha)
  git(dir, 'stash', 'pop', '-q')
  git(dir, 'commit', '-qam', 'two')
  const a = classify(dir, { changed: ['a.txt'], before })
  assert.equal(a.kind, 'advance'); assert.notEqual(a.head.sha, before.sha); assert.equal(a.prevHead.sha, before.sha)
  git(dir, 'checkout', '-qb', 'feature')
  assert.equal(classify(dir, { changed: [], before: headKey(dir) }).kind, 'edit', 'same key, nothing changed')
  const s = classify(dir, { changed: ['a.txt'], before: a.head })
  assert.equal(s.kind, 'switch'); assert.equal(s.head.key, 'feature')
})

test('classify: busy wins, and a mix of clean and dirty paths is an edit', () => {
  const dir = repo()
  const before = headKey(dir)
  write(dir, 'a.txt', 'changed\n')
  fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), 'x')
  assert.equal(classify(dir, { changed: ['a.txt'], before }).kind, 'busy')
  fs.rmSync(path.join(dir, '.git', 'MERGE_HEAD'))
  assert.equal(classify(dir, { changed: ['a.txt', 'b.txt'], before }).kind, 'edit')
})

test('fileAt and changedBetween', () => {
  const dir = repo()
  const one = headKey(dir).sha
  write(dir, 'a.txt', 'a1\na2\na3\na4\n'); git(dir, 'commit', '-qam', 'two')
  const two = headKey(dir).sha
  assert.equal(fileAt(dir, one, 'a.txt'), 'a1\na2\na3\n')
  assert.equal(fileAt(dir, one, 'nope.txt'), null)
  assert.deepEqual(changedBetween(dir, one, two), ['a.txt'])
})

test('indexStamp changes when git touches the index, not when a file is edited', () => {
  const dir = repo()
  const s0 = indexStamp(dir)
  write(dir, 'a.txt', 'x\n')
  assert.equal(indexStamp(dir), s0)
  git(dir, 'add', 'a.txt')
  assert.notEqual(indexStamp(dir), s0)
})

test('watchGit reports head, busy and idle', async () => {
  const dir = repo()
  const seen = []
  const w = watchGit(dir, (e) => seen.push(e.type))
  await new Promise((r) => setTimeout(r, 300))
  git(dir, 'checkout', '-qb', 'feature')
  fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), 'x')
  await new Promise((r) => setTimeout(r, 400))
  fs.rmSync(path.join(dir, '.git', 'MERGE_HEAD'))
  await new Promise((r) => setTimeout(r, 400))
  await w.close()
  assert.ok(seen.includes('head'), `head seen: ${seen}`)
  assert.ok(seen.includes('busy') && seen.includes('idle'), `busy/idle seen: ${seen}`)
})
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test test/gitstate.test.js` — FAIL, cannot find module.

- [ ] **Step 3: Implement `src/gitstate.js`**

```js
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
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
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

/** Where HEAD points: a branch, or a detached commit. Null when the folder is not a repo. */
export function headKey (root) {
  const dir = gitDir(root)
  if (!dir) return null
  let head
  try { head = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim() } catch { return null }
  const sha = (run(root, ['rev-parse', '--verify', '-q', 'HEAD']) || '').trim() || null
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
  if (ref) return { key: ref[1], branch: ref[1], sha }
  if (!sha) return null
  return { key: `@${sha.slice(0, 12)}`, branch: null, sha }
}

/** The git operation in progress in this folder, or null. */
export function busy (root) {
  const dir = gitDir(root)
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
  // Any entry at all means a change or an untracked file; clean paths print nothing.
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
  let wasBusy = !!busy(root)
  const watcher = watch(dir, { ignoreInitial: true, depth: 0, followSymlinks: false })
  const onAny = (p) => {
    const name = path.basename(p)
    if (!names.has(name)) return
    if (name === 'HEAD') onEvent({ type: 'head' })
    else if (name === 'index') onEvent({ type: 'index' })
    else {
      const now = !!busy(root)
      if (now !== wasBusy) { wasBusy = now; onEvent({ type: now ? 'busy' : 'idle' }) }
    }
  }
  watcher.on('add', onAny).on('change', onAny).on('unlink', onAny).on('addDir', onAny).on('unlinkDir', onAny)
  return { close: () => watcher.close() }
}
```

Note on `allClean`: `git status --porcelain=v2 -z -- <paths>` prints nothing for paths equal to HEAD and the index; after a stash they are clean. A file that is *tracked and deleted* prints an entry, so a stash that removed an added-then-staged file is not "clean"; that is fine (it becomes an edit, which is what a deletion is).

- [ ] **Step 4: Run the tests**

Run: `node --test test/gitstate.test.js` — 8 PASS. If `watchGit` misses `head`, chokidar on macOS may need `usePolling: false` plus `awaitWriteFinish: false`; `.git/HEAD` is rewritten atomically (rename), so listen to `add` as well as `change` (done above).

- [ ] **Step 5: Commit**

```bash
git add src/gitstate.js test/gitstate.test.js
git commit -m "Read what git is doing to a synced folder, without ever writing to it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Holds, settle, discard write-back, advance merge, switch pause

**Files:**
- Modify: `src/session.js` (imports; constructor; `flushPending`; `ingest`/`writeOut` guards; `startWatcher`; `stop`; `status`)
- Test: `test/git-awareness.test.js` (new)

**Interfaces:**
- Consumes: Task 1's exports; the existing `mergeOne({ rel, base })`, `merging` set, `writeOut`, `tryWrite`, `applyRemote`, `lastKnown`.
- Produces on `Session`: `this.git` (`{ key, branch, sha } | null`, the branch this session syncs), `this.hold` (`null | { kind: 'busy' | 'settling' | 'switching', since, prevHead }`), `setHold(kind, extra)`, `releaseHold()`, `classifyBurst(paths)`, `settleSoon()`, `onSettled()`, `advanceFrom(prevSha, head)`, `writeBack(paths)`; `status().git = { branch, key, hold }`; event `'hold'` with the hold or null.

- [ ] **Step 1: Write the failing tests**

`test/git-awareness.test.js`:

```js
// Git operations in a synced folder are recognised, not broadcast: a stash on
// one machine never erases the room's work; pulled commits merge into it; a
// folder on another branch pauses. Real relay, two folders, real git.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { generateIdentity } from '../src/identity.js'

let srv, server
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-ga-${n}-`))
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV }).trim()
async function waitFor (fn, ms = 8000) {
  const start = Date.now(); let last
  while (Date.now() - start < ms) { try { last = await fn(); if (last) return last } catch (e) { last = e }; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error(`timed out; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}
/** Holds for `ms` and fails if `fn` ever becomes true meanwhile. */
async function never (fn, ms = 1500) {
  const start = Date.now()
  while (Date.now() - start < ms) { assert.ok(!(await fn()), 'happened but must not'); await new Promise((r) => setTimeout(r, 25)) }
}
const ids = new Map()
const identityOf = (n) => { if (!ids.has(n)) ids.set(n, generateIdentity()); return ids.get(n) }
const stopped = new Set()
const close = async (s) => { if (!stopped.has(s)) { stopped.add(s); await s.stop() } }
async function open (t, dir, name, extra) {
  const s = new Session({ dir, server, secret: 'pw', name, identity: identityOf(name), ...extra })
  t.after(() => close(s))
  await s.start({ waitTimeoutMs: 5000 })
  return s
}
process.env.QUILT_MERGE_CMD = `${process.execPath} ${path.join(tmp('cli'), 'no.mjs')}`
fs.writeFileSync(process.env.QUILT_MERGE_CMD.split(' ')[1], "process.stdout.write('CONFLICT: no\\n')")

let rooms = 0
/** A bare remote, two clones (alice, bob) with one commit, both in a fresh room. */
async function pairRepos (t) {
  const bare = tmp('bare'); git(bare, 'init', '-q', '--bare', '-b', 'main')
  const seed = tmp('seed'); git(seed, 'clone', '-q', bare, '.')
  write(seed, 'src/app.js', 'line1\nline2\nline3\nline4\nline5\n'); write(seed, 'README.md', 'hello\n')
  git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'one'); git(seed, 'push', '-q', 'origin', 'main')
  const dirA = tmp('a'); git(dirA, 'clone', '-q', bare, '.')
  const dirB = tmp('b'); git(dirB, 'clone', '-q', bare, '.')
  const room = `ga${++rooms}`
  const A = await open(t, dirA, 'alice', { room })
  const B = await open(t, dirB, 'bob', { room })
  await waitFor(() => A.status().connected && B.status().connected)
  return { A, B, dirA, dirB, bare, room }
}

before(async () => { srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, maxNewRoomsPerHour: 0 }); server = `ws://127.0.0.1:${srv.port}` })
after(async () => { await srv.close() })

test('a git folder reports its branch; a plain folder reports none', async (t) => {
  const { A } = await pairRepos(t)
  assert.equal(A.status().git.branch, 'main')
  const plain = tmp('plain'); write(plain, 'x.txt', 'x\n')
  const P = await open(t, plain, 'pat', { room: 'ga-plain' })
  assert.equal(P.status().git, null)
})

test('a stash on one machine does not erase the room\'s work; it comes back after settling', async (t) => {
  const { A, B, dirA, dirB } = await pairRepos(t)
  write(dirA, 'src/app.js', 'line1 (alice)\nline2\nline3\nline4\nline5\n')
  await waitFor(() => read(dirB, 'src/app.js') === 'line1 (alice)\nline2\nline3\nline4\nline5\n')
  git(dirB, 'stash', '-q') // bob's disk reverts to the commit
  await never(() => read(dirA, 'src/app.js') !== 'line1 (alice)\nline2\nline3\nline4\nline5\n', 2500)
  await waitFor(() => read(dirB, 'src/app.js') === 'line1 (alice)\nline2\nline3\nline4\nline5\n', 8000)
  assert.ok(B.logs.some((l) => l.includes('Quilt kept the session\'s work')), B.logs.join('\n'))
  assert.equal(git(dirB, 'stash', 'list').split('\n').filter(Boolean).length, 1, 'the stash is untouched')
})

test('reset --hard by an agent is the same', async (t) => {
  const { A, dirA, dirB } = await pairRepos(t)
  write(dirA, 'README.md', 'hello from alice\n')
  await waitFor(() => read(dirB, 'README.md') === 'hello from alice\n')
  git(dirB, 'reset', '-q', '--hard')
  await never(() => read(dirA, 'README.md') !== 'hello from alice\n', 2500)
  await waitFor(() => read(dirB, 'README.md') === 'hello from alice\n', 8000)
})

test('stash, pull, pop lands once with the pulled commit merged, no flicker', async (t) => {
  const { A, B, dirA, dirB } = await pairRepos(t)
  // Alice's uncommitted edit is shared; bob also has his own local commit to pull over.
  write(dirA, 'src/app.js', 'line1\nline2\nline3\nline4\nline5 (alice)\n')
  await waitFor(() => read(dirB, 'src/app.js') === 'line1\nline2\nline3\nline4\nline5 (alice)\n')
  // A commit on the remote touching line1, made elsewhere.
  const bareOf = git(dirA, 'remote', 'get-url', 'origin')
  const c = tmp('c'); git(c, 'clone', '-q', bareOf, '.')
  write(c, 'src/app.js', 'line1 (remote)\nline2\nline3\nline4\nline5\n'); git(c, 'commit', '-qam', 'remote'); git(c, 'push', '-q', 'origin', 'main')
  const flicker = []
  const watch = setInterval(() => flicker.push(read(dirA, 'src/app.js')), 20)
  git(dirB, 'stash', '-q'); git(dirB, 'pull', '-q', '--ff-only'); git(dirB, 'stash', 'pop', '-q')
  const want = 'line1 (remote)\nline2\nline3\nline4\nline5 (alice)\n'
  await waitFor(() => read(dirA, 'src/app.js') === want && read(dirB, 'src/app.js') === want, 10000)
  clearInterval(watch)
  assert.ok(!flicker.includes('line1\nline2\nline3\nline4\nline5\n'), 'alice never saw the committed state flash by')
})

test('a pull that changes a file the partner is editing merges three-way; an overlap becomes a merge record', async (t) => {
  const { A, B, dirA, dirB } = await pairRepos(t)
  write(dirA, 'src/app.js', 'line1\nline2\nline3\nline4\nline5 (alice)\n')
  await waitFor(() => read(dirB, 'src/app.js') === 'line1\nline2\nline3\nline4\nline5 (alice)\n')
  const bareOf = git(dirA, 'remote', 'get-url', 'origin')
  const c = tmp('c'); git(c, 'clone', '-q', bareOf, '.')
  write(c, 'src/app.js', 'line1 (remote)\nline2\nline3\nline4\nline5\n'); write(c, 'README.md', 'hello (remote)\n')
  git(c, 'commit', '-qam', 'remote'); git(c, 'push', '-q', 'origin', 'main')
  write(dirA, 'README.md', 'hello (alice)\n')
  await waitFor(() => read(dirB, 'README.md') === 'hello (alice)\n')
  git(dirB, 'stash', '-q'); git(dirB, 'pull', '-q', '--ff-only'); git(dirB, 'stash', 'pop', '-q')
  await waitFor(() => read(dirA, 'src/app.js') === 'line1 (remote)\nline2\nline3\nline4\nline5 (alice)\n', 10000)
  const rec = await waitFor(() => A.mergeList().find((m) => m.path === 'README.md' && m.state === 'open'), 10000)
  assert.equal(rec.kind, 'conflict')
})

test('a rebase with a conflict never shows git markers to the partner; continuing merges the result', async (t) => {
  const { A, B, dirA, dirB } = await pairRepos(t)
  const bareOf = git(dirA, 'remote', 'get-url', 'origin')
  const c = tmp('c'); git(c, 'clone', '-q', bareOf, '.')
  write(c, 'README.md', 'remote wins\n'); git(c, 'commit', '-qam', 'remote'); git(c, 'push', '-q', 'origin', 'main')
  // bob commits a conflicting change locally (the shared file changes for alice too, as an edit)
  write(dirB, 'README.md', 'bob wins\n')
  await waitFor(() => read(dirA, 'README.md') === 'bob wins\n')
  git(dirB, 'commit', '-qam', 'bob')
  let failed = false
  try { git(dirB, 'pull', '-q', '--rebase') } catch { failed = true }
  assert.ok(failed, 'the rebase stops on the conflict')
  assert.match(read(dirB, 'README.md'), /<<<<<<< /)
  await never(() => /<<<<<<< /.test(read(dirA, 'README.md') || ''), 2000)
  write(dirB, 'README.md', 'both win\n'); git(dirB, 'add', 'README.md')
  execFileSync('git', ['rebase', '--continue'], { cwd: dirB, env: { ...ENV, GIT_EDITOR: 'true' }, stdio: 'ignore' })
  await waitFor(() => read(dirA, 'README.md') === 'both win\n', 10000)
})

test('checking out another branch pauses that folder; coming back resumes and merges', async (t) => {
  const { A, B, dirA, dirB } = await pairRepos(t)
  git(dirB, 'checkout', '-qb', 'feature')
  await waitFor(() => B.status().git.hold?.kind === 'switching')
  assert.ok(B.logs.some((l) => l.includes("You're on feature; this session syncs main")), B.logs.join('\n'))
  write(dirB, 'src/app.js', 'feature work\n')
  write(dirA, 'README.md', 'main work\n')
  await never(() => read(dirA, 'src/app.js') === 'feature work\n', 2000)
  await never(() => read(dirB, 'README.md') === 'main work\n', 500)
  git(dirB, 'stash', '-q'); git(dirB, 'checkout', '-q', 'main')
  await waitFor(() => B.status().git.hold === null, 10000)
  await waitFor(() => read(dirB, 'README.md') === 'main work\n' && read(dirB, 'src/app.js') === 'line1\nline2\nline3\nline4\nline5\n')
})

test('a folder without git is untouched by all of this', async (t) => {
  const dirA = tmp('pa'); const dirB = tmp('pb'); write(dirA, 'x.txt', 'x\n')
  const A = await open(t, dirA, 'alice', { room: 'ga-plain2' })
  const B = await open(t, dirB, 'bob', { room: 'ga-plain2' })
  await waitFor(() => read(dirB, 'x.txt') === 'x\n')
  write(dirB, 'x.txt', 'y\n')
  await waitFor(() => read(dirA, 'x.txt') === 'y\n')
  assert.equal(A.status().git, null)
})
```

`Session` must expose `logs` for these tests: a small array of the last 200 log lines, appended in `log()`.

- [ ] **Step 2: Run to see them fail**

Run: `node --test test/git-awareness.test.js` — FAIL (`status().git` undefined, stash broadcasts).

- [ ] **Step 3: Implement in `src/session.js`**

Imports:

```js
import { headKey, busy as gitBusy, indexStamp, classify, fileAt, changedBetween, watchGit, SETTLE_MS, BURST_PATHS } from './gitstate.js'
```

Constructor additions:

```js
    this.logs = [] // the last 200 log lines (for status and tests)
    this.git = null // { key, branch, sha } this folder was on when the session started (null: not a repo)
    this.gitSeen = null // the head last seen by classifyBurst
    this.gitIndex = null // indexStamp at the last flush
    this.hold = null // { kind: 'busy'|'settling'|'switching', since, prevHead } while this folder's sync is held
    this.heldPaths = new Set() // paths that changed while held
    this.headChangedAt = 0
    this.settleTimer = null
```

`log()`:

```js
  log (msg) { this.logs.push(msg); if (this.logs.length > 200) this.logs.shift(); this.emit('log', msg) }
```

Guards. In `ingest(rel)`, right after the `merging` check: `if (this.hold) { this.heldPaths.add(rel); return false }`. In `writeOut(rel)`, right after the `merging` check: `if (this.hold) { this.heldPaths.add(rel); return }` (remote updates for held paths are applied by `writeBack` when the hold ends).

`flushPending` becomes:

```js
  flushPending () {
    clearTimeout(this.flushTimer)
    this.flushTimer = null
    const paths = [...this.pending]
    this.pending.clear()
    if (this.hold) { for (const rel of paths) this.heldPaths.add(rel); this.settleSoon(); return }
    if (this.git && this.isBurst(paths)) return this.classifyBurst(paths)
    for (const rel of paths) {
      try { this.ingest(rel) } catch (err) { this.log(`could not sync ${rel}: ${err.message}`) }
    }
  }

  /** Did git just touch this folder? (index written, HEAD moved, an operation in progress, or a flood of paths) */
  isBurst (paths) {
    const stamp = indexStamp(this.root)
    const indexChanged = stamp !== this.gitIndex
    this.gitIndex = stamp
    return indexChanged || Date.now() - this.headChangedAt < 2000 || !!gitBusy(this.root) || paths.length >= BURST_PATHS
  }

  classifyBurst (paths) {
    const r = classify(this.root, { changed: paths, before: this.gitSeen })
    if (r.head) this.gitSeen = r.head
    switch (r.kind) {
      case 'edit':
        for (const rel of paths) { try { this.ingest(rel) } catch (err) { this.log(`could not sync ${rel}: ${err.message}`) } }
        return
      case 'busy':
        for (const rel of paths) this.heldPaths.add(rel)
        this.setHold('busy', { prevHead: r.prevHead })
        return
      case 'discard':
        for (const rel of paths) this.heldPaths.add(rel)
        this.setHold('settling', { prevHead: r.prevHead })
        this.settleSoon()
        return
      case 'advance':
        for (const rel of paths) this.heldPaths.add(rel)
        this.setHold('settling', { prevHead: r.prevHead })
        this.settleSoon()
        return
      case 'switch':
        for (const rel of paths) this.heldPaths.add(rel)
        this.setHold('switching', { prevHead: r.prevHead, to: r.head.key })
        this.log(`⏸️ You're on ${r.head.key}; this session syncs ${this.git.key}. Sync resumes when you're back on ${this.git.key}.`)
        return
    }
  }

  setHold (kind, extra = {}) {
    if (this.hold && this.hold.kind === kind) return
    this.hold = { kind, since: Date.now(), ...(this.hold ? { prevHead: this.hold.prevHead } : {}), ...extra }
    if (!this.hold.prevHead) this.hold.prevHead = this.gitSeen
    this.emit('hold', this.hold)
    this.scheduleStatusWrite()
  }

  releaseHold () {
    this.hold = null
    clearTimeout(this.settleTimer); this.settleTimer = null
    this.emit('hold', null)
    this.scheduleStatusWrite()
  }

  /** (Re)arms the settle timer: the hold ends SETTLE_MS after the last file or git event. */
  settleSoon () {
    if (!this.hold || this.hold.kind === 'switching') return
    clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => this.onSettled().catch((err) => this.log(`could not settle: ${err.message}`)), SETTLE_MS)
    this.settleTimer.unref()
  }

  async onSettled () {
    if (!this.hold || this.stopped) return
    if (gitBusy(this.root)) { this.setHold('busy'); return } // still mid-operation; idle will re-arm
    const head = headKey(this.root)
    const prev = this.hold.prevHead
    const paths = [...this.heldPaths]
    this.heldPaths.clear()
    if (head && this.git && head.key !== this.git.key) {
      // Landed on another branch while settling: pause instead.
      this.setHold('switching', { to: head.key })
      this.log(`⏸️ You're on ${head.key}; this session syncs ${this.git.key}. Sync resumes when you're back on ${this.git.key}.`)
      for (const rel of paths) this.heldPaths.add(rel)
      return
    }
    this.gitSeen = head
    this.releaseHold()
    if (head && prev && head.sha !== prev.sha) await this.advanceFrom(prev.sha, head.sha, paths)
    else this.writeBack(paths, true)
  }

  /** Puts the room's version of each path back on disk (a discard on this machine never discards the room's work). */
  writeBack (paths, say = false) {
    let n = 0
    for (const rel of paths) {
      if (!this.syncable(rel)) continue
      const disk = this.readDisk(rel)
      if (disk && (disk.skip || disk.tooLarge)) continue
      if ((disk ? disk.key : undefined) === this.sharedKey(rel)) { if (disk) this.lastKnown.set(rel, disk.key); continue }
      this.lastKnown.delete(rel)
      if (this.tryWrite(rel)) n++
    }
    if (say && n) this.log(`↩️ Quilt kept the session's work; your stash still has your copy. (${n} file${n === 1 ? '' : 's'})`)
  }

  /**
   * New commits reached this folder (pull, merge, rebase). Each path the commits
   * changed is merged three-way into the shared doc: base = the file at the old
   * commit, ours = the disk now, theirs = the room. Other held paths get the
   * room's version back.
   */
  async advanceFrom (prevSha, sha, held) {
    const changed = new Set(changedBetween(this.root, prevSha, sha))
    const rest = held.filter((rel) => !changed.has(rel))
    this.writeBack(rest)
    const entries = [...changed].filter((rel) => this.syncable(rel)).map((rel) => ({ rel, base: fileAt(this.root, prevSha, rel) ?? undefined }))
    for (const e of entries) this.merging.add(e.rel)
    let merged = 0; let conflicts = 0
    for (const e of entries) {
      try {
        const r = await this.mergeOne(e)
        if (r === 'merged' || r === 'ai' || r === 'pushed') merged++
        if (r === 'conflict') conflicts++
      } catch (err) { this.merging.delete(e.rel); this.log(`could not merge ${e.rel}: ${err.message}`) }
    }
    for (const e of entries) this.merging.delete(e.rel)
    if (entries.length) this.log(`🔀 Merged the commits you pulled into the session's work (${entries.length} file${entries.length === 1 ? '' : 's'}${conflicts ? `, ${conflicts} need${conflicts === 1 ? 's' : ''} merging` : ''})`)
  }
```

`mergeOne` reads ours from disk and theirs from the doc already, and `base: undefined` means "no base" (both added); keep its contract. Its `theirs === base` shortcut pushes ours: for a pulled commit that changed a file nobody edited in the room, `theirs` equals the old commit's text (the doc holds the committed state) and ours is the new commit, so the new text is pushed. Correct.

`startWatcher` additions, at the top:

```js
    this.git = headKey(this.root)
    this.gitSeen = this.git
    this.gitIndex = indexStamp(this.root)
    if (this.git) {
      this.gitWatcher = watchGit(this.root, (e) => {
        if (e.type === 'head') { this.headChangedAt = Date.now(); this.queue('.quilt/HEAD-changed') }
        else if (e.type === 'busy') { this.setHold('busy') }
        else if (e.type === 'idle' || e.type === 'index') { this.settleSoon() }
        if (this.hold && this.hold.kind === 'switching') this.checkBackOnBranch()
      })
    }
```

`queue('.quilt/HEAD-changed')` is a sentinel: it is not syncable, so `ingest` ignores it, but it makes `flushPending` run and `isBurst` see the head change even when no file changed (a checkout between identical trees). Filter it out in `classifyBurst` (`paths.filter((p) => p !== '.quilt/HEAD-changed')`).

```js
  /** While switched away: did HEAD come back to the branch this session syncs? */
  checkBackOnBranch () {
    const head = headKey(this.root)
    if (!head || !this.git || head.key !== this.git.key) return
    // Back: let it settle, then merge whatever the commits did and restore the rest.
    this.hold = { kind: 'settling', since: Date.now(), prevHead: this.hold.prevHead }
    this.settleSoon()
  }
```

`stop()`: `if (this.gitWatcher) await this.gitWatcher.close()`, `clearTimeout(this.settleTimer)`.

`status()`: add

```js
      git: this.git ? { branch: this.git.branch, key: this.git.key, hold: this.hold ? { kind: this.hold.kind, since: this.hold.since, to: this.hold.to || null } : null } : null,
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/git-awareness.test.js` then `node --test test/sync.test.js` (nothing there uses git, so it must be unchanged), then `npm test`.
Expected: PASS. Known traps:
- The `never()` checks need the write-back not to happen before settle: ensure `writeOut` is guarded by `hold` (otherwise the stash's revert is "fixed" immediately, and the pull test flickers).
- In the stash test, `git stash` writes `index` and reverts files within the same 40 ms flush, so `isBurst` sees the index change. If it doesn't (slow disk), the `headChangedAt`/index checks are not enough; then compare `indexStamp` in `queue()` too (store it when the first path is queued).
- After `writeBack`, chokidar reports the written files as changes; they hit `ingest`, find `disk.key === sharedKey`, and no-op.

- [ ] **Step 5: Commit**

```bash
git add src/session.js test/git-awareness.test.js
git commit -m "Recognise git operations in a synced folder instead of broadcasting them

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Remove Quilt's own git actions; keep commit requests

**Files:**
- Modify: `src/git.js`, `src/control.js`, `src/mcp.js`, `src/ui-server.js`, `src/session.js` (`markCommitRequestDone`)
- Delete: `src/ui/git.js`
- Modify: `src/ui/session.js`, `src/ui/app.css`
- Test: `test/git.test.js`, `test/commits.test.js`, `test/ui.test.js`, `test/mcp.test.js`

**Interfaces:**
- Produces: `POST /commit-request/done { id? }` (daemon) and `POST /api/sessions/:id/commit-request/done { id? }` (app) → `{ done: n }`, calling `session.resolveCommitRequests({ ids: id ? [id] : null })`; MCP `quilt_commit_request_done { id? }`.
- Removes: `gitops.status/pull/hostsGit/commit/pushAndOpenPr`; routes `GET /api/sessions/:id/git`, `POST …/git/pull`, `…/git/commit`, `…/git/pr`; `gitAction`, `gitDir`, `hostsGit` in ui-server; `POST /commit` in control; `quilt_commit` in mcp; `src/ui/git.js`.

- [ ] **Step 1: Update the tests first**

`test/git.test.js`: delete the tests "status: branch…", "commit: stages…", "pull: fetches…", "pull: a conflict…", "push and open a PR…", "API: start a session from GitHub, then commit and open a PR" (keep its first half if it only starts the session from GitHub: rename to "API: start a session from GitHub" and stop after the session is created), "API: git endpoints refuse folders…". Keep: branch names, clone, gh status/repos/branches.

`test/commits.test.js`: in "commit requests, busy people, and the host committing", replace the `POST /commit` part with:

```js
  await assert.rejects(call(d(guestCtl, guest), 'POST', '/commit', {}), /not found/)
  const r = await call(d(hostCtl, host), 'POST', '/commit-request/done', {})
  assert.equal(r.done, 1)
  await waitFor(() => guest.commitStatus().open.length === 0)
```

and rename the test "commit requests, busy people, and marking them done".

`test/ui.test.js`: add to an existing session test:

```js
  assert.equal((await api('GET', `/api/sessions/${id}/git`)).status, 404)
  const asked = await api('POST', `/api/sessions/${id}/commit-request`, { message: 'ship it' })
  assert.equal(asked.status, 200)
  const done = await api('POST', `/api/sessions/${id}/commit-request/done`, {})
  assert.equal(done.body.done, 1)
```

`test/mcp.test.js`: where tools are listed (or add a small test): `quilt_commit` absent, `quilt_commit_request_done` present; calling it with no open requests returns "No open commit requests."

- [ ] **Step 2: Run to see them fail**

Run: `node --test test/commits.test.js test/ui.test.js test/mcp.test.js` — FAIL on the new routes/tools.

- [ ] **Step 3: Remove and add**

`src/git.js`: delete `status`, `pull`, `hostsGit`, `commit`, `pushAndOpenPr` and any helper only they used (`mustBeRepo` stays if `cloneRepo` uses it). Update the file comment: "Git for starting a session from GitHub: checking names, listing repos and branches, cloning. Quilt never commits, pulls or pushes."

`src/control.js`: remove `POST /commit`; in `GET /commits` drop `host: …` and the `gitops` import; add:

```js
    'POST /commit-request/done': (b) => ({ done: session.resolveCommitRequests({ ids: b.id ? [String(b.id)] : null }) }),
```

`src/mcp.js`: remove `quilt_commit`; change `describeCommits`'s last line to `'When a commit is made, mark the requests done with quilt_commit_request_done.'`; change `quilt_request_commit`'s description to "Ask the people in the session for a commit, e.g. because your changes are ready or you need one to test or deploy. Someone commits with git on their machine and marks the request done."; add:

```js
  server.registerTool('quilt_commit_request_done', {
    description: 'Mark commit requests done after a commit was made with git (yours or someone\'s). Without an id, every open request is marked done.',
    inputSchema: { id: z.string().optional().describe('One request id; omit for all open ones') }
  }, ({ id }) => withDaemon(async (d) => {
    const { done } = await call(d, 'POST', '/commit-request/done', { id })
    return done ? `Marked ${done} commit request${done === 1 ? '' : 's'} done.` : 'No open commit requests.'
  }))
```

Also update the `instructions` string and any guide text (`grep -n "quilt_commit\b\|host commits\|hosts git" src/*.js src/ui/*.js`) so no text says the host commits through Quilt.

`src/ui-server.js`: remove the four git routes, `gitAction`, `gitDir`, `hostsGit`; keep the three `/api/github/*` routes and `cloneRepo`; add `'POST /api/sessions/:id/commit-request/done': (b, id) => { const done = get(id).resolveCommitRequests({ ids: b.id ? [String(b.id)] : null }); pushStatus(id); return { done } }`. Remove `host` from the session summary if it was derived from `hostsGit`.

`src/ui/session.js`: remove the `git.js` import and the six call sites (`gitMarkup()`, `bindGit`, `unbindGit`, `gitFilesChanged`, `renderGitButton`, `gitSessionChanged`). Where `gitMarkup()` was, put:

```html
      <span class="branch-label" id="branch-label" hidden></span>
```

and render it in `renderTop()`:

```js
  const g = st.git
  const label = $('#branch-label')
  label.hidden = !g
  if (g) {
    label.innerHTML = `${I.branch}<span>${esc(g.key)}</span>${g.hold ? `<span class="tag">${g.hold.kind === 'switching' ? `paused · you're on ${esc(g.hold.to || '?')}` : 'syncing paused: git is busy'}</span>` : ''}`
    label.title = g.hold ? (g.hold.kind === 'switching' ? `This session syncs ${g.key}. Sync resumes when you're back on it.` : 'Quilt waits for git to finish, then catches up.') : `This folder is on ${g.key}`
  }
```

The commit chip: clicking it now opens a small popover listing open requests (by, message) with a **Done** button each and **Mark all done**, posting to `/api/sessions/:id/commit-request/done`. Keep "Ask for a commit…". Replace the chip's old onclick (which opened the Git popover) accordingly.

`src/ui/app.css`: `.branch-label { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted); }` and reuse `.tag`; delete the `.git-*` rules that only `git.js` used (grep `git-` in app.css and confirm each selector has no other user).

Delete `src/ui/git.js`; confirm `src/ui-server.js`'s served-files allowlist no longer lists it (the served-modules test will catch a dangling import).

- [ ] **Step 4: Run the tests**

Run: `node --test test/git.test.js test/commits.test.js test/ui.test.js test/mcp.test.js`, then `npm test`. Expected: PASS. Then `grep -rn "git\b.*\(commit\|push\|pull\|stash\|checkout\)" src --include=*.js | grep -v gitstate.js | grep -v "cloneRepo\|clone" ` must show no git *commands* run by Quilt other than in `cloneRepo`.

- [ ] **Step 5: Commit**

```bash
git add -A src test
git commit -m "Quilt no longer runs git for people: commit requests stay a conversation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Release note and a hand check

**Files:**
- Modify: `RELEASES.md` (top unreleased section, or a new patch section if the top one is tagged), `README.md` if it mentions the Git button or host commits

- [ ] **Step 1: Notes**

Bullets (add to the top unreleased section; if the top section's version is tagged, add `## <next patch> — <today>` and bump `package.json`):

```markdown
- **Git on one machine no longer undoes the room's work.** A `git stash`, `reset --hard` or `checkout -- .` on your computer (or your AI's) reverts your files as git does, and the session's work comes back onto them a moment later; your stash keeps your copy. Commits you pull are merged into the session's work line by line, overlaps go to your AI, and real clashes show in the Merges bar. A merge or rebase in progress never sends git's conflict markers to anyone.
- **Switching branches pauses that folder.** Check out another branch and that folder stops syncing until you're back, with a note in the top bar, so two branches never mix. (One live document per branch is coming next.)
- **Quilt stays out of git.** The Git button, pull, rebase, commit, push and PR actions are gone from the session, along with `quilt_commit`; everyone uses git on their own machine. Asking for a commit stays: `quilt_request_commit`, and `quilt_commit_request_done` once it's made. Starting a session from a GitHub repo and branch is unchanged.
```

- [ ] **Step 2: Hand check**

From the worktree: `node bin/quilt.js ui` with two cloned folders of one repo (see `test/git-awareness.test.js`'s `pairRepos` for the setup). Try: stash in one folder while editing in the other; checkout a branch; pull a commit. Confirm the top-bar label, the paused tag, and the log lines. Stop the server.

- [ ] **Step 3: Full suite and commit**

```bash
npm test
git add RELEASES.md README.md package.json
git commit -m "Release notes: git awareness

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Follow-ups (phase 2 and 3, separate plans)

- Branch documents: protocol doc ids and `MSG_BRANCH`, relay per-branch storage and unload, `switchBranch` in the session, per-branch `.quilt/branches/<key>/` state, presence branch, hosted-agent `branch` argument, migration of old rooms, the people-menu branch rows.
- The `main`-vs-`master` warning, start-from-branch polish.
