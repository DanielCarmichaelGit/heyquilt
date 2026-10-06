// test/ui-workspaces-screens.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const ui = (f) => fs.readFileSync(new URL(`../src/ui/${f}`, import.meta.url), 'utf8')
const EM_DASH = String.fromCharCode(0x2014)

// agent-place.js draws Settings › Agents rows and workspace agent cards. Its imports touch the
// page (common.js reads the address and listens for errors), so a little of it is stood in here.
globalThis.location ??= { search: '' }
globalThis.window ??= { addEventListener () {} }
globalThis.history ??= { replaceState () {} }
const place = await import('../src/ui/agent-place.js')
const { I, esc, ago } = await import('../src/ui/common.js')

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
  for (const bit of ['All workspaces', 'data-ws-back', 'class="ws-head"', 'class="sc-grid"', 'data-rejoin=', 'data-go=', 'data-new-session-in=', 'New session', 'People &amp; agents', '<div class="pc$' + '{admin && !isOwner ? \' has-x\' : \'\'}">', 'data-member-access=', 'data-member-remove=', 'Add a person or an agent', 'data-ws-settings', 'Delete workspace', "'/update'", "'/delete'", "'/members/remove'"]) assert.ok(w.includes(bit), bit)
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

test('the sidebar lists workspaces and marks the open one', () => {
  const h = ui('home.js')
  for (const bit of ['function sideWorkspacesHtml (view)', '<div class="side-label">Workspaces</div>', 'class="side-nav side-workspaces"', "data-view=\"ws:${esc(w.id)}\"", "view === `ws:${w.id}` ? 'on' : ''"]) assert.ok(h.includes(bit), bit)
  assert.ok(h.includes('${sideWorkspacesHtml(view)}'))
})

test('Settings sits at the bottom of the sidebar under a rule; Shut down lives in Settings and the session menu, not the sidebar', () => {
  const h = ui('home.js')
  assert.ok(h.includes('<nav class="side-nav side-foot" aria-label="App">'))
  assert.ok(h.indexOf('data-view="settings" class="${view') > h.indexOf('${sideWorkspacesHtml(view)}'))
  assert.ok(ui('app.css').includes('.side-foot { margin-top: auto; display: flex; flex-direction: column; gap: 2px; padding-top: 10px; border-top: 1px solid var(--border); }'))
  const side = h.slice(h.indexOf('function sidebarHtml'), h.indexOf('function sideWorkspacesHtml'))
  assert.ok(!side.includes('data-shutdown'))
  assert.ok(h.includes('data-shutdown>${I.power}<span>Shut down Quilt</span>'), 'still in Settings')
})


test('the settings dialog shows the workspace\'s storage: used of quota and how many files', () => {
  const w = ui('workspaces.js')
  const dialog = w.slice(w.indexOf('function settingsDialog'))
  assert.ok(/import \{[^}]*\bbytes\b[^}]*\} from '\.\/common\.js'/.test(w), 'bytes() from common.js')
  assert.ok(dialog.includes('${usageLine(state.workspace.usage)}'), 'under the fields')
  const line = w.slice(w.indexOf('function usageLine'), w.indexOf('function settingsDialog'))
  for (const bit of ['bytes(u.usedBytes || 0)', 'bytes(u.quotaBytes)', ' used · ', "'file' : 'files'", 'data-ws-usage']) assert.ok(line.includes(bit), bit)
})

// ------------------------------------------------------------ where agents work --

// Settings › Agents' row as main draws it, to hold the flag-off row to.
function mainAgentRow (a) {
  const signedOut = a.status === 'reused' || a.status === 'expired'
  const state = signedOut ? '<span class="pill warn">signed out</span>' : a.canJoinSessions ? '' : '<span class="pill">registered only</span>'
  const when = a.lastUsedAt ? `last used ${ago(a.lastUsedAt)}` : `added ${ago(a.createdAt)}`
  return `<div class="kv agent-row"><span>${I.bot}</span><b>${esc(a.name)} ${state}</b><span class="hint">${esc(a.provider)} · ${esc(a.type)} · ${when}</span></div>`
}
const AGENTS = [
  { id: 'a1', name: 'Marketing <agent>', provider: 'Anthropic', type: 'coding agent', canJoinSessions: true, createdAt: Date.now() - 3600e3, lastUsedAt: Date.now() - 60e3 },
  { id: 'a2', name: 'Editor', provider: 'xAI', type: 'video agent', canJoinSessions: false, createdAt: Date.now() - 86400e3 },
  { id: 'a3', name: 'Reviewer', provider: 'OpenAI', type: 'review agent', canJoinSessions: true, status: 'expired', createdAt: Date.now() }
]
const MINE = [{ id: 'w1', name: 'Launch' }, { id: 'w2', name: 'Website' }]

