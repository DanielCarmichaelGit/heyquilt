// Chat links act on existing work: update and comment on tasks, read one in full, the member
// roster, what the link may do, JSON answers and changes since a cursor. A real relay and the
// owner's real session.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer } from '../../src/server.js'
import { Session } from '../../src/session.js'

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-chat-tasks-home-'))
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-chat-tasks-${n}-`))
async function waitFor (fn, ms = 5000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}

let srv, dana, link
const open = async (action = '', params = '', init) => {
  const res = await fetch(`${link.url}${action ? `/${action}` : ''}${params ? `?${params}` : ''}`, init)
  return { status: res.status, text: await res.text(), headers: res.headers }
}
const json = async (action = '', params = '') => {
  const r = await open(action, params ? `${params}&format=json` : 'format=json')
  assert.match(r.headers.get('content-type'), /^application\/json/)
  return { status: r.status, body: JSON.parse(r.text) }
}

before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {} })
  const dir = tmp('dana')
  fs.writeFileSync(path.join(dir, 'README.md'), '# Project\n')
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n\n## Verifying a change\n\n- npm test passes\n')
  dana = new Session({ dir, server: `ws://127.0.0.1:${srv.port}`, room: 'boardroom', secret: 's3cret', viewSecret: 'v1ew', name: 'dana' })
  await dana.start({ waitTimeoutMs: 5000 })
  await waitFor(() => dana.isOwner)
  link = await dana.createChatLink({ name: 'ChatGPT' })
})

after(async () => {
  await dana?.stop()
  await srv?.close()
})

test('the actions page says what the link may do, apart from creating a task and changing one', async () => {
  const r = await open('actions')
  assert.equal(r.status, 200)
  assert.match(r.text, /- task: Create a new task in To do \(it does not change an existing one: use update\)/)
  assert.match(r.text, /- update: Change an existing task and get it back as saved\. Inputs: id = the task id; assignee \(optional\)/)
  assert.match(r.text, /You may not change existing files\./)
  const { body } = await json('actions')
  assert.equal(body.ok, true)
  assert.equal(body.permissions.updateTasks, true)
  assert.equal(body.permissions.changeExistingFiles, false)
  assert.ok(body.actions.find((a) => a.action === 'comment').required.includes('text'))
  assert.match(body.link.expiresAt, /^\d{4}-\d\d-\d\dT/)
  assert.match(body.link.renew, /session owner can extend/)
})

test('the members page lists who is here, human or agent, role, and their open tasks', async () => {
  dana.addTask({ title: 'Write the parser', assignee: 'dana' })
  await waitFor(async () => (await json('members')).body.members.find((m) => m.name === 'dana')?.openTasks.length === 1)
  const { body } = await json('members')
  const d = body.members.find((m) => m.name === 'dana')
  assert.equal(d.kind, 'human')
  assert.equal(d.role, 'owner')
  assert.equal(d.online, true)
  assert.equal(d.openTasks[0].title, 'Write the parser')
  const me = body.members.find((m) => m.name === 'ChatGPT')
  assert.equal(me.kind, 'agent')
  assert.equal(me.you, true)
  assert.equal(me.via, 'chat link')
  assert.match((await open('members')).text, /- dana \(human, owner, online\).*open tasks: Write the parser \(To do, [0-9a-f]{16}\)/)
})

