// Git operations in a synced folder are recognised, not broadcast: a stash on
// one machine never erases the room's work; pulled commits merge into it; a
// folder on another branch pauses. Real relay, two folders, real git.
// A stash, clean or reset on one machine never erases the room's work; a stash pop that clashes is resolved by the person, never shown as markers to the partner.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { useRelay, tmp, read, write, git, waitFor, never, pairRepos, settleWatcher } from '../helpers/git-pair.js'

useRelay()

test('a stash on one machine does not erase the room\'s work; it comes back after settling', async (t) => {
  const { B, dirA, dirB } = await pairRepos(t)
  write(dirA, 'src/app.js', 'line1 (alice)\nline2\nline3\nline4\nline5\n')
  await waitFor(() => read(dirB, 'src/app.js') === 'line1 (alice)\nline2\nline3\nline4\nline5\n')
  git(dirB, 'stash', '-q') // bob's disk reverts to the commit
  await never(() => read(dirA, 'src/app.js') !== 'line1 (alice)\nline2\nline3\nline4\nline5\n', 2500)
  await waitFor(() => read(dirB, 'src/app.js') === 'line1 (alice)\nline2\nline3\nline4\nline5\n', 8000)
  assert.ok(B.logs.some((l) => l.includes('Quilt kept the session\'s work; your stash still has your copy')), B.logs.join('\n'))
  assert.equal(git(dirB, 'stash', 'list').split('\n').filter(Boolean).length, 1, 'the stash is untouched')
})

test('a stash landing in the same flush as an unrelated save is still not shared: the room keeps its work', async (t) => {
  const { B, dirA, dirB } = await pairRepos(t)
  const alice = 'line1 (alice)\nline2\nline3\nline4\nline5\n'
  write(dirA, 'src/app.js', alice)
  await waitFor(() => read(dirB, 'src/app.js') === alice)
  // An untracked scratch file saved in the same instant as the stash (an editor's autosave, a dev
  // server's output): queued here so both land in one flush, as they do on a busy machine.
  write(dirB, 'scratch.txt', 'notes\n'); git(dirB, 'stash', '-q')
  B.queue('scratch.txt'); B.queue('src/app.js')
  await never(() => read(dirA, 'src/app.js') !== alice, 2500)
  await waitFor(() => read(dirB, 'src/app.js') === alice && read(dirA, 'scratch.txt') === 'notes\n', 8000)
  assert.equal(read(dirA, 'src/app.js'), alice, 'the partner\'s file is untouched')
  assert.equal(git(dirB, 'stash', 'list').split('\n').filter(Boolean).length, 1, 'the stash is untouched')
})

test('git clean of many untracked files is shared as deletions', async (t) => {
  const { dirA, dirB } = await pairRepos(t)
  const many = Array.from({ length: 25 }, (_, i) => `scratch/f${i}.txt`)
  for (const rel of many) write(dirA, rel, `scratch ${rel}\n`)
  await waitFor(() => many.every((rel) => read(dirB, rel) === `scratch ${rel}\n`))
  await settleWatcher()
  git(dirB, 'clean', '-fdq') // untracked in bob's repo too: he meant to delete them
  assert.ok(fs.existsSync(path.join(dirB, '.quilt', 'state.json')), 'git clean leaves Quilt\'s state: .gitignore ignores it')
  await waitFor(() => many.every((rel) => read(dirA, rel) === null), 10000)
  await never(() => many.some((rel) => read(dirB, rel) !== null), 2500)
})

