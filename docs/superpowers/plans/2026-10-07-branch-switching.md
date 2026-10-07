# Branch Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A session holds every branch its members work on, each in its own relay document. Anyone (person, local agent or hosted agent) can move to any branch from the branch menu or `quilt_switch_branch`; the folder is cleared of the old branch's work (kept in the room and in `refs/quilt/parked/<branch>`) and loaded with the new branch's, never synced branch on branch.

**Architecture:** The relay keeps one room document (chat, tasks, agent feed, commit requests, activity) and one Yjs document per branch (files, blobs, fileKeys, merges, history, changes), stored in a new `BranchStore` (`src/branchdocs.js`). Sync messages carry a document id (`''` the room, else a branch key); a connection joins one branch at a time with `MSG_BRANCH`. The app keeps the room document in `this.doc` and the current branch document in `this.bdoc`; `Session.moveTo` runs flush → confirm with the relay → park → clear → `git switch` → join the new document → write it onto the folder. A terminal checkout takes the same path once HEAD has moved. The only git writes live in `src/gitswitch.js`.

**Tech Stack:** Node.js ESM, Yjs + y-protocols, `ws`, `node:test`, git CLI (2.26+ for `--pathspec-from-file`), vanilla ES-module UI.

**Spec:** `docs/superpowers/specs/2026-10-07-branch-switching-design.md` (built on `docs/superpowers/specs/2026-10-05-branch-documents-design.md`).

## Global Constraints

- Quilt never runs an AI to merge anything; merges stay `merge3` plus merge records for people.
- Git writes happen only for a switch a member asked for (or one they made in git): `git switch`, a `git fetch` of that one branch, `update-ref refs/quilt/parked/<branch>`, and putting the session's paths back to HEAD. Never commit on a branch, pull, push or merge.
- The protocol changes: the relay refuses apps without the `branches` feature with the existing NEEDS_UPDATE message (`CLOSE_NEEDS_UPDATE` / HTTP 400), and the app sends `FEATURES` from `src/protocol.js`.
- Every log line and error is plain English ("You're on feature-x now; the session's work there is on disk").
- Every user-visible change gets a bullet under the top section of `RELEASES.md`.
- Every new UI module is listed in `STATIC` in `src/ui-server.js` (the allowlist test enforces it).
- `npm test` passes except the two tests AGENTS.md says already fail on main; note the count.
- Work in `/Users/danielcarmichael/elegy/.claude/worktrees/branches`; never edit `/Users/danielcarmichael/elegy` directly.
- Ship order: deploy the relay before `npm run release` (a new app on an old relay would send framed sync messages it can't read).

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/gitswitch.js` | create | The switch's git commands: `park`, `clear`, `switchTo`, `startBranch`, `localBranches`, `parkedRef`, `busyRefusal`. Nothing else in Quilt writes to git. |
| `src/git.js` | modify (`:33`) | Export `shortError` for gitswitch. |
| `src/protocol.js` | modify | `MSG_BRANCH`, `MSG_BRANCHES`, `ROOM_DOC`, `FEATURES`, document-id framing in `syncStep1Message`/`updateMessage`, `syncHeader`. |
| `src/branchdocs.js` | create | Relay-side branch documents: `validBranchKey`, `branchFileName`, `covers`, `splitLegacyDoc`, `BranchStore` (load, save, unload after idle, rename, remove). Shared constants `DEFAULT_KEY`, `ROOM_TYPES`. |
| `src/server.js` | modify | `Room` uses the store: per-document sync, `MSG_BRANCH` (join, confirm, remove), branch list, per-branch guard and claims, migration of old rooms, active branch, hosted agents' branch. Upgrade refuses apps without `branches`. |
| `src/connection.js` | modify | Frames sync by document id; syncs the room document plus one branch document; `joinBranch`, `confirmBranch`, `branchRequest`, `waitForBranchSync`. |
| `src/session.js` | modify | Two documents (`doc`, `bdoc`), per-branch local state, `switchBranch`, `moveTo`, `followHead`, `arrive`, presence `branch`, `status().branch/branches`, activity `switched`. Phase 1's pause on another branch goes. |
| `src/chat-links.js` | modify | Chat links read and add files on the session's active branch. |
| `src/relay-mcp.js` | modify | File tools, claims and history on a branch document; hosted agents' own branch and `quilt_switch_branch`; `quilt_status` lists branches. |
| `src/status.js` | modify | `## Branches` in the Markdown status; `switched` activity lines. |
| `src/control.js` | modify | `POST /branch`, `POST /branch/remove`. |
| `src/mcp.js` | modify | Local `quilt_switch_branch`; guide line. |
| `src/ui-server.js` | modify | `POST /api/sessions/:id/branch`, `.../branch/remove`; `/branches.js` in `STATIC`. |
| `src/ui/branches.js` | create | The branch menu: button, popover, switch, New branch…, Remove from session. |
| `src/ui/session.js` | modify | Mounts the branch menu in place of `#branch-label`; redraws the tree after a switch. |
| `src/ui/app.css` | modify | Branch button and menu styles. |
| `RELEASES.md` | modify | Release notes. |
| `test/gitswitch.test.js` | create | Git commands against real temp repos. |
| `test/protocol-docs.test.js` | create | Framing, room sync, old apps told to update. |
| `test/relay-branches.test.js` | create | Relay branch documents end to end through `Connection`. |
| `test/branch-docs-session.test.js` | create | Sessions with two documents, local state, a folder from before branch documents. |
| `test/branch-switch.test.js` | create | The spec's switching tests with a real relay and real git. |
| `test/branch-hosted.test.js` | create | Hosted agents on a branch. |
| `test/git-awareness.test.js`, `test/blobstore.test.js`, raw-socket relay tests | modify | Phase 1 pause tests rewritten; raw upgrades send `branches`. |

---

## Task 1: The switch's git commands (`src/gitswitch.js`)

**Files:**
- Create: `src/gitswitch.js`
- Modify: `src/git.js:33` (export `shortError`)
- Test: `test/gitswitch.test.js`

**Interfaces:**
- Consumes: `checkBranchName(name)` and `shortError(text)` from `src/git.js`.
- Produces:
  - `parkedRef(key: string) → string` (`refs/quilt/parked/<key>`)
  - `busyRefusal(kind: string) → string`
  - `park(root, key) → Promise<string|null>` (sha of the parked commit, null when the tree is clean or git failed)
  - `clear(root, paths: string[]) → Promise<{ restored, removed }>` (throws with git's message)
  - `switchTo(root, branch, { base? }) → Promise<{ how: 'local'|'remote'|'created', from?: string|null }>` (throws with git's message)
  - `startBranch(root, name) → Promise<string>` (throws; name checked)
  - `localBranches(root) → Promise<string[]>`

- [ ] **Step 1: Write the failing test**

Create `test/gitswitch.test.js`:

```js
// The switch's git commands, against real repositories: park keeps the work in
// refs/quilt/parked/<branch> (index, tree and stash untouched), clear puts paths
// back to HEAD, switchTo finds a branch locally or on the remote, or starts it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { park, parkedRef, clear, switchTo, startBranch, localBranches, busyRefusal } from '../src/gitswitch.js'

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-gs-${n}-`))
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV }).trim()
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }

/** A bare remote with main (app.js, README.md) and `pushed` (adds pushed.txt), and a clone of it on main. */
function repo () {
  const bare = tmp('bare'); git(bare, 'init', '-q', '--bare', '-b', 'main')
  const seed = tmp('seed'); git(seed, 'clone', '-q', bare, '.')
  write(seed, 'app.js', 'one\n'); write(seed, 'README.md', 'hello\n')
  git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'one'); git(seed, 'push', '-q', 'origin', 'main')
  git(seed, 'checkout', '-qb', 'pushed'); write(seed, 'pushed.txt', 'p\n')
  git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'p'); git(seed, 'push', '-q', 'origin', 'pushed')
  const dir = tmp('clone'); git(dir, 'clone', '-q', bare, '.')
  return { bare, dir, base: git(dir, 'rev-parse', 'HEAD') }
}

test('park keeps tracked and untracked work in a ref, leaving the index, the tree and the stash alone', async () => {
  const { dir } = repo()
  write(dir, 'app.js', 'changed\n'); write(dir, 'new.txt', 'untracked\n'); git(dir, 'add', 'app.js')
  const status = git(dir, 'status', '--porcelain')
  const sha = await park(dir, 'main')
  assert.match(sha, /^[0-9a-f]{40}$/)
  assert.equal(git(dir, 'rev-parse', parkedRef('main')), sha)
  assert.equal(git(dir, 'show', `${sha}:app.js`), 'changed')
  assert.equal(git(dir, 'show', `${sha}:new.txt`), 'untracked')
  assert.equal(git(dir, 'rev-parse', `${sha}^`), git(dir, 'rev-parse', 'HEAD'))
  assert.equal(git(dir, 'status', '--porcelain'), status, 'the index and the tree are as they were')
  assert.equal(git(dir, 'stash', 'list'), '')
  write(dir, 'app.js', 'again\n')
  const next = await park(dir, 'main')
  assert.equal(git(dir, 'rev-parse', parkedRef('main')), next, 'replaced on the next park of the same branch')
})

test('park on a clean tree keeps nothing', async () => {
  const { dir } = repo()
  assert.equal(await park(dir, 'main'), null)
  assert.throws(() => git(dir, 'rev-parse', '--verify', '-q', parkedRef('main')))
})

test('clear puts paths back to HEAD: changes restored, files HEAD has not got removed', async () => {
  const { dir } = repo()
  write(dir, 'app.js', 'changed\n'); write(dir, 'new.txt', 'n\n'); write(dir, 'sub/staged.txt', 's\n'); git(dir, 'add', 'sub/staged.txt')
  write(dir, 'other.txt', 'not the session\'s\n')
  fs.rmSync(path.join(dir, 'README.md'))
  const r = await clear(dir, ['app.js', 'new.txt', 'sub/staged.txt', 'README.md'])
  assert.deepEqual(r, { restored: 2, removed: 2 })
  assert.equal(read(dir, 'app.js'), 'one\n')
  assert.equal(read(dir, 'README.md'), 'hello\n')
  assert.equal(read(dir, 'new.txt'), null)
  assert.equal(read(dir, 'sub/staged.txt'), null)
  assert.equal(fs.existsSync(path.join(dir, 'sub')), false, 'a folder left empty goes too')
  assert.equal(read(dir, 'other.txt'), 'not the session\'s\n', 'paths it was not given stay')
  assert.equal(git(dir, 'status', '--porcelain'), '?? other.txt')
})

test('switchTo: a local branch, then one only the remote has (fetched and tracked)', async () => {
  const { dir } = repo()
  git(dir, 'branch', 'local-one')
  assert.deepEqual(await switchTo(dir, 'local-one'), { how: 'local' })
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'local-one')
  git(dir, 'checkout', '-q', 'main')
  git(dir, 'branch', '-rd', 'origin/pushed') // as if never fetched
  assert.deepEqual(await switchTo(dir, 'pushed'), { how: 'remote' })
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/pushed')
  assert.equal(read(dir, 'pushed.txt'), 'p\n')
})

test('switchTo: a branch nowhere in git starts from base when this repo has it, else from HEAD', async () => {
  const { dir, base } = repo()
  write(dir, 'later.txt', 'l\n'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'later')
  assert.deepEqual(await switchTo(dir, 'spike', { base }), { how: 'created', from: base })
  assert.equal(git(dir, 'rev-parse', 'HEAD'), base)
  git(dir, 'checkout', '-q', 'main')
  const head = git(dir, 'rev-parse', 'HEAD')
  assert.deepEqual(await switchTo(dir, 'spike2', { base: 'f'.repeat(40) }), { how: 'created', from: null })
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head)
})

test('switchTo says what git said when it refuses; startBranch carries the work; the repo\'s branches are listed', async () => {
  const { dir } = repo()
  const other = tmp('wt'); git(dir, 'worktree', 'add', '-q', other, '-b', 'taken')
  await assert.rejects(switchTo(dir, 'taken'), /taken/)
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
  write(dir, 'app.js', 'wip\n')
  assert.equal(await startBranch(dir, 'try-it'), 'try-it')
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'try-it')
  assert.equal(read(dir, 'app.js'), 'wip\n')
  await assert.rejects(startBranch(dir, 'bad..name'), /isn't a valid branch name/)
  assert.deepEqual((await localBranches(dir)).sort(), ['main', 'taken', 'try-it'])
  assert.equal(busyRefusal('merge'), 'Finish the git merge first')
  assert.equal(busyRefusal('index-lock'), 'git is busy in this folder; try again when it finishes')
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/gitswitch.test.js`
Expected: FAIL with `Cannot find module '.../src/gitswitch.js'`.

- [ ] **Step 3: Export `shortError` from `src/git.js`**

In `src/git.js`, change line 33:

```js
function shortError (text) {
```

to:

```js
export function shortError (text) {
```

- [ ] **Step 4: Write `src/gitswitch.js`**

```js
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
 * keep (the tree is HEAD's) or git failed.
 */
export async function park (root, key) {
  const index = path.join(os.tmpdir(), `quilt-park-${crypto.randomBytes(6).toString('hex')}`)
  const env = { GIT_INDEX_FILE: index }
  try {
    const head = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])).out.trim() || null
    if (head && !(await git(root, ['read-tree', 'HEAD'], { env })).ok) return null
    if (!(await git(root, ['add', '-A', '--', '.'], { env })).ok) return null
    const tree = (await git(root, ['write-tree'], { env })).out.trim()
    if (!tree) return null
    if (head && tree === (await git(root, ['rev-parse', 'HEAD^{tree}'])).out.trim()) return null
    const made = await git(root, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', `Quilt: uncommitted work on ${key}`], { env: PARK_ID })
    const sha = made.ok ? made.out.trim() : ''
    if (!sha) return null
    return (await git(root, ['update-ref', '-m', `quilt: parked ${key}`, parkedRef(key), sha])).ok ? sha : null
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
```

- [ ] **Step 5: Run the test and see it pass**

Run: `node --test test/gitswitch.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/gitswitch.js src/git.js test/gitswitch.test.js
git commit -m "Branch switching: gitswitch.js, the switch's only git writes (park, clear, switch)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: Sync messages name their document; old apps are told to update

**Files:**
- Modify: `src/protocol.js` (constants after `MSG_PASS` at `:16`; `syncStep1Message`/`updateMessage` at `:44-56`)
- Modify: `src/connection.js` (imports `:6-13`; constructor `:52-59`; `_onUpdate` `:84`; `startSync` `:337`; `handle` MSG_SYNC branch `:348-358`)
- Modify: `src/server.js` (imports `:27-33`; `Room.handle` MSG_SYNC `:1246-1260`; upgrade `:1747-1767`)
- Modify: `test/blobstore.test.js:117,160,179`, `test/relay-admit-by.test.js:29`, `test/relay-grants.test.js:65`, `test/relay-owner-access.test.js:32`, `test/relay-passes.test.js:41`, `test/relay-presence.test.js:50`, `test/relay.test.js:450,508`
- Test: `test/protocol-docs.test.js`

**Interfaces:**
- Produces (protocol.js): `MSG_BRANCH = 17`, `MSG_BRANCHES = 18`, `ROOM_DOC = ''`, `FEATURES = 'large-files,branches'`, `syncStep1Message(doc, docId = ROOM_DOC)`, `updateMessage(update, docId = ROOM_DOC)`, `syncHeader(docId) → Encoder` (MSG_SYNC and the id written).
- Wire format: `MSG_SYNC, varString docId, <y-protocols sync message>`. `''` is the room document (git never allows an empty branch name).

- [ ] **Step 1: Write the failing test**

Create `test/protocol-docs.test.js`:

```js
// Every sync message names the document it is for ('' the room's, else a
// branch key), and the relay turns away apps that don't know branch documents.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { startServer } from '../src/server.js'
import { Connection } from '../src/connection.js'
import { generateIdentity } from '../src/identity.js'
import { MSG_SYNC, ROOM_DOC, FEATURES, decoding, syncStep1Message, updateMessage } from '../src/protocol.js'

async function waitFor (fn, ms = 5000) {
  const t = Date.now()
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}

test('sync messages carry the document they are for', () => {
  const doc = new Y.Doc()
  doc.getText('t').insert(0, 'x')
  const cases = [[syncStep1Message(doc), ROOM_DOC], [syncStep1Message(doc, 'feature/x'), 'feature/x'], [updateMessage(Y.encodeStateAsUpdate(doc), 'main'), 'main']]
  for (const [msg, id] of cases) {
    const dec = decoding.createDecoder(msg)
    assert.equal(decoding.readVarUint(dec), MSG_SYNC)
    assert.equal(decoding.readVarString(dec), id)
  }
  assert.ok(FEATURES.split(',').includes('branches'))
})

test('the room document syncs between two apps', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {} })
  t.after(() => srv.close())
  const url = `ws://127.0.0.1:${srv.port}`
  const a = new Y.Doc()
  const b = new Y.Doc()
  const ca = new Connection({ server: url, room: 'pd1', secret: 's', name: 'a', identity: generateIdentity(), doc: a })
  const cb = new Connection({ server: url, room: 'pd1', secret: 's', name: 'b', identity: generateIdentity(), doc: b })
  t.after(() => { ca.close(); cb.close() })
  await ca.waitForSync()
  await cb.waitForSync()
  a.getArray('chat').push([{ text: 'hi' }])
  await waitFor(() => b.getArray('chat').length === 1)
})

test('an app that does not know branch documents is told to update, before the room is touched', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {} })
  t.after(() => srv.close())
  const c = new Connection({ server: `ws://127.0.0.1:${srv.port}`, room: 'pd2', secret: 's', name: 'old', identity: generateIdentity(), doc: new Y.Doc(), features: 'large-files' })
  const err = await new Promise((resolve) => c.once('fatal', resolve))
  assert.match(err.message, /needs a newer version of Quilt/)
  assert.equal(srv.rooms.has('pd2'), false)
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/protocol-docs.test.js`
Expected: FAIL: `ROOM_DOC`/`FEATURES` are not exported (`SyntaxError: The requested module '../src/protocol.js' does not provide an export named 'ROOM_DOC'`).

- [ ] **Step 3: Frame sync messages in `src/protocol.js`**

After `export const MSG_PASS = 16 ...` add:

```js
export const MSG_BRANCH = 17 // client -> relay: JSON { id, op: 'join'|'confirm'|'remove', branch, base?, adopt?, sv? }
export const MSG_BRANCHES = 18 // relay -> client: JSON { branches, reply?: { id, op, ok, error?, branch?, created?, base? } }

// Every sync message names its document: the room's (chat, tasks, the feed, commit requests,
// activity) is '', a branch's (its files) is the branch key. Git never allows an empty branch name.
export const ROOM_DOC = ''

// What this app can do, sent when it connects. The relay turns away apps without what a session needs.
export const FEATURES = 'large-files,branches'
```

Replace `syncStep1Message` and `updateMessage` with:

```js
/** An encoder with a sync message's header written: the type and the document it is for. */
export function syncHeader (docId = ROOM_DOC) {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, MSG_SYNC)
  encoding.writeVarString(enc, docId)
  return enc
}

export function syncStep1Message (doc, docId = ROOM_DOC) {
  const enc = syncHeader(docId)
  syncProtocol.writeSyncStep1(enc, doc)
  return encoding.toUint8Array(enc)
}

export function updateMessage (update, docId = ROOM_DOC) {
  const enc = syncHeader(docId)
  syncProtocol.writeUpdate(enc, update)
  return encoding.toUint8Array(enc)
}
```

- [ ] **Step 4: The app reads and writes framed sync (`src/connection.js`)**

Add `ROOM_DOC, FEATURES, syncHeader` to the import from `./protocol.js`. In the constructor signature change `features = 'large-files'` to `features = FEATURES`. In `handle`, replace the `MSG_SYNC` branch with:

```js
    if (type === MSG_SYNC) {
      const docId = decoding.readVarString(dec)
      if (docId !== ROOM_DOC) return // branch documents: see joinBranch (task 3)
      // Give the owner a chance to capture unsaved local edits so remote
      // changes merge with them instead of overwriting them.
      this.beforeRemote()
      const enc = syncHeader(docId)
      const header = encoding.length(enc)
      const msgType = syncProtocol.readSyncMessage(dec, enc, this.doc, REMOTE)
      if (encoding.length(enc) > header) this.send(encoding.toUint8Array(enc))
      if (msgType === syncProtocol.messageYjsSyncStep2 && !this.synced) {
        this.synced = true
        this.emit('synced')
      }
    } else if (type === MSG_AWARENESS) {
```

(`startSync` and `_onUpdate` keep calling `syncStep1Message(this.doc)` / `updateMessage(update)`: the default id is the room's.)

- [ ] **Step 5: The relay reads framed sync and refuses old apps (`src/server.js`)**

Add `ROOM_DOC` and `syncHeader` to the import from `./protocol.js`. In `Room.handle`, replace the `MSG_SYNC` branch with:

```js
    if (type === MSG_SYNC) {
      const docId = decoding.readVarString(dec)
      if (docId !== ROOM_DOC) return // branch documents arrive with MSG_BRANCH (task 3)
      if (this.full) {
        // Over quota: still answer "what do you have?" so people can read, but refuse new data.
        if (decoding.peekVarUint(dec) !== syncProtocol.messageYjsSyncStep1) {
          ws.close(CLOSE_ROOM_FULL, 'room is over the size limit')
          return
        }
      }
      const enc = syncHeader(docId)
      const header = encoding.length(enc)
      syncProtocol.readSyncMessage(dec, enc, this.doc, ws)
      if (encoding.length(enc) > header) send(ws, encoding.toUint8Array(enc))
    } else if (type === MSG_AWARENESS) {
```

In the upgrade handler, right after `if (!person || person.length > MAX_NAME || !key) return reject(socket, 400, 'Bad name or identity key')` add:

```js
    // Every session keeps its files in branch documents: an app that can't sync them is told to update.
    const features = String(url.searchParams.get('features') || '').split(',')
    if (!features.includes('branches')) return reject(socket, 400, NEEDS_UPDATE)
```

and delete the later line `const features = String(url.searchParams.get('features') || '').split(',')` (after `if (!room) return reject(socket, ...refused(name))`).

- [ ] **Step 6: Raw-socket tests speak the new protocol**

```bash
sed -i '' "s/features: 'large-files'/features: 'large-files,branches'/" test/relay-admit-by.test.js test/relay-grants.test.js test/relay-owner-access.test.js test/relay-passes.test.js test/relay-presence.test.js test/relay.test.js
sed -i '' 's/features=large-files`/features=large-files,branches`/' test/relay.test.js
sed -i '' "s/features: '' })/features: 'branches' })/" test/blobstore.test.js
grep -n "features" test/blobstore.test.js test/relay*.test.js
```

Expected grep output: every `features` value includes `branches`; the three in `test/blobstore.test.js` are exactly `'branches'` (they still test an app without large-file support).

- [ ] **Step 7: Run the new test and the suite**

Run: `node --test test/protocol-docs.test.js`
Expected: PASS, 3 tests.
Run: `npm test 2>&1 | tail -5`
Expected: only the two failures AGENTS.md lists.

- [ ] **Step 8: Commit**

```bash
git add src/protocol.js src/connection.js src/server.js test/protocol-docs.test.js test/blobstore.test.js test/relay*.test.js
git commit -m "Protocol: sync messages name their document; apps without branch documents are told to update" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3: Branch documents on the relay, and joining one

**Files:**
- Create: `src/branchdocs.js`
- Modify: `src/server.js` (imports; `relayConfig` `:73-103`; `Room` constructor after `this.meta.claims = ...` `:141`; `this.full = ...` `:176`; new methods after `forget` `:598`; `join` `:1211`; `leave` `:1221`; `handle` `:1243`; `destroy` `:1297`; `onEnd` in `startServer` `:1433-1439`; `removeRoomData` `:1475`)
- Modify: `src/connection.js` (imports, constructor, `startSync`, `handle`, `request`, new methods, `close` handler, `close()`)
- Test: `test/relay-branches.test.js`

**Interfaces:**
- Produces (branchdocs.js): `DEFAULT_KEY = '∅'`, `MAX_BRANCH_KEY = 200`, `BRANCH_IDLE_MS = 600000`, `BRANCH_TTL_MS = 30 days`, `ROOM_TYPES`, `validBranchKey(key) → boolean`, `branchFileName(key) → string`, `covers(have: Uint8Array, want: Uint8Array) → boolean`, `splitLegacyDoc(legacy: Y.Doc) → Y.Doc` (used in task 4), `class BranchStore` with `file(key)`, `stored(key)`, `get(key)`, `size(key)`, `load(key)`, `subscribe(ws, key)`, `unsubscribe(ws, key)`, `touch(entry)`, `unload(key)`, `drop(entry)`, `scheduleSave(entry)`, `save(entry) → boolean`, `write(key, state) → boolean`, `rename(from, to)`, `remove(key)`, `destroy()`, `discard()`. Entry: `{ key, doc, files, blobs, fileKeys, conns: Set<ws>, bytes, saveTimer, unloadTimer }`.
- Produces (Room): `store`, `defaultKey` (getter), `resolveKey(key)`, `totalBytes()`, `noteBranch(key, { by, base }) → boolean`, `branchDoc(key, { by, base }) → entry`, `wireBranch(entry)`, `noteBranchSaved(entry)`, `branchList() → [{ key, by, at, base, default }]`, `broadcastBranches()`, `branchRequest(ws, req)`. On a connection: `ws.branch` (the document key), `ws.branchAs` (the key as the app named it; its sync messages carry it).
- Produces (Connection): constructor option `branch: { key, doc, adopt?, base? }`; fields `branchKey`, `branchDoc`, `roomSynced`, `branchSynced`; `setBranch(key, doc)`, `joinBranch(key, doc, extra) → Promise<{ branch, created, base }>`, `confirmBranch() → Promise`, `branchRequest(req) → Promise`, `waitForBranchSync() → Promise`; events `branches` (list), `branch-joined` (reply), `branch-refused` (message), `branch-synced`. `synced`/`waitForSync()` now mean the room document and the joined branch's are both synced. `request(type, req, what, onId?)` takes an optional id callback.
- Relay storage: `<dataDir>/branches/<room>/<base64url(key)>.ydoc`; room meta `branches: { key: { by, at, base, seen, stored? } }`, `defaultBranch`.

- [ ] **Step 1: Write the failing test**

Create `test/relay-branches.test.js`:

```js
// Branch documents on the relay: a connection syncs the room's document and
// the one branch it joined; branches are kept apart, saved and reloaded, and a
// key that isn't a branch name is refused.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { startServer } from '../src/server.js'
import { Connection, REMOTE } from '../src/connection.js'
import { generateIdentity } from '../src/identity.js'
import { validBranchKey, branchFileName, covers } from '../src/branchdocs.js'

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-rb-${n}-`))
const quiet = () => {}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor (fn, ms = 5000) {
  const t = Date.now()
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await wait(25) }
  throw new Error('timed out')
}
// Sessions without an identity create one in ~/.quilt; keep that out of the real home.
process.env.HOME = process.env.USERPROFILE = tmp('home')

