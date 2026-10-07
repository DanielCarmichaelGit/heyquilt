// An AI agent joins a session on its own through the MCP server, then uses
// the workspace tools. Runs the real `quilt mcp` over stdio.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { encodeInvite } from '../src/runner.js'
import { startTestApi, API_URL } from './api-helpers.js'
import { newPassKeys } from '../src/passes.js'
import { agentJoin } from '../src/agent-join.js'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'quilt.js')
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-mcp-${n}-`))
let relay, human, client, humanDir, agentCwd, accounts, home
const text = (r) => r.content.map((c) => c.text).join('\n')
const call = async (name, args = {}) => client.callTool({ name, arguments: args })
async function waitFor (fn, ms = 8000) {
  const t = Date.now()
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)) }
  throw new Error('timed out')
}

before(async () => {
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {} })
  humanDir = tmp('human')
  fs.mkdirSync(path.join(humanDir, 'src'))
  fs.writeFileSync(path.join(humanDir, 'src', 'app.js'), 'console.log("hi")\n')
  human = new Session({ dir: humanDir, server: `ws://127.0.0.1:${relay.port}`, room: 'pair', secret: 's3cret', name: 'dana' })
  await human.start({ waitTimeoutMs: 5000 })
  agentCwd = tmp('agent')
  home = tmp('home')
  // The agent joined Quilt first (as `quilt agent join` does); sessions then use its keys.
  accounts = await startTestApi({ passKey: newPassKeys().privateKey })
  const link = (await accounts.call('POST', '/v1/agent-invites', {}, 'mem')).body.link.replace(API_URL, accounts.api.url)
  await agentJoin({ link, name: 'helper', dir: path.join(home, '.quilt'), log: () => {} })
  client = new Client({ name: 'claude-code', version: '1.0.0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], cwd: agentCwd, env: { ...process.env, HOME: home, QUILT_SERVER: `ws://127.0.0.1:${relay.port}` }, stderr: 'ignore' }))
})

after(async () => {
  await client?.close().catch(() => {})
  await human?.stop()
  await relay?.close()
  await accounts?.close()
})

test('exposes the join and workspace tools', async () => {
  const names = (await client.listTools()).tools.map((t) => t.name)
  for (const n of ['quilt_join_session', 'quilt_start_session', 'quilt_leave_session', 'quilt_session_info', 'quilt_partner_feed', 'quilt_list_files', 'quilt_status', 'quilt_claim', 'quilt_inbox', 'quilt_before_edit', 'quilt_set_work']) {
    assert.ok(names.includes(n), n)
  }
  // Quilt doesn't run git for anyone: no quilt_commit, but requests can be marked done.
  assert.ok(!names.includes('quilt_commit'))
  assert.ok(names.includes('quilt_commit_request_done'))
})

test('MCP instructions require grok → plan → build → test on pickup', async () => {
  const { TASK_WORKFLOW } = await import('../src/agent-task-workflow.js')
  const instructions = client.getInstructions()
  assert.ok(instructions && instructions.includes(TASK_WORKFLOW), 'server instructions embed TASK_WORKFLOW')
  assert.match(instructions, /grok the codebase/i)
  assert.match(instructions, /implement a plan/i)
  assert.match(instructions, /build the change/i)
  assert.match(instructions, /test it/i)
})

test('without a session, tools explain how to join', async () => {
  const r = await call('quilt_status')
  assert.equal(r.isError, true)
  assert.match(text(r), /quilt_join_session/)
})

test('an agent refuses invites naming another relay, or a room that is a path', async () => {
  for (const invite of ['https://evil.example/join/..%2F..%2F..#x', 'https://evil.example/join/pair#s3cret', `http://127.0.0.1:${relay.port}/join/..%2F..#x`]) {
    const r = await call('quilt_join_session', { invite })
    assert.equal(r.isError, true, invite)
    assert.equal(text(r), 'Could not join: That invite link is not valid. Copy the whole link they sent.', invite)
  }
  assert.deepEqual(fs.readdirSync(agentCwd), [], 'nothing was synced')
  const { roomFolder } = await import('../src/mcp.js')
  assert.equal(roomFolder(agentCwd, 'room-1a2b'), path.join(agentCwd, 'quilt-room-1a2b'))
  for (const room of ['a/../..', 'x/../../etc', '/../..']) {
    assert.throws(() => roomFolder(agentCwd, room), /That invite link is not valid/, room)
  }
})

