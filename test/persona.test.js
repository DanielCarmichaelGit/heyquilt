// AI sessions as their own members (persona.js): each AI session working through a person's
// app is named after its work, and its messages, inbox, duties and claims are its own.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { personaName, cleanLabel, labelFromBranch, labelFromText, firstName } from '../src/persona.js'

test('names: first name and a label from the branch or from what the session says it does', () => {
  assert.equal(firstName('Daniel Carmichael'), 'Daniel')
  assert.equal(personaName('Daniel Carmichael', 'file-queue'), 'Daniel · file-queue')
  assert.equal(labelFromBranch('main'), '')
  assert.equal(labelFromBranch('HEAD'), '')
  assert.equal(labelFromBranch('claude/file-queue'), 'file-queue')
  assert.equal(labelFromText("I'm working on the hosted agent costs doc"), 'hosted agent costs')
  assert.equal(labelFromText('Fix the login bug'), 'fix the login')
  assert.equal(cleanLabel('@sneaky · name\nwith lines'), 'sneaky name with lines')
  assert.ok(cleanLabel('a very long label that keeps going and going forever').length <= 32)
})

let srv, server, rooms = 0
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-persona-${n}-`))
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
async function waitFor (fn, ms = 5000) {
  const start = Date.now()
  let last
  while (Date.now() - start < ms) { try { last = await fn(); if (last) return last } catch (e) { last = e } await new Promise((r) => setTimeout(r, 25)) }
  throw new Error(`timed out; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}

before(async () => { srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {} }); server = `ws://127.0.0.1:${srv.port}` })
after(async () => { await srv.close() })

async function pair (t) {
  const room = `persona${++rooms}`
  const dirA = tmp('a'); const dirB = tmp('b')
  write(dirA, 'src/app.js', 'a\n')
  const open = async (dir, name) => {
    const s = new Session({ dir, server, room, secret: 'pw', name, tool: 'cursor' })
    t.after(() => s.stop())
    await s.start({ waitTimeoutMs: 5000 })
    return s
  }
  const dana = await open(dirA, 'Dana Smith')
  const bob = await open(dirB, 'Bob')
  dana.setAgentState({ tool: 'cursor', status: 'working' })
  await waitFor(() => read(dirB, 'src/app.js') === 'a\n')
  return { dana, bob, dirA, dirB, room }
}

test('two AI sessions through one app are members of their own, with their own messages, inbox and duties', async (t) => {
  const { dana, bob } = await pair(t)
  const repo = tmp('repo')
  execFileSync('git', ['init', '-q', '-b', 'claude/file-queue', repo])
  const a = dana.registerPersona({ via: 'aaaaaaaa', tool: 'Claude Code', cwd: repo })
  const b = dana.registerPersona({ via: 'bbbbbbbb', tool: 'Codex', cwd: tmp('plain') })
  assert.deepEqual(a, { name: 'Dana · file-queue', named: 'branch' })
  assert.deepEqual(b, { name: 'Dana · Codex', named: null })
  // The first thing an unnamed session says it is doing names it; the old name still reaches it.
  dana.personaSays('bbbbbbbb', 'Working on the hosted costs doc')
  assert.equal(dana.persona('bbbbbbbb').name, 'Dana · hosted costs doc')
  dana.personaSays('bbbbbbbb', 'something else entirely')
  assert.equal(dana.persona('bbbbbbbb').name, 'Dana · hosted costs doc', 'named once')
  // Partners see both sessions as members of their own, as Dana's.
  const seen = await waitFor(() => { const ps = bob.status().peers.filter((p) => p.persona); return ps.length === 2 && ps })
  assert.deepEqual(seen.map((p) => [p.name, p.of, p.tool]).sort(), [['Dana · file-queue', 'Dana Smith', 'Claude Code'], ['Dana · hosted costs doc', 'Dana Smith', 'Codex']])
  // A session speaks under its own name.
  dana.say('@Bob on it', { agent: true, via: 'aaaaaaaa' })
  await waitFor(() => bob.chat.toArray().some((m) => m.by === 'Dana · file-queue'))
  // Bob writes to one session: only that one is woken, and owes him an answer; Dana is not.
  bob.say('can you rebase after?', { to: 'Dana · file-queue' })
  bob.say('@Dana · Codex are you still there?') // its old name
  await waitFor(() => dana.inbox({ via: 'aaaaaaaa' }).events.length === 1)
  assert.match(dana.inbox({ via: 'aaaaaaaa' }).events[0].text, /rebase/)
  await waitFor(() => dana.inbox({ via: 'bbbbbbbb' }).events.length === 1)
  assert.equal(dana.inbox().events.length, 0, 'not for the person')
  assert.equal(dana.duties('aaaaaaaa').waiting.length, 1)
  assert.equal(dana.duties().waiting.length, 0)
  dana.say('yes, after the tests', { agent: true, via: 'aaaaaaaa', to: 'Bob' })
  assert.equal(dana.duties('aaaaaaaa').waiting.length, 0)
  assert.equal(dana.inbox({ via: 'aaaaaaaa' }).events.length, 0, 'answered')
})