/** An app on `key` (no branch when null): its room document, its branch document and its connection. */
function open (t, srv, room, name, key, extra = {}) {
  const doc = new Y.Doc()
  const bdoc = new Y.Doc()
  const c = new Connection({
    server: `ws://127.0.0.1:${srv.port}`, room, secret: 's', name, identity: extra.identity || generateIdentity(), doc,
    ...(key ? { branch: { key, doc: bdoc, ...(extra.adopt ? { adopt: extra.adopt } : {}) } } : {}),
    ...(extra.conn || {})
  })
  t.after(() => { if (!c.closed) c.close() })
  return { c, doc, bdoc }
}
const text = (doc, rel) => doc.getMap('files').get(rel)?.toString()
const put = (doc, rel, s) => doc.transact(() => { const y = new Y.Text(); y.insert(0, s); doc.getMap('files').set(rel, y) })

test('branch keys are git branch names, a detached commit or ∅, and their files are safe names', () => {
  for (const ok of ['main', 'feature/x', 'fix-1.2', '∅', '@0123456789ab', 'ünïcode']) assert.equal(validBranchKey(ok), true, ok)
  for (const bad of ['', '-x', 'a b', 'a:b', 'a/', '/a', '.a', 'a/.b', 'a.lock', 'a..b', 'a//b', 'HEAD', '@', 'a@{1}', 'a.', 'x'.repeat(201), 'tab\there']) assert.equal(validBranchKey(bad), false, bad)
  assert.equal(branchFileName('feature/x'), `${Buffer.from('feature/x').toString('base64url')}.ydoc`)
  const a = new Y.Doc(); a.getText('t').insert(0, 'x')
  const b = new Y.Doc(); Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  assert.equal(covers(Y.encodeStateVector(b), Y.encodeStateVector(a)), true)
  a.getText('t').insert(0, 'y')
  assert.equal(covers(Y.encodeStateVector(b), Y.encodeStateVector(a)), false)
})

test('two apps on one branch share its files; an app on another branch never sees them; the room document is shared by all', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  t.after(() => srv.close())
  const a = open(t, srv, 'rb1', 'a', 'main')
  const b = open(t, srv, 'rb1', 'b', 'main')
  const f = open(t, srv, 'rb1', 'f', 'feature-x')
  await Promise.all([a.c.waitForSync(), b.c.waitForSync(), f.c.waitForSync()])
  put(a.bdoc, 'app.js', 'main\n')
  put(f.bdoc, 'app.js', 'feature\n')
  await waitFor(() => text(b.bdoc, 'app.js') === 'main\n')
  await wait(300)
  assert.equal(text(f.bdoc, 'app.js'), 'feature\n')
  assert.equal(text(a.bdoc, 'app.js'), 'main\n')
  const room = srv.rooms.get('rb1')
  assert.equal(room.doc.getMap('files').size, 0, 'files are not in the room document')
  a.doc.getArray('chat').push([{ text: 'hi' }])
  await waitFor(() => f.doc.getArray('chat').length === 1)
  assert.deepEqual(room.branchList().map((x) => x.key).sort(), ['feature-x', 'main'])
  assert.equal(room.defaultKey, 'main', 'the first branch anyone joined')
  let heard = null
  b.c.on('branches', (list) => { heard = list })
  open(t, srv, 'rb1', 'g', 'third')
  await waitFor(() => heard && heard.some((x) => x.key === 'third'))
})

test('joining another branch leaves the first: one branch at a time', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  t.after(() => srv.close())
  const a = open(t, srv, 'rb2', 'a', 'main')
  const b = open(t, srv, 'rb2', 'b', 'main')
  await Promise.all([a.c.waitForSync(), b.c.waitForSync()])
  const other = new Y.Doc()
  const r = await a.c.joinBranch('feature-x', other)
  assert.equal(r.branch, 'feature-x')
  assert.equal(r.created, true)
  await a.c.waitForBranchSync()
  assert.equal(a.c.branchKey, 'feature-x')
  put(b.bdoc, 'x.txt', 'main only\n')
  await wait(300)
  assert.equal(text(other, 'x.txt'), undefined)
  assert.equal(text(a.bdoc, 'x.txt'), undefined, 'the branch it left gets nothing more')
  put(other, 'y.txt', 'feature\n')
  await waitFor(() => text(srv.rooms.get('rb2').store.get('feature-x').doc, 'y.txt') === 'feature\n')
})

test('confirm says whether the relay holds every change the app has on its branch', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  t.after(() => srv.close())
  const a = open(t, srv, 'rb3', 'a', 'main')
  await a.c.waitForSync()
  put(a.bdoc, 'a.txt', 'x\n')
  await a.c.confirmBranch()
  // A change the connection never sent (applied as if it came from the relay).
  const elsewhere = new Y.Doc()
  put(elsewhere, 'b.txt', 'y\n')
  Y.applyUpdate(a.bdoc, Y.encodeStateAsUpdate(elsewhere), REMOTE)
  await assert.rejects(a.c.confirmBranch(), /not all of your changes on main have reached the relay yet/)
})

test('branch documents are saved and come back after the relay restarts', async (t) => {
  const dataDir = tmp('saved')
  let srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir })
  const a = open(t, srv, 'rb4', 'a', 'feature/x')
  await a.c.waitForSync()
  put(a.bdoc, 'saved.txt', 'kept\n')
  const file = path.join(dataDir, 'branches', 'rb4', branchFileName('feature/x'))
  await waitFor(() => fs.existsSync(file))
  a.c.close()
  await srv.close()
  srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir })
  t.after(() => srv.close())
  const b = open(t, srv, 'rb4', 'b', 'feature/x')
  await b.c.waitForSync()
  assert.equal(text(b.bdoc, 'saved.txt'), 'kept\n')
})

test('a key that is not a branch name is refused, and the app stays where it was', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  t.after(() => srv.close())
  const a = open(t, srv, 'rb5', 'a', 'main')
  await a.c.waitForSync()
  await assert.rejects(a.c.joinBranch('bad..name', new Y.Doc()), /isn't a branch name/)
  await assert.rejects(a.c.joinBranch('x'.repeat(201), new Y.Doc()), /isn't a branch name/)
  assert.equal(a.c.branchKey, 'main')
  const refused = open(t, srv, 'rb5', 'z', 'no good')
  assert.match(await new Promise((resolve) => refused.c.once('branch-refused', resolve)), /isn't a branch name/)
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/relay-branches.test.js`
Expected: FAIL with `Cannot find module '.../src/branchdocs.js'`.

- [ ] **Step 3: Write `src/branchdocs.js`**

```js
// The relay's branch documents: one Yjs document per branch a room's members
// work on, holding that branch's files (files, blobs, fileKeys) and what goes
// with them (merge records, the chronology, per-person tallies). The room's own
// document keeps everything room-wide. A branch document is loaded when someone
// joins it (or a hosted agent uses it), saved a second after each change, and
// unloaded once nobody has been on it for a while.
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'

// A folder without git syncs this key: the room's default branch (see Room.resolveKey).
export const DEFAULT_KEY = '∅'
export const MAX_BRANCH_KEY = 200
export const BRANCH_IDLE_MS = 10 * 60 * 1000
// A branch nobody has been on this long leaves the session (never the default branch).
export const BRANCH_TTL_MS = 30 * 24 * 60 * 60 * 1000
// What a room's document keeps for everyone, whatever branch they're on. The rest is a branch's.
export const ROOM_TYPES = [['chat', 'array'], ['agentFeed', 'array'], ['activity', 'array'], ['commitRequests', 'map'], ['tasks', 'map']]

// eslint-disable-next-line no-control-regex
const NOT_IN_REFS = /[\u0000- \u007f~^:?*[\\]/

/**
 * Whether `key` may name a branch document: a git branch name (the rules of
 * `git check-ref-format --branch`, checked here since the relay has no git),
 * a detached commit (@ and 12 hex digits), or ∅.
 */
export function validBranchKey (key) {
  if (typeof key !== 'string' || !key || key.length > MAX_BRANCH_KEY) return false
  if (key === DEFAULT_KEY || /^@[0-9a-f]{12}$/.test(key)) return true
  if (key === 'HEAD' || key === '@' || key.startsWith('-') || NOT_IN_REFS.test(key)) return false
  if (key.includes('..') || key.includes('@{') || key.includes('//')) return false
  if (key.startsWith('/') || key.endsWith('/') || key.endsWith('.')) return false
  return key.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'))
}

/** A branch document's file name: the key in base64url (branch names have slashes, and ∅). */
export const branchFileName = (key) => `${Buffer.from(key, 'utf8').toString('base64url')}.ydoc`

/** Whether a document whose state vector is `have` holds everything one at `want` holds. */
export function covers (have, want) {
  const h = Y.decodeStateVector(have)
  for (const [client, clock] of Y.decodeStateVector(want)) if ((h.get(client) || 0) < clock) return false
  return true
}

/**
 * A room saved before branch documents kept everything in one document. Its
 * room-wide parts are copied into a new room document (returned) and emptied
 * in the old one, which stays as it is otherwise: it becomes the default
 * branch's document, so every app's saved copy of it still matches.
 */
export function splitLegacyDoc (legacy) {
  const room = new Y.Doc()
  room.transact(() => {
    for (const [name, kind] of ROOM_TYPES) {
      if (kind === 'array') room.getArray(name).push(legacy.getArray(name).toJSON())
      else for (const [k, v] of Object.entries(legacy.getMap(name).toJSON())) room.getMap(name).set(k, v)
    }
  })
  legacy.transact(() => {
    for (const [name, kind] of ROOM_TYPES) {
      if (kind === 'array') { const a = legacy.getArray(name); if (a.length) a.delete(0, a.length) } else {
        const m = legacy.getMap(name)
        for (const k of [...m.keys()]) m.delete(k)
      }
    }
  })
  return room
}

export class BranchStore {
  /**
   * @param {object} o
   * @param {string|null} o.dir  where this room's branch documents are saved (null: memory only)
   * @param {number} [o.idleMs]  a document nobody is on is unloaded this long after its last use
   * @param {(entry: object) => void} o.onLoad  wires a document just loaded (listeners, the guard)
   * @param {(entry: object) => void} [o.onSave]  after each save
   * @param {(err: Error) => void} [o.onDiskError]  a save failed
   */
  constructor ({ dir, idleMs = BRANCH_IDLE_MS, onLoad, onSave = () => {}, onDiskError = () => {} }) {
    this.dir = dir || null
    this.idleMs = idleMs
    this.onLoad = onLoad
    this.onSave = onSave
    this.onDiskError = onDiskError
    this.loaded = new Map() // key -> { key, doc, files, blobs, fileKeys, conns, bytes, saveTimer, unloadTimer }
    this.sizes = new Map() // key -> bytes on disk, for the room's size limit
  }

  file (key) { return this.dir ? path.join(this.dir, branchFileName(key)) : null }

  /** Whether branch `key` has a saved document. */
  stored (key) { return !!this.dir && fs.existsSync(this.file(key)) }

  /** The loaded entry for `key`, or null (never loads). */
  get (key) { return this.loaded.get(key) || null }

  /** Bytes branch `key` takes: its loaded size, or its file's. */
  size (key) {
    const e = this.loaded.get(key)
    if (e) return e.bytes
    if (!this.sizes.has(key)) {
      let n = 0
      try { n = fs.statSync(this.file(key)).size } catch {}
      this.sizes.set(key, n)
    }
    return this.sizes.get(key)
  }

  /** Branch `key`'s entry, its document loaded from disk (or new and empty). Throws { unreadable } when its file can't be read. */
  load (key) {
    let e = this.loaded.get(key)
    if (e) { this.touch(e); return e }
    const doc = new Y.Doc()
    let bytes = 0
    if (this.stored(key)) {
      try {
        const buf = fs.readFileSync(this.file(key))
        Y.applyUpdate(doc, buf)
        bytes = buf.length
      } catch (err) {
        doc.destroy()
        throw Object.assign(new Error(`could not read branch ${key}: ${err.message}`), { unreadable: true })
      }
    }
    e = { key, doc, files: doc.getMap('files'), blobs: doc.getMap('blobs'), fileKeys: doc.getMap('fileKeys'), conns: new Set(), bytes, saveTimer: null, unloadTimer: null }
    this.loaded.set(key, e)
    this.onLoad(e)
    this.touch(e)
    return e
  }

  subscribe (ws, key) {
    const e = this.load(key)
    e.conns.add(ws)
    this.touch(e)
    return e
  }

  unsubscribe (ws, key) {
    const e = this.loaded.get(key)
    if (!e) return
    e.conns.delete(ws)
    this.touch(e)
  }

  /** Used just now: a document nobody is on is unloaded idleMs from now (only one that can be saved). */
  touch (e) {
    clearTimeout(e.unloadTimer)
    e.unloadTimer = null
    if (e.conns.size || !this.dir) return
    e.unloadTimer = setTimeout(() => this.unload(e.key), this.idleMs)
    e.unloadTimer.unref?.()
  }

  unload (key) {
    const e = this.loaded.get(key)
    if (!e || e.conns.size) return
    if (this.save(e)) this.drop(e)
  }

  drop (e) {
    clearTimeout(e.saveTimer)
    clearTimeout(e.unloadTimer)
    if (e.guard) e.guard.destroy()
    e.doc.destroy()
    this.loaded.delete(e.key)
  }

  scheduleSave (e) {
    if (!this.dir || e.saveTimer) return
    e.saveTimer = setTimeout(() => this.save(e), 1000)
  }

  /** Saves a loaded document now; false when the disk refused (it then stays loaded). */
  save (e) {
    clearTimeout(e.saveTimer)
    e.saveTimer = null
    if (!this.dir) return true
    const state = Y.encodeStateAsUpdate(e.doc)
    if (!this.write(e.key, state)) return false
    e.bytes = state.length
    this.onSave(e)
    return true
  }

  /** Writes a branch document's state whole, then renames it: a crash leaves the old file, never a cut-off one. */
  write (key, state) {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const f = this.file(key)
      fs.writeFileSync(f + '.tmp', state)
      fs.renameSync(f + '.tmp', f)
      this.sizes.set(key, state.length)
      return true
    } catch (err) {
      this.onDiskError(err)
      return false
    }
  }

  /** Branch `from` is called `to` from now on (∅ taken by the session's first real branch). */
  rename (from, to) {
    const e = this.loaded.get(from)
    if (e) { this.loaded.delete(from); e.key = to; this.loaded.set(to, e) }
    if (this.stored(from)) {
      try { fs.renameSync(this.file(from), this.file(to)) } catch (err) { this.onDiskError(err) }
    }
    if (this.sizes.has(from)) { this.sizes.set(to, this.sizes.get(from)); this.sizes.delete(from) }
  }

  /** Deletes branch `key`'s document, loaded or not. */
  remove (key) {
    const e = this.loaded.get(key)
    if (e) this.drop(e)
    if (this.dir) fs.rmSync(this.file(key), { force: true })
    this.sizes.delete(key)
  }

  /** Saves and drops every loaded document (the room is leaving memory). */
  destroy () { for (const e of [...this.loaded.values()]) { this.save(e); this.drop(e) } }

  /** Drops every loaded document without saving (the room was ended and its data deleted). */
  discard () { for (const e of [...this.loaded.values()]) this.drop(e) }
}
```

- [ ] **Step 4: The relay keeps branch documents (`src/server.js`)**

Imports: add `MSG_BRANCH, MSG_BRANCHES` to the `./protocol.js` import, and

```js
import { BranchStore, DEFAULT_KEY, BRANCH_IDLE_MS, validBranchKey, covers } from './branchdocs.js'
```

In `relayConfig`, after `idleUnloadMs: num(opts.idleUnloadMs, 60 * 1000),` add:

```js
    // A branch document nobody is on leaves memory this long after its last use (the room may stay).
    branchIdleMs: num(opts.branchIdleMs, BRANCH_IDLE_MS),
```

In the `Room` constructor, after `this.meta.claims = this.meta.claims || {} ...` add:

```js
    // Each branch's files live in a document of their own (branchdocs.js); the session's
    // branches are key -> { by, at, base, seen, stored }, and the default is the first one joined.
    this.meta.branches = this.meta.branches || {}
    this.store = new BranchStore({
      dir: dataDir && path.join(dataDir, 'branches', name),
      idleMs: cfg.branchIdleMs,
      onLoad: (e) => this.wireBranch(e),
      onSave: (e) => this.noteBranchSaved(e),
      onDiskError: (err) => this.diskError(err)
    })
```

Change `this.full = this.bytes > cfg.maxRoomBytes` to `this.full = this.totalBytes() > cfg.maxRoomBytes`.

After `forget (item) { ... }` add the branch methods:

```js
  /** The room's default branch: the first one anyone joined (∅, a folder without git, until then). */
  get defaultKey () { return this.meta.defaultBranch || DEFAULT_KEY }

  /** The document a branch name stands for: ∅ is the default branch. */
  resolveKey (key) { return key === DEFAULT_KEY ? this.defaultKey : key }

  /** Bytes the room takes: its own document and every branch's. */
  totalBytes () {
    let n = this.bytes
    if (this.store) for (const key of Object.keys(this.meta.branches)) n += this.store.size(key)
    return n
  }

  /** Adds a branch to the session (once): who started it, when, and the commit it started from. True when new. */
  noteBranch (key, { by = '', base = null } = {}) {
    if (this.meta.branches[key]) return false
    this.meta.branches[key] = { by, at: Date.now(), base: typeof base === 'string' && /^[0-9a-f]{40,64}$/.test(base) ? base : null }
    if (!this.meta.defaultBranch) this.meta.defaultBranch = key
    this.saveMeta()
    return true
  }

  /** Branch `key`'s document, loaded, and added to the session when new (hosted agents and chat links use this). */
  branchDoc (key, { by = '', base = null } = {}) {
    const k = this.resolveKey(key)
    if (this.noteBranch(k, { by, base })) this.broadcastBranches()
    return this.store.load(k)
  }

  /** A branch document just loaded: its changes go to the connections on that branch, and are saved. */
  wireBranch (e) {
    e.doc.on('update', (update, origin) => {
      if (origin && this.conns.has(origin)) this.noteActivity(this.holderKeys(origin))
      for (const ws of e.conns) if (ws !== origin) send(ws, updateMessage(update, ws.branchAs))
      e.bytes += update.length
      if (!this.full && this.totalBytes() > this.cfg.maxRoomBytes) {
        this.full = true
        this.log(`[${this.name}] over the size limit; further edits are refused`)
      }
      this.store.scheduleSave(e)
    })
  }

  /** A branch document was saved: the stored files it points at are remembered for when it is unloaded (storedIds). */
  noteBranchSaved (e) {
    const b = this.meta.branches[e.key]
    if (!b) return
    const ids = [...e.blobs.values()].filter((x) => x && x.stored && x.stored.id).map((x) => x.stored.id).sort()
    if (String(ids) === String(b.stored || [])) return
    b.stored = ids
    this.saveMeta()
  }

  /** The session's branches, for everyone's branch menu. */
  branchList () {
    return Object.entries(this.meta.branches).map(([key, b]) => ({ key, by: b.by || '', at: b.at || 0, base: b.base || null, default: key === this.defaultKey }))
  }

  broadcastBranches () {
    const msg = jsonMessage(MSG_BRANCHES, { branches: this.branchList() })
    for (const ws of this.conns.keys()) send(ws, msg)
  }

  /**
   * A connection's branch request; returns the reply fields. join: subscribe to a branch's
   * document (one at a time), adding the branch to the session when new. confirm: the relay
   * holds everything the app has of the branch it joined, up to the app's state vector (an
   * app asks before it clears its folder for a switch).
   */
  branchRequest (ws, req) {
    const key = String(req.branch ?? '')
    if (!validBranchKey(key)) throw new Error(`"${key.slice(0, 60)}" isn't a branch name`)
    if (req.op === 'join') {
      const k = this.resolveKey(key)
      const created = !this.meta.branches[k]
      if (created && this.full) throw new Error("This session is over its size limit, so it can't take another branch.")
      try { this.store.load(k) } catch (err) {
        if (!err.unreadable) throw err
        this.log(`[${this.name}] ${err.message}`)
        throw new Error("This branch's data can't be read on the relay right now")
      }
      if (ws.branch && ws.branch !== k) this.store.unsubscribe(ws, ws.branch)
      this.store.subscribe(ws, k)
      ws.branch = k // the document, as the relay keeps it
      ws.branchAs = key // as the app named it (∅ without git): its sync messages carry this
      this.noteBranch(k, { by: this.names.get(ws) || '', base: req.base })
      this.meta.branches[k].seen = Date.now()
      return { ok: true, branch: k, created, base: this.meta.branches[k].base, listChanged: created }
    }
    if (req.op === 'confirm') {
      const k = this.resolveKey(key)
      const e = k === ws.branch ? this.store.get(k) : null
      if (!e) throw new Error(`you are not on ${key}`)
      let want
      try {
        want = new Uint8Array(Buffer.from(String(req.sv || ''), 'base64'))
        Y.decodeStateVector(want)
      } catch { throw new Error('that is not a state vector') }
      if (!covers(Y.encodeStateVector(e.doc), want)) throw new Error(`not all of your changes on ${key} have reached the relay yet`)
      return { ok: true, branch: k }
    }
    throw new Error('unknown branch request')
  }
```

In `join (ws, name)`, after `send(ws, syncStep1Message(this.doc))` add:

```js
    send(ws, jsonMessage(MSG_BRANCHES, { branches: this.branchList() }))
```

and change `send(ws, jsonMessage(MSG_CLAIMS, { claims: this.claimList() }))` to `send(ws, jsonMessage(MSG_CLAIMS, { claims: this.claimList(ws.branch) }))` (the argument is used from task 4 on).

In `leave (ws)`, after `const ids = this.conns.get(ws)` add:

```js
    if (ws.branch) this.store.unsubscribe(ws, ws.branch)
```

In `handle`, replace the `MSG_SYNC` branch from task 2 with:

```js
    if (type === MSG_SYNC) {
      const docId = decoding.readVarString(dec)
      let doc = this.doc
      if (docId !== ROOM_DOC) {
        // A connection syncs the room's document and the one branch it joined, nothing else.
        const e = ws.branch && this.resolveKey(docId) === ws.branch ? this.store.get(ws.branch) : null
        if (!e) return
        doc = e.doc
      }
      if (this.full) {
        // Over quota: still answer "what do you have?" so people can read, but refuse new data.
        if (decoding.peekVarUint(dec) !== syncProtocol.messageYjsSyncStep1) {
          ws.close(CLOSE_ROOM_FULL, 'room is over the size limit')
          return
        }
      }
      const enc = syncHeader(docId)
      const header = encoding.length(enc)
      syncProtocol.readSyncMessage(dec, enc, doc, ws)
      if (encoding.length(enc) > header) send(ws, encoding.toUint8Array(enc))
    } else if (type === MSG_BRANCH) {
      let req = {}
      let reply
      try {
        req = JSON.parse(decoding.readVarString(dec))
        reply = { id: req.id, op: req.op, ...this.branchRequest(ws, req) }
      } catch (err) {
        reply = { id: req.id, op: req.op, ok: false, error: err.message }
      }
      const listChanged = reply.listChanged
      delete reply.listChanged
      send(ws, jsonMessage(MSG_BRANCHES, { branches: this.branchList(), reply }))
      if (reply.ok && reply.op === 'join') {
        // What the relay has of the branch, and its claims: the app answers with what it has.
        send(ws, syncStep1Message(this.store.get(ws.branch).doc, ws.branchAs))
        send(ws, jsonMessage(MSG_CLAIMS, { claims: this.claimList(ws.branch) }))
      }
      if (listChanged) this.broadcastBranches()
    } else if (type === MSG_AWARENESS) {
```

In `destroy ()`, after `this.save()` add `this.store.destroy()`.

In `startServer`, in `room.onEnd`, change `room.guard.destroy(); room.awareness.destroy(); room.doc.destroy()` to:

```js
        room.store.discard(); room.guard.destroy(); room.awareness.destroy(); room.doc.destroy()
```

In `removeRoomData`, inside `if (dataDir) { ... }` add:

```js
        fs.rmSync(path.join(dataDir, 'branches', name), { recursive: true, force: true })
```

- [ ] **Step 5: The app joins one branch document besides the room's (`src/connection.js`)**

Add `import * as Y from 'yjs'` and `MSG_BRANCH, MSG_BRANCHES` to the `./protocol.js` import.

Constructor signature: add `branch = null` after `doc,`. After `this.backoff = 500` add:

```js
    // Besides the room's document, the one branch this connection syncs (see setBranch). The
    // relay forgets it on every disconnect, so each (re)connection joins it again (startSync).
    this.branchKey = null
    this.branchDoc = null
    this.joinExtra = {} // sent with the first automatic join: adopt (the branch an older app's saved document is), base (HEAD, for a new branch)
    this.joining = null // { id, key, doc } while joinBranch waits for the relay
    this.autoJoin = null // the id of the automatic join, whose refusal is said (branch-refused)
    this.roomSynced = false
    this.branchSynced = false
    this._onBranchUpdate = (update, origin) => {
      if (origin !== REMOTE && this.branchKey !== null) this.send(updateMessage(update, this.branchKey))
    }
    if (branch) {
      this.setBranch(branch.key, branch.doc)
      this.joinExtra = { ...(branch.adopt ? { adopt: branch.adopt } : {}), ...(branch.base ? { base: branch.base } : {}) }
    }
```

(This block goes before `doc.on('update', this._onUpdate)`; `this.connect()` stays last.)

Replace `startSync ()` with:

```js
  startSync () {
    this.send(syncStep1Message(this.doc))
    if (this.branchKey !== null) {
      // The relay handles messages in order: the join lands before the branch's sync step 1.
      const id = crypto.randomBytes(8).toString('hex')
      this.autoJoin = id
      this.send(jsonMessage(MSG_BRANCH, { id, op: 'join', branch: this.branchKey, ...this.joinExtra }))
      this.joinExtra = {}
      this.send(syncStep1Message(this.branchDoc, this.branchKey))
    }
    // Set again rather than resent: that moves our clock on, so the relay takes the state
    // even when it still holds the clock from before a drop (it would ignore a repeat).
    const mine = this.awareness.getLocalState()
    if (mine !== null) this.awareness.setLocalState(mine)
    const q = encoding.createEncoder()
    encoding.writeVarUint(q, MSG_QUERY_AWARENESS)
    this.send(encoding.toUint8Array(q))
  }
```

In `handle`, replace the `MSG_SYNC` branch from task 2 with:

```js
    if (type === MSG_SYNC) {
      const docId = decoding.readVarString(dec)
      const doc = docId === ROOM_DOC ? this.doc : docId === this.branchKey ? this.branchDoc : null
      if (!doc) return // a branch this connection has left
      // Give the owner a chance to capture unsaved local edits so remote
      // changes merge with them instead of overwriting them.
      this.beforeRemote()
      const enc = syncHeader(docId)
      const header = encoding.length(enc)
      const msgType = syncProtocol.readSyncMessage(dec, enc, doc, REMOTE)
      if (encoding.length(enc) > header) this.send(encoding.toUint8Array(enc))
      if (msgType === syncProtocol.messageYjsSyncStep2) {
        if (doc === this.doc) this.roomSynced = true
        else if (!this.branchSynced) { this.branchSynced = true; this.emit('branch-synced') }
        this.noteSynced()
      }
    } else if (type === MSG_BRANCHES) {
      const { branches, reply } = JSON.parse(decoding.readVarString(dec))
      if (reply && this.joining && reply.id === this.joining.id) {
        const j = this.joining
        this.joining = null
        if (reply.ok) { this.setBranch(j.key, j.doc); this.send(syncStep1Message(j.doc, j.key)) }
      }
      if (reply && reply.op === 'join' && reply.ok) this.emit('branch-joined', reply)
      if (reply && reply.id === this.autoJoin && !reply.ok) this.emit('branch-refused', reply.error || 'refused')
      if (Array.isArray(branches)) this.emit('branches', branches)
      this.settle(reply, 'the relay refused that branch change')
    } else if (type === MSG_AWARENESS) {
```

Add after `handle`:

```js
  /** Room and branch documents both synced: 'synced' (once per connection). */
  noteSynced () {
    const was = this.synced
    this.synced = this.roomSynced && (this.branchKey === null || this.branchSynced)
    if (this.synced && !was) this.emit('synced')
  }

  /** Syncs `doc` as branch `key` from now on; the previous branch document is let go. */
  setBranch (key, doc) {
    if (this.branchDoc) this.branchDoc.off('update', this._onBranchUpdate)
    this.branchKey = key
    this.branchDoc = doc
    this.branchSynced = false
    doc.on('update', this._onBranchUpdate)
  }

  /** Moves this connection to branch `key`, syncing `doc` as it once the relay agrees: { branch, created, base }. */
  joinBranch (key, doc, extra = {}) {
    return this.request(MSG_BRANCH, { op: 'join', branch: key, ...extra }, 'branch switches', (id) => { this.joining = { id, key, doc } })
  }

  /** Resolves once the relay holds every change this app has on its branch (before a switch clears the folder). */
  confirmBranch () {
    if (this.branchKey === null) return Promise.resolve({ ok: true })
    const sv = Buffer.from(Y.encodeStateVector(this.branchDoc)).toString('base64')
    return this.request(MSG_BRANCH, { op: 'confirm', branch: this.branchKey, sv }, 'branch switches')
  }

  /** Any other branch request (remove). */
  branchRequest (req) { return this.request(MSG_BRANCH, req, 'branch changes') }

  waitForBranchSync () {
    if (this.branchSynced) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const onSynced = () => { cleanup(); resolve() }
      const onFatal = (err) => { cleanup(); reject(err) }
      const onDown = (s) => { if (s === 'disconnected') { cleanup(); reject(new Error('disconnected from relay')) } }
      const cleanup = () => { this.off('branch-synced', onSynced); this.off('fatal', onFatal); this.off('status', onDown) }
      this.on('branch-synced', onSynced)
      this.on('fatal', onFatal)
      this.on('status', onDown)
    })
  }
```

In `request (type, req, what)`, change the signature to `request (type, req, what, onId = null)` and after `const id = crypto.randomBytes(8).toString('hex')` add `if (onId) onId(id)`.

In the `ws.on('close', ...)` handler, after `this.synced = false` add `this.roomSynced = false; this.branchSynced = false; this.joining = null`.

In `close ()`, after `this.doc.off('update', this._onUpdate)` add `if (this.branchDoc) this.branchDoc.off('update', this._onBranchUpdate)`.

Remove the old `if (msgType === ... && !this.synced) { this.synced = true; this.emit('synced') }` (it is replaced above by `noteSynced`).

- [ ] **Step 6: Run the test and see it pass**

Run: `node --test test/relay-branches.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 7: Run the suite**

Run: `npm test 2>&1 | tail -5`
Expected: only the two known failures. (Sessions still keep files in the room document until task 5; the relay passes those as before.)

- [ ] **Step 8: Commit**

```bash
git add src/branchdocs.js src/server.js src/connection.js test/relay-branches.test.js
git commit -m "Relay: a document per branch; a connection joins one branch besides the room's" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4: Old rooms, idle branches, per-branch claims and guard, removing a branch

**Files:**
- Modify: `src/server.js` (`Room` constructor `:106-200`; `checkChange` `:500-592`; `forget` `:594`; claims methods `:853-1090`; `storedIds` `:1306`; `ACTIVITY_FIELDS`/`ACTIVITY_KINDS` `:1315-1316`; `branchRequest` from task 3; `handle` MSG_CLAIM)
- Test: `test/relay-branches.test.js` (append)

**Interfaces:**
- Consumes: `splitLegacyDoc`, `DEFAULT_KEY`, `BRANCH_TTL_MS`, `validBranchKey` (branchdocs.js); `store.write/rename/remove/stored`.
- Produces (Room): `migrateLegacy()`, `adoptDefault(key) → boolean`, `removeBranch(key, { save })`, `pruneBranches(now)`, `activeBranch() → key`, `hostedBranch(id) → key`, `roomParts`, `checkChange(ws, update, tr, d = this.roomParts)`, `forget(item, d = this.roomParts)`, `branchOf(c)`, `claimKey(branch, pattern)`, `claimList(branch?)`, `allClaims()`, `claimFor(file, branch?)`, `branchPaths(branch)`, `onBranch(ws, rel)`; `branchRequest` gains `op: 'remove'` and `join` takes `adopt`; `branchList()` entries gain `hosted: string[]`; `claimant(ws)` and claim `who` carry `branch`.
- Meta: claims on the default branch stay keyed by bare pattern; others `"<branch>\0<pattern>"` with `branch` on the claim; `layout: 2`; `hostedBranch: { memberId: key }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/relay-branches.test.js` (add `import crypto from 'node:crypto'` at the top):

```js
/** A room as a relay from before branch documents saved it: one document with files, chat and tasks. */
function legacyRoom (dataDir, room) {
  const legacy = new Y.Doc()
  put(legacy, 'app.js', 'old\n')
  legacy.getArray('chat').push([{ id: 'aaaaaaaaaaaaaaaa', by: 'x', text: 'old chat', ts: 1 }])
  legacy.getMap('tasks').set('t1', { id: 't1', title: 'old task' })
  fs.writeFileSync(path.join(dataDir, `${room}.ydoc`), Y.encodeStateAsUpdate(legacy))
  fs.writeFileSync(path.join(dataDir, `${room}.json`), JSON.stringify({ secretHash: crypto.createHash('sha256').update('s').digest('hex'), createdAt: Date.now(), lastActive: Date.now() }))
  return legacy
}

test('an old room\'s document becomes its default branch, taken by the first branch that joins; apps\' saved copies still match', async (t) => {
  const dataDir = tmp('legacy')
  const legacy = legacyRoom(dataDir, 'rb6')
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir })
  t.after(() => srv.close())
  const a = open(t, srv, 'rb6', 'a', 'main')
  await a.c.waitForSync()
  assert.equal(text(a.bdoc, 'app.js'), 'old\n')
  assert.equal(a.doc.getArray('chat').get(0).text, 'old chat')
  assert.equal(a.doc.getMap('tasks').get('t1').title, 'old task')
  assert.equal(a.bdoc.getArray('chat').length, 0, 'the room-wide parts left the branch document')
  const room = srv.rooms.get('rb6')
  assert.equal(room.meta.layout, 2)
  assert.equal(room.defaultKey, 'main')
  assert.ok(fs.existsSync(path.join(dataDir, 'branches', 'rb6', branchFileName('main'))))
  // An app's saved copy of the old document edits the same text, not a copy of it.
  const saved = new Y.Doc()
  Y.applyUpdate(saved, Y.encodeStateAsUpdate(legacy))
  saved.getMap('files').get('app.js').insert(0, '// ')
  Y.applyUpdate(a.bdoc, Y.encodeStateAsUpdate(saved))
  await waitFor(() => text(room.store.get('main').doc, 'app.js') === '// old\n')
})

test('an app that synced the old document names its branch; other branches start empty; a folder without git gets the default', async (t) => {
  const dataDir = tmp('adopt')
  legacyRoom(dataDir, 'rb7')
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir })
  t.after(() => srv.close())
  const f = open(t, srv, 'rb7', 'f', 'feature', { adopt: 'main' })
  await f.c.waitForSync()
  assert.equal(text(f.bdoc, 'app.js'), undefined, 'feature is a branch of its own')
  const m = open(t, srv, 'rb7', 'm', 'main')
  await m.c.waitForSync()
  assert.equal(text(m.bdoc, 'app.js'), 'old\n')
  const n = open(t, srv, 'rb7', 'n', '∅')
  await n.c.waitForSync()
  assert.equal(text(n.bdoc, 'app.js'), 'old\n')
  put(n.bdoc, 'from-plain.txt', 'p\n')
  await waitFor(() => text(m.bdoc, 'from-plain.txt') === 'p\n')
})

