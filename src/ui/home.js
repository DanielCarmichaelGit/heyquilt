// Home and Settings: a sidebar with your profile and open sessions, next to
// either the start/join page or your settings. Sessions themselves live in session.js.
import { I, state, $, esc, basename, ago, toast, api, ask, decodeInvite, avatar, PALETTE } from './common.js'
import { go, pickFolder, signedOutNow, agentInviteHtml } from './app.js'
import { agentPaste } from './invite.js'
import { quiltMark } from './mark.js'
import { updateControl } from './releases.js'
import { workspacesHtml, bindWorkspaces, workspacePageHtml, bindWorkspacePage, loadWorkspaces, openWorkspace, COLORS } from './workspaces.js'
import { allFilesHtml, bindAllFiles } from './files.js'
import { agentRow, bindPlacements, placeableWorkspaces } from './agent-place.js'

export const tildify = (p) => state.defaults.home && String(p).startsWith(state.defaults.home) ? `~${String(p).slice(state.defaults.home.length)}` : p
const hostOf = (url) => { try { return new URL(String(url).replace(/^ws/, 'http')).host } catch { return url } }
const firstName = () => String(state.profile.name || '').split(/[\s._-]/)[0] || state.profile.name

function greeting () {
  const h = new Date().getHours()
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

// ---------------------------------------------------------------- shell --
export function renderShell (view) {
  const page = $('#page')
  const scroll = page ? page.scrollTop : 0
  $('#app').innerHTML = `
    <div class="app-shell">
      ${mobileBarHtml(view)}
      <div class="side-scrim" data-side-close></div>
      ${sidebarHtml(view)}
      <main class="page" id="page">${view === 'settings' ? settingsHtml() : view.startsWith('wsfiles:') ? allFilesHtml(state.workspace) : view.startsWith('ws:') ? workspacePageHtml() : homeHtml()}</main>
    </div>`
  if (page && view === state.shellView) $('#page').scrollTop = scroll
  state.shellView = view
  bindSidebar()
  if (view === 'settings') bindSettings($('#page'), () => renderShell('settings'))
  else if (view.startsWith('wsfiles:')) {
    const id = view.slice('wsfiles:'.length)
    const rerender = () => { if (state.view === view) renderShell(view) }
    bindAllFiles($('#page'), { id, go, rerender, reload: async () => { await openWorkspace(id).catch((err) => toast(err.message)); rerender() } })
  } else if (view.startsWith('ws:')) {
    bindWorkspacePage($('#page'), { go, rerender: () => renderShell(view), newSessionDialog, inviteDialog: workspaceInviteDialog, dialog })
    bindSessionActions($('#page'))
  } else bindHome()
}

/** Narrow windows: a slim bar with the logo, where you are, your avatar and a menu
 * button; the full sidebar slides in from the left as a drawer. Hidden on wide windows. */
function placeName (view) {
  if (view === 'settings') return 'Settings'
  const id = view.startsWith('wsfiles:') ? view.slice(8) : view.startsWith('ws:') ? view.slice(3) : ''
  if (!id) return 'Home'
  const name = (state.workspaces || []).find((w) => w.id === id)?.name || state.workspace?.workspace?.name || 'Workspace'
  return view.startsWith('wsfiles:') ? `${name} · Files` : name
}

function mobileBarHtml (view) {
  const p = state.profile
  return `
    <header class="mbar">
      <button type="button" class="btn ghost icon" data-side-open aria-label="Open the menu" aria-expanded="false">${I.menu}</button>
      <button type="button" class="mbar-brand" data-view="home" aria-label="Home">${quiltMark({ word: false })}</button>
      <span class="mbar-title">${esc(placeName(view))}</span>
      <button type="button" class="mbar-me" data-view="settings" title="Your profile and settings">${avatar(p.name, p.color)}</button>
    </header>`
}

function sidebarHtml (view) {
  const p = state.profile
  const running = [...state.sessions.values()]
  const reopenable = state.recent.filter((r) => !r.unsupported)
  return `
  <aside class="side">
    <button class="brand" data-view="home" aria-label="Home">${quiltMark({ sew: 'first' })}</button>

    <button class="me-card" data-view="settings" title="Edit your profile">
      ${avatar(p.name, p.color)}
      <span class="me-text"><b>${esc(p.name)}</b><span>${esc(p.tool)}</span></span>
      <span class="me-edit">Edit</span>
    </button>

    <div class="menu-wrap" id="sessions-menu-wrap">
      <button class="btn primary full sessions-btn" id="sessions-btn" aria-haspopup="true" aria-expanded="false">${I.folder}<span>Sessions</span>${running.length ? `<span class="badge-count">${running.length}</span>` : ''}<span class="caret">${I.caret}</span></button>
      <div class="popover menu" id="sessions-menu" role="menu" hidden>
        <button class="pop-item" role="menuitem" data-new-session>${I.plus}<span>New session…</span></button>
        <button class="pop-item" role="menuitem" data-join-session>${I.link}<span>Join with an invite…</span></button>
        ${running.length ? `<div class="pop-sep"></div><div class="pop-label">Open now</div>${running.map((s) => `
        <button class="pop-item" role="menuitem" data-go="${s.id}"><span class="dot" style="background:${s.status.connected ? 'var(--ok)' : 'var(--warn)'}"></span><span class="grow">${esc(s.status.sessionName || basename(s.dir))}</span><span class="hint">${s.status.peers.length + 1} here</span></button>`).join('')}` : ''}
        ${reopenable.length ? `<div class="pop-sep"></div><div class="pop-label">Recent</div>${reopenable.slice(0, 5).map((r) => `
        <button class="pop-item" role="menuitem" data-rejoin="${esc(r.dir)}"><span class="dot"></span><span class="grow">${esc(basename(r.dir))}</span><span class="hint">${esc(ago(r.lastUsed))}</span></button>`).join('')}` : ''}
      </div>
    </div>

    <nav class="side-nav" aria-label="Main">
      <button data-view="home" class="${view === 'home' ? 'on' : ''}">${I.home}<span>Home</span></button>
    </nav>
    ${sideWorkspacesHtml(view)}

    <nav class="side-nav side-foot" aria-label="App">
      <button data-view="settings" class="${view === 'settings' ? 'on' : ''}">${I.gear}<span>Settings</span></button>
    </nav>
  </aside>`
}

/** The sidebar's Workspaces list, with the open one marked. Only once the API has workspaces on. */
function sideWorkspacesHtml (view) {
  view = String(view).replace(/^wsfiles:/, 'ws:') // All files marks its workspace too
  const list = state.workspacesOn ? (state.workspaces || []) : []
  if (!list.length) return ''
  return `
    <div class="side-label">Workspaces</div>
    <nav class="side-nav side-workspaces" aria-label="Workspaces">${list.map((w) => `
      <button data-view="ws:${esc(w.id)}" class="${view === `ws:${w.id}` ? 'on' : ''}" title="${esc(w.name)}"><span class="sw" style="background:${COLORS[w.color] || COLORS.lilac}"></span><span class="nm">${esc(w.name)}${w.space?.kind === 'org' ? `<span class="org"> · ${esc(w.space.name)}</span>` : ''}</span>${w.counts?.open ? `<span class="ct">${w.counts.open}</span>` : ''}</button>`).join('')}
    </nav>`
}

function bindSidebar () {
  document.querySelectorAll('[data-view]').forEach((b) => {
    b.onclick = () => go(b.dataset.view)
  })
  // The narrow drawer: open from the bar's menu button; the scrim, Escape or going anywhere closes it.
  const shell = $('.app-shell')
  const toggle = $('[data-side-open]')
  const setDrawer = (open) => { shell.classList.toggle('side-open', open); toggle?.setAttribute('aria-expanded', String(open)) }
  if (toggle) toggle.onclick = () => setDrawer(!shell.classList.contains('side-open'))
  $('[data-side-close]')?.addEventListener('click', () => setDrawer(false))
  shell.addEventListener('keydown', (e) => { if (e.key === 'Escape' && shell.classList.contains('side-open')) { setDrawer(false); toggle?.focus() } })
  const btn = $('#sessions-btn')
  const menu = $('#sessions-menu')
  const setOpen = (open) => { menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)) }
  btn.onclick = () => setOpen(menu.hidden)
  menu.addEventListener('click', () => setOpen(false))
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setOpen(false); btn.focus() } })
  if (!bindSidebar.listening) {
    bindSidebar.listening = true
    document.addEventListener('mousedown', (e) => {
      const wrap = $('#sessions-menu-wrap')
      if (wrap && !wrap.contains(e.target)) { $('#sessions-menu').hidden = true; $('#sessions-btn').setAttribute('aria-expanded', 'false') }
    })
  }
  document.querySelectorAll('.side [data-go]').forEach((b) => { b.onclick = () => go(b.dataset.go) })
  bindSessionActions(document.querySelector('.side'))
}

