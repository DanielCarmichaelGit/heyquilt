// The relay brings commits in from GitHub itself for a branch that only hosted agents
// work on, with no folder online (relay-upstream.js). GitHub is a fake here, answering
// from a local bare repository the way the REST API would: the tests never touch the
// network. Real relay, real git for the folders, hosted agents over HTTP.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import * as Y from 'yjs'
import { signPass, PASS_TTL_MS } from '../src/passes.js'
import { PASS_KEYS, testPasses } from './pass-helpers.js'
import { parseRepo, upstreamRef, backoffFor, noteFolders, dueBranches, FIRST_BACKOFF_MS, MAX_BACKOFF_MS } from '../src/relay-upstream.js'
import { clashTaskId } from '../src/clash.js'
import { branchBoard, branchesMarkdown } from '../src/branches.js'

process.env.QUILT_UPSTREAM_MS = '400' // folders look often: the returning folder's test waits on it
process.env.HOME = process.env.USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ru-home-'))
const { startServer } = await import('../src/server.js')
const { Session } = await import('../src/session.js')
const { generateIdentity } = await import('../src/identity.js')

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-ru-${n}-`))
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV }).trim()
const gitBuf = (dir, ...args) => { try { return execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], env: ENV }) } catch { return null } }
async function waitFor (fn, ms = 10000) {
  const start = Date.now(); let last
  while (Date.now() - start < ms) { try { last = await fn(); if (last) return last } catch (e) { last = e }; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error(`timed out; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}
const out = (r) => r.content.map((c) => c.text).join('\n')
const TOKEN = 'github_pat_TESTONLY0123456789abcdefSECRET'

/**
 * GitHub's REST API as the relay uses it, answered from bare repositories: the ref's head (with
 * an ETag, 304 when unchanged), compare, and file contents (raw.githubusercontent.com without a
 * token, the contents API with one). A private repository answers 404 without its token.
 * `throttle` makes the next call answer a 403/429 with the given headers.
 */
function fakeGitHub (repos) {
  const calls = []
  const state = { throttle: null }
  const res = (body, status = 200, headers = {}) => new Response(body, { status, headers })
  const fetch = async (url, init = {}) => {
    const h = init.headers || {}
    calls.push({ url, headers: h })
    if (state.throttle) { const t = state.throttle; state.throttle = null; return res('slow down', t.status, t.headers) }
    const u = new URL(url)
    let owner, name, rest
    if (u.host === 'api.github.com') {
      const m = /^\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(u.pathname)
      if (!m) return res('{}', 404);
      [, owner, name, rest] = m
    } else if (u.host === 'raw.githubusercontent.com') {
      const m = /^\/([^/]+)\/([^/]+)\/([0-9a-f]{40})\/(.+)$/.exec(u.pathname)
      if (!m) return res('', 404)
      owner = m[1]; name = m[2]; rest = `raw/${m[3]}/${m[4]}`
    } else return res('', 404)
    const repo = repos[`${owner}/${name}`]
    if (!repo || (repo.private && h.authorization !== `Bearer ${repo.token}`)) return res('Not Found', 404)
    const dir = repo.dir
    let m
    if ((m = /^commits\/(.+)$/.exec(rest))) {
      const sha = gitBuf(dir, 'rev-parse', `refs/heads/${decodeURIComponent(m[1])}`)?.toString().trim()
      if (!sha) return res('', 404)
      const etag = `"${sha}"`
      if (h['if-none-match'] === etag) return res(null, 304, { etag })
      return res(sha, 200, { etag })
    }
    if ((m = /^compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(rest))) {
      const [, base, head] = m
      if (base === head) return res(JSON.stringify({ status: 'identical', ahead_by: 0, files: [] }))
      const isAnc = (a, b) => gitBuf(dir, 'merge-base', '--is-ancestor', a, b) !== null
      const status = isAnc(base, head) ? 'ahead' : isAnc(head, base) ? 'behind' : 'diverged'
      const ahead = Number(git(dir, 'rev-list', '--count', `${base}..${head}`))
      const files = git(dir, 'diff', '--name-status', '-M', base, head).split('\n').filter(Boolean).map((l) => {
        const [st, a, b] = l.split('\t')
        if (st.startsWith('R')) return { filename: b, previous_filename: a, status: 'renamed' }
        return { filename: a, status: st === 'A' ? 'added' : st === 'D' ? 'removed' : 'modified' }
      })
      return res(JSON.stringify({ status, ahead_by: ahead, behind_by: 0, total_commits: ahead, files }))
    }
    const file = (sha, p) => { const b = gitBuf(dir, 'cat-file', 'blob', `${sha}:${p}`); return b ? res(b) : res('', 404) }
    if ((m = /^contents\/(.+)$/.exec(rest))) return file(u.searchParams.get('ref'), decodeURIComponent(m[1]))
    if ((m = /^raw\/([0-9a-f]{40})\/(.+)$/.exec(rest))) return file(m[1], decodeURIComponent(m[2]))
    return res('', 404)
  }
  return { fetch, calls, state }
}