test('a branch nobody is on leaves memory and comes back with its files', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir: tmp('idle'), branchIdleMs: 50 })
  t.after(() => srv.close())
  const a = open(t, srv, 'rb8', 'a', 'main')
  await a.c.waitForSync()
  put(a.bdoc, 'kept.txt', 'kept\n')
  await a.c.confirmBranch()
  await a.c.joinBranch('side', new Y.Doc())
  const room = srv.rooms.get('rb8')
  await waitFor(() => !room.store.get('main'))
  const back = new Y.Doc()
  await a.c.joinBranch('main', back)
  await a.c.waitForBranchSync()
  assert.equal(text(back, 'kept.txt'), 'kept\n')
})

test('claims are per branch: the same path on two branches never blocks; each app hears its own branch\'s', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  t.after(() => srv.close())
  const a = open(t, srv, 'rb9', 'a', 'main')
  await a.c.waitForSync()
  const b = open(t, srv, 'rb9', 'b', 'feature-x')
  await b.c.waitForSync()
  await a.c.claimRequest({ op: 'claim', pattern: 'src/a.js', note: 'main work' })
  await b.c.claimRequest({ op: 'claim', pattern: 'src/a.js', note: 'feature work' })
  const room = srv.rooms.get('rb9')
  assert.deepEqual(room.claimList('main').map((c) => c.by), ['a'])
  assert.deepEqual(room.claimList('feature-x').map((c) => c.by), ['b'])
  assert.ok(room.meta.claims['src/a.js'] && room.meta.claims['feature-x\0src/a.js'], 'the default branch keeps bare paths')
  let heard = null
  b.c.on('claims', (list) => { heard = list })
  await a.c.claimRequest({ op: 'claim', pattern: 'docs/**' })
  await waitFor(() => heard)
  assert.deepEqual(heard.map((c) => c.pattern), ['src/a.js'])
  assert.deepEqual(await b.c.claimRequest({ op: 'release', pattern: 'docs/**' }).then((r) => r.released), 0, 'a claim on main is not there to release on feature-x')
})

test('a viewer\'s change to a branch\'s files is undone there, and nobody else sees it', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  t.after(() => srv.close())
  const owner = open(t, srv, 'rb10', 'olive', 'main', { conn: { viewSecret: 'v' } })
  await owner.c.waitForSync()
  while (!owner.c.access || !owner.c.access.owner) await new Promise((resolve) => owner.c.once('access', resolve))
  put(owner.bdoc, 'a.txt', 'safe\n')
  const vid = generateIdentity()
  const asked = new Promise((resolve) => owner.c.on('members', (m) => { if ((m.pending || []).some((p) => p.key === vid.publicKey)) resolve() }))
  const v = open(t, srv, 'rb10', 'vic', 'main', { identity: vid, conn: { secret: 'v' } })
  await asked
  await owner.c.adminRequest({ op: 'approve', key: vid.publicKey, role: 'viewer' })
  await v.c.waitForSync()
  await waitFor(() => text(v.bdoc, 'a.txt') === 'safe\n')
  v.bdoc.getMap('files').get('a.txt').insert(0, 'EVIL ')
  await waitFor(() => text(v.bdoc, 'a.txt') === 'safe\n')
  await wait(200)
  assert.equal(text(owner.bdoc, 'a.txt'), 'safe\n')
})

test('a branch is removed from the session once nobody is on it; the default branch stays', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  t.after(() => srv.close())
  const a = open(t, srv, 'rb11', 'a', 'main')
  await a.c.waitForSync()
  const b = open(t, srv, 'rb11', 'b', 'gone')
  await b.c.waitForSync()
  await assert.rejects(a.c.branchRequest({ op: 'remove', branch: 'gone' }), /b is on gone/)
  await b.c.joinBranch('main', new Y.Doc())
  await a.c.branchRequest({ op: 'remove', branch: 'gone' })
  const room = srv.rooms.get('rb11')
  assert.deepEqual(room.branchList().map((x) => x.key), ['main'])
  await assert.rejects(a.c.branchRequest({ op: 'remove', branch: 'main' }), /default branch/)
})

test('branches nobody was on for 30 days are dropped when the room loads; the active branch has the most people', async (t) => {
  const dataDir = tmp('ttl')
  const old = Date.now() - 31 * 86400e3
  fs.writeFileSync(path.join(dataDir, 'rb12.json'), JSON.stringify({ secretHash: crypto.createHash('sha256').update('s').digest('hex'), layout: 2, defaultBranch: 'main', branches: { main: { by: 'a', at: old, seen: old }, stale: { by: 'a', at: old, seen: old }, fresh: { by: 'a', at: old, seen: Date.now() } }, lastActive: Date.now() }))
  fs.mkdirSync(path.join(dataDir, 'branches', 'rb12'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'branches', 'rb12', branchFileName('stale')), Y.encodeStateAsUpdate(new Y.Doc()))
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir })
  t.after(() => srv.close())
  const a = open(t, srv, 'rb12', 'a', 'fresh')
  const b = open(t, srv, 'rb12', 'b', 'fresh')
  const c = open(t, srv, 'rb12', 'c', 'main')
  await Promise.all([a.c.waitForSync(), b.c.waitForSync(), c.c.waitForSync()])
  const room = srv.rooms.get('rb12')
  assert.deepEqual(room.branchList().map((x) => x.key).sort(), ['fresh', 'main'])
  assert.equal(fs.existsSync(path.join(dataDir, 'branches', 'rb12', branchFileName('stale'))), false)
  assert.equal(room.activeBranch(), 'fresh')
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/relay-branches.test.js`
Expected: the six new tests FAIL (the legacy room serves `app.js` from the room document, claims block across branches, `room.activeBranch is not a function`, `unknown branch request`).

- [ ] **Step 3: Migrate old rooms and prune idle branches in the constructor**

Import `splitLegacyDoc` and `BRANCH_TTL_MS` from `./branchdocs.js` too.

In the constructor, move the two lines

```js
    this.awareness = new awarenessProtocol.Awareness(this.doc)
    this.awareness.setLocalState(null)
```

from just after `this.doc = new Y.Doc()` to just after the `this.store = new BranchStore({...})` block from task 3, preceded by:

```js
    // A room saved before branch documents: its one document becomes the default branch's.
    this.migrateLegacy()
    this.pruneBranches()
```

and in the load `catch`, delete `this.awareness.destroy()` (it doesn't exist yet there).

Add after `noteBranchSaved`:

```js
  /**
   * A room saved before branch documents kept everything in one document. That document
   * becomes the default branch's as it is (every app's saved copy still matches it), and its
   * room-wide parts (chat, tasks, the feed, commit requests, activity) move to a new room
   * document. Once, before anyone connects. The branch file is written first, so the files
   * are never only in memory, and a crash part-way is finished at the next load.
   */
  migrateLegacy () {
    if (this.meta.layout === 2) return
    const legacy = this.doc
    if (this.docFile && (legacy.getMap('files').size || legacy.getMap('blobs').size)) {
      const stored = [...legacy.getMap('blobs').values()].filter((x) => x && x.stored && x.stored.id).map((x) => x.stored.id).sort()
      const room = splitLegacyDoc(legacy)
      if (!this.store.write(DEFAULT_KEY, Y.encodeStateAsUpdate(legacy))) { room.destroy(); return } // read-only now; tried again at the next load
      const state = Y.encodeStateAsUpdate(room)
      try {
        fs.writeFileSync(this.docFile + '.tmp', state)
        fs.renameSync(this.docFile + '.tmp', this.docFile)
      } catch (err) { room.destroy(); this.diskError(err); return }
      legacy.destroy()
      this.doc = room
      this.bytes = state.length
      this.meta.branches[DEFAULT_KEY] = { by: '', at: this.meta.createdAt || Date.now(), base: null, stored }
      this.log(`[${this.name}] moved its files into the default branch's document`)
    } else if (this.store.stored(DEFAULT_KEY) && !this.meta.branches[DEFAULT_KEY]) {
      // Stopped after both files were written, before this was saved.
      this.meta.branches[DEFAULT_KEY] = { by: '', at: this.meta.createdAt || Date.now(), base: null }
    }
    if (this.meta.branches[DEFAULT_KEY] && !this.meta.defaultBranch) this.meta.defaultBranch = DEFAULT_KEY
    this.meta.layout = 2
    if (this.exists) this.saveMeta()
  }

  /**
   * The default branch is ∅ (a folder without git, or a room from before branch documents)
   * and nothing else is in the session: `key`, its first real branch, takes ∅'s document, so
   * nobody diverges. Two names already in the session stay two branches.
   */
  adoptDefault (key) {
    if (key === DEFAULT_KEY || this.defaultKey !== DEFAULT_KEY || !this.meta.branches[DEFAULT_KEY] || this.meta.branches[key]) return false
    if (Object.keys(this.meta.branches).some((k) => k !== DEFAULT_KEY)) return false
    this.store.rename(DEFAULT_KEY, key)
    this.meta.branches[key] = this.meta.branches[DEFAULT_KEY]
    delete this.meta.branches[DEFAULT_KEY]
    this.meta.defaultBranch = key
    for (const ws of this.conns.keys()) if (ws.branch === DEFAULT_KEY) ws.branch = key
    this.saveMeta()
    return true
  }

  /** Takes branch `key` out of the session: its document, its claims, hosted agents' choice of it. Never the git branch. */
  removeBranch (key, { save = true } = {}) {
    this.store.remove(key)
    delete this.meta.branches[key]
    for (const [k, c] of Object.entries(this.meta.claims)) if (this.branchOf(c) === key) delete this.meta.claims[k]
    for (const [id, k] of Object.entries(this.meta.hostedBranch || {})) if (k === key) delete this.meta.hostedBranch[id]
    if (save) this.saveMeta()
  }

  /** Branches nobody has been on for BRANCH_TTL_MS leave the session (never the default branch). */
  pruneBranches (now = Date.now()) {
    let gone = 0
    for (const [key, b] of Object.entries(this.meta.branches)) {
      if (key === this.defaultKey || now - (b.seen || b.at || 0) < BRANCH_TTL_MS) continue
      this.removeBranch(key, { save: false })
      gone++
    }
    if (!gone) return
    this.log(`[${this.name}] removed ${gone} branch(es) nobody was on for 30 days`)
    if (this.exists) this.saveMeta()
  }

  /**
   * The branch with the most members on it (connected apps, and hosted agents that chose
   * one); ties go to the owner's, then the default. Hosted agents and chat links work here
   * unless they chose a branch.
   */
  activeBranch () {
    const count = new Map()
    const counted = new Set()
    for (const ws of this.conns.keys()) {
      const who = this.names.get(ws)
      if (!ws.branch || counted.has(who)) continue
      counted.add(who)
      count.set(ws.branch, (count.get(ws.branch) || 0) + 1)
    }
    for (const [id, k] of Object.entries(this.meta.hostedBranch || {})) {
      if (this.meta.branches[k] && this.hostedSeen.has(id)) count.set(k, (count.get(k) || 0) + 1)
    }
    if (!count.size) return this.defaultKey
    const top = Math.max(...count.values())
    const tied = [...count].filter(([, n]) => n === top).map(([k]) => k)
    const owner = [...this.access].find(([, a]) => a.owner)?.[0]?.branch
    if (owner && tied.includes(owner)) return owner
    if (tied.includes(this.defaultKey)) return this.defaultKey
    return tied.sort()[0]
  }

  /** The branch a hosted agent works on: the one it chose (quilt_switch_branch), or the active branch. */
  hostedBranch (id) {
    const k = (this.meta.hostedBranch || {})[id]
    return k && this.meta.branches[k] ? k : this.activeBranch()
  }
