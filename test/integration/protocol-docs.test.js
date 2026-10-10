// Every sync message names the document it is for ('' the room's, else a
// branch key), and the relay turns away apps that don't know branch documents.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { startServer } from '../../src/server.js'
import { Connection } from '../../src/connection.js'
import { generateIdentity } from '../../src/identity.js'
import { MSG_SYNC, ROOM_DOC, FEATURES, decoding, syncStep1Message, updateMessage } from '../../src/protocol.js'

async function waitFor (fn, ms = 5000) {
  const t = Date.now()
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}

test('sync messages carry the document they are for', () => {
  const doc = new Y.Doc()
  doc.getText('t').insert(0, 'x')
  const cases = [[syncStep1Message(doc), ROOM_DOC], [syncStep1Message(doc, 'feature/x'), 'feature/x'], [updateMessage(Y.encodeStateAsUpdate(doc), 'main'), 'main']]
  for (const [msg, id] of cases) {
    const dec = decoding.createDecoder(msg)
    assert.equal(decoding.readVarUint(dec), MSG_SYNC)
    assert.equal(decoding.readVarString(dec), id)
  }
  assert.ok(FEATURES.split(',').includes('branches'))
})

test('the room document syncs between two apps', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {} })
  t.after(() => srv.close())
  const url = `ws://127.0.0.1:${srv.port}`
  const a = new Y.Doc()
  const b = new Y.Doc()
  const ca = new Connection({ server: url, room: 'pd1', secret: 's', name: 'a', identity: generateIdentity(), doc: a })
  const cb = new Connection({ server: url, room: 'pd1', secret: 's', name: 'b', identity: generateIdentity(), doc: b })
  t.after(() => { ca.close(); cb.close() })
  await ca.waitForSync()
  await cb.waitForSync()
  a.getArray('chat').push([{ text: 'hi' }])
  await waitFor(() => b.getArray('chat').length === 1)
})

test('an app that does not know branch documents is told to update, before the room is touched', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {} })
  t.after(() => srv.close())
  const c = new Connection({ server: `ws://127.0.0.1:${srv.port}`, room: 'pd2', secret: 's', name: 'old', identity: generateIdentity(), doc: new Y.Doc(), features: 'large-files' })
  const err = await new Promise((resolve) => c.once('fatal', resolve))
  assert.match(err.message, /needs a newer version of Quilt/)
  assert.equal(srv.rooms.has('pd2'), false)
})
