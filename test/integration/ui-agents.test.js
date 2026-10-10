// Inviting your AI from the app: the app makes a one-time agent invite with this
// computer's account and lists your agents, so you never need the website for it.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ui-agents-'))
process.env.HOME = process.env.USERPROFILE = process.env.USERPROFILE = home

const { startUi } = await import('../../src/ui-server.js')
const { startTestApi, API_URL } = await import('../helpers/api-helpers.js')
const { agentJoin } = await import('../../src/agent-join.js')

let ui, accounts
before(async () => {
  accounts = await startTestApi()
  process.env.QUILT_API_URL = accounts.api.url
  ui = await startUi({ port: 0 })
})
after(async () => { await ui.close(); await accounts.close() })

const api = (method, p, body) => fetch(`http://127.0.0.1:${ui.port}${p}`, {
  method,
  headers: { 'x-quilt-token': ui.token, 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined
}).then(async (r) => ({ status: r.status, body: await r.json() }))
const page = (file) => fetch(`http://127.0.0.1:${ui.port}/${file}`).then((r) => r.text())
async function waitFor (fn, ms = 10000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await new Promise((resolve) => setTimeout(resolve, 100)) }
  throw new Error('timed out')
}
async function signIn () {
  const started = await api('POST', '/api/account/start')
  await accounts.call('POST', '/v1/device/approve', { userCode: started.body.link.userCode, approve: true }, 'mem')
  return waitFor(async () => { const r = await api('GET', '/api/account'); return r.body.signedIn && r.body })
}

test('signed out, agents and agent invites are not available', async () => {
  for (const [method, p] of [['GET', '/api/agents'], ['POST', '/api/agent-invites']]) {
    const r = await api(method, p)
    assert.equal(r.status, 401, p)
    assert.equal(r.body.signedOut, true, p)
  }
})

test('signed in, the app makes an agent invite the AI can use, and then lists the agent', async () => {
  await signIn()
  assert.deepEqual((await api('GET', '/api/agents')).body, { agents: [] })
  const made = await api('POST', '/api/agent-invites')
  assert.equal(made.status, 200, JSON.stringify(made.body))
  assert.match(made.body.link, /\/v1\/join\/qj_[A-Za-z0-9_-]+$/)
  assert.ok(made.body.id && made.body.expiresAt > Date.now())
  // The same invite shows on the website's list for this account.
  const listed = (await accounts.call('GET', '/v1/agent-invites', null, 'mem')).body.invites
  assert.equal(listed.find((i) => i.id === made.body.id)?.status, 'waiting')

  // The test API names itself api.quilt.test in links; the AI reaches it at its real address here.
  await agentJoin({ link: made.body.link.replace(API_URL, accounts.api.url), name: 'claude', dir: path.join(home, 'agent-home'), log: () => {} })
  const agents = (await api('GET', '/api/agents')).body.agents
  assert.equal(agents.length, 1)
  assert.equal(agents[0].name, 'claude')
  assert.equal(agents[0].canJoinSessions, true)
})

test('the invite dialog and Settings offer to invite your AI, with the text to paste', async () => {
  const app = await page('app.js')
  for (const copy of ['Invite an AI agent', 'agentPaste', '/api/agent-invites']) assert.ok(app.includes(copy), `app.js: ${copy}`)
  const homeJs = await page('home.js')
  for (const copy of ['Agents', 'Invite an agent', '/api/agents', 'heyquilt.com/dashboard/agents']) assert.ok(homeJs.includes(copy), `home.js: ${copy}`)
})

test('signed out from the website, an agent invite signs the app out too', async () => {
  const token = JSON.parse(fs.readFileSync(path.join(home, '.quilt', 'account.json'), 'utf8')).token
  await accounts.call('POST', '/v1/me/signout', {}, null, { authorization: `Bearer ${token}` })
  const r = await api('POST', '/api/agent-invites')
  assert.equal(r.status, 401)
  assert.deepEqual(r.body, { error: 'This computer was signed out. Sign in again.', signedOut: true })
  assert.equal((await api('GET', '/api/account')).body.signedIn, false)
})