/** New / join / rejoin buttons, wherever they appear. */
function bindSessionActions (root) {
  root.querySelectorAll('[data-new-session]').forEach((b) => { b.onclick = () => newSessionDialog() })
  root.querySelectorAll('[data-join-session]').forEach((b) => { b.onclick = () => joinSessionDialog() })
  root.querySelectorAll('[data-rejoin]').forEach((b) => {
    b.onclick = async () => {
      const label = b.querySelector('.grow') ? null : b.textContent
      b.disabled = true
      if (label) b.innerHTML = `${quiltMark({ word: false, loop: true, cls: 'qm-inline' })}<span>Connecting…</span>`
      try {
        const sum = await api('POST', '/api/sessions', { mode: 'rejoin', dir: b.dataset.rejoin })
        state.sessions.set(sum.id, sum)
        await go(sum.id)
      } catch (err) {
        toast(err.message)
        b.disabled = false
        if (label) b.textContent = label
      }
    }
  })
}

// ------------------------------------------------------------------ home --
function sessionRows () {
  const running = [...state.sessions.values()].map((s) => ({
    live: true, id: s.id, dir: s.dir, name: s.status.me.name, tool: s.status.me.tool,
    server: s.status.server, peers: s.status.peers.length
  }))
  const recent = state.recent.map((r) => ({ live: false, dir: r.dir, name: r.name, tool: r.tool, server: r.server, lastUsed: r.lastUsed, unsupported: !!r.unsupported }))
  return [...running, ...recent]
}

const relayLabel = (server) => server ? hostOf(server) : ''

function sessionRowHtml (r) {
  if (r.unsupported) {
    return `
      <div class="session-row gone">
        <div class="folder-ico">${I.folder}</div>
        <div class="meta">
          <div class="name">${esc(basename(r.dir))}</div>
          <div class="sub">This session ran on your computer's own relay, which Quilt no longer supports. Your files are untouched.</div>
        </div>
        <div class="facts"><span>${esc(ago(r.lastUsed))}</span></div>
        <div class="acts"><button class="btn sm" data-forget="${esc(r.dir)}">Remove from list</button></div>
      </div>`
  }
  return `
      <div class="session-row${r.live ? ' live' : ''}">
        <div class="folder-ico${r.live ? ' live' : ''}">${I.folder}</div>
        <div class="meta">
          <div class="name">${esc(basename(r.dir))}${r.live ? '<span class="pill ok"><span class="dot"></span>Open</span>' : ''}</div>
          <div class="sub">${esc(tildify(r.dir))}</div>
        </div>
        <div class="facts">
          <span title="Your name there">${I.user}${esc(r.name || '')}</span>
          ${r.server ? `<span title="Relay">${I.globe}${esc(relayLabel(r.server))}</span>` : ''}
          <span>${r.live ? `${r.peers ? `${r.peers} other${r.peers === 1 ? '' : 's'} here` : 'Just you'}` : esc(ago(r.lastUsed))}</span>
        </div>
        <div class="acts">
          ${r.live
            ? `<button class="btn sm primary" data-go="${r.id}">Open</button>`
            : `<button class="btn sm" data-rejoin="${esc(r.dir)}">Rejoin</button>
               <button class="btn sm ghost icon" data-forget="${esc(r.dir)}" title="Remove from this list" aria-label="Remove ${esc(basename(r.dir))} from this list">${I.x}</button>`}
        </div>
      </div>`
}

