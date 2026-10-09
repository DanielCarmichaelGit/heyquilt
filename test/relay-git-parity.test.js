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
import { relayLooks, canBringIn } from '../src/relay-upstream.js'
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
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, passPublicKey: PASS_KEYS.publicKey, upstreamAuto: false, upstreamOnChange: true, githubFetch: gh.fetch, idleUnloadMs: 10 * 60 * 1000 })
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
  // Grok keeps the session's line and moves it to QA: brought in, y.js as it is.
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
  assert.match(r, /^Asked for a commit \([0-9a-f]{12}\)\./)
  const open = [...room.doc.getMap('commitRequests').values()].filter((x) => x.state === 'open')
  assert.equal(open.length, 1)
  assert.equal(open[0].by, 'Grok-Bot')
  assert.equal(open[0].branch, 'main')
  assert.match(out(await hal.call('quilt_commit_status')), /Open commit requests:\n- [0-9a-f]{12} Grok-Bot asked for a commit on `main`: x\.js merge is ready/)
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
  assert.equal(canBringIn(room, 'ws', g({ held: 'busy' })), false, 'held')
  assert.equal(canBringIn(room, 'ws', g({}, { diverged: true })), false, 'diverged')
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