const logs = []
let srv, server, gh
const bareW = tmp('bare-w'); git(bareW, 'init', '-q', '--bare', '-b', 'main')
const bareS = tmp('bare-s'); git(bareS, 'init', '-q', '--bare', '-b', 'main')
const pusherW = tmp('pusher-w')
const pusherS = tmp('pusher-s')
const B_JS = 'one\ntwo\nthree\nfour\nfive\nsix\n'

function seed (bare, pusher, files) {
  git(pusher, 'clone', '-q', bare, '.')
  for (const [rel, text] of Object.entries(files)) write(pusher, rel, text)
  git(pusher, 'add', '.'); git(pusher, 'commit', '-qm', 'one'); git(pusher, 'push', '-q', 'origin', 'main')
  return git(pusher, 'rev-parse', 'HEAD')
}
const push = (pusher, files, msg = 'more') => {
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) fs.rmSync(path.join(pusher, rel), { force: true }); else write(pusher, rel, text)
  }
  git(pusher, 'add', '-A'); git(pusher, 'commit', '-qm', msg); git(pusher, 'push', '-q', 'origin', 'main')
  return git(pusher, 'rev-parse', 'HEAD')
}

const ids = new Map()
const identityOf = (n) => { if (!ids.has(n)) ids.set(n, generateIdentity()); return ids.get(n) }
/** A member's app on `dir`; its origin (a local bare repository standing in for GitHub) is reported as `url`, as git would for a clone of it. */
async function open (dir, name, { room, url, sub }) {
  const identity = identityOf(name)
  const s = new Session({ dir, server, room, secret: 's', viewSecret: 'v', name, tool: 'Claude Code', identity, passes: testPasses(identity, { name, sub }) })
  const set = s.setUpstream.bind(s)
  s.setUpstream = (up) => set(up ? { ...up, url } : up)
  await s.start({ waitTimeoutMs: 5000 })
  s.setAgentState({ tool: 'Claude Code', status: 'idle' })
  return s
}
async function hosted (sub, name, room, owner) {
  const pass = () => signPass({ v: 1, sub, kind: 'agent', name, key: '', exp: Date.now() + PASS_TTL_MS }, PASS_KEYS.privateKey)
  const c = new Client({ name: sub, version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), { requestInit: { headers: { 'x-quilt-pass': pass() } } }))
  const call = (tool, args = {}) => c.callTool({ name: tool, arguments: args })
  await call('quilt_join_session', { invite: `https://join.heyquilt.com/${room}#s` })
  await waitFor(() => owner.waiting.some((p) => p.key === `agent:${sub}`))
  await owner.approve(`agent:${sub}`, { role: 'editor' })
  await waitFor(() => owner.members.some((m) => m.key === `agent:${sub}`))
  return { c, call }
}

before(async () => {
  gh = fakeGitHub({ 'acme/widgets': { dir: bareW }, 'acme/secret': { dir: bareS, private: true, token: TOKEN } })
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: (m) => logs.push(m), passPublicKey: PASS_KEYS.publicKey, upstreamAuto: false, githubFetch: gh.fetch, idleUnloadMs: 10 * 60 * 1000 })
  server = `ws://127.0.0.1:${srv.port}`
})
after(async () => { await srv.close() })