function homeHtml () {
  const rows = sessionRows()
  return `
  <header class="page-head">
    <h1>${greeting()}, ${esc(firstName())}</h1>
    <p>${state.workspacesOn ? 'Your workspaces. Open one, or add a new one.' : rows.some((r) => r.live) ? 'Pick up a session, or start something new from the Sessions menu.' : 'Start a session on one of your folders, or join one a partner shared with you.'}</p>
  </header>

  ${state.workspacesOn ? workspacesHtml() : rows.length ? `
  <section class="sessions">
    <div class="sec-head"><h2>Your sessions</h2><span class="count">${rows.length}</span>
      <span class="spacer"></span>
      <button class="btn sm" data-join-session>${I.link}<span>Join</span></button>
      <button class="btn sm primary" data-new-session>${I.plus}<span>New session</span></button>
    </div>
    <div class="card session-list">${rows.map(sessionRowHtml).join('')}</div>
  </section>` : `
  <section class="card welcome">
    <div class="welcome-steps">
      <div><span class="n">1</span><b>Start a session</b><p class="hint">Pick a folder on your computer to work on together.</p></div>
      <div><span class="n">2</span><b>Send an invite link</b><p class="hint">Partners click it or paste it into Quilt. You approve who gets in.</p></div>
      <div><span class="n">3</span><b>Code together</b><p class="hint">Files sync live, and you can watch each other's AI work.</p></div>
    </div>
    <div class="welcome-actions">
      <button class="btn primary" data-new-session>${I.plus}<span>New session</span></button>
      <button class="btn" data-join-session>${I.link}<span>Join with an invite</span></button>
    </div>
  </section>`}`
}

function bindHome () {
  const page = $('#page')
  bindSessionActions(page)
  page.querySelectorAll('.session-list [data-go]').forEach((b) => { b.onclick = () => go(b.dataset.go) })
  if (state.workspacesOn) bindWorkspaces(page, { go, rerender: () => renderShell('home') })
  page.querySelectorAll('[data-forget]').forEach((b) => {
    b.onclick = async () => {
      try {
        state.recent = (await api('POST', '/api/recent/forget', { dir: b.dataset.forget })).recent
        renderShell('home')
        toast('Removed from the list. The folder is untouched.')
      } catch (err) { toast(err.message) }
    }
  })
}

// --------------------------------------------------------------- dialogs --
function dialog (html) {
  const back = document.createElement('div')
  back.className = 'modal-back'
  back.innerHTML = `<form class="card modal" role="dialog" aria-modal="true" autocomplete="off">${html}</form>`
  document.body.appendChild(back)
  const form = back.querySelector('form')
  const close = () => back.remove()
  back.addEventListener('mousedown', (e) => { if (e.target === back) close() })
  back.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })
  form.querySelector('[data-cancel]').onclick = close
  return { back, form, close }
}