test('an agent joins by invite and shows up as an agent', async () => {
  const invite = encodeInvite({ server: `ws://127.0.0.1:${relay.port}`, room: 'pair', secret: 's3cret' })
  const r = await call('quilt_join_session', { invite: `quilt join ${invite}` })
  assert.ok(!r.isError, text(r))
  assert.match(text(r), /Joined room pair/)
  // The empty current folder became the project folder, and files arrived.
  assert.equal(fs.readFileSync(path.join(agentCwd, 'src', 'app.js'), 'utf8'), 'console.log("hi")\n')
  const peer = await waitFor(() => human.status().peers.find((p) => p.kind === 'agent'))
  assert.equal(peer.name, 'helper', 'named after the saved agent')
  assert.equal(peer.tool, 'Claude Code')
  // Joining twice is refused.
  assert.equal((await call('quilt_join_session', { invite })).isError, true)
})

test('quilt_commit_request_done with nothing open says so', async () => {
  assert.equal(text(await call('quilt_commit_request_done')), 'No open commit requests.')
})

test('the agent can read a partner\'s AI feed and the file tree', async () => {
  human.pushAgentEntries([
    { id: 'p', tool: 'Cursor', conv: 'c', kind: 'prompt', text: 'Refactor the auth module', ts: Date.now() },
    { id: 'a', tool: 'Cursor', conv: 'c', kind: 'action', text: 'Edited src/auth.js', ts: Date.now() }
  ])
  await human.claim('src/auth', 'refactoring')
  const list = await waitFor(async () => { const t = text(await call('quilt_partner_feed')); return t.includes('dana') && t })
  assert.match(list, /dana/)
  const feed = await waitFor(async () => { const t = text(await call('quilt_partner_feed', { who: 'dana' })); return t.includes('Refactor') && t })
  assert.match(feed, /dana asked: Refactor the auth module/)
  assert.match(feed, /· Edited src\/auth.js/)
  const files = text(await call('quilt_list_files'))
  assert.match(files, /src\/app\.js/)
  assert.match(files, /Claims: src\/auth \(dana: refactoring\)/)
  assert.match(text(await call('quilt_status')), /dana/)
})

test('mentions, direct messages and handed-over tasks reach the agent: pushed as channel events, and listed by quilt_inbox', async () => {
  // Claude Code started with the quilt channel gets each event as a turn. The push loop
  // skips what was already waiting when it first saw the session, so start listening first.
  const pushed = []
  client.fallbackNotificationHandler = async (n) => { if (n.method === 'notifications/claude/channel') pushed.push(n.params) }
  assert.equal(text(await call('quilt_inbox')), 'Nothing new for you.')
  await new Promise((r) => setTimeout(r, 2500)) // one poll: the push loop takes stock
  human.say('hello everyone, @helper please take the login bug')
  human.say('and privately: when will you be done?', { to: 'helper' })
  human.say('unrelated note') // no mention: not for the agent
  const task = human.addTask({ title: 'Fix login', assignee: 'helper', files: ['src/app.js'] })
  await waitFor(() => pushed.length >= 3)
  assert.deepEqual(pushed.map((p) => [p.meta.kind, p.meta.from]), [['mention', 'dana'], ['dm', 'dana'], ['task', 'dana']])
  assert.match(pushed[0].content, /^dana mentioned you in chat \(id \w+\): hello everyone, @helper please take the login bug\n.*quilt_message/)
  assert.match(pushed[1].content, /^dana sent you a direct message \(id \w+\): and privately: when will you be done\?/)
  assert.match(pushed[2].content, new RegExp(`^dana handed you a task: "Fix login" \\(id ${task.id}\\)\\. Files: src/app\\.js\\. Pick it up with quilt_move_task`))
  assert.equal(pushed[2].meta.id, task.id)
  // The tool lists the same events (its own cursor), then nothing new.
  const inbox = text(await call('quilt_inbox'))
  assert.match(inbox, /^Waiting for you:\n- dana mentioned you in chat \(id \w+\): hello everyone, @helper please take the login bug\n- dana sent you a direct message \(id \w+\): and privately/)
  assert.match(inbox, /- dana handed you a task: "Fix login"/)
  assert.doesNotMatch(inbox, /unrelated note/)
  assert.equal(text(await call('quilt_inbox')), 'Nothing new for you.')
  assert.match(text(await call('quilt_inbox', { all: true })), /Fix login/)
  // The agent's own messages and tasks, and tasks moved along, wake nobody.
  await call('quilt_message', { text: '@dana noted, on it' })
  await call('quilt_move_task', { id: task.id, column: 'doing' })
  await new Promise((r) => setTimeout(r, 2500))
  assert.equal(pushed.length, 3)
  assert.equal(text(await call('quilt_inbox')), 'Nothing new for you.')
  client.fallbackNotificationHandler = undefined
})