test('Settings › Agents with workspaces off: every row is exactly as on main', () => {
  for (const a of AGENTS) assert.equal(place.agentRow(a), mainAgentRow(a), a.name)
  const h = ui('home.js')
  const bind = h.slice(h.indexOf('function bindAgents'), h.indexOf('/** Wires the settings cards'))
  assert.ok(bind.includes('const places = on ? await Promise.all('), 'placements load only with workspaces on')
  assert.ok(bind.includes(': []'))
  assert.ok(bind.includes('agents.map((a, i) => agentRow(a, places[i], mine))'))
  assert.ok(bind.includes('if (on) bindPlacements(list, agents, places, mine)'))
  assert.ok(!h.includes('function agentRow'), 'one agentRow, in agent-place.js')
})

test('Settings › Agents with workspaces on: Available in, the chosen workspaces and Joins, set from the placement', () => {
  const html = place.agentRow(AGENTS[0], { reach: 'workspaces', workspaceIds: ['w2'], sessions: 'all', access: 'edit', scopes: [] }, MINE)
  assert.ok(html.startsWith(mainAgentRow(AGENTS[0]).slice(0, -'</div>'.length)), 'the row as before, then the controls')
  for (const bit of ['data-agent-place="a1"', 'data-placement-reach', 'data-placement-sessions', 'data-placement-ws', 'Available in', 'Joins', 'Only where I add it', 'All my workspaces', 'Chosen workspaces', 'When invited', 'Every session']) assert.ok(html.includes(bit), bit)
  assert.ok(html.includes('<option value="workspaces" selected>Chosen workspaces</option>'))
  assert.ok(html.includes('<option value="all" selected>Every session</option>'))
  assert.ok(html.includes('value="w2" checked') && !html.includes('value="w1" checked'))
  assert.ok(html.includes('data-placement-picked title="Which workspaces">Website</summary>'))
  assert.ok(html.includes('&lt;agent&gt;') && !html.includes('<agent>'), 'names are escaped')
  // Not chosen: the picker keeps its place, hidden; Joins means nothing for an agent only added by hand.
  const manual = place.agentRow(AGENTS[1], { reach: 'manual', workspaceIds: [], sessions: 'invited', access: 'edit', scopes: [] }, MINE)
  // Not chosen: the picker gives its fixed slot to a line saying what the reach means.
  assert.ok(manual.includes('<details class="ap-pick" hidden>'))
  assert.ok(manual.includes('<span class="ap-why">Add it from a workspace&#39;s page</span>'))
  assert.ok(html.includes('<span class="ap-why" hidden>') && html.includes('<details class="ap-pick">'))
  for (const bit of ['class="input sm ap-reach"', 'class="input sm ap-joins"', 'class="ap-slot"']) assert.ok(html.includes(bit), bit)
  assert.ok(manual.includes('data-placement-sessions aria-label="When Editor joins sessions" disabled>'))
  assert.ok(place.agentRow(AGENTS[1], { reach: 'all', workspaceIds: [], sessions: 'invited' }, []).includes('No workspaces yet'))
  // Only your own personal workspaces can be chosen.
  assert.deepEqual(place.placeableWorkspaces([{ id: 'p', space: { kind: 'personal' }, via: 'owner' }, { id: 'm', space: { kind: 'personal' }, via: 'member' }, { id: 'o', space: { kind: 'org', slug: 'acme' }, via: 'org' }]).map((w) => w.id), ['p'])
})

test('a placement saves with its access and folder limits, and only workspaces you can choose', () => {
  const saved = { reach: 'manual', workspaceIds: [], sessions: 'invited', access: 'view', scopes: ['docs'] }
  assert.deepEqual(place.placementBody(saved, { reach: 'workspaces', sessions: 'all', workspaceIds: ['w1', 'gone'] }, MINE), { reach: 'workspaces', sessions: 'all', access: 'view', scopes: ['docs'], workspaceIds: ['w1'] })
  assert.deepEqual(place.placementBody(saved, { reach: 'all', sessions: 'all', workspaceIds: ['w1'] }, MINE).workspaceIds, [])
})