test('the AI assigns, moves and renames an existing task, and gets it back as saved', async () => {
  const task = dana.addTask({ title: 'Review the README' })
  await waitFor(async () => (await open('tasks')).text.includes(task.id))
  // Someone who isn't here is refused, with the names that are.
  const nobody = await open('update', `id=${task.id}&assignee=Duncan`)
  assert.equal(nobody.status, 400)
  assert.match(nobody.text, /Nobody called "Duncan" is in this session\. Members: dana, ChatGPT/)
  const near = await open('update', `id=${task.id}&assignee=Dana`)
  assert.match(near.text, /Did you mean dana\?/)
  // Assign by a unique start of its id.
  const r = await open('update', `id=${task.id.slice(0, 8)}&assignee=dana&column=doing`)
  assert.equal(r.status, 200, r.text)
  assert.match(r.text, /^Saved\. The task now reads:\n\nReview the README\nid: [0-9a-f]{16}\nColumn: In progress\nAssigned to: dana\n/)
  const saved = await waitFor(() => dana.taskList().find((t) => t.id === task.id && t.column === 'doing'))
  assert.equal(saved.assignee, 'dana')
  assert.equal(saved.forAi, false)
  // To dana's AI, as JSON.
  const ai = await json('update', `id=${task.id}&assignee=dana&to_ai=1&title=Review%20the%20README%20and%20docs`)
  assert.equal(ai.body.ok, true)
  assert.equal(ai.body.task.assignee, 'dana')
  assert.equal(ai.body.task.forAi, true)
  assert.equal(ai.body.task.title, 'Review the README and docs')
  assert.equal(ai.body.task.columnName, 'In progress')
  // QA needs notes, as for every agent; then it moves with them.
  const bare = await open('update', `id=${task.id}&column=qa`)
  assert.equal(bare.status, 400)
  assert.match(bare.text, /needs &qaNotes= before it can go to QA/)
  assert.match(bare.text, /npm test passes/, 'with the project\'s checklist')
  const qa = await json('update', `id=${task.id}&column=QA&qaNotes=${encodeURIComponent('Read both; fixed two typos in the README')}`)
  assert.equal(qa.body.task.column, 'qa')
  assert.equal(qa.body.task.qaNotes, 'Read both; fixed two typos in the README')
  // Unassign; nothing to change; no such task; a bad column.
  assert.equal((await json('update', `id=${task.id}&assignee=`)).body.task.assignee, null)
  assert.match((await open('update', `id=${task.id}`)).text, /^Say what to change/)
  const missing = await json('update', 'id=ffffffffffffffff&assignee=dana')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.ok, false)
  assert.match(missing.body.error, /There is no task ffffffffffffffff/)
  assert.equal((await open('update', `id=${task.id}&column=later`)).status, 400)
})

test('the AI reads a task in full and comments on it; the owner sees the comment', async () => {
  const task = dana.addTask({ title: 'Pick a logo' })
  await waitFor(async () => (await open('tasks')).text.includes(task.id))
  const c = await open('comment', `id=${task.id}&text=${encodeURIComponent('Giving this to dana: she drew the first sketches.\nThe round one tested best.')}`)
  assert.equal(c.status, 200, c.text)
  assert.match(c.text, /^Comment added to "Pick a logo"\./)
  assert.match((await open('comment', `id=${task.id}&text=${encodeURIComponent('Giving this to dana: she drew the first sketches.\nThe round one tested best.')}`)).text, /^Already added\./)
  const seen = await waitFor(() => dana.taskList().find((t) => t.id === task.id && t.comments.length))
  assert.equal(seen.comments.length, 1)
  assert.equal(seen.comments[0].by, 'ChatGPT')
  assert.equal(seen.comments[0].text, 'Giving this to dana: she drew the first sketches.\nThe round one tested best.')
  // The owner answers on the task; the AI reads both.
  dana.commentTask({ id: task.id, text: 'Agreed, taking it.' })
  const d = await waitFor(async () => { const r = await json('details', `id=${task.id}`); return r.body.task.comments.length === 2 && r.body })
  assert.deepEqual(d.task.comments.map((x) => x.by), ['ChatGPT', 'dana'])
  assert.match(d.task.comments[1].at, /^\d{4}-/)
  const text = (await open('details', `id=${task.id}`)).text
  assert.match(text, /^Pick a logo\nid: [0-9a-f]{16}\nColumn: To do\nAssigned to: nobody\nAdded by dana/)
  assert.match(text, /Comments \(2\):\n- ChatGPT \(\d+s ago\): Giving this to dana: she drew the first sketches\.\n {2}The round one tested best\.\n- dana \(\d+s ago\): Agreed, taking it\./)
  assert.match((await open('tasks')).text, new RegExp(`Tasks with comments \\(open them with the details link\\): .*${task.id} \\(2\\)`))
  assert.equal((await open('comment', `id=${task.id}`)).status, 400, 'no text')
})

