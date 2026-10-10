// Git operations in a synced folder are recognised, not broadcast: a stash on
// one machine never erases the room's work; pulled commits merge into it; a
// folder on another branch pauses. Real relay, two folders, real git.
// Pulled commits merge into the room's work: rebases, binaries, files the session put there first, and how a pull is recorded.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { renderStatus } from '../../src/status.js'
import { useRelay, tmp, read, write, ENV, git, waitFor, never, LOGO2, readBuf, pairRepos, sessionFilesCommitted, pullingPaths, pushCommits } from '../helpers/git-pair.js'

useRelay()

test('a pull that changes a file the partner is editing merges three-way; an overlap becomes a merge record', async (t) => {
  const { A, dirA, dirB } = await pairRepos(t)
  write(dirA, 'src/app.js', 'line1\nline2\nline3\nline4\nline5 (alice)\n')
  await waitFor(() => read(dirB, 'src/app.js') === 'line1\nline2\nline3\nline4\nline5 (alice)\n')
  const bareOf = git(dirA, 'remote', 'get-url', 'origin')
  const c = tmp('c'); git(c, 'clone', '-q', bareOf, '.')
  write(c, 'src/app.js', 'line1 (remote)\nline2\nline3\nline4\nline5\n'); write(c, 'README.md', 'hello (remote)\n')
  git(c, 'commit', '-qam', 'remote'); git(c, 'push', '-q', 'origin', 'main')
  write(dirA, 'README.md', 'hello (alice)\n')
  await waitFor(() => read(dirB, 'README.md') === 'hello (alice)\n')
  // Stashed and pulled, never popped: the pulled commits meet the room's work in Quilt, not in git.
  git(dirB, 'stash', '-q'); git(dirB, 'pull', '-q', '--ff-only')
  await waitFor(() => read(dirA, 'src/app.js') === 'line1 (remote)\nline2\nline3\nline4\nline5 (alice)\n', 10000)
  const rec = await waitFor(() => A.mergeList().find((m) => m.path === 'README.md' && m.state === 'open'), 10000)
  assert.equal(rec.kind, 'conflict')
  assert.equal(rec.via, 'pull', 'the record says the commits were pulled, not edited offline')
  assert.equal(read(dirA, 'README.md'), 'hello (alice)\n', 'the room keeps its work')
})