```

Replace `branchList ()` with:

```js
  /** The session's branches, for everyone's branch menu (hosted: the hosted agents on each). */
  branchList () {
    const hosted = new Map()
    for (const h of this.hostedOnline()) {
      const k = this.hostedBranch(h.id)
      hosted.set(k, [...(hosted.get(k) || []), h.name])
    }
    return Object.entries(this.meta.branches).map(([key, b]) => ({ key, by: b.by || '', at: b.at || 0, base: b.base || null, default: key === this.defaultKey, hosted: hosted.get(key) || [] }))
  }
```

In `branchRequest`, at the start of the `join` case (before `const k = this.resolveKey(key)`) add:

```js
      // An app from before branch documents names the branch the old document was; else the first real branch takes ∅.
      if (validBranchKey(String(req.adopt || ''))) this.adoptDefault(String(req.adopt))
      this.adoptDefault(key)
```

and before the final `throw new Error('unknown branch request')` add:

```js
    if (req.op === 'remove') {
      const a = this.access.get(ws)
      if (!a || (this.controlled && !a.owner)) throw new Error('only the session owner can remove a branch')
      const k = this.resolveKey(key)
      if (!this.meta.branches[k]) throw new Error(`${key} isn't in this session`)
      if (k === this.defaultKey) throw new Error(`${key} is the session's default branch; it stays`)
      const on = [...this.conns.keys()].filter((c) => c.branch === k).map((c) => this.names.get(c))
      if (on.length) throw new Error(`${[...new Set(on)].join(', ')} ${on.length === 1 ? 'is' : 'are'} on ${key}; it can be removed once nobody is`)
      this.removeBranch(k)
      return { ok: true, branch: k, listChanged: true }
    }
```

- [ ] **Step 4: Guard branch documents with the room's rules**

Replace the constructor lines from `this.guard = new Y.UndoManager(...)` through `this.guard.on('stack-item-added', ...)` with:

```js
    // Undoes changes from people who may not make them: file changes from viewers and from
    // people outside their folders, and posts from people who may not post (chat, the feed,
    // words of their own in the activity log, commit requests). Only their connections are tracked.
    // Branch documents get a guard each (wireBranch) sharing these tracked connections. The room
    // document's files maps are only in rooms from before branch documents.
    this.guard = new Y.UndoManager([this.files, this.blobs, this.fileKeys, this.chat, this.feed, this.activity, this.commitRequests], { trackedOrigins: new Set(), captureTimeout: 0 })
    // What checkChange works on: the room document's parts, its guard and who hears its updates.
    this.roomParts = {
      guard: this.guard, recorded: null, undoing: null,
      files: this.files, blobs: this.blobs, fileKeys: this.fileKeys, chat: this.chat, feed: this.feed, activity: this.activity, commitRequests: this.commitRequests,
      listeners: () => this.conns.keys(), frame: () => ROOM_DOC
    }
    this.guard.on('stack-item-added', ({ stackItem, type }) => { if (type === 'undo') this.roomParts.recorded = stackItem })
```

In the room document's `'update'` listener, change the first line to:

```js
      if (origin === this.guard && this.roomParts.undoing) { this.roomParts.undoing.push(update); return } // sent merged, below
```

Replace `wireBranch (e)` with:

```js
  /** A branch document just loaded: guarded like the room's files, its changes sent to the connections on it, and saved. */
  wireBranch (e) {
    e.guard = new Y.UndoManager([e.files, e.blobs, e.fileKeys], { trackedOrigins: this.guard.trackedOrigins, captureTimeout: 0 })
    e.recorded = null
    e.undoing = null
    e.listeners = () => e.conns
    e.frame = (ws) => ws.branchAs
    e.guard.on('stack-item-added', ({ stackItem, type }) => { if (type === 'undo') e.recorded = stackItem })
    e.doc.on('update', (update, origin, doc, tr) => {
      if (origin === e.guard && e.undoing) { e.undoing.push(update); return } // sent merged, by checkChange
      if (origin && origin !== e.guard && this.guard.trackedOrigins.has(origin) && !this.checkChange(origin, update, tr, e)) return
      if (origin && this.conns.has(origin)) this.noteActivity(this.holderKeys(origin))
      for (const ws of e.conns) if (ws !== origin) send(ws, updateMessage(update, ws.branchAs))
      e.bytes += update.length
      if (!this.full && this.totalBytes() > this.cfg.maxRoomBytes) {
        this.full = true
        this.log(`[${this.name}] over the size limit; further edits are refused`)
      }
      this.store.scheduleSave(e)
    })
  }

  /** Whether `rel` is a file on the branch this connection is on. */
  onBranch (ws, rel) {
    const e = ws.branch ? this.store.get(ws.branch) : null
    return !!e && (e.files.has(rel) || e.blobs.has(rel))
  }
```

Replace `checkChange` and `forget` with:

```js
  /**
   * A restricted member (viewer, or agent limited to folders) changed a document: the room's
   * (`d` = roomParts) or a branch's (`d` = its entry). Returns true to pass it on, or false
   * after scheduling an undo of what they may not change. The undo runs once the guard has
   * recorded the change, whichever order Yjs fires its events in.
   */
  checkChange (ws, update, tr, d = this.roomParts) {
    const a = this.access.get(ws)
    const touched = new Map() // path -> the types (files, blobs) it changed in
    const refused = []
    const posts = [] // chat and the feed, for people who may not post
    // Only the parts of the change that were refused are undone: one update can carry
    // allowed and refused changes together (an edit and a post in one transaction).
    const undo = new Set()
    for (const [type, events] of tr.changedParentTypes) {
      if (type === d.chat || type === d.feed) {
        if (a?.talk === false) { posts.push(type === d.chat ? 'chat' : 'the feed'); undo.add(type) }
        continue
      }
      if (type === d.commitRequests) {
        // Asking for a commit is a message to the host; marking one done (same message) isn't.
        if (a?.talk !== false) continue
        for (const e of events) {
          for (const [id, c] of e.changes.keys) {
            const now = type.get(id)
            if (c.action === 'add' || (c.action === 'update' && now?.message !== c.oldValue?.message)) { posts.push('a commit request'); undo.add(type); break }
          }
        }
        continue
      }
      if (type === d.fileKeys) {
        // Keys to stored files: viewers may not touch them, and others may
        // only add new ones, so nobody can lock people out of stored files.
        for (const e of events) {
          if (e.target !== type) { refused.push('a file key'); undo.add(type); continue }
          for (const [id, c] of e.changes.keys) if (a?.role === 'viewer' || c.action !== 'add') { refused.push(`file key ${id}`); undo.add(type) }
        }
        continue
      }
      if (type !== d.files && type !== d.blobs) continue
      const touch = (rel) => touched.set(rel, [...(touched.get(rel) || []), type])
      for (const e of events) {
        if (e.target === type) for (const k of e.changes.keys.keys()) touch(k)
        else {
          // A change inside a file's text: walk up to the entry in files.
          let t = e.target
          while (t && t._item && t._item.parent !== type) t = t._item.parent
          if (t && t._item && t._item.parentSub) touch(t._item.parentSub)
        }
      }
    }
    for (const [rel, types] of touched) {
      if (this.mayWrite(a, rel)) continue
      refused.push(rel)
      for (const t of types) undo.add(t)
      // The log entry for a change that's undone would describe something that never happened.
      if (d.activity && tr.changedParentTypes.has(d.activity)) undo.add(d.activity)
    }
    // Activity entries come apart from the file changes they describe (files are in branch
    // documents now): one about a file this member may not change describes a change undone there.
    let quiet = false
    const added = d.activity && tr.changedParentTypes.has(d.activity) ? (this.activityAdded.get(tr) || []) : []
    if (added.length && !undo.has(d.activity) && a && a.talk !== false && added.some((x) => x && typeof x.path === 'string' && x.path && !this.mayWrite(a, x.path))) {
      undo.add(d.activity)
      quiet = true
    }
    // The activity log is written by apps as files change. Someone who may not post may add
    // only those entries, for files on their branch they may change, never words of their own.
    if (a?.talk === false && added.length && !undo.has(d.activity)) {
      const plain = (x) => x && typeof x === 'object' && Object.keys(x).every((k) => ACTIVITY_FIELDS.includes(k)) &&
        x.by === a.name && ACTIVITY_KINDS.includes(x.kind) &&
        (x.kind === 'switched' ? x.path === '' : typeof x.path === 'string' && this.mayWrite(a, x.path) && (x.kind === 'deleted' || touched.has(x.path) || this.onBranch(ws, x.path))) &&
        (x.detail === undefined || ACTIVITY_DETAIL.test(x.detail)) && typeof x.ts === 'number' &&
        (x.branch === undefined || validBranchKey(x.branch)) && (x.from === undefined || validBranchKey(x.from))
      if (!added.every(plain)) { posts.push('the activity log'); undo.add(d.activity) }
    }
    refused.push(...posts)
    // The guard recorded this change just before this 'update' (its stack-item-added): only
    // that one is kept or undone, never another change that arrived in the same moment.
    const item = d.recorded
    d.recorded = null
    if (!refused.length && !quiet) { this.forget(item, d); return true }
    if (refused.length) this.log(`[${this.name}] undid ${a ? a.name : 'someone'}'s change to ${refused.slice(0, 3).join(', ')}${refused.length > 3 ? '…' : ''} (not allowed)`)
    queueMicrotask(() => {
      // Send the change and its undo as one update: nobody sees the change,
      // and nobody is left missing part of this person's history.
      const others = d.guard.undoStack.filter((x) => x !== item)
      const scope = d.guard.scope
      d.guard.undoStack = item ? [item] : []
      d.guard.scope = scope.filter((t) => undo.has(t))
      d.undoing = []
      try { d.guard.undo() } finally {
        d.guard.scope = scope
        d.guard.undoStack = others
        d.guard.redoStack = []
        const merged = Y.mergeUpdates([update, ...d.undoing])
        d.undoing = null
        for (const other of d.listeners()) send(other, updateMessage(merged, d.frame(other)))
      }
      if (!refused.length) return
      const why = posts.length === refused.length
        ? TALK_WHY
        : a && a.role === 'viewer' ? 'you can only view this session' : 'that is outside the folders you may change'
      send(ws, jsonMessage(MSG_ACCESS, { ...this.accessMessage(a), refused: refused.slice(0, 20), why }))
    })
    return false
  }

  /** An allowed change: the guard never needs to undo it. */
  forget (item, d = this.roomParts) {
    const i = item ? d.guard.undoStack.indexOf(item) : -1
    if (i >= 0) d.guard.undoStack.splice(i, 1)
  }
```

Change the activity constants near `TALK_WHY`:

```js
// What an app's activity entries look like (session.js recordActivity and moveTo, relay-mcp.js quilt_write).
const ACTIVITY_FIELDS = ['by', 'path', 'kind', 'detail', 'ts', 'branch', 'from']
const ACTIVITY_KINDS = ['created', 'edited', 'deleted', 'switched']
```

- [ ] **Step 5: Claims per branch**

Replace `claimant (ws)` with:

```js
  /** Who a claim from this connection belongs to (their name, or with sign-in on their account), on the branch they're on. */
  claimant (ws) {
    const name = this.names.get(ws)
    if (!ws.pass) return { name, branch: ws.branch }
    const a = this.access.get(ws)
    return { name, id: `${ws.pass.kind}:${ws.pass.sub}`, owner: !!(a && a.owner), talk: !(a && a.talk === false), branch: ws.branch }
  }
```

Replace `claimList ()` with:

```js
  /** Which branch a claim is on: its own, or the default branch (claims from before branches). */
  branchOf (c) { return c.branch ? this.resolveKey(c.branch) : this.defaultKey }

  /** Where a claim on `pattern` on `branch` is kept in meta.claims: the default branch keeps bare paths. */
  claimKey (branch, pattern) {
    const b = this.resolveKey(branch || this.defaultKey)
    return b === this.defaultKey ? pattern : `${b}\0${pattern}`
  }

  shownClaim (c) { return { ...c, queue: c.queue || [], active: this.holderPresent(c), activeAt: this.lastActive(c) } }

  /**
   * The claims on one branch (the default when none is given), each with `active` (whoever
   * holds it is in the session now), `activeAt` (when they last did something there) and its
   * file queue: who asked for it next ({ id, path, by, title, description, task, ts }), oldest first.
   */
  claimList (branch) {
    const b = this.resolveKey(branch || this.defaultKey)
    return Object.values(this.meta.claims).filter((c) => this.branchOf(c) === b).map((c) => this.shownClaim(c)).sort((x, y) => x.ts - y.ts)
  }

  /** Every claim on every branch. */
  allClaims () { return Object.values(this.meta.claims).map((c) => this.shownClaim(c)).sort((x, y) => x.ts - y.ts) }

  /** The files on a branch, for telling whether two patterns overlap (and the room document's, in rooms from before branches). */
  branchPaths (branch) {
    const e = this.store.load(this.resolveKey(branch || this.defaultKey))
    return [...e.files.keys(), ...e.blobs.keys(), ...this.doc.getMap('files').keys(), ...this.doc.getMap('blobs').keys()]
  }
```

Replace `claimFor (file)` with:

```js
  /** The claim covering a file on a branch: its own, or a folder or glob claim that matches it (the earliest). */
  claimFor (file, branch) {
    const own = this.meta.claims[this.claimKey(branch, file)]
    if (own) return own
    return this.claimList(branch).filter((c) => globMatcher(c.pattern)(file)).sort((a, b) => a.ts - b.ts)[0] || null
  }
```

In `broadcastClaims ()` replace the last two lines with:

```js
    for (const other of this.conns.keys()) send(other, jsonMessage(MSG_CLAIMS, { claims: this.claimList(other.branch) }))
```

In `dropClaims`, change `else delete this.meta.claims[c.pattern]` to `else delete this.meta.claims[this.claimKey(c.branch, c.pattern)]`.

In `handOff`, change the `next` line and the store line to:

```js
    const next = { ...(c.branch ? { branch: c.branch } : {}), by: r.by, ...(r.byId ? { byId: r.byId } : {}), pattern: c.pattern, note: String(r.title || '').slice(0, 500), ts: now, from: c.by }
    if (queue.length) next.queue = queue
    this.meta.claims[this.claimKey(c.branch, c.pattern)] = next
```

In `sweepClaims`, change the `shown` line to:

```js
    const shown = this.allClaims().map((c) => `${c.branch || ''}\0${c.pattern}\0${c.active}`).join('\n')
```

In `claimRequest (who, req)`, after `const pattern = ...` add:

```js
    // Claims are per branch: one on src/a.js on main never blocks src/a.js on feature-x.
    const branch = this.resolveKey(who.branch || this.defaultKey)
    const at = (p) => this.claimKey(branch, p)
    const onBranch = branch === this.defaultKey ? {} : { branch }