test("an AI session's claims are its own: another session of the same person is refused, the person's own disk is not", async (t) => {
  const { dana, bob, dirA, dirB, room } = await pair(t)
  dana.registerPersona({ via: 'aaaaaaaa', tool: 'Claude Code', cwd: tmp('x') })
  dana.renamePersona('aaaaaaaa', 'login')
  dana.registerPersona({ via: 'bbbbbbbb', tool: 'Codex', cwd: tmp('y') })
  const r = await dana.prepareEdit(['src/app.js'], 'aaaaaaaa')
  assert.equal(r.files[0].claimed, true)
  assert.equal(r.me, 'Dana · login')
  assert.equal((await waitFor(() => bob.claimFor('src/app.js'))).by, 'Dana · login')
  // The other session is refused and told to ask for it in the file queue.
  const other = await dana.prepareEdit(['src/app.js'], 'bbbbbbbb')
  assert.equal(other.files[0].ok, false)
  assert.equal(other.files[0].claim.by, 'Dana · login')
  // The file is still Dana's to write on her disk (her AI sessions write there).
  write(dirA, 'src/app.js', 'a\nb\n')
  await waitFor(() => read(dirB, 'src/app.js') === 'a\nb\n')
  // Its idle time is its own: Dana's activity doesn't keep it, its tool calls do.
  const rm = srv.rooms.get(room)
  const key = 'name:Dana · login'
  const before = rm.meta.seen[key] || 0
  dana.persona('aaaaaaaa').touchedAt = 0
  dana.touchPersona('aaaaaaaa')
  await waitFor(() => (rm.meta.seen[key] || 0) > before)
  // Finishing lets go of what was claimed for that session only.
  await dana.prepareEdit(['src/other.js'], 'bbbbbbbb')
  await waitFor(() => bob.claimFor('src/other.js'))
  assert.equal((await dana.finishEditing('aaaaaaaa')).released, 1)
  await waitFor(() => !bob.claimFor('src/app.js'))
  assert.equal(bob.claimFor('src/other.js').by, 'Dana · Codex')
})

test('a hook finds its AI session by the tool process they share', async (t) => {
  const { dana } = await pair(t)
  dana.registerPersona({ via: 'aaaaaaaa', tool: 'Claude Code', pids: [500, 400] }) // quilt mcp's parent, then the app above it
  dana.registerPersona({ via: 'bbbbbbbb', tool: 'Claude Code', pids: [600, 400] })
  assert.equal(dana.personaFor([700, 600, 400, 1]), 'bbbbbbbb', 'its own tool process, not the app they share')
  assert.equal(dana.personaFor([701, 500, 400]), 'aaaaaaaa')
  assert.equal(dana.personaFor([999]), null)
})
