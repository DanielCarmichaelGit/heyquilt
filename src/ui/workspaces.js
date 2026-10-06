// Workspaces: the home grid of cards, the Add workspace card, and a workspace's page
// (Sessions, Files, People & agents, Settings). Sessions stay in session.js; the file library
// (the Files section, All files and uploads) is files.js.
import { I, state, $, esc, basename, toast, api, ask, avatar, colorFor, ago, bytes } from './common.js'
import { filesSectionHtml, bindFilesSection } from './files.js'
import { workspaceAgentCardHtml } from './agent-place.js'

export const COLORS = { lilac: '#d9c6ea', mint: '#cfe6d4', peach: '#f6dcc0', rose: '#f3d3d0', periwinkle: '#e0dcf0', sky: '#cfe0ee' }
const coverOf = (w) => COLORS[w.color] || COLORS.lilac
const initial = (name) => [...String(name || '?')][0].toUpperCase()
const spaceLabel = (w) => (w.space?.kind === 'org' ? w.space.name : 'Personal')
const spaceKey = (w) => (w.space?.kind === 'org' ? w.space.slug : 'personal')
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
const wsUrl = (id, rest = '') => `/api/workspaces/${encodeURIComponent(id)}${rest}`
const tildify = (p) => (state.defaults.home && String(p).startsWith(state.defaults.home) ? `~${String(p).slice(state.defaults.home.length)}` : p)

export async function loadWorkspaces () {
  try {
    const r = await api('GET', '/api/workspaces')
    state.workspacesOn = !!r.on
    state.workspaces = r.workspaces || []
  } catch (err) {
    if (err.signedOut) throw err
    state.workspacesOn = false
    state.workspaces = []
  }
  // Your orgs, so an org's first workspace can be made here too. Without them: Personal only.
  if (!state.workspacesOn) return
  try { state.orgs = (await api('GET', '/api/orgs')).orgs || [] } catch (err) {
    if (err.signedOut) throw err
    state.orgs = []
  }
}

/** The workspace id in a `ws:<id>` (its page) or `wsfiles:<id>` (All files) view. */
export const wsIdOf = (view) => String(view).replace(/^(ws|wsfiles):/, '')

export async function openWorkspace (id) {
  const d = await api('GET', wsUrl(id))
  // A slow answer for a workspace you've since left mustn't replace the one on screen.
  // Its files and usage come in the same answer.
  if (state.view === `ws:${id}` || state.view === `wsfiles:${id}`) state.workspace = d
}

// ------------------------------------------------------------------ grid --
function spaces () {
  const keys = new Map([['all', 'All'], ['personal', 'Personal']])
  for (const o of state.orgs || []) if (o.slug) keys.set(o.slug, o.name || o.slug)
  for (const w of state.workspaces || []) if (w.space?.kind === 'org' && w.space.slug) keys.set(w.space.slug, w.space.name)
  return keys
}

function cardHtml (w) {
  const live = w.counts?.open || 0
  return `
  <div class="ws-card" data-open-ws="${esc(w.id)}" role="button" tabindex="0" aria-label="Open ${esc(w.name)}">
    <div class="ws-cover" style="--c:${coverOf(w)}"><span class="ws-mark">${esc(initial(w.name))}</span>${live ? `<span class="pill ok ws-live"><span class="dot"></span>${live} open</span>` : ''}</div>
    <div class="ws-card-body">
      <h3>${esc(w.name)} <span class="pill ws-space${w.space?.kind === 'org' ? ' coral' : ''}">${esc(spaceLabel(w))}</span></h3>
      <p class="ws-desc">${esc(w.description || '')}</p>
      <div class="ws-stats"><span><b>${w.counts?.sessions ?? 0}</b> ${w.counts?.sessions === 1 ? 'session' : 'sessions'}</span><span><b>${w.counts?.files ?? 0}</b> ${w.counts?.files === 1 ? 'file' : 'files'}</span></div>
    </div>
    <div class="ws-foot"><span>${esc(plural((w.counts?.members ?? 0) + (w.space?.kind === 'personal' ? 1 : 0), 'member', 'members'))}</span><span class="spacer"></span><span>${w.archivedAt ? 'archived' : esc(ago(w.createdAt))}</span></div>
  </div>`
}

function addCardHtml () {
  return `
  <div class="ws-card add" data-add-ws role="button" tabindex="0">
    <span class="ws-plus">${I.plus}</span><b>Add workspace</b><span>Sessions, files and agents in one place</span>
  </div>`
}

