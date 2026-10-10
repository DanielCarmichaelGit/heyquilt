import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi, makeOrg, API_URL } from '../helpers/api-helpers.js'
import { generateIdentity } from '../../src/identity.js'
import { newToken, hashToken } from '../../src/api/tokens.js'
import { joinInstructions, joinNext } from '../../src/api/join-text.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())

const PROFILE = { name: 'Larry', provider: 'Anthropic', type: 'coding agent', description: 'Writes tests' }
// A fresh personal invite; returns its token (the path after /v1/join/).
async function invite (who = 'mem', path = '/v1/agent-invites', body = {}) {
  const r = await t.call('POST', path, body, who)
  return { token: r.body.link.split('/v1/join/')[1], id: r.body.invite.id }
}
const join = (token, body = PROFILE) => t.call('POST', `/v1/join/${token}`, body)
const raw = async (path) => {
  const res = await fetch(t.api.url + path)
  return { status: res.status, text: await res.text(), headers: res.headers }
}
const statusOf = async (who, id) => (await t.call('GET', '/v1/agent-invites', null, who)).body.invites.find((i) => i.id === id).status

test('the instructions explain both ways to join, with no em dashes', () => {
  const text = joinInstructions({ link: 'https://api.x/v1/join/qj_abc', apiUrl: 'https://api.x', status: 'waiting', expiresAt: Date.parse('2026-10-01T12:00:00Z') })
  assert.match(text, /Status: this invite is open\. It works once, until 2026-10-01T12:00:00\.000Z\./)
  assert.match(text, /POST https:\/\/api\.x\/v1\/join\/qj_abc/)
  assert.match(text, /"name": /)
  assert.match(text, /GET https:\/\/api\.x\/v1\/join\/qj_abc\?name=/)
  assert.match(text, /POST https:\/\/api\.x\/v1\/agents\/token/)
  assert.match(text, /does not use the invite/)
  for (const [status, line] of [['used', /already used/], ['expired', /has expired/], ['cancelled', /was cancelled/], ['unknown', /isn't valid/]]) {
    assert.match(joinInstructions({ link: 'l', apiUrl: 'a', status }), line, status)
  }
  const next = joinNext({ name: 'Larry', apiUrl: 'https://api.x', hasKey: true })
  assert.match(next, /Larry/)
  assert.match(next, /https:\/\/api\.x\/v1\/agents\/me/)
  assert.match(next, /https:\/\/api\.x\/mcp/)
  assert.match(next, /quilt_join_session/)
  assert.match(next, /quilt join <invite link> --agent <your name>/)
  const noKey = joinNext({ name: 'Larry', apiUrl: 'https://api.x', hasKey: false })
  assert.match(noKey, /Larry/)
  assert.match(noKey, /https:\/\/api\.x\/mcp/)
  assert.match(noKey, /quilt_join_session/)
  assert.doesNotMatch(noKey, /quilt join <invite link>/)
  assert.doesNotMatch(noKey, /coming soon/)
  for (const s of [text, next, noKey]) assert.equal(s.includes('—'), false, 'no em dash')
})

test('an AI joins with POST: a personal agent with its profile and its first keys, once', async () => {
  const { token, id } = await invite('mem')
  const r = await join(token)
  assert.equal(r.status, 200)
  assert.match(r.body.accessKey, /^qa_/)
  assert.match(r.body.refreshKey, /^qr_/)
  assert.ok(r.body.accessExpiresAt > Date.now() && r.body.refreshExpiresAt > r.body.accessExpiresAt)
  assert.deepEqual([r.body.api, r.body.refresh, r.body.mcp], [API_URL, `${API_URL}/v1/agents/token`, `${API_URL}/mcp`])
  assert.match(r.body.next, /Larry/)
  const agent = await t.store.agentById(r.body.agentId)
  assert.deepEqual([agent.name, agent.provider, agent.type, agent.description, agent.ownerUserId, agent.orgId, agent.invitedBy, agent.publicKey], ['Larry', 'Anthropic', 'coding agent', 'Writes tests', 'mem', null, 'mem', null])
  const me = await t.call('GET', '/v1/agents/me', null, null, { authorization: `Bearer ${r.body.accessKey}` })
  assert.deepEqual([me.status, me.body.agent.kind], [200, 'personal'])
  const listed = (await t.call('GET', '/v1/agent-invites', null, 'mem')).body.invites.find((i) => i.id === id)
  assert.deepEqual([listed.status, listed.usedBy], ['used', { id: agent.id, name: 'Larry', provider: 'Anthropic' }])
  const again = await join(token, { ...PROFILE, name: 'Other' })
  assert.deepEqual([again.status, again.body.error], [410, 'this invite was already used; ask for a new one'])
})

test('a plain GET only explains: it never uses the invite, and is not cached or indexed', async () => {
  const { token, id } = await invite('mem')
  const r = await raw(`/v1/join/${token}`)
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /^text\/markdown/)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  assert.equal(r.headers.get('x-robots-tag'), 'noindex')
  assert.match(r.text, /Status: this invite is open/)
  assert.ok(r.text.includes(`POST ${API_URL}/v1/join/${token}`))
  await raw(`/v1/join/${token}`)
  assert.equal(await statusOf('mem', id), 'waiting', 'still open after two previews')
  assert.equal((await join(token)).status, 200)
  const used = await raw(`/v1/join/${token}`)
  assert.equal(used.status, 410)
  assert.match(used.text, /already used/)
})

test('a GET that names the agent joins, for AIs that can only fetch', async () => {
  const { token } = await invite('mem')
  const partial = await raw(`/v1/join/${token}?name=Fetchy&provider=OpenAI`)
  assert.equal(partial.status, 400, 'type is missing')
  assert.equal(partial.headers.get('x-robots-tag'), 'noindex')
  const r = await t.call('GET', `/v1/join/${token}?name=Fetchy&provider=OpenAI&type=chat%20assistant`)
  assert.equal(r.status, 200)
  const agent = await t.store.agentById(r.body.agentId)
  assert.deepEqual([agent.name, agent.provider, agent.type, agent.description], ['Fetchy', 'OpenAI', 'chat assistant', ''])
})

test('a bad request never burns the invite', async () => {
  const { token, id } = await invite('mem')
  assert.equal((await join(token, { name: 'X', type: 'coding agent' })).status, 400, 'no provider')
  assert.equal((await join(token, { ...PROFILE, name: '  ' })).status, 400)
  assert.equal((await join(token, { ...PROFILE, publicKey: 'nope' })).status, 400)
  assert.equal((await t.call('POST', `/v1/join/${token}`)).status, 400, 'no body')
  assert.equal(await statusOf('mem', id), 'waiting')
  const long = await join(token, { ...PROFILE, name: 'n'.repeat(60), description: 'd'.repeat(300) })
  const agent = await t.store.agentById(long.body.agentId)
  assert.deepEqual([agent.name.length, agent.description.length], [40, 180])
})

test('name, provider, type and description must be strings, checked before the invite is claimed', async () => {
  const { token, id } = await invite('mem')
  assert.equal((await join(token, { ...PROFILE, name: 42 })).status, 400, 'a number, not a string')
  assert.equal((await join(token, { ...PROFILE, provider: ['Anthropic'] })).status, 400, 'an array, not a string')
  assert.equal((await join(token, { ...PROFILE, type: { x: 1 } })).status, 400, 'an object, not a string')
  assert.equal((await join(token, { ...PROFILE, description: 180 })).status, 400, 'a number, not a string')
  assert.equal(await statusOf('mem', id), 'waiting', 'none of these burned the invite')
  assert.equal((await join(token)).status, 200, 'and the link still works')
})

test('a profile field holding the example\'s <placeholder> brackets is refused, so copying it literally never joins', async () => {
  const { token, id } = await invite('mem')
  assert.equal((await join(token, { ...PROFILE, name: '<your-agent-name>' })).status, 400)
  assert.equal((await join(token, { ...PROFILE, provider: '<provider>' })).status, 400)
  assert.equal((await join(token, { ...PROFILE, type: '<type>' })).status, 400)
  assert.equal((await join(token, { ...PROFILE, description: '<short-description>' })).status, 400)
  assert.equal(await statusOf('mem', id), 'waiting', 'none of these burned the invite')
  const stray = await raw(`/v1/join/${token}?name=A&provider=B&type=C&description=looks%3Cfine%3E`)
  assert.equal(stray.status, 400, 'the same check applies to a GET join')
  assert.equal(await statusOf('mem', id), 'waiting')
})

test('an agent may bring its own public key, which belongs to one agent only', async () => {
  const id = generateIdentity()
  const a = await invite('mem'); const b = await invite('mem')
  const r = await join(a.token, { ...PROFILE, publicKey: id.publicKey })
  assert.equal((await t.store.agentById(r.body.agentId)).publicKey, id.publicKey)
  assert.match(r.body.next, /quilt join <invite link> --agent <your name>/, 'with a key, it can also sync files on a computer')
  assert.match(r.body.next, /https:\/\/api\.quilt\.test\/mcp/)
  assert.equal((await join(b.token, { ...PROFILE, publicKey: id.publicKey })).status, 409)
  assert.equal(await statusOf('mem', b.id), 'waiting')
})

test('joining without a public key is told to use the hosted MCP, and is not sent to a computer', async () => {
  const { token } = await invite('mem')
  const r = await join(token)
  assert.equal(r.status, 200)
  assert.equal(r.body.mcp, 'https://api.quilt.test/mcp')
  assert.match(r.body.next, /https:\/\/api\.quilt\.test\/mcp/)
  assert.match(r.body.next, /quilt_join_session/)
  assert.doesNotMatch(r.body.next, /quilt join <invite link>/)
  assert.doesNotMatch(r.body.next, /coming soon|registered only/)
})

test('two joins racing with the same public key: the one the pre-check misses still gets a clear 409 from the store itself', async () => {
  const id = generateIdentity()
  const a = await invite('mem'); const b = await invite('mem')
  // Make every read see "no agent has this key yet", as two requests racing truly
  // concurrently would, so the friendly pre-check in join() can't catch it and the
  // store's own unique index is what actually stops the second one.
  const racy = { ...t.store, agentByPublicKey: async () => null }
  const t2 = await startTestApi({ store: racy })
  try {
    const winner = await t2.call('POST', `/v1/join/${a.token}`, { ...PROFILE, publicKey: id.publicKey })
    assert.equal(winner.status, 200)
    const loser = await t2.call('POST', `/v1/join/${b.token}`, { ...PROFILE, publicKey: id.publicKey })
    assert.deepEqual([loser.status, loser.body.error], [409, 'That public key already belongs to an agent.'])
  } finally { await t2.close() }
})

test('expired, cancelled and unknown invites are refused, and their GET says why', async () => {
  const expired = newToken('qj_')
  await t.store.createAgentInvite({ tokenHash: hashToken(expired), ownerUserId: 'mem', createdBy: 'mem', expiresAt: Date.now() - 1 })
  const cancelled = await invite('mem')
  await t.call('DELETE', `/v1/agent-invites/${cancelled.id}`, null, 'mem')
  assert.deepEqual([(await join(expired)).status, (await join(expired)).body.error], [410, 'this invite has expired; ask for a new one'])
  assert.equal((await join(cancelled.token)).status, 410)
  assert.equal((await join(newToken('qj_'))).status, 404)
  assert.equal((await join('nonsense')).status, 404)
  const e = await raw(`/v1/join/${expired}`)
  assert.deepEqual([e.status, /has expired/.test(e.text)], [410, true])
  const c = await raw(`/v1/join/${cancelled.token}`)
  assert.deepEqual([c.status, /was cancelled/.test(c.text)], [410, true])
  const u = await raw(`/v1/join/${newToken('qj_')}`)
  assert.deepEqual([u.status, /isn't valid/.test(u.text), u.headers.get('x-robots-tag')], [404, true, 'noindex'])
})

test('an org invite makes an org agent with the role, teams and folders it was given', async () => {
  const o = await makeOrg(t, 'Join Bots Co')
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  const web = await t.store.createTeam({ orgId: o.org.id, name: 'Web' })
  const gone = await t.store.createTeam({ orgId: o.org.id, name: 'Gone' })
  const lead = await t.store.createRole({ orgId: o.org.id, name: 'Lead', grants: { teams: { r: true } } })
  const { token } = await invite('admin', `/v1/orgs/${o.slug}/agent-invites`, { roleId: lead.id, teams: [{ teamId: core.id, access: 'editor', scopes: ['src'] }, { teamId: web.id }, { teamId: gone.id }] })
  await t.store.deleteTeam(gone.id)
  const r = await join(token, { name: 'Bot', provider: 'OpenAI', type: 'coding agent' })
  assert.equal(r.status, 200)
  const me = (await t.call('GET', '/v1/agents/me', null, null, { authorization: `Bearer ${r.body.accessKey}` })).body
  assert.deepEqual(me.agent.org, { slug: o.slug, name: 'Join Bots Co' })
  assert.deepEqual(me.role, { name: 'Lead' })
  assert.deepEqual(me.teams.map((x) => [x.name, x.access, x.scopes]).sort(), [['Core', 'editor', ['src']], ['Web', 'viewer', []]], 'a team deleted since is skipped')
  const agent = await t.store.agentById(r.body.agentId)
  assert.deepEqual([agent.orgId, agent.ownerUserId, agent.invitedBy], [o.org.id, null, 'admin'])
})

test('two joins racing on one invite: only one agent is made', async () => {
  const { token } = await invite('mem')
  const [a, b] = await Promise.all([join(token, { ...PROFILE, name: 'A' }), join(token, { ...PROFILE, name: 'B' })])
  assert.deepEqual([a.status, b.status].sort(), [200, 410])
})

test('a join that fails part way removes the half-made agent and reopens the invite', async () => {
  const o = await makeOrg(t, 'Join Flaky Co')
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  const { token, id } = await invite('admin', `/v1/orgs/${o.slug}/agent-invites`, { teams: [{ teamId: core.id }] })
  const broken = await startTestApi({ store: { ...t.store, addTeamMember: async () => { throw new Error('db down') } } })
  try {
    assert.equal((await broken.call('POST', `/v1/join/${token}`, { ...PROFILE, name: 'Half' })).status, 500)
  } finally { await broken.close() }
  const after = await t.store.agentInviteById(id)
  assert.deepEqual([after.usedAt, after.usedByAgentId], [null, null])
  assert.equal((await t.store.listMembers(o.org.id)).some((m) => m.name === 'Half'), false, 'the half-made agent is gone')
  assert.equal((await join(token)).status, 200, 'and the link still works')
})

test('a join that fails part way, when the half-made agent itself cannot be deleted, leaves the invite used instead of reopening it', async () => {
  const o = await makeOrg(t, 'Join Worse Co')
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  const { token, id } = await invite('admin', `/v1/orgs/${o.slug}/agent-invites`, { teams: [{ teamId: core.id }] })
  const logs = []
  const broken = await startTestApi({
    store: { ...t.store, addTeamMember: async () => { throw new Error('db down') }, deleteAgent: async () => { throw new Error('delete also down') } },
    log: (m) => logs.push(m)
  })
  try {
    assert.equal((await broken.call('POST', `/v1/join/${token}`, { ...PROFILE, name: 'Stuck' })).status, 500)
  } finally { await broken.close() }
  const after = await t.store.agentInviteById(id)
  assert.ok(after.usedAt, 'the invite stays used: retrying would only make a second broken agent')
  assert.ok(logs.some((m) => m.includes('join rollback')), 'the failed delete is logged')
})

test('joining is rate-limited per address', async () => {
  const limited = await startTestApi({ joinLimit: 2 })
  try {
    for (const want of [404, 404, 429]) assert.equal((await fetch(`${limited.api.url}/v1/join/qj_nope`)).status, want)
  } finally { await limited.close() }
})

test('an agent that joined before gives its agentId with a new invite and comes back as itself', async () => {
  const first = await join((await invite('mem')).token)
  const id = first.body.agentId
  assert.match(first.body.next, new RegExp(`Your agent id is ${id}\\.`), 'told its id, and to save it')
  assert.equal(first.body.rejoined, false)
  const { token, id: inviteId } = await invite('mem')
  const r = await join(token, { ...PROFILE, description: 'Writes more tests', agentId: id })
  assert.equal(r.status, 200)
  assert.deepEqual([r.body.agentId, r.body.rejoined], [id, true])
  assert.match(r.body.next, /Welcome back/)
  assert.match(r.body.resumeKey, /^qs_/)
  assert.equal((await t.store.agentById(id)).description, 'Writes more tests', 'the profile it sent now')
  assert.equal((await t.call('GET', '/v1/agents', null, 'mem')).body.agents.filter((a) => a.name === 'Larry' && a.id === id).length, 1)
  // Its new resume key works and the old one doesn't; its old keys still work until they run out.
  assert.equal((await t.call('POST', '/v1/agents/resume', { resumeKey: first.body.resumeKey })).status, 401)
  assert.equal((await t.call('GET', '/v1/agents/me', null, null, { authorization: `Bearer ${first.body.accessKey}` })).status, 200)
  assert.equal((await t.call('POST', '/v1/agents/resume', { resumeKey: r.body.resumeKey })).status, 200)
  const used = (await t.call('GET', '/v1/agent-invites', null, 'mem')).body.invites.find((i) => i.id === inviteId)
  assert.deepEqual([used.status, used.usedBy.id, used.rejoined], ['used', id, true])
  // Over GET, for AIs that can only fetch.
  const viaGet = await t.call('GET', `/v1/join/${(await invite('mem')).token}?name=Larry&provider=Anthropic&type=coding%20agent&agentId=${id}`)
  assert.deepEqual([viaGet.status, viaGet.body.agentId, viaGet.body.rejoined], [200, id, true])
})

test("a removed agent comes back with a new invite; someone else's, unknown or malformed agentIds are refused without burning it", async () => {
  const first = await join((await invite('mem')).token)
  const id = first.body.agentId
  assert.equal((await t.call('DELETE', `/v1/agents/${id}`, null, 'mem')).status, 200)
  const back = await join((await invite('mem')).token, { ...PROFILE, agentId: id })
  assert.deepEqual([back.status, back.body.agentId], [200, id])
  assert.equal((await t.store.agentById(id)).revokedAt, null)
  const { token, id: inviteId } = await invite('admin')
  const theirs = await join(token, { ...PROFILE, agentId: id })
  assert.equal(theirs.status, 403)
  assert.match(theirs.body.error, /belongs to someone else.*leave agentId out/)
  assert.equal((await join(token, { ...PROFILE, agentId: '00000000-0000-4000-8000-000000000000' })).status, 404)
  for (const bad of ['nope', 42, '<your-agent-id>']) assert.equal((await join(token, { ...PROFILE, agentId: bad })).status, 400, String(bad))
  assert.equal(await statusOf('admin', inviteId), 'waiting', 'none of them used the invite')
  const fresh = await join(token, { ...PROFILE, agentId: '' })
  assert.equal(fresh.status, 200)
  assert.notEqual(fresh.body.agentId, id, 'an empty agentId joins as a new agent')
})

test("a returning agent keeps its public key, and can't take another agent's", async () => {
  const mine = generateIdentity(); const other = generateIdentity()
  const a = await join((await invite('mem')).token, { ...PROFILE, publicKey: mine.publicKey })
  await join((await invite('mem')).token, { ...PROFILE, name: 'Other', publicKey: other.publicKey })
  const same = await join((await invite('mem')).token, { ...PROFILE, agentId: a.body.agentId, publicKey: mine.publicKey })
  assert.equal(same.status, 200)
  const kept = await join((await invite('mem')).token, { ...PROFILE, agentId: a.body.agentId })
  assert.equal(kept.status, 200)
  assert.equal((await t.store.agentById(a.body.agentId)).publicKey, mine.publicKey, 'leaving publicKey out keeps it')
  assert.equal((await join((await invite('mem')).token, { ...PROFILE, agentId: a.body.agentId, publicKey: other.publicKey })).status, 409)
})

test("a returning org agent gets the new invite's role and teams and keeps the rest; another org's agent is refused", async () => {
  const o = await makeOrg(t, 'Rejoin Bots Co')
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  const web = await t.store.createTeam({ orgId: o.org.id, name: 'Web' })
  const lead = await t.store.createRole({ orgId: o.org.id, name: 'Lead', grants: { teams: { r: true } } })
  const path = `/v1/orgs/${o.slug}/agent-invites`
  const first = await join((await invite('admin', path, { teams: [{ teamId: core.id }] })).token, { name: 'Bot', provider: 'OpenAI', type: 'coding agent' })
  const id = first.body.agentId
  const r = await join((await invite('admin', path, { roleId: lead.id, teams: [{ teamId: core.id, access: 'editor', scopes: ['src'] }, { teamId: web.id }] })).token, { name: 'Bot', provider: 'OpenAI', type: 'coding agent', agentId: id })
  assert.deepEqual([r.status, r.body.agentId], [200, id])
  const me = (await t.call('GET', '/v1/agents/me', null, null, { authorization: `Bearer ${r.body.accessKey}` })).body
  assert.deepEqual(me.role, { name: 'Lead' })
  assert.deepEqual(me.teams.map((x) => [x.name, x.access, x.scopes]).sort(), [['Core', 'editor', ['src']], ['Web', 'viewer', []]])
  assert.equal(me.agent.id, id)
  // A personal invite can't bring back an org's agent.
  assert.equal((await join((await invite('admin')).token, { name: 'Bot', provider: 'OpenAI', type: 'coding agent', agentId: id })).status, 403)
})
