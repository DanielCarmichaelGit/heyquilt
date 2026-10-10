// Git operations in a synced folder are recognised, not broadcast: a stash on
// one machine never erases the room's work; pulled commits merge into it; a
// folder on another branch pauses. Real relay, two folders, real git.
// A slow git never stalls the app: the folder is held while git is asked, and what the room sends meanwhile is merged, not lost.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { useRelay, SHELL_GIT, read, write, git, waitFor, close, open, pairRepos, slowGit, gatedGit } from '../helpers/git-pair.js'

useRelay()

test('a change from the room while git is asked about a burst is merged with it, not lost', { skip: SHELL_GIT }, async (t) => {
  const { A, B, dirA, dirB } = await pairRepos(t)
  const gated = gatedGit(fs.realpathSync(dirB))
  process.env.QUILT_GIT = gated.bin
  try {
    // bob stages his edit (git writes the index: a burst, asked of git); alice edits another line meanwhile.
    write(dirB, 'src/app.js', 'line1 (bob)\nline2\nline3\nline4\nline5\n'); git(dirB, 'add', 'src/app.js')
    await waitFor(() => B.classifying)
    write(dirA, 'src/app.js', 'line1\nline2\nline3\nline4\nline5 (alice)\n')
    await waitFor(() => B.heldPaths.has('src/app.js'))
    assert.equal(read(dirB, 'src/app.js'), 'line1 (bob)\nline2\nline3\nline4\nline5\n', 'nothing written over bob\'s file while git is asked')
    gated.release() // only now let git (still asking about bob's burst) finish classifying it
    const both = 'line1 (bob)\nline2\nline3\nline4\nline5 (alice)\n'
    await waitFor(() => read(dirA, 'src/app.js') === both && read(dirB, 'src/app.js') === both, 30000)
  } finally { delete process.env.QUILT_GIT }
  assert.equal(A.mergeList().filter((m) => m.state === 'open').length, 0)
})

test('a resumed hold settles while a partner keeps typing, even with git slow to answer', { skip: SHELL_GIT }, async (t) => {
  const { A, B, dirA, dirB, room } = await pairRepos(t)
  write(dirA, 'README.md', 'main work\n')
  await waitFor(() => read(dirB, 'README.md') === 'main work\n')
  git(dirB, 'stash', '-q')
  await waitFor(() => B.status().git.hold)
  await close(B)
  process.env.QUILT_GIT = slowGit(1)
  let n = 0
  const typing = setInterval(() => write(dirA, 'src/app.js', `line1 (alice ${++n})\nline2\nline3\nline4\nline5\n`), 150)
  try {
    const B2 = await open(t, dirB, 'bob', { room })
    await waitFor(() => B2.status().git.hold === null && read(dirB, 'README.md') === 'main work\n', 30000)
  } finally { clearInterval(typing); delete process.env.QUILT_GIT }
  const last = read(dirA, 'src/app.js')
  await waitFor(() => read(dirB, 'src/app.js') === last)
  assert.equal(A.mergeList().filter((m) => m.state === 'open').length, 0)
})