export function newSessionDialog (workspace = '') {
  const { form, close } = dialog(`
    <h3>New session${workspace ? ` in ${esc(state.workspaces?.find((w) => w.id === workspace)?.name || 'this workspace')}` : ''}</h3>
    <p class="lead">Pick what you want to work on together. You'll get invites to send once it starts.</p>
    <div class="segmented src-switch" role="tablist" aria-label="Start from">
      <button type="button" role="tab" data-src="folder" class="on" aria-selected="true">${I.folder}<span>Folder</span></button>
      <button type="button" role="tab" data-src="github" aria-selected="false">${I.branch}<span>GitHub</span></button>
    </div>
    <div id="src-folder">
    <div class="field">
      <label for="n-dir">Project folder</label>
      <div class="row"><input class="input grow" id="n-dir" name="dir" placeholder="~/code/my-app" value="${esc(tildify(state.lastCreateDir || state.defaults.cwd || ''))}" required>
      <button type="button" class="btn icon" id="n-browse" title="Browse" aria-label="Browse">${I.folder}</button></div>
    </div>
    </div>
    <div id="src-github" hidden></div>
    <p class="error" id="n-error"></p>
    <div class="actions"><button type="button" class="btn ghost" data-cancel>Cancel</button><button class="btn primary" type="submit">Start session</button></div>`)
  let src = 'folder'
  const gh = githubPicker(form.querySelector('#src-github'))
  form.querySelectorAll('[data-src]').forEach((b) => {
    b.onclick = () => {
      src = b.dataset.src
      form.querySelectorAll('[data-src]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)) })
      form.querySelector('#src-folder').hidden = src !== 'folder'
      form.querySelector('#src-github').hidden = src !== 'github'
      form.querySelector('#n-dir').required = src === 'folder'
      form.querySelector('button[type=submit]').textContent = src === 'github' ? 'Clone and start' : 'Start session'
      form.querySelector('#n-error').textContent = ''
      if (src === 'github') gh.open()
      else form.querySelector('#n-dir').focus()
    }
  })
  form.querySelector('#n-browse').onclick = () => pickFolder(form.querySelector('#n-dir'))
  form.onsubmit = async (e) => {
    e.preventDefault()
    if (src === 'github') {
      let body
      try { body = gh.value() } catch (err) { form.querySelector('#n-error').textContent = err.message; return }
      if (await submit(form, '#n-error', { mode: 'github', ...body, workspace }, 'Cloning…')) close()
      return
    }
    const dir = form.querySelector('#n-dir').value
    state.lastCreateDir = dir
    if (await submit(form, '#n-error', { mode: 'create', dir, workspace })) close()
  }
  form.querySelector('#n-dir').focus()
}

/**
 * Add someone to a workspace: people you've worked with and the agents that can be added (your
 * own in a personal workspace, the org's in an org's), each with an Add button, at the access
 * picked above. Agents can also join every session here as it starts, and Invite a new agent
 * makes a link for an agent that joins the workspace once it registers.
 */
function workspaceInviteDialog (id) {
  const d = state.workspace
  // An org's workspace offers the org's agents only (never your own: they can't join it).
  const isOrg = !!d?.workspace?.orgId
  const org = isOrg ? (state.workspaces || []).find((w) => w.id === id)?.space : null
  const orgName = org?.name || d?.owner?.name || 'the org'
  const { back, form, close } = dialog(`
    <h3>Add to ${esc(d?.workspace?.name || 'this workspace')}</h3>
    <p class="lead">They get into every session in this workspace once they sign in.</p>
    <div class="field"><label for="wi-access">Access</label>
      <select class="input" id="wi-access"><option value="edit">Can edit</option><option value="view">View only</option></select></div>
    ${toggle('wiEvery', false, 'Also join every session in this workspace as it starts', 'For agents. Off: the agent is in the workspace, sees its files, and joins a session only when invited there.')}
    <div class="label inv-sub">People you've worked with, and ${isOrg ? `${esc(orgName)}'s agents` : 'your agents'}</div>
    <div class="inv-list" id="wi-people"><p class="hint">Loading…</p></div>
    <div class="inv-agent wi-new-agent" id="wi-new-agent"><button class="btn sm" type="button" data-wi-invite-agent>${I.bot}<span>Invite a new agent</span></button><span class="hint">You'll get a link to paste into your AI.</span></div>
    <p class="error" id="wi-error"></p>
    <div class="actions"><button type="button" class="btn primary" data-cancel>Done</button></div>`)
  // Anchored at the top: it grows downward as the list and an agent invite come in, never jumps.
  back.classList.add('top')
  form.onsubmit = (e) => e.preventDefault()
  const joins = () => (form.querySelector('[name=wiEvery]').checked ? 'all' : 'invited')
  const already = new Set([d?.owner?.account, ...(d?.members || []).map((m) => m.account), ...(d?.agents || []).filter((a) => !a.excluded).map((a) => a.account)].filter(Boolean))
  const list = $('#wi-people', back)
  // { list, note }: a note says why no agents could be listed (an org's need Agents: Read).
  const agents = !isOrg
    ? api('GET', '/api/agents').then((r) => ({ list: r.agents }), () => ({ list: [] }))
    : !org
        ? Promise.resolve({ list: [], note: `${orgName}'s agents can't be listed here.` })
        : api('GET', `/api/orgs/${encodeURIComponent(org.slug)}/agents`).then((r) => ({ list: r.agents }), (err) => ({ list: [], note: `${orgName}'s agents can't be listed: ${err.message}` }))
  Promise.all([
    api('GET', '/api/collaborators').then((r) => r.collaborators).catch(() => []),
    agents
  ]).then(([people, { list: mine, note }]) => {
    const seen = new Set()
    const rows = [...people.filter((c) => c.kind !== 'agent' || !isOrg), ...mine.map((a) => ({ account: `agent:${a.id}`, name: a.name, kind: 'agent' }))].filter((c) => c.account && !seen.has(c.account) && seen.add(c.account))
    const why = note ? `<p class="hint wi-note">${esc(note)}</p>` : ''
    list.innerHTML = rows.length
      ? rows.map((c) => `<div class="inv-row">${avatar(c.name, null)}<span class="grow">${esc(c.name)}${c.kind === 'agent' ? `<span class="tag bot">${I.bot}agent</span>` : ''}</span>${already.has(c.account)
        ? '<span class="hint">Already in</span>'
        : `<button class="btn sm" type="button" data-add-account="${esc(c.account)}" data-name="${esc(c.name)}">Add</button>`}</div>`).join('') + why
      : why || "<p class=\"hint\">Nobody yet. People and agents you've been in a session with show up here.</p>"
  })
  list.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-add-account]')
    if (!b) return
    b.disabled = true
    $('#wi-error', back).textContent = ''
    const account = b.dataset.addAccount
    try {
      await api('POST', `/api/workspaces/${encodeURIComponent(id)}/members`, { account, access: $('#wi-access', back).value, ...(account.startsWith('agent:') ? { sessions: joins() } : {}) })
      b.outerHTML = '<span class="hint">Added</span>'
      toast(`Added ${b.dataset.name}`)
      await openWorkspace(id)
      await loadWorkspaces()
      if (state.view === `ws:${id}` || state.view === `wsfiles:${id}`) renderShell(state.view)
    } catch (err) {
      $('#wi-error', back).textContent = err.message
      b.disabled = false
    }
  })
  const invite = $('[data-wi-invite-agent]', back)
  invite.onclick = async () => {
    invite.disabled = true
    $('#wi-error', back).textContent = ''
    try {
      const { link } = await api('POST', `/api/workspaces/${encodeURIComponent(id)}/agent-invites`, { access: $('#wi-access', back).value, sessions: joins() })
      $('#wi-new-agent', back).innerHTML = agentInviteHtml(agentPaste({ link }), 'wi-paste')
    } catch (err) {
      $('#wi-error', back).textContent = err.message
      invite.disabled = false
    }
  }
  form.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]')
    if (!b) return
    e.preventDefault()
    try { await navigator.clipboard.writeText($(`#${b.dataset.copy}`, form).textContent); toast('Copied') } catch { toast('Select the text and press ⌘/Ctrl+C to copy') }
  })
  return close
}

