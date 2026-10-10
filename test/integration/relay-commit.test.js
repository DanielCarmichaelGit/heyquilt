// quilt_commit: the relay commits a member's work to GitHub from the session's copy of the files,
// with nobody else online and no git where the agent runs, within what the owner lets agents do.
// GitHub is a fake answering reads and writes from a local bare repository: no network.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { signPass, PASS_TTL_MS } from '../../src/passes.js'
import { PASS_KEYS, testPasses } from '../helpers/pass-helpers.js'
import { gitBlobSha, commitTarget, planCommit, othersEditing, CommitRefused, slug } from '../../src/github-commit.js'

process.env.HOME = process.env.USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-rc-home-'))
const { startServer } = await import('../../src/server.js')
const { Session } = await import('../../src/session.js')
const { generateIdentity } = await import('../../src/identity.js')

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-rc-${n}-`))
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (dir, args, opts = {}) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...ENV, ...(opts.env || {}) }, ...(opts.input !== undefined ? { input: opts.input } : {}) }).trim()
const tryGit = (dir, args) => { try { return git(dir, args) } catch { return null } }
async function waitFor (fn, ms = 10000) {
  const start = Date.now(); let last
  while (Date.now() - start < ms) { try { last = await fn(); if (last) return last } catch (e) { last = e }; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error(`timed out; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}
const out = (r) => r.content.map((c) => c.text).join('\n')
const TOKEN = 'github_pat_TESTONLY0123456789abcdefCOMMIT'

