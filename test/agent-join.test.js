import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { startTestApi, API_URL } from './api-helpers.js'
import { agentJoin, agentWhoami, agentFile, describeAgent, parseJoinLink, DEFAULTS, savedAgents, pickAgent, agentAccess, withLock, takeOverStale, REFRESH_TIMING } from '../src/agent-join.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-agent-'))
// A fresh personal invite link, pointed at the test API instead of the public address.
const newLink = async (who = 'mem') => (await t.call('POST', '/v1/agent-invites', {}, who)).body.link.replace(API_URL, t.api.url)

test('quilt agent join uses the link once and saves its keys privately', async () => {
  const dir = tmp()
  const lines = []
  const saved = await agentJoin({ link: await newLink(), name: 'larry', dir, log: (l) => lines.push(l) })
  assert.match(lines[0], /Joined Quilt as larry/)
  assert.match(saved.accessKey, /^qa_/)
  const file = agentFile('larry', dir)
  assert.equal(file, path.join(dir, 'agents', 'larry.json'))
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual([onDisk.agentId, onDisk.api, !!onDisk.identity.privateKey, onDisk.refreshKey], [saved.agentId, t.api.url, true, saved.refreshKey])
  const agent = await t.store.agentById(saved.agentId)
  assert.deepEqual([agent.name, agent.provider, agent.type, agent.publicKey], ['larry', DEFAULTS.provider, DEFAULTS.type, onDisk.identity.publicKey])
})

test('quilt agent whoami says who the agent is, refreshing an expired access key first', async () => {
  const dir = tmp()
  const saved = await agentJoin({ link: await newLink(), name: 'whoami-bot', provider: 'Anthropic', type: 'coding', dir, log: () => {} })
  const me = await agentWhoami({ name: 'whoami-bot', dir })
  assert.deepEqual([me.agent.id, me.agent.kind], [saved.agentId, 'personal'])
  assert.equal(describeAgent(me), 'whoami-bot (Anthropic, coding): your personal agent')
  const file = agentFile('whoami-bot', dir)
  fs.writeFileSync(file, JSON.stringify({ ...saved, accessExpiresAt: Date.now() - 1 }))
  await agentWhoami({ name: 'whoami-bot', dir })
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.notEqual(after.refreshKey, saved.refreshKey, 'the refresh key rotated')
  assert.ok(after.accessExpiresAt > Date.now())
  // The old refresh key is spent: using it again revokes the agent's keys.
  assert.equal((await t.call('POST', '/v1/agents/token', { refreshKey: saved.refreshKey })).status, 401)
  assert.equal((await t.call('GET', '/v1/agents/me', null, null, { authorization: `Bearer ${after.accessKey}` })).status, 401, 'its keys are revoked')
  // The agent itself holds the key it joined with, so it signs back in with new keys.
  assert.equal((await agentWhoami({ name: 'whoami-bot', dir })).agent.id, saved.agentId)
  assert.notEqual(JSON.parse(fs.readFileSync(file, 'utf8')).accessKey, after.accessKey)
})

test("a refresh whose reply never arrived doesn't lock the agent out", async () => {
  const dir = tmp()
  const saved = await agentJoin({ link: await newLink(), name: 'sleepy', dir, log: () => {} })
  const file = agentFile('sleepy', dir)
  const expired = { ...saved, accessExpiresAt: Date.now() - 1 }
  fs.writeFileSync(file, JSON.stringify(expired))
  // The API swaps the keys, but the reply is lost (the computer went to sleep): the file keeps the spent key.
  let lose = true
  const flaky = async (url, opts) => {
    const res = await fetch(url, opts)
    if (lose && url.endsWith('/v1/agents/token')) { lose = false; throw new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } }) }
    return res
  }
  await assert.rejects(agentAccess({ name: 'sleepy', dir, fetch: flaky }), /fetch failed/)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).refreshKey, saved.refreshKey, 'the new keys never arrived')
  // The retry spends the key a second time, which revokes its keys; it signs back in with its own key.
  const back = await agentAccess({ name: 'sleepy', dir, fetch: flaky })
  assert.ok(back.accessExpiresAt > Date.now())
  assert.equal((await agentWhoami({ name: 'sleepy', dir })).agent.id, saved.agentId)
  const keys = await t.store.listAgentKeys(saved.agentId)
  assert.equal(keys.filter((k) => !k.revokedAt).length, 1, 'only the new pair works')
})