// ------------------------------------------------------------ one public repository --

let carl, carlDir, grok, c0, c1, c2
const W = 'ru-w'
const W_URL = 'https://github.com/acme/widgets.git'

test('the relay learns each branch\'s repository, upstream and in-step commit from members\' presence, and does nothing while a folder is online on it', async () => {
  c0 = seed(bareW, pusherW, { 'src/a.js': 'alpha\nbeta\n', 'src/b.js': B_JS, 'README.md': '# Widgets\n' })
  carlDir = tmp('carl'); git(carlDir, 'clone', '-q', bareW, '.')
  carl = await open(carlDir, 'Carl', { room: W, url: W_URL, sub: 'user-carl' })
  await waitFor(() => carl.isOwner)
  grok = await hosted('agent-grok', 'Grok-Bot', W, carl)
  const room = srv.rooms.get(W)
  await waitFor(() => room.meta.upstreams?.main?.sha === c0 && room.meta.upstreams.main.repo)
  const rec = room.meta.upstreams.main
  assert.equal(rec.repo, 'github.com/acme/widgets', 'only owner/name, never a URL')
  assert.equal(rec.name, 'origin/main')
  assert.equal(rec.ref, 'main')
  // Grok works on main; Carl's folder is online on it: the folder brings commits in, not the relay.
  assert.ok(!(await grok.call('quilt_write_file', { path: 'README.md', content: '# Widgets\n\nGrok was here.\n' })).isError)
  const before = gh.calls.length
  assert.deepEqual(await srv.checkUpstreams(W, { force: true }), [])
  assert.equal(gh.calls.length, before, 'GitHub is never asked while a folder is on the branch')
})

test('commits come in when only a hosted agent is on the branch: one transaction, one activity line, the recorded commit moves on', async () => {
  await waitFor(() => read(carlDir, 'README.md') === '# Widgets\n\nGrok was here.\n')
  await carl.stop()
  const room = srv.rooms.get(W)
  // The session's own uncommitted work on src/a.js, then a push that changes another part of it and adds a file.
  assert.ok(!(await grok.call('quilt_write_file', { path: 'src/a.js', content: 'ALPHA (session)\nbeta\n' })).isError)
  c1 = push(pusherW, { 'src/a.js': 'alpha\nbeta\ngamma (pushed)\n', 'docs/new.md': 'new doc\n' })
  // Grok holds src/a.js (its write claimed it): the relay never writes a file someone holds, it waits.
  const [held] = await srv.checkUpstreams(W, { force: true })
  assert.equal(held.state, 'waiting', JSON.stringify(held))
  assert.equal(held.by, 'Grok-Bot')
  assert.match(room.meta.upstreams.main.problem, /Grok-Bot holds src\/a\.js: the relay brings origin\/main in once they let go of it/)
  assert.equal((await grok.call('quilt_read_file', { path: 'docs/new.md' })).isError, true, 'nothing written meanwhile')
  assert.ok(!(await grok.call('quilt_release', { pattern: 'src/a.js' })).isError)
  assert.ok(!(await grok.call('quilt_release', { pattern: 'README.md' })).isError)
  const updates = []
  const e = room.store.get('main')
  const onUpdate = (u, origin) => updates.push(origin)
  e.doc.on('update', onUpdate)
  const [r] = await srv.checkUpstreams(W, { force: true })
  e.doc.off('update', onUpdate)
  assert.equal(r.state, 'brought', JSON.stringify(r))
  assert.equal(r.count, 1)
  assert.equal(r.files, 2)
  assert.equal(updates.length, 1, 'the whole bring-in is one transaction')
  assert.equal(out(await grok.call('quilt_read_file', { path: 'src/a.js' })), 'ALPHA (session)\nbeta\ngamma (pushed)\n', 'merged with the session\'s work')
  assert.equal(out(await grok.call('quilt_read_file', { path: 'docs/new.md' })), 'new doc\n')
  const act = room.activity.toArray().filter((a) => a.kind === 'brought')
  assert.equal(act.length, 1)
  assert.equal(act[0].by, 'the relay')
  assert.equal(act[0].detail, '1 commit from origin/main · 2 files')
  assert.equal(room.meta.upstreams.main.sha, c1)
  const entry = room.branchList().find((b) => b.key === 'main')
  assert.equal(entry.relay.sha, c1, 'members see the relay\'s commit in the branch list')
  assert.equal(entry.relay.brought.count, 1)
  const status = out(await grok.call('quilt_status'))
  assert.match(status, /the relay brought in 1 commit from origin\/main · 2 files on main/)
  assert.match(status, /The relay last checked origin\/main for new commits \d+s ago\. It brought in 1 commit \(2 files\)/)
  assert.match(status, /brought in by the relay just now \(1 commit from origin\/main, 2 files\)/)
  assert.match(out(await grok.call('quilt_branches')), /brought in by the relay just now.*the relay last checked origin\/main just now/)
  assert.match(out(await grok.call('quilt_history', { path: 'docs/new.md' })), /the relay/)
})