/** The parts of GitHub's REST API the relay reads and writes, from a bare repository. */
function fakeGitHub (bare) {
  const pulls = []
  let canWrite = true
  const res = (body, status = 200, headers = {}) => new Response(typeof body === 'string' || body === null ? body : JSON.stringify(body), { status, headers })
  const fetch = async (url, init = {}) => {
    const u = new URL(url)
    const m0 = /^\/repos\/acme\/widgets(?:\/(.+))?$/.exec(u.pathname)
    if (u.host !== 'api.github.com' || !m0) return res('', 404)
    const rest = m0[1] || ''
    const method = init.method || 'GET'
    const body = init.body ? JSON.parse(init.body) : null
    if (method !== 'GET' && (!canWrite || (init.headers || {}).authorization !== `Bearer ${TOKEN}`)) return res({ message: 'Resource not accessible by personal access token' }, 403)
    let m
    if (rest === '') return res({ full_name: 'acme/widgets' })
    if (method === 'GET' && (m = /^contents\/(.+)$/.exec(rest))) {
      const b = tryGit(bare, ['cat-file', 'blob', `${u.searchParams.get('ref')}:${decodeURIComponent(m[1])}`])
      return b === null ? res('', 404) : res(git(bare, ['cat-file', 'blob', `${u.searchParams.get('ref')}:${decodeURIComponent(m[1])}`]) + '\n')
    }
    if ((m = /^commits\/(.+)$/.exec(rest))) {
      const sha = tryGit(bare, ['rev-parse', '--verify', `refs/heads/${decodeURIComponent(m[1])}`])
      return sha ? res(sha, 200, { etag: `"${sha}"` }) : res({ message: 'No commit found' }, 404)
    }
    if ((m = /^git\/ref\/heads\/(.+)$/.exec(rest))) {
      const sha = tryGit(bare, ['rev-parse', '--verify', `refs/heads/${decodeURIComponent(m[1])}`])
      return sha ? res({ object: { sha } }) : res({ message: 'Not Found' }, 404)
    }
    if (method === 'GET' && (m = /^git\/commits\/([0-9a-f]{40})$/.exec(rest))) {
      const tree = git(bare, ['rev-parse', `${m[1]}^{tree}`])
      return res({ sha: m[1], tree: { sha: tree }, committer: { date: new Date(Number(git(bare, ['log', '-1', '--format=%ct', m[1]])) * 1000).toISOString() } })
    }
    if (method === 'GET' && (m = /^git\/trees\/([0-9a-f]{40})$/.exec(rest))) {
      const tree = git(bare, ['ls-tree', '-r', m[1]]).split('\n').filter(Boolean).map((l) => { const [meta, p] = l.split('\t'); const [mode, type, sha] = meta.split(/\s+/); return { path: p, mode, type, sha } })
      return res({ sha: m[1], tree, truncated: false })
    }
    if (method === 'POST' && rest === 'git/blobs') return res({ sha: git(bare, ['hash-object', '-w', '--stdin'], { input: Buffer.from(body.content, 'base64') }) }, 201)
    if (method === 'POST' && rest === 'git/trees') {
      const index = path.join(tmp('idx'), 'index')
      const env = { GIT_INDEX_FILE: index }
      git(bare, ['read-tree', body.base_tree], { env })
      for (const e of body.tree) {
        if (e.sha === null) git(bare, ['update-index', '--force-remove', e.path], { env })
        else git(bare, ['update-index', '--add', '--cacheinfo', `${e.mode},${e.sha},${e.path}`], { env })
      }
      return res({ sha: git(bare, ['write-tree'], { env }) }, 201)
    }
    if (method === 'POST' && rest === 'git/commits') {
      const env = body.author ? { GIT_AUTHOR_NAME: body.author.name, GIT_AUTHOR_EMAIL: body.author.email } : {}
      return res({ sha: git(bare, ['commit-tree', body.tree, ...body.parents.flatMap((p) => ['-p', p]), '-m', body.message], { env }) }, 201)
    }
    if (method === 'PATCH' && (m = /^git\/refs\/heads\/(.+)$/.exec(rest))) {
      const ref = `refs/heads/${decodeURIComponent(m[1])}`
      const now = tryGit(bare, ['rev-parse', '--verify', ref])
      if (!now) return res({ message: 'Reference does not exist' }, 422)
      if (tryGit(bare, ['merge-base', '--is-ancestor', now, body.sha]) === null) return res({ message: 'Update is not a fast forward' }, 422)
      git(bare, ['update-ref', ref, body.sha, now])
      return res({ object: { sha: body.sha } })
    }
    if (method === 'POST' && rest === 'git/refs') {
      if (tryGit(bare, ['rev-parse', '--verify', body.ref])) return res({ message: 'Reference already exists' }, 422)
      git(bare, ['update-ref', body.ref, body.sha])
      return res({ ref: body.ref, object: { sha: body.sha } }, 201)
    }
    if (method === 'POST' && rest === 'pulls') {
      if (pulls.some((p) => p.head === body.head)) return res({ message: 'A pull request already exists' }, 422)
      pulls.push({ ...body, number: pulls.length + 1 })
      return res({ number: pulls.length, html_url: `https://github.com/acme/widgets/pull/${pulls.length}` }, 201)
    }
    if (method === 'GET' && rest === 'pulls') {
      const head = u.searchParams.get('head').split(':')[1]
      return res(pulls.filter((p) => p.head === head).map((p) => ({ number: p.number, html_url: `https://github.com/acme/widgets/pull/${p.number}` })))
    }
    return res('', 404)
  }
  return { fetch, pulls, set canWrite (v) { canWrite = v } }
}

const bare = tmp('bare'); git(bare, ['init', '-q', '--bare', '-b', 'main'])
const pusher = tmp('pusher')
let srv, server, gh, carl, carlDir, base
const sessions = []
const clients = []
const ids = new Map()
const identityOf = (n) => { if (!ids.has(n)) ids.set(n, generateIdentity()); return ids.get(n) }
const R = 'rc-room'

async function hosted (sub, name, { kind = 'agent' } = {}) {
  // Let straight in with an editor's grant (as the accounts API does), so nobody needs to be online.
  const pass = () => signPass({ v: 1, sub, kind, name, key: '', exp: Date.now() + PASS_TTL_MS, room: R, access: { files: 'edit', folders: [], foldersExcept: [], talk: true } }, PASS_KEYS.privateKey)
  const c = new Client({ name: sub, version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), { requestInit: { headers: { 'x-quilt-pass': pass() } } }))
  clients.push(c)
  const call = (tool, args = {}) => c.callTool({ name: tool, arguments: args })
  await call('quilt_join_session', { invite: `https://join.heyquilt.com/${R}#s` })
  return { c, call }
}

