/* eslint-disable no-template-curly-in-string */
// Where agents work, on the website: the placement form (Works in and Joins) on the
// Agents page and on org People agent rows, and agents with why they are there on a
// workspace's page. With workspaces off, the Agents and People pages are as before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { reachOptions, placementOf, placementFromForm, placementChoices, personalWorkspaces, orgWorkspaces, viaLabel, joinsText, peopleOnly } from '../lib/agent-placement.js'

const src = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
function form (fields) {
  const f = new FormData()
  for (const [k, v] of fields) f.append(k, v)
  return f
}
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

test('placementFromForm: chosen workspaces only for Chosen workspaces; access and folders kept', () => {
  assert.deepEqual(placementFromForm(form([['reach', 'workspaces'], ['sessions', 'all'], ['workspaceId', A], ['workspaceId', B], ['workspaceId', A], ['access', 'view'], ['scope', 'docs'], ['scope', 'art']])),
    { reach: 'workspaces', sessions: 'all', access: 'view', scopes: ['docs', 'art'], workspaceIds: [A, B] })
  assert.deepEqual(placementFromForm(form([['reach', 'all'], ['sessions', 'invited'], ['workspaceId', A]])),
    { reach: 'all', sessions: 'invited', access: 'edit', scopes: [], workspaceIds: [] })
  // Anything odd falls back to an agent that works only where it is added.
  assert.deepEqual(placementFromForm(form([['reach', 'everywhere'], ['sessions', 'sometimes']])),
    { reach: 'manual', sessions: 'invited', access: 'edit', scopes: [], workspaceIds: [] })
})

test('placementOf: an agent with no placement works only where it is added', () => {
  assert.deepEqual(placementOf(null), { reach: 'manual', sessions: 'invited', access: 'edit', workspaceIds: [], scopes: [] })
  assert.deepEqual(placementOf({ reach: 'workspaces', sessions: 'all', access: 'view', workspaceIds: [A], scopes: ['x'] }), { reach: 'workspaces', sessions: 'all', access: 'view', workspaceIds: [A], scopes: ['x'] })
})

test('placementChoices keeps chosen workspaces the form cannot show', () => {
  const { shown, hidden } = placementChoices({ reach: 'workspaces', workspaceIds: [A, B] }, [{ id: A, name: 'Launch', extra: 1 }])
  assert.deepEqual(shown, [{ id: A, name: 'Launch' }])
  assert.deepEqual(hidden, [B])
})

test('the workspaces an agent can be placed in: its owner\'s personal ones, or its org\'s', () => {
  const list = [
    { id: '1', space: { kind: 'personal' }, via: 'owner' },
    { id: '2', space: { kind: 'personal' }, via: 'member' },
    { id: '3', space: { kind: 'org', slug: 'acme' }, via: 'org' },
    { id: '4', space: { kind: 'org', slug: 'other' }, via: 'org' }
  ]
  assert.deepEqual(personalWorkspaces(list).map((w) => w.id), ['1'])
  assert.deepEqual(orgWorkspaces(list, 'acme').map((w) => w.id), ['3'])
})

test('words: Works in, why an agent is here, Joins', () => {
  assert.deepEqual(reachOptions().map(([, l]) => l), ['All workspaces (global)', 'Chosen workspaces', 'Only where added'])
  assert.equal(reachOptions('All Acme workspaces')[0][1], 'All Acme workspaces')
  assert.equal(viaLabel({ via: 'member' }), 'This workspace')
  assert.equal(viaLabel({ via: 'global', managedBy: 'owner' }), 'Global')
  assert.equal(viaLabel({ via: 'placed', managedBy: 'owner' }), 'Placed')
  assert.equal(viaLabel({ via: 'global', managedBy: 'org' }, 'Acme'), 'Added by Acme')
  assert.equal(joinsText('all'), 'Joins every session')
  assert.equal(joinsText('invited'), 'Joins when invited')
  assert.deepEqual(peopleOnly([{ account: 'person:1' }, { account: 'agent:a' }, { account: 'agent:gone' }], [{ account: 'agent:a' }]).map((m) => m.account), ['person:1', 'agent:gone'])
})

