// An agent's thread shows what it did, in order, whatever tool drives it: Quilt writes the
// entries itself when the agent posts, claims, releases, moves a task, leaves a note or edits,
// so CLI and webhook agents that never call quilt_share still have a populated thread.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer } from '../../src/server.js'
import { Session } from '../../src/session.js'
import { startControl, call } from '../../src/control.js'

let srv, server, rooms = 0
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-thread-${name}-`))
async function waitFor (fn, ms = 5000) {
  const start = Date.now()
  let last
  while (Date.now() - start < ms) {
    try { last = await fn(); if (last) return last } catch (err) { last = err }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out; last value: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}

before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {} })
  server = `ws://127.0.0.1:${srv.port}`
})
after(async () => { await srv.close() })

async function open (t, dir, name, extra = {}) {
  const s = new Session({ dir, server, secret: 'pw', name, ...extra })
  t.after(async () => { await s.stop() })
  await s.start({ waitTimeoutMs: 5000 })
  return s
}

async function room (t) {
  const r = `thread${++rooms}`
  const dirH = tmp('h'); const dirA = tmp('a')
  fs.writeFileSync(path.join(dirH, 'app.js'), 'a\n')
  const H = await open(t, dirH, 'dana', { room: r, tool: 'claude-code' })
  const A = await open(t, dirA, 'Duncan', { room: r, tool: 'Cursor', kind: 'agent' })
  await waitFor(() => fs.existsSync(path.join(dirA, 'app.js')))
  const ctl = await startControl(A)
  t.after(() => ctl.close && ctl.close())
  const d = JSON.parse(fs.readFileSync(path.join(A.stateDir, 'daemon.json'), 'utf8'))
  return { H, A, dirA, api: (method, route, body) => call(d, method, route, body) }
}

const thread = (s, who) => s.agentFeedFor(who).map((e) => e.text)

test('an agent driven by the CLI gets thread entries for what it says, claims, releases and moves', async (t) => {
  const { H, A, api } = await room(t)
  await api('POST', '/say', { text: '@dana on it' })
  await api('POST', '/claim', { pattern: 'app.js', note: 'fixing it' })
  const { task } = await api('POST', '/tasks', { title: 'Fix the app' })
  await api('POST', '/tasks/update', { id: task.id, column: 'doing' })
  await api('POST', '/tasks/comment', { id: task.id, text: 'Root cause found' })
  await api('POST', '/release', { pattern: 'app.js' })
  const seen = await waitFor(() => { const x = thread(H, 'Duncan'); return x.length >= 6 && x })
  assert.deepEqual(seen, [
    'In chat: @dana on it',
    'Claimed app.js (fixing it)',
    'Added task "Fix the app" to To do',
    'Moved task "Fix the app" to In progress',
    'Note on "Fix the app": Root cause found',
    'Released app.js'
  ])
  const kinds = A.agentFeedFor('Duncan').map((e) => e.kind)
  assert.equal(kinds[0], 'reply')
  assert.ok(kinds.slice(1).every((k) => k === 'action'))
  // Thread entries never open tasks of their own.
  assert.equal(A.taskList().length, 1)
})

test('the same line within a minute is written once', async (t) => {
  const { A } = await room(t)
  A.noteActivity('Editing app.js')
  A.noteActivity('Editing app.js')
  assert.equal(thread(A, 'Duncan').filter((x) => x === 'Editing app.js').length, 1)
})

test('a person typing in the app gets no thread entries; their AI chat reader writes theirs', async (t) => {
  const { H } = await room(t)
  H.say('hello everyone')
  await H.claim('app.js', '')
  assert.deepEqual(thread(H, 'dana'), [])
})

test('with sharing paused, nothing is written', async (t) => {
  const { A } = await room(t)
  A.setAgentSharing(false)
  A.noteActivity('Claimed app.js')
  assert.ok(!thread(A, 'Duncan').includes('Claimed app.js'))
})
