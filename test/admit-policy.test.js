// Who may let people into a session: the setting and the check.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ADMIT_BY, DEFAULT_ADMIT_BY, ADMIT_BY_LABELS, BAD_ADMIT_BY,
  cleanAdmitBy, canAdmit
} from '../src/admit-policy.js'

test('admit-by values are owner, editors, members; default is owner', () => {
  assert.deepEqual([...ADMIT_BY], ['owner', 'editors', 'members'])
  assert.equal(DEFAULT_ADMIT_BY, 'owner')
  assert.equal(ADMIT_BY_LABELS.owner, 'Only the owner')
  assert.equal(cleanAdmitBy('editors'), 'editors')
  assert.equal(cleanAdmitBy('  members '), 'members')
  assert.equal(cleanAdmitBy('admin'), null)
  assert.equal(cleanAdmitBy(''), null)
  assert.ok(BAD_ADMIT_BY.includes('owner'))
})

test('the owner always may admit; others follow the setting', () => {
  const owner = { owner: true, role: 'editor' }
  const editor = { owner: false, role: 'editor' }
  const viewer = { owner: false, role: 'viewer' }
  assert.equal(canAdmit(owner, 'owner'), true)
  assert.equal(canAdmit(editor, 'owner'), false)
  assert.equal(canAdmit(viewer, 'owner'), false)
  assert.equal(canAdmit(editor, 'editors'), true)
  assert.equal(canAdmit(viewer, 'editors'), false)
  assert.equal(canAdmit(editor, 'members'), true)
  assert.equal(canAdmit(viewer, 'members'), true)
  assert.equal(canAdmit(null, 'members'), false)
  assert.equal(canAdmit(editor, 'nope'), false, 'unknown setting falls back to owner-only')
})

test('the app works out canAdmit when the relay is older and does not send it', async () => {
  const { Session } = await import('../src/session.js')
  const get = Object.getOwnPropertyDescriptor(Session.prototype, 'canAdmit').get
  const as = (access, admitBy = 'owner') => get.call({ access, admitBy })
  // An older relay: no canAdmit, no admitBy. The owner still sees who's waiting.
  assert.equal(as({ state: 'approved', owner: true, role: 'editor' }), true)
  assert.equal(as({ state: 'approved', owner: false, role: 'editor' }), false)
  assert.equal(as({ state: 'pending' }), false)
  assert.equal(as(null), false)
  // A newer relay decides.
  assert.equal(as({ state: 'approved', owner: false, role: 'editor', canAdmit: true }), true)
  assert.equal(as({ state: 'approved', owner: true, role: 'editor', canAdmit: false }), false)
  // The room's setting from the member list counts when access doesn't carry it.
  assert.equal(as({ state: 'approved', owner: false, role: 'editor' }, 'editors'), true)
})