test('nothing new: the head is asked for with its ETag, and a 304 costs nothing more', async () => {
  const n = gh.calls.length
  const [r] = await srv.checkUpstreams(W, { force: true })
  assert.equal(r.state, 'up-to-date')
  const asked = gh.calls.slice(n)
  assert.equal(asked.length, 1, 'only the head, nothing else')
  assert.equal(asked[0].headers['if-none-match'], `"${c1}"`)
  assert.equal(asked[0].headers.authorization, undefined, 'a public repository needs no token')
})

test('a clash makes one task for the hosted agent, writes nothing, and the merge lands once the agent writes the resolved file', async () => {
  const room = srv.rooms.get(W)
  const mine = B_JS.replace('three', 'three (session)')
  assert.ok(!(await grok.call('quilt_write_file', { path: 'src/b.js', content: mine })).isError)
  c2 = push(pusherW, { 'src/b.js': B_JS.replace('three', 'three (pushed)'), 'src/c.js': 'c\n' })
  const [r] = await srv.checkUpstreams(W, { force: true })
  assert.equal(r.state, 'clash', JSON.stringify(r))
  const id = clashTaskId('main', c2)
  assert.equal(r.task, id, 'the same id a member\'s Quilt would give it')
  assert.equal(out(await grok.call('quilt_read_file', { path: 'src/b.js' })), mine, 'nothing written')
  assert.equal((await grok.call('quilt_read_file', { path: 'src/c.js' })).isError, true, 'all or nothing: not even the clean file')
  const tasks = [...room.tasks.values()].filter((t) => t.id === id)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].assignee, 'Grok-Bot')
  assert.match(tasks[0].title, /Bring 1 commit from origin\/main into the session: src\/b\.js clashes/)
  const comments = room.taskComments.get(id)
  assert.match(comments[0].text, /- src\/b\.js: changed in the same lines here and in the new commits/)
  assert.match(comments[0].text, /quilt_write_file/)
  assert.match(comments[0].text, /Quilt closes this task by itself/)
  assert.match(comments[1].text, /What origin\/main changed in src\/b\.js[\s\S]*\+three \(pushed\)/)
  assert.equal(room.doc.getMap('clashes').get('main').task, id, 'a folder that comes back finds the same task')
  assert.equal(room.meta.upstreams.main.sha, c1, 'the recorded commit stays until the merge lands')
  const task = out(await grok.call('quilt_tasks'))
  assert.match(task, new RegExp(id))
  // Looked at again with nothing resolved: still one task, no new comments.
  const [again] = await srv.checkUpstreams(W, { force: true })
  assert.equal(again.state, 'clash')
  assert.equal([...room.tasks.values()].filter((t) => t.id === id).length, 1)
  assert.equal(room.taskComments.get(id).length, comments.length)
  // The agent writes the merged file; the next look brings everything in and closes the task.
  const merged = B_JS.replace('three', 'three (session, pushed)')
  assert.ok(!(await grok.call('quilt_write_file', { path: 'src/b.js', content: merged })).isError)
  const [landed] = await srv.checkUpstreams(W, { force: true })
  assert.equal(landed.state, 'brought', JSON.stringify(landed))
  assert.deepEqual(landed.resolved, ['src/b.js'])
  assert.equal(out(await grok.call('quilt_read_file', { path: 'src/b.js' })), merged, 'the agent\'s merge is kept')
  assert.equal(out(await grok.call('quilt_read_file', { path: 'src/c.js' })), 'c\n')
  const done = room.tasks.get(id)
  assert.equal(done.column, 'done')
  assert.match(done.verified, /^Brought in at [0-9a-f]{7}: the relay merged 1 commit from origin\/main into main/)
  assert.equal(room.meta.upstreams.main.sha, c2)
})

