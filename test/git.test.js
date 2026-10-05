// Git and GitHub integration, offline: a local bare repo plays GitHub, and a
// small fake `gh` (QUILT_GH) clones from it and pretends to open PRs.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-git-')))
const home = path.join(root, 'home')
fs.mkdirSync(home)
process.env.HOME = process.env.USERPROFILE = process.env.USERPROFILE = home
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com'
})

const g = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const write = (dir, file, text) => fs.writeFileSync(path.join(dir, file), text)

// "GitHub": a bare repo with main and dev.
const remote = path.join(root, 'remote.git')
g(root, 'init', '-q', '--bare', '-b', 'main', remote)
const seed = path.join(root, 'seed')
g(root, 'clone', '-q', remote, seed)
g(seed, 'checkout', '-q', '-b', 'main')
write(seed, 'README.md', 'line one\nline two\n')
g(seed, 'add', '-A')
g(seed, 'commit', '-q', '-m', 'first')
g(seed, 'push', '-q', 'origin', 'main')
g(seed, 'checkout', '-q', '-b', 'dev')
write(seed, 'dev.txt', 'dev\n')
g(seed, 'add', '-A')
g(seed, 'commit', '-q', '-m', 'dev work')
g(seed, 'push', '-q', 'origin', 'dev')
g(seed, 'checkout', '-q', 'main')

const fakeGh = path.join(root, 'gh.cjs')
fs.writeFileSync(fakeGh, `#!/usr/bin/env node
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const a = process.argv.slice(2)
const remote = ${JSON.stringify(remote)}
const k = a.slice(0, 2).join(' ')
const out = (s) => process.stdout.write(s + '\\n')
if (a[0] === '--version') out('gh version 0.0.0 (fake)')
else if (k === 'auth status') process.stderr.write('github.com\\n  ✓ Logged in to github.com account tester (keyring)\\n')
else if (k === 'repo clone') execFileSync('git', ['clone', '-q', remote, a[3]])
else if (k === 'repo list') out(JSON.stringify(a[2] === 'acme'
  ? [{ nameWithOwner: 'acme/site', description: 'Org site', updatedAt: '2026-01-02T00:00:00Z', defaultBranchRef: { name: 'main' } }]
  : [{ nameWithOwner: 'me/app', description: '', updatedAt: '2026-03-01T00:00:00Z', defaultBranchRef: { name: 'main' } }]))
else if (a[0] === 'api' && a[1] === 'user/orgs') out('acme')
else if (a[0] === 'api' && a[1].endsWith('/branches')) out(execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: remote, encoding: 'utf8' }).trim())
else if (a[0] === 'api') out('main')
else if (k === 'pr create') {
  const head = a[a.indexOf('--head') + 1]
  const marker = path.join(remote, 'pr-' + head.replace(/\\W/g, '_') + '.json')
  if (fs.existsSync(marker)) { process.stderr.write('a pull request for branch "' + head + '" into branch "main" already exists:\\nhttps://github.com/me/app/pull/1\\n'); process.exit(1) }
  fs.writeFileSync(marker, JSON.stringify(a))
  out('https://github.com/me/app/pull/1')
} else if (k === 'pr view') out('https://github.com/me/app/pull/1')
else { process.stderr.write('fake gh: unknown ' + a.join(' ') + '\\n'); process.exit(2) }
`, { mode: 0o755 })
process.env.QUILT_GH = fakeGh

const git = await import('../src/git.js')

test('branch names are validated with git check-ref-format', async () => {
  assert.equal(await git.checkBranchName(' feature/login '), 'feature/login')
  for (const bad of ['', 'bad..name', '-x', 'a b', 'x~1', 'end.lock', '@{-1}']) {
    await assert.rejects(git.checkBranchName(bad), /branch name/, bad)
  }
})