test('the agent subscribes a webhook through the tools and is POSTed a mention; unsubscribing stops it', async () => {
  const posts = []
  const receiver = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => { posts.push({ headers: req.headers, body: JSON.parse(raw) }); res.writeHead(200); res.end() })
  })
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r))
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name)
    assert.ok(tools.includes('quilt_webhook_subscribe') && tools.includes('quilt_webhook_unsubscribe'))
    assert.match(text(await call('quilt_webhook_subscribe', { url: 'http://example.com/hook' })), /must use https/)
    const r = text(await call('quilt_webhook_subscribe', { url: `http://127.0.0.1:${receiver.address().port}/hook`, events: ['chat.mention'] }))
    assert.match(r, /Webhook: Quilt POSTs to http:\/\/127\.0\.0\.1:\d+\/hook on chat\.mention\./)
    assert.match(r, /Secret \(shown once/)
    human.say('private, not sent', { to: 'helper' })
    human.say('@helper via the webhook')
    await waitFor(() => posts.length === 1)
    assert.equal(posts[0].headers['x-quilt-event'], 'chat.mention')
    assert.match(posts[0].headers['x-quilt-signature'], /^sha256=[a-f0-9]{64}$/)
    assert.deepEqual([posts[0].body.event, posts[0].body.by, posts[0].body.to, posts[0].body.text], ['chat.mention', 'dana', 'helper', '@helper via the webhook'])
    assert.match(text(await call('quilt_webhook_unsubscribe')), /Webhook removed/)
    human.say('@helper after')
    await waitFor(async () => /@helper after/.test(text(await call('quilt_inbox'))))
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(posts.length, 1)
  } finally { receiver.close() }
})

test('an agent whose Quilt is behind the newest release is told to update in every answer', async () => {
  // GitHub, as far as this agent's `quilt mcp` knows, has a far newer release.
  const gh = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ tag_name: 'v99.0.0', html_url: 'https://github.com/x/releases/tag/v99.0.0', published_at: '2026-10-09T00:00:00Z', body: '' }))
  })
  await new Promise((r) => gh.listen(0, '127.0.0.1', r))
  const old = new Client({ name: 'cursor', version: '1.0.0' })
  await old.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], cwd: agentCwd, env: { ...process.env, HOME: home, QUILT_SERVER: `ws://127.0.0.1:${relay.port}`, QUILT_RELEASES_URL: `http://127.0.0.1:${gh.address().port}/latest` }, stderr: 'ignore' }))
  try {
    const ask = (name, args = {}) => old.callTool({ name, arguments: args })
    const check = await waitFor(async () => { const t = text(await ask('quilt_check_update')); return /99\.0\.0/.test(t) && t })
    assert.match(check, /^You must update your app: you run Quilt \d+\.\d+\.\d+ and 99\.0\.0 is out\. Update Quilt/)
    assert.match(text(await ask('quilt_check_update', { image: '99.0.0' })), /^Quilt 99\.0\.0 is current/)
    assert.match(text(await ask('quilt_check_update', { image: '0.0.1' })), /^You must update your app: you run Quilt 0\.0\.1 and 99\.0\.0 is out/)
    // Every other answer carries the warning too (this server found the agent's running session).
    const status = text(await ask('quilt_status'))
    assert.match(status, /dana/)
    assert.match(status, /\n\n⚠️ You must update your app: you run Quilt \d+\.\d+\.\d+ and 99\.0\.0 is out/)
  } finally {
    await old.close().catch(() => {})
    gh.close()
  }
  // The agent's own server knows no newer release: no warning.
  assert.doesNotMatch(text(await call('quilt_status')), /update your app/)
})

