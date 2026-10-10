import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi, makeOrg, makeAgent } from '../helpers/api-helpers.js'
import { keyStatus, REUSED } from '../../src/api/agent-auth.js'
import { generateIdentity, signAgentResume } from '../../src/identity.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())
const me = (key) => t.call('GET', '/v1/agents/me', null, null, { authorization: `Bearer ${key}` })
const refresh = (refreshKey) => t.call('POST', '/v1/agents/token', { refreshKey })

test('keyStatus: active while a key can refresh, reused after a family revoke, otherwise expired', () => {
  assert.match(REUSED, /keys were revoked\. Get new ones with your resume key: POST \/v1\/agents\/resume/)
  assert.equal(keyStatus([{ revokedAt: null, refreshExpiresAt: 2000 }], 1000), 'active')
  assert.equal(keyStatus([{ revokedAt: 500, refreshExpiresAt: 2000 }], 1000), 'reused')
  assert.equal(keyStatus([{ revokedAt: null, refreshExpiresAt: 900 }], 1000), 'expired')
  assert.equal(keyStatus([], 1000), 'expired')
})

test('an access key signs a personal agent in; /me says who it is', async () => {
  const { agent, accessKey } = await makeAgent(t, { name: 'Larry', description: 'Writes tests', ownerUserId: 'mem' })
  const r = await me(accessKey)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { agent: { id: agent.id, name: 'Larry', provider: 'Anthropic', type: 'coding agent', description: 'Writes tests', canJoinSessions: true, hosted: true, kind: 'personal', org: null }, teams: [], role: null, mcp: 'https://api.quilt.test/mcp' })
  assert.ok((await t.store.agentById(agent.id)).lastUsedAt > 0, 'last used is recorded')
  assert.equal((await me('qa_nope')).status, 401)
  assert.equal((await t.call('GET', '/v1/agents/me', null, 'mem')).status, 401, "a person's sign-in is not an agent's")
})

test('last used is written at most once a minute', async () => {
  const { accessKey } = await makeAgent(t, { ownerUserId: 'mem' })
  let touches = 0
  const counting = { ...t.store, touchAgent: async (id) => { touches++; return t.store.touchAgent(id) } }
  const t2 = await startTestApi({ store: counting })
  try {
    for (let i = 0; i < 3; i++) assert.equal((await t2.call('GET', '/v1/agents/me', null, null, { authorization: `Bearer ${accessKey}` })).status, 200)
  } finally { await t2.close() }
  assert.equal(touches, 1)
})

test('/me for an org agent lists its org, role and teams with folders', async () => {
  const o = await makeOrg(t, 'Agent Me Co')
  const lead = await t.store.createRole({ orgId: o.org.id, name: 'Lead', grants: { teams: { r: true } } })
  const { agent, accessKey } = await makeAgent(t, { name: 'Bot', provider: 'OpenAI', orgId: o.org.id })
  const m = await t.store.addAgentMember({ orgId: o.org.id, agentId: agent.id, roleId: lead.id })
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  await t.store.addTeamMember({ teamId: core.id, memberId: m.id, access: 'editor', scopes: ['src'] })
  assert.deepEqual((await me(accessKey)).body, {
    agent: { id: agent.id, name: 'Bot', provider: 'OpenAI', type: 'coding agent', description: '', canJoinSessions: true, hosted: true, kind: 'org', org: { slug: o.slug, name: 'Agent Me Co' } },
    teams: [{ id: core.id, name: 'Core', access: 'editor', scopes: ['src'] }],
    role: { name: 'Lead' },
    mcp: 'https://api.quilt.test/mcp'
  })
})

test('expired or revoked access keys are refused', async () => {
  const stale = await makeAgent(t, { ownerUserId: 'mem', accessTtl: -1 })
  assert.equal((await me(stale.accessKey)).status, 401)
  const { agent, accessKey } = await makeAgent(t, { ownerUserId: 'mem' })
  await t.store.revokeAgent(agent.id)
  assert.equal((await me(accessKey)).status, 401)
})

