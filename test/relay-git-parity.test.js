// Agents can do with git what people with the same role can, even when no person is online:
// pull now (hosted quilt_sync_branch, or a folder that can't fetch asking the relay), merges
// that land as soon as they are written, commit requests over HTTP, branches loaded from
// GitHub, the GitHub token, and a folder whose fetch fails being said and covered by the
// relay. GitHub is a fake answering from local bare repositories: no network.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { signPass, PASS_TTL_MS } from '../src/passes.js'
import { PASS_KEYS, testPasses } from './pass-helpers.js'
import { relayLooks, canBringIn, noteFolders, loadBranch, configureGithubBudget, resetGithubBudgets, LONG_HOLD_MS } from '../src/relay-upstream.js'
import { addTask } from '../src/tasks.js'
import { clashTaskId } from '../src/clash.js'
import { fetchProblem } from '../src/gitstate.js'
import { describeBranchSync, branchBoard, branchesMarkdown, upstreamLine } from '../src/branches.js'
import { makeChatLink } from '../src/chat-links.js'
import { HOSTED_INSTRUCTIONS } from '../src/relay-mcp.js'

process.env.QUILT_UPSTREAM_MS = '400'
process.env.HOME = process.env.USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-gp-home-'))
const { startServer } = await import('../src/server.js')
const { Session } = await import('../src/session.js')
const { generateIdentity } = await import('../src/identity.js')

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-gp-${n}-`))
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
const TOKEN = 'github_pat_TESTONLY0123456789abcdefPARITY'

/** GitHub's REST API as the relay uses it (head with ETag, compare, trees, the repository, file contents), from bare repositories. */
function fakeGitHub (repos) {
  const calls = []
  const res = (body, status = 200, headers = {}) => new Response(body, { status, headers })
  const fetch = async (url, init = {}) => {
    const h = init.headers || {}
    calls.push({ url, headers: h })
    const u = new URL(url)
    let owner, name, rest
    if (u.host === 'api.github.com') {
      const m = /^\/repos\/([^/]+)\/([^/]+)(?:\/(.+))?$/.exec(u.pathname)
      if (!m) return res('{}', 404);
      [, owner, name, rest] = m
      rest = rest || ''
    } else if (u.host === 'raw.githubusercontent.com') {
      const m = /^\/([^/]+)\/([^/]+)\/([0-9a-f]{40})\/(.+)$/.exec(u.pathname)
      if (!m) return res('', 404)
      owner = m[1]; name = m[2]; rest = `raw/${m[3]}/${m[4]}`
    } else return res('', 404)
    const repo = repos[`${owner}/${name}`]
    if (!repo || (repo.private && h.authorization !== `Bearer ${repo.token}`)) return res('Not Found', 404)
    const dir = repo.dir
    let m
    if (rest === '') return res(JSON.stringify({ full_name: `${owner}/${name}` }))
    if ((m = /^commits\/(.+)$/.exec(rest))) {
      const sha = gitBuf(dir, 'rev-parse', '--verify', `refs/heads/${decodeURIComponent(m[1])}`)?.toString().trim()
      if (!sha) return res('{"message":"No commit found"}', 404)
      const etag = `"${sha}"`
      if (h['if-none-match'] === etag) return res(null, 304, { etag })
      return res(sha, 200, { etag })
    }
    if ((m = /^git\/trees\/([0-9a-f]{40})$/.exec(rest))) {
      const tree = git(dir, 'ls-tree', '-r', '-l', m[1]).split('\n').filter(Boolean).map((l) => {
        const [meta, p] = l.split('\t')
        const [mode, type, , size] = meta.split(/\s+/)
        return { path: p, mode, type, size: Number(size) }
      })
      return res(JSON.stringify({ sha: m[1], tree, truncated: false }))
    }
    if ((m = /^compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(rest))) {
      const [, base, head] = m
      if (gitBuf(dir, 'cat-file', '-e', `${base}^{commit}`) === null) return res('{"message":"Not Found"}', 404)
      if (base === head) return res(JSON.stringify({ status: 'identical', ahead_by: 0, files: [] }))
      const isAnc = (a, b) => gitBuf(dir, 'merge-base', '--is-ancestor', a, b) !== null
      const status = isAnc(base, head) ? 'ahead' : isAnc(head, base) ? 'behind' : 'diverged'
      const ahead = Number(git(dir, 'rev-list', '--count', `${base}..${head}`))
      const files = git(dir, 'diff', '--name-status', '-M', base, head).split('\n').filter(Boolean).map((l) => {
        const [st, a, b] = l.split('\t')
        if (st.startsWith('R')) return { filename: b, previous_filename: a, status: 'renamed' }
        return { filename: a, status: st === 'A' ? 'added' : st === 'D' ? 'removed' : 'modified' }
      })
      return res(JSON.stringify({ status, ahead_by: ahead, total_commits: ahead, files }))
    }
    const file = (sha, p) => { const b = gitBuf(dir, 'cat-file', 'blob', `${sha}:${p}`); return b ? res(b) : res('', 404) }
    if ((m = /^contents\/(.+)$/.exec(rest))) return file(u.searchParams.get('ref'), decodeURIComponent(m[1]))
    if ((m = /^raw\/([0-9a-f]{40})\/(.+)$/.exec(rest))) return file(m[1], decodeURIComponent(m[2]))
    return res('', 404)
  }
  return { fetch, calls }
}

const bareW = tmp('bare-w'); git(bareW, 'init', '-q', '--bare', '-b', 'main')
const bareS = tmp('bare-s'); git(bareS, 'init', '-q', '--bare', '-b', 'main')
const pusherW = tmp('pusher-w')
const pusherS = tmp('pusher-s')
const X_JS = 'one\ntwo\nthree\nfour\nfive\nsix\n'
function seed (bare, pusher, files) {
  git(pusher, 'clone', '-q', bare, '.')
  for (const [rel, text] of Object.entries(files)) write(pusher, rel, text)
  git(pusher, 'add', '.'); git(pusher, 'commit', '-qm', 'one'); git(pusher, 'push', '-q', 'origin', 'main')
  return git(pusher, 'rev-parse', 'HEAD')
}
const push = (pusher, files, branch = 'main') => {
  git(pusher, 'checkout', '-q', branch)
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) fs.rmSync(path.join(pusher, rel), { force: true }); else write(pusher, rel, text)
  }
  git(pusher, 'add', '-A'); git(pusher, 'commit', '-qm', 'more'); git(pusher, 'push', '-q', 'origin', branch)
  return git(pusher, 'rev-parse', 'HEAD')
}

let srv, server, gh
const ids = new Map()
const identityOf = (n) => { if (!ids.has(n)) ids.set(n, generateIdentity()); return ids.get(n) }
/** A member's app on `dir`; `url` stands in for its origin's address as git reports it. */
async function open (dir, name, { room, url, sub }) {
  const identity = identityOf(name)
  const s = new Session({ dir, server, room, secret: 's', viewSecret: 'v', name, tool: 'Claude Code', identity, passes: testPasses(identity, { name, sub }) })
  const set = s.setUpstream.bind(s)
  s.setUpstream = (up) => set(up ? { ...up, url } : up)
  s.told = []
  const notice = s.notice.bind(s)
  s.notice = (text) => { s.told.push(text); notice(text) }
  sessions.push(s)
  await s.start({ waitTimeoutMs: 5000 })
  s.setAgentState({ tool: 'Claude Code', status: 'idle' })
  return s
}
const clients = []
async function hosted (sub, name, room, owner, { role = 'editor', kind = 'agent', approve = true, grant = null } = {}) {
  // `grant`: the access the accounts API would put in a pass for this room (let straight in).
  const pass = () => signPass({ v: 1, sub, kind, name, key: '', exp: Date.now() + PASS_TTL_MS, ...(grant ? { room, access: grant } : {}) }, PASS_KEYS.privateKey)
  const c = new Client({ name: sub, version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), { requestInit: { headers: { 'x-quilt-pass': pass() } } }))
  clients.push(c)
  const call = (tool, args = {}) => c.callTool({ name: tool, arguments: args })
  await call('quilt_join_session', { invite: `https://join.heyquilt.com/${room}#${role === 'viewer' ? 'v' : 's'}` })
  if (approve && !grant) {
    await waitFor(() => owner.waiting.some((p) => p.key === `${kind}:${sub}`))
    await owner.approve(`${kind}:${sub}`, { role })
    await waitFor(() => owner.members.some((m) => m.key === `${kind}:${sub}`))
  }
  return { c, call }
}