test('a folder that comes back behind origin follows the relay: git fast-forwards to its commit without the files being written again', async (t) => {
  const room = srv.rooms.get(W)
  assert.equal(git(carlDir, 'rev-parse', 'HEAD'), c0, 'Carl\'s folder was left behind')
  let writes = []
  carl = await open(carlDir, 'Carl', { room: W, url: W_URL, sub: 'user-carl' })
  t.after(() => carl.stop())
  const write0 = carl.writeFile.bind(carl)
  carl.writeFile = (rel, abs, data) => { writes.push(rel); return write0(rel, abs, data) }
  // Coming back, the folder takes in what the session did while it was away (as always)...
  await waitFor(() => read(carlDir, 'src/c.js') === 'c\n' && read(carlDir, 'src/b.js') === B_JS.replace('three', 'three (session, pushed)'))
  if (git(carlDir, 'rev-parse', 'HEAD') === c0) writes = []
  // ...then finds its branch two commits behind origin, the relay's commit: git moves, no file is written.
  await waitFor(() => git(carlDir, 'rev-parse', 'HEAD') === c2, 15000)
  await waitFor(() => carl.logs.some((l) => l.includes(`main follows the relay to ${c2.slice(0, 7)}`)))
  assert.deepEqual(writes, [], 'no file written by the bring-in: the session already had them')
  assert.equal(read(carlDir, 'src/a.js'), 'ALPHA (session)\nbeta\ngamma (pushed)\n')
  // git sees only the session's own work: the commits' changes are in HEAD now.
  const changed = gitBuf(carlDir, 'status', '--porcelain').toString().split('\n').filter((l) => l && !l.endsWith('.gitignore')).sort()
  assert.deepEqual(changed, [' M README.md', ' M src/a.js', ' M src/b.js'])
  assert.equal(git(carlDir, 'diff', 'src/b.js').includes('+three (session, pushed)'), true)
  // Its folder is back and in step at that commit: the relay's record follows it, and the relay stands down.
  await waitFor(() => room.meta.upstreams.main.sha === c2 && !room.meta.upstreams.main.relayHead)
  assert.deepEqual(await srv.checkUpstreams(W, { force: true }), [])
})

// ------------------------------------------------------------ a private repository --

let dana, danaDir, eve, eveDir, kim
const S = 'ru-s'
const S_URL = 'git@github.com:acme/secret.git'