test('AgentPlacement: a client form with Works in (radios and checkboxes) and Joins', () => {
  const s = src('components/AgentPlacement.js')
  assert.ok(s.startsWith("'use client'"))
  assert.match(s, /export default function AgentPlacement \(\{ agent, workspaces, action/)
  for (const bit of ["type='radio'", "name='reach'", "type='checkbox'", "name='workspaceId'", "name='sessions'", "name='access'", "name='scope'", 'useActionState(action', 'Works in', 'Joins']) assert.ok(s.includes(bit), bit)
})

test('the Agents page shows placements only when workspaces are on', () => {
  const s = src('app/dashboard/agents/page.js')
  assert.ok(s.includes("import { workspacesOn } from '@/lib/workspaces.js'"))
  assert.ok(s.includes('const on = await workspacesOn(user.accessToken)'))
  assert.match(s, /on\s*\?\s*await Promise\.all\(\[\s*Promise\.all\(agents\.map/, 'placements are read only when on')
  assert.match(s, /\{on && placement\?\.ok && <div style=\{\{ flexBasis: '100%' \}\}><AgentPlacement /)
  const a = src('app/dashboard/actions.js')
  assert.match(a, /export async function saveAgentPlacement \(prev, formData\)/)
  assert.ok(a.includes("apiCall(user, 'PUT', `/v1/me/agents/${encodeURIComponent(id)}/placement`, placementFromForm(formData))"))
})

test('org People: agent rows get a placement form with Agents: Update and Workspaces: Update, only when workspaces are on', () => {
  const s = src('app/org/[slug]/people/page.js')
  assert.ok(s.includes("import { workspacesOn } from '@/lib/workspaces.js'"))
  assert.match(s, /const placing = canSetAgentRole && allowed\(me, 'workspaces', 'u'\) && await workspacesOn\(user\.accessToken\)/)
  assert.match(s, /\{placing && placements\.has\(m\.agentId\) && <div style=\{\{ flexBasis: '100%' \}\}><AgentPlacement /)
  const a = src('app/org/[slug]/people/actions.js')
  assert.match(a, /export async function saveOrgAgentPlacement \(prev, formData\)/)
  assert.ok(a.includes('`/v1/orgs/${slug}/agents/${encodeURIComponent(id)}/placement`'))
})

test('workspace pages list agents with why they are here, and admins set Joins', () => {
  for (const [page, actions] of [['app/dashboard/workspaces/[id]/page.js', 'app/dashboard/workspaces/actions.js'], ['app/org/[slug]/workspaces/[id]/page.js', 'app/org/[slug]/workspaces/actions.js']]) {
    const s = src(page)
    assert.ok(s.includes('<WorkspaceAgents '), page)
    assert.ok(s.includes('const members = peopleOnly(all, agents)'), page)
    const a = src(actions)
    for (const fn of ['setAgentJoins', 'keepAgentOut', 'letAgentBackIn']) assert.match(a, new RegExp(`export async function ${fn} \\(formData\\)`), `${actions} ${fn}`)
    assert.ok(a.includes('/agents/${enc(agentId)}`'), actions)
  }
  const c = src('components/WorkspaceAgents.js')
  for (const bit of ['viaLabel(a, orgName)', "name='sessions'", 'Not in this workspace', 'Let back in', 'joinsText(a.sessions)']) assert.ok(c.includes(bit), bit)
  // Someone else's agent: Joins is shown, disabled, with why (only its owner can make it join every session).
  assert.ok(c.includes('disabled={a.foreign}'), 'disabled for a foreign agent')
  assert.ok(c.includes('FOREIGN_JOINS'), 'with the reason')
})

test('the reason a foreign agent cannot be made to join every session', async () => {
  const { FOREIGN_JOINS } = await import('../lib/agent-placement.js')
  assert.equal(FOREIGN_JOINS, 'Only its owner can make an agent join every session.')
})
