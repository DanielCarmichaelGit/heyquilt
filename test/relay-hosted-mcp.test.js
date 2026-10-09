// Hosted agents: an AI with no computer joins a session through the relay's /mcp with a
// pass from the accounts API (no key), waits for the owner like anyone else, and then
// reads and writes the shared files, messages and claims as its own member.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import nodeHttp from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { generateIdentity } from '../src/identity.js'
import { signPass, PASS_TTL_MS } from '../src/passes.js'
import { PASS_KEYS, testPasses } from './pass-helpers.js'
import { verifyWebhook } from '../src/webhooks.js'

process.env.HOME = process.env.USERPROFILE = process.env.USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-hm-home-'))
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-hm-${n}-`))
async function waitFor (fn, ms = 8000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
const out = (r) => r.content.map((c) => c.text).join('\n')
const GROK = 'agent:agent-grok'
const hostedPass = (over = {}) => signPass({ v: 1, sub: 'agent-grok', kind: 'agent', name: 'Grok-Bot', key: '', exp: Date.now() + PASS_TTL_MS, ...over }, PASS_KEYS.privateKey)

let srv, http, carl, carlDir, grok
// Where the relay's webhook POSTs go (a test swaps the handler in).
const hook = { fetch: async () => ({ ok: true, status: 200 }) }
async function client (pass, headers = {}) {
  const c = new Client({ name: 'grok', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(`${http}/mcp`), { requestInit: { headers: { ...(pass ? { 'x-quilt-pass': pass } : {}), ...headers } } }))
  return c
}
const call = (name, args = {}) => grok.callTool({ name, arguments: args })

// The update check (src/update-check.js) otherwise asks the real GitHub for the newest
// release; QUILT_RELEASES_URL (src/releases.js) points it at a fixed, no-newer-release
// stub instead, so tool answers never flake with a surprise "must update" line. The one
// test below that means to check that line uses an old image against this same relay, not
// a newer GitHub release, so it stays deterministic too.
let noUpdateGh
before(async () => {
  noUpdateGh = nodeHttp.createServer((req, res) => { res.writeHead(404); res.end() })
  await new Promise((r) => noUpdateGh.listen(0, '127.0.0.1', r))
  process.env.QUILT_RELEASES_URL = `http://127.0.0.1:${noUpdateGh.address().port}/latest`
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, passPublicKey: PASS_KEYS.publicKey, webhookFetch: (url, init) => hook.fetch(url, init), webhookDelays: [1, 1, 1] })
  http = `http://127.0.0.1:${srv.port}`
  const id = generateIdentity()
  carlDir = tmp('carl')
  fs.writeFileSync(path.join(carlDir, 'README.md'), '# Project\n')
  carl = new Session({ dir: carlDir, server: `ws://127.0.0.1:${srv.port}`, room: 'hm-1', secret: 's', viewSecret: 'v', name: 'Carl', tool: 'Claude Code', identity: id, passes: testPasses(id, { name: 'Carl', sub: 'user-carl' }) })
  await carl.start({ waitTimeoutMs: 5000 })
  carl.setAgentState({ tool: 'Claude Code', status: 'idle' }) // Carl edits by hand in these tests
  await waitFor(() => carl.isOwner)
  grok = await client(hostedPass())
})
after(async () => {
  await grok?.close(); await carl.stop(); await srv.close()
  delete process.env.QUILT_RELEASES_URL
  noUpdateGh?.close()
})

test('without a pass the hosted MCP is refused; with one, the tools are there', async () => {
  await assert.rejects(client(''), /sign in to continue/)
  const tools = (await grok.listTools()).tools.map((t) => t.name)
  for (const t of ['quilt_join_session', 'quilt_session_info', 'quilt_leave_session', 'quilt_status', 'quilt_read_file', 'quilt_write_file', 'quilt_message', 'quilt_claim', 'quilt_share']) assert.ok(tools.includes(t), t)
  const { TASK_WORKFLOW } = await import('../src/agent-task-workflow.js')
  const instructions = grok.getInstructions()
  assert.ok(instructions && instructions.includes(TASK_WORKFLOW), 'hosted MCP instructions embed TASK_WORKFLOW')
  assert.match(instructions, /grok the codebase/i)
})