test('a refresh key swaps for a new pair once, and the new pair works', async () => {
  const { agent, refreshKey } = await makeAgent(t, { ownerUserId: 'mem' })
  const r = await refresh(refreshKey)
  assert.equal(r.status, 200)
  assert.equal(r.body.agentId, agent.id)
  assert.match(r.body.accessKey, /^qa_[A-Za-z0-9_-]{43}$/)
  assert.match(r.body.refreshKey, /^qr_[A-Za-z0-9_-]{43}$/)
  const at = Date.now()
  assert.ok(Math.abs(r.body.accessExpiresAt - (at + 60 * 60 * 1000)) < 5000, 'access: 1 hour')
  assert.ok(Math.abs(r.body.refreshExpiresAt - (at + 30 * 24 * 60 * 60 * 1000)) < 5000, 'refresh: 30 days')
  assert.equal((await me(r.body.accessKey)).status, 200)
  assert.equal((await refresh(r.body.refreshKey)).status, 200, 'the new refresh key works in turn')
  const rows = await t.store.listAgentKeys(agent.id)
  assert.equal(new Set(rows.map((k) => k.familyId)).size, 1, 'refreshing stays in one family')
  assert.equal(JSON.stringify(rows).includes(r.body.accessKey), false, 'only hashes are stored')
})

test('reusing a spent refresh key revokes the whole family, and the list says so', async () => {
  const { agent, refreshKey } = await makeAgent(t, { name: 'Leaky', ownerUserId: 'lim' })
  const fresh = (await refresh(refreshKey)).body
  const reused = await refresh(refreshKey)
  assert.deepEqual([reused.status, reused.body.error], [401, REUSED])
  assert.equal((await me(fresh.accessKey)).status, 401, 'the newer access key died too')
  assert.equal((await refresh(fresh.refreshKey)).status, 401, 'and the newer refresh key')
  const listed = (await t.call('GET', '/v1/agents', null, 'lim')).body.agents.find((a) => a.id === agent.id)
  assert.equal(listed.status, 'reused')
})

test('two refreshes racing with one key: at most one gets a pair, and no pair survives', async () => {
  const { refreshKey } = await makeAgent(t, { ownerUserId: 'mem' })
  const results = await Promise.all([refresh(refreshKey), refresh(refreshKey)])
  assert.ok(results.some((r) => r.status === 401), 'the second use is a reuse')
  // A copied key means nobody keeps the family, whichever request finished first.
  for (const r of results.filter((x) => x.status === 200)) assert.equal((await me(r.body.accessKey)).status, 401)
})

test('if minting the new pair fails after the claim went through, the claim is released so the same key can retry', async () => {
  const { agent, refreshKey } = await makeAgent(t, { ownerUserId: 'mem' })
  let fail = true
  const flaky = { ...t.store, createAgentKeys: async (k) => { if (fail) { fail = false; throw new Error('db hiccup') } return t.store.createAgentKeys(k) } }
  const t2 = await startTestApi({ store: flaky })
  try {
    const first = await t2.call('POST', '/v1/agents/token', { refreshKey })
    assert.equal(first.status, 500, 'the mint failure surfaces, not a false reuse')
    const retry = await t2.call('POST', '/v1/agents/token', { refreshKey })
    assert.equal(retry.status, 200, 'the same refresh key works on retry')
    assert.equal((await t2.call('GET', '/v1/agents/me', null, null, { authorization: `Bearer ${retry.body.accessKey}` })).status, 200)
    const rows = await t.store.listAgentKeys(agent.id)
    assert.equal(rows.some((k) => k.revokedAt), false, 'nothing was revoked')
  } finally { await t2.close() }
})

test('two refreshes forced to interleave inside claimRefresh: at most one pair survives, the family is revoked', async () => {
  const { agent, refreshKey } = await makeAgent(t, { ownerUserId: 'mem' })
  // Both calls stall right before the real claimRefresh mutation until both have
  // arrived, so the check-and-set genuinely races rather than happening to run in order.
  let entered = 0
  let release
  const bothIn = new Promise((resolve) => { release = resolve })
  const paused = {
    ...t.store,
    async claimRefresh (id) {
      if (++entered === 2) release()
      await bothIn
      return t.store.claimRefresh(id)
    }
  }
  const t2 = await startTestApi({ store: paused })
  try {
    const results = await Promise.all([
      t2.call('POST', '/v1/agents/token', { refreshKey }),
      t2.call('POST', '/v1/agents/token', { refreshKey })
    ])
    // The claim itself is exclusive (one true, one false), but even the "true" side can
    // lose: if the loser's reuse-triggered revoke lands before the winner's post-mint
    // recheck, the winner's own pair comes back dead too. Either way, no pair survives.
    assert.ok(results.some((r) => r.status === 401), 'the losing side is always a reuse')
    for (const r of results.filter((x) => x.status === 200)) {
      assert.equal((await t2.call('GET', '/v1/agents/me', null, null, { authorization: `Bearer ${r.body.accessKey}` })).status, 401, 'a surviving 200 still has a dead key')
    }
    const rows = await t.store.listAgentKeys(agent.id)
    assert.ok(rows.every((k) => k.revokedAt), 'the whole family is revoked')
  } finally { await t2.close() }
})

