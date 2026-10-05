import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PERSONAL_NAV, isOn, withoutWorkspaces } from '../lib/nav.js'
import { orgTabs } from '../lib/org-view.js'

const active = (pathname) => PERSONAL_NAV.filter((item) => isOn(item, pathname)).map((item) => item.label)

test('exactly one personal tab is on for each personal page', () => {
  assert.deepEqual(active('/dashboard'), ['Dashboard'])
  assert.deepEqual(active('/dashboard/workspaces'), ['Workspaces'])
  assert.deepEqual(active('/dashboard/workspaces/abc'), ['Workspaces'])
  assert.deepEqual(active('/dashboard/computers'), ['Computers'])
  assert.deepEqual(active('/dashboard/agents'), ['Agents'])
  assert.deepEqual(active('/dashboard/access'), ['Access types'])
  assert.deepEqual(active('/settings'), [])
})

test('isOn: in-page links are never on, and a non-exact item covers pages under it', () => {
  assert.equal(isOn({ href: '/#how' }, '/'), false)
  assert.equal(isOn({ href: '/org/acme/teams' }, '/org/acme/teams/web'), true)
  assert.equal(isOn({ href: '/org/acme', exact: true }, '/org/acme/teams'), false)
})

test('withoutWorkspaces drops only the Workspaces tab, for the personal and org bars', () => {
  assert.deepEqual(withoutWorkspaces(PERSONAL_NAV).map((i) => i.label), ['Dashboard', 'Computers', 'Agents', 'Access types'])
  const org = orgTabs('acme', { isOwner: true, grants: {} })
  assert.ok(org.some((i) => i.label === 'Workspaces'))
  assert.deepEqual(withoutWorkspaces(org).map((i) => i.label), org.filter((i) => i.label !== 'Workspaces').map((i) => i.label))
  assert.equal(PERSONAL_NAV.length, 5, 'the list itself is unchanged')
})