```

and inside it:
- `const existing = this.meta.claims[pattern]` → `const existing = this.meta.claims[at(pattern)]`
- `const paths = [...this.doc.getMap('files').keys(), ...this.doc.getMap('blobs').keys()]` → `const paths = this.branchPaths(branch)`
- `const other = this.claimList().find(` → `const other = this.claimList(branch).find(`
- `this.meta.claims[pattern] = { by: name, ...` → `this.meta.claims[at(pattern)] = { ...onBranch, by: name, ...`
- in the release-everything case, `this.dropClaims((c) => mine(c) && !queued(c))` → `this.dropClaims((c) => mine(c) && !queued(c) && this.branchOf(c) === branch)` and the `held` filter `.filter((c) => mine(c) && queued(c))` → `.filter((c) => mine(c) && queued(c) && this.branchOf(c) === branch)`
- `const c = this.meta.claims[pattern]` (release one) → `const c = this.meta.claims[at(pattern)]`
- `const c = this.claimFor(file)` (request) → `const c = this.claimFor(file, branch)`
- `const c = this.meta.claims[pattern] || (pattern && this.claimFor(pattern))` (handoff) → `const c = this.meta.claims[at(pattern)] || (pattern && this.claimFor(pattern, branch))`

In `handle`, the `MSG_CLAIM` branch: change `claims: this.claimList()` in the error reply to `claims: this.claimList(ws.branch)`, and the broadcast to:

```js
      this.saveMeta()
      for (const other of this.conns.keys()) {
        const claims = this.claimList(other.branch)
        send(other, jsonMessage(MSG_CLAIMS, other === ws ? { claims, reply } : { claims }))
      }
```

Replace `storedIds ()` with:

```js
  /** Stored-file ids any of the room's documents still points at (unloaded branches: as of their last save). */
  storedIds () {
    const ids = new Set()
    const add = (b) => { if (b && b.stored && b.stored.id) ids.add(b.stored.id) }
    for (const b of this.blobs.values()) add(b) // rooms from before branch documents
    for (const [key, meta] of Object.entries(this.meta.branches)) {
      const e = this.store.get(key)
      if (e) for (const b of e.blobs.values()) add(b)
      else for (const id of meta.stored || []) ids.add(id)
    }
    return ids
  }
```

- [ ] **Step 6: Run the tests and see them pass**

Run: `node --test test/relay-branches.test.js`
Expected: PASS, 13 tests.

- [ ] **Step 7: Run the suite**

Run: `npm test 2>&1 | tail -5`
Expected: only the two known failures. If a claims test in `test/sync.test.js` or `test/relay-talk.test.js` fails, it is a missed `claimList()`/`meta.claims[...]` call: `grep -n "claimList()\|meta.claims\[" src/server.js src/relay-mcp.js src/chat-links.js` and route it through `claimKey`/`claimList(branch)`.

- [ ] **Step 8: Commit**

```bash
git add src/server.js test/relay-branches.test.js
git commit -m "Relay: old rooms become their default branch; per-branch claims and guard; removing and pruning branches" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 5: The app keeps two documents; hosted agents and chat links work on a branch

The app's files move into the branch document of the branch the folder syncs. A terminal checkout still pauses the folder (phase 1) in this task; task 6 replaces the pause with a move.

**Files:**
- Modify: `src/session.js` (imports `:1-34`; constructor `:86-131`; new methods after `log` `:246`; `start` `:248-345`; `goLive` `:431-503`; `loadState`/`saveState` `:506-543`; the `this.doc` lines listed in step 3; `status` `:3459`)
- Modify: `src/relay-mcp.js` (`sessionTools` `:111-190`, `quilt_write_file` `:515-562`)
- Modify: `src/chat-links.js` (`ChatPage` `:260-489`)
- Test: `test/branch-docs-session.test.js`

**Interfaces:**
- Consumes: `Connection` option `branch`, events `branches`, `branch-joined`, `branch-refused` (task 3); `Room.branchDoc`, `Room.activeBranch`, `Room.claimList(branch)` (tasks 3-4); `DEFAULT_KEY` (branchdocs.js).
- Produces (Session): `doc` (room document), `bdoc` (branch document), `branch` (key as the relay names it), `branchList`, `localBranches`, `roomFile` (`.quilt/room.bin`), `legacyState`; `bindBranchDoc(doc)`, `transact(fn, origin = LOCAL)`, `observeBranch()`, `setBranches(list)`; `status().branch`. Local files: `.quilt/state.bin` = branch document, `.quilt/room.bin` = room document, `.quilt/state.json` gains `layout: 2` and `branch`.
- Produces (relay-mcp `sessionTools`): `branchOf(room)`, tool parts gain `fdoc` (the branch document) and `branch` (its store entry); claims and history are the branch's.

- [ ] **Step 1: Write the failing test**

Create `test/branch-docs-session.test.js`:

```js
// A session keeps two documents: the room's (chat, tasks, the feed, commit
// requests, activity) and its branch's (files and what goes with them). Each
// folder syncs the branch git is on, so folders on different branches never mix.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { generateIdentity } from '../src/identity.js'
import { sha1 } from '../src/fsutil.js'

let srv, server
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-bd-${n}-`))
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV }).trim()
async function waitFor (fn, ms = 8000) {
  const start = Date.now(); let last
  while (Date.now() - start < ms) { try { last = await fn(); if (last) return last } catch (e) { last = e }; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error(`timed out; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}
async function never (fn, ms = 1500) {
  const start = Date.now()
  while (Date.now() - start < ms) { assert.ok(!(await fn()), 'happened but must not'); await new Promise((r) => setTimeout(r, 25)) }
}
process.env.HOME = process.env.USERPROFILE = tmp('home')
const ids = new Map()
const identityOf = (n) => { if (!ids.has(n)) ids.set(n, generateIdentity()); return ids.get(n) }
const stopped = new Set()
const close = async (s) => { if (!stopped.has(s)) { stopped.add(s); await s.stop() } }
async function open (t, dir, name, extra) {
  const s = new Session({ dir, server, secret: 'pw', name, identity: identityOf(name), ...extra })
  t.after(() => close(s))
  await s.start({ waitTimeoutMs: 5000 })
  s.setAgentState({ tool: s.tool, status: 'idle' })
  return s
}
let rooms = 0
/** A remote with main and feature (feature changes README.md), and two clones on main. */
function clones () {
  const bare = tmp('bare'); git(bare, 'init', '-q', '--bare', '-b', 'main')
  const seed = tmp('seed'); git(seed, 'clone', '-q', bare, '.')
  write(seed, 'README.md', 'hello\n'); write(seed, 'src/app.js', 'app\n')
  git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'one'); git(seed, 'push', '-q', 'origin', 'main')
  git(seed, 'checkout', '-qb', 'feature'); write(seed, 'README.md', 'feature readme\n'); git(seed, 'commit', '-qam', 'f'); git(seed, 'push', '-q', 'origin', 'feature')
  const dirA = tmp('a'); git(dirA, 'clone', '-q', bare, '.')
  const dirB = tmp('b'); git(dirB, 'clone', '-q', bare, '.')
  return { dirA, dirB }
}

before(async () => { srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, maxNewRoomsPerHour: 0 }); server = `ws://127.0.0.1:${srv.port}` })
after(async () => { await srv.close() })

test('files live in the branch document; chat and activity in the room document', async (t) => {
  const { dirA } = clones()
  const room = `bd${++rooms}`
  const A = await open(t, dirA, 'alice', { room })
  assert.notEqual(A.bdoc, A.doc)
  assert.equal(A.files.doc, A.bdoc)
  assert.equal(A.chat.doc, A.doc)
  assert.equal(A.status().branch, 'main')
  write(dirA, 'src/app.js', 'edited\n')
  const r = srv.rooms.get(room)
  await waitFor(() => r.store.get('main')?.files.get('src/app.js')?.toString() === 'edited\n')
  assert.equal(r.doc.getMap('files').size, 0)
  await waitFor(() => r.doc.getArray('activity').toArray().some((x) => x.path === 'src/app.js'))
  A.say('hello everyone', { everyone: true })
  await waitFor(() => r.doc.getArray('chat').length === 1)
})

test('two folders on different branches at start never mix; chat reaches both', async (t) => {
  const { dirA, dirB } = clones()
  git(dirB, 'checkout', '-q', 'feature')
  const room = `bd${++rooms}`
  const A = await open(t, dirA, 'alice', { room })
  const B = await open(t, dirB, 'bob', { room })
  assert.equal(B.status().branch, 'feature')
  assert.equal(read(dirB, 'README.md'), 'feature readme\n')
  write(dirA, 'README.md', 'main work\n')
  write(dirB, 'src/app.js', 'feature work\n')
  await never(() => read(dirB, 'README.md') !== 'feature readme\n' || read(dirA, 'src/app.js') !== 'app\n', 2000)
  A.say('hi bob', { everyone: true })
  await waitFor(() => B.messages({ markRead: false }).some((m) => m.text === 'hi bob'))
})

test('local state: state.bin is the branch document, room.bin the room\'s, and state.json names the branch', async (t) => {
  const { dirA } = clones()
  const room = `bd${++rooms}`
  const A = await open(t, dirA, 'alice', { room })
  A.say('kept in the room', { everyone: true })
  await close(A)
  const state = JSON.parse(fs.readFileSync(path.join(dirA, '.quilt', 'state.json'), 'utf8'))
  assert.equal(state.layout, 2)
  assert.equal(state.branch, 'main')
  const bdoc = new Y.Doc(); Y.applyUpdate(bdoc, fs.readFileSync(path.join(dirA, '.quilt', 'state.bin')))
  assert.equal(bdoc.getMap('files').get('README.md').toString(), 'hello\n')
  const rdoc = new Y.Doc(); Y.applyUpdate(rdoc, fs.readFileSync(path.join(dirA, '.quilt', 'room.bin')))
  assert.ok(rdoc.getArray('chat').toArray().some((m) => m.text === 'kept in the room'))
})

test('a folder from before branch documents rejoins its old room: its offline edit merges into the default branch', async (t) => {
  const dataDir = tmp('legacy-relay')
  const relay = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: () => {}, maxNewRoomsPerHour: 0 })
  t.after(() => relay.close())
  const url = `ws://127.0.0.1:${relay.port}`
  const legacy = new Y.Doc()
  legacy.transact(() => { const y = new Y.Text(); y.insert(0, 'shared\n'); legacy.getMap('files').set('notes.txt', y) })
  legacy.getArray('chat').push([{ id: 'aaaaaaaaaaaaaaaa', by: 'carl', text: 'from before', ts: 1 }])
  fs.writeFileSync(path.join(dataDir, 'old-room.ydoc'), Y.encodeStateAsUpdate(legacy))
  fs.writeFileSync(path.join(dataDir, 'old-room.json'), JSON.stringify({ secretHash: crypto.createHash('sha256').update('pw').digest('hex'), createdAt: Date.now(), lastActive: Date.now() }))
  // The folder as an app from before saved it: the one document, no layout, and an edit made offline.
  const dir = tmp('legacy-folder')
  write(dir, 'notes.txt', 'shared\nedited offline\n')
  fs.mkdirSync(path.join(dir, '.quilt'))
  fs.writeFileSync(path.join(dir, '.quilt', 'state.bin'), Y.encodeStateAsUpdate(legacy))
  fs.writeFileSync(path.join(dir, '.quilt', 'state.json'), JSON.stringify({ room: 'old-room', server: url, storedOnDisk: {}, known: { 'notes.txt': sha1('shared\n') } }))
  const A = await open(t, dir, 'alice', { room: 'old-room', server: url })
  const r = relay.rooms.get('old-room')
  await waitFor(() => r.store.get(r.defaultKey)?.files.get('notes.txt')?.toString() === 'shared\nedited offline\n')
  assert.ok(A.messages({ markRead: false }).some((m) => m.text === 'from before'))
  const other = tmp('fresh')
  await open(t, other, 'bob', { room: 'old-room', server: url })
  await waitFor(() => read(other, 'notes.txt') === 'shared\nedited offline\n')
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/branch-docs-session.test.js`
Expected: FAIL: `A.bdoc` is undefined (`assert.notEqual(A.bdoc, A.doc)` fails), and the relay's `main` branch never gets `src/app.js`.

- [ ] **Step 3: Point the file transactions at the branch document (before any other edit to session.js)**

These line numbers are as of the start of this task; run this first:

```bash
sed -i '' \
  -e '772s/this\.doc\.transact(/this.transact(/' \
  -e '1644s/this\.doc\.transact(/this.transact(/' \
  -e '1671s/this\.doc\.transact(/this.transact(/' \
  -e '2149s/this\.doc\.transact(/this.transact(/' \
  -e '2071s/this\.doc\.transact(/this.bdoc.transact(/' \
  -e '2082s/this\.doc\.transact(/this.bdoc.transact(/' \
  -e 's/(this\.doc, this\.merges/(this.bdoc, this.merges/g' \
  src/session.js
grep -n "this\.transact(\|this\.bdoc\.transact(\|this\.bdoc, this\.merges" src/session.js
```

Expected: 4 `this.transact(` lines (applyMerged, ingest's delete and edit, uploadLarge), 2 `this.bdoc.transact(` (fileKeys), 5 `this.bdoc, this.merges` (pruneMerges, openMerge, three updateMerge). The remaining `this.doc.transact(` calls touch only room-wide types (activity for a pull, commit requests, chat, the agent feed).

- [ ] **Step 4: Two documents in the session (`src/session.js`)**

Add to the imports:

```js
import { DEFAULT_KEY } from './branchdocs.js'
```

In the constructor, replace

```js
    this.doc = new Y.Doc()
    this.files = this.doc.getMap('files') // path -> Y.Text
    this.blobs = this.doc.getMap('blobs') // path -> { hash, data(base64) } or { hash, size, stored: { id, key } }
    // keyId -> { wraps, ts }: file keys for large files, each wrapped for editors and viewers.
    this.fileKeys = this.doc.getMap('fileKeys')
```

with

```js
    this.roomFile = path.join(this.stateDir, 'room.bin')
    // Two documents: the room's (chat, tasks, the agent feed, commit requests, activity) and
    // the one for the branch this folder syncs (its files and what goes with them; see
    // bindBranchDoc). state.bin keeps the branch's, room.bin the room's.
    this.doc = new Y.Doc()
    this.branch = null // the branch this folder syncs, as the relay names it (∅: the room's default, for a folder without git)
    this.branchList = [] // the session's branches, from the relay: [{ key, by, at, base, default, hosted }]
    this.localBranches = [] // this repo's own branches (refs/heads), for the branch menu
    this.legacyState = false // state.json from before branch documents: its state.bin is the room's old single document
    this.bindBranchDoc(new Y.Doc())
```

Delete these constructor lines (they move to `bindBranchDoc`):

```js
    // The chronology: every change with its diff and the task it was for (src/history.js).
    this.history = new HistoryLog(this.doc, this.doc.getArray('history'), { origin: LOCAL })
```

```js
    // "<name>\0<path>" -> { by, path, added, removed, edits, kind, ts }: what each
    // person has changed in this room, every edit counted. Each person writes
    // only their own keys, so there is nothing to merge.
    this.tallies = this.doc.getMap('changes')
```

```js
    this.merges = this.doc.getMap('merges') // id -> merge record (see merges.js)
```

After `log (msg) { ... }` add:

```js
  /**
   * Points the folder's file state at a branch document: files (path -> Y.Text), blobs
   * (path -> { hash, data } or { hash, size, stored: { id, key } }), fileKeys (keyId ->
   * { wraps, ts }: keys for large files, wrapped for editors and viewers), merges (merge
   * records, see merges.js), tallies ("<name>\0<path>" -> what each person changed, each
   * writing only their own keys) and the chronology (every change with its diff and task).
   */
  bindBranchDoc (doc) {
    this.bdoc = doc
    this.files = doc.getMap('files')
    this.blobs = doc.getMap('blobs')
    this.fileKeys = doc.getMap('fileKeys')
    this.merges = doc.getMap('merges')
    this.tallies = doc.getMap('changes')
    this.history = new HistoryLog(doc, doc.getArray('history'), { origin: LOCAL })
  }

  /** A change to this branch's files and the room's record of it, made together (each document sends its own update). */
  transact (fn, origin = LOCAL) { this.bdoc.transact(() => this.doc.transact(fn, origin), origin) }

  /** The relay's list of the session's branches. */
  setBranches (list) {
    this.branchList = (Array.isArray(list) ? list : []).filter((b) => b && typeof b.key === 'string')
    this.scheduleStatusWrite()
  }
```

- [ ] **Step 5: Join the branch git is on when the session starts**

In `start`, replace

```js
    if (hadState) this.loadClaims()

    this.conn = new Connection({
```

with

```js
    if (hadState) this.loadClaims()
    // Restarted on another branch, or mid-hold: nothing in this tree is the session's offline work (see resumeHold).
    const resumed = hadState && this.resumeHold()
    // The branch document this folder syncs: the branch it syncs in git (still the one it was paused off, until
    // the folder follows git), ∅ (the room's default) without git.
    this.branch = this.git ? this.git.key : (gitDir(this.root) && headRef(this.root)) || DEFAULT_KEY

    this.conn = new Connection({
```

and in the `Connection` options, after `doc: this.doc,` add:

```js
      // An app's saved document from before branch documents is the room's old one: the relay kept it as that branch's.
      // base: the commit a branch new to the session starts from (a partner without it locally creates it there).
      branch: { key: this.branch, doc: this.bdoc, ...(this.git && this.git.sha ? { base: this.git.sha } : {}), ...(this.legacyState && this.savedGit ? { adopt: this.savedGit.key } : {}) },
```

After `this.conn.on('members', (m) => this.setMembers(m))` add:

```js
    this.conn.on('branches', (list) => this.setBranches(list))
    this.conn.on('branch-joined', (r) => { if (typeof r.branch === 'string' && r.branch) { this.branch = r.branch; this.scheduleStatusWrite() } })
    this.conn.on('branch-refused', (why) => this.log(`⚠️ the relay refused this folder's branch: ${why}`))
```

Inside `if (hadState) {`, delete the line `const resumed = this.resumeHold()` (it now runs above).

- [ ] **Step 6: Watch the branch document apart from the room's**

In `goLive`, replace everything from `this.files.observeDeep((events, tr) => {` through the end of the `this.fileKeys.observe(() => { ... })` block with:

```js
    this.observeBranch()
```

and delete the line `this.merges.observe(() => { this.scheduleStatusWrite(); this.emit('merges', this.mergeList()) })`. After `goLive` add:

```js
  /** Watches the branch document: the room's changes to files reach the disk. Done again for each branch the folder moves to. */
  observeBranch () {
    this.files.observeDeep((events, tr) => {
      if (tr.origin === LOCAL) return
      const paths = new Set()
      for (const ev of events) {
        if (ev.target === this.files) for (const k of ev.changes.keys.keys()) paths.add(k)
        else if (ev.path.length) paths.add(ev.path[0])
      }
      this.applyRemote(paths)
    })
    this.blobs.observe((ev, tr) => {
      if (tr.origin === LOCAL) return
      const paths = [...ev.changes.keys.keys()]
      for (const k of paths) this.retry.delete(k)
      this.applyRemote(paths)
    })
    this.fileKeys.observe(() => {
      this.shareKeysWithViewers()
      // Files whose key just arrived can be downloaded now.
      for (const [rel, b] of this.blobs) if (b && b.stored && this.lastKnown.get(rel) !== `bin:${b.hash}`) this.writeOut(rel)
    })
    this.merges.observe(() => { this.scheduleStatusWrite(); this.emit('merges', this.mergeList()) })
    this.bdoc.on('update', () => this.scheduleStateSave())
  }
```

- [ ] **Step 7: Save and load both documents**

Replace `loadState` and `saveState` with:

```js
  loadState () {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(this.stateDir, 'state.json'), 'utf8'))
      if (meta.room !== this.room || meta.server !== this.server) return false
      // state.bin: the branch document this folder synced. From before branch documents it is the
      // room's one document, which the relay kept as that branch's (Room.migrateLegacy).
      Y.applyUpdate(this.bdoc, fs.readFileSync(this.stateFile), LOCAL)
      try { Y.applyUpdate(this.doc, fs.readFileSync(this.roomFile), LOCAL) } catch {} // none from before: the relay sends it
      this.legacyState = meta.layout !== 2
      this.storedOnDisk = new Map(Object.entries(meta.storedOnDisk || {}))
      this.known = meta.known ? new Map(Object.entries(meta.known)) : null
      // No gitKey (an older state file): taken as the branch the folder is on now.
      this.savedRole = typeof meta.role === 'string' ? meta.role : null
      this.savedGit = typeof meta.gitKey === 'string' && meta.gitKey ? { key: meta.gitKey, sha: typeof meta.gitSha === 'string' ? meta.gitSha : null, held: !!meta.gitHeld } : null
      return true
    } catch {
      return false
    }
  }
```

```js
  saveState () {
    clearTimeout(this.stateTimer)
    this.stateTimer = null
    const save = (file, doc) => { fs.writeFileSync(file + '.tmp', Y.encodeStateAsUpdate(doc)); fs.renameSync(file + '.tmp', file) }
    save(this.stateFile, this.bdoc)
    save(this.roomFile, this.doc)
    // Hashes of what we last wrote or read for each path: on the next start they
    // tell a file the room changed behind our back from one edited offline.
    const known = {}
    for (const [rel, key] of this.lastKnown) known[rel] = sha1(key)
    fs.writeFileSync(path.join(this.stateDir, 'state.json'), JSON.stringify({ room: this.room, server: this.server, layout: 2, branch: this.branch, storedOnDisk: Object.fromEntries(this.storedOnDisk), known, ...this.gitState(), ...this.roleState() }))
  }
```

In `status ()`, after `server: this.server,` add `branch: this.branch,`.

- [ ] **Step 8: Hosted agents and the link-based MCP use a branch document (`src/relay-mcp.js`)**

First, every claim request in `sessionTools` goes through a `who` that carries the branch (defined below):

```bash
sed -i '' 's/ctx\.who(room)/who(room)/g' src/relay-mcp.js
grep -c "who(room)" src/relay-mcp.js
```

Expected: 7.

In `sessionTools`, before `const tool = (name, def, fn) => ...` add:

```js
  // Files, claims and history are a branch's: the agent's own (hosted agents can choose one), or the session's active branch.
  const branchOf = (room) => ctx.branch ? ctx.branch(room) : room.activeBranch ? room.activeBranch() : null
```

Replace the `tool` helper with:

```js
  const tool = (name, def, fn) => server.registerTool(name, def, async (args) => stale(await ctx.withSession((room) => {
    const doc = room.doc
    const branch = room.branchDoc ? room.branchDoc(branchOf(room), { by: ctx.me }) : null
    const fdoc = branch ? branch.doc : doc
    const parts = { room, doc, fdoc, branch, feed: doc.getArray('agentFeed'), chat: doc.getArray('chat'), activity: doc.getArray('activity'), files: fdoc.getMap('files'), blobs: fdoc.getMap('blobs') }
    return queueNote(room, fn(args || {}, parts))
  })))
```

Change `const claimsOf = (room) => room.claimList ? room.claimList() : []` to:

```js
  const claimsOf = (room) => room.claimList ? room.claimList(branchOf(room)) : []
  // Claims are per branch: who the agent is, on the branch it works on.
  const who = (room) => ({ ...ctx.who(room), branch: branchOf(room) })
```

Change `const roomKey = (room) => room.id || room.name || ''` to:

```js
  const roomKey = (room) => `${room.id || room.name || ''}\0${branchOf(room)}` // claims held per branch
```

Replace `autoClaim` with:

```js
  const autoClaim = (room, rel) => {
    const key = `${roomKey(room)}\0${rel}`
    const branch = branchOf(room) // released on this branch, even if the agent has moved on since
    clearTimeout(autoHeld.get(key))
    if (!autoHeld.has(key)) {
      try { room.claimRequest({ ...who(room), talk: ctx.access(room)?.talk !== false }, { op: 'claim', pattern: rel, note: 'editing' }) } catch { return false }
      room.broadcastClaims()
    }
    const timer = setTimeout(() => {
      autoHeld.delete(key)
      if (!room.claimList(branch).some((c) => c.pattern === rel && c.by === me)) return
      try { room.claimRequest({ ...ctx.who(room), branch }, { op: 'release', pattern: rel }); room.broadcastClaims() } catch {}
    }, HOSTED_AUTO_CLAIM_QUIET_MS)
    if (timer.unref) timer.unref()
    autoHeld.set(key, timer)
    return true
  }
```

Replace `historyOf` with:

```js
  // One chronology writer per branch document, shared by every hosted agent's connection.
  const historyOf = (room) => {
    const b = room.branchDoc(branchOf(room), { by: me })
    if (!b.historyLog) b.historyLog = new HistoryLog(b.doc, b.doc.getArray('history'), { origin: AGENT })
    return b.historyLog
  }
```

In `quilt_write_file`, change the handler's parameters to `({ path: p, content }, { room, doc, fdoc, branch, files, blobs, activity })` and the transaction to:

```js
    fdoc.transact(() => doc.transact(() => {
      existed = files.has(rel) || blobs.has(rel)
      blobs.delete(rel)
      let ytext = files.get(rel)
      if (!ytext) { ytext = new Y.Text(); files.set(rel, ytext) }
      const before = ytext.toString()
      detail = applyTextDiff(ytext, content)
      const kind = existed ? 'edited' : 'created'
      activity.push([{ by: me, path: rel, kind, detail, ...(branch ? { branch: branch.key } : {}), ts: Date.now() }])
      if (activity.length > ACTIVITY_CAP) activity.delete(0, activity.length - ACTIVITY_CAP)
      historyOf(room).record({ by: me, path: rel, kind, before, after: content, task: currentTask(readTasks(taskMap(doc)), me) })
    }, AGENT), AGENT)
```

- [ ] **Step 9: Chat links add files on the active branch (`src/chat-links.js`)**

In `class ChatPage`, after the constructor add:

```js
  /** Chat links have no branch of their own: files are the session's active branch's. */
  get branch () { return this._branch || (this._branch = this.room.branchDoc(this.room.activeBranch(), { by: this.me })) }
  get bdoc () { return this.branch.doc }
```

Then:

```bash
sed -i '' "s/this\.doc\.getMap('files')/this.bdoc.getMap('files')/g; s/this\.doc\.getMap('blobs')/this.bdoc.getMap('blobs')/g" src/chat-links.js
```

Change `const claim = (this.room.claimList ? this.room.claimList() : [])` to `const claim = (this.room.claimList ? this.room.claimList(this.branch.key) : [])`. In `place`, replace from `const history = this.room.historyLog || ...` to the end of the transaction with:

```js
    const history = this.branch.historyLog || (this.branch.historyLog = new HistoryLog(this.bdoc, this.bdoc.getArray('history'), { origin: ORIGIN }))
    const detail = kind.text ? `${buf.toString('utf8').split('\n').length} lines` : `${buf.length} bytes`
    this.bdoc.transact(() => this.doc.transact(() => {
      if (kind.text) {
        const t = new Y.Text()
        t.insert(0, buf.toString('utf8'))
        files.set(rel, t)
      } else {
        blobs.set(rel, { hash: crypto.createHash('sha1').update(buf).digest('hex'), data: buf.toString('base64') })
      }
      activity.push([{ by: this.me, path: rel, kind: 'created', detail, branch: this.branch.key, ts: Date.now() }])
      if (activity.length > ACTIVITY_CAP) activity.delete(0, activity.length - ACTIVITY_CAP)
      history.record({ by: this.me, path: rel, kind: 'created', detail, ...(kind.text ? { before: '', after: buf.toString('utf8') } : {}) })
    }, ORIGIN), ORIGIN)
```

(`files`/`blobs` above it already read `this.bdoc` after the sed.)

- [ ] **Step 10: Run the test and the suite**

Run: `node --test test/branch-docs-session.test.js`
Expected: PASS, 4 tests.
Run: `npm test 2>&1 | tail -5`
Expected: only the two known failures. Tests that poke `X.doc.transact(() => X.files.get(...))` still work: the text's own document takes the change.

- [ ] **Step 11: Commit**

```bash
git add src/session.js src/relay-mcp.js src/chat-links.js test/branch-docs-session.test.js
git commit -m "Sessions keep the room's document and their branch's apart; hosted agents and chat links work on a branch" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 6: Switching a folder to another branch

**Files:**
- Modify: `src/session.js` (imports; constructor `:197`; `start` `:305-312`; `flushPending` `:954-960`; `held` `:991`; `settleBurst` `:1068-1074, :1110-1112`; `headless` `:1132-1137`; `logSwitch` `:1178-1180` (delete); `onSettled` `:1254-1259`; `resumeHold` `:1424`; `checkBackOnBranch` `:1439-1457` (delete); `retryFailed` `:2027`; `startWatcher` `:2266-2269`; new methods after `untouchedHere`)
- Modify: `test/git-awareness.test.js` (the phase 1 pause tests at `:281`, `:296`, `:336`, `:454`, `:487`, `:543`)
- Test: `test/branch-switch.test.js`

**Interfaces:**
- Consumes: `park`, `parkedRef`, `clear`, `switchTo`, `startBranch`, `localBranches`, `busyRefusal` (task 1); `checkBranchName` (git.js); `validBranchKey`, `DEFAULT_KEY` (branchdocs.js); `Connection.confirmBranch/joinBranch/waitForBranchSync/branchRequest` (task 3); `treeState`, `filesAt`, `headKey`, `indexStamp`, `stashStamp` (gitstate.js).
- Produces (Session): `switchBranch(target, { create = false }) → Promise<{ branch, how: 'already'|'local'|'remote'|'created'|'new'|'followed', note }>`, `followHead(key)`, `moveTo(to, { mode: 'switch'|'new'|'followed' })`, `finishMove(m)`, `arrive({ created }) → entries[]`, `carriedFrom(oldKeys, fromSha) → string[]`, `writeBackAll(rels)`, `branchStateDir(key)`, `parkLocalState(key)`, `unparkLocalState(key, doc)`, `refreshLocalBranches()`, `announceBranch()`, `removeBranch(key)`, `moveNote({ from, to, how, mode })`; fields `switching`, `following`, `arriving`, `resumeAway`, `pendingMove`; event `branch`. Parked branches' local state: `.quilt/branches/<base64url(key)>/{state.bin,claims.json}`. Activity entry `{ by, path: '', kind: 'switched', detail: '', branch, from, ts }`.
- Removes: `logSwitch`, `checkBackOnBranch`, `checkingBack` (a folder on another branch no longer pauses: it moves).

- [ ] **Step 1: Write the failing test**

Create `test/branch-switch.test.js`:

```js
// Switching a folder between the session's branches, with a real relay and
// real git: the folder is cleared of one branch's work (kept in the room and in
// refs/quilt/parked/<branch>) and loaded with the other's, never a mix. A switch
// made in git ends where the same switch from the menu does.
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
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-bs-${n}-`))
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV }).trim()
async function waitFor (fn, ms = 8000) {
  const start = Date.now(); let last
  while (Date.now() - start < ms) { try { last = await fn(); if (last) return last } catch (e) { last = e }; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error(`timed out; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}
async function never (fn, ms = 1500) {
  const start = Date.now()
  while (Date.now() - start < ms) { assert.ok(!(await fn()), 'happened but must not'); await new Promise((r) => setTimeout(r, 25)) }
}
process.env.HOME = process.env.USERPROFILE = tmp('home')
const ids = new Map()
const identityOf = (n) => { if (!ids.has(n)) ids.set(n, generateIdentity()); return ids.get(n) }
const stopped = new Set()
const close = async (s) => { if (!stopped.has(s)) { stopped.add(s); await s.stop() } }
async function open (t, dir, name, extra) {
  const s = new Session({ dir, server, secret: 'pw', name, identity: identityOf(name), ...extra })
  t.after(() => close(s))
  if (process.env.BS_DEBUG) s.on('log', (m) => console.error(`[${name}] ${m}`))
  await s.start({ waitTimeoutMs: 5000 })
  s.setAgentState({ tool: s.tool, status: 'idle' }) // people typing by hand
  return s
}
let rooms = 0
const MAIN_APP = 'app\n'

/** A remote with main (README.md, src/app.js) and feature-x (adds feature.txt, changes README.md); alice and bob on main in one room. */
async function repos (t) {
  const bare = tmp('bare'); git(bare, 'init', '-q', '--bare', '-b', 'main')
  const seed = tmp('seed'); git(seed, 'clone', '-q', bare, '.')
  write(seed, 'README.md', 'hello\n'); write(seed, 'src/app.js', MAIN_APP)
  git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'one'); git(seed, 'push', '-q', 'origin', 'main')
  git(seed, 'checkout', '-qb', 'feature-x'); write(seed, 'README.md', 'feature readme\n'); write(seed, 'feature.txt', 'feature\n')
  git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'f'); git(seed, 'push', '-q', 'origin', 'feature-x')
  const dirA = tmp('a'); git(dirA, 'clone', '-q', bare, '.')
  const dirB = tmp('b'); git(dirB, 'clone', '-q', bare, '.')
  const room = `bs${++rooms}`
  const A = await open(t, dirA, 'alice', { room })
  const B = await open(t, dirB, 'bob', { room })
  await waitFor(() => A.status().connected && B.status().connected)
  return { A, B, dirA, dirB, bare, room }
}

before(async () => { srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, maxNewRoomsPerHour: 0 }); server = `ws://127.0.0.1:${srv.port}` })
after(async () => { await srv.close() })

test('a switch moves one folder to the branch\'s document; the two branches never mix', async (t) => {
  const { A, B, dirA, dirB } = await repos(t)
  write(dirA, 'README.md', 'main work\n')
  await waitFor(() => read(dirB, 'README.md') === 'main work\n')
  const r = await A.switchBranch('feature-x')
  assert.equal(r.branch, 'feature-x')
  assert.equal(git(dirA, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature-x')
  assert.equal(read(dirA, 'feature.txt'), 'feature\n')
  assert.equal(read(dirA, 'README.md'), 'feature readme\n', 'main\'s uncommitted work is not on feature-x')
  assert.ok(A.logs.some((l) => l.includes("You're on feature-x now")), A.logs.join('\n'))
  assert.equal(A.status().git.hold, null)
  write(dirB, 'src/app.js', 'main edit\n')
  write(dirA, 'feature.txt', 'feature edit\n')
  await never(() => read(dirA, 'src/app.js') === 'main edit\n' || read(dirB, 'feature.txt') !== null, 2000)
  assert.equal(B.status().branch, 'main')
  assert.equal(read(dirB, 'README.md'), 'main work\n', 'main keeps its work')
})

test('two folders on the same branch pair live there', async (t) => {
  const { A, B, dirA, dirB } = await repos(t)
  await A.switchBranch('feature-x')
  write(dirA, 'feature.txt', 'from alice\n')
  await waitFor(() => A.files.get('feature.txt')?.toString() === 'from alice\n')
  await B.switchBranch('feature-x')
  await waitFor(() => read(dirB, 'feature.txt') === 'from alice\n')
  write(dirB, 'feature.txt', 'from bob\n')
  await waitFor(() => read(dirA, 'feature.txt') === 'from bob\n')
})

test('switching back brings the room\'s work on main, including edits made while away', async (t) => {
  const { A, B, dirA, dirB } = await repos(t)
  await A.switchBranch('feature-x')
  write(dirB, 'README.md', 'bob on main\n')
  await waitFor(() => B.files.get('README.md')?.toString() === 'bob on main\n')
  await A.switchBranch('main')
  await waitFor(() => read(dirA, 'README.md') === 'bob on main\n')
  assert.equal(read(dirA, 'feature.txt'), null)
  assert.equal(A.status().branch, 'main')
})

test('uncommitted work is in the room and in refs/quilt/parked before the folder is cleared, and git did not refuse', async (t) => {
  const { A, dirA } = await repos(t)
  write(dirA, 'src/app.js', 'unsaved idea\n'); write(dirA, 'notes.txt', 'new file\n')
  await waitFor(() => A.files.get('notes.txt')?.toString() === 'new file\n' && A.files.get('src/app.js')?.toString() === 'unsaved idea\n')
  await A.switchBranch('feature-x')
  assert.equal(read(dirA, 'notes.txt'), null)
  assert.equal(read(dirA, 'src/app.js'), MAIN_APP)
  const parked = git(dirA, 'rev-parse', 'refs/quilt/parked/main')
  assert.equal(git(dirA, 'show', `${parked}:src/app.js`), 'unsaved idea')
  assert.equal(git(dirA, 'show', `${parked}:notes.txt`), 'new file')
  assert.equal(git(dirA, 'stash', 'list'), '')
  await A.switchBranch('main')
  assert.equal(read(dirA, 'src/app.js'), 'unsaved idea\n')
  assert.equal(read(dirA, 'notes.txt'), 'new file\n')
})

test('a branch this repo and its remote haven\'t got starts from where the session\'s began; the log says it isn\'t pushed', async (t) => {
  const { A, B, dirA, dirB } = await repos(t)
  const base = git(dirA, 'rev-parse', 'HEAD')
  await A.switchBranch('spike', { create: true })
  write(dirA, 'spike.txt', 'idea\n')
  await waitFor(() => A.files.get('spike.txt')?.toString() === 'idea\n')
  await waitFor(() => B.branchList.some((b) => b.key === 'spike'))
  await B.switchBranch('spike')
  assert.equal(git(dirB, 'rev-parse', 'HEAD'), base)
  assert.equal(read(dirB, 'spike.txt'), 'idea\n')
  assert.ok(B.logs.some((l) => l.includes("spike isn't pushed yet, so git shows alice's work there as changes")), B.logs.join('\n'))
})

test('New branch starts from this folder\'s work and puts it in the session; main keeps it too', async (t) => {
  const { A, B, dirA, dirB } = await repos(t)
  write(dirA, 'src/app.js', 'wip\n')
  await waitFor(() => read(dirB, 'src/app.js') === 'wip\n')
  const r = await A.switchBranch('try-it', { create: true })
  assert.equal(r.how, 'new')
  assert.equal(git(dirA, 'rev-parse', '--abbrev-ref', 'HEAD'), 'try-it')
  assert.equal(read(dirA, 'src/app.js'), 'wip\n')
  await waitFor(() => A.branchList.some((b) => b.key === 'try-it'))
  write(dirA, 'src/app.js', 'wip 2\n')
  await never(() => read(dirB, 'src/app.js') !== 'wip\n', 1500)
  await assert.rejects(A.switchBranch('main', { create: true }), /main already exists: switch to it instead/)
})

test('a switch made in git ends where the same switch from the menu does', async (t) => {
  const { A, B, dirA, dirB } = await repos(t)
  write(dirA, 'src/app.js', 'main work\n')
  await waitFor(() => read(dirB, 'src/app.js') === 'main work\n')
  await A.switchBranch('feature-x')
  git(dirB, 'checkout', '-q', 'feature-x') // git carries src/app.js's change over
  await waitFor(() => B.status().branch === 'feature-x' && B.status().git.hold === null, 10000)
  assert.ok(B.logs.some((l) => l.includes("You're on feature-x now (you switched in git)")), B.logs.join('\n'))
  assert.equal(git(dirB, 'rev-parse', 'HEAD'), git(dirA, 'rev-parse', 'HEAD'))
  for (const rel of ['README.md', 'src/app.js', 'feature.txt']) assert.equal(read(dirB, rel), read(dirA, rel), rel)
  assert.equal(read(dirB, 'src/app.js'), MAIN_APP, 'main\'s work carried by git went back to the commit')
  assert.equal(git(dirB, 'show', 'refs/quilt/parked/main:src/app.js'), 'main work')
})

test('a switch while git is mid-merge is refused and changes nothing', async (t) => {
  const { A, dirA } = await repos(t)
  fs.writeFileSync(path.join(dirA, '.git', 'MERGE_HEAD'), git(dirA, 'rev-parse', 'HEAD') + '\n')
  await assert.rejects(A.switchBranch('feature-x'), /Finish the git merge first/)
  assert.equal(git(dirA, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
  assert.equal(A.status().branch, 'main')
  fs.rmSync(path.join(dirA, '.git', 'MERGE_HEAD'))
})

test('when git refuses the switch, the folder stays on its branch with its work back on disk', async (t) => {
  const { A, B, dirA, dirB } = await repos(t)
  git(dirA, 'worktree', 'add', '-q', tmp('wt'), '-b', 'taken')
  write(dirA, 'src/app.js', 'keep me\n')
  await waitFor(() => read(dirB, 'src/app.js') === 'keep me\n')
  await assert.rejects(A.switchBranch('taken'), /Couldn't switch to taken/)
  assert.equal(read(dirA, 'src/app.js'), 'keep me\n')
  assert.equal(A.status().branch, 'main')
  assert.equal(A.status().git.hold, null)
  await never(() => read(dirB, 'src/app.js') !== 'keep me\n', 1500)
  write(dirA, 'src/app.js', 'still live\n')
  await waitFor(() => read(dirB, 'src/app.js') === 'still live\n')
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/branch-switch.test.js`
Expected: FAIL: `A.switchBranch is not a function`.

- [ ] **Step 3: Imports and fields (`src/session.js`)**

Change `import { DEFAULT_KEY } from './branchdocs.js'` to:

```js
import { DEFAULT_KEY, validBranchKey } from './branchdocs.js'
import { park, parkedRef, clear, switchTo, startBranch, localBranches, busyRefusal } from './gitswitch.js'
import { checkBranchName } from './git.js'
```

Replace the constructor line

```js
    this.checkingBack = false // a look at HEAD while switched away is queued (checkBackOnBranch)
```

with

```js
    this.switching = null // the branch a switch asked for here is moving this folder to (switchBranch)
    this.following = null // the branch git moved HEAD to, which the folder is following (followHead)
    this.arriving = false // a move is writing the new branch onto the folder: held, but its own writes go through
    this.resumeAway = null // started on another branch than the one saved: followed once the relay has synced
    this.pendingMove = null // a move whose new branch the relay couldn't load yet: tried again on reconnecting
```

Change `held ()` to:

```js
  /** Whether the folder's sync is held: git is at work on it, or a burst of changes is being classified. (A move's own writes go through: arrive.) */
  held () { return !!((this.hold && !this.arriving) || this.classifying) }
```

- [ ] **Step 4: A switch made in git moves the folder instead of pausing it**

In `flushPending`, replace

```js
      if (this.hold.kind === 'switching') this.checkBackOnBranch() // in case the watcher missed the way back
      // Only a change here puts the settle off: the flush before each update from the room
      // (beforeRemote) has none, and a partner typing must not hold this folder for good.
      else if (paths.length) this.settleSoon()
```

with

```js
      // Only a change here puts the settle off: the flush before each update from the room
      // (beforeRemote) has none, and a partner typing must not hold this folder for good.
      // A move to another branch ends on its own (moveTo).
      if (paths.length && this.hold.kind !== 'switching') this.settleSoon()
```

In `settleBurst`, replace

```js
      if (this.hold.kind === 'switching') this.checkBackOnBranch()
      else this.settleSoon()
```

with

```js
      if (this.hold.kind !== 'switching') this.settleSoon()
```

and replace

```js
    } else if (r.kind === 'switch') {
      this.setHold('switching', { prevHead: r.prevHead, to: r.head.key })
      this.logSwitch(r.head.key)
    } else { // discard, advance
```

with

```js
    } else if (r.kind === 'switch') {
      this.followHead(r.head.key)
    } else { // discard, advance
```

In `headless`, replace

```js
      for (const rel of paths) this.heldPaths.add(rel)
      this.setHold('switching', { to: ref })
      this.logSwitch(ref)
      return
```

with

```js
      for (const rel of paths) this.heldPaths.add(rel)
      this.followHead(ref)
      return
```

Delete `logSwitch (key) { ... }` and the whole `checkBackOnBranch () { ... }` method with its comment.

In `onSettled`, replace

```js
    if (this.git && head.key !== this.git.key) {
      // Landed on another branch while settling: pause instead.
      this.setHold('switching', { to: head.key })
      this.logSwitch(head.key)
      return
    }
```

with

```js
    if (this.git && head.key !== this.git.key) {
      // Landed on another branch while settling: the folder follows it there.
      this.followHead(head.key)
      return
    }
```

In `resumeHold`, change `if (away) this.logSwitch(at)` to `if (away) this.resumeAway = at`.

In `start`, replace

```js
        synced.then(() => { this.holdAwaitsSync = false; this.settleSoon() }, () => {})
```

with

```js
        synced.then(() => {
          this.holdAwaitsSync = false
          // Restarted on another branch: the folder follows git there, now that it has the room's work on the old one.
          if (this.resumeAway) this.followHead(this.resumeAway)
          else this.settleSoon()
        }, () => {})
```

In `startWatcher`, delete the line `if (this.hold && this.hold.kind === 'switching') this.checkBackOnBranch()` inside the `watchGit` callback, and replace

```js
      if (this.hold && this.hold.kind === 'switching') this.checkBackOnBranch() // back before the watcher started?
      else this.settleSoon() // a hold resumed at start ends once the tree has settled
```

with

```js
      if (!this.hold || this.hold.kind !== 'switching') this.settleSoon() // a hold resumed at start ends once the tree has settled
      this.refreshLocalBranches()
```

In `retryFailed`, after `if (!this.ready || this.stopped) return` add:

```js
    if (this.pendingMove && this.conn.connected) this.gitTask(() => this.pendingMove && this.finishMove(this.pendingMove)).catch(() => {})
```

- [ ] **Step 5: The move itself**

After `untouchedHere (rel) { ... }` add:

```js
  // ------------------------------------------------------------ branches --
  // A folder is on one branch of the session at a time. Moving it (the branch
  // menu, quilt_switch_branch, or a switch made in git) clears the old branch's
  // work off the disk, kept in the room and in refs/quilt/parked/<branch>, and
  // writes the new branch's. Nothing is synced branch on branch.

  /**
   * Moves this folder to branch `target` (the menu, quilt_switch_branch): see moveTo. `create`:
   * a new branch from this folder's work (New branch…). Only this folder moves; everyone
   * working in it moves with it, nobody else does.
   */
  async switchBranch (target, { create = false } = {}) {
    target = String(target || '').trim()
    if (!this.git && !gitDir(this.root)) throw new Error("This folder isn't a git repository, so it has no branches to switch between.")
    if (create) target = await checkBranchName(target)
    else if (!validBranchKey(target) || target === DEFAULT_KEY) throw new Error(`"${target}" isn't a branch name.`)
    if (!create && target === this.branch) return { branch: target, how: 'already', note: `You're already on ${target}.` }
    if (create && (target === this.branch || this.branchList.some((b) => b.key === target) || this.localBranches.includes(target))) throw new Error(`${target} already exists: switch to it instead.`)
    const busy = this.gitBusy()
    if (busy) throw new Error(busyRefusal(busy))
    if (this.switching || this.following) throw new Error(`Already switching to ${this.switching || this.following}.`)
    if (this.held()) throw new Error('Quilt is catching up with git in this folder; try again in a moment.')
    if (this.merging.size) throw new Error('Quilt is still merging changes made while you were away; try again in a moment.')
    if (!this.conn || !this.conn.connected) throw new Error('Switching branches needs the relay: wait until this folder reconnects.')
    this.switching = target
    try {
      return await this.gitTask(() => this.moveTo(target, { mode: create ? 'new' : 'switch' }))
    } finally { this.switching = null }
  }

  /** git moved HEAD to another branch (a terminal checkout, or while Quilt was stopped): the folder follows, as a menu switch would. */
  followHead (to) {
    if (!to || to === this.branch || this.following === to || this.switching) return
    this.following = to
    this.setHold('switching', { to }) // nothing more is shared on the old branch from here
    this.gitTask(() => this.moveTo(to, { mode: 'followed' }))
      .catch((err) => this.emit('debug', `following git to ${to}: ${err.message}`))
      .finally(() => { this.following = null })
  }

  /**
   * Moves this folder to branch `to`: 'switch' (the menu), 'new' (a new branch from this
   * folder's work) or 'followed' (git already moved HEAD). 1. Every change on the branch it
   * leaves is confirmed in the room. 2. A copy of the uncommitted work goes to
   * refs/quilt/parked/<branch>, and the session's files go back to HEAD (after a switch made
   * in git, only what git carried over). 3. git switches. 4-7: finishMove. Runs as git work.
   */
  async moveTo (to, { mode = 'switch' } = {}) {
    const from = this.branch
    const fromSha = this.git ? this.git.sha : null
    const oldKeys = new Map() // path -> the old branch's version (as lastKnown keys it), for putting back or telling carried work apart
    for (const rel of this.sharedPaths()) if (this.syncable(rel)) oldKeys.set(rel, this.sharedKey(rel) ?? null)
    if (mode !== 'followed') this.flushPending() // edits not shared yet land on `from` first
    this.setHold('switching', { to })
    let cleared = false
    let how = mode === 'switch' ? 'local' : mode
    try {
      // After a switch made in git there's no going back: what hasn't reached the relay stays in `from`'s saved document.
      try { await this.conn.confirmBranch() } catch (err) { if (mode !== 'followed') throw err }
      await this.releaseAutoClaims() // claims that followed edits on `from` don't come along
      if (mode !== 'new' && await park(this.root, from)) this.log(`📦 A copy of your uncommitted work on ${from} is in git at ${parkedRef(from)}.`)
      if (mode === 'switch') { cleared = true; await clear(this.root, [...oldKeys.keys()]) }
      if (mode === 'followed') await clear(this.root, await this.carriedFrom(oldKeys, fromSha))
      if (mode === 'switch') how = (await switchTo(this.root, to, { base: this.branchList.find((b) => b.key === to)?.base || null })).how
      if (mode === 'new') await startBranch(this.root, to)
    } catch (err) {
      if (mode === 'followed') {
        // git has moved and Quilt couldn't follow: held, so nothing of `to` reaches `from`, until the next start.
        this.log(`⚠️ Couldn't move this folder to ${to} (${err.message}); it stays paused until Quilt restarts.`)
        throw err
      }
      const late = [...this.heldPaths]
      this.heldPaths.clear()
      this.releaseHold()
      if (cleared) this.writeBackAll([...oldKeys.keys()]) // git said no: the folder stays on `from`, its work put back
      this.requeue(late.filter((rel) => this.syncable(rel) && !this.untouchedHere(rel)))
      const msg = `Couldn't ${mode === 'new' ? 'start' : 'switch to'} ${to}: ${err.message}`
      this.log(`⚠️ ${msg}. You're still on ${from}.`)
      throw new Error(msg)
    }
    // The branch this folder leaves keeps its document and claims here; the new one's comes from the room.
    const head = await headKey(this.root)
    this.parkLocalState(from)
    const doc = new Y.Doc()
    this.unparkLocalState(to, doc)
    return this.finishMove({ from, to, doc, head, how, mode })
  }

  /** 4. Join the new branch's document, 5. write it onto the folder, 6. go live and say so. Tried again on reconnecting when the relay can't load it yet. */
  async finishMove (m) {
    const { from, to, doc, head, how, mode } = m
    let reply
    try {
      reply = await this.conn.joinBranch(to, doc, head && head.sha ? { base: head.sha } : {})
      await this.conn.waitForBranchSync()
    } catch (err) {
      if (!this.pendingMove) this.log(`⚠️ You're on ${to} in git, but its work in the session can't be loaded yet (${err.message}). This folder waits and tries again.`)
      this.pendingMove = m
      throw err
    }
    this.pendingMove = null
    const old = this.bdoc
    this.bindBranchDoc(doc)
    old.destroy()
    this.branch = reply.branch
    this.git = head || { key: to, branch: to, sha: null } // a branch with no commits yet has no sha
    this.gitSeen = this.git
    this.observeBranch()
    this.announceBranch()
    let entries = []
    try { entries = await this.arrive({ created: reply.created }) } finally {
      // What git and the move wrote is accounted for: the next flush is an edit unless git moves again.
      const late = [...this.heldPaths]
      this.heldPaths.clear()
      this.releaseHold()
      this.gitIndex = indexStamp(this.root)
      this.headChangedAt = 0
      this.stashSeen = stashStamp(this.root)
      this.scanDisk({ baseline: true })
      this.requeue(late.filter((rel) => this.syncable(rel) && !this.untouchedHere(rel)))
    }
    if (entries.length) {
      this.mergeHeld(entries).then(({ conflicts }) => {
        if (conflicts) this.log(`🔀 ${conflicts} file${conflicts === 1 ? '' : 's'} you changed on ${to} clash with the session's; see Merges.`)
      }).catch((err) => this.log(`could not merge: ${err.message}`))
    }
    this.refreshPull()
    this.refreshLocalBranches()
    this.saveStateNow()
    const note = this.moveNote({ from, to: this.branch, how, mode })
    this.log(`🔀 ${note}`)
    // Agents working in this folder hear it with their next answer; the room sees it in the activity log.
    this.notice(`${this.name} switched this folder to ${this.branch}: its files are ${this.branch}'s now.`)
    this.doc.transact(() => {
      this.activity.push([{ by: this.name, path: '', kind: 'switched', detail: '', branch: this.branch, from, ts: Date.now() }])
      if (this.activity.length > 300) this.activity.delete(0, this.activity.length - 300)
    }, LOCAL)
    this.emit('branch', this.branch)
    this.scheduleStatusWrite()
    return { branch: this.branch, how, note }
  }

  /**
   * Writes the branch document onto a folder git has just put on that branch. A new (or
   * empty) document is seeded from the folder instead. A path git shows as changed (an edit
   * made on this branch while Quilt wasn't looking) is merged into the document against
   * HEAD's version: returned as entries for mergeHeld. Paths HEAD has that the document
   * hasn't are left as git has them.
   */
  async arrive ({ created }) {
    this.lastKnown.clear()
    this.storedOnDisk.clear()
    this.known = null
    this.arriving = true
    try {
      if (created || (!this.files.size && !this.blobs.size)) {
        // What the folder brings to the room is its starting point, not a change anyone made.
        this.seeding = true
        try { for (const rel of walk(this.root, this.ig)) this.ingest(rel) } finally { this.seeding = false }
        return []
      }
      const tree = await treeState(this.root, [])
      const dirty = tree ? [...tree.dirty].filter((rel) => this.syncable(rel)) : []
      const bases = this.git && this.git.sha && dirty.length ? await filesAt(this.root, this.git.sha, dirty) : null
      const changed = new Set(dirty)
      for (const rel of this.sharedPaths()) {
        if (!this.syncable(rel) || changed.has(rel)) continue
        const disk = this.readDisk(rel)
        if (disk && (disk.skip || disk.tooLarge)) continue
        if (disk) this.lastKnown.set(rel, disk.key) // git's version: replaced without a copy (git has it)
        this.tryWrite(rel)
      }
      const entries = dirty.map((rel) => ({ rel, base: bases ? bases.get(rel) ?? undefined : undefined, via: 'hold' }))
      for (const e of entries) this.merging.add(e.rel)
      return entries
    } finally { this.arriving = false }
  }

  /**
   * After a switch made in git: the paths git carried over from the old branch, which are
   * that branch's work (the room has it): on disk is the old document's version, and it
   * differs from the old HEAD's. Other changes (made on the new branch) stay, and merge.
   */
  async carriedFrom (oldKeys, fromSha) {
    const tree = await treeState(this.root, [])
    if (!tree) return []
    const dirty = [...tree.dirty].filter((rel) => this.syncable(rel))
    const was = fromSha && dirty.length ? await filesAt(this.root, fromSha, dirty) : null
    return dirty.filter((rel) => {
      const disk = this.readDisk(rel)
      if (disk && (disk.skip || disk.tooLarge)) return false
      const here = disk ? disk.key : null
      const doc = oldKeys.has(rel) ? oldKeys.get(rel) : null
      const head = was ? was.get(rel) : undefined // undefined: git couldn't read it
      return here === doc && head !== doc
    })
  }

  /** A switch git refused: the session's files of the branch the folder stays on go back on disk (clear had put them back to HEAD). */
  writeBackAll (rels) {
    for (const rel of rels) {
      const disk = this.readDisk(rel)
      if (disk && (disk.skip || disk.tooLarge)) continue
      if (disk) this.lastKnown.set(rel, disk.key); else this.lastKnown.delete(rel)
      this.tryWrite(rel)
    }
  }

  /** Where the saved state of branch `key` waits while this folder is on another branch. */
  branchStateDir (key) { return path.join(this.stateDir, 'branches', Buffer.from(key, 'utf8').toString('base64url')) }

  /** Keeps the branch this folder leaves: its document as this app has it (anything the relay hasn't got yet included) and its claims. */
  parkLocalState (key) {
    const dir = this.branchStateDir(key)
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'state.bin'), Y.encodeStateAsUpdate(this.bdoc))
      fs.writeFileSync(path.join(dir, 'claims.json'), JSON.stringify([...this.claims.values()]))
    } catch (err) { this.log(`could not keep ${key}'s state: ${err.message}`) }
  }

  /** The saved document of a branch this folder was on before (into `doc`), and its claims until the relay sends them. */
  unparkLocalState (key, doc) {
    const dir = this.branchStateDir(key)
    try { Y.applyUpdate(doc, fs.readFileSync(path.join(dir, 'state.bin')), LOCAL) } catch {}
    this.claims = new Map()
    try { for (const c of JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8'))) this.claims.set(c.pattern, c) } catch {}
    fs.rmSync(dir, { recursive: true, force: true }) // the folder's own state from here (state.bin, claims.json)
  }

  /** This repo's branches, for the branch menu's Other branches. */
  refreshLocalBranches () {
    if (!gitDir(this.root)) return
    localBranches(this.root).then((list) => { this.localBranches = list; this.scheduleStatusWrite() }, () => {})
  }

  /** Partners see which branch this folder is on (presence). */
  announceBranch () {
    if (this.conn && this.conn.awareness.getLocalState()) this.conn.awareness.setLocalStateField('branch', this.branch)
  }

  /** Session owner: takes a branch out of the session (its document; never the git branch). */
  async removeBranch (key) {
    key = String(key || '')
    if (key === this.branch) throw new Error(`You're on ${key}: switch to another branch first.`)
    await this.conn.branchRequest({ op: 'remove', branch: key })
    fs.rmSync(this.branchStateDir(key), { recursive: true, force: true })
    return { removed: key }
  }

  /** What a move says, in the log and to whoever asked for it. */
  moveNote ({ from, to, how, mode }) {
    if (mode === 'new') return `You started ${to} from your work on ${from}; it's in the session now.`
    if (how === 'created') {
      const b = this.branchList.find((x) => x.key === to)
      const whose = b && b.by && b.by !== this.name ? `${b.by}'s work` : "the session's work"
      return `You're on ${to} now. ${to} isn't pushed yet, so git shows ${whose} there as changes.`
    }
    return `You're on ${to} now${mode === 'followed' ? ' (you switched in git)' : ''}; the session's work there is on disk.`
  }
```

Also in `start`, change the `branch-joined` listener from task 5 to announce the branch:

```js
    this.conn.on('branch-joined', (r) => { if (typeof r.branch === 'string' && r.branch) { this.branch = r.branch; this.announceBranch(); this.scheduleStatusWrite() } })
```

- [ ] **Step 6: Run the new test**

Run: `node --test test/branch-switch.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 7: Rewrite the phase 1 pause tests in `test/git-awareness.test.js`**

Delete the tests `'git at work on the other branch keeps the pause as it is, said once; the hold is in state.json at once'` and `'while paused on another branch, a save asks no git (only .git/HEAD is read)'` (there is no pause any more).

Replace the test `'checking out another branch pauses that folder; coming back resumes and merges'` with:

```js
test('checking out another branch moves that folder to its document; coming back brings back main\'s work', async (t) => {
  const { B, dirA, dirB } = await pairRepos(t)
  write(dirA, 'README.md', 'main work\n')
  await waitFor(() => read(dirB, 'README.md') === 'main work\n')
  git(dirB, 'checkout', '-qb', 'feature') // git carries README.md's change over
  await waitFor(() => B.status().branch === 'feature' && B.status().git.hold === null, 10000)
  assert.ok(B.logs.some((l) => l.includes("You're on feature now (you switched in git)")), B.logs.join('\n'))
  assert.equal(read(dirB, 'README.md'), 'hello\n', 'main\'s work stays on main')
  write(dirB, 'src/app.js', 'feature work\n')
  write(dirA, 'README.md', 'main work 2\n')
  await never(() => read(dirA, 'src/app.js') === 'feature work\n', 2000)
  await never(() => read(dirB, 'README.md') === 'main work 2\n', 500)
  git(dirB, 'checkout', '-q', 'main') // carries feature's src/app.js over: it goes back too
  await waitFor(() => B.status().branch === 'main' && B.status().git.hold === null, 10000)
  await waitFor(() => read(dirB, 'README.md') === 'main work 2\n' && read(dirB, 'src/app.js') === 'line1\nline2\nline3\nline4\nline5\n')
  assert.equal(git(dirB, 'show', 'refs/quilt/parked/feature:src/app.js'), 'feature work')
})
```

Replace `'stopped while paused on another branch: the next start stays paused, then resumes on the way back'` with:

```js
test('stopped on main, restarted on another branch: the folder moves there, and main\'s room work never lands on it', async (t) => {
  const { A, B, dirA, dirB, room } = await pairRepos(t)
  write(dirA, 'README.md', 'main work\n')
  await waitFor(() => read(dirB, 'README.md') === 'main work\n')
  await close(B)
  git(dirB, 'checkout', '-qb', 'feature') // carries README.md's change over
  write(dirB, 'src/app.js', 'feature work\n') // an edit on feature while Quilt was stopped
  write(dirA, 'src/app.js', 'line1\nline2 (alice, meanwhile)\nline3\nline4\nline5\n')
  const B2 = await open(t, dirB, 'bob', { room })
  await waitFor(() => B2.status().branch === 'feature' && B2.status().git.hold === null, 10000)
  assert.equal(read(dirB, 'README.md'), 'hello\n', 'main\'s work git carried went back to the commit')
  assert.equal(read(dirB, 'src/app.js'), 'feature work\n', 'the edit made on feature stays')
  await never(() => read(dirA, 'src/app.js') !== 'line1\nline2 (alice, meanwhile)\nline3\nline4\nline5\n' || read(dirA, 'README.md') !== 'main work\n', 2000)
  assert.equal(A.status().branch, 'main')
})
```

Replace `'restarted on a branch with no commits yet, with a hold saved: nothing in that tree is captured'` with:

```js
test('restarted on a branch with no commits yet: the folder moves to it, and main\'s work stays on main', async (t) => {
  const { A, B, dirA, dirB, room } = await pairRepos(t)
  write(dirA, 'README.md', 'main work\n')
  await waitFor(() => read(dirB, 'README.md') === 'main work\n')
  await close(B)
  git(dirB, 'checkout', '-q', '--orphan', 'scratch')
  write(dirB, 'src/app.js', 'orphan work\n') // HEAD has no commit to read: headKey is null at the next start
  const B2 = await open(t, dirB, 'bob', { room })
  await waitFor(() => B2.status().branch === 'scratch' && B2.status().git.hold === null, 10000)
  await never(() => read(dirA, 'src/app.js') !== 'line1\nline2\nline3\nline4\nline5\n' || read(dirA, 'README.md') !== 'main work\n', 2500)
  assert.equal(A.mergeList().filter((m) => m.state === 'open').length, 0)
  git(dirB, 'checkout', '-qf', 'main')
  await waitFor(() => B2.status().branch === 'main' && read(dirB, 'README.md') === 'main work\n', 10000)
  assert.equal(read(dirA, 'src/app.js'), 'line1\nline2\nline3\nline4\nline5\n')
})
```

Replace `'a new branch with no commits yet (checkout --orphan) is a switch, not git gone missing'` with:

```js
test('a new branch with no commits yet (checkout --orphan) is a switch, not git gone missing', async (t) => {
  const { B, dirA, dirB } = await pairRepos(t)
  git(dirB, 'checkout', '-q', '--orphan', 'scratch')
  await waitFor(() => B.status().branch === 'scratch' && B.status().git.hold === null, 10000)
  assert.ok(B.logs.some((l) => l.includes("You're on scratch now")), B.logs.join('\n'))
  write(dirA, 'README.md', 'main work\n')
  await never(() => read(dirB, 'README.md') === 'main work\n', 1000)
  git(dirB, 'checkout', '-qf', 'main')
  await waitFor(() => B.status().branch === 'main' && read(dirB, 'README.md') === 'main work\n', 10000)
})
```

- [ ] **Step 8: Run the git tests and the suite**

Run: `node --test test/git-awareness.test.js test/branch-switch.test.js`
Expected: PASS.
Run: `npm test 2>&1 | tail -5`
Expected: only the two known failures.

- [ ] **Step 9: Commit**

```bash
git add src/session.js test/branch-switch.test.js test/git-awareness.test.js
git commit -m "Switching branches: a folder moves to another branch's document (menu, MCP or git), never mixing them" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 7: Who is on which branch (presence, status, activity, commit requests)

**Files:**
- Modify: `src/session.js` (`setupPresence` `:2327`; `recordActivity` `:1747`; `requestCommit` `:2370`; `status` peers and `git`; new `branchRows` after `status`)
- Modify: `src/status.js` (`renderStatus`: after `## Partners online`; the activity loop)
- Test: `test/branch-switch.test.js` (append)

**Interfaces:**
- Consumes: `branchList`, `localBranches`, `announceBranch` (tasks 5-6); presence states' `branch`.
- Produces: presence field `branch`; `status().peers[].branch`; `status().branches: [{ key, by, at, default, current, people: [{ name, kind, hosted? }] }]` (yours first, then most people, then newest); `status().git.others: string[]` (repo branches not in the session); activity entries and commit requests carry `branch`; `renderStatus` prints `## Branches` and `switched` lines; `Session.branchRows()`.

- [ ] **Step 1: Write the failing test**

Add `import { renderStatus } from '../src/status.js'` to `test/branch-switch.test.js` and append:

```js
test('status lists the session\'s branches with who is on each, yours first; activity and commit requests say the branch', async (t) => {
  const { A, B, dirA } = await repos(t)
  await A.switchBranch('feature-x')
  await waitFor(() => {
    const rows = B.status().branches
    return rows.length === 2 && rows[0].key === 'main' && rows[0].current && rows[0].people.map((p) => p.name).join() === 'bob' &&
      rows[1].key === 'feature-x' && rows[1].people.map((p) => p.name).join() === 'alice'
  })
  assert.equal(B.status().peers.find((p) => p.name === 'alice').branch, 'feature-x')
  const md = renderStatus(B.status())
  assert.match(md, /## Branches/)
  assert.match(md, /- `main` \(you are here\) · default: you/)
  assert.match(md, /- `feature-x`: alice/)
  await waitFor(() => /alice switched to `feature-x`/.test(renderStatus(B.status())))
  git(dirA, 'branch', 'local-only')
  A.refreshLocalBranches()
  await waitFor(() => A.status().git.others.includes('local-only') && !A.status().git.others.includes('feature-x'))
  B.requestCommit('ready on main')
  await waitFor(() => A.status().commits.some((r) => r.message === 'ready on main' && r.branch === 'main'))
  write(dirA, 'feature.txt', 'x\n')
  await waitFor(() => B.status().activity.some((x) => x.path === 'feature.txt' && x.branch === 'feature-x'))
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test --test-name-pattern="status lists the session" test/branch-switch.test.js`
Expected: FAIL: `B.status().branches` is undefined.

- [ ] **Step 3: Presence and status (`src/session.js`)**

In `setupPresence`, add `branch: this.branch,` to the object passed to `setLocalState` (after `kind: this.kind,`).

In `recordActivity`, change the push to:

```js
    this.activity.push([{ by: this.name, path: rel, kind, detail, branch: this.branch, ts: now }])
```

In `requestCommit`, change the record to:

```js
    const r = { id: crypto.randomBytes(6).toString('hex'), by: this.name, message, branch: this.branch, ts: Date.now(), state: 'open' }
```

In `status ()`, in the `peers.push({ ... })` for presence states, after `kind: s.kind || 'human',` add `branch: typeof s.branch === 'string' ? s.branch : null,`. After `fileCount: ...,` add `branches: this.branchRows(),`. Replace the `git:` line with:

```js
      git: this.git ? { branch: this.git.branch, key: this.git.key, hold: this.hold ? { kind: this.hold.kind, since: this.hold.since, to: this.hold.to || null, conflict: this.hold.conflict || null } : null, pull: this.pull, others: this.localBranches.filter((b) => !this.branchList.some((x) => x.key === b)) } : null
```

After `status ()` add:

```js
  /**
   * The session's branches for the branch menu and quilt_status, with who is on each (people
   * from presence, hosted agents from the relay): yours first, then the most people, then the newest.
   */
  branchRows () {
    const on = new Map()
    const add = (key, p) => {
      if (!key) return
      const list = on.get(key) || []
      if (!list.some((x) => x.name === p.name)) list.push(p)
      on.set(key, list)
    }
    add(this.branch, { name: this.name, kind: this.kind })
    const states = this.conn ? this.conn.awareness.getStates() : new Map()
    for (const [id, s] of states) if (id !== this.doc.clientID && s && s.name && typeof s.branch === 'string') add(s.branch, { name: s.name, kind: s.kind || 'human' })
    for (const b of this.branchList) for (const n of b.hosted || []) add(b.key, { name: n, kind: 'agent', hosted: true })
    const rows = this.branchList.map((b) => ({ key: b.key, by: b.by || '', at: b.at || 0, default: !!b.default, current: b.key === this.branch, people: on.get(b.key) || [] }))
    // Yours before the relay has listed it (just joined).
    if (this.branch && !rows.some((r) => r.current)) rows.push({ key: this.branch, by: this.name, at: Date.now(), default: false, current: true, people: on.get(this.branch) || [] })
    return rows.sort((a, b) => (b.current - a.current) || (b.people.length - a.people.length) || (b.at - a.at))
  }
```

- [ ] **Step 4: The Markdown status (`src/status.js`)**

After the `## Partners online` block (after its trailing `out.push('')`) add:

```js
  // Every branch in the session and who is on it (a folder without git has none to show).
  const branches = st.git && Array.isArray(st.branches) ? st.branches : []
  if (branches.length) {
    out.push('## Branches')
    for (const b of branches) {
      const people = b.people.map((p) => p.name === st.me.name ? 'you' : p.name)
      out.push(`- \`${b.key}\`${b.current ? ' (you are here)' : ''}${b.default ? ' · default' : ''}: ${people.length ? people.join(', ') : 'nobody right now'}`)
    }
    if (st.git.others && st.git.others.length) out.push(`- Not in the session yet: ${st.git.others.map((k) => `\`${k}\``).join(', ')}`)
    out.push('Move this folder to another branch with quilt_switch_branch (only this folder moves).')
    out.push('')
  }
```

In the `## Recent activity` loop, change

```js
    if (a.kind === 'pulled') out.push(`- ${ago(a.ts)}: ${who} pulled ${a.detail || 'commits'}`)
```

to

```js
    if (a.kind === 'pulled') out.push(`- ${ago(a.ts)}: ${who} pulled ${a.detail || 'commits'}`)
    else if (a.kind === 'switched') out.push(`- ${ago(a.ts)}: ${who} switched to \`${a.branch}\``)
```

- [ ] **Step 5: Run the test and the suite**

Run: `node --test test/branch-switch.test.js`
Expected: PASS, 10 tests.
Run: `npm test 2>&1 | tail -5`
Expected: only the two known failures.

- [ ] **Step 6: Commit**

```bash
git add src/session.js src/status.js test/branch-switch.test.js
git commit -m "Branches in status and presence: who is on which branch; activity and commit requests name it" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 8: Local agents switch through the control API and `quilt_switch_branch`

**Files:**
- Modify: `src/control.js` (`routes`, after `'POST /work'`)
- Modify: `src/mcp.js` (INSTRUCTIONS `:76`; new tool before `quilt_merges` `:325`)
- Modify: `test/mcp.test.js:57`
- Test: `test/branch-switch.test.js` (append)

**Interfaces:**
- Consumes: `Session.switchBranch`, `Session.removeBranch` (task 6).
- Produces: `POST /branch { branch, create? } → { branch, how, note }`, `POST /branch/remove { branch } → { removed }`; MCP tool `quilt_switch_branch({ branch, create? })` (gated like other work-moving tools).

- [ ] **Step 1: Write the failing test**

Add `import { startControl, call } from '../src/control.js'` to `test/branch-switch.test.js` and append:

```js
test('an agent in the folder switches through the control API, the same path as the menu', async (t) => {
  const { A, dirA } = await repos(t)
  const ctl = await startControl(A, {})
  t.after(() => ctl.close())
  const d = JSON.parse(fs.readFileSync(path.join(A.stateDir, 'daemon.json'), 'utf8'))
  const r = await call(d, 'POST', '/branch', { branch: 'feature-x' })
  assert.equal(r.branch, 'feature-x')
  assert.match(r.note, /You're on feature-x now/)
  assert.equal(read(dirA, 'feature.txt'), 'feature\n')
  await assert.rejects(call(d, 'POST', '/branch', { branch: 'bad..name' }), /isn't a branch name/)
  assert.match((await call(d, 'GET', '/status')).markdown, /## Branches/)
  assert.ok((await call(d, 'POST', '/notices', {})).notices.some((n) => n.includes('switched this folder to feature-x')))
})
```

In `test/mcp.test.js:57`, add `'quilt_switch_branch'` to the list after `'quilt_set_work'`.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test --test-name-pattern="control API" test/branch-switch.test.js && node --test --test-name-pattern="exposes the join" test/mcp.test.js`
Expected: FAIL: `not found` from the control API; `quilt_switch_branch` missing from the tool list.

- [ ] **Step 3: Control routes (`src/control.js`)**

After `'POST /work': ...` add:

```js
    // Moves this folder to another branch of the session (the branch menu does the same): { branch, create } -> { branch, how, note }.
    'POST /branch': (b) => session.switchBranch(String(b.branch || ''), { create: !!b.create }),
    // Session owner: takes a branch out of the session (never the git branch).
    'POST /branch/remove': (b) => session.removeBranch(String(b.branch || '')),
```

- [ ] **Step 4: The local MCP tool (`src/mcp.js`)**

After `'If quilt_status lists merges to settle, read quilt_merges before editing those files. ' +` add:

```js
  'The session has a branch for each git branch people work on, each with its own files; quilt_status lists them and who is on each. To work on another, call quilt_switch_branch: it moves this whole folder (and everyone working in it), never anyone else. ' +
```

Before `server.registerTool('quilt_merges', {` add:

```js
  server.registerTool('quilt_switch_branch', {
    description: 'Move this folder to another branch of the session, as the branch menu does: the work on the branch you leave stays in the session (and a copy in git at refs/quilt/parked/<branch>), git switches, and the folder gets that branch\'s files. Everyone working in this folder moves with it; nobody else does. create: true starts a new branch from the work here. quilt_status lists the branches and who is on each.',
    inputSchema: {
      branch: z.string().min(1).max(200).describe('The branch, e.g. feature/login'),
      create: z.boolean().optional().describe('Start a new branch from this folder\'s work')
    }
  }, ({ branch, create }) => withDaemon(async (d) => {
    const r = await call(d, 'POST', '/branch', { branch, create: !!create })
    return r.note
  }, { gate: gateFor('quilt_switch_branch') }))
```

- [ ] **Step 5: Run the tests and the suite**

Run: `node --test test/branch-switch.test.js test/mcp.test.js test/agent-task-workflow.test.js`
Expected: PASS.
Run: `npm test 2>&1 | tail -5`
Expected: only the two known failures.

- [ ] **Step 6: Exercise the tool from an agent**

Run `npm run app`, start a session in a git folder with two branches, then from Claude Code or Cursor in that folder ask the agent to "switch to <branch> with quilt_switch_branch". Expected: the agent's answer is the note ("You're on … now; the session's work there is on disk"), the folder's files are that branch's, and `quilt_status` shows `## Branches` with you on it.

- [ ] **Step 7: Commit**

```bash
git add src/control.js src/mcp.js test/mcp.test.js test/branch-switch.test.js
git commit -m "quilt_switch_branch for agents in the folder: the same switch as the branch menu" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 9: Hosted agents choose a branch

**Files:**
- Modify: `src/server.js` (new `Room.setHostedBranch` after `hostedBranch`)
- Modify: `src/relay-mcp.js` (`HOSTED_INSTRUCTIONS` `:51`; `quilt_status` in `sessionTools` `:211`; `ctx` in `handleHostedMcp` `:706`; new tool before `sessionTools(mcp, ctx)` `:794`)
- Test: `test/branch-hosted.test.js`

**Interfaces:**
- Consumes: `Room.hostedBranch`, `Room.branchDoc`, `Room.branchList` (tasks 3-4); `branchOf(room)` in `sessionTools` (task 5).
- Produces: `Room.setHostedBranch(id, key, { create, by }) → { branch, created, from }` (kept in `meta.hostedBranch`); hosted `ctx.branch(room)`; hosted MCP tool `quilt_switch_branch({ branch, create? })`; `quilt_status` gains `## Branches` for hosted and link-based agents.

- [ ] **Step 1: Write the failing test**

Create `test/branch-hosted.test.js`:

```js
// Hosted agents work on a branch: the session's active one by default, or one
// they choose with quilt_switch_branch. Their file tools, claims and history
// follow it, and a folder that switches to that branch gets their work.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { generateIdentity } from '../src/identity.js'
import { signPass, PASS_TTL_MS } from '../src/passes.js'
import { PASS_KEYS, testPasses } from './pass-helpers.js'

process.env.HOME = process.env.USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-bh-home-'))
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-bh-${n}-`))
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV }).trim()
async function waitFor (fn, ms = 8000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}
const out = (r) => r.content.map((c) => c.text).join('\n')
const GROK = 'agent:agent-grok'
const hostedPass = () => signPass({ v: 1, sub: 'agent-grok', kind: 'agent', name: 'Grok-Bot', key: '', exp: Date.now() + PASS_TTL_MS }, PASS_KEYS.privateKey)

let srv, carl, carlDir, grok
const call = (name, args = {}) => grok.callTool({ name, arguments: args })

before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, passPublicKey: PASS_KEYS.publicKey })
  const bare = tmp('bare'); git(bare, 'init', '-q', '--bare', '-b', 'main')
  carlDir = tmp('carl'); git(carlDir, 'clone', '-q', bare, '.')
  write(carlDir, 'README.md', '# Project\n'); git(carlDir, 'add', '.'); git(carlDir, 'commit', '-qm', 'one'); git(carlDir, 'push', '-q', 'origin', 'main')
  const id = generateIdentity()
  carl = new Session({ dir: carlDir, server: `ws://127.0.0.1:${srv.port}`, room: 'bh-1', secret: 's', viewSecret: 'v', name: 'Carl', tool: 'Claude Code', identity: id, passes: testPasses(id, { name: 'Carl', sub: 'user-carl' }) })
  await carl.start({ waitTimeoutMs: 5000 })
  carl.setAgentState({ tool: 'Claude Code', status: 'idle' })
  await waitFor(() => carl.isOwner)
  grok = new Client({ name: 'grok', version: '1.0.0' })
  await grok.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), { requestInit: { headers: { 'x-quilt-pass': hostedPass() } } }))
  await call('quilt_join_session', { invite: 'https://join.heyquilt.com/bh-1#s' })
  await waitFor(() => carl.waiting.some((p) => p.key === GROK))
  await carl.approve(GROK, { role: 'editor' })
  await waitFor(() => carl.members.some((m) => m.key === GROK))
})
after(async () => { await grok?.close(); await carl.stop(); await srv.close() })

test('a hosted agent reads and writes the session\'s active branch by default; quilt_status lists the branches', async () => {
  const r = await call('quilt_write_file', { path: 'notes.md', content: 'from grok\n' })
  assert.ok(!r.isError, out(r))
  await waitFor(() => read(carlDir, 'notes.md') === 'from grok\n')
  assert.match(out(await call('quilt_status')), /## Branches\n- main \(yours\) · default: Carl, Grok-Bot/)
})

test('quilt_switch_branch moves the agent\'s file tools and claims to that branch; the folder on main never sees it', async () => {
  const missing = await call('quilt_switch_branch', { branch: 'feature-x' })
  assert.equal(missing.isError, true)
  assert.match(out(missing), /isn't in this session\. Pass create: true/)
  const r = await call('quilt_switch_branch', { branch: 'feature-x', create: true })
  assert.ok(!r.isError, out(r))
  assert.match(out(r), /Started feature-x from main/)
  assert.equal(out(await call('quilt_read_file', { path: 'notes.md' })), 'from grok\n', 'started from a copy of main\'s files')
  await call('quilt_write_file', { path: 'README.md', content: '# Project on feature-x\n' })
  await new Promise((resolve) => setTimeout(resolve, 1000))
  assert.equal(read(carlDir, 'README.md'), '# Project\n')
  assert.match(out(await call('quilt_status')), /- feature-x \(yours\): Grok-Bot/)
  await carl.claim('README.md', 'main edit')
  const c = await call('quilt_claim', { pattern: 'README.md', note: 'feature edit' })
  assert.ok(!c.isError, out(c))
  await call('quilt_release', { pattern: 'README.md' })
  await carl.release('README.md')
})

test('a folder that switches to the agent\'s branch gets its work', async () => {
  await waitFor(() => carl.branchList.some((b) => b.key === 'feature-x'))
  await carl.switchBranch('feature-x')
  assert.equal(read(carlDir, 'README.md'), '# Project on feature-x\n')
  assert.equal(read(carlDir, 'notes.md'), 'from grok\n')
  assert.ok(carl.logs.some((l) => l.includes("feature-x isn't pushed yet, so git shows Grok-Bot's work there as changes")), carl.logs.join('\n'))
  await carl.switchBranch('main')
  assert.equal(read(carlDir, 'README.md'), '# Project\n')
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/branch-hosted.test.js`
Expected: FAIL: no `## Branches` in `quilt_status`; `quilt_switch_branch` is an unknown tool.

- [ ] **Step 3: A hosted agent's branch on the relay (`src/server.js`)**

After `hostedBranch (id) { ... }` add:

```js
  /**
   * A hosted agent works on branch `key` from now on (quilt_switch_branch), kept per member.
   * `create`: a new branch in the session, started from a copy of the files on the branch it
   * is on (as `git switch -c` carries a folder's work). Returns { branch, created, from }.
   */
  setHostedBranch (id, key, { create = false, by = '' } = {}) {
    if (!validBranchKey(key) || key === DEFAULT_KEY) throw new Error(`"${String(key).slice(0, 60)}" isn't a branch name.`)
    const to = this.resolveKey(key)
    const from = this.hostedBranch(id)
    const exists = !!this.meta.branches[to]
    if (!exists && !create) throw new Error(`${key} isn't in this session. Pass create: true to start it from the files on ${from}.`)
    if (exists && create) throw new Error(`${key} is already in this session: switch to it without create.`)
    if (!exists) {
      if (this.full) throw new Error("This session is over its size limit, so it can't take another branch.")
      const src = this.branchDoc(from, { by })
      const e = this.branchDoc(to, { by, base: this.meta.branches[from] ? this.meta.branches[from].base : null })
      e.doc.transact(() => {
        for (const [rel, t] of src.files) { const y = new Y.Text(); y.insert(0, t.toString()); e.files.set(rel, y) }
        for (const [rel, b] of src.blobs) e.blobs.set(rel, b)
        for (const [k, v] of src.fileKeys) e.fileKeys.set(k, v)
      }, 'hosted-branch')
    }
    this.meta.hostedBranch = { ...(this.meta.hostedBranch || {}), [id]: to }
    this.saveMeta()
    this.broadcastBranches()
    return { branch: to, created: !exists, from }
  }
```

- [ ] **Step 4: The hosted MCP (`src/relay-mcp.js`)**

Append to `HOSTED_INSTRUCTIONS`, before `TASK_WORKFLOW`:

```js
  'A session has a branch for each git branch its members work on, each with its own files: quilt_status lists them and who is on each, and you work on the busiest one until you pick another with quilt_switch_branch (create: true starts a new one from the files you have). ' +
```

In `quilt_status` (in `sessionTools`), after the `## People online` loop add:

```js
    const bl = room.branchList ? room.branchList() : []
    if (bl.length) {
      const mine = branchOf(room)
      const on = new Map()
      for (const s of room.awareness.getStates().values()) if (s && s.name && typeof s.branch === 'string') on.set(s.branch, [...(on.get(s.branch) || []), s.name])
      lines.push('', '## Branches')
      for (const b of bl) {
        const names = [...new Set([...(on.get(b.key) || []), ...(b.hosted || [])])]
        lines.push(`- ${b.key}${b.key === mine ? ' (yours)' : ''}${b.default ? ' · default' : ''}: ${names.length ? names.join(', ') : 'nobody right now'}`)
      }
      if (ctx.branch) lines.push('Work on another branch with quilt_switch_branch.')
    }
```

In `handleHostedMcp`, add to `ctx` after `access: (room) => room.hostedAccess(pass),`:

```js
    branch: (room) => room.hostedBranch(account),
```

Before `sessionTools(mcp, ctx)` in `handleHostedMcp` add:

```js
  mcp.registerTool('quilt_switch_branch', {
    description: 'Work on another branch of the session: your file tools, claims and history then read and write that branch. quilt_status lists the branches and who is on each. create: true starts a new branch from a copy of the files on the one you are on.',
    inputSchema: {
      branch: z.string().min(1).max(200).describe('The branch, e.g. feature/login'),
      create: z.boolean().optional().describe('Start it: a new branch from the files on your current one')
    }
  }, ({ branch, create }) => ctx.withSession((room) => {
    try {
      const r = room.setHostedBranch(account, String(branch).trim(), { create: !!create, by: me })
      return text(r.created
        ? `Started ${r.branch} from ${r.from}, with a copy of its files. Your file tools, claims and history use ${r.branch} now; people move their folders to it from the branch menu.`
        : `You are on ${r.branch} now: your file tools, claims and history use it.`)
    } catch (e) { return fail(e.message) }
  }))
```

- [ ] **Step 5: Run the tests and the suite**

Run: `node --test test/branch-hosted.test.js test/relay-hosted-mcp.test.js test/relay-mcp.test.js`
Expected: PASS.
Run: `npm test 2>&1 | tail -5`
Expected: only the two known failures.

- [ ] **Step 6: Commit**

```bash
git add src/server.js src/relay-mcp.js test/branch-hosted.test.js
git commit -m "Hosted agents choose a branch with quilt_switch_branch; quilt_status lists the session's branches" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 10: The branch menu

**Files:**
- Create: `src/ui/branches.js`
- Modify: `src/ui/session.js` (imports `:3-15`; top bar markup `:87`; `renderTop` `:500-512`; `bindTop` `:311`; `renderPeopleMenu` row `:857`; `renderCommitPanel` `:582`; `sessionUnmount`)
- Modify: `src/ui-server.js` (`STATIC` `:89-112`; routes after `commit-request/done` `:646`)
- Modify: `src/ui/app.css` (after `.branch-label` rules `:787`)
- Modify: `test/ui.test.js:49,79`

**Interfaces:**
- Consumes: `status().branch`, `status().branches`, `status().git` (`hold`, `others`), `status().access.owner`, `status().peers[].branch`, commit requests' `branch`; routes below.
- Produces: `POST /api/sessions/:id/branch { branch, create? } → { branch, how, note }`, `POST /api/sessions/:id/branch/remove { branch } → { removed }`; `src/ui/branches.js` exports `branchMenuMarkup()`, `bindBranchMenu({ session, status, signal, onSwitched })`, `renderBranchButton(st)`, `renderBranchMenu()`, `peopleText(row, me)`, `closeBranchMenu()`.

- [ ] **Step 1: Write the failing test**

In `test/ui.test.js`, after `assert.equal((await fetch(base + '/access-form.js')).status, 200)` add:

```js
  assert.equal((await fetch(base + '/branches.js')).status, 200, 'the branch menu module is served')
```

and after `assert.equal(done.body.done, 1)` add:

```js
  // The session's folder has no git: the branch menu isn't shown, and a switch says why.
  const sw = await api('POST', `/api/sessions/${id}/branch`, { branch: 'feature-x' })
  assert.equal(sw.status, 400)
  assert.match(sw.body.error, /isn't a git repository/)
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/ui.test.js test/ui-static-allowlist.test.js`
Expected: FAIL: `/branches.js` is 404; the branch route is 404.

- [ ] **Step 3: Routes and STATIC (`src/ui-server.js`)**

Add to `STATIC`:

```js
  '/branches.js': ['branches.js', 'text/javascript; charset=utf-8'],
```

After `'POST /api/sessions/:id/commit-request/done': ...` add:

```js
    // The branch menu: move this folder to another branch of the session (or start one), or, for the owner, remove one.
    'POST /api/sessions/:id/branch': async (b, id) => { const r = await get(id).switchBranch(String(b.branch || ''), { create: !!b.create }); pushStatus(id); return r },
    'POST /api/sessions/:id/branch/remove': async (b, id) => { const r = await owned(id).removeBranch(String(b.branch || '')); pushStatus(id); return r },
```

- [ ] **Step 4: Write `src/ui/branches.js`**

```js
// The branch menu in the session's top bar: every branch in the session with
// who is on it, and Switch; the repo's other branches; New branch…; and for the
// session owner, Remove from session. Switching moves only this folder.
import { I, $, esc, toast, api, ask } from './common.js'

let ctx = null // { session: () => id, status: () => st, onSwitched }
let busyNow = false // a switch is running from this menu

export function branchMenuMarkup () {
  return `<div class="branch-wrap" id="branch-wrap" hidden>
    <button type="button" class="branch-btn" id="branch-btn" aria-haspopup="true" aria-expanded="false" aria-controls="branch-menu"></button>
    <div class="popover branch-menu" id="branch-menu" role="menu" aria-label="Branches" hidden></div>
  </div>`
}

/** Who is on a branch, in a few words: "you, Duncan" or "nobody right now". */
export function peopleText (row, me) {
  const names = row.people.map((p) => p.name === me ? 'you' : p.name)
  return names.length ? names.join(', ') : 'nobody right now'
}

/** Why switching can't happen now, or ''. */
function blocked (st) {
  const h = st.git && st.git.hold
  if (busyNow || (h && h.kind === 'switching')) return `Switching to ${(h && h.to) || 'another branch'}…`
  if (h && h.conflict) return 'Resolve the git conflict first'
  if (h && h.kind === 'busy') return 'Finish the git merge first'
  if (!st.connected) return 'Reconnecting to the relay…'
  return ''
}

/** The top bar button: this folder's branch, and a note while git is busy or a switch runs. Hidden without git. */
export function renderBranchButton (st) {
  const wrap = $('#branch-wrap')
  if (!wrap) return
  const g = st.git
  wrap.hidden = !g
  if (!g) return
  const why = blocked(st)
  const others = (st.branches || []).filter((b) => !b.current).length
  $('#branch-btn').innerHTML = `${I.branch}<span class="branch-name">${esc(st.branch || g.key)}</span>${why ? `<span class="tag">${esc(why)}</span>` : others ? `<span class="count">${others + 1}</span>` : ''}`
  $('#branch-btn').title = why || `This folder is on ${st.branch || g.key}. Click to see the session's branches and switch.`
  if (!$('#branch-menu').hidden) renderBranchMenu()
}

export function renderBranchMenu () {
  const menu = $('#branch-menu')
  if (!menu || menu.hidden || !ctx) return
  const st = ctx.status()
  const why = blocked(st)
  const owner = !!(st.access && st.access.owner)
  const rows = (st.branches || []).map((b) => `
    <div class="branch-row${b.current ? ' current' : ''}">
      <button type="button" class="pop-item" role="menuitem" data-switch="${esc(b.key)}" ${b.current || why ? 'disabled' : ''} title="${esc(b.current ? "You're on this branch" : why || `Switch this folder to ${b.key}`)}">
        ${I.branch}<span class="grow">${esc(b.key)}${b.default ? ' <span class="hint">default</span>' : ''}</span><span class="hint">${esc(peopleText(b, st.me.name))}</span>
      </button>
      ${owner && !b.current && !b.default && !b.people.length ? `<button type="button" class="btn sm ghost" data-remove="${esc(b.key)}" title="Takes ${esc(b.key)}'s work out of the session. The git branch stays.">Remove</button>` : ''}
    </div>`).join('')
  const local = ((st.git && st.git.others) || []).map((k) => `
    <button type="button" class="pop-item" role="menuitem" data-switch="${esc(k)}" ${why ? 'disabled' : ''} title="${esc(why || `Switch to ${k}; it joins the session with this folder's files`)}">${I.branch}<span class="grow">${esc(k)}</span><span class="hint">not in the session</span></button>`).join('')
  menu.innerHTML = `
    <div class="pm-title">In this session</div>${rows}
    ${local ? `<div class="pm-title">Other branches</div>${local}` : ''}
    <div class="pop-sep"></div>
    <button type="button" class="pop-item" role="menuitem" data-new ${why ? 'disabled' : ''}>${I.branch}<span class="grow">New branch…</span></button>
    ${why ? `<p class="hint branch-why">${esc(why)}</p>` : '<p class="hint branch-why">Switching moves only this folder: its work stays in the session, and a copy in git.</p>'}`
}

export function closeBranchMenu () {
  const menu = $('#branch-menu')
  if (menu) menu.hidden = true
  $('#branch-btn')?.setAttribute('aria-expanded', 'false')
}

export function bindBranchMenu ({ session, status, signal, onSwitched = () => {} }) {
  ctx = { session, status, onSwitched }
  const wrap = $('#branch-wrap')
  const btn = $('#branch-btn')
  const menu = $('#branch-menu')
  const setOpen = (open) => {
    menu.hidden = !open
    btn.setAttribute('aria-expanded', String(open))
    if (open) renderBranchMenu()
  }
  btn.onclick = () => setOpen(menu.hidden)
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setOpen(false); btn.focus() } })
  document.addEventListener('mousedown', (e) => { if (!wrap.contains(e.target)) setOpen(false) }, { signal })
  menu.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-switch],[data-new],[data-remove]')
    if (!b || b.disabled) return
    if (b.dataset.remove !== undefined) return remove(b.dataset.remove)
    let branch = b.dataset.switch
    let create = false
    if (b.dataset.new !== undefined) {
      setOpen(false)
      branch = await ask({ title: 'New branch', message: 'Starts from this folder\'s work and puts it in the session. Partners stay where they are.', ok: 'Start', input: { label: 'Branch name', placeholder: 'feature/login' } })
      if (!branch) return
      create = true
    }
    setOpen(false)
    busyNow = true
    renderBranchButton(status())
    try {
      const r = await api('POST', `/api/sessions/${session()}/branch`, { branch: branch.trim(), create })
      toast(r.note)
      onSwitched()
    } catch (err) { toast(err.message) } finally {
      busyNow = false
      renderBranchButton(status())
    }
  })
}

async function remove (key) {
  if (!await ask({ title: `Remove ${key} from the session?`, message: `Its work in the session goes. The git branch, and anything committed or pushed on it, stays.`, ok: 'Remove', danger: true })) return
  try {
    await api('POST', `/api/sessions/${ctx.session()}/branch/remove`, { branch: key })
    toast(`Removed ${key} from the session`)
  } catch (err) { toast(err.message) }
}
```

- [ ] **Step 5: Mount it (`src/ui/session.js`)**

Add the import:

```js
import { branchMenuMarkup, bindBranchMenu, renderBranchButton, closeBranchMenu } from './branches.js'
```

Replace `<span class="branch-label" id="branch-label" hidden></span>` with `${branchMenuMarkup()}`.

In `renderTop`, replace the whole `const label = $('#branch-label')` … `if (label) { ... }` block with:

```js
  // The branch menu: this folder's branch, the session's others, and Switch. The "git is busy"
  // note shows once a hold has lasted a moment (a `git add` holds for an instant).
  const held = g && g.hold ? Date.now() - g.hold.since : 0
  clearTimeout(holdNoteTimer)
  if (g && g.hold && g.hold.kind === 'busy' && held < HOLD_NOTE_MS) {
    holdNoteTimer = setTimeout(renderTop, HOLD_NOTE_MS - held + 20)
    renderBranchButton({ ...st, git: { ...g, hold: null } })
  } else renderBranchButton(st)
```

In `bindTop`, after `bindCommitChip()` add:

```js
  bindBranchMenu({ session: () => current, status: () => sum().status, signal: mounted.signal, onSwitched: () => { loadTree(); renderMain() } })
```

In `sessionUnmount`, after `closeTreeMenu()` add `closeBranchMenu()`.

In `renderPeopleMenu`'s `row`, after `${toolsOf(p).map(...).join('')}` add:

```js
${p.branch && p.branch !== st.branch ? `<span class="tag" title="On ${esc(p.branch)}">${I.branch}${esc(p.branch)}</span>` : ''}
```

In `renderCommitPanel`, change `<b>${esc(r.by)}</b>` to `<b>${esc(r.by)}</b>${r.branch ? ` <span class="tag">${esc(r.branch)}</span>` : ''}`.

- [ ] **Step 6: Styles (`src/ui/app.css`)**

After the `.branch-label .tag` rule add:

```css
.branch-wrap { position: relative; }
.branch-btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; max-width: 280px; padding: 0 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--panel); color: var(--muted); font-size: 12.5px; cursor: pointer; }
.branch-btn:hover, .branch-btn[aria-expanded="true"] { border-color: var(--border-strong); color: var(--text); }
.branch-btn svg { flex: none; width: 15px; height: 15px; }
.branch-btn .branch-name { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.branch-btn .tag { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.branch-btn .count { font-size: 11px; padding: 0 5px; border-radius: 8px; background: var(--panel-2); }
.branch-menu { position: absolute; top: calc(100% + 8px); left: 0; width: 340px; max-width: calc(100vw - 24px); padding: 8px; max-height: 70vh; overflow: auto; }
.branch-row { display: flex; align-items: center; gap: 4px; }
.branch-row.current .pop-item { background: var(--panel-2); }
.branch-row .pop-item:disabled { cursor: default; opacity: 1; }
.branch-menu .pop-item:disabled:not(.current .pop-item) { opacity: .55; }
.branch-why { margin: 6px 8px 2px; font-size: 12px; }
@media (max-width: 700px) { .branch-menu { position: fixed; top: 60px; left: 8px; right: 8px; width: auto; } }
```

- [ ] **Step 7: Run the tests**

Run: `node --test test/ui.test.js test/ui-static-allowlist.test.js`
Expected: PASS.

- [ ] **Step 8: Check the menu by hand with two folders**

Run `npm run app` (from this worktree; see `.claude/launch.json` notes in memory for a signed-in preview). Share a git folder on `main`; join the session from a second clone of the same repo in another window (or `quilt ui` in the browser). Then, in the first window:

1. Click the branch button: "In this session" shows `main` with you and the other window's person; "Other branches" lists the repo's other local branches; the hint says only this folder moves.
2. Pick an Other branch: the toast says "You're on … now", the file tree redraws with that branch's files, the button shows it, and the second window's people menu shows you as "· <branch>".
3. New branch… → `try-it`: the folder keeps its work, `git branch --show-current` says `try-it`, and both windows list `try-it`.
4. Switch back to `main` from the menu: the room's `main` work is on disk.
5. Start `git merge` with a conflict in the folder: the menu items are disabled with "Resolve the git conflict first".
6. As owner, Remove `try-it` once nobody is on it: it leaves both menus; `git branch` still lists it.

A blank cream window means a module failed to load: check `STATIC` and the console.

- [ ] **Step 9: Commit**

```bash
git add src/ui/branches.js src/ui/session.js src/ui/app.css src/ui-server.js test/ui.test.js
git commit -m "The branch menu: every branch in the session, who is on it, Switch, New branch and Remove" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 11: Release notes, the full check, and shipping

**Files:**
- Modify: `RELEASES.md` (top section), `package.json` (version)

- [ ] **Step 1: Release notes**

Bump `package.json` to the next patch version and add a section at the top of `RELEASES.md` (format per its header):

```markdown
## <version> — <YYYY-MM-DD>

- **Switch branches from the top bar.** The branch button lists every branch in the session and who is on each. Pick one and only your folder moves: your uncommitted work stays in the session (and a copy in git at `refs/quilt/parked/<branch>`), git switches (fetching the branch, or starting it, if your repo hasn't got it), and the folder gets that branch's files. **New branch…** starts one from your current work. Two people on the same branch see each other's edits live; branches never mix.
- **A switch made in git does the same.** `git checkout` in a terminal now moves the folder to that branch's work instead of pausing sync, and coming back brings back the session's work there.
- **Agents switch too.** `quilt_switch_branch` moves an agent's folder (local agents) or its own file tools, claims and history (hosted agents), and `quilt_status` lists the branches and who is on each. Claims are per branch: a claim on a file on `main` doesn't block the same file on `feature-x`.
- **Commit requests and activity name their branch,** and the people menu shows a partner on another branch as "Duncan · feature-x".
- **Update Quilt to join sessions.** Sessions now keep a document per branch, so older apps are asked to update; your sessions and their files carry over.
```

- [ ] **Step 2: Run everything**

Run: `npm test 2>&1 | tail -8`
Expected: all pass except the two tests AGENTS.md lists. Note the count for `qaNotes`.

- [ ] **Step 3: Hand check end to end**

Repeat task 10 step 8 with an agent in each folder: ask the first folder's agent to `quilt_switch_branch` and confirm the second folder doesn't move; confirm a hosted agent (accounts API `/mcp`) sees `## Branches` in `quilt_status` and can `quilt_switch_branch` with `create: true`.

- [ ] **Step 4: Commit, merge and ship**

```bash
git add RELEASES.md package.json
git commit -m "Release notes: switching branches in a session" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Then, from a clean clone (never the shared main checkout): merge the branch into `main`, push, deploy the relay first (`fly deploy` for the relay app; old apps then get "needs a newer version"), and only then `npm run release`.

---

## Self-review against the spec

**Coverage** (spec decisions → tasks):

| Spec | Where |
|---|---|
| Menu lists every branch document with members, current first, then most members, then most recent | `branchList` (task 3/4), `branchRows` (task 7), menu (task 10) |
| Switch: flush, save local state, safety ref, clear, `git switch`, load, live, log line | `moveTo`/`finishMove`/`arrive` (task 6), `park`/`clear`/`switchTo` (task 1) |
| Branch not in repo: fetch + track; else create from `base`, else HEAD; "isn't pushed yet" line | `switchTo` (task 1), `moveNote` (task 6), base sent at first join (tasks 3/5) |
| Other branches (local, not in session) → switch creates its document seeded from the folder | `git.others` (task 7), menu (task 10), `arrive` seeding when `created` (task 6) |
| New branch: name checked, `git switch -c`, carries work, seeds document | `startBranch` (task 1), `mode: 'new'` (task 6) |
| Refused when git busy; git error leaves folder on old branch; clear only after confirm + park | `busyRefusal`, `switchBranch` checks, `confirmBranch` before `park`/`clear`, `writeBackAll` on refusal (tasks 1, 3, 6) |
| Only the folder that asks moves; agents in it are told | `notice` + `switched` activity (task 6) |
| Local agents `quilt_switch_branch`, `quilt_status` lists branches | task 8, task 7 |
| Hosted agents' own branch, default active branch (most members, ties to host's) | `activeBranch`, `hostedBranch` (task 4), `setHostedBranch`, tool (task 9) |
| Claims per branch, `branch\0path`, default keeps bare paths | task 4 |
| Commit requests, chat, tasks, feed, activity room-wide with `branch` on requests and activity | tasks 5, 7; commit chip shows branch (task 10) |
| Branch nobody is on: unloaded after 10 minutes, reloaded; owner removes (never git branch) | `BranchStore` (task 3), remove op (task 4), menu Remove (task 10) |
| No git: no menu; syncs default branch | `DEFAULT_KEY`/`resolveKey` (tasks 3-5), `renderBranchButton` hides (task 10) |
| Protocol: doc id framing, `MSG_BRANCH` one at a time, storage, version bump, migration | tasks 2, 3, 4 |
| Spec tests 1-10 | 1-7: `test/branch-switch.test.js`; 8: `test/branch-hosted.test.js`; 9: `relay-branches` claims test and hosted claims; 10: `relay-branches` unload/migration/bad key |

**Placeholders:** none; every step has the code or command it needs. Task 11's `<version>`/`<date>` are filled at release time by design (RELEASES.md's format).

**Name consistency checked:** `joinBranch/confirmBranch/branchRequest/waitForBranchSync` (Connection) are used with those names in tasks 3, 4, 6; `branchDoc/branchList/activeBranch/hostedBranch/setHostedBranch/claimList(branch)` (Room) in tasks 3-5, 9; `switchBranch/removeBranch/branchRows/refreshLocalBranches/announceBranch` (Session) in tasks 6-10; status fields `branch`, `branches`, `git.others`, `peers[].branch` in tasks 5, 7, 10.

**Decisions where the plan differs from the spec, and why:**

1. **Room document id is `''`, not `0`.** The id is a string on the wire; git never allows an empty branch name, while `0` is a valid one.
2. **Awareness is not framed per document.** Presence is room-wide and carries `branch`, which is what the menu needs. Per-document awareness would split who-is-here for no gain.
3. **Branch files live at `data/branches/<room>/<base64url key>.ydoc`, not `data/<room>/branches/<key>.ydoc`.** The relay already keeps `data/files/` and `data/blobs/`, so a room named `files` or `blobs` would collide, and branch names contain `/` and `∅`.
4. **Migration keeps the old document as the default branch's and copies the room-wide parts out**, instead of copying files out. Copies would get new Yjs item ids, so every app's saved `state.bin` would no longer match and offline edits would land on duplicate texts. Keeping the document means old local state rejoins as-is. Apps from before branch documents send `adopt` so their branch takes ∅.
5. **"Git error: nothing cleared" becomes "cleared, then put back from the room".** The spec orders clear before `git switch`, and git can refuse only after the clear (for example, the branch is checked out in another worktree). The plan puts the session's files back (`writeBackAll`) and keeps the folder on the old branch.
6. **A switch made in git clears only what git carried over.** Carried paths are those whose disk matches the old branch's document and differ from the old HEAD. Edits made on the new branch, or made while Quilt was stopped, stay and merge against HEAD. The spec's literal "same path" would discard those edits. They are parked in git either way.
7. **Activity entries are no longer checked against "files touched by the same change".** Files now live in another document, so the relay instead undoes entries about files the member may not change, or files that aren't on their branch.
8. **Phase 1's pause on another branch is removed,** along with its tests (rewritten in task 6). Spec 2026-10-07 replaces it with the move.