before(async () => {
  gh = fakeGitHub({ 'acme/widgets': { dir: bareW }, 'acme/secret': { dir: bareS, private: true, token: TOKEN } })
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, passPublicKey: PASS_KEYS.publicKey, upstreamAuto: false, githubAnonPerHour: 100000, upstreamOnChange: true, githubFetch: gh.fetch, idleUnloadMs: 10 * 60 * 1000 })
  server = `ws://127.0.0.1:${srv.port}`
})
const sessions = []
after(async () => { for (const s of sessions) await s.stop().catch(() => {}); for (const c of clients) await c.close().catch(() => {}); await srv.close() })

const W = 'gp-w'
const W_URL = 'https://github.com/acme/widgets.git'
let carl, carlDir, grok, hal, vee, c0

test('hosted quilt_sync_branch: left to a folder that can fetch; with none online, the relay asks GitHub now, at most once a minute', async () => {
  c0 = seed(bareW, pusherW, { 'x.js': X_JS, 'y.js': X_JS, 'README.md': '# W\n' })
  carlDir = tmp('carl'); git(carlDir, 'clone', '-q', bareW, '.')
  carl = await open(carlDir, 'Carl', { room: W, url: W_URL, sub: 'user-carl' })
  await waitFor(() => carl.isOwner)
  grok = await hosted('agent-grok', 'Grok-Bot', W, carl)
  hal = await hosted('agent-hal', 'Hal', W, carl)
  vee = await hosted('agent-vee', 'Vee', W, carl, { role: 'viewer' })
  const room = srv.rooms.get(W)
  await waitFor(() => room.meta.upstreams?.main?.sha === c0 && room.meta.upstreams.main.repo && room.meta.upstreams.main.ref)
  // Carl's folder fetches itself: the relay leaves it alone.
  assert.match(out(await grok.call('quilt_sync_branch')), /^Carl's folder on `main` brings commits in itself/)
  await carl.stop()
  const c1 = push(pusherW, { 'docs/a.md': 'a\n' })
  const n = gh.calls.length
  const r = out(await grok.call('quilt_sync_branch'))
  assert.match(r, /^Brought 1 commit from origin\/main into `main` \(1 file\), merged with the session's uncommitted work\. `main` is up to date with origin\/main/)
  assert.ok(gh.calls.length > n, 'GitHub was asked')
  assert.equal(out(await grok.call('quilt_read_file', { path: 'docs/a.md' })), 'a\n')
  assert.equal(room.meta.upstreams.main.sha, c1)
  // Again at once: not asked again, said so.
  const m = gh.calls.length
  assert.match(out(await hal.call('quilt_sync_branch')), /asks at most once a minute per branch/)
  assert.equal(gh.calls.length, m)
})

test('a clash goes to a hosted agent (never a chat link), who holds the files while merging; a partner is refused; a write that only touches other lines does not count; the merged write lands at once', async () => {
  const room = srv.rooms.get(W)
  room.syncAsked.clear()
  // A chat link on main, more recently active than anyone: it can only add new files, so never the assignee.
  const link = makeChatLink(room, { name: 'Chatty', by: 'Carl' })
  room.hostedActive(`chat:${link.id}`)
  const mine = X_JS.replace('three', 'three (session)')
  assert.ok(!(await grok.call('quilt_write_file', { path: 'x.js', content: mine })).isError)
  const c2 = push(pusherW, { 'x.js': X_JS.replace('three', 'three (pushed)').replace('six', 'six (pushed)'), 'z.js': 'z\n' })
  const said = out(await grok.call('quilt_sync_branch'))
  const id = clashTaskId('main', c2)
  assert.match(said, /^Nothing brought in: origin\/main \([0-9a-f]{7}\) clashes with the session's uncommitted work on `main` in:\n- x\.js: changed in the same lines/)
  assert.match(said, new RegExp(`Task ${id} on the board \\(Grok-Bot\\)`))
  assert.equal(room.tasks.get(id).assignee, 'Grok-Bot', 'not the chat link')
  // Grok holds x.js for the merge: Hal's write is refused with the usual claim message.
  const claim = room.claimList('main').find((c) => c.pattern === 'x.js')
  assert.equal(claim.by, 'Grok-Bot')
  assert.equal(claim.clash, id)
  const refused = await hal.call('quilt_write_file', { path: 'x.js', content: 'hal was here\n' })
  assert.equal(refused.isError, true)
  assert.match(out(refused), /Grok-Bot/)
  // A write that leaves the lines that clashed as they were is not the merge.
  assert.ok(!(await grok.call('quilt_write_file', { path: 'x.js', content: mine.replace('one', 'one (tidied)') })).isError)
  await new Promise((r) => setTimeout(r, 400))
  assert.equal((await grok.call('quilt_read_file', { path: 'z.js' })).isError, true, 'still nothing brought in')
  assert.notEqual(room.tasks.get(id).column, 'done')
  // The merged write: the relay looks again at once and brings everything in, keeping the merge and taking the rest of the commit.
  const merged = mine.replace('one', 'one (tidied)').replace('three (session)', 'three (session, pushed)')
  assert.ok(!(await grok.call('quilt_write_file', { path: 'x.js', content: merged })).isError)
  await waitFor(() => room.tasks.get(id).column === 'done', 8000)
  assert.equal(out(await grok.call('quilt_read_file', { path: 'x.js' })), merged.replace('six', 'six (pushed)'))
  assert.equal(out(await grok.call('quilt_read_file', { path: 'z.js' })), 'z\n')
  assert.equal(room.meta.upstreams.main.sha, c2)
  // The merge is done: x.js is let go of.
  await waitFor(() => !room.claimList('main').some((c) => c.clash === id))
})

test('a clash whose assignee keeps its side moves the task to QA: the files count as merged; someone else moving it does not', async () => {
  const room = srv.rooms.get(W)
  room.syncAsked.clear()
  const mine = X_JS.replace('two', 'two (session)')
  assert.ok(!(await grok.call('quilt_write_file', { path: 'y.js', content: mine })).isError)
  const c3 = push(pusherW, { 'y.js': X_JS.replace('two', 'two (pushed)') })
  assert.match(out(await grok.call('quilt_sync_branch')), /Nothing brought in/)
  const id = clashTaskId('main', c3)
  // Hal moving it to QA is not the assignee saying it is merged.
  assert.ok(!(await hal.call('quilt_move_task', { id, column: 'qa', qaNotes: 'Looked at y.js and it seemed fine to me, so moving it along to QA now.' })).isError)
  await new Promise((r) => setTimeout(r, 400))
  assert.notEqual(room.meta.upstreams.main.sha, c3)
  // Grok moving it with conflict markers still in y.js is not a merge either.
  const marked = X_JS.replace('two', '<<<<<<< session\ntwo (session)\n=======\ntwo (pushed)\n>>>>>>> origin/main')
  assert.ok(!(await grok.call('quilt_write_file', { path: 'y.js', content: marked })).isError)
  assert.ok(!(await grok.call('quilt_move_task', { id, column: 'qa', qaNotes: 'Merged y.js line two by hand, keeping both versions of the line for review.' })).isError)
  await new Promise((r) => setTimeout(r, 400))
  assert.notEqual(room.meta.upstreams.main.sha, c3, 'conflict markers left: not merged')
  // Grok keeps the session's line and moves it to QA: brought in, y.js as it is.
  assert.ok(!(await grok.call('quilt_write_file', { path: 'y.js', content: mine })).isError)
  assert.ok(!(await grok.call('quilt_move_task', { id, column: 'qa', qaNotes: 'Kept the session version of y.js line two on purpose; upstream change superseded.' })).isError)
  await waitFor(() => room.meta.upstreams.main.sha === c3, 8000)
  assert.equal(out(await grok.call('quilt_read_file', { path: 'y.js' })), mine)
  await waitFor(() => room.tasks.get(id).column === 'done')
})

test('a relay clash handed on (its assignee left the branch) moves the held files to the new assignee', async () => {
  const room = srv.rooms.get(W)
  room.syncAsked.clear()
  const mine = X_JS.replace('four', 'four (session)')
  assert.ok(!(await grok.call('quilt_write_file', { path: 'w.js', content: X_JS })).isError)
  assert.ok(!(await grok.call('quilt_release', { pattern: 'w.js' })).isError)
  push(pusherW, { 'w.js': X_JS })
  assert.match(out(await grok.call('quilt_sync_branch')), /up to date|Brought/)
  room.syncAsked.clear()
  assert.ok(!(await grok.call('quilt_write_file', { path: 'w.js', content: mine })).isError)
  const c5 = push(pusherW, { 'w.js': X_JS.replace('four', 'four (pushed)') })
  assert.match(out(await grok.call('quilt_sync_branch')), /Nothing brought in/)
  const id = clashTaskId('main', c5)
  assert.equal(room.claimList('main').find((c) => c.pattern === 'w.js').by, 'Grok-Bot')
  // Grok moves to another branch: the next look hands the task, and w.js, to Hal.
  assert.ok(!(await grok.call('quilt_switch_branch', { branch: 'side', create: true })).isError)
  room.syncAsked.clear()
  assert.match(out(await hal.call('quilt_sync_branch')), new RegExp(`Task ${id} on the board \\(Hal\\)`))
  const held = room.claimList('main').find((c) => c.pattern === 'w.js')
  assert.deepEqual([held.by, held.clash], ['Hal', id])
  assert.ok(!(await grok.call('quilt_switch_branch', { branch: 'main' })).isError)
  // Hal's merge lands at once, and w.js is let go of.
  assert.ok(!(await hal.call('quilt_write_file', { path: 'w.js', content: X_JS.replace('four', 'four (session, pushed)') })).isError)
  await waitFor(() => room.meta.upstreams.main.sha === c5, 8000)
  await waitFor(() => !room.claimList('main').some((c) => c.clash === id))
})

test('commit requests over HTTP, with the same rules as people: a viewer is refused, one who may not post is refused', async () => {
  const room = srv.rooms.get(W)
  const r = out(await grok.call('quilt_request_commit', { message: 'x.js merge is ready' }))
  assert.match(r, /^Asked for a commit \[[0-9a-f]{12}\] of \d+ files?: /)
  const open = [...room.doc.getMap('commitRequests').values()].filter((x) => x.state === 'open')
  assert.equal(open.length, 1)
  assert.equal(open[0].by, 'Grok-Bot')
  assert.equal(open[0].branch, 'main')
  assert.match(out(await hal.call('quilt_commit_status')), /Open commit requests:\n- \[[0-9a-f]{12}\] Grok-Bot on `main`: x\.js merge is ready \(\d+ files?: /)
  const v = await vee.call('quilt_request_commit', { message: 'me too' })
  assert.deepEqual([v.isError, out(v)], [true, "Viewers can't ask for commits."])
  const mute = await hosted('agent-mute', 'Mute', W, null, { grant: { files: 'edit', folders: [], foldersExcept: [], talk: false } })
  const m = await mute.call('quilt_request_commit', { message: 'shh' })
  assert.equal(m.isError, true)
  assert.match(out(m), /can't post/)
  assert.equal(out(await hal.call('quilt_commit_request_done', { id: open[0].id })), 'Marked 1 commit request done.')
  assert.equal(room.doc.getMap('commitRequests').get(open[0].id).doneBy, 'Hal')
  assert.equal(out(await hal.call('quilt_commit_request_done')), 'No open commit requests.')
})

test('quilt_switch_branch create loads a branch that is only on GitHub at its head (ignored files left out), and the relay pulls into it later', async () => {
  const room = srv.rooms.get(W)
  git(pusherW, 'checkout', '-q', '-b', 'feature')
  write(pusherW, '.quiltignore', 'secret.txt\n')
  write(pusherW, 'secret.txt', 'keep me home\n')
  write(pusherW, 'feature.md', 'feature v1\n')
  git(pusherW, 'add', '-A'); git(pusherW, 'commit', '-qm', 'feature'); git(pusherW, 'push', '-q', 'origin', 'feature')
  const f1 = git(pusherW, 'rev-parse', 'HEAD')
  const r = out(await grok.call('quilt_switch_branch', { branch: 'feature', create: true }))
  assert.match(r, new RegExp(`^Loaded feature from GitHub \\(github\\.com/acme/widgets at ${f1.slice(0, 7)}, \\d+ files\\)\\.`))
  assert.match(r, /The relay brings new commits on origin\/feature in while no folder on it can/)
  assert.equal(out(await grok.call('quilt_read_file', { path: 'feature.md' })), 'feature v1\n')
  assert.equal(out(await grok.call('quilt_read_file', { path: 'x.js' })), git(pusherW, 'show', 'feature:x.js') + '\n')
  assert.equal((await grok.call('quilt_read_file', { path: 'secret.txt' })).isError, true, '.quiltignore is honoured')
  const rec = room.meta.upstreams.feature
  assert.deepEqual([rec.repo, rec.name, rec.ref, rec.sha], ['github.com/acme/widgets', 'origin/feature', 'feature', f1])
  // A push to feature: brought in by the relay on that branch.
  const f2 = push(pusherW, { 'feature.md': 'feature v2\n', 'secret.txt': 'still home\n' }, 'feature')
  assert.match(out(await grok.call('quilt_sync_branch')), /^Brought 1 commit from origin\/feature into `feature` \(1 file\)/)
  assert.equal(out(await grok.call('quilt_read_file', { path: 'feature.md' })), 'feature v2\n')
  assert.equal((await grok.call('quilt_read_file', { path: 'secret.txt' })).isError, true, '.quiltignore read from the commit')
  assert.equal(room.meta.upstreams.feature.sha, f2)
  git(pusherW, 'checkout', '-q', 'main')
  // Not on GitHub: said plainly, and started from a copy as before.
  const nope = out(await grok.call('quilt_switch_branch', { branch: 'nope', create: true }))
  assert.match(nope, /^nope isn't a branch on GitHub \(github\.com\/acme\/widgets\), so started nope from feature, with a copy of its files\./)
})

test('a private repository without a token: switching to its branch says to ask the session owner, and starts from a copy', async () => {
  seed(bareS, pusherS, { 'app.txt': 'v1\n' })
  git(pusherS, 'checkout', '-q', '-b', 'dev'); write(pusherS, 'dev.txt', 'dev\n'); git(pusherS, 'add', '.'); git(pusherS, 'commit', '-qm', 'dev'); git(pusherS, 'push', '-q', 'origin', 'dev')
  const danaDir = tmp('dana'); git(danaDir, 'clone', '-q', bareS, '.')
  const dana = await open(danaDir, 'Dana', { room: 'gp-s', url: 'git@github.com:acme/secret.git', sub: 'user-dana' })
  await waitFor(() => dana.isOwner)
  const kim = await hosted('agent-kim', 'Kim', 'gp-s', dana)
  await waitFor(() => srv.rooms.get('gp-s').meta.upstreams?.main?.repo === 'github.com/acme/secret')
  const r = out(await kim.call('quilt_switch_branch', { branch: 'dev', create: true }))
  assert.match(r, /^The relay can't read github\.com\/acme\/secret on GitHub \(a private repository needs a read-only token: ask the session owner to add one\), so started dev from main, with a copy of its files\./)
  // quilt_github_token: owner only, never echoed. The owner over HTTP (her own account) sets it.
  const k = await kim.call('quilt_github_token', { token: TOKEN })
  assert.deepEqual([k.isError, out(k)], [true, 'Only the session owner can set the GitHub token: ask them.'])
  const owner = await hosted('user-dana', 'Dana', 'gp-s', dana, { kind: 'person', approve: false })
  const set = out(await owner.call('quilt_github_token', { token: TOKEN }))
  assert.equal(set, 'Saved the GitHub token on the relay. It looks at the session\'s branches again now.')
  assert.ok(!set.includes(TOKEN))
  assert.equal(srv.rooms.get('gp-s').meta.githubToken, TOKEN)
  assert.match(out(await kim.call('quilt_switch_branch', { branch: 'dev2', create: true })), /^dev2 isn't a branch on GitHub \(github\.com\/acme\/secret\)/)
  assert.equal(out(await owner.call('quilt_github_token', { token: '' })), 'Removed the GitHub token.')
  await dana.stop()
})

test('a folder whose fetch fails says why, never "up to date", tells the relay in presence, and quilt_sync_branch asks the relay instead', async () => {
  const room = srv.rooms.get(W)
  const dir = tmp('eve'); git(dir, 'clone', '-q', bareW, '.')
  git(dir, 'remote', 'set-url', 'origin', path.join(tmp('gone'), 'nowhere.git'))
  const carlAgain = await open(carlDir, 'Carl', { room: W, url: W_URL, sub: 'user-carl' })
  await waitFor(() => carlAgain.isOwner)
  const eve = await open(dir, 'Eve', { room: W, url: W_URL, sub: 'user-eve' })
  await waitFor(() => carlAgain.waiting.some((p) => p.name === 'Eve'))
  await carlAgain.approve(carlAgain.waiting.find((p) => p.name === 'Eve').key, { role: 'editor' })
  await waitFor(() => eve.access && eve.access.state === 'approved')
  await carlAgain.stop()
  await waitFor(() => eve.status().git?.upstream?.fetchOk === false, 15000)
  const u = eve.status().git.upstream
  assert.equal(u.fetchError, "origin isn't a repository git can fetch from")
  assert.doesNotMatch(upstreamLine(u), /up to date/)
  assert.match(upstreamLine(u), /^can't fetch origin\/main: origin isn't a repository git can fetch from/)
  assert.match(eve.told.join('\n'), /Couldn't fetch origin\/main: origin isn't a repository git can fetch from/)
  // Presence says so: the relay doesn't count her folder as one that brings commits in.
  await waitFor(() => [...room.awareness.getStates().values()].some((s) => s.name === 'Eve' && s.git?.upstream?.fetchOk === false))
  assert.equal(relayLooks(room, 'main'), true)
  assert.match(branchesMarkdown(eve.status().branches), /Eve's folder \(can't fetch origin\/main/)
  // quilt_sync_branch (the control route) asks the relay, which brings the push in for her branch.
  const c4 = push(pusherW, { 'docs/b.md': 'b\n' })
  room.syncAsked.clear()
  const said = describeBranchSync(await eve.syncBranchNow())
  assert.match(said, /^Couldn't fetch origin\/main: origin isn't a repository git can fetch from\. Nothing new could be looked for through this folder/)
  assert.match(said, /The relay brings commits in for `main` from GitHub while no folder on it can: Brought 1 commit from origin\/main into `main`/)
  await waitFor(() => read(dir, 'docs/b.md') === 'b\n')
  assert.equal(room.meta.upstreams.main.sha, c4)
  await eve.stop()
})

test('fetch problems in plain English; who can bring commits in; the board prefers a folder that can fetch', () => {
  assert.equal(fetchProblem({ stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled", url: 'https://github.com/a/b.git' }), "git can't sign in to github.com from this folder")
  assert.equal(fetchProblem({ stderr: 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', url: 'git@github.com:a/b.git' }), "git can't sign in to github.com from this folder")
  assert.equal(fetchProblem({ stderr: "fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com", url: 'https://github.com/a/b.git' }), "can't reach github.com (no network?)")
  assert.equal(fetchProblem({ timedOut: true, url: 'https://github.com/a/b.git' }), 'fetching from github.com took over a minute and was stopped')
  assert.ok(!fetchProblem({ stderr: 'fatal: weird https://user:ghp_secret@github.com/a/b', url: 'https://github.com/a/b.git' }).includes('ghp_secret'))
  const room = { access: new Map([['viewer', { role: 'viewer' }]]) }
  const g = (o = {}, up = {}) => ({ branch: 'main', sha: 'a'.repeat(40), held: null, ...o, upstream: { name: 'origin/main', behind: 0, ...up } })
  assert.equal(canBringIn(room, 'ws', g()), true)
  // Held (git at work in it) or diverged: its own git is under way, so it still keeps the relay out.
  assert.equal(canBringIn(room, 'ws', g({ held: 'busy' })), true, 'held')
  assert.equal(canBringIn(room, 'ws', g({ held: 'switching' })), true, 'switching branches')
  assert.equal(canBringIn(room, 'ws', g({}, { diverged: true })), true, 'diverged')
  // Only a hold the relay has seen for over 30 minutes lets it in, never a branch switch.
  const long = { ...room, heldSince: new Map([['ws', { kind: 'busy', since: Date.now() - LONG_HOLD_MS - 1000 }]]) }
  assert.equal(canBringIn(long, 'ws', g({ held: 'busy' })), false, 'held for over 30 minutes')
  assert.equal(canBringIn({ ...room, heldSince: new Map([['ws', { kind: 'switching', since: 0 }]]) }, 'ws', g({ held: 'switching' })), true)
  assert.equal(canBringIn(room, 'ws', g({}, { fetchOk: false })), false, 'its fetch fails')
  assert.equal(canBringIn(room, 'viewer', g()), false, "a viewer's folder")
  assert.equal(canBringIn(room, 'ws', { ...g(), upstream: null }), false, 'no upstream')
  const board = branchBoard([
    { name: 'Eve', git: { branch: 'main', upstream: { name: 'origin/main', behind: 0, fetchOk: false, fetchError: "git can't sign in to github.com from this folder" } } },
    { name: 'Carl', git: { branch: 'main', upstream: { name: 'origin/main', behind: 2 } } }
  ])
  assert.equal(board[0].upstream.behind, 2, 'what a folder that can fetch sees')
  assert.match(describeBranchSync({ git: false }), /clone the repository into this folder/)
})

test('hosted agents are told how commits come in, how to pull now, and how to merge a relay clash', () => {
  assert.match(HOSTED_INSTRUCTIONS, /the relay brings them in from GitHub about every 10 minutes\. quilt_sync_branch asks for that now/)
  assert.match(HOSTED_INSTRUCTIONS, /quilt_write_file the merged file without conflict markers; each such write makes the relay look again at once/)
  assert.match(HOSTED_INSTRUCTIONS, /move the task to QA once all files are done/)
  assert.match(HOSTED_INSTRUCTIONS, /ask the session owner \(quilt_github_token sets it, owner only\)/)
  assert.match(HOSTED_INSTRUCTIONS, /quilt_request_commit/)
})

/** A stand-in room for noteFolders: connections on main with presence, and each one's access. */
function presenceRoom (members, upstreams = {}) {
  const states = new Map(members.map((m, i) => [i + 1, { name: m.name, git: m.git }]))
  const conns = new Map(members.map((m, i) => [m.ws = { branch: 'main' }, new Set([i + 1])]))
  const access = new Map(members.map((m) => [m.ws, m.access || { role: 'editor', scopes: [], scopesExcept: [] }]))
  return { name: 'r', meta: { branches: { main: {} }, upstreams }, awareness: { getStates: () => states }, conns, access, names: new Map(members.map((m) => [m.ws, m.name])) }
}

test('the relay records the repository and base only from members who may change every file; ahead gives the upstream tip; newer only when it descends', () => {
  const A = 'a'.repeat(40); const B = 'b'.repeat(40); const L = 'c'.repeat(40)
  const git = (sha, up = {}) => ({ branch: 'main', sha, held: null, upstream: { name: 'origin/main', url: 'https://github.com/acme/widgets.git', behind: 0, ahead: 0, conflicts: 0, sha, past: null, ...up } })
  // A viewer, or a member limited to some folders, can't point the relay anywhere.
  let r = presenceRoom([{ name: 'Vic', git: git(A, { url: 'https://github.com/evil/repo.git' }), access: { role: 'viewer', scopes: [] } }], { main: { repo: 'github.com/acme/widgets', name: 'origin/main', ref: 'main', sha: B } })
  assert.equal(noteFolders(r), false)
  assert.deepEqual([r.meta.upstreams.main.repo, r.meta.upstreams.main.sha], ['github.com/acme/widgets', B])
  r = presenceRoom([{ name: 'Sam', git: git(A, { url: 'https://github.com/evil/repo.git' }), access: { role: 'editor', scopes: ['docs'] } }])
  assert.equal(noteFolders(r), false)
  // Only ahead (not pushed yet): the upstream tip, which GitHub has, not the local commit.
  r = presenceRoom([{ name: 'Ann', git: git(L, { ahead: 1, sha: A }) }])
  noteFolders(r)
  assert.equal(r.meta.upstreams.main.sha, A)
  // Behind, or clashing: not taken.
  r = presenceRoom([{ name: 'Ann', git: git(A, { behind: 1, sha: B }) }])
  noteFolders(r)
  assert.equal(r.meta.upstreams.main?.sha, undefined)
  // A newer commit only when the folder says it descends from the recorded one.
  r = presenceRoom([{ name: 'Ann', git: git(B) }], { main: { repo: 'github.com/acme/widgets', name: 'origin/main', ref: 'main', sha: A } })
  noteFolders(r)
  assert.equal(r.meta.upstreams.main.sha, A, 'an older or unrelated commit never replaces it')
  r = presenceRoom([{ name: 'Ann', git: git(B, { past: A }) }], { main: { repo: 'github.com/acme/widgets', name: 'origin/main', ref: 'main', sha: A } })
  noteFolders(r)
  assert.equal(r.meta.upstreams.main.sha, B)
})

test('the GitHub budget is the whole relay\'s: spent requests wait, GitHub saying it is nearly spent pauses everyone, and a plain 403 is no access', async () => {
  const H = 'd'.repeat(40)
  const answer = (status, body, headers = {}) => new Response(body, { status, headers })
  try {
    resetGithubBudgets()
    configureGithubBudget({ anonPerHour: 2 })
    let asked = 0
    const ok = async (url) => { asked++; return /\/commits\//.test(url) ? answer(200, H) : /\/git\/trees\//.test(url) ? answer(200, JSON.stringify({ tree: [{ path: 'a.txt', type: 'blob', mode: '100644', size: 2 }] })) : answer(200, 'a\n') }
    assert.equal((await loadBranch({ repo: 'github.com/acme/w', ref: 'main', fetch: ok })).state, 'loaded', 'two API requests (head and tree); the file is raw')
    const before = asked
    assert.equal((await loadBranch({ repo: 'github.com/acme/w', ref: 'main', fetch: ok })).state, 'backoff', 'the third in the hour waits')
    assert.equal(asked, before, 'without asking GitHub')
    // GitHub says only a few are left: every room waits until its reset.
    resetGithubBudgets()
    configureGithubBudget({ anonPerHour: 1000 })
    const low = async () => { asked++; return answer(200, H, { 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) }) }
    await loadBranch({ repo: 'github.com/acme/w', ref: 'main', fetch: low })
    const n = asked
    assert.equal((await loadBranch({ repo: 'github.com/acme/other', ref: 'main', fetch: ok })).state, 'backoff')
    assert.equal(asked, n)
    // A 403 without rate-limit headers is a refusal to read, not a reason to slow down.
    resetGithubBudgets()
    assert.equal((await loadBranch({ repo: 'github.com/acme/w', ref: 'main', fetch: async () => answer(403, 'Forbidden') })).state, 'private')
  } finally { resetGithubBudgets(); configureGithubBudget({ anonPerHour: 100000 }) }
})

test('a held or diverged folder keeps the relay out and keeps its clash; after a hold of over 30 minutes the relay looks, but never hands on its task or takes its files', async () => {
  const H = 'gp-h'
  const odir = tmp('olga'); git(odir, 'clone', '-q', bareW, '.')
  const olga = new Session({ dir: odir, server, room: H, secret: 's', viewSecret: 'v', name: 'Olga', tool: 'Claude Code', identity: identityOf('Olga'), passes: testPasses(identityOf('Olga'), { name: 'Olga', sub: 'user-olga' }) })
  const set = olga.setUpstream.bind(olga)
  olga.setUpstream = (up) => set(up ? { ...up, url: W_URL } : up)
  sessions.push(olga)
  await olga.start({ waitTimeoutMs: 5000 })
  await waitFor(() => olga.isOwner)
  const gus = await hosted('agent-gus', 'Gus', H, olga)
  // A viewer's folder pointing at another repository changes nothing.
  const vdir = tmp('vic'); git(vdir, 'clone', '-q', bareW, '.')
  const vic = await open(vdir, 'Vic', { room: H, url: 'https://github.com/evil/repo.git', sub: 'user-vic' })
  await waitFor(() => olga.waiting.some((p) => p.name === 'Vic'))
  await olga.approve(olga.waiting.find((p) => p.name === 'Vic').key, { role: 'viewer' })
  const room = srv.rooms.get(H)
  await waitFor(() => room.meta.upstreams?.main?.sha && room.meta.upstreams.main.repo === 'github.com/acme/widgets')
  await waitFor(() => [...room.awareness.getStates().values()].some((s) => s.name === 'Vic' && s.git?.upstream))
  assert.equal(room.meta.upstreams.main.repo, 'github.com/acme/widgets', "a viewer can't redirect the relay")
  await vic.stop()
  olga.bringInUpstream = false // her folder is busy with git from here: it brings nothing in itself
  // Olga's folder is mid-merge (held): the relay stays out, even with Gus on the branch.
  assert.ok(!(await gus.call('quilt_write_file', { path: 'q.js', content: X_JS.replace('one', 'one (session)') })).isError)
  assert.ok(!(await gus.call('quilt_release', { pattern: 'q.js' })).isError)
  const head = push(pusherW, { 'q.js': X_JS.replace('one', 'one (pushed)') })
  const summary = olga.gitSummary.bind(olga)
  olga.gitSummary = () => { const g = summary(); return g ? { ...g, held: 'busy' } : g }
  olga.shareGit()
  await waitFor(() => [...room.awareness.getStates().values()].some((s) => s.name === 'Olga' && s.git?.held === 'busy'))
  assert.equal(relayLooks(room, 'main'), false)
  assert.deepEqual(await srv.checkUpstreams(H, { force: true }), [])
  assert.match(out(await gus.call('quilt_sync_branch')), /^Olga's folder on `main`/)
  // Her clash task, for her AI. After a hold of over 30 minutes the relay looks, but the task and its file stay hers.
  const id = clashTaskId('main', head)
  addTask(room.doc, room.tasks, { id, title: 'Bring 1 commit from origin/main into the session: q.js clashes', by: 'Olga', assignee: 'Olga', forAi: false, tool: '', files: ['q.js'] }, 'test')
  const ws = [...room.conns.keys()].find((w) => room.names.get(w) === 'Olga')
  room.heldSince.set(ws, { kind: 'busy', since: Date.now() - LONG_HOLD_MS - 1000 })
  assert.equal(relayLooks(room, 'main'), true)
  const [r] = await srv.checkUpstreams(H, { force: true })
  assert.equal(r.state, 'clash', JSON.stringify(r))
  assert.equal(room.tasks.get(id).assignee, 'Olga', 'never handed on while she is connected')
  assert.ok(!room.claimList('main').some((c) => c.by === 'Gus'), 'nor her files taken')
  assert.ok(!(room.taskComments.get(id) || []).some((c) => c.by === 'the relay'), 'nothing posted over her merge')
})

test('a public repository whose recorded commit isn\'t on GitHub says so, not "add a token"', async () => {
  const room = srv.rooms.get(W)
  assert.ok(!(await grok.call('quilt_switch_branch', { branch: 'main' })).isError)
  const rec = room.meta.upstreams.main
  const was = rec.sha
  rec.sha = 'e'.repeat(40)
  delete rec.etag
  try {
    room.syncAsked.clear()
    const said = out(await grok.call('quilt_sync_branch'))
    assert.match(said, /isn't on GitHub \(not pushed yet, or the branch is gone\)/)
    assert.doesNotMatch(said, /token/)
  } finally { rec.sha = was; delete rec.problem }
})

test('a file the relay waited on is let go of: the bring-in follows at once', async () => {
  const room = srv.rooms.get(W)
  room.syncAsked.clear()
  push(pusherW, { 'held.md': 'a\nb\nc\nd\n' })
  assert.match(out(await hal.call('quilt_sync_branch')), /^Brought/)
  room.syncAsked.clear()
  assert.ok(!(await grok.call('quilt_write_file', { path: 'held.md', content: 'a (grok)\nb\nc\nd\n' })).isError)
  const sha = push(pusherW, { 'held.md': 'a\nb\nc\nd (pushed)\n', 'other.md': 'other\n' })
  assert.match(out(await hal.call('quilt_sync_branch')), /Grok-Bot holds held\.md/)
  assert.ok(!(await grok.call('quilt_release', { pattern: 'held.md' })).isError)
  await waitFor(() => room.meta.upstreams.main.sha === sha, 8000)
  assert.equal(out(await hal.call('quilt_read_file', { path: 'other.md' })), 'other\n')
  assert.equal(out(await hal.call('quilt_read_file', { path: 'held.md' })), 'a (grok)\nb\nc\nd (pushed)\n')
})

test('a relay clash whose hosted assignee makes no progress is handed to the next agent', async () => {
  const room = srv.rooms.get(W)
  room.syncAsked.clear()
  assert.ok(!(await grok.call('quilt_write_file', { path: 'idle.js', content: X_JS })).isError)
  assert.ok(!(await grok.call('quilt_release', { pattern: 'idle.js' })).isError)
  push(pusherW, { 'idle.js': X_JS })
  assert.match(out(await grok.call('quilt_sync_branch')), /Brought|up to date/)
  room.syncAsked.clear()
  assert.ok(!(await grok.call('quilt_write_file', { path: 'idle.js', content: X_JS.replace('five', 'five (session)') })).isError)
  const sha = push(pusherW, { 'idle.js': X_JS.replace('five', 'five (pushed)') })
  assert.match(out(await grok.call('quilt_sync_branch')), /Nothing brought in/)
  const id = clashTaskId('main', sha)
  assert.equal(room.tasks.get(id).assignee, 'Grok-Bot')
  const idle = room.cfg.clashIdleMs
  room.cfg.clashIdleMs = 0
  try {
    await new Promise((r) => setTimeout(r, 20))
    room.syncAsked.clear()
    await hal.call('quilt_sync_branch')
    assert.equal(room.tasks.get(id).assignee, 'Hal')
    assert.match(room.taskComments.get(id).at(-1).text, /^Handed to Hal: Grok-Bot made no progress on it/)
    assert.equal(room.claimList('main').find((c) => c.pattern === 'idle.js').by, 'Hal')
  } finally { room.cfg.clashIdleMs = idle }
  assert.ok(!(await hal.call('quilt_write_file', { path: 'idle.js', content: X_JS.replace('five', 'five (session, pushed)') })).isError)
  await waitFor(() => room.meta.upstreams.main.sha === sha, 8000)
})

test('a folder back after the relay brought commits in, with more pushed since, follows the relay first and brings in only the rest', async () => {
  const M = 'gp-m'
  const pdir = tmp('pam'); git(pdir, 'clone', '-q', bareW, '.')
  const pam = await open(pdir, 'Pam', { room: M, url: W_URL, sub: 'user-pam' })
  pam.logs = []
  pam.on('log', (m) => pam.logs.push(m))
  await waitFor(() => pam.isOwner)
  const gil = await hosted('agent-gil', 'Gil', M, pam)
  const room = srv.rooms.get(M)
  const at = git(pdir, 'rev-parse', 'HEAD')
  await waitFor(() => room.meta.upstreams?.main?.sha === at && room.meta.upstreams.main.repo)
  await pam.stop()
  const p1 = push(pusherW, { 'm1.md': 'one\n' })
  assert.match(out(await gil.call('quilt_sync_branch')), /^Brought 1 commit/)
  const p2 = push(pusherW, { 'm2.md': 'two\n' })
  const back = await open(pdir, 'Pam', { room: M, url: W_URL, sub: 'user-pam' })
  back.logs = []
  back.on('log', (m) => back.logs.push(m))
  await waitFor(() => git(pdir, 'rev-parse', 'HEAD') === p2 && read(pdir, 'm2.md') === 'two\n', 20000)
  assert.equal(read(pdir, 'm1.md'), 'one\n')
  assert.ok(back.logs.some((l) => l.includes(`follows the relay to ${p1.slice(0, 7)}`)), back.logs.join('\n'))
  // Back in step past the relay's commit: its record follows her folder.
  await waitFor(() => room.meta.upstreams.main.sha === p2)
  await back.stop()
})

test('the relay\'s own token (QUILT_GITHUB_TOKEN) reads for a session that has none', async () => {
  git(pusherS, 'checkout', '-q', '-b', 'dev4'); write(pusherS, 'dev4.txt', 'four\n'); git(pusherS, 'add', '.'); git(pusherS, 'commit', '-qm', 'dev4'); git(pusherS, 'push', '-q', 'origin', 'dev4')
  const room = srv.rooms.get('gp-s')
  const kim = await hosted('agent-kim', 'Kim', 'gp-s', null, { approve: false })
  const was = room.cfg.githubToken
  room.cfg.githubToken = TOKEN
  try {
    const n = gh.calls.length
    assert.match(out(await kim.call('quilt_switch_branch', { branch: 'dev4', create: true })), /^Loaded dev4 from GitHub \(github\.com\/acme\/secret/)
    assert.ok(gh.calls.slice(n).every((c) => c.headers.authorization === `Bearer ${TOKEN}`))
    assert.equal(room.meta.githubToken, undefined, 'the session itself has no token')
  } finally { room.cfg.githubToken = was }
})