test('merges are listed and settled through the MCP tools', async () => {
  await call('quilt_message', { text: '@dana got your messages.' }) // answered: work may move on
  // Two tool calls on an empty list, then a record made directly in the shared doc.
  assert.match(text(await call('quilt_merges')), /nothing to merge/i)
  const { openMerge } = await import('../src/merges.js')
  const rec = openMerge(human.doc, human.merges, { path: 'src/app.js', by: 'dana', others: ['helper'], kind: 'conflict', ours: 'console.log("dana")\n', base: 'console.log("hi")\n', theirsHash: 'x', binary: false }, null)
  const listed = await waitFor(async () => { const t = text(await call('quilt_merges')); return t.includes(rec.id) ? t : null })
  assert.match(listed, /src\/app\.js/)
  assert.match(listed, /dana/)
  // The tool says the other version is under .quilt/merges/<id>/: it must be there on the agent's machine too.
  const there = path.join(agentCwd, '.quilt', 'merges', rec.id)
  assert.equal(fs.readFileSync(path.join(there, 'ours'), 'utf8'), 'console.log("dana")\n')
  assert.equal(fs.readFileSync(path.join(there, 'base'), 'utf8'), 'console.log("hi")\n')
  const r = text(await call('quilt_resolve_merge', { id: rec.id, how: 'theirs' }))
  assert.match(r, /settled/i)
  await waitFor(() => human.mergeList().find((m) => m.id === rec.id)?.state === 'done')
  // A record where the offline side deleted the file must read as a deletion, not an ordinary content conflict.
  const rec2 = openMerge(human.doc, human.merges, { path: 'src/gone.js', by: 'dana', others: ['helper'], kind: 'conflict', ours: null, oursDeleted: true, base: 'console.log("hi")\n', theirsHash: 'y', binary: false }, null)
  const listed2 = await waitFor(async () => { const t = text(await call('quilt_merges')); return t.includes(rec2.id) ? t : null })
  assert.match(listed2, /deleted it offline/)
})

