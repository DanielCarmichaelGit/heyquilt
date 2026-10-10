// A session's audit trail on the accounts API: what the relay reports (how each visit came
// in, why it ended, what it did), read back by the session owner as JSON or CSV.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { startTestApi, makeAgent } from '../helpers/api-helpers.js'
import { endReasonOf, auditCsv, HOSTED_QUIET_MS } from '../../src/api/audit.js'
import { HOSTED_ONLINE_MS } from '../../src/server.js'
import { cleanEvent } from '../../src/api/routes/relay.js'
import { createSupabaseStore } from '../../src/api/supabase-store.js'
import { END_REASONS, ACTIONS } from '../../src/presence.js'
import fs from 'node:fs'

const SECRET = 'test-relay-secret-0123456789'
const MIN = 60 * 1000
let t
before(async () => { t = await startTestApi({ relaySecret: SECRET }) })
after(() => t.close())

let rooms = 0
const room = () => `audit-${++rooms}`
const report = (events) => t.call('POST', '/v1/relay/presence', { events }, null, { authorization: `Bearer ${SECRET}` })
const ago = (min) => Date.now() - min * MIN
const start = (r, account, name, at, extra = {}) => ({ id: crypto.randomUUID(), type: 'start', room: r, account, name, at, ...extra })
const end = (s, at, reason) => ({ id: crypto.randomUUID(), type: 'end', start: s.id, room: s.room, account: s.account, at, ...(reason ? { reason } : {}) })
const act = (s, at, action, target) => ({ id: crypto.randomUUID(), type: 'act', start: s.id, room: s.room, account: s.account, action, target, at })

test("the relay's quiet window and the API's agree", () => {
  assert.equal(HOSTED_QUIET_MS, HOSTED_ONLINE_MS)
})

test('the owner reads every visit: how it came in, what it did and when, and why it ended', async () => {
  const r = room()
  const owner = start(r, 'person:owner', 'Olive', ago(120), { owner: true, via: 'app', tool: 'Quilt app' })
  const bot = start(r, 'agent:bot-1', 'Larry', ago(90), { via: 'hosted', tool: 'Codex' })
  const mo = start(r, 'person:mem', 'Mo', ago(60), { via: 'app' })
  const botEnd = end(bot, ago(80), 'idle')
  const res = await report([
    owner, bot, mo,
    act(bot, ago(89), 'claimed', 'src/a.js'),
    act(bot, ago(88), 'edited', 'src/a.js'),
    act(bot, ago(85), 'tool', 'quilt_move_task t-1'),
    botEnd,
    end(mo, ago(30), 'removed')
  ])
  assert.deepEqual(res.body, { ok: true, applied: 8, skipped: 0 })
  const got = await t.call('GET', `/v1/me/sessions/${r}/audit`, null, 'owner')
  assert.equal(got.status, 200)
  const v = got.body.visits
  assert.deepEqual(v.map((x) => [x.name, x.kind, x.via, x.tool, x.endReason]), [
    ['Mo', 'person', 'app', null, 'removed'],
    ['Larry', 'agent', 'hosted', 'Codex', 'idle'],
    ['Olive', 'person', 'app', 'Quilt app', null]
  ])
  assert.deepEqual(v[1].actions.map((a) => [a.action, a.target]), [['claimed', 'src/a.js'], ['edited', 'src/a.js'], ['tool', 'quilt_move_task t-1']])
  assert.deepEqual([v[1].startedAt, v[1].endedAt], [bot.at, botEnd.at])
})

test('only the owner may read it; people who were never in it get a 404', async () => {
  const r = room()
  const owner = start(r, 'person:owner', 'Olive', ago(10), { owner: true })
  await report([owner, start(r, 'person:mem', 'Mo', ago(5))])
  assert.equal((await t.call('GET', `/v1/me/sessions/${r}/audit`, null, 'mem')).status, 403)
  assert.equal((await t.call('GET', `/v1/me/sessions/${r}/audit`, null, 'out')).status, 404)
  assert.equal((await t.call('GET', `/v1/me/sessions/${r}/audit`, null, null)).status, 401)
})

