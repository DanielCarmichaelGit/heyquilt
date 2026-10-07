import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PERSONAL_NAV, isOn, sectionOf, sectionPage, isSectionOn, currentSection, showBackToTop } from '../lib/nav.js'

const active = (pathname) => PERSONAL_NAV.filter((item) => isOn(item, pathname)).map((item) => item.label)

test('exactly one personal tab is on for each personal page', () => {
  assert.deepEqual(active('/dashboard'), ['Dashboard'])
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

test('sectionOf / sectionPage split an in-page link', () => {
  assert.equal(sectionOf({ href: '/#how' }), 'how')
  assert.equal(sectionOf({ href: '/pricing' }), '')
  assert.equal(sectionPage({ href: '/#agents' }), '/')
  assert.equal(sectionPage({ href: '#agents' }), '/')
  assert.equal(sectionPage({ href: '/docs#setup' }), '/docs')
})

test('isSectionOn: an in-page item is on only on its page while its section is in view', () => {
  const how = { href: '/#how' }
  const agents = { href: '/#agents' }
  assert.equal(isSectionOn(how, '/', 'how'), true)
  assert.equal(isSectionOn(agents, '/', 'how'), false)
  assert.equal(isSectionOn(agents, '/', 'agents'), true)
  assert.equal(isSectionOn(how, '/', ''), false)
  assert.equal(isSectionOn(how, '/pricing', 'how'), false)
  assert.equal(isSectionOn({ href: '/pricing' }, '/pricing', 'how'), false)
})

test('currentSection follows the scroll: hero, How it works, Agents, then past both', () => {
  // Boxes as getBoundingClientRect reports them at four scroll positions.
  const at = (y) => [
    { id: 'how', top: 900 - y, bottom: 1500 - y },
    { id: 'agents', top: 1600 - y, bottom: 2400 - y }
  ]
  assert.equal(currentSection(at(0)), '')
  assert.equal(currentSection(at(800)), 'how')
  assert.equal(currentSection(at(1500)), 'agents')
  assert.equal(currentSection(at(3000)), '')
  // The gap between sections lights nothing rather than the wrong one.
  assert.equal(currentSection(at(1420)), '')
  // Missing sections (not on this page) are skipped.
  assert.equal(currentSection([null, { id: 'agents', top: 0, bottom: 500 }]), 'agents')
})

test('back-to-top shows after about a screen of scrolling, never at the top', () => {
  assert.equal(showBackToTop(0, 800), false)
  assert.equal(showBackToTop(400, 800), false)
  assert.equal(showBackToTop(800, 800), true)
  assert.equal(showBackToTop(500, 400), true) // short windows still need 480px
  assert.equal(showBackToTop(470, 400), false)
})