test('a revoked access key that has not run out yet signs back in too', async () => {
  const dir = tmp()
  const saved = await agentJoin({ link: await newLink(), name: 'early', dir, log: () => {} })
  for (const k of await t.store.listAgentKeys(saved.agentId)) await t.store.revokeFamily(k.familyId)
  assert.equal((await agentWhoami({ name: 'early', dir })).agent.id, saved.agentId)
  assert.notEqual(JSON.parse(fs.readFileSync(agentFile('early', dir), 'utf8')).accessKey, saved.accessKey)
})

test('an agent a person revoked stays signed out', async () => {
  const dir = tmp()
  const saved = await agentJoin({ link: await newLink(), name: 'gone', dir, log: () => {} })
  await t.store.revokeAgent(saved.agentId)
  fs.writeFileSync(agentFile('gone', dir), JSON.stringify({ ...saved, accessExpiresAt: Date.now() - 1 }))
  await assert.rejects(agentWhoami({ name: 'gone', dir }), (err) => err.status === 401 && /revoked/i.test(err.message))
})

test('describeAgent lists an org agent, its role and its teams', () => {
  const me = { agent: { name: 'Bot', provider: 'OpenAI', type: 'coding agent', kind: 'org', org: { slug: 'acme', name: 'Acme' } }, role: { name: 'Lead' }, teams: [{ name: 'Core', access: 'editor', scopes: ['src', 'docs'] }, { name: 'Web', access: 'viewer', scopes: [] }] }
  assert.equal(describeAgent(me), 'Bot (OpenAI, coding agent): an agent in Acme\nRole: Lead\nTeam Core: editor, folders src, docs\nTeam Web: viewer')
})

test('used and malformed links, bad names and unknown agents are refused clearly', async () => {
  const link = await newLink()
  await agentJoin({ link, name: 'first', dir: tmp(), log: () => {} })
  await assert.rejects(agentJoin({ link, name: 'second', dir: tmp(), log: () => {} }), /already used/)
  for (const bad of ['nope', 'https://api.heyquilt.com/v1/agents', 'ftp://x/v1/join/qj_a']) assert.throws(() => parseJoinLink(bad), /invite link/, bad)
  assert.deepEqual(parseJoinLink('https://api.heyquilt.com/v1/join/qj_abc'), { api: 'https://api.heyquilt.com', token: 'qj_abc' })
  assert.throws(() => agentFile('../evil', tmp()), /--name/)
  await assert.rejects(agentWhoami({ name: 'nobody', dir: tmp() }), /quilt agent join <link> --name nobody/)
})

test('agent files are saved atomically with no leftover temp files', async () => {
  const dir = tmp()
  await agentJoin({ link: await newLink(), name: 'atomic', dir, log: () => {} })
  const agentsDir = path.join(dir, 'agents')
  const leftovers = fs.readdirSync(agentsDir).filter((f) => f.includes('.tmp-'))
  assert.deepEqual(leftovers, [])
  assert.deepEqual(fs.readdirSync(agentsDir), ['atomic.json'])
})