test('git stash -u of untracked files brings them back from the room, and leaves Quilt\'s state in place', async (t) => {
  const { B, dirA, dirB } = await pairRepos(t)
  const notes = ['notes/a.txt', 'notes/b.txt', 'notes/c.txt']
  for (const rel of notes) write(dirA, rel, `alice's ${rel}\n`)
  await waitFor(() => notes.every((rel) => read(dirB, rel) === `alice's ${rel}\n`))
  await settleWatcher()
  git(dirB, 'stash', '-uq')
  assert.ok(fs.existsSync(path.join(dirB, '.quilt', 'state.json')), '.gitignore ignores .quilt/: the stash leaves it')
  await never(() => notes.some((rel) => read(dirA, rel) !== `alice's ${rel}\n`), 2500)
  await waitFor(() => notes.every((rel) => read(dirB, rel) === `alice's ${rel}\n`), 8000)
  assert.equal(git(dirB, 'stash', 'list').split('\n').filter(Boolean).length, 1, 'the stash is untouched')
  assert.ok(fs.existsSync(path.join(dirB, '.quilt', 'state.json')))
  assert.equal(B.status().git.hold, null)
})

test('reset --hard by an agent is the same', async (t) => {
  const { B, dirA, dirB } = await pairRepos(t)
  write(dirA, 'README.md', 'hello from alice\n')
  await waitFor(() => read(dirB, 'README.md') === 'hello from alice\n')
  git(dirB, 'reset', '-q', '--hard')
  await never(() => read(dirA, 'README.md') !== 'hello from alice\n', 2500)
  await waitFor(() => read(dirB, 'README.md') === 'hello from alice\n', 8000)
  // Nothing was stashed, so the line doesn't say there is a stash.
  assert.ok(B.logs.some((l) => l.includes('git put 1 file back to your last commit on this computer only')), B.logs.join('\n'))
  assert.ok(!B.logs.some((l) => l.includes('your stash still has your copy')), B.logs.join('\n'))
})

test('a stash pop that clashes is git mid-conflict: the person resolves it, the partner never sees markers, and the resolution is shared', async (t) => {
  const { A, B, dirA, dirB } = await pairRepos(t)
  // Alice's uncommitted line 2 is the room's work; a commit elsewhere rewrites the same line.
  write(dirA, 'src/app.js', 'line1\nline2 (alice)\nline3\nline4\nline5\n')
  await waitFor(() => read(dirB, 'src/app.js') === 'line1\nline2 (alice)\nline3\nline4\nline5\n')
  const c = tmp('c'); git(c, 'clone', '-q', git(dirA, 'remote', 'get-url', 'origin'), '.')
  write(c, 'src/app.js', 'line1\nline2 (remote)\nline3\nline4\nline5\n'); git(c, 'commit', '-qam', 'remote'); git(c, 'push', '-q', 'origin', 'main')
  git(dirB, 'stash', '-q'); git(dirB, 'pull', '-q', '--ff-only')
  assert.throws(() => git(dirB, 'stash', 'pop', '-q'), 'the pop clashes')
  assert.match(read(dirB, 'src/app.js'), /<<<<<<< /)
  // Held while git's conflict is there: bob keeps his markers, alice never gets them.
  await never(() => /<<<<<<< /.test(read(dirA, 'src/app.js') || '') || !/<<<<<<< /.test(read(dirB, 'src/app.js') || ''), 4000)
  await waitFor(() => B.status().git.hold?.conflict?.includes('src/app.js'))
  assert.ok(B.logs.some((l) => l.includes('git left a conflict in src/app.js on this computer')), B.logs.join('\n'))
  assert.equal(A.mergeList().filter((m) => m.state === 'open').length, 0)
  // Bob resolves (both changes) and tells git: his resolution is the session's now, no record.
  write(dirB, 'src/app.js', 'line1\nline2 (remote, alice)\nline3\nline4\nline5\n'); git(dirB, 'add', 'src/app.js')
  await waitFor(() => read(dirA, 'src/app.js') === 'line1\nline2 (remote, alice)\nline3\nline4\nline5\n', 10000)
  await waitFor(() => B.status().git.hold === null)
  assert.equal(A.mergeList().filter((m) => m.state === 'open').length, 0)
  assert.equal(B.mergeList().filter((m) => m.state === 'open').length, 0)
})

test('stash, pull, pop lands once with the pulled commit merged, no flicker', async (t) => {
  const { dirA, dirB } = await pairRepos(t)
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