before(async () => {
  gh = fakeGitHub(bare)
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, passPublicKey: PASS_KEYS.publicKey, upstreamAuto: false, githubAnonPerHour: 100000, upstreamOnChange: false, githubFetch: gh.fetch, idleUnloadMs: 10 * 60 * 1000 })
  server = `ws://127.0.0.1:${srv.port}`
  git(pusher, ['clone', '-q', bare, '.'])
  write(pusher, 'x.js', 'one\n'); write(pusher, 'y.js', 'why\n'); write(pusher, 'gone.md', 'bye\n')
  git(pusher, ['add', '.']); git(pusher, ['commit', '-qm', 'one']); git(pusher, ['push', '-q', 'origin', 'main'])
  base = git(pusher, ['rev-parse', 'HEAD'])
  carlDir = tmp('carl'); git(carlDir, ['clone', '-q', bare, '.'])
  const identity = identityOf('Carl')
  carl = new Session({ dir: carlDir, server, room: R, secret: 's', viewSecret: 'v', name: 'Carl', tool: 'Claude Code', identity, passes: testPasses(identity, { name: 'Carl', sub: 'user-carl' }) })
  const set = carl.setUpstream.bind(carl)
  carl.setUpstream = (up) => set(up ? { ...up, url: 'https://github.com/acme/widgets.git' } : up)
  sessions.push(carl)
  await carl.start({ waitTimeoutMs: 5000 })
  await waitFor(() => carl.isOwner)
})
after(async () => { for (const s of sessions) await s.stop().catch(() => {}); for (const c of clients) await c.close().catch(() => {}); await srv.close() })

test('pure parts: git blob ids, where a commit may go, what changed, who else edited', () => {
  assert.equal(gitBlobSha(Buffer.from('one\n')), git(bare, ['hash-object', '--stdin'], { input: 'one\n' }))
  assert.deepEqual(commitTarget({ kind: 'agent', name: 'Grok Bot', sessionBranch: 'main', message: 'Blog covers!' }), { branch: 'quilt/grok-bot/blog-covers', own: true })
  assert.throws(() => commitTarget({ kind: 'agent', name: 'Grok Bot', sessionBranch: 'main', target: 'main' }), CommitRefused)
  assert.throws(() => commitTarget({ policy: 'off', kind: 'agent', name: 'A', sessionBranch: 'main' }), /quilt_request_commit/)
  assert.deepEqual(commitTarget({ policy: 'any', kind: 'agent', name: 'A', sessionBranch: 'main' }), { branch: 'main', own: false })
  assert.deepEqual(commitTarget({ policy: 'off', kind: 'human', name: 'Carl', sessionBranch: 'main' }), { branch: 'main', own: false }, 'people are not limited')
  assert.throws(() => commitTarget({ kind: 'human', name: 'C', sessionBranch: 'main', target: 'bad..name' }), /not a branch name/)
  const files = new Map([['a', Buffer.from('new')], ['b', Buffer.from('same')], ['c', null], ['d', Buffer.from('mine')]])
  const sha = (s) => gitBlobSha(Buffer.from(s))
  const parent = new Map([['a', sha('old')], ['b', sha('same')], ['c', sha('x')], ['d', sha('upstream')]])
  const baseBlobs = new Map([['a', sha('old')], ['b', sha('same')], ['c', sha('x')], ['d', sha('before')]])
  const p = planCommit(files, { parent, base: baseBlobs })
  assert.deepEqual([p.changes.map((c) => [c.path, c.deleted]), p.same, p.moved], [[['a', false], ['c', true]], ['b'], ['d']])
  assert.deepEqual(planCommit(files, { parent }).moved, [], 'a branch of one\'s own: nothing counts as moved')
  const h = [{ path: 'a', by: 'Hal', ts: 5 }, { path: 'a', by: 'Grok', ts: 6 }, { path: 'a', by: 'Ivy', ts: 1 }, { path: 'b', by: 'Hal', ts: 9, pulled: true }]
  assert.deepEqual([...othersEditing(['a', 'b'], h, { me: 'Grok', since: 2 })], [['a', ['Hal']]])
  assert.equal(slug('  Daniel Carmichael’s AI!! '), 'daniel-carmichaels-ai')
})