test("an agent whose keys were revoked shows its visit ended because of it", async () => {
  const { agent } = await makeAgent(t, { name: 'Rev', ownerUserId: 'owner' })
  const r = room()
  const owner = start(r, 'person:owner', 'Olive', ago(60), { owner: true })
  const bot = start(r, `agent:${agent.id}`, 'Rev', ago(50), { via: 'app' })
  await t.store.revokeAgent(agent.id)
  await report([owner, bot, end(bot, Date.now(), 'pass_expired')])
  const v = (await t.call('GET', `/v1/me/sessions/${r}/audit`, null, 'owner')).body.visits
  assert.equal(v.find((x) => x.name === 'Rev').endReason, 'revoked')
})

test('why a visit ended, with revocation the relay could not see', () => {
  const v = { startedAt: 1000, endedAt: 5000, endReason: 'pass_expired' }
  assert.equal(endReasonOf(v, null), 'pass_expired')
  assert.equal(endReasonOf(v, 4000), 'revoked')
  assert.equal(endReasonOf(v, 6000), 'pass_expired', 'revoked after it had already gone')
  assert.equal(endReasonOf(v, 500), 'pass_expired', 'revoked before this visit: it came back with new keys')
  assert.equal(endReasonOf({ ...v, endReason: 'idle' }, 5000 + HOSTED_QUIET_MS - 1), 'revoked', 'quiet, and revoked before it would have come back')
  assert.equal(endReasonOf({ ...v, endReason: 'removed' }, 4000), 'removed')
  assert.equal(endReasonOf({ ...v, endedAt: null }, 4000), null, 'still in')
})

test('CSV: one row per event in time order, UTC times, formulas defused', async () => {
  const r = room()
  const owner = start(r, 'person:owner', 'Olive', ago(30), { owner: true, via: 'app' })
  const bot = start(r, 'agent:bot-csv', 'Larry, the bot', ago(20), { via: 'hosted', tool: 'Grok' })
  await report([owner, bot, act(bot, ago(19), 'edited', '=cmd|calc'), end(bot, ago(10), 'left')])
  const res = await fetch(`${t.api.url}/v1/me/sessions/${r}/audit?format=csv`, { headers: { authorization: 'Bearer user:owner' } })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /^text\/csv/)
  const lines = (await res.text()).trim().split('\r\n')
  assert.equal(lines[0], 'time_utc,member,account,kind,event,detail,via,tool')
  assert.deepEqual(lines.slice(1).map((l) => l.split(',')[0]), lines.slice(1).map((l) => l.split(',')[0]).sort())
  assert.match(lines[1], /^\d{4}-\d\d-\d\dT.*Z,Olive,person:owner,person,joined,,app,$/)
  assert.match(lines.find((l) => l.includes('edited')), /,"Larry, the bot",agent:bot-csv,agent,edited,'=cmd\|calc,hosted,Grok$/)
  assert.match(lines.at(-1), /,left,left,hosted,Grok$/)
  assert.equal(auditCsv([]), 'time_utc,member,account,kind,event,detail,via,tool\r\n')
})

test('the API takes only what it knows: unknown reasons, actions and vias are dropped, labels are cleaned', () => {
  const now = Date.now()
  const s = cleanEvent({ id: crypto.randomUUID(), type: 'start', room: 'r1', account: 'agent:a', name: 'A', via: 'carrier-pigeon', tool: 'Cur\u0000sor‮', at: now }, now)
  assert.deepEqual([s.via, s.tool], [undefined, 'Cursor'])
  const e = cleanEvent({ id: crypto.randomUUID(), type: 'end', start: crypto.randomUUID(), room: 'r1', account: 'agent:a', reason: 'whatever', at: now }, now)
  assert.equal(e.reason, undefined)
  assert.equal(cleanEvent({ id: crypto.randomUUID(), type: 'act', start: crypto.randomUUID(), room: 'r1', account: 'agent:a', action: 'hack', at: now }, now), null)
  const a = cleanEvent({ id: crypto.randomUUID(), type: 'act', start: crypto.randomUUID(), room: 'r1', account: 'agent:a', action: 'edited', target: 'x'.repeat(400), at: now }, now)
  assert.equal(a.target.length, 300)
})

