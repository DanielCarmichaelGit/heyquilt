// Git operations in a synced folder are recognised, not broadcast: a stash on
// one machine never erases the room's work; pulled commits merge into it; a
// folder on another branch pauses. Real relay, two folders, real git.
// A slow git never stalls the app: the folder is held while git is asked, and what the room sends meanwhile is merged, not lost.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { useRelay, SHELL_GIT, read, write, git, waitFor, never, pairRepos, slowGit, gatedGit } from '../helpers/git-pair.js'

useRelay()

test('a slow git never stalls the app: the folder is held while git is asked, then settles', { skip: SHELL_GIT }, async (t) => {
  const GIT_SECS = 3
  const { B, dirA, dirB } = await pairRepos(t)
  write(dirA, 'README.md', 'main work\n')
  await waitFor(() => read(dirB, 'README.md') === 'main work\n')
  let last = Date.now(); let worst = 0
  const tick = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now }, 10)
  process.env.QUILT_GIT = slowGit(GIT_SECS)
  try {
    git(dirB, 'stash', '-q')
    // Every git call takes 3 s: the stash is classified, then settled, all the while held.
    await never(() => read(dirA, 'README.md') !== 'main work\n', 5000)
    await waitFor(() => read(dirB, 'README.md') === 'main work\n' && B.status().git.hold === null, 60000)
  } finally { delete process.env.QUILT_GIT; clearInterval(tick) }
  // Every git call here takes at least GIT_SECS: one run synchronously (execFileSync) would stall the
  // event loop for all of that. The bound sits well under it, so any blocking git call fails the test,
  // and well over the scheduler's noise: this timer measures the whole test process, and with the full
  // suite running every file in parallel a busy machine alone has delayed it by 300 ms (no git involved).
  assert.ok(worst < GIT_SECS * 1000 / 3, `the event loop stalled for ${worst} ms: something waited on git synchronously`)
  assert.equal(read(dirA, 'README.md'), 'main work\n')
  assert.ok(B.logs.some((l) => l.includes('Quilt kept the session\'s work')), B.logs.join('\n'))
})

test('new files from the room while git is asked about a burst land as they are: no merge records', { skip: SHELL_GIT }, async (t) => {
  const { A, B, dirA, dirB } = await pairRepos(t)
  const gated = gatedGit(fs.realpathSync(dirB))
  process.env.QUILT_GIT = gated.bin
  const mine = Array.from({ length: 25 }, (_, i) => `bob/f${i}.txt`)
  const theirs = Array.from({ length: 40 }, (_, i) => `alice/f${i}.txt`)
  try {
    for (const rel of mine) write(dirB, rel, `bob ${rel}\n`) // 20 paths or more in a flush: asked of git
    await waitFor(() => B.classifying)
    for (const rel of theirs) write(dirA, rel, `alice ${rel}\n`)
    await waitFor(() => theirs.some((rel) => B.heldPaths.has(rel)))
    gated.release() // only now let git (still asking about bob's burst) finish classifying it
    await waitFor(() => theirs.every((rel) => read(dirB, rel) === `alice ${rel}\n`) && mine.every((rel) => read(dirA, rel) === `bob ${rel}\n`), 30000)
  } finally { delete process.env.QUILT_GIT }
  await never(() => A.mergeList().some((m) => m.state === 'open') || B.mergeList().some((m) => m.state === 'open'), 1500)
})