function addFormHtml () {
  const orgs = [...spaces()].filter(([k]) => k !== 'all' && k !== 'personal')
  // Just a name and where it lives: colour and a description are set later, in the workspace's settings.
  return `
  <form class="ws-card form" data-add-ws-form>
    <div class="ws-cover" style="--c:${COLORS.lilac};height:36px"></div>
    <div class="ws-card-body">
      <label class="label" for="ws-name">Name</label><input class="input" id="ws-name" name="name" maxlength="80" required placeholder="Launch">
      ${orgs.length ? `<label class="label" for="ws-org">Where</label>
      <select class="input" id="ws-org" name="org"><option value="">Personal</option>${orgs.map(([slug, name]) => `<option value="${esc(slug)}">${esc(name)}</option>`).join('')}</select>` : ''}
      <p class="error" data-add-ws-error></p>
      <div class="actions"><button type="button" class="btn sm ghost" data-add-ws-cancel>Cancel</button><button class="btn sm primary" type="submit">Create</button></div>
    </div>
  </form>`
}

function looseRows () {
  const known = new Set((state.workspaces || []).map((w) => w.id))
  const loose = (ws) => !ws || !known.has(ws)
  const running = [...state.sessions.values()].filter((s) => loose(s.workspace)).map((s) => ({ live: true, id: s.id, dir: s.dir, peers: s.status.peers.length }))
  const recent = state.recent.filter((r) => loose(r.workspace) && !r.unsupported).map((r) => ({ live: false, dir: r.dir, lastUsed: r.lastUsed }))
  return [...running, ...recent]
}

export function workspacesHtml () {
  const filter = state.spaceFilter || 'all'
  const list = (state.workspaces || []).filter((w) => filter === 'all' || spaceKey(w) === filter)
  const loose = looseRows()
  return `
  <section class="workspaces">
    <div class="sec-head"><h2>Your workspaces</h2><span class="count">${list.length}</span><span class="spacer"></span>
      ${spaces().size > 2 ? `<div class="segmented ws-filter" role="tablist">${[...spaces()].map(([k, label]) => `<button type="button" role="tab" data-space-filter="${esc(k)}" class="${filter === k ? 'on' : ''}" aria-selected="${filter === k}">${esc(label)}</button>`).join('')}</div>` : ''}
    </div>
    <div class="ws-grid">${list.map(cardHtml).join('')}${state.addingWorkspace ? addFormHtml() : addCardHtml()}</div>
  </section>
  <section class="ws-loose">
    <div class="sec-head"><h2 class="ws-loose-h">Sessions not in a workspace</h2><span class="count">${loose.length}</span><span class="spacer"></span>
      <button class="btn sm ghost" data-join-session>${I.link}<span>Join with an invite</span></button>
      <button class="btn sm" data-new-session>${I.plus}<span>New session</span></button>
    </div>
    ${loose.length ? `<div class="ws-chips">${loose.map((r) => `
      <div class="ws-chip"><span class="folder-ico${r.live ? ' live' : ''}">${I.folder}</span>
        <span class="t"><b>${esc(basename(r.dir))}</b><span>${r.live ? (r.peers ? `${r.peers} other${r.peers === 1 ? '' : 's'} here` : 'just you') : esc(ago(r.lastUsed))}</span></span>
        ${r.live ? `<button class="btn sm primary" data-go="${esc(r.id)}">Open</button>` : `<button class="btn sm" data-rejoin="${esc(r.dir)}">Rejoin</button>`}
        ${state.workspaces?.length ? `<button class="btn sm ghost" data-move-session="${esc(r.dir)}" title="Move to a workspace" aria-label="Move to a workspace">${I.folder}</button>` : ''}
      </div>`).join('')}</div>` : `<p class="hint">${state.sessions.size || state.recent.length ? 'Every session is in a workspace.' : 'No sessions yet.'}</p>`}
  </section>`
}