test('changes since a cursor: only what changed on the board and in messages, removals included', async () => {
  const keep = dana.addTask({ title: 'Ship the beta' })
  const drop = dana.addTask({ title: 'Old idea' })
  await waitFor(async () => (await open('tasks')).text.includes(drop.id))
  const start = (await json('tasks')).body.cursor
  assert.match(start, /^[0-9a-f]{8}\.\d+$/)
  const quiet = await json('changes', `since=${start}`)
  assert.deepEqual([quiet.body.tasks, quiet.body.removedTasks, quiet.body.messages], [[], [], []])
  assert.match((await open('changes', `since=${start}`)).text, /^Nothing changed since then\./)
  dana.updateTask({ id: keep.id, column: 'doing', assignee: 'dana' })
  dana.deleteTask(drop.id)
  dana.say('@ChatGPT the beta is moving')
  const ch = await waitFor(async () => { const r = await json('changes', `since=${start}`); return r.body.messages.length && r.body.removedTasks.length && r.body })
  assert.deepEqual(ch.tasks.map((t) => [t.id, t.column, t.assignee]), [[keep.id, 'doing', 'dana']])
  assert.deepEqual(ch.removedTasks, [drop.id])
  assert.equal(ch.messages[0].text, '@ChatGPT the beta is moving')
  assert.notEqual(ch.cursor, start)
  // From the new cursor: nothing new. tasks?since and messages?since give one side each.
  assert.deepEqual((await json('changes', `since=${ch.cursor}`)).body.tasks, [])
  const onlyTasks = (await json('tasks', `since=${start}`)).body
  assert.equal(onlyTasks.messages, undefined)
  assert.equal(onlyTasks.tasks.length, 1)
  const onlyMsgs = (await json('messages', `since=${start}`)).body
  assert.equal(onlyMsgs.tasks, undefined)
  assert.equal(onlyMsgs.messages.length, 1)
  // A cursor from another run of the relay, or nonsense, has expired.
  const old = await json('changes', 'since=00000000.3')
  assert.equal(old.status, 410)
  assert.equal(old.body.expired, true)
  assert.match((await open('changes', 'since=junk')).text, /That cursor has expired .* each gives a fresh cursor/)
  // Answer dana so later tests aren't held.
  await open('say', 'to=dana&text=Seen')
})

test('POST takes the inputs as JSON; JSON answers carry ok, and errors say why', async () => {
  const task = dana.addTask({ title: 'Long notes' })
  await waitFor(async () => (await open('tasks')).text.includes(task.id))
  const long = 'Why it went to dana: '.padEnd(1500, 'x')
  const r = await open('comment', 'format=json', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: task.id, text: long }) })
  const body = JSON.parse(r.text)
  assert.equal(body.ok, true, r.text)
  assert.equal(body.task.comments[0].text, long)
  const bad = await open('comment', '', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: '{nope' })
  assert.equal(bad.status, 400)
  assert.equal(JSON.parse(bad.text).ok, false)
  // The overview as JSON: who you are, the link, a cursor and your permissions.
  const o = (await json()).body
  assert.equal(o.you.name, 'ChatGPT')
  assert.equal(o.session.room, 'boardroom')
  assert.match(o.cursor, /^[0-9a-f]{8}\.\d+$/)
  assert.equal(o.permissions.commentOnTasks, true)
})

test('a message waiting for an answer holds task changes, and the owner\'s "no posting" stops them', async () => {
  const task = dana.addTask({ title: 'Held task' })
  await waitFor(async () => (await open('tasks')).text.includes(task.id))
  dana.say('Which font?', { to: 'ChatGPT' })
  const held = await waitFor(async () => { const r = await open('update', `id=${task.id}&assignee=dana`); return r.status === 409 && r })
  assert.match(held.text, /dana sent you a direct message/)
  assert.equal((await open('comment', `id=${task.id}&text=later`)).status, 409)
  await open('say', 'to=dana&text=Inter')
  assert.equal((await open('update', `id=${task.id}&assignee=dana`)).status, 200)
  const m = await waitFor(() => dana.members.find((x) => x.name === 'ChatGPT'))
  await dana.setMember(m.key, { access: { files: 'edit', folders: [], foldersExcept: [], talk: false } })
  const off = await waitFor(async () => { const r = await json('update', `id=${task.id}&assignee=`); return r.status === 403 && r })
  assert.match(off.body.error, /turned off messages and task changes from you/)
  assert.equal((await json('actions')).body.permissions.updateTasks, false)
})
