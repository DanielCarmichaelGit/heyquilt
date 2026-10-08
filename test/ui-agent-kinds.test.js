// test/ui-agent-kinds.test.js
// Invite an agent with workspaces on: a small menu of the three kinds (global, workspace,
// session agent), where it goes, and the invite each makes. With workspaces off, every Invite
// an agent button does exactly what it did before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const ui = (f) => fs.readFileSync(new URL(`../src/ui/${f}`, import.meta.url), 'utf8')
const EM_DASH = String.fromCharCode(0x2014)

globalThis.location ??= { search: '' }
globalThis.window ??= { addEventListener () {} }
globalThis.history ??= { replaceState () {} }
const kinds = await import('../src/ui/agent-kinds.js')
const { state } = await import('../src/ui/common.js')

test('the menu: three kinds with a line each, and How agent kinds work opening the docs in the browser', () => {
  const html = kinds.kindMenuHtml()
  for (const bit of [
    'data-kind="global"', '<b>Global agent</b><span>In all your workspaces, invited to their sessions</span>',
    'data-kind="workspace"', '<b>Workspace agent</b><span>In one workspace, invited to its sessions</span>',
    'data-kind="session"', '<b>Session agent</b><span>Invited to one session</span>',
    'href="https://heyquilt.com/docs/agent-kinds" target="_blank" rel="noopener">How agent kinds work'
  ]) assert.ok(html.includes(bit), bit)
  assert.equal(html.match(/role="menuitem"/g).length, 4, 'every choice is a menu item, the docs link too')
  assert.ok(!html.includes(EM_DASH))
})

test('where it goes: the current one first and marked, names escaped, and a line when there is nowhere', () => {
  const html = kinds.pickHtml('workspace', [{ id: 'w1', name: 'Alpha', color: '#fff' }, { id: 'w2', name: 'Be<ta>', color: '#000', current: true }])
  assert.ok(html.indexOf('data-pick="w2"') < html.indexOf('data-pick="w1"'), 'the current workspace first')
  for (const bit of ['data-km-back', '<b>Workspace agent</b>', 'Which workspace', 'Be&lt;ta&gt;', '<span class="hint">This workspace</span>']) assert.ok(html.includes(bit), bit)
  assert.ok(!html.includes('<ta>'))
  assert.ok(kinds.pickHtml('session', []).includes('No session is running.'))
  assert.ok(kinds.pickHtml('workspace', []).includes('No workspace you can invite an agent to yet.'))
  assert.ok(kinds.pickHtml('session', [{ id: 's', name: 'web', color: 'var(--ok)', current: true }]).includes('This session'))
})

test('only your own workspaces and org ones you admin (not archived) take a workspace agent; only sessions with a link take a session agent', () => {
  const list = [
    { id: 'mine', admin: true, via: 'owner', space: { kind: 'personal' } },
    { id: 'theirs', admin: false, via: 'member', space: { kind: 'personal' } },
    { id: 'org', admin: true, via: 'org', space: { kind: 'org' } },
    { id: 'org-view', admin: false, via: 'org', space: { kind: 'org' } },
    { id: 'old', admin: true, via: 'owner', space: { kind: 'personal' }, archivedAt: 1 }
  ]
  assert.deepEqual(kinds.invitableWorkspaces(list).map((w) => w.id), ['mine', 'org'])
  assert.deepEqual(kinds.invitableSessions([{ id: 'a', invite: 'https://join.heyquilt.com/r#s' }, { id: 'b' }]).map((s) => s.id), ['a'])
})

test('the line above the paste text says which kind it made, and where', () => {
  assert.ok(kinds.kindLineHtml('global').includes('Global agent</span>In all your workspaces, invited to their sessions.'))
  assert.ok(kinds.kindLineHtml('workspace', 'Launch <x>').includes('Workspace agent</span>In Launch &lt;x&gt;, invited to its sessions.'))
  assert.ok(kinds.kindLineHtml('session', 'web').includes('Session agent</span>Invited to web.'))
})

test('each kind makes its own invite: global, the workspace\'s (with its access and sessions), a session\'s with its link', async () => {
  const was = globalThis.fetch
  const sent = []
  globalThis.fetch = async (url, opts) => {
    sent.push([opts.method, url, opts.body ? JSON.parse(opts.body) : undefined])
    return { ok: true, status: 200, json: async () => ({ link: 'https://api.quilt.test/v1/join/qj_x' }) }
  }
  try {
    state.workspaces = [{ id: 'w1', name: 'Launch' }]
    state.sessions = new Map([['s1', { id: 's1', dir: '/x/web', invite: 'https://join.heyquilt.com/r1#k', status: { sessionName: 'Web' } }]])
    const g = await kinds.makeAgentInvite('global')
    assert.deepEqual(sent.at(-1), ['POST', '/api/agent-invites', { global: true }])
    assert.ok(g.text.includes('quilt agent join https://api.quilt.test/v1/join/qj_x'))
    const w = await kinds.makeAgentInvite('workspace', 'w1')
    assert.deepEqual(sent.at(-1), ['POST', '/api/workspaces/w1/agent-invites', { access: 'edit', sessions: 'all' }])
    assert.equal(w.where, 'Launch')
    await kinds.makeAgentInvite('workspace', 'w1', () => ({ access: 'view', sessions: 'invited' }))
    assert.deepEqual(sent.at(-1)[2], { access: 'view', sessions: 'invited' }, 'the Add dialog\'s choices')
    const s = await kinds.makeAgentInvite('session', 's1')
    assert.deepEqual(sent.at(-1), ['POST', '/api/agent-invites', undefined], 'a plain invite, as today')
    assert.ok(s.text.includes('join my session with this session invite link: https://join.heyquilt.com/r1#k'), 'the session kind carries its link')
    assert.equal(s.where, 'Web')
    await assert.rejects(kinds.makeAgentInvite('session', 'gone'), /not running/)
  } finally { globalThis.fetch = was; state.workspaces = []; state.sessions = new Map() }
})

