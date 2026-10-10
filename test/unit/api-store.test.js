import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../../src/api/memory-store.js'
import { cleanEvent } from '../../src/api/issues.js'

test('devices: the same computer relinking reuses its row and is un-revoked', async () => {
  const s = createMemoryStore()
  s.addUser('u1', { name: 'Dana' })
  const d1 = await s.upsertDevice({ userId: 'u1', name: 'Mac', platform: 'darwin', publicKey: 'pk1' })
  await s.setDeviceToken(d1.id, 'h1')
  assert.equal((await s.deviceByToken('h1')).id, d1.id)
  await s.revokeDevice(d1.id)
  assert.equal(await s.deviceByToken('h1'), null)
  const d2 = await s.upsertDevice({ userId: 'u1', name: 'Mac 2', platform: 'darwin', publicKey: 'pk1' })
  assert.equal(d2.id, d1.id)
  assert.equal(d2.revokedAt, null)
  assert.equal(d2.name, 'Mac 2')
  assert.equal(await s.deviceByToken('h1'), null, 'the old token stays dead')
})

test('devices: revoking clears the token, and relinking clears it too', async () => {
  const s = createMemoryStore()
  const d = await s.upsertDevice({ userId: 'u1', name: 'Mac', platform: 'darwin', publicKey: 'pk1' })
  await s.setDeviceToken(d.id, 'h1')
  await s.revokeDevice(d.id)
  assert.equal((await s.upsertDevice({ userId: 'u1', name: 'Mac', platform: 'darwin', publicKey: 'pk1' })).tokenHash, null)
  await s.setDeviceToken(d.id, 'h2')
  const again = await s.upsertDevice({ userId: 'u1', name: 'Mac', platform: 'darwin', publicKey: 'pk1' })
  assert.equal(again.tokenHash, null, 'a relink without a revoke also retires the old token')
  assert.equal(await s.deviceByToken('h2'), null)
})

test('devices: the same key under two accounts is two rows; one never touches the other', async () => {
  const s = createMemoryStore()
  const a = await s.upsertDevice({ userId: 'u1', name: 'Mac', platform: 'darwin', publicKey: 'pk1' })
  await s.setDeviceToken(a.id, 'ha')
  const b = await s.upsertDevice({ userId: 'u2', name: 'Stolen', platform: 'darwin', publicKey: 'pk1' })
  assert.notEqual(b.id, a.id)
  assert.equal(b.userId, 'u2')
  const stillA = await s.deviceByToken('ha')
  assert.equal(stillA.id, a.id)
  assert.equal(stillA.userId, 'u1')
  assert.equal(stillA.name, 'Mac')
})

test('links are found by device code and by user code', async () => {
  const s = createMemoryStore()
  const l = await s.createLink({ deviceCodeHash: 'dh', userCode: 'AAAA-BBBB', publicKey: 'pk', deviceName: 'Mac', platform: 'darwin', expiresAt: Date.now() + 1000 })
  assert.equal(l.status, 'pending')
  assert.equal((await s.linkByDeviceCode('dh')).id, l.id)
  assert.equal((await s.linkByUserCode('AAAA-BBBB')).id, l.id)
  await s.updateLink(l.id, { status: 'approved', userId: 'u1' })
  assert.equal((await s.linkByUserCode('AAAA-BBBB')).status, 'approved')
})

test('claimLink only changes status once', async () => {
  const s = createMemoryStore()
  const l = await s.createLink({ deviceCodeHash: 'dh2', userCode: 'CCCC-DDDD', publicKey: 'pk', deviceName: 'Mac', platform: 'darwin', expiresAt: Date.now() + 1000 })
  await s.updateLink(l.id, { status: 'approved' })
  assert.equal(await s.claimLink(l.id, 'approved', 'consumed'), true)
  assert.equal((await s.linkByDeviceCode('dh2')).status, 'consumed')
  assert.equal(await s.claimLink(l.id, 'approved', 'consumed'), false)
})

test('profiles are read and edited', async () => {
  const s = createMemoryStore()
  s.addUser('u1', { name: 'Dana' })
  assert.equal((await s.profile('u1')).name, 'Dana')
  assert.equal((await s.updateProfile('u1', { color: '#123456', tool: 'Cursor' })).tool, 'Cursor')
})

test('profileKind defaults to personal, and only an org account reads back org', async () => {
  const s = createMemoryStore()
  s.addUser('u1', { name: 'Dana' })
  s.addUser('u2', { name: 'Org', kind: 'org' })
  assert.equal(await s.profileKind('u1'), 'personal')
  assert.equal(await s.profileKind('u2'), 'org')
  assert.equal(await s.profileKind('missing'), null)
})