test('without hooks, the MCP holds an agent to the rules: claims refuse files, chat is context, and an unanswered message holds up work', async () => {
  human.say('helper, please do not touch src/app.js, I am mid-refactor', { to: 'helper' })
  await waitFor(async () => text(await call('quilt_inbox', { all: true })).includes('mid-refactor'))
  // Before editing: a free file is claimed (chat about it is shown, never blocks it), a held one is refused.
  const check = text(await call('quilt_before_edit', { paths: ['src/app.js', 'src/auth/login.js', '/etc/passwd'] }))
  assert.match(check, /- src\/app\.js: ✅ yours to edit \(claimed for you until you finish\)/)
  assert.match(check, /- src\/auth\/login\.js: ⛔ src\/auth\/login\.js is claimed by dana \(refactoring\), as part of their claim on src\/auth.*Do not retry.*quilt_request_file \(path "src\/auth\/login\.js"/)
  assert.match(check, /- \/etc\/passwd: not inside the project folder/)
  assert.match(check, /What people said in chat about these files:\n- dana \(to you\), just now, about src\/app\.js: "helper, please do not touch src\/app\.js, I am mid-refactor" \(you have not replied\)/)
  assert.equal((await waitFor(() => human.claimFor('src/app.js'))).by, 'helper')
  // Every step that moves work on waits for an answer to dana.
  const held = text(await call('quilt_claim', { pattern: 'docs/**' }))
  assert.match(held, /Not yet: these people are still waiting for an answer from you:\n/)
  assert.match(held, /- dana sent you a direct message \(id \w+\): "helper, please do not touch src\/app\.js/)
  assert.match(held, /Then call quilt_claim again/)
  assert.match(text(await call('quilt_set_work', { state: 'done' })), /^Not yet:/)
  assert.equal(human.claimFor('docs/x.md'), null)
  // What arrives while the agent works is put in front of its next answer, once.
  human.say('also @helper, ping me when you are done')
  const news = await waitFor(async () => { const t = text(await call('quilt_status')); return t.includes('📬') && t })
  assert.match(news, /^📬 Waiting for you:\n- dana mentioned you in chat \(id \w+\): also @helper, ping me when you are done/)
  assert.doesNotMatch(text(await call('quilt_status')), /📬/)
  // Answering lets work move on; the chat stays as context, now marked answered; finishing lets go of the file.
  await call('quilt_message', { to: 'dana', text: 'Understood, leaving src/app.js to you.' })
  const again = text(await call('quilt_before_edit', { paths: ['src/app.js'] }))
  assert.match(again, /about src\/app\.js: "helper, please do not touch src\/app\.js, I am mid-refactor"\n/)
  assert.doesNotMatch(again, /\(you have not replied\)/)
  assert.match(text(await call('quilt_set_work', { state: 'done' })), /^Marked as done\. Let go of \d+ files? claimed for you while you edited\./)
  await waitFor(() => !human.claimFor('src/app.js'))
})

test('an AI whose person lets it pick up work is handed its next task as it finishes, in any MCP client', async () => {
  const settings = path.join(home, '.quilt', 'settings.json')
  const before = fs.existsSync(settings) ? fs.readFileSync(settings, 'utf8') : null
  for (const t of human.taskList()) human.deleteTask(t.id) // earlier tests left helper a task In progress
  const task = human.addTask({ title: 'Tidy the README', assignee: 'helper' })
  try {
    assert.doesNotMatch(text(await call('quilt_set_work', { state: 'done' })), /next task/, 'off by default')
    fs.mkdirSync(path.dirname(settings), { recursive: true })
    fs.writeFileSync(settings, JSON.stringify({ ...(before ? JSON.parse(before) : {}), aiTasks: 'mine' }))
    await waitFor(async () => (await call('quilt_tasks')) && text(await call('quilt_tasks')).includes('Tidy the README'))
    const done = text(await call('quilt_set_work', { state: 'done' }))
    assert.match(done, new RegExp(`➡️ Your next task, from the board .*${task.id} "Tidy the README"\\. Start it now: quilt_move_task`))
  } finally {
    if (before == null) fs.rmSync(settings, { force: true }); else fs.writeFileSync(settings, before)
    human.deleteTask(task.id)
  }
})

test('nothing is Claude-only: any MCP client is pushed what arrives, and shares its work into the feed, the board and commit timing', async (t) => {
  // A second agent tool in the same folder, which is not Claude Code: it works through the same session.
  const codex = new Client({ name: 'codex-mcp-client', version: '1.0.0' })
  await codex.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], cwd: agentCwd, env: { ...process.env, HOME: home, QUILT_SERVER: `ws://127.0.0.1:${relay.port}` }, stderr: 'ignore' }))
  t.after(() => codex.close().catch(() => {}))
  const say = async (name, args = {}) => text(await codex.callTool({ name, arguments: args }))
  // Push, in plain MCP: subscribe to the inbox resource, hear when it changes, read it.
  const updates = []
  codex.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => { updates.push(n.params.uri) })
  await codex.subscribeResource({ uri: 'quilt://inbox' })
  await new Promise((r) => setTimeout(r, 500))
  human.say('@helper the build is red, can you look?')
  await waitFor(() => updates.length)
  assert.equal(updates[0], 'quilt://inbox')
  const inbox = (await codex.readResource({ uri: 'quilt://inbox' })).contents[0].text
  assert.match(inbox, /dana mentioned you in chat \(id \w+\): @helper the build is red, can you look\?/)
  // Sharing the work: it reaches dana's feed as Codex, and the host now waits before committing.
  assert.equal(await say('quilt_share', { request: 'Fix the red build', summary: 'Looking at the failing test first.' }), 'Shared with the session.')
  const feed = await waitFor(() => { const f = human.agentFeedFor('helper'); return f.some((e) => e.text === 'Fix the red build') && f })
  assert.deepEqual(feed.filter((e) => e.conv === 'mcp-Codex').map((e) => [e.kind, e.tool]).slice(0, 2), [['prompt', 'Codex'], ['reply', 'Codex']])
  await waitFor(() => human.commitStatus().busy.some((b) => b.name === 'helper'))
  assert.match(await say('quilt_partner_feed'), /dana/)
  // Finishing with the files it changed opens an In progress task for that request, as a chat Quilt reads would.
  assert.equal(await say('quilt_share', { summary: 'Fixed the import in src/build.js.', files: ['src/build.js'] }), 'Shared with the session.')
  const task = await waitFor(() => human.taskList().find((x) => /red build/i.test(x.title)))
  assert.equal(task.column, 'doing')
  assert.equal(task.assignee, 'helper')
  assert.deepEqual(task.files, ['src/build.js'])
  // Done (after answering dana) ends "working", so the host may commit again.
  await say('quilt_message', { text: '@dana fixed, it was an import', to: 'dana' })
  assert.match(await say('quilt_set_work', { state: 'done' }), /^Marked as done/)
  await waitFor(() => !human.commitStatus().busy.some((b) => b.name === 'helper'))
  human.deleteTask(task.id)
})