test('with workspaces off, every Invite an agent button does exactly what it did', () => {
  const home = ui('home.js')
  const app = ui('app.js')
  // Settings › Agents: the menu only behind the flag; the old one-click invite right after it.
  const bind = home.slice(home.indexOf('function bindAgents'), home.indexOf('/** Wires the settings cards'))
  assert.ok(bind.includes('if (state.workspacesOn) {\n      return openKindMenu(btn, {'))
  assert.ok(bind.indexOf('openKindMenu(btn') < bind.indexOf("const inv = await api('POST', '/api/agent-invites')"))
  assert.ok(bind.includes("$('#agents-invite', root).innerHTML = agentInviteHtml(agentPaste({ link: inv.link }), 'agents-paste')"), 'flag off: as before')
  assert.ok(home.includes('<button class="btn primary" type="button" id="agents-make">$' + '{I.bot}<span>Invite an agent</span></button></div>\n    </div>\n  </section>`}'), 'flag off: the same button, in Settings')
  assert.ok(home.includes('id="agents-make" aria-haspopup="menu" aria-expanded="false"'), 'flag on: on the Agents page, opening the menu')
  // A session's Invite dialog.
  const inv = app.slice(app.indexOf("$('#inv-agent-make', back).onclick"), app.indexOf("$('#inv-done', back).onclick"))
  assert.ok(inv.includes('if (state.workspacesOn) {\n      return openKindMenu(btn, {\n        sessionId: id,'))
  assert.ok(inv.includes("const inv = await api('POST', '/api/agent-invites')\n      $('#inv-agent', back).innerHTML = agentInviteHtml(agentPaste({ link: inv.link, session: s.invite }), 'inv-agent-text')"), 'flag off: as before')
  assert.ok(app.includes('id="inv-agent-make"$' + "{state.workspacesOn ? ' aria-haspopup=\"menu\" aria-expanded=\"false\"' : ''}>"))
  // agentInviteHtml without a kind is exactly what it was.
  assert.ok(app.includes("export function agentInviteHtml (text, id, kind = '') {\n  return `$" + '{kind}<p class="hint"><b>Paste this into your AI.</b>'))
  // The local route only asks for a global agent with workspaces on.
  assert.ok(fs.readFileSync(new URL('../src/ui-server.js', import.meta.url), 'utf8').includes('createAgentInvite({ token, global: workspacesOn && b?.global === true })'))
})

test('the menu is a fixed popover at its button: no layout shift, closes on Escape or a click outside, arrow keys move', () => {
  const k = ui('agent-kinds.js')
  for (const bit of ["menu.className = 'popover kind-menu'", 'document.body.append(menu)', "e.key === 'Escape'", 'closeKindMenu(true)', "document.addEventListener('mousedown', outside", "'ArrowDown'", "btn.setAttribute('aria-expanded', 'true')"]) assert.ok(k.includes(bit), bit)
  const css = ui('app.css')
  assert.ok(css.includes('.popover.kind-menu { width: 340px; max-width: calc(100vw - 16px);'))
  assert.ok(css.includes('.popover { position: fixed;'), 'fixed to the window')
  assert.ok(!k.includes(EM_DASH))
  const served = fs.readFileSync(new URL('../src/ui-server.js', import.meta.url), 'utf8')
  assert.ok(served.includes("'/agent-kinds.js': ['agent-kinds.js', 'text/javascript; charset=utf-8']"))
})

test('with workspaces on: an Agents page in the sidebar, and Join a session instead of the Sessions menu', () => {
  const home = ui('home.js')
  const app = ui('app.js')
  assert.ok(home.includes("$" + "{state.workspacesOn ? `<button data-view=\"agents\""), 'Agents only with workspaces on')
  assert.ok(home.includes("view === 'agents' ? agentsPageHtml()") && home.includes("else if (view === 'agents') bindAgents($('#page'))"))
  assert.ok(home.includes('https://heyquilt.com/docs/agent-kinds'))
  assert.ok(app.includes("view !== 'agents' && !isWorkspace(view)"), 'the Agents view is not a session')
  // The Sessions menu is still there with workspaces off; with them on, one Join a session button.
  assert.ok(home.includes("? `<button class=\"btn primary full sessions-btn\" type=\"button\" data-join-session>$" + "{I.link}<span>Join a session</span></button>`\n    : `<div class=\"menu-wrap\" id=\"sessions-menu-wrap\">"))
  assert.ok(home.includes('if (btn && menu) {'), 'the menu binds only when it is there')
  // Settings points to the Agents page with workspaces on, and keeps its own section off.
  assert.ok(home.includes('data-view="agents">$' + '{I.bot}<span>Open Agents</span></button>'))
  assert.ok(home.includes("if ($('#agents-sec', root)) bindAgents(root)"))
})
