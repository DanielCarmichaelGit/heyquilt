// test/ui-workspaces-screens.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const ui = (f) => fs.readFileSync(new URL(`../src/ui/${f}`, import.meta.url), 'utf8')
const EM_DASH = String.fromCharCode(0x2014)

test('home shows the workspace grid when the API has workspaces on, and today\'s list otherwise', () => {
  const h = ui('home.js')
  assert.ok(h.includes("from './workspaces.js'"))
  assert.ok(h.includes('state.workspacesOn ? workspacesHtml()'), 'the grid replaces the session list only when on')
  assert.ok(ui('workspaces.js').includes('Sessions not in a workspace'))
})

test('the grid: a card per workspace with cover, name, space pill, counts, avatars, and an Add workspace card that becomes the form', () => {
  const w = ui('workspaces.js')
  for (const bit of ['class="ws-card"', 'data-open-ws=', 'class="ws-cover', 'ws-space', 'session', 'files', 'class="ws-card add"', 'Add workspace', 'data-add-ws', 'name="name"', 'name="org"', 'name="color"', 'name="description"', 'Create', "api('POST', '/api/workspaces'"]) assert.ok(w.includes(bit), bit)
  assert.ok(w.includes('data-space-filter'), 'a Personal / org switch')
  assert.ok(w.includes("'/api/orgs'"), 'the Where list comes from the account\'s orgs, so an org\'s first workspace can be made')
  assert.ok(w.includes('open</span>') || w.includes('open<'), 'an N open pill')
})

test('the workspace page: back link, header, session cards with New session, people cards with access and Add, settings', () => {
  const w = ui('workspaces.js')
  for (const bit of ['All workspaces', 'data-ws-back', 'class="ws-head"', 'class="sc-grid"', 'data-rejoin=', 'data-go=', 'data-new-session-in=', 'New session', 'People &amp; agents', 'class="pc"', 'data-member-access=', 'data-member-remove=', 'Add a person or an agent', 'data-ws-settings', 'Delete workspace', "'/update'", "'/delete'", "'/members/remove'"]) assert.ok(w.includes(bit), bit)
})

test('settings: Save sends archived only when it changed, and Delete shows only to who may delete', () => {
  const w = ui('workspaces.js')
  const dialog = w.slice(w.indexOf('function settingsDialog'))
  assert.ok(dialog.includes("if (archived !== !!w.archivedAt) patch.archived = archived"), 'an unchanged toggle leaves archivedAt alone')
  assert.ok(!dialog.includes("archived: f.get('archived') === 'on'"))
  assert.ok(dialog.includes("state.workspace.canDelete ? '<button type=\"button\" class=\"btn ghost danger\" data-delete>Delete workspace</button>' : ''"))
  assert.ok(dialog.includes("form.querySelector('[data-delete]')?.addEventListener"))
})

test('starting a session from a workspace passes the workspace id', () => {
  const h = ui('home.js')
  assert.ok(h.includes('export function newSessionDialog (workspace = \'\')'))
  assert.ok(h.includes("{ mode: 'create', dir, workspace }"))
  assert.ok(h.includes("{ mode: 'github', ...body, workspace }"))
})

test('app routes ws: views through the shell and loads workspaces at boot', () => {
  const a = ui('app.js')
  for (const bit of ["startsWith('ws:')", 'loadWorkspaces()', 'openWorkspace(']) assert.ok(a.includes(bit), bit)
  assert.ok(ui('common.js').includes('workspacesOn: false'))
})

test('no em dashes', () => { for (const f of ['workspaces.js', 'home.js', 'app.js', 'app.css']) assert.ok(!ui(f).includes(EM_DASH), f) })

test('the session view no longer calls itself a workspace in code', () => {
  assert.ok(!ui('session.js').includes('state.ws.'), 'the session view no longer calls itself a workspace')
  assert.ok(!ui('app.css').includes('.ws-tab'))
})
