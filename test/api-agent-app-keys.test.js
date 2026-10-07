// App keys (qk_): one pasted key that signs an agent in and doesn't run out, for apps
// like Pipedream that can't swap keys every hour. The agent's owner makes and revokes them.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startTestApi, makeAgent } from './api-helpers.js'
import { startServer } from '../src/server.js'
import { newPassKeys } from '../src/passes.js'
import { MAX_APP_KEYS } from '../src/api/routes/agents.js'

let t, relay
const passKeys = newPassKeys()
before(async () => {
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: passKeys.publicKey })
  t = await startTestApi({ passKey: passKeys.privateKey, relayUrl: `ws://127.0.0.1:${relay.port}` })
})
after(async () => { await t.close(); await relay.close() })
const me = (key) => t.call('GET', '/v1/agents/me', null, null, { authorization: `Bearer ${key}` })
const connectApp = (body, who = 'mem') => t.call('POST', '/v1/agents/apps', body, who)

test('connecting an app makes a hosted personal agent and a key that signs it in, shown once', async () => {
  const r = await connectApp({ name: 'Pipedream' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.match(r.body.key.key, /^qk_/)
  assert.equal(r.body.key.name, 'Pipedream')
  assert.equal(r.body.mcp, 'https://api.quilt.test/mcp')
  assert.deepEqual([r.body.agent.name, r.body.agent.provider, r.body.agent.type, r.body.agent.hosted], ['Pipedream', 'Pipedream', 'app', true])
  const who = await me(r.body.key.key)
  assert.equal(who.status, 200)
  assert.equal(who.body.agent.id, r.body.agent.id)
  assert.equal(who.body.agent.kind, 'personal')
  const listed = (await t.call('GET', '/v1/agents', null, 'mem')).body.agents
  const row = listed.find((a) => a.id === r.body.agent.id)
  assert.ok(row, 'it is one of Mo\'s agents')
  assert.equal(row.status, 'active', 'its app key keeps it signed in: it has no access keys of its own')
  const keys = (await t.call('GET', `/v1/agents/${r.body.agent.id}/keys`, null, 'mem')).body.keys
  assert.deepEqual(keys.map((k) => k.name), ['Pipedream'])
  assert.equal(JSON.stringify(keys).includes('qk_'), false, 'a listed key never shows the key')
  assert.ok((await t.store.listAgentAppKeys(r.body.agent.id))[0].lastUsedAt > 0, 'last used is recorded')
})

test('connecting an app needs a name and a signed-in person', async () => {
  assert.equal((await connectApp({})).status, 400)
  assert.equal((await connectApp({ name: '   ' })).status, 400)
  assert.equal((await t.call('POST', '/v1/agents/apps', { name: 'Zap' })).status, 401)
  const r = await connectApp({ name: 'My zaps', provider: 'Zapier' })
  assert.deepEqual([r.body.agent.name, r.body.agent.provider, r.body.key.name], ['My zaps', 'Zapier', 'Zapier'])
})

test('an app key works at /mcp: the agent joins a session and posts', async () => {
  const { body } = await connectApp({ name: 'Piper' })
  const c = new Client({ name: 'pipedream', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(`${t.api.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${body.key.key}` } } }))
  try {
    const tools = (await c.listTools()).tools.map((x) => x.name)
    assert.ok(tools.includes('quilt_message') && tools.includes('quilt_webhook_subscribe'))
    const r = await c.callTool({ name: 'quilt_session_info', arguments: {} })
    assert.match(r.content[0].text, /not in a session|join/i)
  } finally { await c.close() }
})

test('an agent of yours gets more keys; each is revoked on its own', async () => {
  const { agent, accessKey } = await makeAgent(t, { name: 'Larry', ownerUserId: 'mem' })
  const a = await t.call('POST', `/v1/agents/${agent.id}/keys`, { name: 'Zapier' }, 'mem')
  const b = await t.call('POST', `/v1/agents/${agent.id}/keys`, { name: 'n8n' }, 'mem')
  assert.equal(a.status, 200)
  assert.equal(a.body.agent.id, agent.id)
  assert.equal((await me(a.body.key.key)).status, 200)
  assert.equal((await t.call('POST', `/v1/agents/${agent.id}/keys`, {}, 'mem')).status, 400, 'a key needs a name')
  const del = await t.call('DELETE', `/v1/agents/${agent.id}/keys/${a.body.key.id}`, null, 'mem')
  assert.equal(del.status, 200)
  const gone = await me(a.body.key.key)
  assert.equal(gone.status, 401)
  assert.match(gone.body.error, /revoked/)
  assert.equal((await t.call('DELETE', `/v1/agents/${agent.id}/keys/${a.body.key.id}`, null, 'mem')).status, 404, 'once')
  assert.equal((await me(b.body.key.key)).status, 200, 'the other key still works')
  assert.equal((await me(accessKey)).status, 200, 'so does the agent\'s own access key')
  assert.deepEqual((await t.call('GET', `/v1/agents/${agent.id}/keys`, null, 'mem')).body.keys.map((k) => k.name), ['n8n'])
})

test("someone else's agent, a made-up key and a missing agent all look the same", async () => {
  const { agent } = await makeAgent(t, { name: 'Theirs', ownerUserId: 'out' })
  const k = await t.call('POST', `/v1/agents/${agent.id}/keys`, { name: 'Mine' }, 'out')
  for (const [m, p] of [['GET', `/v1/agents/${agent.id}/keys`], ['POST', `/v1/agents/${agent.id}/keys`], ['DELETE', `/v1/agents/${agent.id}/keys/${k.body.key.id}`], ['GET', '/v1/agents/not-a-uuid/keys']]) {
    assert.equal((await t.call(m, p, m === 'POST' ? { name: 'x' } : null, 'mem')).status, 404, `${m} ${p}`)
  }
  assert.equal((await me(k.body.key.key)).status, 200, 'still works for its owner')
  assert.equal((await me('qk_made_up')).status, 401)
})

test(`an agent holds at most ${MAX_APP_KEYS} live keys`, async () => {
  const { agent } = await makeAgent(t, { name: 'Many', ownerUserId: 'lim' })
  for (let i = 0; i < MAX_APP_KEYS; i++) assert.equal((await t.call('POST', `/v1/agents/${agent.id}/keys`, { name: `k${i}` }, 'lim')).status, 200)
  const over = await t.call('POST', `/v1/agents/${agent.id}/keys`, { name: 'one more' }, 'lim')
  assert.equal(over.status, 409)
  const [first] = (await t.call('GET', `/v1/agents/${agent.id}/keys`, null, 'lim')).body.keys
  await t.call('DELETE', `/v1/agents/${agent.id}/keys/${first.id}`, null, 'lim')
  assert.equal((await t.call('POST', `/v1/agents/${agent.id}/keys`, { name: 'one more' }, 'lim')).status, 200)
})

test('revoking the agent revokes its app keys, and a rejoin does not bring them back', async () => {
  const { body } = await connectApp({ name: 'Short-lived' })
  assert.equal((await t.call('DELETE', `/v1/agents/${body.agent.id}`, null, 'mem')).status, 200)
  assert.equal((await me(body.key.key)).status, 401)
  await t.store.rejoinAgent(body.agent.id, { name: 'Short-lived', provider: 'Pipedream', type: 'app' })
  assert.equal((await me(body.key.key)).status, 401, 'the key stays revoked')
})