test('refuses to write through a symlinked agent file or agents directory', async () => {
  const dir = tmp()
  const file = agentFile('sym', dir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const elsewhere = path.join(tmp(), 'elsewhere.json')
  fs.symlinkSync(elsewhere, file)
  await assert.rejects(agentJoin({ link: await newLink(), name: 'sym', dir, log: () => {} }), /symlink/)
  assert.ok(!fs.existsSync(elsewhere), "the symlink's target was never written")

  const dir2 = tmp()
  fs.symlinkSync(tmp(), path.join(dir2, 'agents'))
  await assert.rejects(agentJoin({ link: await newLink(), name: 'x', dir: dir2, log: () => {} }), /symlink/)
})

test('tightens an agents directory left with loose permissions', async () => {
  const dir = tmp()
  const agentsDir = path.join(dir, 'agents')
  fs.mkdirSync(agentsDir, { mode: 0o755 })
  await agentJoin({ link: await newLink(), name: 'loose', dir, log: () => {} })
  assert.equal(fs.statSync(agentsDir).mode & 0o777, 0o700)
})

test('parseJoinLink requires https except for a local address', () => {
  assert.throws(() => parseJoinLink('http://example.com/v1/join/qj_a'), /invite link/)
  assert.deepEqual(parseJoinLink('http://127.0.0.1:4000/v1/join/qj_a'), { api: 'http://127.0.0.1:4000', token: 'qj_a' })
  assert.deepEqual(parseJoinLink('http://localhost:4000/v1/join/qj_a'), { api: 'http://localhost:4000', token: 'qj_a' })
  assert.deepEqual(parseJoinLink('http://[::1]:4000/v1/join/qj_a'), { api: 'http://[::1]:4000', token: 'qj_a' })
  assert.deepEqual(parseJoinLink('https://example.com/v1/join/qj_a'), { api: 'https://example.com', token: 'qj_a' })
})

test('a corrupt saved agent file is reported differently from a missing one', async () => {
  const dir = tmp()
  await agentJoin({ link: await newLink(), name: 'corrupt', dir, log: () => {} })
  fs.writeFileSync(agentFile('corrupt', dir), '{ not json')
  await assert.rejects(agentWhoami({ name: 'corrupt', dir }), /corrupt or unreadable/)
  await assert.rejects(agentWhoami({ name: 'nobody-here', dir }), /No agent called nobody-here here/)
})

test('quilt agent needs a subcommand, a link to join, and a name', () => {
  const bin = new URL('../bin/quilt.js', import.meta.url).pathname
  for (const args of [['agent'], ['agent', 'join', '--name', 'x'], ['agent', 'join', 'https://x/v1/join/qj_a'], ['agent', 'whoami'], ['agent', 'dance', '--name', 'x']]) {
    const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })
    assert.equal(r.status, 1, args.join(' '))
    assert.match(r.stderr, /quilt agent join <link> --name <name>/)
  }
})

test('the saved agents on a computer, and which one a session uses', async () => {
  const dir = tmp()
  assert.deepEqual(savedAgents(dir), [])
  assert.throws(() => pickAgent({ dir }), /no Quilt agent yet/)
  await agentJoin({ link: await newLink(), name: 'solo', dir, log: () => {} })
  assert.deepEqual(savedAgents(dir), ['solo'])
  assert.equal(pickAgent({ dir }), 'solo', 'the only one')
  await agentJoin({ link: await newLink(), name: 'other', dir, log: () => {} })
  assert.throws(() => pickAgent({ dir }), /several Quilt agents \(other, solo\)/)
  assert.equal(pickAgent({ agent: 'other', dir }), 'other')
})

test('two processes refreshing one agent at once make a single refresh, and both get a working key', async (tc) => {
  const dir = tmp()
  const saved = await agentJoin({ link: await newLink(), name: 'shared', dir, log: () => {} })
  // Count refreshes on their way to the API, and hold each one a while so the processes overlap.
  let refreshes = 0
  const proxy = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    if (req.url === '/v1/agents/token') { refreshes++; await new Promise((resolve) => setTimeout(resolve, 300)) }
    const r = await fetch(t.api.url + req.url, { method: req.method, headers: { 'content-type': 'application/json', ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) }, body: chunks.length ? Buffer.concat(chunks) : undefined })
    res.writeHead(r.status, { 'content-type': 'application/json' })
    res.end(await r.text())
  })
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  tc.after(() => { proxy.closeAllConnections(); proxy.close() })
  fs.writeFileSync(agentFile('shared', dir), JSON.stringify({ ...saved, api: `http://127.0.0.1:${proxy.address().port}`, accessExpiresAt: Date.now() - 1 }))
  // Each child says it's ready, waits for the go file, then asks for a working key.
  const go = path.join(dir, 'go')
  const mod = pathToFileURL(path.resolve('src/agent-join.js')).href
  const script = `
    import fs from 'node:fs'
    import { agentAccess } from '${mod}'
    console.log('ready')
    while (!fs.existsSync(${JSON.stringify(go)})) await new Promise((resolve) => setTimeout(resolve, 5))
    const s = await agentAccess({ name: 'shared', dir: ${JSON.stringify(dir)} })
    console.log('key ' + s.accessKey)
  `
  const runChild = () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stderr.on('data', (d) => { err += d })
    const ready = new Promise((resolve) => child.stdout.on('data', (d) => { out += d; if (out.includes('ready')) resolve() }))
    const done = new Promise((resolve) => child.on('exit', (code) => resolve({ code, out, err })))
    return { ready, done }
  }
  const a = runChild()
  const b = runChild()
  await Promise.all([a.ready, b.ready])
  fs.writeFileSync(go, '')
  const results = await Promise.all([a.done, b.done])
  for (const r of results) assert.equal(r.code, 0, r.err)
  const keys = results.map((r) => r.out.match(/key (\S+)/)[1])
  assert.equal(refreshes, 1, 'exactly one refresh')
  assert.equal(keys[0], keys[1])
  assert.notEqual(keys[0], saved.accessKey)
  const me = await fetch(`${t.api.url}/v1/agents/me`, { headers: { authorization: `Bearer ${keys[0]}` } })
  assert.equal(me.status, 200, 'the key works')
  assert.ok(!fs.existsSync(agentFile('shared', dir) + '.lock'), 'the lock is released')
})

