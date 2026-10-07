// Wording on the audit trail page.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reasonText, howText, actionLine, spanText, filterVisits } from '../lib/audit-view.js'

const T = (iso) => Date.parse(iso)

test('why a visit ended, in words; an open one is still here', () => {
  assert.equal(reasonText({ endedAt: null, endReason: null }), 'Still here')
  assert.equal(reasonText({ endedAt: 1, endReason: 'revoked' }), 'Access revoked')
  assert.equal(reasonText({ endedAt: 1, endReason: 'idle' }), 'Done working (went quiet)')
  assert.equal(reasonText({ endedAt: 1, endReason: null }), 'Left', 'visits from before reasons were recorded')
})

test('how a member came in', () => {
  assert.equal(howText({ via: 'hosted', tool: 'Codex' }), 'Hosted agent · Codex')
  assert.equal(howText({ via: 'app', tool: null }), 'Quilt app')
  assert.equal(howText({ via: 'app', tool: 'Quilt app' }), 'Quilt app', 'not said twice')
  assert.equal(howText({}), 'Unknown')
})

test("actions and spans in the visitor's time zone", () => {
  assert.deepEqual(actionLine({ at: T('2026-10-07T14:05:00Z'), action: 'handed_off', target: 'src/a.js' }, 'UTC'), { time: '2:05 PM', what: 'Handed off', target: 'src/a.js' })
  assert.equal(spanText({ startedAt: T('2026-10-07T09:00:00Z'), endedAt: T('2026-10-07T10:30:00Z') }, 'UTC'), 'Oct 7, 2026, 9:00 AM to 10:30 AM')
  assert.equal(spanText({ startedAt: T('2026-10-07T23:00:00Z'), endedAt: T('2026-10-08T01:00:00Z') }, 'UTC'), 'Oct 7, 2026, 11:00 PM to Oct 8, 2026, 1:00 AM')
  assert.equal(spanText({ startedAt: T('2026-10-07T09:00:00Z'), endedAt: null }, 'UTC'), 'Oct 7, 2026, 9:00 AM to now')
})

test('filter by agents or people', () => {
  const v = [{ kind: 'agent' }, { kind: 'person' }]
  assert.equal(filterVisits(v, 'agent').length, 1)
  assert.equal(filterVisits(v, 'nonsense').length, 2)
})
