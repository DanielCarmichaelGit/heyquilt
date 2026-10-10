// Two clones of one repo, each in a Quilt session on a real relay, for the git end-to-end
// tests (test/e2e/git-*.test.js). Each test file calls useRelay() once to get its own relay.
import { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { startServer } from '../../src/server.js'
import { Session } from '../../src/session.js'
import { generateIdentity } from '../../src/identity.js'
import { NO_SHELL_SCRIPTS } from './platform.js'

let srv, server
/** Starts a relay for this test file, and stops it at the end. */
export function useRelay () {
  before(async () => { srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, maxNewRoomsPerHour: 0 }); server = `ws://127.0.0.1:${srv.port}` })
  after(async () => { await srv.close() })
}
export const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-ga-${n}-`))
export const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
export const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
export const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
export const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV }).trim()
export async function waitFor (fn, ms = 8000) {
  const start = Date.now(); let last
  while (Date.now() - start < ms) { try { last = await fn(); if (last) return last } catch (e) { last = e }; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error(`timed out; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}
/** Holds for `ms` and fails if `fn` ever becomes true meanwhile. */
export async function never (fn, ms = 1500) {
  const start = Date.now()
  while (Date.now() - start < ms) { assert.ok(!(await fn()), 'happened but must not'); await new Promise((r) => setTimeout(r, 25)) }
}
const ids = new Map()
const identityOf = (n) => { if (!ids.has(n)) ids.set(n, generateIdentity()); return ids.get(n) }
const stopped = new Set()
/** Stops a session once; open() also stops it when the test ends. */
export const close = async (s) => { if (!stopped.has(s)) { stopped.add(s); await s.stop() } }
export async function open (t, dir, name, extra) {
  // These tests are about a person's own git commands: commits come in only when they pull (see e2e/upstream.test.js).
  const s = new Session({ dir, server, secret: 'pw', name, identity: identityOf(name), bringInUpstream: false, ...extra })
  t.after(() => close(s))
  if (process.env.GA_DEBUG) { s.on('log', (m) => console.error(`[${name}] ${m}`)); s.on('hold', (h) => console.error(`[${name}] hold ${JSON.stringify(h)}`)) }
  await s.start({ waitTimeoutMs: 5000 })
  s.setAgentState({ tool: s.tool, status: 'idle' }) // people typing by hand; their edits are not claimed for them
  return s
}

let rooms = 0
/** A room name no other test in this file has used. */
export const nextRoom = () => `ga${++rooms}`
export const LOGO = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 0xfe])
export const LOGO2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 2, 0xfe, 0xff])
export const readBuf = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel)) } catch { return null } }

/** A bare remote, two clones (alice, bob) with one commit, both in a fresh room. `extra`: more files for the commit. */
export async function pairRepos (t, extra = {}, bobOpts = {}) {
  const bare = tmp('bare'); git(bare, 'init', '-q', '--bare', '-b', 'main')
  const seed = tmp('seed'); git(seed, 'clone', '-q', bare, '.')
  write(seed, 'src/app.js', 'line1\nline2\nline3\nline4\nline5\n'); write(seed, 'README.md', 'hello\n')
  fs.writeFileSync(path.join(seed, 'assets-logo.png'), LOGO)
  for (const [rel, text] of Object.entries(extra)) write(seed, rel, text)
  git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'one'); git(seed, 'push', '-q', 'origin', 'main')
  const dirA = tmp('a'); git(dirA, 'clone', '-q', bare, '.')
  const dirB = tmp('b'); git(dirB, 'clone', '-q', bare, '.')
  const room = nextRoom()
  const A = await open(t, dirA, 'alice', { room })
  const B = await open(t, dirB, 'bob', { room, ...bobOpts })
  await waitFor(() => A.status().connected && B.status().connected)
  return { A, B, dirA, dirB, bare, room }
}

export const settleWatcher = () => new Promise((resolve) => setTimeout(resolve, 1500))

/** For tests that use failingGit or slowGit: skipped on Windows, which can't run them (CI runs them on Linux). */
export const SHELL_GIT = NO_SHELL_SCRIPTS