test("an act whose visit never arrived is skipped, and a replayed one applies once", async () => {
  const r = room()
  const owner = start(r, 'person:owner', 'Olive', ago(10), { owner: true })
  const orphan = act({ id: crypto.randomUUID(), room: r, account: 'agent:x' }, ago(9), 'edited', 'a')
  const mine = act(owner, ago(8), 'edited', 'b')
  await report([owner, orphan, mine])
  await report([mine])
  const v = (await t.call('GET', `/v1/me/sessions/${r}/audit`, null, 'owner')).body.visits
  assert.deepEqual(v[0].actions.map((a) => a.target), ['b'])
})

test('deleting an account takes its visits and what they did', async () => {
  const r = room()
  const owner = start(r, 'person:owner', 'Olive', ago(10), { owner: true })
  const mo = start(r, 'person:mem', 'Mo', ago(9))
  await report([owner, mo, act(mo, ago(8), 'edited', 'gone.txt')])
  const before = await t.store.actionsInRoom(r, { from: 0, to: Date.now() + 1, limit: 10 })
  assert.equal(before.length, 1)
  await t.store.deleteUser('mem')
  assert.deepEqual(await t.store.actionsInRoom(r, { from: 0, to: Date.now() + 1, limit: 10 }), [])
})

test('the migration: clients never touch it, functions are the service role\'s, and its lists match the relay\'s', () => {
  const sql = fs.readFileSync(new URL('../../supabase/migrations/20261008000000_audit_trail.sql', import.meta.url), 'utf8')
  assert.match(sql, /alter table public\.visit_actions enable row level security/)
  assert.match(sql, /revoke all on public\.visit_actions from anon, authenticated;/)
  assert.doesNotMatch(sql, /create policy/)
  assert.match(sql, /references public\.session_visits \(event_start_id\) on delete cascade/)
  assert.ok(sql.includes('revoke execute on function public.actions_in_room (text, timestamptz, timestamptz, integer) from public, anon, authenticated;'))
  assert.ok(sql.includes('grant execute on function public.actions_in_room (text, timestamptz, timestamptz, integer) to service_role;'))
  for (const m of sql.matchAll(/create (or replace )?function public\.\w+[\s\S]*?\nas \$\$/g)) assert.match(m[0], /set search_path = ''/)
  for (const r of END_REASONS) assert.ok(sql.includes(`'${r}'`), r)
  for (const a of ACTIONS) assert.ok(sql.includes(`'${a}'`), a)
})

test('the Supabase store reads actions through actions_in_room, with times as epoch ms', async () => {
  const calls = []
  const chain = (call) => new Proxy({}, {
    get (_, op) {
      if (op === 'then') return (res) => Promise.resolve({ data: [{ id: 'a1', visit_start_id: 'v1', room: 'r1', account: 'agent:a', action: 'edited', target: 'x', at: '2026-10-07T12:00:00Z' }], error: null }).then(res)
      return (...args) => { call.ops.push([op, ...args]); return chain(call) }
    }
  })
  const client = { rpc (fn, args) { const call = { fn, args, ops: [] }; calls.push(call); return chain(call) } }
  const rows = await createSupabaseStore({ client }).actionsInRoom('r1', { from: 0, to: Date.parse('2026-10-08T00:00:00Z'), limit: 10 })
  assert.deepEqual(calls[0].args, { p_room: 'r1', p_from: '1970-01-01T00:00:00.000Z', p_to: '2026-10-08T00:00:00.000Z', p_limit: 10 })
  assert.deepEqual(rows, [{ id: 'a1', visitStartId: 'v1', room: 'r1', account: 'agent:a', action: 'edited', target: 'x', at: Date.parse('2026-10-07T12:00:00Z') }])
})

test('actions in the same millisecond keep the order they happened in', async () => {
  const r = room()
  const owner = start(r, 'person:owner', 'Olive', ago(10), { owner: true })
  const at = ago(5)
  const names = ['tool', 'claimed', 'created', 'messaged', 'released']
  await report([owner, ...names.map((a, i) => act(owner, at, a, `x${i}`))])
  const v = (await t.call('GET', `/v1/me/sessions/${r}/audit`, null, 'owner')).body.visits
  assert.deepEqual(v[0].actions.map((a) => a.action), names)
})
