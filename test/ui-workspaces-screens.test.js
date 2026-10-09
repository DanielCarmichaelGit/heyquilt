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
  for (const bit of ['All workspaces', 'data-ws-back', 'class="ws-head"', 'class="sc-grid"', 'data-rejoin=', 'data-go=', 'data-new-session-in=', 'New session', 'People &amp; agents', '<div class="pc$' + '{admin && !isOwner ? \' has-x\' : \'\'}">', 'data-member-access=', 'data-member-remove=', 'Invite a person or add an agent', 'data-ws-settings', 'Delete workspace', "'/update'", "'/delete'", "'/members/remove'"]) assert.ok(w.includes(bit), bit)
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

test('the session view keeps main\'s names: workspace screens use other ws- names, so sessions are unchanged', () => {
  assert.ok(ui('session.js').includes('state.ws.') && ui('session.js').includes('<div class="ws-content" id="main">'))
  for (const name of ['.ws-body', '.ws-tree', '.ws-main', '.ws-chat', '.ws-content', '.ws-tabs', '.ws-top']) assert.ok(ui('app.css').includes(name), name)
  assert.ok(!/\bsv-(body|tree|main|chat|content|tabs|top)\b/.test(ui('session.js') + ui('app.css')), 'no second set of session names')
})

test('the settings dialog focuses its name field so Escape closes it, and people cards keep access beside the name', () => {
  assert.ok(ui('workspaces.js').includes("form.querySelector('#wss-name').focus()"))
  const css = ui('app.css')
  assert.ok(css.includes('.pc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));'))
  assert.ok(css.includes('.pc { position: relative; display: grid; grid-template-columns: 40px minmax(0, 1fr) auto;'))
  assert.ok(css.includes('.pc .t { min-width: 0;'))
  assert.ok(css.includes('.pc .ws-scope { grid-column: 1 / -1;'), 'an agent\'s second line runs across the card')
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

test('Settings › Agents with workspaces on: a card per agent with Works in, the chosen workspaces and Invited to new sessions', () => {
  const chosen = place.agentRow(AGENTS[0], { reach: 'workspaces', workspaceIds: ['w2'], sessions: 'all', access: 'edit', scopes: [] }, MINE)
  for (const bit of ['class="ag-card" data-agent-place="a1"', 'data-placement-reach', 'data-placement-sessions', 'data-placement-ws', 'Works in', 'Invited to new sessions', '>All<', 'Chosen', 'Where added', 'Every session', 'Not automatically']) assert.ok(chosen.includes(bit), bit)
  assert.ok(chosen.includes('data-v="workspaces" aria-checked="true" class="on"'))
  assert.ok(chosen.includes('data-v="all" aria-checked="true" class="on"'), 'invited to every session')
  assert.ok(chosen.includes('value="w2" aria-pressed="true"') && chosen.includes('value="w1" aria-pressed="false"'), 'a chip per workspace, pressed when chosen')
  assert.ok(chosen.includes('data-ag-global hidden'), 'not global')
  assert.ok(chosen.includes('&lt;agent&gt;') && !chosen.includes('<agent>'), 'names are escaped')
  // Global: the badge shows, and the line under Works in says what it means.
  const global = place.agentRow(AGENTS[0], { reach: 'all', workspaceIds: [], sessions: 'all' }, MINE)
  assert.ok(global.includes('data-ag-global title') && global.includes('Global</span>'))
  assert.ok(global.includes(place.REACH_HINTS.all))
  // Only where added: whether it is invited is set per workspace, so its choice is off.
  const manual = place.agentRow(AGENTS[1], { reach: 'manual', workspaceIds: [], sessions: 'invited', access: 'edit', scopes: [] }, MINE)
  assert.ok(manual.includes('data-placement-sessions aria-label="Whether Editor is invited to new sessions" aria-disabled="true"'))
  assert.ok(manual.includes('Set on each workspace it is added to.'))
  assert.ok(place.agentRow(AGENTS[1], { reach: 'workspaces', workspaceIds: [], sessions: 'invited' }, []).includes('Make a workspace first.'))
  // Only your own personal workspaces can be chosen.
  assert.deepEqual(place.placeableWorkspaces([{ id: 'p', space: { kind: 'personal' }, via: 'owner' }, { id: 'm', space: { kind: 'personal' }, via: 'member' }, { id: 'o', space: { kind: 'org', slug: 'acme' }, via: 'org' }]).map((w) => w.id), ['p'])
})

test('a placement saves with its access and folder limits, and only workspaces you can choose', () => {
  const saved = { reach: 'manual', workspaceIds: [], sessions: 'invited', access: 'view', scopes: ['docs'] }
  assert.deepEqual(place.placementBody(saved, { reach: 'workspaces', sessions: 'all', workspaceIds: ['w1', 'gone'] }, MINE), { reach: 'workspaces', sessions: 'all', access: 'view', scopes: ['docs'], workspaceIds: ['w1'] })
  assert.deepEqual(place.placementBody(saved, { reach: 'all', sessions: 'all', workspaceIds: ['w1'] }, MINE).workspaceIds, [])
})

test('workspace agent cards: why it is here, Invite to new sessions for admins, and the right action for each kind', () => {
  const member = { account: 'agent:m', agentId: 'm', name: 'Editor', provider: 'xAI', via: 'member', access: 'edit', sessions: 'invited', managedBy: 'workspace', excluded: false }
  const global = { account: 'agent:g', agentId: 'g', name: 'Marketing', provider: 'Anthropic', via: 'global', access: 'edit', sessions: 'all', managedBy: 'owner', excluded: false }
  const placed = { ...global, account: 'agent:p', agentId: 'p', name: 'Reviewer', via: 'placed', access: 'view' }
  const fromOrg = { ...global, managedBy: 'org' }
  const out = { ...placed, excluded: true }

  const m = place.workspaceAgentCardHtml(member, { admin: true })
  for (const bit of ['>This workspace</span>', 'data-agent-joins="m"', 'title="Invite to new sessions"', '<option value="invited" selected>Not invited automatically</option>', 'data-member-access="agent:m"', 'data-member-remove="agent:m"']) assert.ok(m.includes(bit), bit)
  assert.ok(!m.includes('data-agent-exclude'))

  const g = place.workspaceAgentCardHtml(global, { admin: true })
  for (const bit of ['Global</span>', 'pill ws-via violet" title="In every workspace its owner has.', 'data-agent-joins="g"', '<option value="all" selected>Invited to new sessions</option>', 'data-agent-exclude="g"', 'title="Not in this workspace"', '<span class="pill">Can edit</span>']) assert.ok(g.includes(bit), bit)
  assert.ok(!g.includes('data-member-access'), 'a placed agent\'s access is set where it was placed')
  assert.ok(place.workspaceAgentCardHtml(placed, { admin: true }).includes('>Placed</span>'))
  assert.ok(place.workspaceAgentCardHtml(fromOrg, { admin: true, orgName: 'Acme' }).includes('>Added by Acme</span>'))

  const viewer = place.workspaceAgentCardHtml(global, { admin: false })
  assert.ok(viewer.includes('<span>Invited to new sessions</span>'))
  assert.ok(place.workspaceAgentCardHtml(member, { admin: false }).includes('<span>Not invited automatically</span>'))
  for (const bit of ['data-agent-joins', 'data-agent-exclude', 'data-member-access', 'data-member-remove']) assert.ok(!viewer.includes(bit), bit)

  const o = place.workspaceAgentCardHtml(out, { admin: true })
  assert.ok(o.includes('class="pc agent out"') && o.includes('<span>Not in this workspace</span>') && o.includes('data-agent-include="p"'))
  assert.ok(!o.includes('data-agent-joins'))

  // Someone else's agent added here: an admin sets its access and removes it, but cannot have
  // it invited to every session (only its owner can), and the card says so instead of offering it.
  const foreign = { ...member, account: 'agent:f', agentId: 'f', name: 'Visitor', foreign: true }
  const f = place.workspaceAgentCardHtml(foreign, { admin: true })
  for (const bit of ['data-member-access="agent:f"', 'data-member-remove="agent:f"', '<span title="Only its owner can have an agent invited to every session.">Not invited automatically</span>']) assert.ok(f.includes(bit), bit)
  assert.ok(!f.includes('data-agent-joins'), 'no choice the API would refuse')
})

test('the workspace page lists agents from the API\'s agents, with their cards wired', () => {
  const w = ui('workspaces.js')
  assert.ok(w.includes("import { workspaceAgentCardHtml } from './agent-place.js'"))
  for (const bit of ['const agents = d.agents || []', 'agents.map((a) => workspaceAgentCardHtml(a, { admin, orgName }))', '<span class="count">$' + '{people.length + agents.length}</span>', '[data-agent-joins]', '[data-agent-exclude]', '[data-agent-include]', '{ excluded: true }', "'/remove'", '{ account: a.account, access: a.access, sessions: sel.value }']) assert.ok(w.includes(bit), bit)
})

test('the Add dialog: agents of the workspace\'s owner, the every-session switch, and Invite a new agent (the kinds menu)', () => {
  const h = ui('home.js')
  const dlg = h.slice(h.indexOf('function workspaceInviteDialog'), h.indexOf('/** The GitHub side'))
  for (const bit of ['Also invite to every new session in this workspace', 'Invite a new agent', 'openKindMenu(invite, {', 'workspaceId: id,', "workspaceBody: () => ({ access: $('#wi-access', back).value, sessions: joins() })", "agentInviteHtml(text, 'wi-paste', kindLineHtml(kind, where))", 'data-wi-invite-agent', '/api/orgs/$' + '{encodeURIComponent(org.slug)}/agents', "api('GET', '/api/agents')", '/agent-invites`', "account.startsWith('agent:') ? { sessions: ownAgents.has(account) || !ownKnown ? joins() : 'invited' } : {}", "agentInviteHtml(agentPaste({ link, invitedToSessions: joins() === 'all' }), 'wi-paste')"]) assert.ok(dlg.includes(bit), bit)
})

test('agent-place.js is served, and has no em dashes', () => {
  assert.ok(!ui('agent-place.js').includes(EM_DASH))
})

test('a card follows its choices, saves each change, and goes back when a save fails', async () => {
  const toastEl = { textContent: '', classList: { add () {}, remove () {} } }
  globalThis.document = { querySelector: (sel) => (sel === '#toast' ? toastEl : null), querySelectorAll: () => [], addEventListener () {} }
  const was = globalThis.fetch
  const sent = []
  let fail = false
  globalThis.fetch = async (url, opts) => {
    sent.push(JSON.parse(opts.body))
    return fail ? { ok: false, status: 400, json: async () => ({ error: 'Quilt said no.' }) } : { ok: true, status: 200, json: async () => ({ placement: JSON.parse(opts.body) }) }
  }
  try {
    const mk = (list) => list.map(([v]) => ({ dataset: { v }, disabled: false, on: false, attrs: {}, classList: { toggle: function (c, on) { this.self.on = on } }, setAttribute (k, v2) { this.attrs[k] = v2 } }))
    const reachBs = mk(place.REACH_OPTIONS)
    const joinBs = mk(place.JOINS_OPTIONS)
    for (const b of [...reachBs, ...joinBs]) b.classList.self = b
    const group = (bs) => ({ attrs: {}, querySelectorAll: () => bs, setAttribute (k, v) { this.attrs[k] = v }, removeAttribute (k) { delete this.attrs[k] } })
    const reach = group(reachBs)
    const joins = group(joinBs)
    const badge = { hidden: true }
    const detail = { innerHTML: '' }
    const joinsWhy = { textContent: '' }
    const parts = { '[data-placement-reach]': reach, '[data-placement-sessions]': joins, '[data-ag-global]': badge, '[data-ag-detail]': detail, '[data-ag-joins-why]': joinsWhy }
    let onClick
    const el = { querySelector: (sel) => parts[sel], addEventListener: (type, fn) => { onClick = fn } }
    place.bindPlacement(el, AGENTS[0], { reach: 'manual', workspaceIds: [], sessions: 'invited', access: 'view', scopes: ['docs'] }, MINE)
    const click = (target) => onClick({ target: { closest: (sel) => (sel === '[data-placement-reach] [data-v]' && reachBs.includes(target)) || (sel === '[data-placement-sessions] [data-v]' && joinBs.includes(target)) ? target : null } })
    // All workspaces: global, saved with its access and folders as they were.
    await click(reachBs.find((b) => b.dataset.v === 'all'))
    assert.deepEqual(sent.at(-1), { reach: 'all', sessions: 'invited', access: 'view', scopes: ['docs'], workspaceIds: [] })
    assert.equal(badge.hidden, false, 'the Global badge shows')
    assert.ok(detail.innerHTML.includes(place.REACH_HINTS.all))
    assert.equal(joins.attrs['aria-disabled'], undefined, 'Joins can be chosen again')
    // A failed save: the card goes back to what was saved.
    fail = true
    await click(reachBs.find((b) => b.dataset.v === 'manual'))
    assert.equal(toastEl.textContent, 'Quilt said no.')
    assert.equal(badge.hidden, false, 'still global')
    assert.deepEqual(reachBs.map((b) => b.on), [true, false, false], 'All workspaces is lit again')
  } finally { globalThis.fetch = was; delete globalThis.document }
})

test('a session\'s People: the agents its workspace invites, where each stands, Don\'t invite and Invite, only with workspaces on', () => {
  assert.equal(place.sessionAgentsHtml([]), '')
  const st = { members: [{ key: 'agent:in1', name: 'Inez' }], waiting: [{ key: 'agent:w1', name: 'Wade' }] }
  const html = place.sessionAgentsHtml([
    { agentId: 'g1', name: 'Gale <bot>', via: 'global', managedBy: 'owner', excluded: false },
    { agentId: 'w1', name: 'Wade', via: 'member', managedBy: 'workspace', excluded: false },
    { agentId: 'in1', name: 'Inez', via: 'placed', managedBy: 'owner', excluded: false },
    { agentId: 'k1', name: 'Kurt', via: 'global', managedBy: 'org', excluded: true }
  ], st)
  for (const bit of ['Invited from the workspace', 'Gale &lt;bot&gt;', '<small>Global · Invited</small>', 'data-agent-uninvite="g1"', '<small>This workspace · Waiting for you to let it in</small>', 'data-agent-uninvite="w1"', '<small>Placed · In this session</small>', 'class="pm-member pm-inv out"', '<small>Added by the org · Not invited</small>', 'data-agent-invite="k1"', '>Invite</button>', ">Don't invite</button>"]) assert.ok(html.includes(bit), bit)
  assert.ok(!html.includes('data-agent-uninvite="in1"'), 'an agent already in is managed under Who can get in')
  assert.ok(!html.includes('<bot>'))
  const s = ui('session.js')
  assert.ok(s.includes('if (sum().status.access?.owner) { loadGrants(); if (state.workspacesOn) loadSessionAgents() }'))
  assert.ok(s.includes("if (state.workspacesOn && f.dataset.key.startsWith('agent:')) loadSessionAgents()"))
  assert.ok(s.includes('if (state.workspacesOn && sum()?.workspace && sum().status.access?.owner)'))
  // With nothing listed (always, with workspaces off) the owner's section ends exactly as before.
  assert.ok(s.includes('    $' + "{wsAgents.id === current ? sessionAgentsHtml(wsAgents.agents, st) : ''}<div class=\"pm-foot\">"))
  for (const bit of ['`/api/sessions/$' + '{id}/agents`', 'agents/$' + "{invite ? 'include' : 'exclude'}"]) assert.ok(s.includes(bit), bit)
  assert.ok(!s.includes('keptOut'), 'the kept-out block is gone')
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
  for (const bit of ['.modal-back.top { align-items: start; }', '#wi-people .tag.bot { margin-left: 6px; }', '.pc .btn.pc-x { position: absolute;', '.pc.has-x { padding-right: 44px; }', '.ag-detail {']) assert.ok(css.includes(bit), bit)
  assert.ok(!css.includes('.modal-back {') || css.includes('.modal-back { position: fixed; inset: 0; background: rgba(43, 42, 56, .4); backdrop-filter: blur(2px); display: grid; place-items: center;'), 'other dialogs stay centred')
  assert.ok(ui('workspaces.js').includes('class="btn sm ghost icon pc-x" data-member-remove='))
})