export function bindWorkspaces (root, { go, rerender }) {
  root.querySelectorAll('[data-open-ws]').forEach((el) => {
    const open = () => go(`ws:${el.dataset.openWs}`)
    el.onclick = open
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }
  })
  root.querySelectorAll('.ws-chips [data-go]').forEach((b) => { b.onclick = () => go(b.dataset.go) })
  root.querySelectorAll('[data-space-filter]').forEach((b) => { b.onclick = () => { state.spaceFilter = b.dataset.spaceFilter; rerender() } })
  const add = root.querySelector('[data-add-ws]')
  if (add) {
    const open = () => { state.addingWorkspace = true; rerender(); $('#ws-name')?.focus() } // rerender replaces root
    add.onclick = open
    add.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }
  }
  const form = root.querySelector('[data-add-ws-form]')
  if (form) {
    form.querySelector('[data-add-ws-cancel]').onclick = () => { state.addingWorkspace = false; rerender() }
    form.onsubmit = async (e) => {
      e.preventDefault()
      const f = new FormData(form)
      const body = { name: f.get('name'), org: f.get('org') || undefined }
      form.querySelector('button[type=submit]').disabled = true
      try {
        const { workspace } = await api('POST', '/api/workspaces', body)
        state.addingWorkspace = false
        await loadWorkspaces()
        go(`ws:${workspace.id}`)
      } catch (err) {
        form.querySelector('[data-add-ws-error]').textContent = err.message
        form.querySelector('button[type=submit]').disabled = false
      }
    }
  }
  root.querySelectorAll('[data-move-session]').forEach((b) => {
    b.onclick = async () => {
      const options = (state.workspaces || []).filter((w) => w.access === 'edit')
      if (!options.length) return toast('No workspace you can edit.')
      const choice = await ask({ title: `Move ${basename(b.dataset.moveSession)} to`, input: { select: options.map((w) => ({ value: w.id, label: w.name })) }, ok: 'Move' })
      if (!choice) return
      try {
        await api('POST', wsUrl(choice, '/sessions/move'), { dir: b.dataset.moveSession })
        // The folder's workspace changed on this computer: take the fresh recent list and summaries.
        const st = await api('GET', '/api/state')
        state.recent = st.recent
        for (const sum of st.sessions) { const s = state.sessions.get(sum.id); if (s) s.workspace = sum.workspace }
        await loadWorkspaces(); rerender(); toast('Moved')
      } catch (err) { toast(err.message) }
    }
  })
}

// ------------------------------------------------------------------ page --
function sessionCardHtml (s, { live, dir, id, peers, lastUsed, mine }) {
  return `
  <div class="sc">
    <div class="top"><span class="folder-ico${live ? ' live' : ''}">${I.folder}</span><b>${esc(s?.name || basename(dir || '') || s?.room || '')}</b>${live ? '<span class="pill ok" title="Open now" aria-label="Open now"><span class="dot"></span></span>' : ''}</div>
    <div class="mono">${esc(dir ? tildify(dir) : (s?.room || ''))}</div>
    <div class="who"><span>${live ? (peers ? `${peers} other${peers === 1 ? '' : 's'} here` : 'Just you') : (dir ? esc(ago(lastUsed)) : (mine ? 'Yours, on another computer' : 'Someone else\'s'))}</span><span class="spacer"></span>
      ${live ? `<button class="btn sm primary" data-go="${esc(id)}">Open</button>` : dir ? `<button class="btn sm" data-rejoin="${esc(dir)}">Rejoin</button>` : ''}</div>
  </div>`
}

function peopleCardHtml (m, { admin, isOwner }) {
  const bot = m.kind === 'agent'
  return `
  <div class="pc${admin && !isOwner ? ' has-x' : ''}">${avatar(m.name || m.account, colorFor(m.name || m.account), false)}
    <div class="t"><b>${esc(m.name || m.account)}</b><span>${bot ? 'agent' : 'person'}${isOwner ? ' · owner' : ''}</span></div>
    ${isOwner ? '<span class="pill">Owner</span>' : admin
      ? `<select class="input sm" data-member-access="${esc(m.account)}" aria-label="Access for ${esc(m.name || m.account)}"><option value="edit" ${m.access === 'edit' ? 'selected' : ''}>Can edit</option><option value="view" ${m.access === 'view' ? 'selected' : ''}>View only</option></select>
         <button class="btn sm ghost icon pc-x" data-member-remove="${esc(m.account)}" title="Remove" aria-label="Remove ${esc(m.name || m.account)}">${I.x}</button>`
      : `<span class="pill">${m.access === 'edit' ? 'Can edit' : 'View only'}</span>`}
  </div>`
}