test('an agent commits its own work to a branch of its own and opens a pull request, with nobody else needed; the session\'s branch is left alone', async () => {
  const grok = await hosted('agent-grok', 'Grok Bot')
  const room = srv.rooms.get(R)
  await waitFor(() => room.meta.upstreams?.main?.sha === base)
  // No token yet: said, with what to do meanwhile.
  await grok.call('quilt_write_file', { path: 'x.js', content: 'one\ntwo\n' })
  let r = await grok.call('quilt_commit', { message: 'Add two' })
  assert.ok(r.isError)
  assert.match(out(r), /connects GitHub.*quilt_request_commit/s)
  room.setGithubToken(TOKEN)
  await carl.stop() // nobody else online from here
  r = await grok.call('quilt_commit', { message: 'Add two', pull_request: true })
  assert.ok(!r.isError, out(r))
  assert.match(out(r), /Committed [0-9a-f]{7} to acme\/widgets quilt\/grok-bot\/add-two \(new branch\): 1 file \(x\.js\)/)
  assert.match(out(r), /Pull request: https:\/\/github\.com\/acme\/widgets\/pull\/1/)
  const tip = git(bare, ['rev-parse', 'refs/heads/quilt/grok-bot/add-two'])
  assert.equal(git(bare, ['rev-parse', `${tip}^`]), base, 'on the session\'s commit')
  assert.equal(git(bare, ['show', `${tip}:x.js`]), 'one\ntwo')
  assert.deepEqual(git(bare, ['diff', '--name-only', base, tip]).split('\n'), ['x.js'])
  assert.equal(git(bare, ['log', '-1', '--format=%an <%ae>', tip]), 'Grok Bot <grok-bot@agents.noreply.heyquilt.com>')
  assert.match(git(bare, ['log', '-1', '--format=%B', tip]), /^Add two\n\nMade in Quilt by Grok Bot\./)
  assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), base, 'main untouched')
  assert.deepEqual(gh.pulls.map((p) => [p.head, p.base]), [['quilt/grok-bot/add-two', 'main']])
  // Everyone sees it in chat; nobody is woken by it.
  const note = room.doc.getArray('chat').toArray().at(-1)
  assert.equal(note.kind, 'commit')
  assert.match(note.text, /^Grok Bot committed [0-9a-f]{7} to quilt\/grok-bot\/add-two \(a new branch\): "Add two" \(1 file\), pull request/)
  // Again with nothing new: nothing to commit; the pull request is found, not made twice.
  r = await grok.call('quilt_commit', { message: 'Add two', pull_request: true })
  assert.match(out(r), /^Nothing to commit/)
  assert.equal(gh.pulls.length, 1)
  // A second change goes on top of its branch.
  await grok.call('quilt_write_file', { path: 'x.js', content: 'one\ntwo\nthree\n' })
  r = await grok.call('quilt_commit', { message: 'Add two', files: ['x.js'] })
  assert.match(out(r), /Committed [0-9a-f]{7} to acme\/widgets quilt\/grok-bot\/add-two: 1 file/)
  assert.equal(git(bare, ['rev-parse', 'refs/heads/quilt/grok-bot/add-two^']), tip)
  // Not the session's branch, and not someone else's: the owner hasn't allowed it.
  r = await grok.call('quilt_commit', { message: 'x', branch: 'main' })
  assert.match(out(r), /only to branches of their own: quilt\/grok-bot\/<topic> \(not main itself\)/)
  r = await grok.call('quilt_commit', { message: 'x', branch: 'quilt/hal/thing' })
  assert.ok(r.isError)
})