test('bad, expired and revoked refresh keys are 401s', async () => {
  assert.equal((await t.call('POST', '/v1/agents/token', {})).status, 401)
  assert.equal((await refresh('qr_nope')).status, 401)
  assert.equal((await refresh(42)).status, 401)
  const stale = await makeAgent(t, { ownerUserId: 'mem', refreshTtl: -1 })
  assert.equal((await refresh(stale.refreshKey)).status, 401)
  const gone = await makeAgent(t, { ownerUserId: 'mem' })
  assert.equal((await t.call('DELETE', `/v1/agents/${gone.agent.id}`, null, 'mem')).status, 200)
  assert.equal((await refresh(gone.refreshKey)).status, 401, 'revoking the agent revokes its keys')
})

test('the personal agents list shows the profile, when each was added and last used, and its key status', async () => {
  const { agent } = await makeAgent(t, { name: 'Listed', provider: 'Cursor', type: 'editor agent', description: 'Fixes lint', ownerUserId: 'out' })
  const [a] = (await t.call('GET', '/v1/agents', null, 'out')).body.agents
  assert.deepEqual([a.id, a.name, a.provider, a.type, a.description, a.status, a.lastUsedAt], [agent.id, 'Listed', 'Cursor', 'editor agent', 'Fixes lint', 'active', null])
  assert.ok(a.createdAt > 0)
})

test('the personal agents list says whether each agent has a key, never the key itself', async () => {
  const id = generateIdentity()
  await makeAgent(t, { name: 'Keyed', publicKey: id.publicKey, ownerUserId: 'noKeyOwner' })
  await makeAgent(t, { name: 'Keyless', ownerUserId: 'noKeyOwner' })
  const agents = (await t.call('GET', '/v1/agents', null, 'noKeyOwner')).body.agents
  const byName = (n) => agents.find((a) => a.name === n)
  // Every agent can join a session: with a key from a computer running Quilt too, without one through the hosted MCP.
  assert.deepEqual([byName('Keyed').canJoinSessions, byName('Keyed').hosted], [true, false])
  assert.deepEqual([byName('Keyless').canJoinSessions, byName('Keyless').hosted], [true, true])
  for (const a of agents) assert.equal('publicKey' in a, false, 'never expose the key itself')
})

test('key refreshes are rate-limited per address', async () => {
  const limited = await startTestApi({ tokenLimit: 2 })
  try {
    for (const want of [401, 401, 429]) assert.equal((await limited.call('POST', '/v1/agents/token', { refreshKey: 'qr_x' })).status, want)
  } finally { await limited.close() }
})

test('resume: only the holder of the key an agent joined with gets new keys, once per signature', async () => {
  const identity = generateIdentity()
  const { agent, refreshKey } = await makeAgent(t, { ownerUserId: 'mem', publicKey: identity.publicKey })
  const resume = (body) => t.call('POST', '/v1/agents/resume', body)
  const signed = (who = identity, at = Date.now()) => ({ agentId: agent.id, at, signature: signAgentResume(who, agent.id, at) })

  // Someone with only a copy of the refresh key: reusing it revokes the keys, and they can't sign.
  assert.equal((await refresh(refreshKey)).status, 200)
  assert.equal((await refresh(refreshKey)).status, 401)
  assert.equal((await resume(signed(generateIdentity()))).status, 401, "another key's signature")
  assert.equal((await resume({ agentId: agent.id, at: Date.now(), signature: 'nope' })).status, 401)

  const body = signed()
  const r = await resume(body)
  assert.equal(r.status, 200)
  assert.match(r.body.accessKey, /^qa_/)
  assert.equal((await me(r.body.accessKey)).status, 200)
  assert.equal((await refresh(r.body.refreshKey)).status, 200, 'the new refresh key works')
  assert.equal((await resume(body)).status, 401, 'a signature works once')

  // A second resume revokes the pair the first one made.
  const again = await resume(signed())
  assert.equal(again.status, 200)
  assert.equal((await me(r.body.accessKey)).status, 401)
  assert.equal((await t.store.listAgentKeys(agent.id)).filter((k) => !k.revokedAt).length, 1)
})