test('a rebase with a conflict never shows git markers to the partner; continuing merges the result', async (t) => {
  const { dirA, dirB } = await pairRepos(t)
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

test('a pulled commit changing a binary nobody edited lands on both disks, no record', async (t) => {
  const { A, dirA, dirB } = await pairRepos(t)
  const c = tmp('c'); git(c, 'clone', '-q', git(dirA, 'remote', 'get-url', 'origin'), '.')
  fs.writeFileSync(path.join(c, 'assets-logo.png'), LOGO2); git(c, 'commit', '-qam', 'new logo'); git(c, 'push', '-q', 'origin', 'main')
  git(dirB, 'pull', '-q', '--ff-only')
  await waitFor(() => LOGO2.equals(readBuf(dirA, 'assets-logo.png')) && LOGO2.equals(readBuf(dirB, 'assets-logo.png')), 10000)
  await never(() => A.mergeList().some((m) => m.state === 'open') || !LOGO2.equals(readBuf(dirB, 'assets-logo.png')), 2500)
})

test('a pulled commit with a binary and a text file merges the text file and takes the binary', async (t) => {
  const { A, dirA, dirB } = await pairRepos(t)
  write(dirA, 'src/app.js', 'line1\nline2\nline3\nline4\nline5 (alice)\n')
  await waitFor(() => read(dirB, 'src/app.js') === 'line1\nline2\nline3\nline4\nline5 (alice)\n')
  const c = tmp('c'); git(c, 'clone', '-q', git(dirA, 'remote', 'get-url', 'origin'), '.')
  fs.writeFileSync(path.join(c, 'assets-logo.png'), LOGO2); write(c, 'src/app.js', 'line1 (remote)\nline2\nline3\nline4\nline5\n')
  git(c, 'commit', '-qam', 'both'); git(c, 'push', '-q', 'origin', 'main')
  git(dirB, 'stash', '-q'); git(dirB, 'pull', '-q', '--ff-only'); git(dirB, 'stash', 'pop', '-q')
  const want = 'line1 (remote)\nline2\nline3\nline4\nline5 (alice)\n'
  await waitFor(() => read(dirA, 'src/app.js') === want && read(dirB, 'src/app.js') === want && LOGO2.equals(readBuf(dirA, 'assets-logo.png')), 10000)
  assert.ok(LOGO2.equals(readBuf(dirB, 'assets-logo.png')))
  assert.equal(A.mergeList().filter((m) => m.state === 'open').length, 0)
})

test('files the session put here that pulled commits add are named to the AI: the same, and how to pull', async (t) => {
  const { B } = await sessionFilesCommitted(t)
  await waitFor(() => pullingPaths(B).length === 2)
  assert.deepEqual(pullingPaths(B), ['docs/notes.md:same', 'docs/todo.md:same'])
  const notes = B.takeNotices().join('\n')
  assert.match(notes, /docs\/notes\.md/)
  assert.match(notes, /same content/)
  assert.match(notes, /rm docs\/notes\.md docs\/todo\.md && git pull --autostash/)
  const md = renderStatus(B.status())
  assert.match(md, /## Pulling/)
  assert.match(md, /`docs\/todo\.md`: same content as the session's/)
})

test('removing them to make way for the pull never removes them from the session, and the pull lands them', async (t) => {
  const { A, B, dirA, dirB } = await sessionFilesCommitted(t)
  await waitFor(() => pullingPaths(B).length === 2)
  fs.rmSync(path.join(dirB, 'docs/notes.md')); fs.rmSync(path.join(dirB, 'docs/todo.md'))
  await never(() => read(dirA, 'docs/notes.md') === null || read(dirA, 'docs/todo.md') === null, 2500)
  await waitFor(() => pullingPaths(B).every((p) => p.endsWith(':waiting')))
  git(dirB, '-c', 'pull.rebase=true', 'pull', '-q', '--autostash')
  await waitFor(() => read(dirB, 'docs/notes.md') === 'notes from the session\n' && read(dirB, 'docs/todo.md') === 'todo from the session\n')
  await never(() => read(dirA, 'docs/notes.md') === null || read(dirA, 'docs/todo.md') === null, 2500)
  await waitFor(() => read(dirB, 'README.md') === 'hello, edited in the session\n')
  await waitFor(() => pullingPaths(B).length === 0)
  assert.equal(git(dirB, 'status', '--porcelain', '--', 'docs'), '', 'the pulled files are tracked and match')
  assert.equal(A.mergeList().filter((m) => m.state === 'open').length, 0)
  assert.equal(B.mergeList().filter((m) => m.state === 'open').length, 0)
})

test('removed and the pull never comes: shared as a deletion once the wait is over', async (t) => {
  const { B, dirA, dirB } = await sessionFilesCommitted(t, { bobOpts: { pullWaitMs: 2000 } })
  fs.rmSync(path.join(dirB, 'docs/notes.md'))
  await never(() => read(dirA, 'docs/notes.md') === null, 1200)
  await waitFor(() => read(dirA, 'docs/notes.md') === null, 10000)
  assert.ok(B.logs.some((l) => l.includes('No pull came: docs/notes.md is deleted for everyone')), B.logs.join('\n'))
  assert.equal(read(dirA, 'docs/todo.md'), 'todo from the session\n', 'only the removed file goes')
})

test('stashed away with stash -u to make way: kept for the session, not put back before the pull, landed by it', async (t) => {
  const { A, dirA, dirB } = await sessionFilesCommitted(t)
  git(dirB, 'stash', '-u', '-q')
  await new Promise((resolve) => setTimeout(resolve, 3000)) // past a settle: the files must not come back and block the pull
  assert.equal(read(dirB, 'docs/notes.md'), null)
  // The session's work in README.md came back meanwhile, as after any stash: --autostash carries it over the pull.
  git(dirB, '-c', 'pull.rebase=true', 'pull', '-q', '--autostash')
  git(dirB, 'stash', 'drop', '-q')
  await waitFor(() => read(dirB, 'docs/notes.md') === 'notes from the session\n' && read(dirB, 'README.md') === 'hello, edited in the session\n', 10000)
  assert.equal(read(dirA, 'docs/notes.md'), 'notes from the session\n')
  assert.equal(A.mergeList().filter((m) => m.state === 'open').length, 0)
})

test('a committed file that differs from the session\'s: said so; after the pull the two are merged, a record when they clash', async (t) => {
  const { A, B, dirA, dirB } = await sessionFilesCommitted(t, { same: false })
  await waitFor(() => pullingPaths(B).length === 2)
  assert.deepEqual(pullingPaths(B), ['docs/notes.md:differs', 'docs/todo.md:same'])
  assert.match(B.takeNotices().join('\n'), /docs\/notes\.md differs from the session's/)
  fs.rmSync(path.join(dirB, 'docs/notes.md')); fs.rmSync(path.join(dirB, 'docs/todo.md'))
  git(dirB, '-c', 'pull.rebase=true', 'pull', '-q', '--autostash')
  const rec = await waitFor(() => A.mergeList().find((m) => m.path === 'docs/notes.md' && m.state === 'open'), 10000)
  assert.equal(rec.via, 'pull')
  assert.equal(read(dirA, 'docs/notes.md'), 'notes from the session\n', 'the session keeps its version until someone settles it')
})

test('a pull is one "pulled" event: no claims, no per-file edits, and its own group in Changes', async (t) => {
  const { A, B, dirA, dirB } = await pairRepos(t)
  pushCommits(dirA, [
    { 'src/app.js': 'line1\nline2\nline3\nline4\nline5\nline6\n', 'docs/new.md': 'new\nfile\n' },
    { 'README.md': null }
  ])
  // Bob's AI is at work, so a hand edit of his would be claimed for him. A pull must not be.
  B.setAgentState({ tool: B.tool, status: 'working' })
  git(dirB, 'pull', '-q', '--ff-only')
  await waitFor(() => read(dirA, 'docs/new.md') === 'new\nfile\n' && read(dirA, 'README.md') === null && read(dirA, 'src/app.js').endsWith('line6\n'), 10000)

  const pulled = await waitFor(() => A.status().activity.find((a) => a.kind === 'pulled'))
  assert.equal(pulled.by, 'bob')
  assert.equal(pulled.detail, '2 commits from main · 3 files')
  assert.ok(!A.status().activity.some((a) => a.by === 'bob' && a.kind !== 'pulled'), 'no per-file entries for what the pull brought')
  await never(() => A.status().claims.some((c) => c.by === 'bob'), 1500)

  const bob = A.changes().people.find((p) => p.name === 'bob')
  assert.deepEqual(bob.files.filter((f) => f.path !== '.gitignore'), [], 'a pull is not bob\'s own work (Quilt\'s .quilt/ line in .gitignore aside)')
  assert.equal(bob.pulled.fileCount, 3)
  assert.deepEqual(bob.pulled.files.map((f) => [f.path, f.kind]).sort(), [['README.md', 'deleted'], ['docs/new.md', 'created'], ['src/app.js', 'edited']])
  assert.equal(bob.pulled.added, 3)
  assert.equal(bob.pulled.removed, 1)
  assert.ok(A.changes().files.find((f) => f.path === 'src/app.js').by.every((b) => b.pulled === true))

  const md = renderStatus(A.status())
  assert.match(md, /bob pulled 2 commits from main · 3 files/)
  assert.match(md, /\*\*bob\*\* pulled from git: 3 files, \+3 -1/)
  assert.doesNotMatch(md, /bob edited `src\/app\.js`/)
  const h = A.historyQuery({ path: 'src/app.js' }).find((e) => e.by === 'bob')
  assert.equal(h.pulled, true, 'the chronology says the change came from a pull')

  // A hand edit afterwards is bob's own again, claimed while his AI works.
  write(dirB, 'src/app.js', 'line1\nline2\nline3\nline4\nline5\nline6\nline7 by bob\n')
  B.ingest('src/app.js')
  await waitFor(() => A.status().claims.some((c) => c.by === 'bob' && c.pattern === 'src/app.js'))
  const after = await waitFor(() => { const p = A.changes().people.find((x) => x.name === 'bob'); return p.files.some((f) => f.path === 'src/app.js') && p })
  assert.deepEqual(after.files.filter((f) => f.path === 'src/app.js').map((f) => [f.path, f.added]), [['src/app.js', 1]])
  assert.equal(after.pulled.fileCount, 3)
})

test('a commit of your own is not a pull: nothing is recorded when HEAD moves over work already shared', async (t) => {
  const { A, B, dirB } = await pairRepos(t)
  write(dirB, 'src/app.js', 'line1\nline2 edited\nline3\nline4\nline5\n')
  const bobsOwn = (S) => (S.changes().people.find((p) => p.name === 'bob')?.files || []).filter((f) => f.path !== '.gitignore') // Quilt's .quilt/ line aside
  await waitFor(() => bobsOwn(A).some((f) => f.path === 'src/app.js'))
  git(dirB, 'commit', '-qam', 'mine')
  await never(() => A.status().activity.some((a) => a.kind === 'pulled'), 3000)
  assert.equal(B.changes().people.find((p) => p.name === 'bob').pulled, null)
})