test('the GitHub token is the owner\'s to set: anyone else is refused by the relay', async () => {
  seed(bareS, pusherS, { 'app.txt': 'v1\n' })
  danaDir = tmp('dana'); git(danaDir, 'clone', '-q', bareS, '.')
  dana = await open(danaDir, 'Dana', { room: S, url: S_URL, sub: 'user-dana' })
  await waitFor(() => dana.isOwner)
  eveDir = tmp('eve'); git(eveDir, 'clone', '-q', bareS, '.')
  eve = await open(eveDir, 'Eve', { room: S, url: S_URL, sub: 'user-eve' })
  await waitFor(() => dana.waiting.some((p) => p.name === 'Eve'))
  await dana.approve(dana.waiting.find((p) => p.name === 'Eve').key, { role: 'editor' })
  await waitFor(() => eve.access && eve.access.state === 'approved')
  await assert.rejects(eve.setGithubToken(TOKEN), /only the session owner/)
  await assert.rejects(eve.conn.adminRequest({ op: 'githubToken', token: TOKEN }), /only the session owner/, 'the relay refuses it too')
  await assert.rejects(dana.setGithubToken('not a token!'), /doesn't look like a GitHub token/)
  assert.equal(srv.rooms.get(S).meta.githubToken, undefined)
  kim = await hosted('agent-kim', 'Kim-Bot', S, dana)
  assert.ok(!(await kim.call('quilt_write_file', { path: 'notes.md', content: 'kim\n' })).isError)
  await waitFor(() => srv.rooms.get(S).meta.upstreams?.main?.repo === 'github.com/acme/secret')
})

test('a private repository without a token: the status says so, once', async () => {
  await eve.stop()
  await dana.stop()
  const room = srv.rooms.get(S)
  push(pusherS, { 'app.txt': 'v2\n' })
  const n = logs.length
  const [r] = await srv.checkUpstreams(S, { force: true })
  assert.equal(r.state, 'private')
  const said = "the relay can't read github.com/acme/secret: ask the session owner to add a read-only GitHub token (session settings, or quilt_github_token)"
  assert.equal(room.meta.upstreams.main.problem, said)
  assert.equal(room.branchList().find((b) => b.key === 'main').relay.problem, said)
  assert.match(out(await kim.call('quilt_status')), new RegExp(`Note: ${said.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  await srv.checkUpstreams(S, { force: true })
  assert.equal(logs.slice(n).filter((l) => l.includes(said)).length, 1, 'logged once, not on every look')
  assert.equal(out(await kim.call('quilt_read_file', { path: 'app.txt' })), 'v1\n')
})

test('with the owner\'s token the relay reads the private repository; the token never shows in presence, the branch list, status or the logs', async () => {
  dana = await open(danaDir, 'Dana', { room: S, url: S_URL, sub: 'user-dana' })
  await waitFor(() => dana.isOwner)
  const r = await dana.setGithubToken(TOKEN)
  assert.deepEqual(r, { ok: true, githubToken: true })
  await waitFor(() => dana.access.githubToken === true)
  const room = srv.rooms.get(S)
  assert.equal(room.meta.githubToken, TOKEN)
  assert.equal(room.meta.upstreams.main.problem, undefined, 'a new token clears what was said')
  const seen = [
    JSON.stringify([...room.awareness.getStates().values()]),
    JSON.stringify(room.branchList()),
    JSON.stringify(dana.status()),
    JSON.stringify(dana.branchList),
    dana.logs.join('\n')
  ]
  // Her folder takes v2 in itself while online: a newer push is what the relay brings in.
  await waitFor(() => room.meta.upstreams.main.sha === git(pusherS, 'rev-parse', 'HEAD'), 15000)
  // Dana's app goes; her folder offline, Kim's next look reads the repository with the token.
  await dana.stop()
  const v3 = push(pusherS, { 'app.txt': 'v3\n' })
  const n = gh.calls.length
  const [r2] = await srv.checkUpstreams(S, { force: true })
  assert.equal(r2.state, 'brought', JSON.stringify(r2))
  assert.equal(out(await kim.call('quilt_read_file', { path: 'app.txt' })), 'v3\n')
  assert.equal(room.meta.upstreams.main.sha, v3)
  const calls = gh.calls.slice(n)
  assert.ok(calls.length && calls.every((c) => c.headers.authorization === `Bearer ${TOKEN}` && !c.url.includes(TOKEN)), 'in a header, never the URL')
  assert.ok(calls.every((c) => c.url.startsWith('https://api.github.com/')), 'private files through the API, with the token')
  seen.push(out(await kim.call('quilt_status')), out(await kim.call('quilt_branches')), JSON.stringify(room.branchList()), logs.join('\n'))
  for (const s of seen) assert.ok(!s.includes(TOKEN) && !s.includes('TESTONLY'), 'the token never leaves the relay\'s meta')
})

test('GitHub saying slow down (403 with the rate limit spent, or 429) backs the relay off until it may ask again', async () => {
  const room = srv.rooms.get(S)
  const rec = room.meta.upstreams.main
  push(pusherS, { 'app.txt': 'v4\n' })
  const reset = Math.floor(Date.now() / 1000) + 120
  gh.state.throttle = { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }
  const [r] = await srv.checkUpstreams(S, { force: true })
  assert.equal(r.state, 'backoff')
  assert.ok(Math.abs(rec.backoffUntil - reset * 1000) < 3000, 'until the rate limit resets')
  assert.match(rec.problem, /GitHub asked the relay to slow down/)
  const n = gh.calls.length
  assert.deepEqual(await srv.checkUpstreams(S, { force: true }), [], 'not asked again while backing off')
  assert.equal(gh.calls.length, n)
  // Time passes: asked again; a 429 with Retry-After waits that long.
  rec.backoffUntil = Date.now() - 1
  gh.state.throttle = { status: 429, headers: { 'retry-after': '30' } }
  const [r2] = await srv.checkUpstreams(S, { force: true })
  assert.equal(r2.state, 'backoff')
  assert.ok(Math.abs(rec.backoffUntil - (Date.now() + 30000)) < 3000)
  rec.backoffUntil = Date.now() - 1
  const [r3] = await srv.checkUpstreams(S, { force: true })
  assert.equal(r3.state, 'brought')
  assert.equal(rec.backoffUntil, undefined, 'a good answer ends the back-off')
  assert.equal(rec.problem, undefined)
  assert.equal(out(await kim.call('quilt_read_file', { path: 'app.txt' })), 'v4\n')
})

after(async () => { await grok?.c.close(); await kim?.c.close() })

// ------------------------------------------------------------ the parts on their own --

test('remote URLs become host/owner/name without credentials; other hosts are told apart', () => {
  assert.deepEqual(parseRepo('https://x-access-token:ghp_secret@github.com/acme/widgets.git'), { host: 'github.com', owner: 'acme', name: 'widgets', github: true, slug: 'github.com/acme/widgets' })
  assert.equal(parseRepo('git@github.com:acme/widgets.git').slug, 'github.com/acme/widgets')
  assert.equal(parseRepo('ssh://git@github.com/acme/widgets').slug, 'github.com/acme/widgets')
  assert.equal(parseRepo('https://gitlab.com/acme/widgets.git').github, false)
  assert.equal(parseRepo('/tmp/bare'), null)
  assert.equal(upstreamRef('origin/main'), 'main')
  assert.equal(upstreamRef('origin/feature/x'), 'feature/x')
  assert.equal(upstreamRef('my/remote/main', 'my/remote'), 'main')
})

test('back-off: Retry-After, then the rate limit reset, else doubling from 15 minutes up to 6 hours', () => {
  const h = (o) => new Headers(o)
  assert.equal(backoffFor({ headers: h({ 'retry-after': '60' }) }, {}), 60000)
  const now = Date.now()
  assert.ok(Math.abs(backoffFor({ headers: h({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(now / 1000) + 600) }) }, {}, now) - 600000) < 2000)
  assert.equal(backoffFor({ headers: h({}) }, {}), FIRST_BACKOFF_MS)
  assert.equal(backoffFor({ headers: h({}) }, { backoffMs: FIRST_BACKOFF_MS }), 2 * FIRST_BACKOFF_MS)
  assert.equal(backoffFor({ headers: h({}) }, { backoffMs: MAX_BACKOFF_MS }), MAX_BACKOFF_MS)
})

/** A stand-in room: presence, connections and hosted agents, as relay-upstream.js reads them. */
function fakeRoom ({ states = [], hosted = [], upstreams = {} } = {}) {
  const doc = new Y.Doc()
  const map = new Map(states.map((s, i) => [i + 1, s]))
  const conns = new Map(states.map((s, i) => [{ branch: s.on || 'main' }, new Set([i + 1])]))
  return {
    name: 'r', exists: true, ended: false, doc,
    meta: { branches: { main: {} }, members: Object.fromEntries(hosted.map((h) => [h.id, { name: h.name, role: 'editor' }])), upstreams },
    awareness: { getStates: () => map },
    conns,
    hostedOnline: () => hosted.map((h) => ({ ...h, seen: Date.now() })),
    hostedBranch: () => 'main'
  }
}

test('in-step folders move the recorded commit; once the relay moved it, a folder behind (or not yet fetched) does not move it back', () => {
  const A = 'a'.repeat(40); const H = 'b'.repeat(40); const C = 'c'.repeat(40)
  const git = (sha, up = {}) => ({ name: 'P', git: { branch: 'main', sha, held: null, upstream: { name: 'origin/main', url: 'https://github.com/acme/w.git', behind: 0, ...up } } })
  let r = fakeRoom({ states: [git(A)] })
  assert.equal(noteFolders(r), true)
  assert.equal(r.meta.upstreams.main.sha, A)
  r = fakeRoom({ states: [git(A, { sha: A })], upstreams: { main: { repo: 'github.com/acme/w', name: 'origin/main', ref: 'main', sha: H, head: H, relayHead: H } } })
  noteFolders(r)
  assert.equal(r.meta.upstreams.main.sha, H, 'a folder still at the old commit, not fetched yet')
  r = fakeRoom({ states: [git(A, { sha: H, behind: 1 })], upstreams: { main: { repo: 'github.com/acme/w', name: 'origin/main', ref: 'main', sha: H, head: H, relayHead: H } } })
  noteFolders(r)
  assert.equal(r.meta.upstreams.main.sha, H, 'a folder behind it')
  r = fakeRoom({ states: [git(C, { sha: H })], upstreams: { main: { repo: 'github.com/acme/w', name: 'origin/main', ref: 'main', sha: H, head: H, relayHead: H } } })
  noteFolders(r)
  assert.equal(r.meta.upstreams.main.sha, C, 'a folder that sees the same upstream and is past it')
  assert.equal(r.meta.upstreams.main.relayHead, undefined)
  r = fakeRoom({ states: [{ ...git(C), git: { ...git(C).git, held: 'busy' } }] })
  noteFolders(r)
  assert.equal(r.meta.upstreams.main?.sha, undefined, 'a held folder is not in step')
})

test('due: hosted agents on the branch (or a call in the last 30 minutes), no folder online, last look long enough ago, not backing off', () => {
  const now = Date.now()
  const rec = (o) => ({ main: { repo: 'github.com/acme/w', name: 'origin/main', ref: 'main', sha: 'a'.repeat(40), ...o } })
  assert.deepEqual(dueBranches(fakeRoom({ hosted: [{ id: 'agent:x', name: 'X' }], upstreams: rec({}) }), { now }), ['main'])
  assert.deepEqual(dueBranches(fakeRoom({ upstreams: rec({}) }), { now }), [], 'nobody hosted works there')
  assert.deepEqual(dueBranches(fakeRoom({ upstreams: rec({ hostedAt: now - 60000 }) }), { now }), ['main'], 'a hosted call a minute ago')
  assert.deepEqual(dueBranches(fakeRoom({ hosted: [{ id: 'agent:x', name: 'X' }], upstreams: rec({ checkedAt: now - 60000 }) }), { now }), [], 'looked at a minute ago')
  assert.deepEqual(dueBranches(fakeRoom({ hosted: [{ id: 'agent:x', name: 'X' }], upstreams: rec({ backoffUntil: now + 1000 }) }), { now }), [])
  const folder = { name: 'P', git: { branch: 'main', sha: 'a'.repeat(40), upstream: { name: 'origin/main', behind: 0 } } }
  assert.deepEqual(dueBranches(fakeRoom({ states: [folder], hosted: [{ id: 'agent:x', name: 'X' }], upstreams: rec({}) }), { now }), [], 'a folder that can bring commits in is online on it')
})

test('the branch board shows what the relay brought in and when it last looked', () => {
  const now = Date.now()
  const board = branchBoard([], [{ key: 'main', default: true, relay: { sha: 'a'.repeat(40), upstream: 'origin/main', checkedAt: now - 120000, brought: { count: 3, files: 2, at: now - 600000 } } }])
  assert.match(branchesMarkdown(board, { now }), /brought in by the relay 10m ago \(3 commits from origin\/main, 2 files\); the relay last checked origin\/main 2m ago/)
})