/** The GitHub side of the New session dialog: repo, branch, and where to clone it. */
function githubPicker (root) {
  let repos = null
  let repo = null // { name, defaultBranch }
  let branches = null // { branches, defaultBranch }
  let loaded = false

  async function open () {
    if (loaded) return root.querySelector('#gh-search')?.focus()
    loaded = true
    root.innerHTML = '<p class="hint gh-wait">Checking GitHub…</p>'
    let st
    try { st = await api('GET', '/api/github/status') } catch (err) { st = { authenticated: false, message: err.message } }
    if (!st.authenticated) {
      loaded = false
      root.innerHTML = `<div class="note gh-setup">${I.branch}<span>${st.installed === false
        ? 'Install the GitHub CLI (<code>brew install gh</code>), then run <code>gh auth login</code> in a terminal.'
        : 'Connect GitHub by running <code>gh auth login</code> in a terminal.'} Then switch to GitHub again.</span></div>`
      return
    }
    root.innerHTML = `
      <div class="field">
        <label for="gh-search">Repository${st.user ? ` <span class="hint">· signed in as ${esc(st.user)}</span>` : ''}</label>
        <input class="input" id="gh-search" placeholder="Search your repositories" spellcheck="false" autocomplete="off">
        <div class="gh-list" id="gh-list" role="listbox" aria-label="Repositories"><p class="hint">Loading repositories…</p></div>
      </div>
      <div id="gh-branch" hidden>
        <div class="field">
          <span class="label">Branch</span>
          <div class="choice-cards">
            <label class="choice-card"><input type="radio" name="ghb" value="existing" checked><span><b>Use an existing branch</b></span></label>
            <label class="choice-card"><input type="radio" name="ghb" value="new"><span><b>Create a new branch</b></span></label>
          </div>
          <div id="gh-existing"><select class="input" id="gh-branch-select" aria-label="Branch"></select></div>
          <div id="gh-new" class="row" hidden>
            <input class="input grow" id="gh-new-name" placeholder="my-feature" spellcheck="false" aria-label="New branch name">
            <span class="hint">from</span>
            <select class="input gh-base" id="gh-base" aria-label="Start from branch"></select>
          </div>
        </div>
        <div class="field">
          <label for="gh-dir">Clone into</label>
          <div class="row"><input class="input grow" id="gh-dir" spellcheck="false">
          <button type="button" class="btn icon" id="gh-browse" title="Browse" aria-label="Browse">${I.folder}</button></div>
          <span class="hint">Leave empty to use a new folder in ${esc(state.profile.joinDir)}.</span>
        </div>
      </div>`
    const search = root.querySelector('#gh-search')
    search.addEventListener('input', paintRepos)
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault() // pick the first match rather than submitting
      root.querySelector('#gh-list [data-repo]')?.click()
    })
    root.querySelector('#gh-browse').onclick = () => pickFolder(root.querySelector('#gh-dir'))
    root.querySelectorAll('[name=ghb]').forEach((r) => {
      r.onchange = () => {
        root.querySelector('#gh-existing').hidden = r.value !== 'existing'
        root.querySelector('#gh-new').hidden = r.value !== 'new'
        if (r.value === 'new') root.querySelector('#gh-new-name').focus()
      }
    })
    search.focus()
    try {
      repos = (await api('GET', '/api/github/repos')).repos
    } catch (err) {
      root.querySelector('#gh-list').innerHTML = `<p class="hint warn">${esc(err.message)}</p>`
      return
    }
    paintRepos()
  }

  function paintRepos () {
    const list = root.querySelector('#gh-list')
    if (!list || !repos) return
    const q = root.querySelector('#gh-search').value.trim().toLowerCase()
    const shown = repos.filter((r) => !q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)).slice(0, 60)
    list.innerHTML = shown.length
      ? shown.map((r) => `<button type="button" class="gh-repo${repo && repo.name === r.name ? ' on' : ''}" role="option" aria-selected="${repo && repo.name === r.name}" data-repo="${esc(r.name)}">
          <span class="grow"><b>${esc(r.name)}</b>${r.description ? `<span class="hint">${esc(r.description)}</span>` : ''}</span>
          ${r.updatedAt ? `<span class="hint">${esc(ago(Date.parse(r.updatedAt)))}</span>` : ''}</button>`).join('')
      : `<p class="hint">${repos.length ? 'No repositories match.' : 'You have no repositories on GitHub yet.'}</p>`
    list.querySelectorAll('[data-repo]').forEach((b) => { b.onclick = () => pickRepo(repos.find((r) => r.name === b.dataset.repo)) })
  }

  async function pickRepo (r) {
    repo = r
    branches = null
    paintRepos()
    root.querySelector('#gh-branch').hidden = false
    root.querySelector('#gh-dir').placeholder = `${state.profile.joinDir}/${r.name.split('/').pop()}`
    const sel = root.querySelector('#gh-branch-select')
    const baseSel = root.querySelector('#gh-base')
    sel.innerHTML = baseSel.innerHTML = '<option>Loading…</option>'
    sel.disabled = baseSel.disabled = true
    try {
      const b = await api('GET', `/api/github/branches?repo=${encodeURIComponent(r.name)}`)
      if (repo !== r) return // picked another meanwhile
      branches = b
      const opts = b.branches.map((n) => `<option value="${esc(n)}" ${n === b.defaultBranch ? 'selected' : ''}>${esc(n)}${n === b.defaultBranch ? ' (default)' : ''}</option>`).join('')
      sel.innerHTML = baseSel.innerHTML = opts || '<option value="">No branches</option>'
      sel.disabled = baseSel.disabled = false
    } catch (err) {
      sel.innerHTML = baseSel.innerHTML = '<option value="">Couldn’t load branches</option>'
      toast(err.message)
    }
  }

  function value () {
    if (!repo) throw new Error('Pick a repository.')
    if (!branches) throw new Error('Wait for the branches to load.')
    const dir = root.querySelector('#gh-dir').value.trim() || undefined
    if (root.querySelector('[name=ghb]:checked').value === 'new') {
      const newBranch = root.querySelector('#gh-new-name').value.trim()
      if (!newBranch) throw new Error('Name your new branch.')
      return { repo: repo.name, newBranch, base: root.querySelector('#gh-base').value || undefined, dir }
    }
    return { repo: repo.name, branch: root.querySelector('#gh-branch-select').value || undefined, dir }
  }

  return { open, value }
}