test('releasing never removes a lock that is no longer ours', async () => {
  const dir = tmp()
  const file = path.join(dir, 'a.json')
  await withLock(file, async () => {
    // Another process took it over, thinking ours had gone stale.
    fs.writeFileSync(file + '.lock', 'someone-else')
  })
  assert.equal(fs.readFileSync(file + '.lock', 'utf8'), 'someone-else')
})

/** A pid that was running a moment ago and isn't now. */
async function deadPid () {
  const child = spawn(process.execPath, ['-e', ''])
  await new Promise((resolve) => child.on('exit', resolve))
  return child.pid
}
const aged = (file, ms) => { const d = new Date(Date.now() - ms); fs.utimesSync(file, d, d) }

test('a lock held by a running process is never taken over, however old', async (tc) => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'])
  tc.after(() => child.kill())
  await new Promise((resolve) => child.on('spawn', resolve))
  const lock = path.join(tmp(), 'a.json.lock')
  fs.writeFileSync(lock, `${child.pid}.abc`)
  aged(lock, 4 * 60_000)
  assert.equal(takeOverStale(lock), false)
  assert.equal(fs.readFileSync(lock, 'utf8'), `${child.pid}.abc`)
})

test("a lock whose process is gone is taken over, and the agent's keys get refreshed", async () => {
  const dir = tmp()
  const saved = await agentJoin({ link: await newLink(), name: 'orphan', dir, log: () => {} })
  const file = agentFile('orphan', dir)
  fs.writeFileSync(file, JSON.stringify({ ...saved, accessExpiresAt: Date.now() - 1 }))
  fs.writeFileSync(file + '.lock', `${await deadPid()}.abc`)
  const s = await agentAccess({ name: 'orphan', dir })
  assert.notEqual(s.accessKey, saved.accessKey)
  assert.ok(!fs.existsSync(file + '.lock'))
})

test('a lock older than 5 minutes is taken over even if its pid is running', () => {
  const lock = path.join(tmp(), 'a.json.lock')
  fs.writeFileSync(lock, `${process.pid}.abc`)
  aged(lock, 5 * 60_000 + 1000)
  assert.equal(takeOverStale(lock), true)
  assert.ok(!fs.existsSync(lock))
})

test('a stale lock that changed between our two reads is left alone', async () => {
  const lock = path.join(tmp(), 'a.json.lock')
  fs.writeFileSync(lock, `${await deadPid()}.abc`)
  // Another process took it over and locked between our two reads.
  assert.equal(takeOverStale(lock, () => fs.writeFileSync(lock, `${process.pid}.theirs`)), false)
  assert.equal(fs.readFileSync(lock, 'utf8'), `${process.pid}.theirs`)
})

test('a slow refresh is waited for, not cut off: the timeouts nest', () => {
  const { refreshTimeoutMs, lockWaitMs, lockMaxAgeMs } = REFRESH_TIMING
  // Cutting off a refresh the API already did loses the new keys, and the agent is later revoked.
  assert.equal(refreshTimeoutMs, 120 * 1000)
  assert.ok(lockWaitMs > refreshTimeoutMs, 'another process waits out a whole refresh')
  assert.ok(lockMaxAgeMs > lockWaitMs, 'a live holder is never taken for stale')
})