test('before joining, tools say to join; a bad invite is refused without touching the room', async () => {
  const r = await call('quilt_status')
  assert.equal(r.isError, true)
  assert.match(out(r), /quilt_join_session/)
  assert.match(out(await call('quilt_join_session', { invite: 'https://join.heyquilt.com/hm-1#wrong' })), /Wrong room secret/)
  assert.match(out(await call('quilt_join_session', { invite: 'https://join.heyquilt.com/hm-nope#s' })), /isn't running/)
  assert.match(out(await call('quilt_join_session', { invite: 'nonsense' })), /not valid/)
})

test('joining puts the agent on the owner\'s list; the owner lets it in and it becomes an editor', async () => {
  const r = await call('quilt_join_session', { invite: 'https://join.heyquilt.com/hm-1#s' })
  assert.equal(r.isError, undefined)
  assert.match(out(r), /Asked to join room hm-1 as an editor/)
  await waitFor(() => carl.waiting.some((p) => p.key === GROK))
  assert.deepEqual(carl.waiting.map((p) => [p.key, p.name, p.kind, p.invitedAs]), [[GROK, 'Grok-Bot', 'agent', 'editor']])
  const waiting = await call('quilt_status')
  assert.equal(waiting.isError, true)
  assert.match(out(waiting), /not let you in yet/)
  assert.match(out(await call('quilt_session_info')), /not let you in yet/)

  await carl.approve(GROK, { role: 'editor' })
  await waitFor(() => carl.members.some((m) => m.key === GROK))
  assert.match(out(await call('quilt_session_info')), /you are Grok-Bot, an editor/)
  assert.equal(carl.waiting.length, 0)
  const status = out(await call('quilt_status'))
  assert.match(status, /You are Grok-Bot in a live quilt session \(room hm-1\)/)
  assert.match(status, /- Carl \(Claude Code\)/)
  // It has no live connection, but it's online: the owner's people list shows it.
  const peer = await waitFor(() => carl.status().peers.find((p) => p.name === 'Grok-Bot'))
  assert.equal(peer.kind, 'agent')
  assert.equal(peer.hosted, true)
  assert.ok(Date.now() - peer.lastSeen < 60 * 1000, 'with when it last checked in')
  const member = carl.members.find((m) => m.key === GROK)
  assert.equal(member.http, true, 'the member list marks it as over HTTP')
  // Joining again while a member is just a no-op.
  assert.match(out(await call('quilt_join_session', { invite: 'https://join.heyquilt.com/hm-1#s' })), /Joined room hm-1 as Grok-Bot \(editor\)/)
})

test('a hosted agent sees the session\'s branches: which folder is on which, and how each stands against its upstream', async () => {
  // Carl's folder is no git repository here: what a git folder tells the room is set by hand.
  carl.conn.awareness.setLocalStateField('git', {
    branch: 'main', key: 'main', sha: 'a'.repeat(40), held: null, on: 'main',
    upstream: { name: 'origin/main', url: 'https://github.com/x/y.git', behind: 2, ahead: 0, diverged: false, conflicts: 1, waiting: null },
    repo: { worktrees: [{ name: '.', branch: 'main' }, { name: 'billing', branch: 'billing' }], branches: [{ name: 'billing', upstream: null, ahead: 0, behind: 0, author: 'Sam', ts: Date.now() - 5 * 60000, subject: 'Plans' }] }
  })
  const listed = await waitFor(async () => { const t = out(await call('quilt_branches')); return t.includes('`billing`') && t })
  assert.match(listed, /`main` · on it: Carl's folder \(2 behind origin\/main; 1 file clash with the session's work\)\n/)
  assert.match(listed, /`billing` · on it: worktree `billing` · last commit 5m ago by Sam: Plans/)
  assert.match(listed, /come into the session by themselves/)
  assert.match(out(await call('quilt_status')), /## Branches\n(- .*\n)*- `main` · on it: Carl/)
})

test('moving a task to In progress reminds the agent to grok → plan → build → test', async () => {
  const added = await call('quilt_add_task', { title: 'Wire agent workflow' })
  assert.ok(!added.isError, out(added))
  const id = out(added).split('\n').find((l) => /^[0-9a-f]{16}$/.test(l.trim()))
  assert.ok(id, `expected task id in:\n${out(added)}`)
  const moved = await call('quilt_move_task', { id: id.trim(), column: 'doing' })
  assert.ok(!moved.isError, out(moved))
  assert.match(out(moved), /Picked up "Wire agent workflow"/)
  assert.match(out(moved), /grok the codebase/i)
  assert.match(out(moved), /implement a plan/i)
  assert.match(out(moved), /build the change/i)
  assert.match(out(moved), /test it/i)
  assert.match(out(moved), /no "Verifying a change" section/)
  // Done needs evidence; "tested" is not evidence.
  const refused = await call('quilt_move_task', { id: id.trim(), column: 'done' })
  assert.ok(refused.isError)
  assert.match(out(refused), /needs `verified`/)
  assert.ok((await call('quilt_move_task', { id: id.trim(), column: 'done', verified: 'tested' })).isError)
  const done = await call('quilt_move_task', { id: id.trim(), column: 'done', verified: 'npm test passed (3 tests); opened the board and the new column rendered' })
  assert.ok(!done.isError, out(done))
  assert.match(out(done), /Moved "Wire agent workflow" to Done\. Verified: npm test passed/)
  assert.match(out(await call('quilt_tasks')), /verified: npm test passed \(3 tests\)/)
})

test('picking up a task briefs the agent: files, their recent changes, claims and the project checks', async () => {
  // The owner's AGENTS.md carries the project's checks; it syncs to the room like any file.
  fs.writeFileSync(path.join(carlDir, 'AGENTS.md'), '# Notes\n\n## Verifying a change\n\n- Run `npm test`.\n- Open the app and click through the board.\n\n## Other\n\nignored\n')
  fs.writeFileSync(path.join(carlDir, 'src.txt'), 'v1\n')
  await waitFor(async () => out(await call('quilt_read_file', { path: 'src.txt' })) === 'v1\n')
  assert.ok(!(await call('quilt_claim', { pattern: 'docs/**', note: 'rewriting the guide' })).isError)
  await waitFor(() => carl.claims.has('docs/**'))
  const added = out(await call('quilt_add_task', { title: 'Bump src', files: ['src.txt', 'docs/a.md'] }))
  const id = added.split('\n').find((l) => /^[0-9a-f]{16}$/.test(l.trim())).trim()
  const brief = out(await call('quilt_move_task', { id, column: 'doing' }))
  assert.match(brief, /^Picked up "Bump src" \[[0-9a-f]{16}\]\.\nFiles: src\.txt, docs\/a\.md/)
  assert.match(brief, /Recent changes to these files[^\n]*\n- \[\d+s ago\] Carl created src\.txt \(\+1 -0\)/)
  assert.doesNotMatch(brief, /AGENTS\.md \(/, 'changes to other files are left out')
  assert.doesNotMatch(brief, /Claims to respect/, 'my own claim is not a warning')
  assert.match(brief, /This project's checks \(from AGENTS\.md\):\n- Run `npm test`\.\n- Open the app and click through the board\./)
  assert.doesNotMatch(brief, /ignored/)
  assert.match(brief, /grok the codebase/i)
  // Another person's claim on one of the files is called out.
  await carl.claim('src.txt', 'mine for a minute')
  await waitFor(() => carl.claims.has('src.txt'))
  await call('quilt_move_task', { id, column: 'todo' })
  assert.match(out(await call('quilt_move_task', { id, column: 'doing' })), /Claims to respect[^\n]*\n- src\.txt by Carl \(mine for a minute\)/)
  // The refusal quotes the checks too.
  assert.match(out(await call('quilt_move_task', { id, column: 'done' })), /Run `npm test`/)
  await carl.release('src.txt')
  await call('quilt_release', { pattern: 'docs/**' })
  fs.rmSync(path.join(carlDir, 'AGENTS.md'))
})

test('the agent comments on a task and reads it in full; the owner sees the comment and answers on the task', async () => {
  const added = out(await call('quilt_add_task', { title: 'Plan the launch' }))
  const id = added.split('\n').find((l) => /^[0-9a-f]{16}$/.test(l.trim())).trim()
  const c = await call('quilt_comment_task', { id, text: 'Giving the copy to Carl: he wrote the last launch post.' })
  assert.ok(!c.isError, out(c))
  assert.match(out(c), /^Comment added to "Plan the launch" \(1 on it now\)\./)
  const seen = await (async () => { for (let i = 0; i < 200; i++) { const t = carl.taskList().find((x) => x.id === id && x.comments.length); if (t) return t; await new Promise((r) => setTimeout(r, 25)) } })()
  assert.ok(seen, 'the owner sees it')
  assert.equal(seen.comments[0].text, 'Giving the copy to Carl: he wrote the last launch post.')
  const agent = seen.comments[0].by
  carl.commentTask({ id, text: 'Fine, draft due Friday.' })
  await waitFor(async () => /Comments \(2\)/.test(out(await call('quilt_task', { id }))))
  const full = out(await call('quilt_task', { id }))
  assert.match(full, new RegExp(`^Plan the launch\nid: ${id}\nColumn: To do\nAssigned to: nobody`))
  assert.match(full, new RegExp(`- ${agent} \\(\\d+s ago\\): Giving the copy to Carl.*\n- Carl \\(\\d+s ago\\): Fine, draft due Friday\\.`))
  // Picking it up shows the comments in the briefing.
  assert.match(out(await call('quilt_move_task', { id, column: 'doing' })), /Comments on the task \(latest last\):\n- you \[\d+s ago\]: Giving the copy to Carl.*\n- Carl \[\d+s ago\]: Fine, draft due Friday\./)
  assert.ok((await call('quilt_task', { id: 'ffffffffffffffff' })).isError)
  assert.ok((await call('quilt_comment_task', { id: 'ffffffffffffffff', text: 'x' })).isError)
})

test('the agent reads what the owner has, and what it writes lands on the owner\'s disk', async () => {
  assert.equal(out(await call('quilt_read_file', { path: 'README.md' })), '# Project\n')
  assert.match(out(await call('quilt_read_file', { path: 'missing.txt' })), /no file called missing.txt/)
  assert.match(out(await call('quilt_read_file', { path: '../etc/passwd' })), /not a path inside the project/)

  const created = out(await call('quilt_write_file', { path: './hello.md', content: 'hello from Grok\n' }))
  assert.match(created, /Created hello.md/)
  assert.match(created, /hello\.md is claimed for you while you work on it/, 'claims follow writes')
  await waitFor(() => read(carlDir, 'hello.md') === 'hello from Grok\n')
  await waitFor(() => carl.claimFor('hello.md')?.by === 'Grok-Bot')
  const updated = out(await call('quilt_write_file', { path: 'hello.md', content: 'hello from Grok\nand again\n' }))
  assert.match(updated, /Updated hello.md \(\+1 -0 lines\)/)
  assert.doesNotMatch(updated, /claimed for you/, 'said once')
  await waitFor(() => read(carlDir, 'hello.md') === 'hello from Grok\nand again\n')
  // The owner's hand edit to the agent's file is undone while the agent holds it; releasing frees it.
  fs.writeFileSync(path.join(carlDir, 'hello.md'), 'carl was here\n')
  await waitFor(() => read(carlDir, 'hello.md') === 'hello from Grok\nand again\n')
  assert.match(carl.takeNotices()[0], /hello\.md was undone: it is claimed by Grok-Bot \(editing\)/)
  assert.match(out(await call('quilt_release', { pattern: 'hello.md' })), /Released hello\.md/)
  await waitFor(() => !carl.claimFor('hello.md'))

  // Chat never blocks a file: the write goes through, and the agent is told what was said about it (once).
  carl.say('I am rewriting brief.md, hold off for now')
  const wrote = await waitFor(async () => { const t = out(await call('quilt_write_file', { path: 'brief.md', content: 'brief\n' })); return /What people said/.test(t) && t })
  assert.match(wrote, /^(Created|Updated) brief\.md/)
  assert.match(wrote, /- Carl, just now, about brief\.md: "I am rewriting brief\.md, hold off for now" \(you have not replied\)/)
  assert.doesNotMatch(out(await call('quilt_write_file', { path: 'brief.md', content: 'brief!\n' })), /What people said/, 'once')
  // An unanswered direct message holds up writes and claims until the agent answers.
  carl.say('Grok-Bot, are you around?', { to: 'Grok-Bot' })
  const held = await waitFor(async () => { const t = out(await call('quilt_claim', { pattern: 'docs/**' })); return /^Not yet/.test(t) && t })
  assert.match(held, /Carl sent you a direct message \(id \w+\): "Grok-Bot, are you around\?"/)
  assert.match(held, /Then call quilt_claim again/)
  assert.ok(!carl.claimFor('docs/x.md'), 'nothing claimed')
  await call('quilt_message', { to: 'Carl', text: 'Here. Sorry, I will leave brief.md to you.' })
  assert.match(out(await call('quilt_write_file', { path: 'brief.md', content: 'brief\n' })), /Updated brief\.md/)
  await call('quilt_release', { pattern: 'brief.md' })
  await waitFor(() => !carl.claimFor('brief.md'))

  fs.writeFileSync(path.join(carlDir, 'notes.txt'), 'owner notes')
  await waitFor(async () => out(await call('quilt_read_file', { path: 'notes.txt' })) === 'owner notes')
  const list = out(await call('quilt_list_files'))
  for (const f of ['README.md', 'hello.md', 'notes.txt']) assert.match(list, new RegExp(`- ${f}`))
  const status = out(await call('quilt_status'))
  assert.match(status, /Grok-Bot created hello.md|Grok-Bot edited hello.md/)
  // The owner sees the agent as a member who is online.
  await waitFor(() => carl.members.find((m) => m.key === GROK)?.online === true)
})

test('the chronology records hosted and local changes with diffs, and is queryable', async () => {
  // The owner is working a task; Grok has none in progress.
  const task = carl.addTask({ title: 'Owner notes', assignee: 'me', column: 'doing' })
  fs.writeFileSync(path.join(carlDir, 'notes.txt'), 'owner notes\nmore\n')
  await waitFor(() => carl.history.entries().some((e) => e.path === 'notes.txt' && /\+more/.test(e.diff)))

  const all = out(await call('quilt_history'))
  // Grok's two writes within seconds fold into one entry; so do Carl's two saves of notes.txt.
  assert.match(all, /Grok-Bot created hello\.md \(\+2 -0\)/)
  assert.match(all, /Carl created notes\.txt \(\+2 -0\) for "Owner notes" \[/)
  const mine = out(await call('quilt_history', { by: 'grok-bot', with_diff: true }))
  assert.match(mine, /hello\.md/)
  assert.doesNotMatch(mine, /notes\.txt/)
  assert.match(mine, /\+hello from Grok/)
  assert.match(out(await call('quilt_history', { path: 'notes.txt', task: task.id })), /Carl created notes\.txt/)
  assert.equal(out(await call('quilt_history', { path: 'src/**' })), 'No changes match.')
  assert.match(out(await call('quilt_history', { since: 'soonish' })), /since: use a duration/)
  // The owner's local query sees the same record.
  assert.ok(carl.historyQuery({ by: 'Grok-Bot' }).every((e) => e.by === 'Grok-Bot'))
  assert.ok(carl.historyQuery({ since: '1h' }).length >= 2)
  assert.throws(() => carl.historyQuery({ since: 'nope' }), /since: use a duration/)
  carl.deleteTask(task.id)
})

test('messages, shares and claims reach the owner, and claims are respected', async () => {
  const bare = await call('quilt_message', { text: 'hello from the cloud' })
  assert.equal(bare.isError, true, 'a message that names nobody is refused')
  assert.match(out(bare), /^Not sent: this message names nobody.*@Carl/)
  await call('quilt_message', { text: '@Carl hello from the cloud' })
  await waitFor(() => carl.chat.toArray().some((m) => m.by === 'Grok-Bot' && m.text === '@Carl hello from the cloud'))
  await call('quilt_share', { request: 'Write the docs', summary: 'Plan: a README section.' })
  await waitFor(() => carl.agentFeedFor('Grok-Bot').length === 2)

  assert.match(out(await call('quilt_claim', { pattern: 'docs/**', note: 'writing docs' })), /Claimed docs\/\*\*/)
  await waitFor(() => [...carl.claims.values()].some((c) => c.pattern === 'docs/**' && c.by === 'Grok-Bot'))
  const again = await call('quilt_claim', { pattern: 'docs/**' })
  assert.equal(again.isError, undefined, 'a claim of your own is fine')
  assert.match(out(await call('quilt_release', { pattern: 'docs/**' })), /Released docs\/\*\*/)
  await waitFor(() => ![...carl.claims.values()].some((c) => c.pattern === 'docs/**'))

  // The owner claims a file: the agent may not write it.
  await carl.claim('README.md', 'mine')
  await waitFor(async () => /README.md is claimed by Carl/.test(out(await call('quilt_write_file', { path: 'README.md', content: 'x' }))))
  await carl.release('README.md')
})

test('quilt_inbox shows mentions, direct messages and tasks handed to the hosted agent since it joined', async () => {
  carl.say('@Grok-Bot the README needs a usage section')
  carl.say('between us: keep it short', { to: 'Grok-Bot' })
  carl.say('nothing for the bot here')
  const task = carl.addTask({ title: 'Write the usage section', assignee: 'Grok-Bot', files: ['README.md'] })
  await waitFor(async () => /Write the usage section/.test(out(await call('quilt_tasks'))))
  const inbox = out(await call('quilt_inbox'))
  assert.match(inbox, /- Carl mentioned you in chat \(id \w+\): @Grok-Bot the README needs a usage section/)
  assert.match(inbox, /- Carl sent you a direct message \(id \w+\): between us: keep it short/)
  assert.match(inbox, new RegExp(`- Carl handed you a task: "Write the usage section" \\(id ${task.id}\\)\\. Files: README\\.md`))
  assert.doesNotMatch(inbox, /nothing for the bot here/)
  assert.doesNotMatch(inbox, /^- .*hello from the cloud/m, 'its own messages are not waiting for it (they show only as context)')
  assert.equal(out(await call('quilt_inbox')), 'Nothing new for you.')
  carl.deleteTask(task.id)
})

test('a hosted agent subscribes a webhook and is POSTed mentions, direct messages and tasks as they happen', async () => {
  const posts = []
  const answers = []
  hook.fetch = async (url, init) => { posts.push({ url, init }); const status = answers.shift() || 200; return { ok: status < 300, status } }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const bodies = () => posts.map((p) => JSON.parse(p.init.body))

  assert.match(out(await call('quilt_webhook_subscribe', { url: 'http://hooks.example.com/grok' })), /must use https/)
  assert.match(out(await call('quilt_webhook_subscribe', { url: 'https://hooks.example.com/grok', events: ['chat.nope'] })), /Invalid|Unknown event/)
  const r = out(await call('quilt_webhook_subscribe', { url: 'https://hooks.example.com/grok' }))
  assert.match(r, /Webhook: Quilt POSTs to https:\/\/hooks.example.com\/grok on chat.mention, chat.dm, task.assigned\./)
  const secret = r.match(/Secret \(shown once[^:]*: ([a-f0-9]+)/)[1]
  assert.match(out(await call('quilt_status')), /Webhook: Quilt POSTs to https:\/\/hooks.example.com\/grok/)
  await sleep(50)
  assert.equal(posts.length, 0, 'what was already in the room is not POSTed')

  carl.say('@Grok-Bot now via webhook')
  await waitFor(() => posts.length === 1)
  const { url, init } = posts[0]
  assert.equal(url, 'https://hooks.example.com/grok')
  const body = JSON.parse(init.body)
  assert.deepEqual({ event: body.event, room: body.room, to: body.to, by: body.by, text: body.text }, { event: 'chat.mention', room: 'hm-1', to: 'Grok-Bot', by: 'Carl', text: '@Grok-Bot now via webhook' })
  assert.equal(init.headers['x-quilt-event'], 'chat.mention')
  assert.equal(verifyWebhook(secret, init.headers['x-quilt-timestamp'], init.body, init.headers['x-quilt-signature']), true, 'signed with the secret it was given')

  carl.say('between us, via webhook', { to: 'Grok-Bot' })
  carl.say('nothing for the bot')
  await call('quilt_message', { text: '@Grok-Bot talking to myself', everyone: true })
  const task = carl.addTask({ title: 'Webhook task', assignee: 'Grok-Bot', files: ['README.md'] })
  await waitFor(() => posts.length === 3)
  await sleep(50)
  assert.deepEqual(bodies().slice(1).map((b) => [b.event, b.text]), [['chat.dm', 'between us, via webhook'], ['task.assigned', 'Webhook task']])
  assert.deepEqual(bodies()[2].task, { id: task.id, title: 'Webhook task', column: 'todo', assignee: 'Grok-Bot', forAi: false, tool: '', files: ['README.md'] })
  // quilt_inbox still has everything the webhook carried.
  const inbox = out(await call('quilt_inbox'))
  assert.match(inbox, /mentioned you in chat \(id \w+\): @Grok-Bot now via webhook/)
  assert.match(inbox, /direct message \(id \w+\): between us, via webhook/)
  assert.match(inbox, /handed you a task: "Webhook task"/)

  // A receiver that is down for a moment gets the POST again.
  answers.push(503, 500)
  carl.say('@Grok-Bot once more')
  await waitFor(() => posts.length === 6)
  assert.deepEqual(bodies().slice(3).map((b) => b.text), ['@Grok-Bot once more', '@Grok-Bot once more', '@Grok-Bot once more'])
  assert.equal(new Set(posts.slice(3).map((p) => p.init.headers['x-quilt-delivery'])).size, 1, 'the same delivery id on every try')

  // Only the events asked for; a secret of its own; joining again keeps the subscription.
  const keyed = out(await call('quilt_webhook_subscribe', { url: 'https://hooks.example.com/grok2', secret: 'my-own-secret-of-16+', events: ['chat.dm'], bearer: 'crsr_sender_key' }))
  assert.doesNotMatch(keyed, /shown once/)
  assert.match(keyed, /with your bearer key in the Authorization header/)
  assert.match(out(await call('quilt_join_session', { invite: 'https://join.heyquilt.com/hm-1#s' })), /Joined room hm-1/)
  carl.say('@Grok-Bot not sent')
  carl.say('sent', { to: 'Grok-Bot' })
  await waitFor(() => posts.length === 7)
  await sleep(50)
  assert.equal(posts.length, 7)
  assert.equal(bodies()[6].event, 'chat.dm')
  assert.equal(verifyWebhook('my-own-secret-of-16+', posts[6].init.headers['x-quilt-timestamp'], posts[6].init.body, posts[6].init.headers['x-quilt-signature']), true)
  assert.equal(posts[6].init.headers.authorization, 'Bearer crsr_sender_key', 'the receiver key rides along')
  assert.equal('authorization' in posts[0].init.headers, false)

  assert.match(out(await call('quilt_webhook_unsubscribe')), /Webhook removed/)
  assert.match(out(await call('quilt_webhook_unsubscribe')), /had no webhook/)
  carl.say('after', { to: 'Grok-Bot' })
  await sleep(80)
  assert.equal(posts.length, 7, 'nothing after unsubscribing')
  assert.match(out(await call('quilt_status')), /No webhook/)
  await call('quilt_inbox')
  carl.deleteTask(task.id)
})

test('an agent that sends an old image is told to update in every answer; quilt_check_update answers for any image', async () => {
  const names = (await grok.listTools()).tools.map((t) => t.name)
  assert.ok(names.includes('quilt_check_update'))
  assert.match(out(await call('quilt_check_update')), /^Quilt \d+\.\d+\.\d+ is current \(the newest release is \d+\.\d+\.\d+\)\./, 'no image given: the relay checks its own')
  assert.match(out(await call('quilt_check_update', { image: '0.0.1' })), /^You must update your app: you run Quilt 0\.0\.1 and \d+\.\d+\.\d+ is out\. Update Quilt/)
  assert.doesNotMatch(out(await call('quilt_status')), /update your app/)
  const old = await client(hostedPass(), { 'x-quilt-image': '0.0.1' })
  try {
    const r = await old.callTool({ name: 'quilt_status', arguments: {} })
    assert.match(out(r), /You are Grok-Bot in a live quilt session/)
    assert.match(out(r), /\n⚠️ You must update your app: you run Quilt 0\.0\.1 and \d+\.\d+\.\d+ is out/)
    assert.match(out(await old.callTool({ name: 'quilt_check_update', arguments: {} })), /^You must update your app: you run Quilt 0\.0\.1/)
  } finally {
    await old.close()
  }
})

test('the owner can limit the agent to folders, make it a viewer, or remove it', async () => {
  await call('quilt_message', { text: '@Carl got all your messages.' }) // answered, so writes are not held for that
  await carl.setMember(GROK, { scopes: ['docs'] })
  await waitFor(async () => /only change files in docs/.test(out(await call('quilt_write_file', { path: 'src/x.js', content: 'x' }))))
  assert.match(out(await call('quilt_write_file', { path: 'docs/guide.md', content: 'guide' })), /Created docs\/guide.md/)
  await waitFor(() => read(carlDir, 'docs/guide.md') === 'guide')

  await carl.setMember(GROK, { role: 'viewer', scopes: [] })
  await waitFor(async () => /only view this session/.test(out(await call('quilt_write_file', { path: 'docs/guide.md', content: 'nope' }))))
  assert.equal(out(await call('quilt_read_file', { path: 'docs/guide.md' })), 'guide', 'viewers still read')

  await carl.removeMember(GROK)
  await waitFor(async () => { const r = await call('quilt_status'); return r.isError && /no longer in that session/.test(out(r)) })
  assert.match(out(await call('quilt_leave_session')), /Left room hm-1/)
  assert.match(out(await call('quilt_session_info')), /not in a session/)
})

test('a hosted agent in an uncontrolled room (no owner) is an editor straight away', async () => {
  const id = generateIdentity()
  const dir = tmp('dana')
  const dana = new Session({ dir, server: `ws://127.0.0.1:${srv.port}`, room: 'hm-open', secret: 's', name: 'Dana', identity: id, passes: testPasses(id) })
  await dana.start({ waitTimeoutMs: 5000 })
  dana.setAgentState({ tool: null, status: 'idle' })
  try {
    assert.match(out(await call('quilt_join_session', { invite: 'https://join.heyquilt.com/hm-open#s' })), /Joined room hm-open as Grok-Bot \(editor\)/)
    await call('quilt_write_file', { path: 'open.txt', content: 'open' })
    await waitFor(() => read(dir, 'open.txt') === 'open')
  } finally { await dana.stop() }
})

test('a hosted agent whose room pass has a grant gets straight in, with that access', async () => {
  const access = { files: 'edit', folders: [], foldersExcept: ['secrets'], talk: false }
  const gem = await client(hostedPass({ sub: 'agent-gem', name: 'Gem', room: 'hm-1', access }))
  const gemCall = (name, args = {}) => gem.callTool({ name, arguments: args })
  try {
    assert.match(out(await gemCall('quilt_join_session', { invite: 'https://join.heyquilt.com/hm-1#v' })), /Joined room hm-1 as Gem \(editor\)/)
    await waitFor(() => carl.members.some((m) => m.key === 'agent:agent-gem' && m.talk === false))
    assert.ok(!carl.waiting.some((p) => p.key === 'agent:agent-gem'), 'no prompt for the owner')
    assert.match(out(await gemCall('quilt_session_info')), /an editor, not in secrets, and you may not post/)
    assert.match(out(await gemCall('quilt_status')), /You may not post in this session/)
    const said = await gemCall('quilt_message', { text: 'hello' })
    assert.deepEqual([said.isError, out(said)], [true, "You can't post in this session."])
    assert.equal(out(await gemCall('quilt_share', { summary: 'plan' })), "You can't post in this session.")
    assert.equal(out(await gemCall('quilt_write_file', { path: 'secrets/token.txt', content: 'x' })), 'You may not change files in secrets.')
    assert.match(out(await gemCall('quilt_write_file', { path: 'gem.txt', content: 'from Gem' })), /Created gem.txt/)
    await waitFor(() => read(carlDir, 'gem.txt') === 'from Gem')
    assert.match(out(await gemCall('quilt_claim', { pattern: 'gem/**', note: 'everyone, read this' })), /Claimed gem/)
    assert.equal(srv.rooms.get('hm-1').meta.claims['gem/**'].note, '', 'a claim, but not its note')
  } finally { await gem.close() }
})

test('a granted agent whose pass names no room is asked to call again, never told it was removed', async () => {
  // Gem joined hm-1 by its grant (above). Its pass from an API that just restarted names no room.
  const rpc = (name, args = {}) => fetch(`${http}/mcp`, { method: 'POST', headers: { 'x-quilt-pass': hostedPass({ sub: 'agent-gem', name: 'Gem' }), 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  const res = await rpc('quilt_status')
  assert.equal(res.headers.get('x-quilt-room'), 'hm-1')
  assert.equal(res.headers.get('x-quilt-retry'), 'room-pass', 'the API retries with a pass for that room')
  const body = await res.text()
  assert.match(body, /Call the same tool again/)
  assert.doesNotMatch(body, /no longer in that session/)
  // With a pass for the room, the same call works.
  const gem = await client(hostedPass({ sub: 'agent-gem', name: 'Gem', room: 'hm-1', access: { files: 'edit', folders: [], foldersExcept: ['secrets'], talk: false } }))
  try { assert.match(out(await gem.callTool({ name: 'quilt_status', arguments: {} })), /Carl/) } finally { await gem.close() }
})

test('the relay tells the accounts API which session a hosted agent is in', async () => {
  const pass = hostedPass({ sub: 'agent-gem', name: 'Gem' })
  const res = await fetch(`${http}/mcp`, { method: 'POST', headers: { 'x-quilt-pass': pass, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
  assert.equal(res.headers.get('x-quilt-room'), 'hm-1')
  const other = await fetch(`${http}/mcp`, { method: 'POST', headers: { 'x-quilt-pass': hostedPass({ sub: 'agent-new', name: 'New' }), 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
  assert.equal(other.headers.get('x-quilt-room'), null, 'in no session')
})