test('clone: existing branch, new branch from a base, and bad input', async () => {
  const dev = path.join(root, 'clones', 'dev')
  assert.deepEqual(await git.cloneRepo({ repo: 'me/app', dir: dev, branch: 'dev' }), { dir: dev, branch: 'dev' })
  assert.equal(g(dev, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'), 'origin/dev')
  assert.ok(fs.existsSync(path.join(dev, 'dev.txt')))

  const feat = path.join(root, 'clones', 'feat')
  assert.equal((await git.cloneRepo({ repo: 'me/app', dir: feat, newBranch: 'feature/a' })).branch, 'feature/a')
  assert.throws(() => g(feat, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'), 'a new branch has no upstream until pushed')
  assert.ok(!fs.existsSync(path.join(feat, 'dev.txt')), 'started from main')

  const fromDev = path.join(root, 'clones', 'from-dev')
  await git.cloneRepo({ repo: 'me/app', dir: fromDev, newBranch: 'feature/b', base: 'dev' })
  assert.ok(fs.existsSync(path.join(fromDev, 'dev.txt')), 'started from dev')

  const bad = path.join(root, 'clones', 'bad')
  await assert.rejects(git.cloneRepo({ repo: 'me/app', dir: bad, newBranch: 'no..dots' }), /valid branch name/)
  await assert.rejects(git.cloneRepo({ repo: 'me/app', dir: bad, branch: 'missing' }), /no branch named missing/)
  assert.ok(!fs.existsSync(bad), 'a failed clone is cleaned up')
  await assert.rejects(git.cloneRepo({ repo: 'me/app', dir: bad, newBranch: 'dev' }), /already exists/)
  await assert.rejects(git.cloneRepo({ repo: 'me/app', dir: feat, branch: 'main' }), /already has files/)
  await assert.rejects(git.cloneRepo({ repo: 'not a repo; rm -rf /', dir: bad }), /owner\/name/)
})

test('gh: status, repos (with orgs) and branches', async () => {
  assert.deepEqual(await git.ghStatus(), { installed: true, authenticated: true, user: 'tester', message: null })
  const repos = await git.listRepos({ limit: 10 })
  assert.deepEqual(repos.map((r) => r.name), ['me/app', 'acme/site'])
  assert.equal(repos[0].defaultBranch, 'main')
  const b = await git.listBranches('me/app')
  assert.equal(b.defaultBranch, 'main')
  assert.equal(b.branches[0], 'main')
  assert.ok(b.branches.includes('dev'))
  await assert.rejects(git.listBranches('../etc'), /owner\/name/)

  process.env.QUILT_GH = path.join(root, 'no-such-gh')
  try {
    const st = await git.ghStatus()
    assert.equal(st.installed, false)
    assert.match(st.message, /gh auth login/)
  } finally { process.env.QUILT_GH = fakeGh }
})

// ------------------------------------------------------------------- API --
let ui, base, relay, accounts
before(async () => {
  // A signed-in computer: an accounts API that signs passes, a relay that needs them, and account.json.
  const { startServer } = await import('../src/server.js')
  const { startTestApi, linkDevice } = await import('./api-helpers.js')
  const { newPassKeys } = await import('../src/passes.js')
  const { loadIdentity } = await import('../src/identity.js')
  const { saveAccount } = await import('../src/account.js')
  const keys = newPassKeys()
  accounts = await startTestApi({ passKey: keys.privateKey })
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: keys.publicKey })
  process.env.QUILT_API_URL = accounts.api.url
  // The app always uses one relay; QUILT_SERVER points it at this local one.
  process.env.QUILT_SERVER = `ws://127.0.0.1:${relay.port}`
  const { token } = await linkDevice(accounts, 'mem', loadIdentity())
  saveAccount({ token, account: { id: 'mem', name: 'Mo', email: 'mo@acme.com' }, signedInAt: Date.now() })
  const { startUi } = await import('../src/ui-server.js')
  ui = await startUi({ port: 0 })
  base = `http://127.0.0.1:${ui.port}`
})
after(async () => { await ui.close(); await relay.close(); await accounts.close(); fs.rmSync(root, { recursive: true, force: true }) })
const api = (method, p, body) => fetch(base + p, {
  method,
  headers: { 'x-quilt-token': ui.token, 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined
}).then(async (r) => ({ status: r.status, body: await r.json() }))

test('API: start a session from GitHub', async () => {
  assert.equal((await api('GET', '/api/github/status')).body.user, 'tester')
  assert.equal((await api('GET', '/api/github/repos')).body.repos.length, 2)
  assert.ok((await api('GET', '/api/github/branches?repo=me/app')).body.branches.includes('dev'))

  const bad = await api('POST', '/api/sessions', { mode: 'github', repo: 'me/app', newBranch: 'bad name' })
  assert.equal(bad.status, 400)
  assert.match(bad.body.error, /valid branch name/)

  const s = await api('POST', '/api/sessions', { mode: 'github', repo: 'me/app', newBranch: 'feature/api' })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  assert.equal(s.body.dir, path.join(home, 'quilt', 'app'), 'defaults to the join folder')
  await api('POST', `/api/sessions/${s.body.id}/stop`)
})