test('deleting a user removes their profile, computers and agents', async () => {
  const s = createMemoryStore()
  s.addUser('gone', { name: 'Gone' })
  const d = await s.upsertDevice({ userId: 'gone', name: 'Mac', platform: 'darwin', publicKey: 'pk-gone' })
  await s.setDeviceToken(d.id, 'h-gone')
  const a = await s.createAgent({ name: 'A', provider: 'Anthropic', type: 'coding agent', ownerUserId: 'gone', invitedBy: 'gone' })
  await s.deleteUser('gone')
  assert.equal(await s.profile('gone'), null)
  assert.equal(await s.deviceByToken('h-gone'), null)
  assert.equal(await s.agentById(a.id), null)
})

const at = (iso) => () => Date.parse(iso)
const ev = (raw, now) => cleanEvent(raw, { surface: 'app', appVersion: '0.3.2', platform: 'darwin', userId: 'u1', deviceId: 'd1', now })

test('events: ok outcomes are kept as events only; failures open an issue and repeats count up', async () => {
  const s = createMemoryStore()
  const t1 = at('2026-10-01T10:00:00Z'); const t2 = at('2026-10-01T11:00:00Z')
  assert.equal(await s.recordEvents([
    ev({ kind: 'action', name: 'open-in', outcome: 'ok', durationMs: 40 }, t1),
    ev({ kind: 'action', name: 'open-in', outcome: 'error', message: 'Could not open it: spawn /Users/a/x ENOENT' }, t1)
  ]), 2)
  await s.recordEvents([ev({ kind: 'action', name: 'open-in', outcome: 'error', message: 'Could not open it: spawn /Users/b/y ENOENT' }, t2)])
  const events = s.listEvents()
  assert.equal(events.length, 3)
  assert.equal(events[0].issueId, null, 'an ok event belongs to no issue')
  const issues = s.listIssues()
  assert.equal(issues.length, 1)
  assert.equal(issues[0].count, 2)
  assert.equal(issues[0].message, 'Could not open it: spawn /Users/a/x ENOENT', 'the first message seen is kept')
  assert.equal(issues[0].firstSeenAt, t1()); assert.equal(issues[0].lastSeenAt, t2())
  assert.equal(events[1].issueId, issues[0].id); assert.equal(events[2].issueId, issues[0].id)
  assert.equal(events[1].durationMs, null); assert.equal(events[0].durationMs, 40)
})

test('events: a new occurrence reopens a resolved issue', async () => {
  const s = createMemoryStore()
  const t = at('2026-10-01T10:00:00Z')
  await s.recordEvents([ev({ kind: 'http404', name: '/pricing/old', outcome: 'error', status: 404 }, t)])
  const [issue] = s.listIssues()
  await s.resolveIssue(issue.id)
  assert.ok(s.listIssues()[0].resolvedAt)
  await s.recordEvents([ev({ kind: 'http404', name: '/pricing/old', outcome: 'error', status: 404 }, at('2026-10-02T10:00:00Z'))])
  assert.equal(s.listIssues()[0].resolvedAt, null)
  assert.equal(s.listIssues()[0].count, 2)
})

test('events: pruning deletes old events and keeps issues', async () => {
  const s = createMemoryStore()
  await s.recordEvents([ev({ kind: 'action', name: 'a', outcome: 'error', message: 'x' }, at('2026-08-01T00:00:00Z'))])
  await s.recordEvents([ev({ kind: 'action', name: 'a', outcome: 'ok' }, at('2026-10-01T00:00:00Z'))])
  assert.equal(await s.pruneEvents(Date.parse('2026-09-01T00:00:00Z')), 1)
  assert.equal(s.listEvents().length, 1)
  assert.equal(s.listIssues().length, 1)
})

test('issues: pruning drops issues not seen since the cut-off, by lastSeenAt', async () => {
  const s = createMemoryStore()
  await s.recordEvents([ev({ kind: 'action', name: 'old', outcome: 'error', message: 'x' }, at('2026-08-01T00:00:00Z'))])
  await s.recordEvents([ev({ kind: 'action', name: 'new', outcome: 'error', message: 'y' }, at('2026-10-01T00:00:00Z'))])
  assert.equal(await s.pruneIssues(Date.parse('2026-09-01T00:00:00Z')), 1)
  const left = s.listIssues()
  assert.equal(left.length, 1)
  assert.equal(left[0].name, 'new')
})