export function joinSessionDialog (invite = '') {
  const p = state.profile
  const { form, close } = dialog(`
    <h3>Join a session</h3>
    <p class="lead">${invite ? 'You were invited to a session. Choose where the files go, then join.' : 'Paste the invite link your partner sent you.'} They'll be asked to let you in.</p>
    <div class="field">
      <label for="j-invite">Invite link</label>
      <textarea class="input mono" id="j-invite" rows="2" spellcheck="false" placeholder="https://join.heyquilt.com/…" required></textarea>
      <span class="hint warn" id="invite-hint" hidden>That doesn’t look like a quilt invite link. Copy the whole link they sent.</span>
    </div>
    <div class="field">
      <label for="j-dir">Put the files in</label>
      <div class="row"><input class="input grow" id="j-dir" placeholder="${esc(p.joinDir)}/<room>">
      <button type="button" class="btn icon" id="j-browse" title="Browse" aria-label="Browse">${I.folder}</button></div>
      <span class="hint">Leave empty to use a new folder in ${esc(p.joinDir)}.</span>
    </div>
    <p class="error" id="j-error"></p>
    <div class="actions"><button type="button" class="btn ghost" data-cancel>Cancel</button><button class="btn primary" type="submit">Join session</button></div>`)
  const inv = form.querySelector('#j-invite')
  inv.addEventListener('input', () => {
    const d = decodeInvite(inv.value)
    form.querySelector('#invite-hint').hidden = !inv.value.trim() || !!d
    form.querySelector('#j-dir').placeholder = `${p.joinDir}/${d ? d.room : '<room>'}`
  })
  if (invite) { inv.value = invite; inv.dispatchEvent(new Event('input')) }
  form.querySelector('#j-browse').onclick = () => pickFolder(form.querySelector('#j-dir'))
  form.onsubmit = async (e) => {
    e.preventDefault()
    if (!decodeInvite(inv.value)) { form.querySelector('#j-error').textContent = 'Paste the invite link your partner sent you.'; return }
    if (await submit(form, '#j-error', { mode: 'join', invite: inv.value, dir: form.querySelector('#j-dir').value.trim() || undefined })) close()
  }
  if (invite) form.querySelector('button[type=submit]').focus()
  else inv.focus()
}

async function submit (form, errSel, body, busy = 'Connecting…') {
  const btn = form.querySelector('button[type=submit]')
  const label = btn.textContent
  btn.disabled = true
  btn.innerHTML = `${quiltMark({ word: false, loop: true, cls: 'qm-inline' })}<span>${esc(busy)}</span>`
  form.querySelector(errSel).textContent = ''
  try {
    const sum = await api('POST', '/api/sessions', body)
    state.sessions.set(sum.id, sum)
    await go(sum.id)
    return true
  } catch (err) {
    form.querySelector(errSel).textContent = err.message
    btn.disabled = false
    btn.textContent = label
    return false
  }
}