export function workspacePageHtml () {
  const d = state.workspace
  if (!d || d.workspace.id !== String(state.view).slice(3)) return '<p class="hint">Loading…</p>'
  const w = d.workspace
  const admin = d.access.admin
  const running = d.running.map((id) => state.sessions.get(id)).filter(Boolean)
  const runningRooms = new Set(running.map((s) => s.status.room))
  const recent = d.recent
  const recentRooms = new Set(recent.map((r) => r.room))
  const others = d.sessions.filter((s) => !runningRooms.has(s.room) && !recentRooms.has(s.room))
  const me = `person:${state.account?.id}`
  const members = [...(d.owner.account ? [{ account: d.owner.account, name: d.owner.name, kind: 'person', access: 'edit', owner: true }] : []), ...d.members]
  // Agents with why they are here (added, placed or global) come from `agents`; a member agent
  // missing there (revoked, or gone from the org) keeps its plain card so it can be removed.
  const agents = d.agents || []
  const listed = new Set(agents.map((a) => a.account))
  const people = members.filter((m) => !listed.has(m.account))
  const orgName = w.orgId ? d.owner.name : ''
  return `
  <a class="ws-back" href="#" data-ws-back>${I.caret} All workspaces</a>
  <header class="ws-head">
    <span class="ws-mark big" style="background:${coverOf(w)}">${esc(initial(w.name))}</span>
    <div><h1>${esc(w.name)} <span class="pill ws-space${w.orgId ? ' coral' : ''}">${esc(w.orgId ? d.owner.name : 'Personal')}</span>${w.archivedAt ? ' <span class="pill">Archived</span>' : ''}</h1><p>${esc(w.description || '')}</p></div>
    <div class="acts">${admin ? `<button class="btn sm" data-invite-ws>${I.link}<span>Invite</span></button><button class="btn sm ghost icon" data-ws-settings title="Workspace settings" aria-label="Workspace settings">${I.gear}</button>` : ''}</div>
  </header>

  <section class="sec">
    <div class="sec-head"><h2>Sessions</h2><span class="count">${running.length + recent.length + others.length}</span></div>
    <div class="sc-grid">
      ${running.map((s) => sessionCardHtml(d.sessions.find((x) => x.room === s.status.room), { live: true, dir: s.dir, id: s.id, peers: s.status.peers.length })).join('')}
      ${recent.map((r) => sessionCardHtml(d.sessions.find((x) => x.room === r.room), { live: false, dir: r.dir, lastUsed: r.lastUsed })).join('')}
      ${others.map((s) => sessionCardHtml(s, { live: false, mine: s.ownerAccount === me })).join('')}
      ${d.access.access === 'edit' ? `<button class="sc add" data-new-session-in="${esc(w.id)}">${I.plus}<span>New session</span></button>` : ''}
    </div>
  </section>
  ${filesSectionHtml(d)}

  <section class="sec">
    <div class="sec-head"><h2>People &amp; agents</h2><span class="count">${people.length + agents.length}</span></div>
    <div class="pc-grid">
      ${people.map((m) => peopleCardHtml(m, { admin, isOwner: !!m.owner })).join('')}
      ${agents.map((a) => workspaceAgentCardHtml(a, { admin, orgName })).join('')}
      ${admin ? `<button class="pc add" data-add-member>${I.plus}<span>Add a person or an agent</span></button>` : ''}
    </div>
  </section>`
}

export function bindWorkspacePage (root, { go, rerender, newSessionDialog, inviteDialog, dialog }) {
  const d = state.workspace
  if (!d || d.workspace.id !== String(state.view).slice(3)) return
  const id = d.workspace.id
  const reload = async () => { await openWorkspace(id); await loadWorkspaces(); rerender() }
  root.querySelector('[data-ws-back]').onclick = (e) => { e.preventDefault(); go('home') }
  root.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => go(b.dataset.go) })
  root.querySelector('[data-new-session-in]')?.addEventListener('click', () => newSessionDialog(id))
  root.querySelector('[data-invite-ws]')?.addEventListener('click', () => inviteDialog(id))
  root.querySelector('[data-add-member]')?.addEventListener('click', () => inviteDialog(id))
  root.querySelectorAll('[data-member-access]').forEach((sel) => {
    sel.onchange = async () => { try { await api('POST', wsUrl(id, '/members'), { account: sel.dataset.memberAccess, access: sel.value }); toast('Saved'); await reload() } catch (err) { toast(err.message); rerender() } }
  })
  root.querySelectorAll('[data-member-remove]').forEach((b) => {
    b.onclick = async () => {
      if (!await ask({ title: 'Remove from this workspace?', message: 'They lose access to its sessions unless a session owner lets them in directly.', ok: 'Remove', danger: true })) return
      try { await api('POST', wsUrl(id, '/members/remove'), { account: b.dataset.memberRemove }); await reload() } catch (err) { toast(err.message) }
    }
  })
  // Agents: Joins writes an added agent's own setting, or the workspace's say over a placed one.
  const agentOf = (agentId) => (d.agents || []).find((a) => a.agentId === agentId)
  const agentUrl = (agentId, rest = '') => wsUrl(id, `/agents/${encodeURIComponent(agentId)}${rest}`)
  root.querySelectorAll('[data-agent-joins]').forEach((sel) => {
    sel.onchange = async () => {
      const a = agentOf(sel.dataset.agentJoins)
      if (!a) return
      try {
        if (a.via === 'member') await api('POST', wsUrl(id, '/members'), { account: a.account, access: a.access, sessions: sel.value })
        else await api('POST', agentUrl(a.agentId), { sessions: sel.value })
        toast('Saved'); await reload()
      } catch (err) { toast(err.message); rerender() }
    }
  })
  root.querySelectorAll('[data-agent-exclude]').forEach((b) => {
    b.onclick = async () => {
      const a = agentOf(b.dataset.agentExclude)
      if (!a || !await ask({ title: 'Not in this workspace?', message: `${a.name} leaves this workspace and its sessions. It keeps its other workspaces, and you can let it back in here.`, ok: 'Not in this workspace', danger: true })) return
      try { await api('POST', agentUrl(a.agentId), { excluded: true }); await reload() } catch (err) { toast(err.message) }
    }
  })
  root.querySelectorAll('[data-agent-include]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true
      try { await api('POST', agentUrl(b.dataset.agentInclude, '/remove')); toast('Back in'); await reload() } catch (err) { toast(err.message); b.disabled = false }
    }
  })
  root.querySelector('[data-ws-settings]')?.addEventListener('click', () => settingsDialog(reload, go, dialog))
  bindFilesSection(root, { id, reload, go })
}