/** A git that runs, but fails any call with one of `failOn` in its arguments. */
export function failingGit (...failOn) {
  const bin = path.join(tmp('fakegit'), 'git')
  fs.writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do case "$a" in ${failOn.map((f) => `'${f}'`).join('|')}) exit 1;; esac; done\nexec git "$@"\n`, { mode: 0o755 })
  return bin
}
export const POINTER = (oid) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 123456789\n`

/** A git that answers every call, `secs` seconds late. */
export function slowGit (secs) {
  const bin = path.join(tmp('slowgit'), 'git')
  fs.writeFileSync(bin, `#!/bin/sh\nsleep ${secs}\nexec git "$@"\n`, { mode: 0o755 })
  return bin
}

/**
 * A git that blocks every call made *in `holdDir`* until the test calls `release()`, then
 * runs the real git normally; a call in any other folder (QUILT_GIT applies to every
 * session in the process, so a partner folder's own git calls must not wait on this gate
 * too) always runs straight away. Lets a test hold a burst's classification open for
 * exactly as long as it needs to set up a race, instead of guessing a sleep that must
 * outlast whatever the host is doing at the time (the fixed-sleep version of these tests,
 * slowGit, flaked under load).
 */
export function gatedGit (holdDir) {
  const dir = tmp('gatedgit')
  const gate = path.join(dir, 'gate')
  const bin = path.join(dir, 'git')
  fs.writeFileSync(bin, `#!/bin/sh\nif [ "$(pwd -P)" = "${holdDir}" ]; then\n  while [ ! -f "${gate}" ]; do sleep 0.02; done\nfi\nexec git "$@"\n`, { mode: 0o755 })
  return { bin, release: () => fs.writeFileSync(gate, '') }
}

/**
 * The session put two new files in bob's folder (untracked there), and a commit
 * elsewhere adds the same two. Bob also has the room's uncommitted work in README.md.
 * His first pull fetches, then git refuses: untracked files would be overwritten.
 */
export async function sessionFilesCommitted (t, { same = true, bobOpts = {} } = {}) {
  const p = await pairRepos(t, {}, bobOpts)
  write(p.dirA, 'README.md', 'hello, edited in the session\n')
  write(p.dirA, 'docs/notes.md', 'notes from the session\n')
  write(p.dirA, 'docs/todo.md', 'todo from the session\n')
  await waitFor(() => read(p.dirB, 'docs/notes.md') && read(p.dirB, 'docs/todo.md') && read(p.dirB, 'README.md') === 'hello, edited in the session\n')
  const c = tmp('c'); git(c, 'clone', '-q', p.bare, '.')
  write(c, 'docs/notes.md', same ? 'notes from the session\n' : 'notes, committed differently\n')
  write(c, 'docs/todo.md', 'todo from the session\n')
  git(c, 'add', '.'); git(c, 'commit', '-qm', 'docs'); git(c, 'push', '-q', 'origin', 'main')
  assert.throws(() => git(p.dirB, '-c', 'pull.rebase=true', 'pull', '-q', '--autostash'), /untracked working tree files would be overwritten/)
  return p
}
export const pullingPaths = (B) => (B.status().git.pull?.adds || []).map((a) => `${a.path}:${a.same ? 'same' : 'differs'}${a.waiting ? ':waiting' : ''}`).sort()

/** A third clone pushes `commits` (each a map of path -> text, or null to delete) to the pair's remote. */
export function pushCommits (dirA, commits) {
  const c = tmp('c'); git(c, 'clone', '-q', git(dirA, 'remote', 'get-url', 'origin'), '.')
  commits.forEach((files, i) => {
    for (const [rel, text] of Object.entries(files)) {
      if (text === null) git(c, 'rm', '-q', rel)
      else { write(c, rel, text); git(c, 'add', rel) }
    }
    git(c, 'commit', '-qm', `change ${i + 1}`)
  })
  git(c, 'push', '-q', 'origin', 'main')
}

