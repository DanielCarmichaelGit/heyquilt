// Hosted agents work on a branch: the session's active one by default, or one
// they choose with quilt_switch_branch. Their file tools, claims and history
// follow it, and a folder that switches to that branch (a checkout in git,
// which Quilt follows) gets their work.
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

test('a hosted agent reads and writes the session\'s active branch by default; quilt_status lists the branches, marking its own', async () => {
  const r = await call('quilt_write_file', { path: 'notes.md', content: 'from grok\n' })
  assert.ok(!r.isError, out(r))
  await waitFor(() => read(carlDir, 'notes.md') === 'from grok\n')
  const status = out(await call('quilt_status'))
  assert.match(status, /## Branches\n- `main` \(yours\) · default · in the session · on it: Carl's folder, hosted agent Grok-Bot/)
  assert.match(status, /Work on another branch with quilt_switch_branch\./)
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
  assert.equal(read(carlDir, 'README.md'), '# Project\n', 'the folder on main never sees feature-x\'s work')
  const status = out(await call('quilt_status'))
  assert.match(status, /- `feature-x` \(yours\) · in the session · on it: hosted agent Grok-Bot/)
  await carl.claim('README.md', 'main edit')
  const c = await call('quilt_claim', { pattern: 'README.md', note: 'feature edit' })
  assert.ok(!c.isError, out(c), 'claims are per branch: feature-x\'s claim on README.md does not clash with main\'s')
  await call('quilt_release', { pattern: 'README.md' })
  await carl.release('README.md')
})

test('a folder that switches to the agent\'s branch (a checkout in git) gets its work', async () => {
  await waitFor(() => carl.branchList.some((b) => b.key === 'feature-x'))
  git(carlDir, 'checkout', '-qb', 'feature-x')
  await waitFor(() => read(carlDir, 'README.md') === '# Project on feature-x\n' && read(carlDir, 'notes.md') === 'from grok\n', 10000)
  assert.ok(carl.logs.some((l) => l.includes("You're on feature-x now (you switched in git); the session's work there is on disk.")), carl.logs.join('\n'))
  git(carlDir, 'checkout', '-q', 'main')
  await waitFor(() => read(carlDir, 'README.md') === '# Project\n', 10000)
})