/** "1.2 GB of 5.0 GB used · 34 files", from the workspace's usage; nothing without one. */
function usageLine (u) {
  if (!u) return ''
  const used = Number.isFinite(u.quotaBytes) ? `${bytes(u.usedBytes || 0)} of ${bytes(u.quotaBytes)}` : bytes(u.usedBytes || 0)
  const n = u.fileCount || 0
  return `<p class="hint" data-ws-usage>${esc(`${used} used · ${n} ${n === 1 ? 'file' : 'files'}`)}</p>`
}

/** `dialog(html)` is home.js's: a modal form that closes on Cancel, Escape or a click outside. */
function settingsDialog (reload, go, dialog) {
  const w = state.workspace.workspace
  const { form, close } = dialog(`
    <h3>Workspace settings</h3>
    <div class="field"><label for="wss-name">Name</label><input class="input" id="wss-name" name="name" maxlength="80" required value="${esc(w.name)}"></div>
    <div class="field"><label for="wss-desc">About</label><input class="input" id="wss-desc" name="description" maxlength="500" value="${esc(w.description || '')}"></div>
    <div class="field"><span class="label">Colour</span><div class="swatches">${Object.entries(COLORS).map(([k, c]) => `<label class="swatch"><input type="radio" name="color" value="${k}" ${(w.color || 'lilac') === k ? 'checked' : ''}><span style="background:${c}"></span></label>`).join('')}</div></div>
    <label class="toggle"><input type="checkbox" name="archived" ${w.archivedAt ? 'checked' : ''}><span class="track"><span class="knob"></span></span><span class="tg-text"><b>Archived</b><span class="hint">Kept, but out of the way.</span></span></label>
    ${usageLine(state.workspace.usage)}
    <p class="error" data-error></p>
    <div class="actions">${state.workspace.canDelete ? '<button type="button" class="btn ghost danger" data-delete>Delete workspace</button>' : ''}<span class="spacer"></span><button type="button" class="btn ghost" data-cancel>Cancel</button><button class="btn primary" type="submit">Save</button></div>`)
  // Focus inside the dialog, so Escape (bound on the dialog) closes it straight away.
  form.querySelector('#wss-name').focus()
  form.onsubmit = async (e) => {
    e.preventDefault()
    const f = new FormData(form)
    const save = form.querySelector('button[type=submit]')
    save.disabled = true
    try {
      const patch = { name: f.get('name'), description: f.get('description'), color: f.get('color') }
      // Only a change of the toggle: sending it again would reset when it was archived.
      const archived = f.get('archived') === 'on'
      if (archived !== !!w.archivedAt) patch.archived = archived
      await api('POST', wsUrl(w.id, '/update'), patch)
      close(); await reload()
    } catch (err) {
      form.querySelector('[data-error]').textContent = err.message
      save.disabled = false
    }
  }
  form.querySelector('[data-delete]')?.addEventListener('click', async () => {
    const typed = await ask({ title: `Delete ${w.name}?`, message: 'Its sessions stay, outside any workspace. Type the workspace name to confirm.', ok: 'Delete', danger: true, input: { placeholder: w.name } })
    if (typed !== w.name) { if (typed) toast('That is not the name.'); return }
    try { await api('POST', wsUrl(w.id, '/delete')); close(); await loadWorkspaces(); go('home') } catch (err) { toast(err.message) }
  })
}
