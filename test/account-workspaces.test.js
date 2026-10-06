// Workspaces: account API helpers (see docs/superpowers/specs/2026-10-03-workspaces-design.md).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listWorkspaces, listOrgs, createWorkspace, getWorkspace, putWorkspaceMember, setSessionWorkspace, announceSessionStarted, announceWhenReported } from '../src/account.js'

const fakeFetch = (status, body) => {
  const calls = []
  const f = async (url, init = {}) => { calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.authorization }); return { ok: status < 400, status, json: async () => body } }
  f.calls = calls
  return f
}

test('listWorkspaces reads the list and passes the token', async () => {
  const fetch = fakeFetch(200, { workspaces: [{ id: 'w1', name: 'Launch' }] })
  assert.deepEqual(await listWorkspaces({ token: 'qd_x', api: 'https://api.test', fetch }), [{ id: 'w1', name: 'Launch' }])
  assert.deepEqual(fetch.calls[0], { url: 'https://api.test/v1/me/workspaces', method: 'GET', body: null, auth: 'Bearer qd_x' })
})

test('listWorkspaces: a 404 (flag off) throws with status 404', async () => {
  await assert.rejects(listWorkspaces({ token: 'qd_x', api: 'https://api.test', fetch: fakeFetch(404, { error: 'not found' }) }), (e) => e.status === 404)
})

test('createWorkspace, getWorkspace, putWorkspaceMember, setSessionWorkspace hit the right routes', async () => {
  const fetch = fakeFetch(200, { workspace: { id: 'w1' }, access: {}, members: [], sessions: [], member: { account: 'person:u2' }, session: { room: 'r' } })
  await createWorkspace({ token: 't', api: 'https://api.test', fetch, name: 'Launch', color: 'mint', org: 'acme' })
  await getWorkspace({ token: 't', api: 'https://api.test', fetch, id: 'w1' })
  await putWorkspaceMember({ token: 't', api: 'https://api.test', fetch, id: 'w1', account: 'person:u2', access: 'view' })
  await setSessionWorkspace({ token: 't', api: 'https://api.test', fetch, id: 'w1', room: 'r' })
  assert.deepEqual(fetch.calls.map((c) => [c.method, c.url, c.body]), [
    ['POST', 'https://api.test/v1/workspaces', { name: 'Launch', description: '', color: 'mint', org: 'acme' }],
    ['GET', 'https://api.test/v1/workspaces/w1', null],
    ['PUT', 'https://api.test/v1/workspaces/w1/members/person%3Au2', { access: 'view' }],
    ['POST', 'https://api.test/v1/workspaces/w1/sessions', { room: 'r' }]
  ])
})

test('listOrgs reads GET /v1/orgs with the token, and an odd reply throws', async () => {
  const fetch = fakeFetch(200, { orgs: [{ slug: 'acme', name: 'Acme' }] })
  assert.deepEqual(await listOrgs({ token: 'qd_x', api: 'https://api.test', fetch }), [{ slug: 'acme', name: 'Acme' }])
  assert.deepEqual(fetch.calls[0], { url: 'https://api.test/v1/orgs', method: 'GET', body: null, auth: 'Bearer qd_x' })
  await assert.rejects(listOrgs({ token: 'qd_x', api: 'https://api.test', fetch: fakeFetch(200, { orgs: null }) }), /unexpected reply/)
})

test('announceSessionStarted posts the link for the room to its workspace', async () => {
  const fetch = fakeFetch(200, { notified: ['a1'], withoutWebhook: [] })
  const r = await announceSessionStarted({ token: 't', api: 'https://api.test', fetch, id: 'w1', room: 'room-1', link: 'https://join.heyquilt.com/room-1#s' })
  assert.deepEqual(r, { notified: ['a1'], withoutWebhook: [] })
  assert.deepEqual(fetch.calls.map((c) => [c.method, c.url, c.body, c.auth]), [['POST', 'https://api.test/v1/workspaces/w1/sessions/room-1/started', { link: 'https://join.heyquilt.com/room-1#s' }, 'Bearer t']])
  await assert.rejects(announceSessionStarted({ token: 't', api: 'https://api.test', fetch: fakeFetch(200, {}), id: 'w1', room: 'r', link: 'x' }))
})

test('announceWhenReported tries again while the API has not heard who owns the session, and never throws', async () => {
  const waits = []
  const sleep = async (ms) => { waits.push(ms) }
  const logs = []
  const log = (l) => logs.push(l)
  const early = Object.assign(new Error('not yet'), { status: 409 })
  let n = 0
  const ok = await announceWhenReported(async () => { if (++n < 3) throw early; return { notified: ['a1', 'a2'], withoutWebhook: [] } }, { sleep, log, delays: [10, 20, 30] })
  assert.deepEqual([ok.notified, n, waits], [['a1', 'a2'], 3, [10, 20]])
  assert.ok(logs.some((l) => /2 agents/.test(l)), logs.join(' | '))
  // Any other failure is logged once, not retried.
  logs.length = 0; waits.length = 0; n = 0
  assert.equal(await announceWhenReported(async () => { n++; throw Object.assign(new Error('nope'), { status: 400 }) }, { sleep, log, delays: [10] }), null)
  assert.deepEqual([n, waits.length], [1, 0])
  assert.match(logs.join(), /nope/)
  // Gives up after the last wait.
  n = 0; waits.length = 0
  assert.equal(await announceWhenReported(async () => { n++; throw early }, { sleep, log, delays: [10, 20] }), null)
  assert.deepEqual([n, waits], [3, [10, 20]])
  // Stops once the session is gone.
  let alive = true; n = 0
  assert.equal(await announceWhenReported(async () => { n++; alive = false; throw early }, { sleep, log, delays: [10, 20], alive: () => alive }), null)
  assert.equal(n, 1)
})