test('resume: refused for a bad clock, a hosted agent, an unknown one, and one a person revoked', async () => {
  const identity = generateIdentity()
  const { agent } = await makeAgent(t, { ownerUserId: 'mem', publicKey: identity.publicKey })
  const resume = (agentId, at = Date.now(), who = identity) => t.call('POST', '/v1/agents/resume', { agentId, at, signature: signAgentResume(who, agentId, at) })
  assert.equal((await resume(agent.id, Date.now() - 11 * 60 * 1000)).status, 400)
  const hosted = await makeAgent(t, { ownerUserId: 'mem' })
  assert.equal((await resume(hosted.agent.id)).status, 404)
  assert.equal((await resume(crypto.randomUUID())).status, 404)
  await t.store.revokeAgent(agent.id)
  const r = await resume(agent.id)
  assert.equal(r.status, 401)
  assert.match(r.body.error, /revoked/)
})

test('resume key: an HTTP agent whose copied refresh key was reused gets new keys, like any agent', async () => {
  // Joined over HTTP with no key of its own, then kept its keys in two places (Sriram's box and Mac).
  const inv = (await t.call('POST', '/v1/agent-invites', {}, 'mem')).body.link.split('/v1/join/')[1]
  const joined = await t.call('POST', `/v1/join/${inv}`, { name: 'Sriram', provider: 'OpenAI', type: 'coding agent' })
  assert.equal(joined.status, 200)
  assert.match(joined.body.resumeKey, /^qs_[A-Za-z0-9_-]{43}$/)
  assert.equal(joined.body.resume, 'https://api.quilt.test/v1/agents/resume')
  const agentId = joined.body.agentId
  assert.equal((await t.store.agentById(agentId)).publicKey, null, 'hosted: no key of its own')
  assert.equal(JSON.stringify(await t.store.agentById(agentId)).includes('resume'), false, 'the agent row never carries the resume key')

  // One copy refreshes; the other copy's stale refresh key revokes the family.
  const box = await refresh(joined.body.refreshKey)
  assert.equal(box.status, 200)
  const mac = await refresh(joined.body.refreshKey)
  assert.deepEqual([mac.status, mac.body.error], [401, REUSED])
  assert.equal((await me(box.body.accessKey)).status, 401)
  assert.equal((await refresh(box.body.refreshKey)).status, 401)

  // The resume key gets a working pair, in a new family; nothing else keeps working.
  const back = await t.call('POST', '/v1/agents/resume', { resumeKey: joined.body.resumeKey })
  assert.equal(back.status, 200)
  assert.equal(back.body.agentId, agentId)
  assert.equal((await me(back.body.accessKey)).status, 200)
  assert.equal((await t.store.listAgentKeys(agentId)).filter((k) => !k.revokedAt).length, 1)
  assert.equal((await refresh(back.body.refreshKey)).status, 200, 'its refresh key works in turn')

  // It keeps working: a later lockout recovers the same way.
  assert.equal((await t.call('POST', '/v1/agents/resume', { resumeKey: joined.body.resumeKey })).status, 200)
})

test('resume key: refused when unknown, malformed, or the agent was revoked by a person', async () => {
  const resume = (resumeKey) => t.call('POST', '/v1/agents/resume', { resumeKey })
  for (const bad of ['qs_nope', 'qr_x', '', 42, null]) assert.equal((await resume(bad)).status, 401, String(bad))
  const inv = (await t.call('POST', '/v1/agent-invites', {}, 'mem')).body.link.split('/v1/join/')[1]
  const joined = await t.call('POST', `/v1/join/${inv}`, { name: 'Gone', provider: 'OpenAI', type: 'coding agent' })
  await t.store.revokeAgent(joined.body.agentId)
  const r = await resume(joined.body.resumeKey)
  assert.equal(r.status, 401)
  assert.match(r.body.error, /revoked/)
})