test('two AI sessions working as one member (say Claude Code and Cursor) answer each person once, and every message says who it is for', async (t) => {
  const cursor = new Client({ name: 'cursor', version: '1.0.0' })
  await cursor.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], cwd: agentCwd, env: { ...process.env, HOME: home, QUILT_SERVER: `ws://127.0.0.1:${relay.port}` }, stderr: 'ignore' }))
  t.after(() => cursor.close().catch(() => {}))
  const other = async (name, args = {}) => cursor.callTool({ name, arguments: args })
  // A message to no one in particular is refused, with who could be named.
  const bare = await call('quilt_message', { text: 'Thanks, noted.' })
  assert.equal(bare.isError, true)
  assert.match(text(bare), /names nobody.*@dana/)
  assert.match(text(await call('quilt_message', { text: 'Release is out', everyone: true })), /^Sent/, 'an announcement')
  // dana writes to helper; both sessions see it; the first answer stands for both.
  await text(await other('quilt_inbox'))
  human.say('helper, are you there?', { to: 'helper' })
  await waitFor(async () => /are you there/.test(text(await call('quilt_inbox', { all: true }))))
  assert.match(text(await call('quilt_message', { to: 'dana', text: 'Yes, here.' })), /^Sent/)
  const repeat = await other('quilt_message', { text: '@dana Hi dana, welcome! Here too.' })
  assert.equal(repeat.isError, true)
  assert.match(text(repeat), /another AI session working as you already wrote to dana .*"Yes, here\."/)
  assert.doesNotMatch(text(await other('quilt_inbox')), /are you there/, 'answered by the other session: not shown again')
  assert.match(text(await other('quilt_message', { text: '@dana separately: the build is green', also: true })), /^Sent/, 'something different goes with also')
  // dana writes again: an answer is due, from either session.
  human.say('@helper great, one more question?')
  await waitFor(() => human.chat.toArray().some((m) => m.text === '@helper great, one more question?'))
  await new Promise((r) => setTimeout(r, 200))
  assert.match(text(await other('quilt_message', { text: '@dana ask away' })), /^Sent/)
  // A message that needs nothing back is settled, for every session, without a reply.
  human.say('helper, thanks!', { to: 'helper' })
  const thanks = await waitFor(() => human.chat.toArray().find((m) => m.text === 'helper, thanks!'))
  await waitFor(async () => /helper, thanks!/.test(text(await call('quilt_claim', { pattern: 'docs/**' }))))
  assert.match(text(await other('quilt_inbox', { no_reply: [thanks.id] })), new RegExp(`Settled as needing no reply: ${thanks.id}`))
  assert.match(text(await call('quilt_claim', { pattern: 'docs/**' })), /^Claimed/, 'no longer held up by it')
  await call('quilt_release', { pattern: 'docs/**' })
})

