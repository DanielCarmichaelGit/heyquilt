// runSession remembers which workspace a session was started in, in .quilt/config.json and recent.json.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-runner-ws-'))
process.env.HOME = process.env.USERPROFILE = home
const { startServer } = await import('../src/server.js')
const { runSession, newConn, readConfig, recentSessions } = await import('../src/runner.js')

let relay
before(async () => { relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {} }) })
after(() => relay.close())

test('the workspace id is saved with the session and on the recent list', async () => {
  const dir = path.join(home, 'proj')
  const conn = { ...newConn(), server: `ws://127.0.0.1:${relay.port}` }
  const run = await runSession({ dir, conn, name: 'Mo', tool: 'Other', workspace: 'ws-123', onLog: () => {} })
  try {
    assert.equal(readConfig(dir).workspace, 'ws-123')
    assert.equal(recentSessions().find((r) => r.dir === dir)?.workspace, 'ws-123')
  } finally { await run.stop() }
})

test('a rejoin of the same room keeps the saved workspace; a new room in that folder does not inherit it', async () => {
  const dir = path.join(home, 'proj-old')
  const server = `ws://127.0.0.1:${relay.port}`
  const conn = { ...newConn(), server }
  const first = await runSession({ dir, conn, name: 'Mo', tool: 'Other', workspace: 'ws-OLD', onLog: () => {} })
  await first.stop()
  const again = await runSession({ dir, conn, name: 'Mo', tool: 'Other', onLog: () => {} })
  try {
    assert.equal(readConfig(dir).workspace, 'ws-OLD', 'same room')
    assert.equal(recentSessions().find((r) => r.dir === dir)?.workspace, 'ws-OLD')
  } finally { await again.stop() }
  const fresh = await runSession({ dir, conn: { ...newConn(), server }, name: 'Mo', tool: 'Other', onLog: () => {} })
  try {
    assert.equal(readConfig(dir).workspace, undefined, 'a new room starts outside any workspace')
    assert.equal(recentSessions().find((r) => r.dir === dir)?.workspace, '')
  } finally { await fresh.stop() }
})