// -------------------------------------------------------------- settings --
const THEMES = [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']]

function toggle (name, checked, label, hint) {
  return `<label class="toggle"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}><span class="track"><span class="knob"></span></span>
    <span class="tg-text"><b>${label}</b><span class="hint">${hint}</span></span></label>`
}

function settingsHtml ({ head = true } = {}) {
  const p = state.profile
  const a = state.account || { name: p.name, email: '' }
  const theme = p.theme || document.documentElement.dataset.theme || 'light'
  return `
  ${head ? `<header class="page-head">
    <h1>Settings</h1>
    <p>Saved on this computer and used for every new session.</p>
  </header>` : ''}

  <section class="card settings-sec" id="account-sec">
    <div class="sec-intro"><h2>Account</h2><p>This computer is signed in to your heyquilt.com account.</p></div>
    <div class="sec-body">
      <div class="kv"><span>Signed in as</span><b>${esc(a.name)}</b><span class="hint">${esc(a.email)}</span></div>
      <div class="sec-actions"><span class="hint">Signing out stops your sessions on this computer. Your files stay put.</span><button class="btn" type="button" id="sign-out">Sign out</button></div>
    </div>
  </section>

  <section class="card settings-sec" id="agents-sec">
    <div class="sec-intro"><h2>Agents</h2><p>AIs that join your sessions as their own members, under your account.</p></div>
    <div class="sec-body">
      <div id="agents-list"><p class="hint">Loading…</p></div>
      <div id="agents-invite">
        <p class="hint">Make a one-time invite and paste the text into your AI (Claude Code, Cursor, Codex and others). It registers as your agent; from then on it can join any session you send it. Revoke agents on <a href="https://heyquilt.com/dashboard/agents" target="_blank" rel="noopener">heyquilt.com</a>.</p>
        <p class="error" id="agents-error"></p>
      </div>
      <div class="sec-actions"><span class="hint">Inside a session, Invite also offers this with the session's link filled in.</span><button class="btn primary" type="button" id="agents-make">${I.bot}<span>Invite an agent</span></button></div>
    </div>
  </section>

  <form class="card settings-sec" id="profile-sec" autocomplete="off">
    <div class="sec-intro"><h2>Profile</h2><p>How you show up to the people you code with.</p></div>
    <div class="sec-body">
      <div class="profile-preview" id="pv">${avatar(p.name, p.color)}<div><b id="pv-name">${esc(p.name)}</b><span id="pv-tool">coding with ${esc(p.tool)}</span></div></div>
      <div class="field">
        <label for="s-name">Name</label>
        <input class="input" id="s-name" value="${esc(p.name)}" readonly>
        <span class="hint"><a href="https://heyquilt.com/settings" target="_blank" rel="noopener">Change it on heyquilt.com</a></span>
      </div>
      <div class="field">
        <span class="label">Color</span>
        <div class="swatches" role="radiogroup" aria-label="Color">
          <label class="swatch auto" title="Automatic"><input type="radio" name="color" value="" ${p.color ? '' : 'checked'}><span>Auto</span></label>
          ${PALETTE.map((c) => `<label class="swatch" title="${c}"><input type="radio" name="color" value="${c}" ${p.color === c ? 'checked' : ''}><span style="background:${c}"></span></label>`).join('')}
        </div>
      </div>
      <div class="field">
        <label for="s-tool">AI tool you use</label>
        <select class="input" id="s-tool" name="tool">${state.defaults.tools.map((t) => `<option ${t === p.tool ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
        <span class="hint">Shown next to your name, and used to find your AI chat so partners can follow along.</span>
      </div>
      <div class="sec-actions"><span class="hint">New sessions use this. Rejoin a running session to update it there.</span><button class="btn primary" type="submit">Save profile</button></div>
    </div>
  </form>

  <section class="card settings-sec" id="appearance-sec">
    <div class="sec-intro"><h2>Appearance</h2><p>How Quilt looks on this computer.</p></div>
    <div class="sec-body">
      <div class="segmented theme-switch" role="radiogroup" aria-label="Theme">
        ${THEMES.map(([v, label]) => `<button type="button" role="radio" data-theme-pick="${v}" class="${theme === v ? 'on' : ''}" aria-checked="${theme === v}">${theme === v ? I.check : ''}<span>${label}</span></button>`).join('')}
      </div>
      <span class="hint">System follows your computer's light or dark setting.</span>
    </div>
  </section>

  <form class="card settings-sec" id="sessions-sec" autocomplete="off">
    <div class="sec-intro"><h2>Sessions</h2><p>Defaults for starting and joining.</p></div>
    <div class="sec-body">
      <div class="field">
        <label for="s-joindir">Put projects you join in</label>
        <div class="row"><input class="input grow" id="s-joindir" name="joinDir" value="${esc(p.joinDir)}">
        <button type="button" class="btn icon" data-browse-settings="s-joindir" title="Browse" aria-label="Browse">${I.folder}</button></div>
        <span class="hint">Each session gets its own folder in here.</span>
      </div>
      ${toggle('shareAgent', p.shareAgent, 'Share my AI chat', 'Partners see your prompts, the replies and which files it touches. You can pause it inside any session.')}
      ${toggle('summarize', p.summarize, 'Summarize my chats', 'Your prompts and your AI’s replies are shortened to a sentence or two on this computer before they’re shared. Uses your claude CLI (a few Haiku tokens each); if it isn’t available, the text is just shortened.')}
      ${toggle('preferLocal', p.preferLocal, 'Keep my files when joining a folder that has some', 'When off, their versions of the same files win.')}
      ${toggle('report', p.report, 'Send problem reports to Quilt', 'The app tells Quilt which actions you take (not what you read), whether they worked and how long they took, with the error message when something fails, your app version and OS. Never your files, your chats or your links.')}
      <div class="sec-actions"><span></span><button class="btn primary" type="submit">Save</button></div>
    </div>
  </form>

  <section class="card settings-sec" id="about-sec">
    <div class="sec-intro"><h2>About Quilt</h2><p>${state.release?.outOfDate ? `Quilt ${esc(state.release.latest.version)} is out.` : 'The version on this computer.'}</p></div>
    <div class="sec-body">
      <div class="kv"><span>Version</span><span>${esc(state.release?.version || '…')}${state.release?.outOfDate ? ` <span class="pill warn">update available</span>` : state.release ? ' <span class="pill">up to date</span>' : ''}</span></div>
      <div class="sec-actions"><span class="hint">Everything that changed, release by release.</span><span class="row">
        ${state.release?.outOfDate ? updateControl() : ''}
        <button class="btn" type="button" data-release-notes>${I.sparkle}<span>What's new</span></button></span></div>
    </div>
  </section>

  <section class="card settings-sec">
    <div class="sec-intro"><h2>This computer</h2><p>Where Quilt keeps things.</p></div>
    <div class="sec-body">
      <div class="kv"><span>Identity key</span><code>~/.quilt/identity.json</code><span class="hint">Proves your name is yours. Copy it to another computer to keep your name there.</span></div>
      <div class="kv"><span>Sign-in</span><code>~/.quilt/account.json</code><span class="hint">This computer's sign-in. Only you can read it.</span></div>
      <div class="kv"><span>Settings</span><code>~/.quilt/settings.json</code></div>
      <div class="sec-actions"><span class="hint">Stops every session and this app. Your files stay put.</span><button class="btn" type="button" data-shutdown>${I.power}<span>Shut down Quilt</span></button></div>
    </div>
  </section>`
}

/**
 * The Agents card: your agents from the accounts API, and a one-time invite for a new one.
 * With workspaces on, each agent's placement loads first, so its row (Available in and Joins
 * included) draws once.
 */
function bindAgents (root) {
  const list = $('#agents-list', root)
  api('GET', '/api/agents').then(async ({ agents }) => {
    const on = state.workspacesOn
    const places = on ? await Promise.all(agents.map((a) => api('GET', `/api/agents/${encodeURIComponent(a.id)}/placement`).then((r) => r.placement, () => null))) : []
    const mine = placeableWorkspaces(state.workspaces)
    list.innerHTML = agents.length
      ? agents.map((a, i) => agentRow(a, places[i], mine)).join('') + (on && places.some(Boolean) ? '<p class="hint ap-note"><b>Available in</b>: the workspaces it is in without being added. <b>Joins</b>: every session there as it starts, or only when invited.</p>' : '')
      : '<p class="hint">No agents yet. Invite one below.</p>'
    if (on) bindPlacements(list, agents, places, mine)
  }).catch((err) => { list.innerHTML = `<p class="hint warn">${esc(err.message)}</p>` })
  const sec = $('#agents-sec', root)
  sec.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]')
    if (!b) return
    try { await navigator.clipboard.writeText($(`#${b.dataset.copy}`, sec).textContent); toast('Copied') } catch { toast('Select the text and press ⌘/Ctrl+C to copy') }
  })
  const btn = $('#agents-make', root)
  btn.onclick = async () => {
    btn.disabled = true
    try {
      const inv = await api('POST', '/api/agent-invites')
      $('#agents-invite', root).innerHTML = agentInviteHtml(agentPaste({ link: inv.link }), 'agents-paste')
      btn.innerHTML = `${I.bot}<span>Invite another</span>`
    } catch (err) {
      $('#agents-error', root).textContent = err.message
    }
    btn.disabled = false
  }
}