test('workspace agent cards: why it is here, Joins for admins, and the right action for each kind', () => {
  const member = { account: 'agent:m', agentId: 'm', name: 'Editor', provider: 'xAI', via: 'member', access: 'edit', sessions: 'invited', managedBy: 'workspace', excluded: false }
  const global = { account: 'agent:g', agentId: 'g', name: 'Marketing', provider: 'Anthropic', via: 'global', access: 'edit', sessions: 'all', managedBy: 'owner', excluded: false }
  const placed = { ...global, account: 'agent:p', agentId: 'p', name: 'Reviewer', via: 'placed', access: 'view' }
  const fromOrg = { ...global, managedBy: 'org' }
  const out = { ...placed, excluded: true }

  const m = place.workspaceAgentCardHtml(member, { admin: true })
  for (const bit of ['>This workspace</span>', 'data-agent-joins="m"', '<option value="invited" selected>When invited</option>', 'data-member-access="agent:m"', 'data-member-remove="agent:m"']) assert.ok(m.includes(bit), bit)
  assert.ok(!m.includes('data-agent-exclude'))

  const g = place.workspaceAgentCardHtml(global, { admin: true })
  for (const bit of ['pill ws-via violet">Global</span>', 'data-agent-joins="g"', '<option value="all" selected>Every session</option>', 'data-agent-exclude="g"', 'title="Not in this workspace"', '<span class="pill">Can edit</span>']) assert.ok(g.includes(bit), bit)
  assert.ok(!g.includes('data-member-access'), 'a placed agent\'s access is set where it was placed')
  assert.ok(place.workspaceAgentCardHtml(placed, { admin: true }).includes('>Placed</span>'))
  assert.ok(place.workspaceAgentCardHtml(fromOrg, { admin: true, orgName: 'Acme' }).includes('>Added by Acme</span>'))

  const viewer = place.workspaceAgentCardHtml(global, { admin: false })
  assert.ok(viewer.includes('<span>Joins every session</span>'))
  for (const bit of ['data-agent-joins', 'data-agent-exclude', 'data-member-access', 'data-member-remove']) assert.ok(!viewer.includes(bit), bit)

  const o = place.workspaceAgentCardHtml(out, { admin: true })
  assert.ok(o.includes('class="pc agent out"') && o.includes('<span>Not in this workspace</span>') && o.includes('data-agent-include="p"'))
  assert.ok(!o.includes('data-agent-joins'))

  // Someone else's agent added here: an admin sets its access and removes it, but cannot make
  // it join every session (only its owner can), and the card says so instead of offering it.
  const foreign = { ...member, account: 'agent:f', agentId: 'f', name: 'Visitor', foreign: true }
  const f = place.workspaceAgentCardHtml(foreign, { admin: true })
  for (const bit of ['data-member-access="agent:f"', 'data-member-remove="agent:f"', '<span title="Only its owner can make an agent join every session.">Joins when invited</span>']) assert.ok(f.includes(bit), bit)
  assert.ok(!f.includes('data-agent-joins'), 'no Joins choice the API would refuse')
})

test('the workspace page lists agents from the API\'s agents, with their cards wired', () => {
  const w = ui('workspaces.js')
  assert.ok(w.includes("import { workspaceAgentCardHtml } from './agent-place.js'"))
  for (const bit of ['const agents = d.agents || []', 'agents.map((a) => workspaceAgentCardHtml(a, { admin, orgName }))', '<span class="count">$' + '{people.length + agents.length}</span>', '[data-agent-joins]', '[data-agent-exclude]', '[data-agent-include]', '{ excluded: true }', "'/remove'", '{ account: a.account, access: a.access, sessions: sel.value }']) assert.ok(w.includes(bit), bit)
})

test('the Add dialog: agents of the workspace\'s owner, the every-session switch, and Invite a new agent', () => {
  const h = ui('home.js')
  const dlg = h.slice(h.indexOf('function workspaceInviteDialog'), h.indexOf('/** The GitHub side'))
  for (const bit of ['Also join every session in this workspace as it starts', 'Invite a new agent', 'data-wi-invite-agent', '/api/orgs/$' + '{encodeURIComponent(org.slug)}/agents', "api('GET', '/api/agents')", '/agent-invites`', "account.startsWith('agent:') ? { sessions: ownAgents.has(account) || !ownKnown ? joins() : 'invited' } : {}", "agentInviteHtml(agentPaste({ link }), 'wi-paste')"]) assert.ok(dlg.includes(bit), bit)
})

test('agent-place.js is served, and has no em dashes', () => {
  assert.ok(!ui('agent-place.js').includes(EM_DASH))
})

// A select the app has turned into a dropdown button (common.js): the button shows the chosen option.
function fakeSelect (opts, value) {
  const label = { textContent: opts.find(([v]) => v === value)[1] }
  const btn = { classList: { contains: (c) => c === 'dd-btn' }, querySelector: () => label, disabled: false, label }
  return {
    value,
    disabled: false,
    dataset: { dd: '1' },
    nextElementSibling: btn,
    get options () { return opts.map(([v, t]) => ({ value: v, textContent: t })) },
    get selectedIndex () { return opts.findIndex(([v]) => v === this.value) }
  }
}

