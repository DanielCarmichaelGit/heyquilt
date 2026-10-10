// "… is typing" travels in presence: a partner sees it, sending clears it, it runs out by
// itself, a direct message's shows only to its recipient, and nobody can type as someone else.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer } from '../../src/server.js'
import { Session } from '../../src/session.js'

let srv, server, rooms = 0
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-typing-${n}-`))
async function waitFor (fn, ms = 5000) {
  const start = Date.now()
  let last
  while (Date.now() - start < ms) { try { last = await fn(); if (last) return last } catch (e) { last = e } await new Promise((r) => setTimeout(r, 25)) }
  throw new Error(`timed out; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}

before(async () => { srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {} }); server = `ws://127.0.0.1:${srv.port}` })
after(async () => { await srv.close() })

async function trio (t) {
  const room = `typing${++rooms}`
  const open = async (name) => {
    const s = new Session({ dir: tmp(name), server, room, secret: 'pw', name, tool: 'cursor' })
    t.after(() => s.stop())
    await s.start({ waitTimeoutMs: 5000 })
    return s
  }
  const dana = await open('Dana')
  const bob = await open('Bob')
  const lee = await open('Lee')
  await waitFor(() => dana.status().peers.length === 2 && bob.status().peers.length === 2 && lee.status().peers.length === 2)
  return { dana, bob, lee }
}
const typingIn = (s, name) => s.status().peers.find((p) => p.name === name)?.typing === true

test('a partner sees someone typing, and sending the message clears it', async (t) => {
  const { dana, bob } = await trio(t)
  assert.equal(typingIn(bob, 'Dana'), false)
  assert.deepEqual(dana.setTyping(true), { typing: true, name: 'Dana' })
  await waitFor(() => typingIn(bob, 'Dana'))
  assert.ok(!dana.status().peers.some((p) => p.typing), 'nobody else is typing')
  dana.say('hello')
  await waitFor(() => !typingIn(bob, 'Dana'))
})

test('typing stops showing when taken back, and runs out by itself', async (t) => {
  const { dana, bob } = await trio(t)
  dana.setTyping(true)
  await waitFor(() => typingIn(bob, 'Dana'))
  dana.setTyping(false)
  await waitFor(() => !typingIn(bob, 'Dana'))
  dana.setTyping(true, { ms: 1000 })
  await waitFor(() => typingIn(bob, 'Dana'))
  await waitFor(() => !typingIn(bob, 'Dana'), 4000)
  await waitFor(() => Object.keys(dana.typing).length === 0, 2000) // its own entry is cleared too
})

test('typing a direct message shows only to its recipient in the app', async (t) => {
  const { dana, bob, lee } = await trio(t)
  const { typingNames } = await import('../../src/ui/chat.js')
  dana.setTyping(true, { to: 'Bob' })
  await waitFor(() => typingIn(bob, 'Dana') && typingIn(lee, 'Dana'))
  assert.deepEqual(typingNames(bob.status().peers, 'Bob'), ['Dana'])
  assert.deepEqual(typingNames(lee.status().peers, 'Lee'), [])
})

test('an AI session types under its own name; a forged entry for someone else is ignored', async (t) => {
  const { dana, bob } = await trio(t)
  const a = dana.registerPersona({ via: 'aaaaaaaa', tool: 'Claude Code', cwd: tmp('repo') })
  dana.renamePersona('aaaaaaaa', 'typing', 'self')
  const me = dana.persona('aaaaaaaa').name
  await waitFor(() => bob.status().peers.some((p) => p.name === me))
  dana.setTyping(true, { via: 'aaaaaaaa', agent: true })
  await waitFor(() => typingIn(bob, me))
  assert.equal(typingIn(bob, 'Dana'), false, 'the person is not typing, their AI is')
  assert.ok(dana.status().peers.find((p) => p.name === me)?.typing, 'the person sees their own AI typing')
  assert.ok(a)
  // Presence names only the sender (the relay checks state.name); entries for other names are dropped.
  dana.conn.awareness.setLocalStateField('typing', { Lee: { ts: Date.now(), ms: 5000 } })
  await new Promise((r) => setTimeout(r, 300))
  assert.ok(!bob.status().peers.some((p) => p.name === 'Lee' && p.typing))
})

test('someone who may not post cannot say they are typing', async (t) => {
  const { dana } = await trio(t)
  dana.mayTalk = () => false
  assert.deepEqual(dana.setTyping(true), { typing: false, name: 'Dana' })
  assert.deepEqual(dana.typing, {})
})
