import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PERSONAL_NAV, isOn } from '../lib/nav.js'

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
