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
  for (const bit of ['class="ws-card"', 'data-open-ws=', 'class="ws-cover', 'ws-space', 'session', 'files', 'class="ws-card add"', 'Add workspace', 'data-add-ws', 'name="name"', 'name="org"', 'Create', "api('POST', '/api/workspaces'"]) assert.ok(w.includes(bit), bit)
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
  assert.ok(!ui('session.js').includes('ws-content') && !ui('app.css').includes('.ws-content'), 'ws- is the workspaces screens\' prefix')
  assert.ok(ui('session.js').includes('<div class="sv-content" id="main">') && ui('app.css').includes('.sv-content {'))
})

test('the settings dialog focuses its name field so Escape closes it, and people cards wrap instead of squeezing the name', () => {
  assert.ok(ui('workspaces.js').includes("form.querySelector('#wss-name').focus()"))
  const css = ui('app.css')
  assert.ok(css.includes('.pc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));'))
  assert.ok(css.includes('.pc { display: flex; flex-wrap: wrap;'))
  assert.ok(css.includes('.pc .t { flex: 1 1 110px; min-width: 0;'))
})

test('the add form asks only for a name and where; colour and about live in settings', () => {
  const w = ui('workspaces.js')
  const add = w.slice(w.indexOf('function addFormHtml'), w.indexOf('function looseRows'))
  for (const bit of ['Colour', 'About', 'name="color"', 'name="description"']) assert.ok(!add.includes(bit), bit)
  assert.ok(w.includes("const body = { name: f.get('name'), org: f.get('org') || undefined }"))
  const settings = w.slice(w.indexOf('function settingsDialog'))
  for (const bit of ['name="color"', 'name="description"']) assert.ok(settings.includes(bit), bit)
})

test('the add form keeps the add card\'s height, so opening it does not move the grid', () => {
  const css = ui('app.css')
  assert.ok(css.includes('.ws-card.form { min-height: 230px; }'))
  assert.ok(css.includes('.ws-card.form .actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: auto;'))
})

test('the space filter shows only when the person is in an org (more than All and Personal)', () => {
  assert.ok(ui('workspaces.js').includes('spaces().size > 2 ? `<div class="segmented ws-filter"'))
})