test('agent edits sync back to people, and leaving removes the agent', async () => {
  fs.writeFileSync(path.join(agentCwd, 'src', 'app.js'), 'console.log("hi from the agent")\n')
  await waitFor(() => fs.readFileSync(path.join(humanDir, 'src', 'app.js'), 'utf8').includes('agent'))
  const info = text(await call('quilt_session_info'))
  assert.match(info, /Invite link.*\/join\/pair#s3cret/)
  assert.match(text(await call('quilt_leave_session')), /Left the session/)
  await waitFor(() => !human.status().peers.some((p) => p.kind === 'agent'))
})

const rx = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

test("an agent started in a person's folder works in its own copy and leaves theirs alone", async (t) => {
  // Dana's own folder for the room, from the app: saved, but not being synced right now.
  const personDir = tmp('person')
  fs.mkdirSync(path.join(personDir, '.quilt'))
  fs.writeFileSync(path.join(personDir, 'notes.md'), 'mine\n')
  const saved = { server: `ws://127.0.0.1:${relay.port}`, room: 'pair', secret: 's3cret', name: 'dana', tool: 'Cursor' }
  fs.writeFileSync(path.join(personDir, '.quilt', 'config.json'), JSON.stringify(saved))
  const c2 = new Client({ name: 'claude-code', version: '1.0.0' })
  await c2.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], cwd: personDir, env: { ...process.env, HOME: home, QUILT_SERVER: `ws://127.0.0.1:${relay.port}` }, stderr: 'ignore' }))
  t.after(() => c2.close().catch(() => {}))
  const call2 = (name, args = {}) => c2.callTool({ name, arguments: args })
  const invite = encodeInvite({ server: `ws://127.0.0.1:${relay.port}`, room: 'pair', secret: 's3cret' })

  // Before: the agent synced Dana's folder itself, and Rejoin in her app failed with
  // "already being synced by another quilt process" until the agent left.
  const r = await call2('quilt_join_session', { invite })
  assert.ok(!r.isError, text(r))
  const copy = path.join(home, 'quilt', 'quilt-pair-helper')
  assert.match(text(r), rx(`Files are synced into ${copy}`))
  // The aside names the folder as the MCP server's cwd resolves it (/private/var on macOS).
  assert.match(text(r), rx(`(${fs.realpathSync(personDir)} is a person's own copy of this session on this computer and stays theirs`))
  await waitFor(() => fs.existsSync(path.join(copy, 'src', 'app.js')))
  assert.equal(JSON.parse(fs.readFileSync(path.join(copy, '.quilt', 'config.json'), 'utf8')).kind, 'agent')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(personDir, '.quilt', 'config.json'), 'utf8')), saved, "Dana's saved session is untouched")
  assert.equal(fs.existsSync(path.join(personDir, '.quilt', 'daemon.json')), false, 'nothing runs in her folder')
  assert.equal(fs.existsSync(path.join(personDir, 'src')), false, 'nothing is synced into it')
  assert.match(text(await call2('quilt_leave_session')), /Left the session/)

  // Starting a new session from her folder would hand it to another room: refused.
  const s = await call2('quilt_start_session', {})
  assert.equal(s.isError, true)
  assert.match(text(s), /already belongs to a session a person started on this computer/)

  // Naming her folder outright, or the agent's own copy, both land in the copy.
  for (const folder of [personDir, copy]) {
    const again = await call2('quilt_join_session', { invite, folder })
    assert.ok(!again.isError, text(again))
    assert.match(text(again), rx(`Files are synced into ${copy}`))
    if (folder === copy) assert.doesNotMatch(text(again), /stays theirs/)
    assert.match(text(await call2('quilt_leave_session')), /Left the session/)
  }
})