test('with the owner\'s leave, an agent commits to the session\'s branch: exactly its files, never others\' unfinished work or a file that moved on GitHub; and an owner can say no', async () => {
  const room = srv.rooms.get(R)
  const grok = await hosted('agent-grok2', 'Grok Two')
  const hal = await hosted('agent-hal', 'Hal')
  assert.equal(room.setAgentCommits('any'), 'any')
  await grok.call('quilt_write_file', { path: 'y.js', content: 'why\nnot\n' })
  await hal.call('quilt_write_file', { path: 'z.js', content: 'hal was here\n' }) // Hal's unfinished work
  let r = await grok.call('quilt_commit', { message: 'Why not', files: ['y.js'] })
  assert.match(out(r), /Committed [0-9a-f]{7} to acme\/widgets main: 1 file \(y\.js\)/)
  const tip = git(bare, ['rev-parse', 'refs/heads/main'])
  assert.equal(git(bare, ['rev-parse', `${tip}^`]), base, 'one commit, fast-forward')
  assert.deepEqual(git(bare, ['diff', '--name-only', base, tip]).split('\n'), ['y.js'])
  assert.equal(tryGit(bare, ['show', `${tip}:z.js`]), null, 'Hal\'s file is not swept in')
  // Hal changed y.js too, after Grok's commit: Grok is told, and can commit them together.
  await grok.call('quilt_release', { pattern: 'y.js' })
  assert.ok(!(await hal.call('quilt_write_file', { path: 'y.js', content: 'why\nnot\nhal\n' })).isError)
  await hal.call('quilt_release', { pattern: 'y.js' })
  r = await grok.call('quilt_commit', { message: 'More', files: ['y.js'] })
  assert.match(out(r), /also hold changes by others that are not in git yet: y\.js \(Hal\)/)
  // The session is still measured from `base` (nothing brought in): Hal's change counts as others' since then.
  r = await grok.call('quilt_commit', { message: 'More', files: ['y.js'], with_others: true })
  assert.ok(!r.isError, out(r))
  assert.match(git(bare, ['log', '-1', '--format=%B', 'refs/heads/main']), /Co-authored-by: Hal <hal@agents\.noreply\.heyquilt\.com>/)
  // Someone pushed y.js on GitHub; the session hasn't brought it in: committing its copy would undo that.
  assert.equal(room.meta.upstreams.main.sha, git(bare, ['rev-parse', 'refs/heads/main']), 'the session is measured from its own commits')
  git(pusher, ['pull', '-q']); write(pusher, 'y.js', 'pushed\n'); git(pusher, ['commit', '-qam', 'push']); git(pusher, ['push', '-q', 'origin', 'main'])
  await grok.call('quilt_write_file', { path: 'y.js', content: 'why\nnot\nhal\ngrok\n' })
  r = await grok.call('quilt_commit', { message: 'Undo the push', files: ['y.js'], with_others: true })
  assert.match(out(r), /y\.js changed on main since the session's copy was taken.*quilt_sync_branch/s)
  await grok.call('quilt_release', { pattern: 'y.js' })
  await grok.call('quilt_write_file', { path: 'gone.md', content: 'still here\n' })
  // A token that can't write: said plainly, never the token.
  gh.canWrite = false
  r = await grok.call('quilt_commit', { message: 'Gone', files: ['gone.md'] })
  assert.match(out(r), /can't write to acme\/widgets.*Contents: Read and write/)
  assert.ok(!out(r).includes(TOKEN))
  gh.canWrite = true
  // The owner keeps agents from committing: they are told to ask a person.
  room.setAgentCommits('off')
  r = await grok.call('quilt_commit', { message: 'Gone', files: ['gone.md'] })
  assert.match(out(r), /has not let agents commit.*quilt_request_commit/s)
  r = await grok.call('quilt_agent_commits', { mode: 'any' })
  assert.match(out(r), /Only the session owner/)
  assert.equal(room.meta.agentCommits, 'off')
})

test('an agent joined from a folder without git commits through its Quilt (the CLI and every AI tool\'s MCP use this), to a branch of its own by default', async () => {
  const room = srv.rooms.get(R)
  room.setAgentCommits('branches')
  const dir = tmp('dee')
  const identity = identityOf('Dee')
  const dee = new Session({ dir, server, room: R, secret: 's', viewSecret: 'v', name: 'Dee', kind: 'agent', tool: 'Codex', identity, passes: testPasses(identity, { name: 'Dee', kind: 'agent', sub: 'agent-dee', room: R, access: { files: 'edit', folders: [], foldersExcept: [], talk: true } }) })
  sessions.push(dee)
  await dee.start({ waitTimeoutMs: 5000 })
  await waitFor(() => fs.existsSync(path.join(dir, 'gone.md')))
  write(dir, 'docs/dee.md', '# Dee\n')
  await waitFor(() => room.branchDoc('main').files.get('docs/dee.md'))
  const r = await dee.commitToGit({ message: 'Dee notes', files: ['docs/dee.md'] })
  assert.equal(r.branch, 'quilt/dee/dee-notes')
  assert.equal(r.agentCommits, 'branches')
  assert.equal(git(bare, ['show', 'refs/heads/quilt/dee/dee-notes:docs/dee.md']), '# Dee')
  await assert.rejects(dee.commitToGit({ message: 'x', files: ['docs/dee.md'], branch: 'main' }), /only to branches of their own/)
  // Without files: the changes of Dee's on record.
  const again = await dee.commitToGit({ message: 'Dee notes' })
  assert.ok(again.nothing, 'already on its branch')
})

test('a woken agent gets the conversation before the message, and reads further back with quilt_conversation, past the room\'s newest 500', async () => {
  const room = srv.rooms.get(R)
  const ann = await hosted('agent-ann', 'Ann')
  const bob = await hosted('agent-bob', 'Bob')
  await ann.call('quilt_message', { text: 'please build the export tool', to: 'Bob' })
  await bob.call('quilt_message', { text: 'on it', to: 'Ann' })
  for (let i = 0; i < 520; i++) room.postChat({ by: 'Chatty', text: `@Zed noise ${i}` }) // the room keeps its newest 500
  await ann.call('quilt_message', { text: 'is that tool live?', to: 'Bob' })
  const inbox = out(await bob.call('quilt_inbox'))
  assert.match(inbox, /Ann sent you a direct message \(id [0-9a-f]+\): is that tool live\?\n {2}Earlier between you and Ann \(oldest first\):\n {4}- \[[0-9a-f]+\] .* Ann → you: please build the export tool\n {4}- \[[0-9a-f]+\] .* you → Ann: on it/)
  const back = out(await bob.call('quilt_conversation', { with: 'Ann' }))
  assert.match(back, /^Messages between you and Ann, oldest first:\n- .*please build the export tool\n- .*on it\n- .*is that tool live\?$/)
  assert.match(out(await bob.call('quilt_conversation', { q: 'export' })), /please build the export tool/)
  assert.ok(!room.doc.getArray('chat').toArray().some((m) => m.text === 'please build the export tool'), 'gone from the room\'s chat, kept by the relay')
})

test('with the owner\'s GitHub connected (Quilt\'s GitHub App), agents commit with no token set: the relay asks the API for the repository\'s credentials', async () => {
  const room = srv.rooms.get(R)
  room.setAgentCommits('branches')
  room.meta.githubToken = '' // no token pasted by hand
  assert.match(room.meta.ownerSub, /^person:/)
  room.cfg = { ...room.cfg, apiUrl: 'https://api.test', relayApiSecret: 'relay-secret' }
  room.appTokens = null
  let answer = { state: 'not-installed' }
  const asked = []
  room.apiFetch = async (url, init) => {
    asked.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) })
    return new Response(JSON.stringify(answer), { status: 200 })
  }
  const eve = await hosted('agent-eve', 'Eve')
  await eve.call('quilt_write_file', { path: 'docs/eve.md', content: 'eve\n' })
  let r = await eve.call('quilt_commit', { message: 'Eve docs', files: ['docs/eve.md'] })
  assert.match(out(r), /Quilt's GitHub app isn't installed on acme\/widgets.*Connect GitHub/s)
  assert.deepEqual(asked[0], { url: 'https://api.test/v1/relay/github-token', auth: 'Bearer relay-secret', body: { account: room.meta.ownerSub, repo: 'acme/widgets' } })
  answer = { state: 'no-access', login: 'carl-gh' }
  room.appTokens = null
  assert.match(out(await eve.call('quilt_commit', { message: 'Eve docs', files: ['docs/eve.md'] })), /\(@carl-gh\) can't write to acme\/widgets/)
  answer = { state: 'ok', token: TOKEN, expiresAt: Date.now() + 3600e3 }
  room.appTokens = null
  r = await eve.call('quilt_commit', { message: 'Eve docs', files: ['docs/eve.md'] })
  assert.match(out(r), /Committed [0-9a-f]{7} to acme\/widgets quilt\/eve\/eve-docs \(new branch\)/)
  const n = asked.length
  await eve.call('quilt_write_file', { path: 'docs/eve.md', content: 'eve 2\n' })
  await eve.call('quilt_commit', { message: 'Eve docs', files: ['docs/eve.md'] })
  assert.equal(asked.length, n, 'the credentials are kept until near their expiry')
})
