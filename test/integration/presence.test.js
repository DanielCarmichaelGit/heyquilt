// Presence after a dropped connection: partners come back into view right away, a dead
// connection the relay hasn't noticed gives way to the new one, and a connection that
// goes silent is reopened.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import * as Y from 'yjs'
import { startServer } from '../../src/server.js'
import { Connection } from '../../src/connection.js'
import { generateIdentity } from '../../src/identity.js'

process.env.HOME = process.env.USERPROFILE = process.env.USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-presence-home-'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor (fn, ms = 5000) {
  const t = Date.now()
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await wait(25) }
  throw new Error('timed out')
}
const quiet = () => {}
function cleanups (t) {
  const fns = []
  t.after(async () => { for (const fn of fns.reverse()) await fn() })
  return (fn) => fns.push(fn)
}
function connect (port, room, name, opts = {}) {
  const c = new Connection({ server: `ws://127.0.0.1:${port}`, room, secret: 's', name, identity: generateIdentity(), doc: new Y.Doc(), ...opts })
  c.awareness.setLocalState({ name })
  return c
}
const sees = (c, name) => [...c.awareness.getStates().values()].some((s) => s && s.name === name)

test('partners are back in view moments after a dropped connection, on both sides', async (t) => {
  const defer = cleanups(t)
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  defer(() => srv.close())
  const ann = connect(srv.port, 'r', 'ann')
  const bob = connect(srv.port, 'r', 'bob')
  defer(() => { for (const c of [ann, bob]) if (!c.closed) c.close() })
  await waitFor(() => sees(ann, 'bob') && sees(bob, 'ann'))

  // Bob's socket dies; the relay sees it go and tells Ann. Bob reconnects on his own.
  const dropped = Date.now()
  bob.ws.terminate()
  await waitFor(() => !sees(ann, 'bob'), 2000)
  // Before: the relay and Ann still held Bob's old presence clock, so the state he sent
  // again was ignored until his next renewal, up to 15s later; and Bob held Ann's.
  await waitFor(() => sees(ann, 'bob') && sees(bob, 'ann'), 4000)
  assert.ok(Date.now() - dropped < 4000)

  // And when Bob leaves for good after that, Ann sees him go at once.
  bob.close()
  await waitFor(() => !sees(ann, 'bob'), 2000)
})

/** A TCP proxy where a client's disconnect is not passed on: the relay's side stays open and silent. */
async function leakyProxy (port) {
  const upstreams = []
  const srv = net.createServer((client) => {
    const up = net.connect(port, '127.0.0.1')
    upstreams.push(up)
    client.on('error', () => {})
    up.on('error', () => {})
    client.pipe(up, { end: false })
    up.pipe(client)
    client.on('close', () => { up.unpipe(client); up.resume() })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { port: srv.address().port, close: () => { for (const u of upstreams) u.destroy(); srv.close() } }
}

test('the same person over a new connection replaces a dead one the relay has not noticed', async (t) => {
  const defer = cleanups(t)
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  defer(() => srv.close())
  const proxy = await leakyProxy(srv.port)
  defer(() => proxy.close())
  const ann = connect(srv.port, 'r', 'ann')
  const bob = connect(proxy.port, 'r', 'bob')
  defer(() => { for (const c of [ann, bob]) if (!c.closed) c.close() })
  await waitFor(() => sees(ann, 'bob') && sees(bob, 'ann'))
  const room = srv.rooms.get('r')
  assert.equal(room.conns.size, 2)
  const oldWs = [...room.conns.keys()].find((w) => room.names.get(w) === 'bob')

  // Bob's side drops, but the relay's side of his old connection lingers (its heartbeat
  // would notice in up to a minute). Bob reconnects right away.
  bob.ws.terminate()
  await waitFor(() => !bob.connected)
  await waitFor(() => bob.connected && bob.synced, 3000)
  // Before: his presence over the new connection was dropped as "another name's" while the
  // old one still claimed it, so partners lost him for that minute. Now the old one goes.
  await waitFor(() => !room.conns.has(oldWs) && room.conns.size === 2, 3000)
  assert.ok(sees(ann, 'bob'), 'Ann never lost him')
  await wait(200)
  assert.ok(sees(ann, 'bob'))

  // The new connection owns his presence: when he leaves, Ann sees it at once.
  bob.close()
  await waitFor(() => !sees(ann, 'bob'), 2000)
})

test('a connection that hears nothing from the relay is dropped and reopened', async (t) => {
  const defer = cleanups(t)
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  defer(() => srv.close())
  // The relay pings every 30s; with this short a patience, that's silence.
  const c = connect(srv.port, 'r', 'cat', { livenessMs: 300 })
  defer(() => { if (!c.closed) c.close() })
  const statuses = []
  const warns = []
  c.on('status', (s) => statuses.push(s))
  c.on('warn', (w) => warns.push(w))
  await waitFor(() => statuses.filter((s) => s === 'connected').length >= 2, 4000)
  assert.deepEqual(statuses.slice(0, 3), ['connected', 'disconnected', 'connected'])
  assert.ok(warns.includes('the relay went quiet; reconnecting'), warns.join('; '))
})
