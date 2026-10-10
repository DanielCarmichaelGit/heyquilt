// Git operations in a synced folder are recognised, not broadcast: a stash on
// one machine never erases the room's work; pulled commits merge into it; a
// folder on another branch pauses. Real relay, two folders, real git.
// A git that fails (unreachable, a failing call, a broken LFS filter, a huge hold) leaves the folder held or settled, never frozen and never shared wrong.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { useRelay, SHELL_GIT, tmp, read, write, git, waitFor, never, close, open, pairRepos, failingGit, POINTER } from '../helpers/git-pair.js'

useRelay()

test('git unreachable when a hold settles: the folder stays held, nothing is shared, and it settles once git is back', async (t) => {
  const { B, dirA, dirB } = await pairRepos(t)
  write(dirA, 'README.md', 'main work\n')
  await waitFor(() => read(dirB, 'README.md') === 'main work\n')
  git(dirB, 'stash', '-q')
  await waitFor(() => B.status().git.hold)
  process.env.QUILT_GIT = path.join(tmp('nogit'), 'git')
  try {
    await never(() => read(dirA, 'README.md') !== 'main work\n' || B.status().git.hold === null, 4500)
    assert.equal(B.status().git.hold.kind, 'busy')
  } finally { delete process.env.QUILT_GIT }
  await waitFor(() => read(dirB, 'README.md') === 'main work\n' && B.status().git.hold === null, 10000)
  assert.equal(read(dirA, 'README.md'), 'main work\n')
})

test('a hold resumed over 500 files settles without stalling the app', async (t) => {
  const many = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`many/f${i}.txt`, `file ${i}\n`]))
  const { B, dirA, dirB, room } = await pairRepos(t, many)
  write(dirA, 'README.md', 'main work\n')
  await waitFor(() => read(dirB, 'README.md') === 'main work\n')
  git(dirB, 'stash', '-q')
  await waitFor(() => B.status().git.hold)
  await close(B)
  const B2 = await open(t, dirB, 'bob', { room })
  let last = Date.now(); let worst = 0
  const tick = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now }, 5)
  try {
    await waitFor(() => read(dirB, 'README.md') === 'main work\n' && B2.status().git.hold === null, 15000)
  } finally { clearInterval(tick) }
  assert.ok(worst < 1000, `the event loop stalled for ${worst} ms`)
  assert.equal(read(dirA, 'README.md'), 'main work\n')
})

test('a commit git fails to list is not taken as seen; one it lists is', { skip: SHELL_GIT }, async (t) => {
  const { B, dirA, dirB } = await pairRepos(t)
  write(dirB, 'README.md', 'committed here\n')
  await waitFor(() => read(dirA, 'README.md') === 'committed here\n')
  const before = B.gitSeen.sha
  git(dirB, 'commit', '-qam', 'bob') // no file changes: no burst sees it
  process.env.QUILT_GIT = failingGit('diff')
  try { await B.noteCommits() } finally { delete process.env.QUILT_GIT }
  assert.equal(B.gitSeen.sha, before, 'what the commit changed is unknown: not taken as the session\'s work')
  await B.noteCommits()
  assert.equal(B.gitSeen.sha, git(dirB, 'rev-parse', 'HEAD'))
})

test('a pull over a Git LFS file whose filter fails settles; nothing is parked', async (t) => {
  const { B, dirA, dirB } = await pairRepos(t, { '.gitattributes': '*.lfs filter=lfs\n', 'model.lfs': POINTER('aaa') })
  const c = tmp('c'); git(c, 'clone', '-q', git(dirA, 'remote', 'get-url', 'origin'), '.')
  write(c, 'model.lfs', POINTER('bbb')); write(c, 'README.md', 'hello (remote)\n')
  git(c, 'commit', '-qam', 'new model'); git(c, 'push', '-q', 'origin', 'main')
  git(dirB, 'pull', '-q', '--ff-only')
  // The filter is set now (within the settle time): running it fails.
  git(dirB, 'config', 'filter.lfs.smudge', 'false'); git(dirB, 'config', 'filter.lfs.required', 'true')
  await waitFor(() => B.status().git.hold)
  await waitFor(() => B.status().git.hold === null && read(dirA, 'README.md') === 'hello (remote)\n', 10000)
})

test('a file git fails to read at the old commit settles as a record at worst, not a frozen folder', { skip: SHELL_GIT }, async (t) => {
  const { A, B, dirA, dirB } = await pairRepos(t)
  const c = tmp('c'); git(c, 'clone', '-q', git(dirA, 'remote', 'get-url', 'origin'), '.')
  write(c, 'src/app.js', 'line1 (remote)\nline2\nline3\nline4\nline5\n'); git(c, 'commit', '-qam', 'remote'); git(c, 'push', '-q', 'origin', 'main')
  git(dirB, 'pull', '-q', '--ff-only')
  await waitFor(() => B.status().git.hold)
  process.env.QUILT_GIT = failingGit('--filters')
  try {
    await waitFor(() => B.status().git.hold === null, 10000)
  } finally { delete process.env.QUILT_GIT }
  assert.ok(B.logs.some((l) => l.includes('git could not read 1 file')), B.logs.join('\n'))
  await waitFor(() => read(dirA, 'src/app.js') === 'line1 (remote)\nline2\nline3\nline4\nline5\n' || A.mergeList().some((m) => m.path === 'src/app.js' && m.state === 'open'), 10000)
})

test('git status failing during a stash: held, then merged against the last commit, so the room keeps its work', { skip: SHELL_GIT }, async (t) => {
  const { B, dirA, dirB } = await pairRepos(t)
  write(dirA, 'README.md', 'main work\n')
  await waitFor(() => read(dirB, 'README.md') === 'main work\n')
  process.env.QUILT_GIT = failingGit('status')
  try {
    git(dirB, 'stash', '-q')
    await never(() => read(dirA, 'README.md') !== 'main work\n', 2500)
    await waitFor(() => read(dirB, 'README.md') === 'main work\n' && B.status().git.hold === null, 10000)
  } finally { delete process.env.QUILT_GIT }
  assert.equal(read(dirA, 'README.md'), 'main work\n')
})
