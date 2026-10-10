// The relay's hosted MCP server: a website user's AI connects with a link and
// shares its work into the session, next to a CLI user.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../../src/server.js'
import { Session } from '../../src/session.js'

const NEEDS_IDENTITY = 'relay-hosted agents need their own identity (issues/002)'

let srv, http, carl
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-rmcp-${n}-`))
const TOKEN = 'tok_' + 'a'.repeat(30)

async function waitFor (fn, ms = 5000) {
  const start = Date.now()
  while (Date.now() - start < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}

async function client (token = TOKEN, tool = 'Cursor') {
  const c = new Client({ name: 'cursor-test', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(`${http}/mcp/${token}?tool=${encodeURIComponent(tool)}`)))
  return c
}
const out = (r) => r.content.map((c) => c.text).join('\n')
const link = (body) => fetch(`${http}/agent/link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {} })
  http = `http://127.0.0.1:${srv.port}`
  carl = new Session({ dir: tmp('carl'), server: `ws://127.0.0.1:${srv.port}`, room: 'room1', secret: 'pw', name: 'Carl', tool: 'Claude Code' })
  await carl.start({ waitTimeoutMs: 5000 })
})

after(async () => {
  await carl.stop()
  await srv.close()
})

test('before the browser links a session, tools explain what to do', async () => {
  const c = await client('tok_' + 'b'.repeat(30))
  const tools = (await c.listTools()).tools.map((t) => t.name)
  assert.ok(tools.includes('quilt_share') && tools.includes('quilt_status'))
  const r = await c.callTool({ name: 'quilt_status', arguments: {} })
  assert.equal(r.isError, true)
  assert.match(out(r), /not in a quilt session/)
  await c.close()
})

test('linking needs the room secret and an existing room', async () => {
  assert.equal((await link({ token: TOKEN, room: 'room1', secret: 'wrong', name: 'Wendy' })).status, 403)
  assert.equal((await link({ token: TOKEN, room: 'nope', secret: 'pw', name: 'Wendy' })).status, 403)
  assert.equal((await link({ token: 'short', room: 'room1', secret: 'pw', name: 'Wendy' })).status, 400)
  const ok = await link({ token: TOKEN, room: 'room1', secret: 'pw', name: 'Wendy', tool: 'Cursor' })
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).aiSeenAt, 0)
})

test('the AI shares its work, reads status and messages as its person', { skip: NEEDS_IDENTITY }, async () => {
  const c = await client()
  const status = out(await c.callTool({ name: 'quilt_status', arguments: {} }))
  assert.match(status, /working for Wendy/)
  assert.match(status, /Carl \(Claude Code\)/)

  await c.callTool({ name: 'quilt_share', arguments: { request: 'Make the header sticky', summary: 'Plan: add position: sticky to .header.' } })
  await c.callTool({ name: 'quilt_share', arguments: { summary: 'Done: the header now sticks.', files: ['src/header.css', '../etc/passwd'] } })
  await waitFor(() => carl.agentFeedFor('Wendy').length === 4)
  const feed = carl.agentFeedFor('Wendy')
  assert.deepEqual(feed.map((e) => [e.kind, e.text]), [
    ['prompt', 'Make the header sticky'],
    ['reply', 'Plan: add position: sticky to .header.'],
    ['reply', 'Done: the header now sticks.'],
    ['action', 'Edited src/header.css']
  ])
  assert.ok(feed.every((e) => e.tool === 'Cursor' && e.by === 'Wendy'))

  await c.callTool({ name: 'quilt_message', arguments: { text: 'taking the header' } })
  await waitFor(() => carl.messages({ markRead: false }).some((m) => m.by === 'Wendy' && m.text === 'taking the header'))
  carl.say('thanks!')
  await waitFor(async () => /Carl .*thanks!/.test(out(await c.callTool({ name: 'quilt_read_messages', arguments: {} }))))

  carl.pushAgentEntries([{ id: 'x1', tool: 'Claude Code', kind: 'prompt', text: 'Add a footer' }])
  await waitFor(async () => /Carl asked: Add a footer/.test(out(await c.callTool({ name: 'quilt_partner_feed', arguments: { who: 'Carl' } }))))

  assert.match(out(await c.callTool({ name: 'quilt_claim', arguments: { pattern: 'src/header.css', note: 'sticky' } })), /Claimed/)
  await waitFor(() => carl.claimFor('src/header.css')?.by === 'Wendy')
  carl.claim('src/footer/**')
  await waitFor(() => carl.claims.has('src/footer/**'))
  assert.equal((await c.callTool({ name: 'quilt_claim', arguments: { pattern: 'src/footer/**' } })).isError, true)
  assert.match(out(await c.callTool({ name: 'quilt_release', arguments: {} })), /Released src\/header.css/)
  await c.close()

  // The browser learns its AI is connected on its next check-in.
  const again = await (await link({ token: TOKEN, room: 'room1', secret: 'pw', name: 'Wendy', tool: 'Cursor' })).json()
  assert.ok(again.aiSeenAt > 0)
})