test('a placement that fails to save puts the controls back, dropdown buttons included', async () => {
  const toastEl = { textContent: '', classList: { add () {}, remove () {} } }
  globalThis.document = { querySelector: (sel) => (sel === '#toast' ? toastEl : null), querySelectorAll: () => [], addEventListener () {} }
  const was = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'Quilt said no.' }) })
  try {
    const reach = fakeSelect(place.REACH_OPTIONS, 'manual')
    const sessions = fakeSelect(place.JOINS_OPTIONS, 'invited')
    const pick = { hidden: true, open: false }
    const why = { hidden: false, textContent: '' }
    const picked = { textContent: '' }
    const parts = { '[data-placement-reach]': reach, '[data-placement-sessions]': sessions, '.ap-pick': pick, '.ap-why': why, '[data-placement-picked]': picked }
    const el = { querySelector: (sel) => parts[sel], querySelectorAll: () => [] }
    place.bindPlacement(el, AGENTS[0], { reach: 'manual', workspaceIds: [], sessions: 'invited', access: 'edit', scopes: [] }, MINE)
    // The person picks Chosen workspaces: the dropdown already shows it, then the save fails.
    reach.value = 'workspaces'
    reach.nextElementSibling.label.textContent = 'Chosen workspaces'
    await reach.onchange()
    assert.equal(toastEl.textContent, 'Quilt said no.')
    assert.equal(reach.value, 'manual')
    assert.equal(reach.nextElementSibling.label.textContent, 'Only where I add it', 'the button is redrawn, not left saying Chosen workspaces')
    assert.equal(sessions.nextElementSibling.label.textContent, 'When invited')
    assert.deepEqual([pick.hidden, why.hidden, why.textContent, sessions.disabled], [true, false, place.REACH_HINTS.manual, true])
  } finally { globalThis.fetch = was; delete globalThis.document }
})

test('a session\'s people menu: agents kept out of it, each with Let back in, only with workspaces on', () => {
  assert.equal(place.keptOutHtml([]), '')
  const html = place.keptOutHtml([{ agentId: 'k1', name: 'Kip <bot>' }])
  for (const bit of ['Kept out of this session', 'Kip &lt;bot&gt; (agent)', 'data-let-in="k1"', 'Let back in', 'class="pm-member"']) assert.ok(html.includes(bit), bit)
  const s = ui('session.js')
  assert.ok(s.includes('if (sum().status.access?.owner) { loadGrants(); if (state.workspacesOn) loadKeptOut() }'))
  // The removal answers once the keep-out is written (or given up on), so the list is read then, not on a timer.
  assert.ok(!s.includes('setTimeout(loadKeptOut'))
  assert.ok(s.includes("if (state.workspacesOn && f.dataset.key.startsWith('agent:')) loadKeptOut()"))
  assert.ok(s.includes('if (state.workspacesOn && sum()?.workspace && sum().status.access?.owner)'))
  // With nothing kept out (always, with workspaces off) the owner's section ends exactly as before.
  assert.ok(s.includes('    $' + "{keptOut.id === current ? keptOutHtml(keptOut.agents) : ''}<div class=\"pm-foot\">"))
  assert.ok(s.includes('/agents/include') && s.includes('/agents/excluded'))
})

test('the Add dialog: anchored at the top, a gap before the agent tag, and a hint when an org\'s agents can\'t be listed', () => {
  const h = ui('home.js')
  const dlg = h.slice(h.indexOf('function workspaceInviteDialog'), h.indexOf('/** The GitHub side'))
  assert.ok(dlg.includes("back.classList.add('top')"))
  assert.ok(dlg.includes("const agents = !isOrg\n    ? api('GET', '/api/agents')"), 'your own agents only in a personal workspace')
  assert.ok(dlg.includes("agents can't be listed here."))
  assert.ok(dlg.includes("agents can't be listed: $" + '{err.message}'))
  assert.ok(dlg.includes("people.filter((c) => c.kind !== 'agent' || !isOrg)"))
  const css = ui('app.css')
  for (const bit of ['.modal-back.top { align-items: start; }', '#wi-people .tag.bot { margin-left: 6px; }', '.pc .btn.pc-x { position: absolute;', '.pc.has-x { position: relative; }', '.ap-slot {']) assert.ok(css.includes(bit), bit)
  assert.ok(!css.includes('.modal-back {') || css.includes('.modal-back { position: fixed; inset: 0; background: rgba(43, 42, 56, .4); backdrop-filter: blur(2px); display: grid; place-items: center;'), 'other dialogs stay centred')
  assert.ok(ui('workspaces.js').includes('class="btn sm ghost icon pc-x" data-member-remove='))
})