/** Wires the settings cards inside `root`; `refresh()` redraws them after a save. */
function bindSettings (root, refresh) {
  const saveForm = (form, pick, done) => {
    form.onsubmit = async (e) => {
      e.preventDefault()
      const btn = form.querySelector('button[type=submit]')
      btn.disabled = true
      try {
        state.profile = await api('POST', '/api/settings', pick(new FormData(form)))
        toast('Saved')
        refresh()
        done && done()
      } catch (err) {
        toast(err.message)
        btn.disabled = false
      }
    }
  }

  // Profile: live preview while picking. The name comes from the account.
  const prof = $('#profile-sec', root)
  const preview = () => {
    const f = new FormData(prof)
    $('#pv', root).querySelector('.avatar').outerHTML = avatar(state.profile.name, f.get('color') || null)
    $('#pv-tool', root).textContent = `coding with ${f.get('tool')}`
  }
  prof.addEventListener('input', preview)
  prof.addEventListener('change', preview)
  saveForm(prof, (f) => ({ color: f.get('color'), tool: f.get('tool') }))

  const sess = $('#sessions-sec', root)
  sess.querySelector('[data-browse-settings]').onclick = () => pickFolder($('#s-joindir', root))
  saveForm(sess, (f) => ({ joinDir: f.get('joinDir'), shareAgent: !!f.get('shareAgent'), summarize: !!f.get('summarize'), preferLocal: !!f.get('preferLocal'), report: !!f.get('report') }))

  // Appearance applies at once; the server puts it on <html> at the next launch.
  $('#appearance-sec', root).addEventListener('click', async (e) => {
    const pick = e.target.closest('[data-theme-pick]')
    if (!pick || pick.classList.contains('on')) return
    const before = document.documentElement.dataset.theme
    document.documentElement.dataset.theme = pick.dataset.themePick
    try {
      state.profile = await api('POST', '/api/settings', { theme: pick.dataset.themePick })
      refresh()
    } catch (err) {
      document.documentElement.dataset.theme = before
      toast(err.message)
    }
  })

  bindAgents(root)

  $('#sign-out', root).onclick = async () => {
    if (!await ask({ title: 'Sign out of Quilt?', message: 'This stops your sessions on this computer. Your files stay where they are.', ok: 'Sign out', danger: true })) return
    try {
      await api('POST', '/api/account/signout')
      signedOutNow()
    } catch (err) {
      toast(err.message)
    }
  }
}

/**
 * Settings in a pop-up, for inside a session: the same cards as the Settings page, so you
 * can change your profile without leaving. Saving redraws the cards in place.
 */
export function openSettings () {
  $('#settings-back')?.remove()
  const back = document.createElement('div')
  back.id = 'settings-back'
  back.className = 'modal-back settings-back'
  back.innerHTML = `
  <div class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <header class="settings-head">
      <h2 id="settings-title">${I.gear}<span>Settings</span></h2>
      <p>Saved on this computer and used for every new session.</p>
      <button class="btn icon ghost settings-close" type="button" data-settings-close aria-label="Close">${I.x}</button>
    </header>
    <div class="settings-body" id="settings-body"></div>
  </div>`
  document.body.appendChild(back)
  const body = $('#settings-body', back)
  const draw = () => {
    const scroll = body.scrollTop
    body.innerHTML = settingsHtml({ head: false })
    bindSettings(body, draw)
    body.scrollTop = scroll
    // The sidebar's profile card, if it is showing, follows the saved profile.
    if (state.shellView && $('#app .side')) renderShell(state.shellView)
  }
  draw()
  const close = () => back.remove()
  back.addEventListener('mousedown', (e) => { if (e.target === back) close() })
  back.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })
  back.querySelector('[data-settings-close]').onclick = close
  back.querySelector('[data-settings-close]').focus()
}
