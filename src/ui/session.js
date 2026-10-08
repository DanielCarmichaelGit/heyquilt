// The session workspace: file tree on the left, a partner's live AI chat, a
// shared file, or the task board in the middle, and the team chat on the right.
import { TOKEN, I, state, $, esc, basename, bytes, clock, ago, avatar, toast, api, ask, remember, recall, toolsOf, busyPeople, NO_POSTING, ACCOUNT_KEY, loadAccessTypes, typeOptions, accessLine } from './common.js'
import { openInvite, renderTabs, markRead } from './app.js'
import { renderFeed } from './feed.js'
import { conversations } from './feed-convs.js'
import { renderTree, openTreeMenu, closeTreeMenu, claimFolder } from './tree.js'
import { renderFileView } from './fileview.js'
import { changesMarkup, bindChanges, unbindChanges, changesChanged } from './changes.js'
import { quiltMark } from './mark.js'
import { openSettings } from './home.js'
import { fileCardHref, renderable, textHtml, mentionAt, mentionCandidates, completeMention, ALL_AGENTS, foldPersonas, aiOwners, shownName, ownAiChatter } from './chat.js'
import { renderBoard, taskNotesModalHtml } from './board.js'
import { accessFormValues, accessSaveBody, grantsLoading, grantsLoaded, grantsFailed } from './access-form.js'
import { renderMergeBar, bindMerges, renderMergeView } from './merges.js'
import { workspaceFilePicker } from './files.js'
import { sessionAgentsHtml } from './agent-place.js'
import { renderCatchUp, bindCatchUp } from './catchup.js'
import { branchMenuHtml, upstreamText, needsHand } from './branches.js'

let current = null // session id being shown
let timers = []
let holdNoteTimer = null // shows the "git is busy" note once a hold has lasted HOLD_NOTE_MS
const HOLD_NOTE_MS = 1000 // a `git add` holds for a moment: no note flashing by for it
let grantLoad = grantsLoading() // this session's grants (the owner's view, from the API), for the Access sections
let wsAgents = { id: null, agents: [] } // the agents this session's workspace invites (workspaces on), for its People
let mounted = null // AbortController for document-level listeners of this mount

// ------------------------------------------------------------ layout state --
// Per session: mode ('ai' | 'files' | 'merge'), open tabs per mode, expanded folders.
function ws (id) {
  if (!state.ws.has(id)) {
    let saved = null
    try { saved = JSON.parse(recall(`ws-${id}`, 'null')) } catch {}
    state.ws.set(id, {
      mode: 'ai',
      aiTabs: [],
      aiSel: null,
      convSel: {}, // person -> pinned conversation id (absent: follow the newest)
      fileTabs: [],
      fileSel: null,
      mergeSel: null, // merge id shown in the compare view
      expanded: {},
      stale: {}, // file path -> changed while not visible
      ...(saved || {}),
      drawer: null
    })
  }
  return state.ws.get(id)
}

function saveWs (id) {
  const w = ws(id)
  const { drawer, stale, ...keep } = w
  remember(`ws-${id}`, JSON.stringify(keep))
}

const sum = () => state.sessions.get(current)
const me = () => sum()?.status.me.name

/** Who is here as people see them: each person's AI sessions as one "<person>'s AI". */
const peopleHere = (st) => foldPersonas(st.peers || [])

/** Whose AI session each name in this session is (chat.js aiOwners). */
function owners (s) {
  const st = s.status
  return aiOwners({ peers: st.peers, messages: renderable(state.messages.get(current)), people: [st.me?.name, ...(st.peers || []).map((p) => p.name), ...(st.members || []).map((m) => m.name)] })
}

function personInfo (name) {
  const st = sum().status
  if (name === st.me.name) return { ...st.me, online: st.connected, isMe: true }
  const p = st.peers.find((x) => x.name === name)
  return p ? { ...p, online: p.hosted ? 'http' : true } : { name, online: false, agent: null }
}

// ------------------------------------------------------------------ mount --
export function mountSession (id) {
  current = id
  pendingAssign = ''
  mounted = new AbortController()

  $('#app').innerHTML = `
  <div class="ws" id="ws">
    <header class="ws-top">
      <button class="brand" data-go="home" aria-label="Home">${quiltMark({ sew: 'first' })}</button>
      <nav class="tabs" id="tabs" aria-label="Sessions"></nav>
      <span class="spacer"></span>
      <span class="relay-problem" id="relay-problem" role="status" hidden></span>
      <span class="access-pill" id="access-pill" hidden></span>
      <div class="commit-wrap" id="commit-wrap">
        <button class="commit-chip" id="commit-chip" aria-haspopup="true" aria-expanded="false" aria-controls="commit-panel" hidden></button>
        <div class="popover commit-panel" id="commit-panel" role="dialog" aria-label="Commit requests" hidden></div>
      </div>
      <button class="btn sm ghost icon narrow-only" id="toggle-tree" title="Files" aria-label="Show files">${I.tree}</button>
      <div class="people" id="people">
        <button class="people-btn" id="people-btn" aria-haspopup="true" aria-expanded="false" aria-controls="people-menu"></button>
        <div class="popover people-menu" id="people-menu" role="dialog" aria-label="People in this session" hidden></div>
      </div>
      ${changesMarkup()}
      <div class="branch-wrap" id="branch-wrap" hidden>
        <button type="button" class="branch-label" id="branch-label" aria-haspopup="true" aria-expanded="false" aria-controls="branch-menu"></button>
        <div class="popover branch-menu" id="branch-menu" role="dialog" aria-label="Branches" hidden></div>
      </div>
      ${openInMarkup()}
      <button class="btn sm ghost" id="tasks-btn" type="button" aria-pressed="false" title="Tasks">${I.board}<span class="wide-only">Tasks</span><span class="tasks-n" id="tasks-count" hidden></span></button>
      <button class="btn sm primary" id="invite-btn">${I.link}<span class="wide-only">Invite</span></button>
      <button class="btn sm ghost icon narrow-only" id="toggle-chat" title="Chat" aria-label="Show chat">${I.chat}<span class="badge" id="chat-badge" hidden></span></button>
      <button class="btn sm ghost icon" id="settings-btn" type="button" title="Settings" aria-label="Settings">${I.gear}</button>
      <div class="overflow">
        <button class="btn sm ghost icon" id="more-btn" title="More" aria-label="More" aria-haspopup="true" aria-expanded="false">${I.more}</button>
        <div class="popover more-menu" id="more-menu" role="menu" hidden>
          <button class="pop-item" role="menuitem" id="rename-btn" hidden>Rename session…</button>
          <button class="pop-item" role="menuitem" id="ask-commit">Ask for a commit…</button>
          <button class="pop-item" role="menuitem" id="leave-btn">Leave this session</button>
          <button class="pop-item" role="menuitem" data-shutdown>Shut down Quilt</button>
        </div>
      </div>
    </header>
    <div class="ws-body" id="ws-body">
      <aside class="ws-tree" aria-label="Project files">
        <div class="pane-head">
          <button type="button" class="tree-collapse wide-tree" id="collapse-tree" title="Collapse files" aria-expanded="true" aria-controls="tree">${I.arrowLeft}</button>
          <span class="pane-title">Files</span><span class="hint" id="file-count"></span>
        </div>
        <div class="tree-scroll" id="tree"></div>
      </aside>
      <main class="ws-main">
        <div class="requests catchup" id="catchup" role="region" aria-label="While you were away" hidden></div>
        <div class="requests" id="requests" hidden></div>
        <div class="requests merges" id="merges" hidden></div>
        <div class="ws-mainbar" id="mainbar" hidden>
          <div class="ws-tabs" id="main-tabs" role="tablist"></div>
        </div>
        <div class="ws-content" id="main"></div>
      </main>
      <aside class="ws-chat" id="chat-pane" aria-label="Chat">
        <div class="chat-head"><h3>Chat</h3><span class="hint" id="chat-sub"></span></div>
        <div class="messages" id="messages"></div>
        <div class="drop">Drop files to send</div>
        <form class="composer" id="composer">
          <div class="to"><label for="to-select">To</label><select id="to-select"></select></div>
          <div class="attachments" id="attachments"></div>
          <div class="mention-menu" id="mention-menu" role="listbox" aria-label="Mention someone" hidden></div>
          <div class="box">
            <button type="button" class="btn ghost icon" id="attach-btn" title="Send a file" aria-label="Send a file">${I.clip}</button>
            ${sum()?.workspace ? `<button type="button" class="btn ghost icon" data-attach-workspace title="Attach from workspace" aria-label="Attach from workspace">${I.folder}</button>` : ''}
            <input type="file" id="file-input" multiple hidden>
            <textarea id="msg-input" rows="1" placeholder="Message everyone…"></textarea>
            <button type="submit" class="btn primary icon" id="send-btn" title="Send" aria-label="Send">${I.send}</button>
          </div>
        </form>
      </aside>
      <div class="scrim" id="scrim"></div>
    </div>
  </div>`

  bindTop()
  bindAccess()
  for (const el of [$('#merges'), $('#main')]) bindMerges(el, { sessionId: () => current, onCompare: openMerge, editors: editorsByPreference })
  bindChanges(id, mounted.signal, { onOpen: openFile })
  bindCatchUp($('#catchup'), { sessionId: () => current, onOpen: openFile })
  bindMain()
  bindTreeEvents()
  applyTreeCollapsed()
  bindChat()
  bindBoard()
  renderTop()
  renderMainBar()
  renderMain()
  renderTreePane()
  renderMessages(false, true)
  renderRecipients()
  renderComposer()
  grantLoad = grantsLoading()
  // The approve control and the people menu offer access types once they're here.
  loadAccessTypes().then(() => { if (current === id) { renderAccess(); if (!$('#people-menu').hidden) renderPeopleMenu() } })
  loadTree()
  loadFeeds()
  const shown = ws(id).mode === 'merge' && shownMerge()
  if (shown && !shown.binary) refreshFile(shown.path, false) // the cached copy may be from before
  autoOpenNewPeople(id) // everyone already here gets a tab on first visit
  // Relative times ("4s ago") and recent-edit badges age out.
  timers.push(setInterval(() => { renderTreePane(); renderTop() }, 15000))
}

export function sessionUnmount () {
  for (const t of timers) clearInterval(t)
  timers = []
  clearTimeout(holdNoteTimer)
  if (mounted) mounted.abort()
  mounted = null
  closeTreeMenu()
  pendingAssign = ''
  unbindChanges()
  current = null
}

// ------------------------------------------------------------ live events --
let lastAccessState = null
export function sessionUpdated (id) {
  if (id !== current) return
  const accState = sum().status.access?.state || null
  if (accState !== lastAccessState) { lastAccessState = accState; renderMain(); loadTree() }
  autoOpenNewPeople(id)
  renderTop()
  renderMainBar()
  renderRecipients()
  renderComposer()
  if (ws(id).mode === 'ai') renderMain()
  if (ws(id).mode === 'tasks') paintBoard()
  scheduleTree()
  changesChanged()
}

export function sessionMessage (id) {
  if (id !== current) return
  renderMessages(true)
  const w = ws(id)
  if (w.drawer !== 'chat' && window.matchMedia('(max-width: 900px)').matches) {
    const b = $('#chat-badge')
    if (b) { b.hidden = false; b.textContent = '•' }
  }
}

export function sessionLog () {}

export function sessionFeed (id, entries) {
  const feeds = state.feeds.get(id)
  if (!feeds) return
  const touched = new Set()
  for (const e of entries) {
    if (!feeds.has(e.by)) continue // not loaded yet; fetched when opened
    const list = feeds.get(e.by)
    if (!list.some((x) => x.id === e.id)) list.push(e)
    if (list.length > 300) list.splice(0, list.length - 300)
    touched.add(e.by)
  }
  if (id !== current) return
  const w = ws(id)
  if (w.mode === 'ai' && touched.has(w.aiSel)) renderMain()
  renderMainBar()
}

export function sessionFileChanged (id, { path }) {
  if (id !== current) return
  scheduleTree()
  changesChanged()
  const w = ws(id)
  if (w.mode === 'merge' && shownMerge()?.path === path) refreshFile(path, false)
  if (w.fileTabs.includes(path)) {
    if (w.mode === 'files' && w.fileSel === path) refreshFile(path, true)
    else { w.stale[path] = true; renderMainBar() }
  }
}

/** Someone new joined: give them an AI tab once (closing it sticks). */
function autoOpenNewPeople (id) {
  const w = ws(id)
  w.autoOpened = w.autoOpened || []
  let changed = false
  let grew = false
  for (const p of sum().status.peers) {
    if (p.persona) continue // an AI session working through someone's app has no AI chat of its own to show
    if (w.autoOpened.includes(p.name)) continue
    w.autoOpened.push(p.name)
    grew = true
    if (!w.aiTabs.includes(p.name)) {
      w.aiTabs.push(p.name)
      if (!w.aiSel) w.aiSel = p.name
      changed = true
      loadFeed(p.name)
    }
  }
  if (changed) { saveWs(id); renderMainBar(); if (w.mode === 'ai') renderMain() }
  else if (grew) saveWs(id)
}

// --------------------------------------------------------------- top bar --
// The AI apps installed here, the one from your profile first, so your AI works
// in the synced folder and its chats reach the feed.
function editorsByPreference () {
  const all = state.defaults.editors || []
  const mine = all.find((e) => e.tool === state.profile?.tool)
  return mine ? [mine, ...all.filter((e) => e !== mine)] : all
}

function openInMarkup () {
  const [first, ...rest] = editorsByPreference()
  if (!first) return ''
  return `<div class="open-in overflow">
    <button class="btn sm" data-open-in="${esc(first.id)}">Open in ${esc(first.name)}</button>${rest.length ? `
    <button class="btn sm icon" id="open-in-more" title="Open in another app" aria-label="Open in another app" aria-haspopup="true" aria-expanded="false">${I.chevDown}</button>
    <div class="popover more-menu" id="open-in-menu" role="menu" hidden>
      ${rest.map((e) => `<button class="pop-item" role="menuitem" data-open-in="${esc(e.id)}">Open in ${esc(e.name)}</button>`).join('')}
    </div>` : ''}
  </div>`
}

function bindOpenIn () {
  const wrap = $('.open-in')
  if (!wrap) return
  const moreBtn = $('#open-in-more')
  const menu = $('#open-in-menu')
  const setMenu = (open) => { if (menu) { menu.hidden = !open; moreBtn.setAttribute('aria-expanded', String(open)) } }
  if (moreBtn) moreBtn.onclick = () => setMenu(menu.hidden)
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setMenu(false); moreBtn?.focus() } })
  document.addEventListener('mousedown', (e) => { if (!wrap.contains(e.target)) setMenu(false) }, { signal: mounted.signal })
  wrap.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-open-in]')
    if (!b) return
    setMenu(false)
    try { await api('POST', `/api/sessions/${current}/open-in`, { app: b.dataset.openIn }) } catch (err) { toast(err.message) }
  })
}

function bindTop () {
  $('#tasks-btn').onclick = () => {
    const w = ws(current)
    if (w.mode === 'tasks') w.mode = w.aiSel ? 'ai' : w.fileSel ? 'files' : 'ai'
    else w.mode = 'tasks'
    saveWs(current)
    renderMainBar()
    renderMain()
    renderTop()
    if (w.mode === 'tasks') $('#task-add')?.focus()
  }
  $('#invite-btn').onclick = () => openInvite(current)
  bindOpenIn()
  $('#ask-commit').onclick = askForCommit
  $('#rename-btn').onclick = renameSession
  bindCommitChip()
  $('#leave-btn').onclick = async () => {
    if (!await ask({ title: 'Leave this session?', message: 'Quilt stops syncing this folder. Your files stay where they are, and you can rejoin later.', ok: 'Leave', danger: true })) return
    await api('POST', `/api/sessions/${current}/stop`).catch((err) => toast(err.message))
  }
  $('#settings-btn').onclick = () => openSettings()
  bindBranchMenu()
  const moreBtn = $('#more-btn')
  const moreMenu = $('#more-menu')
  const setMore = (open) => { moreMenu.hidden = !open; moreBtn.setAttribute('aria-expanded', String(open)) }
  moreBtn.onclick = () => setMore(moreMenu.hidden)
  moreMenu.addEventListener('click', () => setMore(false))
  moreMenu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setMore(false); moreBtn.focus() } })
  document.addEventListener('mousedown', (e) => { if (!moreBtn.parentElement.contains(e.target)) setMore(false) }, { signal: mounted.signal })
  const wrap = $('#people')
  const btn = $('#people-btn')
  const menu = $('#people-menu')
  let hoverTimer
  let openedAt = 0
  const open = () => {
    clearTimeout(hoverTimer)
    if (!menu.hidden) return
    menu.hidden = false; openedAt = Date.now(); btn.setAttribute('aria-expanded', 'true'); renderPeopleMenu()
    if (sum().status.access?.owner) { loadGrants(); if (state.workspacesOn) loadSessionAgents() }
  }
  const close = () => { clearTimeout(hoverTimer); menu.hidden = true; btn.setAttribute('aria-expanded', 'false') }
  // A click also focuses (and may hover) the button, which already opened the menu; don't toggle it shut.
  btn.onclick = () => (menu.hidden ? open() : Date.now() - openedAt > 400 && close())
  wrap.addEventListener('mouseenter', () => { if (window.matchMedia('(hover: hover)').matches) open() })
  wrap.addEventListener('mouseleave', () => {
    // Don't close while someone's typing in the menu.
    if (menu.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return
    hoverTimer = setTimeout(close, 250)
  })
  btn.addEventListener('focus', open)
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); btn.focus() } })
  document.addEventListener('mousedown', (e) => { if (!wrap.contains(e.target)) close() }, { signal: mounted.signal })

  menu.addEventListener('change', async (e) => {
    if (e.target.matches('[data-share]')) {
      const on = e.target.checked
      try {
        await api('POST', `/api/sessions/${current}/sharing`, { on })
        toast(on ? 'Sharing your AI chat again' : 'Paused sharing your AI chat')
      } catch (err) { toast(err.message); e.target.checked = !on }
      return
    }
    if (e.target.matches('[data-admit-by]')) {
      const admitBy = e.target.value
      try {
        await api('POST', `/api/sessions/${current}/admit-by`, { admitBy })
        toast(admitBy === 'owner' ? 'Only you can let people in' : admitBy === 'editors' ? 'Anyone who can edit may let people in' : 'Anyone in the session may let people in')
      } catch (err) { toast(err.message); renderPeopleMenu({ force: true }) }
      return
    }
    if (!e.target.matches('[data-summarize]')) return
    const on = e.target.checked
    try {
      await api('POST', `/api/sessions/${current}/summarize`, { on })
      toast(on ? 'Your prompts and replies are summarized before sharing' : 'Sharing your AI chat word for word')
    } catch (err) { toast(err.message); e.target.checked = !on }
  })
  menu.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-person],[data-dm],[data-sharing]')
    if (!t) return
    if (t.dataset.sharing) {
      const on = t.dataset.sharing === 'on'
      try {
        await api('POST', `/api/sessions/${current}/sharing`, { on })
        toast(on ? 'Sharing your AI chat again' : 'Paused sharing your AI chat')
      } catch (err) { toast(err.message) }
      return
    }
    if (t.dataset.dm) {
      state.to = t.dataset.dm
      renderRecipients()
      openDrawer('chat')
      $('#msg-input').focus()
      close()
      return
    }
    openPerson(t.dataset.person)
    close()
  })
  menu.addEventListener('change', async (e) => {
    const f = e.target.closest('.pm-member.edit')
    // Access types are saved with Save (below), not on every change; a chat link's time with Extend.
    if (!f || f.classList.contains('pm-access') || f.classList.contains('pm-chat')) return
    try {
      await api('POST', `/api/sessions/${current}/members/set`, { key: f.dataset.key, role: f.role.value, ...(f.scopes ? { scopes: parseScopes(f.scopes.value) } : {}) })
      toast('Access updated')
    } catch (err) { toast(err.message) }
  })
  menu.addEventListener('click', (e) => {
    if (!e.target.closest('[data-retry-grants]')) return
    grantLoad = grantsLoading()
    renderPeopleMenu({ force: true })
    loadGrants()
  })
  menu.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-extend-chat]')
    if (!b) return
    const f = b.closest('.pm-chat')
    b.disabled = true
    try {
      const r = await api('POST', `/api/sessions/${current}/chat-link/extend`, { key: f.dataset.key, minutes: Number(f.minutes.value) })
      toast(`${r.name}: ${chatTimeLeft(r.expiresAt)}`)
      // The menu doesn't redraw under a focused row: show the new time now, and let it redraw.
      f.querySelector('.pm-now').textContent = chatTimeLeft(r.expiresAt)
      b.blur()
    } catch (err) { toast(err.message) } finally { b.disabled = false }
  })
  menu.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-remove]')
    if (!b) return
    const f = b.closest('.pm-member')
    if (!await ask({ title: `Remove ${f.querySelector('.nm').textContent.trim()}?`, message: 'They\'ll need a new invite and your approval to come back.', ok: 'Remove', danger: true })) return
    try { const r = await api('POST', `/api/sessions/${current}/members/remove`, { key: f.dataset.key }); toast(r.warning || 'Removed') } catch (err) { toast(err.message) }
    // In a workspace, a removed agent is no longer invited here (the removal answers once that is written): list it now.
    if (state.workspacesOn && f.dataset.key.startsWith('agent:')) loadSessionAgents()
  })
  // Invited from the workspace: Don't invite (a keep-out) and Invite (which sends it the link now).
  menu.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-agent-uninvite],[data-agent-invite]')
    if (!b) return
    const invite = 'agentInvite' in b.dataset
    b.disabled = true
    try {
      const r = await api('POST', `/api/sessions/${current}/agents/${invite ? 'include' : 'exclude'}`, { agentId: b.dataset.agentInvite || b.dataset.agentUninvite })
      toast(!invite ? 'Not invited to this session' : r.notified ? 'Invited: it was sent this session\'s link' : 'Invited. It has no webhook, so send it this session\'s link')
    } catch (err) { toast(err.message); b.disabled = false }
    loadSessionAgents()
  })
  menu.addEventListener('click', async (e) => {
    if (e.target.closest('[data-end-session]')) {
      if (!await ask({ title: 'End this session for everyone?', message: 'Everyone is disconnected, and the session and its stored files are deleted from the relay. Your own folder is not touched.', ok: 'End session', danger: true })) return
      try { await api('POST', `/api/sessions/${current}/end`); toast('Session ended') } catch (err) { toast(err.message) }
      return
    }
  })
  menu.addEventListener('submit', async (e) => {
    const f = e.target.closest('.pm-access')
    if (!f) return
    e.preventDefault()
    // Only what was loaded: never a default type saved over a grant we haven't seen.
    const body = accessSaveBody(grantLoad, state.accessTypes, f.dataset.key, { typeId: f.typeId.value, viewOnly: f.viewOnly.checked, noTalk: f.noTalk.checked, foldersRemove: f.foldersRemove.value })
    if (!body) return toast('Their access is still loading. Try again in a moment.')
    const save = f.querySelector('[type=submit]')
    save.disabled = true
    try {
      const r = await api('POST', `/api/sessions/${current}/members/access`, body)
      grantLoad.grants.set(f.dataset.key, r.grant)
      toast('Access updated')
      // The relay's member list may have redrawn the form meanwhile, from the old grant.
      save.blur()
      renderPeopleMenu()
    } catch (err) { toast(err.message) } finally { save.disabled = false }
  })
  menu.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (e.target.closest('.pm-member')) return
    const input = menu.querySelector('#focus-input')
    await api('POST', `/api/sessions/${current}/focus`, { text: input.value }).catch((err) => toast(err.message))
    toast(input.value ? 'Focus shared' : 'Focus cleared')
    input.blur()
  })

  $('#toggle-tree').onclick = () => toggleDrawer('tree')
  $('#toggle-chat').onclick = () => { toggleDrawer('chat'); $('#chat-badge').hidden = true }
  $('#scrim').onclick = () => toggleDrawer(null)
}

function toggleDrawer (which) {
  const w = ws(current)
  openDrawer(w.drawer === which ? null : which)
}

function openDrawer (which) {
  const w = ws(current)
  w.drawer = which
  $('#ws-body').dataset.drawer = which || ''
}

/** The title and dot before a member's name: green when connected, blue when an agent over HTTP checked in lately. */
function memberDot (m) {
  const [title, color] = m.http ? ['Online over HTTP (checked in within 30 minutes)', 'var(--http)'] : m.online ? ['Online', 'var(--ok)'] : ['Offline', 'var(--faint)']
  return `title="${title}"><span class="dot" style="background:${color}"></span>`
}

function agentLine (p) {
  if (p.hosted) return `<span class="ai-state http" title="Connected over HTTP: shown as here for 30 minutes after each check-in">Over HTTP · ${p.lastSeen ? `checked in ${ago(p.lastSeen) === 'now' ? 'just now' : `${ago(p.lastSeen)} ago`}` : 'checked in lately'}</span>`
  const a = p.agent
  if (!a || (!a.tool && a.status !== 'unavailable' && a.sharing !== false)) return p.online ? 'No AI activity found yet' : ''
  if (a.sharing === false) return `<span class="ai-state paused">${p.isMe ? 'You paused sharing' : 'Paused sharing'}</span>`
  if (a.status === 'unavailable') return `<span class="ai-state off" title="${esc(a.reason || '')}">${esc(a.tool || 'AI')} feed unavailable</span>`
  if (a.status === 'working') return `<span class="ai-state working"><span class="pulse"></span>${esc(a.tool || 'AI')} is working…</span>`
  return `<span class="ai-state">${a.tool ? `${esc(a.tool)} idle` : 'AI idle'}</span>`
}

// ------------------------------------------------------------- branches --
let branchSyncing = false

function renderBranchMenu () {
  const st = sum().status
  $('#branch-menu').innerHTML = branchMenuHtml({ git: st.git, branches: st.branches || [], me: st.me.name, syncing: branchSyncing })
}

function bindBranchMenu () {
  const btn = $('#branch-label')
  const menu = $('#branch-menu')
  const set = (open) => {
    menu.hidden = !open
    btn.setAttribute('aria-expanded', String(open))
    if (open) renderBranchMenu()
  }
  btn.onclick = () => set(menu.hidden)
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { set(false); btn.focus() } })
  document.addEventListener('mousedown', (e) => { if (!menu.hidden && !$('#branch-wrap').contains(e.target)) set(false) }, { signal: mounted.signal })
  menu.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-branch-sync]') || branchSyncing) return
    branchSyncing = true
    renderBranchMenu()
    const id = current
    try { await api('POST', `/api/sessions/${id}/branches/sync`) } catch (err) { toast(err.message) } finally {
      branchSyncing = false
      if (id === current && !menu.hidden) renderBranchMenu()
    }
  })
}

function renderTop () {
  if (!current || !$('#people-btn')) return
  renderTabs()
  const st = sum().status
  const g = st.git
  const label = $('#branch-label')
  if (label) {
    $('#branch-wrap').hidden = !g
    if (g) {
      // Moving to another branch: said at once. Git busy: only once it has lasted a moment.
      const held = g.hold ? Date.now() - g.hold.since : 0
      const note = g.hold && (g.hold.kind === 'switching' || held >= HOLD_NOTE_MS)
      clearTimeout(holdNoteTimer)
      if (g.hold && !note) holdNoteTimer = setTimeout(renderTop, HOLD_NOTE_MS - held + 20)
      const tag = note ? (g.hold.kind === 'switching' ? `moving to ${esc(g.hold.to || '?')}…` : g.hold.conflict ? 'paused: resolve the git conflict' : 'syncing paused: git is busy') : ''
      const up = g.upstream
      const behind = !tag && up && (up.behind || up.diverged) ? `<span class="tag${needsHand(up) ? ' warn' : ''}">${needsHand(up) ? 'needs a pull' : `${up.behind} behind`}</span>` : ''
      label.innerHTML = `${I.branch}<span class="branch-name">${esc(g.key)}</span>${tag ? `<span class="tag" title="${tag}">${tag}</span>` : ''}${behind}`
      label.title = g.hold ? (g.hold.kind === 'switching' ? `You checked out ${g.hold.to || 'another branch'} in git: this folder is moving to that branch's work in the session. The branch it left keeps its own.` : g.hold.conflict ? `git left a conflict in ${g.hold.conflict.join(', ')} on this computer. Resolve it and git add it; Quilt then shares your resolution.` : 'Quilt waits for git to finish, then catches up.') : `This folder is on ${g.key}${up ? `, ${upstreamText(up)}` : ''}. Click for every branch in the session.`
      if (!$('#branch-menu').hidden) renderBranchMenu()
    }
  }
  const people = [st.me, ...peopleHere(st)]
  const shown = people.slice(0, 4)
  $('#people-btn').innerHTML = `<span class="stack">${shown.map((p, i) => `<span style="z-index:${10 - i}">${avatar(p.name, p.color)}</span>`).join('')}</span>
    <span class="count">${people.length}</span><span class="conn ${st.connected ? 'ok' : 'warn'}" title="${st.connected ? 'Connected' : esc(st.problem || 'Reconnecting…')}"></span>`
  $('#people-btn').setAttribute('aria-label', `${people.length} ${people.length === 1 ? 'person' : 'people'} in this session${st.connected ? '' : ', reconnecting'}`)
  // Why we're offline, when we know: otherwise "Reconnecting…" can go on silently forever.
  const problem = $('#relay-problem')
  if (problem) {
    problem.hidden = st.connected || !st.problem
    problem.textContent = st.connected ? '' : (st.problem || '')
    problem.title = problem.textContent ? `${problem.textContent}. Quilt keeps retrying.` : ''
  }
  if (!$('#people-menu').hidden) renderPeopleMenu()
  renderAccess()
  renderCatchUp($('#catchup'), st.catchUp, { colors: new Map([st.me, ...st.peers].map((p) => [p.name, p.color])) })
  renderMerges()
  renderCommitChip()
  $('#rename-btn').hidden = !st.access?.owner
  renderTaskButton()
  $('#chat-sub').textContent = st.peers.length ? `with ${peopleHere(st).map((p) => p.sessions && p.mine ? 'your AI' : p.name).join(', ')}` : 'just you so far'
}

// ---------------------------------------------------------- commit timing --
function bindCommitChip () {
  const wrap = $('#commit-wrap')
  const chip = $('#commit-chip')
  const panel = $('#commit-panel')
  const setOpen = (open) => {
    panel.hidden = !open
    chip.setAttribute('aria-expanded', String(open))
    if (open) renderCommitPanel()
  }
  chip.onclick = () => setOpen(panel.hidden)
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setOpen(false); chip.focus() } })
  document.addEventListener('mousedown', (e) => { if (!wrap.contains(e.target)) setOpen(false) }, { signal: mounted.signal })
  panel.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-done]')
    if (!b) return
    b.disabled = true
    try {
      const id = b.dataset.done === 'all' ? null : b.dataset.done
      const r = await api('POST', `/api/sessions/${current}/commit-request/done`, id ? { id } : {})
      toast(r.done === 1 ? 'Marked done' : `Marked ${r.done} done`)
    } catch (err) { toast(err.message); b.disabled = false }
  })
}

function renderCommitChip () {
  const chip = $('#commit-chip')
  if (!chip) return
  const s = sum()
  const st = s.status
  const open = (st.commits || []).filter((r) => r.state === 'open')
  const busy = busyPeople(st)
  chip.hidden = !open.length
  if (!open.length) { $('#commit-panel').hidden = true; return }
  chip.className = `commit-chip${busy.length ? '' : ' ready'}`
  chip.innerHTML = busy.length
    ? `${I.branch}<span>Commit requested · waiting on ${busy.length}</span>`
    : `${I.branch}<span>Ready to commit</span>`
  chip.title = `${open.map((r) => `${r.by}: ${r.message}`).join('\n')}${busy.length ? `\nStill working: ${busy.join(', ')}` : ''}`
  if (!$('#commit-panel').hidden) renderCommitPanel()
}

/** Open requests, each with a Done button, and Mark all done. */
function renderCommitPanel () {
  const panel = $('#commit-panel')
  if (!panel) return
  const open = (sum().status.commits || []).filter((r) => r.state === 'open')
  panel.innerHTML = open.length
    ? `<ul class="commit-reqs">${open.map((r) => `<li><b>${esc(r.by)}</b><div>${esc(r.message)}</div><button type="button" class="btn sm ghost" data-done="${esc(r.id)}">Done</button></li>`).join('')}</ul>
       <div class="commit-foot"><button type="button" class="btn sm" data-done="all">Mark all done</button></div>`
    : '<p class="hint">No open commit requests.</p>'
}

async function askForCommit () {
  const message = await ask({ title: 'Ask for a commit', message: 'Everyone sees the request until someone commits and marks it done.', ok: 'Ask', input: { label: 'What is the commit for?', placeholder: 'Pricing page and download button' } })
  if (!message) return
  try {
    await api('POST', `/api/sessions/${current}/commit-request`, { message: message.trim() })
    toast('Asked for a commit')
  } catch (err) { toast(err.message) }
}

// ----------------------------------------------------------------- access --
const roleLabel = (r) => r === 'owner' ? 'Owner' : r === 'viewer' ? 'View only' : 'Can edit'
const scopesText = (scopes) => (scopes || []).join(', ')
const parseScopes = (text) => String(text || '').split(',').map((x) => x.trim()).filter(Boolean)

/** The access pill, the request bar for anyone who may let people in, and the waiting screen. */
function renderAccess () {
  const st = sum().status
  const acc = st.access || {}
  const pill = $('#access-pill')
  if (pill) {
    const parts = acc.state === 'pending' ? ['Waiting to be let in'] : !acc.controlled ? [] : [
      ...(acc.role === 'viewer' ? ['View only'] : acc.scopes && acc.scopes.length ? [`Can change ${scopesText(acc.scopes)}`] : []),
      ...(acc.role !== 'viewer' && acc.scopesExcept && acc.scopesExcept.length ? [`Not ${scopesText(acc.scopesExcept)}`] : []),
      ...(acc.talk === false ? ["Can't post"] : [])
    ]
    const text = parts.join(' · ')
    pill.hidden = !text
    pill.textContent = text
    pill.className = `access-pill${acc.state === 'pending' ? ' wait' : ''}`
  }
  const bar = $('#requests')
  if (!bar) return
  const waiting = st.waiting || []
  // Don't redraw while someone is filling in a request (the type picker is a button, see
  // startDropdowns), only once they've let someone in or denied them.
  const active = document.activeElement
  if (bar.contains(active) && !active.closest('[type=submit],[data-deny]')) return
  bar.hidden = !waiting.length
  // Access types (and their grants) belong to the owner; others who may admit pick a role.
  const asType = !!(state.accessTypes && acc.owner)
  bar.innerHTML = waiting.map((p) => `
    <form class="request" data-key="${esc(p.key)}">
      ${avatar(p.name, null)}
      <div class="rq-main"><b>${esc(p.name)}</b>${p.kind === 'agent' ? `<span class="tag bot">${I.bot}agent</span>` : ''}
        <span class="hint">wants to join · invited to ${p.invitedAs === 'viewer' ? 'view' : 'edit'}</span></div>
      ${asType
        ? `<select class="input" name="typeId" aria-label="Let ${esc(p.name)} in as" title="What they may do: an access type">${typeOptions()}</select>`
        : `<select class="input" name="role" aria-label="Role for ${esc(p.name)}">
        <option value="editor" ${p.invitedAs !== 'viewer' ? 'selected' : ''}>Can edit</option>
        <option value="viewer" ${p.invitedAs === 'viewer' ? 'selected' : ''}>View only</option>
      </select>
      ${p.kind === 'agent' ? `<input class="input" name="scopes" placeholder="All folders (or e.g. src, docs)" aria-label="Folders ${esc(p.name)} may change" title="Folders this agent may change, separated by commas">` : ''}`}
      <button type="button" class="btn sm ghost" data-deny>Deny</button>
      <button type="submit" class="btn sm primary">Let in</button>
    </form>`).join('')
}

function bindAccess () {
  const bar = $('#requests')
  bar.addEventListener('submit', async (e) => {
    e.preventDefault()
    const f = e.target
    const btn = f.querySelector('[type=submit]')
    btn.disabled = true
    try {
      const body = f.typeId ? { key: f.dataset.key, typeId: f.typeId.value } : { key: f.dataset.key, role: f.role.value, scopes: f.scopes ? parseScopes(f.scopes.value) : [] }
      const r = await api('POST', `/api/sessions/${current}/members/approve`, body)
      toast(r.warning || 'Let in')
    } catch (err) { toast(err.message); btn.disabled = false }
  })
  bar.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-deny]')) return
    const f = e.target.closest('form')
    try { await api('POST', `/api/sessions/${current}/members/deny`, { key: f.dataset.key }); toast('Denied') } catch (err) { toast(err.message) }
  })
}

/** Owner only: renames the session for everyone in it, and on heyquilt.com. */
async function renameSession () {
  const s = sum()
  const name = await ask({ title: 'Rename this session', message: 'Everyone in it sees the new name, here and on heyquilt.com.', ok: 'Rename', input: { label: 'Name', value: s.status.sessionName || basename(s.dir) } })
  if (!name) return
  try { await api('POST', `/api/sessions/${current}/rename`, { name }); toast('Renamed') } catch (err) { toast(err.message) }
}

// ----------------------------------------------------------------- merges --
const isViewer = () => { const a = sum().status.access || {}; return !!(a.controlled && a.role === 'viewer') }
const shownMerge = () => (sum().status.merges || []).find((m) => m.id === ws(current).mergeSel) || null

// Status carries merge records without their texts; the compare view fetches
// the full record once. Keyed by session, id and state: ours and base never
// change for a record, but "edit by hand" and settling change its state.
const mergeTexts = new Map() // `${session}\n${id}\n${state}` -> { ours, base } | 'loading'
const mergeKey = (sid, m) => `${sid}\n${m.id}\n${m.state}`

/** The shown merge's ours and base, or undefined while they load. */
function fullMerge (m) {
  const sid = current
  const got = mergeTexts.get(mergeKey(sid, m))
  if (got && got !== 'loading') return got
  if (got) return undefined
  mergeTexts.set(mergeKey(sid, m), 'loading')
  api('GET', `/api/sessions/${sid}/merges`).then((r) => {
    for (const full of r.merges || []) mergeTexts.set(mergeKey(sid, full), { ours: full.ours ?? null, base: full.base ?? null })
    if (mergeTexts.get(mergeKey(sid, m)) === 'loading') mergeTexts.set(mergeKey(sid, m), { ours: null, base: null }) // gone meanwhile
    if (current === sid && ws(sid).mode === 'merge') renderMain()
  }).catch(() => {
    mergeTexts.set(mergeKey(sid, m), { ours: null, base: null }) // shown as not available, not refetched on every status
    if (current === sid && ws(sid).mode === 'merge') renderMain()
  })
  return undefined
}

/** The merge bar, and the compare view when it's showing (it only redraws on a change). */
function renderMerges () {
  const bar = $('#merges')
  if (!bar) return
  const merges = sum().status.merges || []
  renderMergeBar(bar, { merges, me: me(), editors: editorsByPreference(), viewer: isViewer() })
  const w = ws(current)
  if (w.mode !== 'merge' || !w.mergeSel) return
  // The same file can conflict again after its record was settled: the compare
  // tab then follows the new open record instead of showing the old one.
  const shown = merges.find((m) => m.id === w.mergeSel)
  if (shown && shown.state === 'done') {
    const next = merges.find((m) => m.path === shown.path && m.state !== 'done')
    if (next) { w.mergeSel = next.id; saveWs(current); renderMainBar() }
  }
  renderMain()
}

function openMerge (id) {
  const w = ws(current)
  w.mergeSel = id
  w.mode = 'merge'
  saveWs(current)
  renderMainBar()
  renderMain()
  renderTreePane()
  // Always fetch: a cached copy may be from before the session moved on.
  const m = shownMerge()
  if (m && !m.binary) refreshFile(m.path, false)
}

/** Owner controls for everyone who has been let in, shown in the people menu. */
function membersHtml (st) {
  const acc = st.access || {}
  if (!acc.controlled) return ''
  const list = (st.members || []).filter((m) => m.role !== 'owner')
  if (!acc.owner) {
    return list.length || st.members?.length ? `<div class="pm-section"><div class="pm-title">Access</div>
      ${(st.members || []).map((m) => m.chat && acc.canAdmit ? chatMemberRow(m, { remove: false }) : `<div class="pm-member"><span class="nm">${esc(m.name)}${m.kind === 'agent' ? ' (agent)' : ''}</span><span class="tag">${roleLabel(m.role)}</span>${m.scopes && m.scopes.length ? `<span class="hint">${esc(scopesText(m.scopes))}</span>` : ''}</div>`).join('')}</div>` : ''
  }
  const admitBy = st.admitBy || acc.admitBy || 'owner'
  const admitOpts = [
    ['owner', 'Only the owner'],
    ['editors', 'Anyone who can edit'],
    ['members', 'Anyone in the session']
  ].map(([v, label]) => `<option value="${v}" ${admitBy === v ? 'selected' : ''}>${label}</option>`).join('')
  return `<div class="pm-section"><div class="pm-title">Who can get in</div>
    <label class="pm-admit"><span>Who can let people in</span>
      <select class="input" name="admitBy" data-admit-by aria-label="Who can let people into this session">${admitOpts}</select>
    </label>
    ${list.length ? list.map((m) => m.chat ? chatMemberRow(m) : state.accessTypes && ACCOUNT_KEY.test(m.key) ? accessForm(m) : `
      <form class="pm-member edit" data-key="${esc(m.key)}">
        <span class="nm" ${memberDot(m)}${esc(m.name)}${m.kind === 'agent' ? ' (agent)' : ''}</span>
        <select class="input" name="role" aria-label="Role for ${esc(m.name)}">
          <option value="editor" ${m.role === 'editor' ? 'selected' : ''}>Can edit</option>
          <option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>View only</option>
        </select>
        ${m.kind === 'agent' ? `<input class="input" name="scopes" value="${esc(scopesText(m.scopes))}" placeholder="All folders" aria-label="Folders ${esc(m.name)} may change" title="Folders this agent may change, separated by commas">` : ''}
        <button type="button" class="btn sm ghost icon" data-remove title="Remove ${esc(m.name)}" aria-label="Remove ${esc(m.name)}">${I.x}</button>
      </form>`).join('') : '<div class="pm-empty">Only you so far. People you let in show up here.</div>'}
    </div>
    ${wsAgents.id === current ? sessionAgentsHtml(wsAgents.agents, st) : ''}<div class="pm-foot"><button type="button" class="btn sm ghost danger" data-end-session>End session for everyone</button></div>`
}

/** With workspaces on, the agents this session's workspace invites (and the ones not invited), for its People. */
async function loadSessionAgents () {
  const id = current
  let agents = []
  if (state.workspacesOn && sum()?.workspace && sum().status.access?.owner) {
    try { agents = (await api('GET', `/api/sessions/${id}/agents`)).agents } catch { agents = [] }
  }
  if (id !== current) return
  wsAgents = { id, agents }
  if (!$('#people-menu').hidden) renderPeopleMenu({ force: true })
}

/** How long a chat link still works, e.g. "8 min left (until 14:32)", or "Ran out". */
export function chatTimeLeft (expiresAt, now = Date.now()) {
  const ms = (expiresAt || 0) - now
  if (ms <= 0) return 'Ran out: make a new link to keep going'
  const min = Math.ceil(ms / 60000)
  const left = min < 60 ? `${min} min` : min < 2880 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} days`
  const until = new Date(expiresAt).toLocaleString(undefined, min < 1440 ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return `${left} left (until ${until})`
}

/** A chat AI let in with a chat link: how long it still works, a way to extend it, and (for the owner) remove. */
function chatMemberRow (m, { remove = true } = {}) {
  const name = esc(m.name)
  const live = (m.expiresAt || 0) > Date.now()
  return `
      <form class="pm-member edit pm-chat" data-key="${esc(m.key)}">
        <span class="nm" ${memberDot(m)}${name} (chat link)</span>
        <span class="hint pm-now">${esc(chatTimeLeft(m.expiresAt))}</span>
        ${live ? `<select class="input" name="minutes" aria-label="Keep ${name}'s link working for">
          <option value="10">10 more minutes</option>
          <option value="60" selected>1 more hour</option>
          <option value="480">8 more hours</option>
          <option value="1440">1 more day</option>
          <option value="10080">1 more week</option>
        </select>
        <button type="button" class="btn sm" data-extend-chat>Extend</button>` : ''}
        ${remove ? `<button type="button" class="btn sm ghost icon" data-remove title="Remove ${name}" aria-label="Remove ${name}">${I.x}</button>` : ''}
      </form>`
}

/**
 * The owner's "Access" section for one person: their access type, and how it's narrowed
 * for them here (view only, folders taken away, no posting). It never widens the type.
 */
function accessForm (m) {
  // Disabled until this session's grants are here: Save only sends what was loaded.
  const v = accessFormValues(grantLoad, m)
  const ready = v.state === 'ready'
  const off = ready ? '' : 'disabled'
  const name = esc(m.name)
  return `
      <form class="pm-member edit pm-access" data-key="${esc(m.key)}">
        <span class="nm" ${memberDot(m)}${name}${m.kind === 'agent' ? ' (agent)' : ''}</span>
        <span class="hint pm-now">${esc(accessLine(m))}</span>
        ${ready ? '' : `<span class="hint pm-load ${v.state === 'error' ? 'warn' : ''}" role="status">${esc(v.message)}</span>`}
        <select class="input" name="typeId" aria-label="Access type for ${name}" ${off}>${typeOptions(ready ? v.typeId : '')}</select>
        <label class="pm-check"><input type="checkbox" name="viewOnly" ${ready && v.viewOnly ? 'checked' : ''} ${off}> View only</label>
        <label class="pm-check"><input type="checkbox" name="noTalk" ${ready && v.noTalk ? 'checked' : ''} ${off}> No posting</label>
        <input class="input" name="foldersRemove" value="${esc(ready ? v.foldersRemove : '')}" placeholder="Take away folders, e.g. secrets" aria-label="Folders ${name} may not change" title="Folders taken away from this person, separated by commas" ${off}>
        ${v.state === 'error' ? '<button type="button" class="btn sm" data-retry-grants>Retry</button>' : `<button type="submit" class="btn sm" ${off}>Save</button>`}
        <button type="button" class="btn sm ghost icon" data-remove title="Remove ${name}" aria-label="Remove ${name}">${I.x}</button>
      </form>`
}

/** The owner's grants in this session, from the API, for the Access sections. */
async function loadGrants () {
  const id = current
  let next
  try {
    next = grantsLoaded((await api('GET', `/api/sessions/${id}/grants`)).grants)
  } catch (err) {
    // The forms say so and offer Retry: saving from grants we couldn't check isn't safe.
    next = grantsFailed(err)
  }
  if (id !== current) return
  grantLoad = next
  // Fresh grants replace what the forms show, even one the owner is in.
  if (!$('#people-menu').hidden) renderPeopleMenu({ force: true })
}

function renderPeopleMenu ({ force = false } = {}) {
  const st = sum().status
  const menu = $('#people-menu')
  const focusEl = menu.querySelector('#focus-input')
  const typing = focusEl && document.activeElement === focusEl ? focusEl.value : null
  // Don't redraw under the owner while they change someone's access (unless fresh grants
  // arrived: then the form is redrawn from them, and keeps its focus).
  const active = menu.contains(document.activeElement) && document.activeElement.closest('.pm-member') ? document.activeElement : null
  if (!force && active && menu.querySelector('.pm-member.edit')) return
  const refocus = active && active.name ? [active.closest('.pm-member').dataset.key, active.name] : null
  const self = personInfo(st.me.name)
  const a = st.me.agent || {}
  // Your AI chat: two plain switches instead of a button plus a checkbox.
  // Without posting rights there's nothing to share: the feed is posting too.
  const muted = mayNotPost()
  const sharing = a.sharing !== false && !muted
  const shareLine = a.status === 'unavailable'
    ? `<div class="pm-card"><div class="hint warn">${esc(a.reason || 'Your AI feed is unavailable')}</div></div>`
    : `<div class="pm-card pm-settings">
        <label class="pm-switch ${muted ? 'off' : ''}"><span><b>Share my AI chat</b><small>${muted ? NO_POSTING : 'Others see your prompts and your AI\'s replies.'}</small></span><input type="checkbox" role="switch" data-share ${sharing ? 'checked' : ''} ${muted ? 'disabled' : ''}></label>
        <label class="pm-switch ${sharing ? '' : 'off'}"><span><b>Summarize it first</b><small>Share short summaries instead of every word.</small></span><input type="checkbox" role="switch" data-summarize ${a.summarized ? 'checked' : ''} ${sharing ? '' : 'disabled'}></label>
      </div>`
  const row = (p) => {
    const editing = p.editing && p.editing[0] ? `<div class="pm-sub">Editing <code>${esc(p.editing[0].path)}</code></div>` : ''
    return `<div class="pm-row">
      <button class="pm-open" data-person="${esc(p.name)}" title="Open ${p.isMe ? 'your' : `${esc(p.name)}'s`} AI chat">${avatar(p.name, p.color, p.online)}
        <span class="pm-main">
          <span class="pm-name">${esc(p.isMe ? `${p.name} (you)` : p.name)}${p.kind === 'agent' ? `<span class="tag bot">${I.bot}agent</span>` : ''}${toolsOf(p).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</span>
          ${p.persona ? `<span class="pm-sub">${p.mine ? 'One of your AI sessions' : `One of ${esc(p.of)}'s AI sessions`}</span>` : ''}
          ${p.focus && !p.isMe ? `<span class="pm-sub">${esc(p.focus)}</span>` : ''}
          ${editing}
          ${p.persona ? '' : `<span class="pm-sub">${agentLine(p)}</span>`}
        </span></button>
      ${p.isMe ? '' : `<button class="btn sm ghost" data-dm="${esc(p.name)}">Message</button>`}
    </div>`
  }
  // A person's AI sessions are one row, "Daniel's AI", with each session under it.
  const aiRow = (g) => `<div class="pm-row">
      <div class="pm-open">${avatar(g.name, null, true)}
        <span class="pm-main">
          <span class="pm-name">${esc(g.mine ? 'Your AI' : g.name)}<span class="tag bot">${I.bot}AI</span>${g.agents.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</span>
          <span class="pm-sub">${g.sessions.length === 1 ? 'One chat' : `${g.sessions.length} chats`}. Messages go to the one active last.</span>
          ${g.sessions.map((x) => `<span class="pm-sub" title="${esc(x.name)}">· ${esc(x.focus || x.name.split(' · ').slice(1).join(' · ') || x.tool || 'AI')}${x.tool && x.focus ? ` <span class="hint">(${esc(x.tool)})</span>` : ''}</span>`).join('')}
        </span></div>
      <button class="btn sm ghost" data-dm="${esc(g.name)}">Message</button>
    </div>`
  const here = peopleHere(st)
  const myAi = here.find((p) => p.sessions && p.mine)
  const others = here.some((p) => p !== myAi)
    ? here.filter((p) => p !== myAi).map((p) => p.sessions ? aiRow(p) : row(personInfo(p.name))).join('')
    : '<div class="pm-empty">Nobody else is here yet. Use <b>Invite</b> to bring someone in.</div>'
  menu.innerHTML = `
    <div class="pm-head"><span>People</span><span class="pm-count">${here.length + 1} here</span></div>
    <div class="pm-section">
      <div class="pm-title">You</div>
      <div class="pm-card">
        ${row(self)}
        <form class="pm-focus"><input class="input" id="focus-input" placeholder="What are you working on?" aria-label="Your focus" value="${esc(typing ?? st.me.focus ?? '')}"></form>
      </div>
      ${myAi ? `<div class="pm-card">${aiRow(myAi)}</div>` : ''}
      ${shareLine}
    </div>
    <div class="pm-section">
      <div class="pm-title">Others</div>
      ${others}
    </div>
    ${membersHtml(st)}`
  if (typing != null) {
    const el = menu.querySelector('#focus-input')
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }
  if (refocus) [...menu.querySelectorAll('.pm-member')].find((f) => f.dataset.key === refocus[0])?.elements?.[refocus[1]]?.focus()
}

// ------------------------------------------------------ main area (AI/Files) --
function bindMain () {
  $('#main-tabs').addEventListener('click', (e) => {
    const close = e.target.closest('[data-close]')
    const tab = e.target.closest('[data-tab]')
    const w = ws(current)
    if (close && close.dataset.kind === 'merge') {
      e.stopPropagation()
      w.mergeSel = null
      if (w.mode === 'merge') w.mode = w.fileSel ? 'files' : 'ai'
      saveWs(current)
      renderMainBar()
      renderMain()
      renderTreePane()
      return
    }
    if (tab && tab.dataset.kind === 'merge') { openMerge(tab.dataset.tab); return }
    if (close) {
      e.stopPropagation()
      const key = close.dataset.close
      const isAi = close.dataset.kind === 'ai'
      const list = isAi ? w.aiTabs : w.fileTabs
      const i = list.indexOf(key)
      if (i !== -1) list.splice(i, 1)
      const selKey = isAi ? 'aiSel' : 'fileSel'
      if (w[selKey] === key) w[selKey] = list[Math.min(i, list.length - 1)] || null
      // Closing the tab you're looking at falls back to whatever is left.
      if ((w.mode === 'ai') === isAi && !w[selKey]) {
        const other = isAi ? 'files' : 'ai'
        if ((other === 'ai' ? w.aiSel : w.fileSel)) w.mode = other
      }
      saveWs(current)
      renderMainBar()
      renderMain()
      renderTreePane()
      return
    }
    if (tab) {
      if (tab.dataset.kind === 'ai') openPerson(tab.dataset.tab)
      else openFile(tab.dataset.tab)
    }
  })
  $('#main').addEventListener('click', async (e) => {
    const copy = e.target.closest('[data-copy-invite]')
    if (copy) {
      const view = copy.dataset.copyInvite === 'view'
      try { await navigator.clipboard.writeText(view ? sum().viewInvite : sum().invite); toast(view ? 'View-only link copied' : 'Invite link copied') } catch { openInvite(current) }
      return
    }
    const b = e.target.closest('[data-person]')
    if (b) openPerson(b.dataset.person)
    const c = e.target.closest('[data-conv]')
    if (c) pickConv(c.dataset.conv)
    const f = e.target.closest('[data-fv]')
    if (f && f.dataset.fv === 'claim') claimPath(ws(current).fileSel, '')
    if (f && f.dataset.fv === 'release') releasePattern(f.dataset.pattern)
  })
}

function openPerson (name) {
  const w = ws(current)
  if (!w.aiTabs.includes(name)) w.aiTabs.push(name)
  w.aiSel = name
  w.mode = 'ai'
  saveWs(current)
  renderMainBar()
  renderMain()
  renderTreePane()
  if (!state.feeds.get(current)?.has(name)) loadFeed(name)
}

/** Show one of the person's conversations. Picking the newest goes back to following whatever is newest. */
function pickConv (conv) {
  const w = ws(current)
  if (!w.aiSel) return
  const entries = state.feeds.get(current)?.get(w.aiSel) || []
  const newest = conversations(entries)[0]
  if (!w.convSel) w.convSel = {}
  if (newest && newest.conv === conv) delete w.convSel[w.aiSel]
  else w.convSel[w.aiSel] = conv
  saveWs(current)
  renderMain()
}

function openFile (path) {
  const w = ws(current)
  if (!w.fileTabs.includes(path)) w.fileTabs.push(path)
  w.fileSel = path
  w.mode = 'files'
  const wasStale = w.stale[path]
  delete w.stale[path]
  saveWs(current)
  renderMainBar()
  renderMain()
  renderTreePane()
  if (window.matchMedia('(max-width: 900px)').matches) openDrawer(null)
  if (!state.files.has(fileKey(path)) || wasStale) refreshFile(path, !!wasStale)
}

function renderMainBar () {
  if (!current || !$('#main-tabs')) return
  const w = ws(current)
  const el = $('#main-tabs')
  const aiOn = (name) => w.mode === 'ai' && w.aiSel === name
  const fileOn = (path) => w.mode === 'files' && w.fileSel === path
  el.innerHTML = w.aiTabs.map((name) => {
    const p = personInfo(name)
    const working = p.agent && p.agent.sharing !== false && p.agent.status === 'working'
    return `<div class="ws-tab${aiOn(name) ? ' on' : ''}" role="tab" aria-selected="${aiOn(name)}" tabindex="0" data-kind="ai" data-tab="${esc(name)}" title="${esc(p.isMe ? 'Your AI chat' : `${name}'s AI chat`)}">
      ${avatar(name, p.color, p.online)}<span class="nm">${esc(p.isMe ? 'Your AI' : `${name}'s AI`)}</span>${working ? '<span class="pulse" title="AI is working"></span>' : ''}
      <button class="x" data-kind="ai" data-close="${esc(name)}" aria-label="Close ${esc(name)}">${I.x}</button></div>`
  }).join('') + (w.aiTabs.length && w.fileTabs.length ? '<span class="ws-tab-sep"></span>' : '') +
  w.fileTabs.map((path) => `<div class="ws-tab${fileOn(path) ? ' on' : ''}" role="tab" aria-selected="${fileOn(path)}" tabindex="0" data-kind="file" data-tab="${esc(path)}" title="${esc(path)}">
      <span class="ico">${I.file}</span><span class="nm">${esc(basename(path))}</span>${w.stale[path] ? '<span class="changed" title="Changed"></span>' : ''}
      <button class="x" data-kind="file" data-close="${esc(path)}" aria-label="Close ${esc(basename(path))}">${I.x}</button></div>`).join('') +
  (w.mergeSel ? mergeTabHtml(w) : '')
  $('#mainbar').hidden = !w.aiTabs.length && !w.fileTabs.length && !w.mergeSel
}

function mergeTabHtml (w) {
  const m = shownMerge()
  const on = w.mode === 'merge'
  const name = m ? `Merge ${basename(m.path)}` : 'Merge'
  return `${w.aiTabs.length || w.fileTabs.length ? '<span class="ws-tab-sep"></span>' : ''}<div class="ws-tab${on ? ' on' : ''}" role="tab" aria-selected="${on}" tabindex="0" data-kind="merge" data-tab="${esc(w.mergeSel)}" title="${esc(m ? `Compare the two versions of ${m.path}` : 'Merge')}">
      <span class="ico">${I.branch}</span><span class="nm">${esc(name)}</span>
      <button class="x" data-kind="merge" data-close="${esc(w.mergeSel)}" aria-label="Close merge">${I.x}</button></div>`
}

// A card being renamed, or a drag in progress, must not be rebuilt under the pointer.
let draggingTask = false
let boardDirty = false
// Who the next task is for, chosen before Add. `p:name` or `a:name`.
let pendingAssign = ''

function renderTaskButton () {
  const btn = $('#tasks-btn')
  if (!btn || !current) return
  const open = (sum()?.status.tasks || []).filter((t) => t.column === 'todo' || t.column === 'doing').length
  const n = $('#tasks-count')
  if (n) { n.hidden = open === 0; n.textContent = String(open) }
  const on = ws(current).mode === 'tasks'
  btn.classList.toggle('on', on)
  btn.setAttribute('aria-pressed', String(on))
}

function editingTask () {
  const el = document.activeElement
  if (!el?.closest) return false
  return !!el.closest('.task-edit, .task-assign, .task-file, .task-file-form, .task-cron, .task-cron-form, .task-add-assign')
}

function taskPeople (st) {
  // A person's AI sessions are assigned as "their AI" (forAi), not one by one.
  return [st.me, ...(st.peers || [])].filter((p) => p && p.name && !p.persona).map((p) => ({
    name: p.name,
    tool: p.tool && p.tool !== 'unknown' ? p.tool : '',
    agent: p.kind === 'agent'
  }))
}

function assignmentFromValue (value, st) {
  if (!value) return { assignee: '', forAi: false, tool: '' }
  const forAi = value.startsWith('a:')
  const assignee = value.slice(2)
  const person = [st.me, ...(st.peers || [])].find((p) => p.name === assignee)
  const saved = (st.tasks || []).find((t) => t.assignee === assignee && !!t.forAi === forAi)
  const live = person?.tool && person.tool !== 'unknown' ? person.tool : ''
  return { assignee, forAi, tool: forAi ? (live || saved?.tool || '') : '' }
}

// Board scroll survives a repaint: the column row's horizontal position and
// each column's own vertical position, keyed by column id.
let lastBoard = { html: '', el: null }
function boardScroll (root) {
  const cols = root?.querySelector('.board-cols')
  if (!cols) return null
  const lists = {}
  for (const col of cols.querySelectorAll('.board-col')) {
    const list = col.querySelector('.board-list')
    if (list) lists[col.dataset.column] = list.scrollTop
  }
  return { left: cols.scrollLeft, top: cols.scrollTop, lists }
}

function restoreBoardScroll (root, scroll) {
  if (!scroll) return
  const cols = root?.querySelector('.board-cols')
  if (!cols) return
  cols.scrollLeft = scroll.left
  cols.scrollTop = scroll.top
  for (const col of cols.querySelectorAll('.board-col')) {
    const list = col.querySelector('.board-list')
    const top = scroll.lists[col.dataset.column]
    if (list && typeof top === 'number') list.scrollTop = top
  }
}

// A plain mouse wheel only scrolls up and down. Over the board's headers,
// gaps or a column too short to scroll, turn that into sideways movement so
// the column row can be reached without a trackpad or the scrollbar.
function boardWheel (e) {
  if (e.ctrlKey || e.defaultPrevented) return
  const cols = e.target.closest?.('.board-cols')
  if (!cols || cols.scrollWidth <= cols.clientWidth + 1) return
  if (getComputedStyle(cols).overflowX === 'visible') return
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
  if (!dy || Math.abs(e.deltaX) >= Math.abs(dy) || e.shiftKey) return
  const list = e.target.closest('.board-list')
  if (list && list.scrollHeight > list.clientHeight + 1) return
  // Stacked phone layout scrolls vertically; leave it alone.
  if (cols.scrollHeight > cols.clientHeight + 1) return
  e.preventDefault()
  cols.scrollLeft += dy
}

function paintBoard ({ force = false } = {}) {
  if (!current || !$('#main')) return
  renderTaskButton()
  if (ws(current).mode !== 'tasks') return
  if (!force && (draggingTask || editingTask())) { boardDirty = true; return }
  boardDirty = false
  const add = !force && document.activeElement?.id === 'task-add'
    ? { value: document.activeElement.value, pos: document.activeElement.selectionStart }
    : null
  renderMain()
  if (!add) return
  const input = $('#task-add')
  if (!input) return
  input.value = add.value
  input.focus()
  try { input.setSelectionRange(add.pos, add.pos) } catch {}
}

async function changeTasks (path, body, beforePaint) {
  const id = current
  const { tasks } = await api('POST', `/api/sessions/${id}/tasks${path}`, body)
  if (id !== current) return
  const s = state.sessions.get(id)
  if (s) s.status.tasks = tasks
  beforePaint?.()
  paintBoard({ force: true })
}

function beginEdit (btn) {
  const card = btn.closest('.task')
  if (!card || card.querySelector('.task-edit')) return
  const input = document.createElement('input')
  input.className = 'task-edit'
  input.value = btn.textContent
  input.maxLength = 200
  input.setAttribute('aria-label', 'Task')
  const original = btn.textContent
  card.draggable = false
  btn.replaceWith(input)
  input.focus()
  input.select()
  const finish = async (save) => {
    if (input.dataset.done) return
    input.dataset.done = '1'
    const title = input.value.trim()
    const taskId = card.dataset.task
    if (!save || !title || title === original) { paintBoard({ force: true }); return }
    try { await changeTasks('/update', { id: taskId, title }) }
    catch (err) { toast(err.message); paintBoard({ force: true }) }
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true) }
    if (e.key === 'Escape') { e.preventDefault(); finish(false) }
  })
  input.addEventListener('blur', () => finish(true))
}

function bindBoard () {
  const el = $('#main')
  el.addEventListener('wheel', boardWheel, { passive: false })
  el.addEventListener('focusout', () => {
    setTimeout(() => { if (!editingTask() && boardDirty) paintBoard() }, 0)
  })
  el.addEventListener('change', async (e) => {
    const addAssign = e.target.closest?.('#task-add-assign')
    if (addAssign) { pendingAssign = addAssign.value; return }
    const sel = e.target.closest?.('select.task-assign')
    if (!sel) return
    const id = sel.closest('.task')?.dataset.task
    if (!id) return
    try { await changeTasks('/update', { id, ...assignmentFromValue(sel.value, sum().status) }) }
    catch (err) { toast(err.message); paintBoard({ force: true }) }
  })
  el.addEventListener('submit', async (e) => {
    if (e.target.classList.contains('task-cron-form')) {
      e.preventDefault()
      const input = e.target.querySelector('input')
      const id = e.target.closest('.task')?.dataset.task
      if (!id || !input) return
      try { await changeTasks('/update', { id, cron: input.value }) }
      catch (err) { toast(err.message) }
      return
    }
    if (e.target.classList.contains('task-file-form')) {
      e.preventDefault()
      const input = e.target.querySelector('input')
      const path = input.value.trim()
      const id = e.target.closest('.task')?.dataset.task
      if (!path || !id) return
      const task = (sum()?.status.tasks || []).find((t) => t.id === id)
      const files = [...(task?.files || [])]
      if (!files.includes(path)) files.push(path)
      try { await changeTasks('/update', { id, files }) }
      catch (err) { toast(err.message); input.focus() }
      return
    }
    if (e.target.id !== 'task-add-form') return
    e.preventDefault()
    const input = e.target.querySelector('input')
    const title = input.value.trim()
    if (!title) return
    const button = e.target.querySelector('button[type="submit"]')
    button.disabled = true
    const who = assignmentFromValue(e.target.querySelector('#task-add-assign')?.value || pendingAssign, sum().status)
    try {
      await changeTasks('', { title, ...who }, () => { pendingAssign = '' })
      $('#task-add')?.focus()
    } catch (err) { toast(err.message); button.disabled = false }
  })
  el.addEventListener('click', async (e) => {
    const move = e.target.closest('[data-move]')
    if (move) {
      const id = move.closest('.task')?.dataset.task
      if (!id) return
      try { await changeTasks('/update', { id, column: move.dataset.move }) }
      catch (err) { toast(err.message) }
      return
    }
    const removeFile = e.target.closest('[data-file-remove]')
    if (removeFile) {
      const id = removeFile.closest('.task')?.dataset.task
      const path = removeFile.getAttribute('data-file-remove')
      const task = (sum()?.status.tasks || []).find((t) => t.id === id)
      if (!id || !task) return
      try { await changeTasks('/update', { id, files: (task.files || []).filter((f) => f !== path) }) }
      catch (err) { toast(err.message) }
      return
    }
    const notes = e.target.closest('[data-task-notes]')
    if (notes) {
      const id = notes.closest('.task')?.dataset.task
      const task = (sum()?.status.tasks || []).find((t) => t.id === id)
      if (task) openTaskNotes(task)
      return
    }
    const recur = e.target.closest('[data-task-recur]')
    if (recur) {
      const id = recur.closest('.task')?.dataset.task
      const task = (sum()?.status.tasks || []).find((t) => t.id === id)
      if (!id || !task) return
      try { await changeTasks('/update', { id, recurring: !task.recurring }) }
      catch (err) { toast(err.message) }
      return
    }
    if (e.target.closest('[data-task-delete]')) {
      const id = e.target.closest('.task')?.dataset.task
      if (!id) return
      try { await changeTasks('/delete', { id }) }
      catch (err) { toast(err.message) }
      return
    }
    const edit = e.target.closest('[data-task-edit]')
    const title = edit ? edit.closest('.task')?.querySelector('.task-title') : e.target.closest('.task-title')
    if (title) beginEdit(title)
  })
  el.addEventListener('dragstart', (e) => {
    const card = e.target.closest?.('.task')
    if (!card || e.target.closest('.task-icon, .task-move, .task-assign, .task-files, .task-file-form, .task-cron-form, .task-file-x, input, select')) { e.preventDefault(); return }
    draggingTask = true
    e.dataTransfer.setData('text/plain', card.dataset.task)
    e.dataTransfer.effectAllowed = 'move'
    card.classList.add('dragging')
  })
  el.addEventListener('dragover', (e) => {
    const col = e.target.closest?.('.board-col')
    if (!col) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    for (const n of el.querySelectorAll('.board-col.over')) if (n !== col) n.classList.remove('over')
    col.classList.add('over')
  })
  el.addEventListener('drop', async (e) => {
    const col = e.target.closest?.('.board-col')
    if (!col) return
    e.preventDefault()
    const id = e.dataTransfer.getData('text/plain')
    const before = e.target.closest('.task')?.dataset.task
    col.classList.remove('over')
    draggingTask = false
    if (!id || before === id) { if (boardDirty) paintBoard(); return }
    try { await changeTasks('/update', { id, column: col.dataset.column, ...(before ? { before } : {}) }) }
    catch (err) { toast(err.message); paintBoard({ force: true }) }
  })
  el.addEventListener('dragend', () => {
    draggingTask = false
    for (const n of el.querySelectorAll('.over, .dragging')) n.classList.remove('over', 'dragging')
    if (boardDirty) paintBoard()
  })
}

function renderMain () {
  const el = $('#main')
  if (!current || !el) return
  const w = ws(current)
  const st = sum().status
  if (w.mode === 'tasks') {
    const html = renderBoard(st.tasks || [], me(), taskPeople(st), pendingAssign)
    // Status ticks arrive every few seconds. Re-rendering an unchanged board
    // would throw away hover, selection and scroll for nothing.
    if (html === lastBoard.html && lastBoard.el && el.firstElementChild === lastBoard.el) return
    const scroll = boardScroll(el)
    el.innerHTML = html
    lastBoard = { html, el: el.firstElementChild }
    restoreBoardScroll(el, scroll)
    return
  }
  lastBoard = { html: '', el: null }
  if (st.access && st.access.state === 'pending') {
    el.innerHTML = `<div class="main-empty">
      <div class="ill">${I.lock}</div>
      <h3>Waiting to be let in</h3>
      <p class="hint">The person who started this session needs to approve you. Files will appear here as soon as they do. You can leave this open.</p>
    </div>`
    return
  }
  if (w.mode === 'merge' && !w.mergeSel) w.mode = 'ai'
  if (w.mode === 'merge') {
    const m = shownMerge()
    const cached = m ? state.files.get(fileKey(m.path)) : null
    const f = cached && cached.file
    const theirs = !cached ? undefined : f.missing || f.binary ? null : f.text
    const texts = m && !m.binary ? fullMerge(m) : { ours: null, base: null }
    renderMergeView(el, { merge: m, texts, theirs, me: me(), editors: editorsByPreference(), viewer: isViewer() })
    if (m && !m.binary && !cached) refreshFile(m.path, false)
    return
  }
  if (w.mode === 'ai') {
    if (!w.aiSel) {
      const people = st.peers
      if (!people.length) {
        const { invite, viewInvite } = sum()
        el.innerHTML = `<div class="main-empty invite-empty">
          <div class="ill">${I.link}</div>
          <h3>Invite someone to code with you</h3>
          <p class="hint">Send a link. Clicking it opens this session in Quilt${viewInvite ? ', and you approve them before they get in' : ''}. To add an AI, use <b>Invite</b> above.</p>
          ${viewInvite ? `
          <div class="invite-pair">
            <div><div class="label">Can edit</div><div class="codebox"><code>${esc(invite)}</code></div><button class="btn primary" data-copy-invite="edit">${I.copy}<span>Copy edit link</span></button></div>
            <div><div class="label">View only</div><div class="codebox"><code>${esc(viewInvite)}</code></div><button class="btn" data-copy-invite="view">${I.copy}<span>Copy view link</span></button></div>
          </div>` : `
          <div class="codebox"><code id="empty-invite">${esc(invite)}</code></div>
          <button class="btn primary" data-copy-invite="edit">${I.copy}<span>Copy invite link</span></button>`}
          <p class="hint small">Once they join, you'll see their AI chat here as it happens.</p>
        </div>`
        return
      }
      el.innerHTML = `<div class="main-empty">
        <div class="ill">${I.sparkle}</div>
        <h3>Watch your partners' AI, live</h3>
        <p class="hint">Pick someone to see what they ask their AI, what it answers, and which files it touches.</p>
        <div class="row" style="justify-content:center;flex-wrap:wrap">
          ${people.map((p) => `<button class="btn" data-person="${esc(p.name)}">${avatar(p.name, p.color, true)}${esc(p.name)}</button>`).join('')}
        </div>
      </div>`
      return
    }
    const feeds = state.feeds.get(current)
    const entries = feeds && feeds.get(w.aiSel)
    if (!entries) { el.innerHTML = '<div class="main-empty"><p class="hint">Loading…</p></div>'; return }
    const p = personInfo(w.aiSel)
    const convSel = w.convSel && w.convSel[w.aiSel]
    renderFeed(el, { entries, person: w.aiSel, isMe: !!p.isMe, color: p.color, agent: p.agent, online: p.online, convSel })
  } else {
    if (!w.fileSel) {
      el.innerHTML = `<div class="main-empty"><div class="ill">${I.file}</div><h3>Open a file</h3>
        <p class="hint">Pick a file in the tree to see it live. Lines your partners change light up as they happen.</p></div>`
      return
    }
    const cached = state.files.get(fileKey(w.fileSel))
    renderFileView(el, { path: w.fileSel, file: cached ? cached.file : null, meta: treeMeta(w.fileSel), me: me(), prevText: cached ? cached.prevText : null })
    if (cached) cached.prevText = null // highlight once
  }
}

const fileKey = (path) => `${current}\n${path}`

function treeMeta (path) {
  const t = state.trees.get(current)
  const f = t && t.files.find((x) => x.path === path)
  if (f) return f
  // Deleted or unknown: still show a claim covering it.
  return { path, edited: null, claim: null }
}

async function refreshFile (path, highlight) {
  const id = current
  const key = fileKey(path)
  const before = state.files.get(key)
  const prevText = highlight && before && before.file && !before.file.missing && !before.file.binary ? before.file.text : null
  let file
  try {
    file = await api('GET', `/api/sessions/${id}/file?path=${encodeURIComponent(path)}`)
  } catch {
    file = { missing: true, deleted: !!(before && before.file && !before.file.missing) }
  }
  if (id !== current) return
  state.files.set(key, { file, prevText })
  const w = ws(current)
  if ((w.mode === 'files' && w.fileSel === path) || (w.mode === 'merge' && shownMerge()?.path === path)) renderMain()
}

async function loadFeed (name) {
  const id = current
  try {
    const { entries } = await api('GET', `/api/sessions/${id}/feed?who=${encodeURIComponent(name)}`)
    if (!state.feeds.has(id)) state.feeds.set(id, new Map())
    state.feeds.get(id).set(name, entries)
    if (id === current && ws(id).mode === 'ai' && ws(id).aiSel === name) renderMain()
  } catch (err) {
    toast(err.message)
  }
}

function loadFeeds () {
  if (!state.feeds.has(current)) state.feeds.set(current, new Map())
  for (const name of ws(current).aiTabs) loadFeed(name)
}

// -------------------------------------------------------------- file tree --
let treeTimer = null
function scheduleTree () {
  clearTimeout(treeTimer)
  treeTimer = setTimeout(loadTree, 300)
}

async function loadTree () {
  const id = current
  if (!id) return
  try {
    const tree = await api('GET', `/api/sessions/${id}/tree`)
    if (id !== current) return
    state.trees.set(id, tree)
    renderTreePane()
    const w = ws(id)
    if (w.mode === 'files' && w.fileSel) {
      // Keep the banner (editor, claim) fresh without re-highlighting.
      const cached = state.files.get(fileKey(w.fileSel))
      if (cached) renderFileView($('#main'), { path: w.fileSel, file: cached.file, meta: treeMeta(w.fileSel), me: me(), bannerOnly: true })
    }
  } catch {}
}

function renderTreePane () {
  const el = $('#tree')
  if (!current || !el) return
  const w = ws(current)
  const tree = state.trees.get(current)
  const scroll = el.scrollTop
  renderTree(el, tree, { me: me(), expanded: w.expanded, selected: w.mode === 'files' ? w.fileSel : null })
  el.scrollTop = scroll
  $('#file-count').textContent = tree ? `${tree.files.length}` : ''
}

function openTaskNotes (task, { instant = false } = {}) {
  document.querySelector('.task-notes-back')?.remove()
  const back = document.createElement('div')
  back.className = 'modal-back task-notes-back'
  back.innerHTML = taskNotesModalHtml(task)
  document.body.appendChild(back)
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const close = () => {
    if (back.dataset.closing) return
    back.dataset.closing = '1'
    back.classList.remove('is-open')
    if (reduce) { back.remove(); return }
    let finished = false
    const finish = () => { if (finished) return; finished = true; back.remove() }
    back.addEventListener('transitionend', (e) => { if (e.target === back) finish() })
    setTimeout(finish, 280)
  }
  back.addEventListener('mousedown', (e) => { if (e.target === back) close() })
  back.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close() } })
  back.querySelector('[data-close-notes]').onclick = close
  const form = back.querySelector('.task-comment-form')
  const box = back.querySelector('.task-comment-text')
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit() } })
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const text = box.value.trim()
    if (!text) return
    try {
      await changeTasks('/comment', { id: task.id, text })
      const now = (sum()?.status.tasks || []).find((t) => t.id === task.id)
      box.value = ''
      // Drawn again with the new comment, the box ready for another.
      if (now) openTaskNotes(now, { instant: true })
    } catch (err) { toast(err.message) }
  })
  ;(task.comments?.length || task.qaNotes || task.verified ? back.querySelector('[data-close-notes]') : box).focus()
  if (reduce || instant) back.classList.add('is-open')
  else requestAnimationFrame(() => requestAnimationFrame(() => back.classList.add('is-open')))
  if (instant) back.querySelector('.task-comment-text').focus()
}

function applyTreeCollapsed () {
  const body = $('#ws-body')
  const btn = $('#collapse-tree')
  if (!body || !current) return
  const collapsed = !!ws(current).treeCollapsed
  body.classList.toggle('tree-collapsed', collapsed)
  const scroll = $('#tree')
  if (scroll) {
    scroll.toggleAttribute('inert', collapsed)
    scroll.setAttribute('aria-hidden', collapsed ? 'true' : 'false')
  }
  if (!btn) return
  btn.setAttribute('aria-expanded', String(!collapsed))
  btn.title = collapsed ? 'Expand files' : 'Collapse files'
  btn.setAttribute('aria-label', collapsed ? 'Expand files' : 'Collapse files')
  btn.innerHTML = collapsed ? I.arrowRight : I.arrowLeft
}

function toggleTreeCollapsed () {
  if (!current) return
  const w = ws(current)
  w.treeCollapsed = !w.treeCollapsed
  saveWs(current)
  applyTreeCollapsed()
}

function bindTreeEvents () {
  const collapse = $('#collapse-tree')
  if (collapse) collapse.onclick = () => toggleTreeCollapsed()
  const el = $('#tree')
  el.addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]')
    if (more) { e.stopPropagation(); showTreeMenu(more, more.dataset.more, more.dataset.kind); return }
    const dir = e.target.closest('[data-dir]')
    if (dir) {
      const w = ws(current)
      const depth0 = !dir.dataset.dir.includes('/')
      const open = w.expanded[dir.dataset.dir] ?? depth0
      w.expanded[dir.dataset.dir] = !open
      saveWs(current)
      renderTreePane()
      return
    }
    const file = e.target.closest('[data-file]')
    if (file) openFile(file.dataset.file)
  })
  el.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('[data-file],[data-dir]')
    if (!row) return
    e.preventDefault()
    const path = row.dataset.file || row.dataset.dir
    showTreeMenu(row.querySelector('.t-more') || row, path, row.dataset.file ? 'file' : 'dir')
  })
  el.addEventListener('keydown', (e) => {
    const row = e.target.closest('.t-row')
    if (!row) return
    const rows = [...el.querySelectorAll('.t-row')]
    const i = rows.indexOf(row)
    if (e.key === 'ArrowDown') { e.preventDefault(); rows[i + 1]?.focus() }
    if (e.key === 'ArrowUp') { e.preventDefault(); rows[i - 1]?.focus() }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click() }
  })
  // Make the tree reachable by keyboard: first row takes focus.
  el.tabIndex = 0
  el.addEventListener('focus', () => { if (document.activeElement === el) el.querySelector('.t-row')?.focus() })
}

function claimCovering (path, kind) {
  const tree = state.trees.get(current)
  if (!tree) return null
  if (kind === 'dir') return tree.claims.find((c) => claimFolder(c.pattern) === path) || null
  const f = tree.files.find((x) => x.path === path)
  return f ? f.claim : null
}

function showTreeMenu (anchor, path, kind) {
  openTreeMenu(anchor, {
    path,
    kind,
    me: me(),
    owner: !!sum()?.status.access?.owner,
    claim: claimCovering(path, kind),
    onOpen: () => openFile(path),
    onClaim: (note) => claimPath(path, note),
    onRelease: () => releasePattern(claimCovering(path, kind).pattern),
    onClearAway: clearAwayClaims,
    onRequest: (req) => fileQueue('request-file', { path, ...req }, `Asked for ${path}`),
    onWithdraw: (request) => fileQueue('withdraw-request', { request }, 'Request withdrawn'),
    onHandoff: (h) => fileQueue('handoff', { path: claimCovering(path, kind).pattern, ...h }, `Handed off ${path}`)
  })
}

/** The file queue from the ⋯ menu: ask for a file, take a request back, or hand a file on. */
async function fileQueue (route, body, done) {
  try {
    await api('POST', `/api/sessions/${current}/${route}`, body)
    toast(done)
    loadTree()
  } catch (err) { toast(err.message) }
}

async function clearAwayClaims () {
  try {
    const { released } = await api('POST', `/api/sessions/${current}/clear-claims`, {})
    toast(released ? `Released ${released} claim${released === 1 ? '' : 's'}` : 'No claims to release')
    loadTree()
  } catch (err) { toast(err.message) }
}

async function claimPath (path, note) {
  try {
    await api('POST', `/api/sessions/${current}/claim`, { pattern: path, note })
    toast(`Claimed ${path}`)
    loadTree()
  } catch (err) { toast(err.message) }
}

async function releasePattern (pattern) {
  try {
    await api('POST', `/api/sessions/${current}/release`, { pattern })
    toast(`Released ${pattern}`)
    loadTree()
  } catch (err) { toast(err.message) }
}

// ------------------------------------------------------------------- chat --
function bindChat () {
  const id = current
  const input = $('#msg-input')
  const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px` }
  input.addEventListener('input', grow)
  bindMentions(input)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.defaultPrevented) { e.preventDefault(); $('#composer').requestSubmit() }
  })
  $('#to-select').onchange = (e) => { state.to = e.target.value; updatePlaceholder() }
  $('#attach-btn').onclick = () => $('#file-input').click()
  $('#file-input').onchange = (e) => { addFiles(e.target.files); e.target.value = '' }
  $('[data-attach-workspace]')?.addEventListener('click', async () => {
    if (mayNotPost()) return toast(NO_POSTING)
    const workspace = sum()?.workspace
    const pick = await workspaceFilePicker(workspace)
    if (!pick) return
    try {
      await api('POST', `/api/sessions/${id}/attach-from-workspace`, { fileId: pick.id, to: state.to || null, text: input.value.trim() })
      input.value = ''
      grow()
    } catch (err) {
      toast(err.message)
    } finally {
      input.focus()
    }
  })
  $('#attachments').onclick = (e) => {
    const b = e.target.closest('[data-unqueue]')
    if (b) { state.pending.splice(Number(b.dataset.unqueue), 1); renderAttachments() }
  }
  $('#composer').onsubmit = async (e) => {
    e.preventDefault()
    const text = input.value.trim()
    const files = state.pending.slice()
    if (!text && !files.length) return
    $('#send-btn').disabled = true
    try {
      if (files.length) {
        for (let i = 0; i < files.length; i++) {
          const f = files[i]
          await api('POST', `/api/sessions/${id}/send`, f, {
            'x-filename': encodeURIComponent(f.name),
            'x-to': encodeURIComponent(state.to),
            'x-text': encodeURIComponent(i === 0 ? text : '')
          })
        }
      } else {
        const r = await api('POST', `/api/sessions/${id}/say`, { text, to: state.to || null })
        if (state.to && !r.recipientOnline) toast(`${state.to} is offline. They'll see it when they’re back.`)
      }
      input.value = ''
      state.pending = []
      renderAttachments()
      grow()
    } catch (err) {
      toast(err.message)
    } finally {
      $('#send-btn').disabled = mayNotPost()
      input.focus()
    }
  }

  const pane = $('#chat-pane')
  let depth = 0
  pane.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { depth++; pane.classList.add('dragging') } })
  pane.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) pane.classList.remove('dragging') })
  pane.addEventListener('dragover', (e) => e.preventDefault())
  pane.addEventListener('drop', (e) => {
    e.preventDefault()
    depth = 0
    pane.classList.remove('dragging')
    addFiles(e.dataTransfer.files)
  })
  input.addEventListener('paste', (e) => {
    if (e.clipboardData?.files?.length) { e.preventDefault(); addFiles(e.clipboardData.files) }
  })
  pane.addEventListener('focusin', () => markRead(id))
}

function addFiles (list) {
  if (mayNotPost()) return toast(NO_POSTING)
  for (const f of list) {
    if (state.maxFileBytes && f.size > state.maxFileBytes) { toast(`${f.name} is larger than ${bytes(state.maxFileBytes)}`); continue }
    state.pending.push(f)
  }
  renderAttachments()
  $('#msg-input').focus()
}

function renderAttachments () {
  const el = $('#attachments')
  if (!el) return
  el.innerHTML = state.pending.map((f, i) => `<span class="tag">${esc(f.name)} · ${bytes(f.size)}<button type="button" data-unqueue="${i}" aria-label="Remove">×</button></span>`).join('')
  updatePlaceholder()
}

/** Someone who may not post sees the chat, but not a way to post to it. */
function renderComposer () {
  const input = $('#msg-input')
  const s = sum()
  if (!input || !s) return
  const muted = mayNotPost()
  input.disabled = muted
  $('#attach-btn').disabled = muted
  const wsBtn = $('[data-attach-workspace]')
  if (wsBtn) wsBtn.disabled = muted
  $('#send-btn').disabled = muted
  $('#composer').classList.toggle('muted', muted)
  updatePlaceholder()
}

function mayNotPost () {
  const acc = sum()?.status.access
  return !!(acc && acc.state === 'approved' && acc.talk === false)
}

function updatePlaceholder () {
  const input = $('#msg-input')
  if (!input) return
  if (mayNotPost()) { input.placeholder = NO_POSTING; return }
  const who = state.to ? (state.to === `${me()}'s AI` ? 'your AI' : state.to) : 'everyone'
  input.placeholder = state.pending.length ? `Add a note for ${who} (optional)…` : `Message ${who}…`
}

function renderRecipients () {
  const s = sum()
  const sel = $('#to-select')
  if (!s || !sel) return
  const who = owners(s)
  const names = new Set(peopleHere(s.status).map((p) => p.name))
  for (const m of renderable(state.messages.get(current))) {
    if (m.by !== s.status.me.name) names.add(shownName(m.by, who))
    if (m.to && m.to !== s.status.me.name) names.add(shownName(m.to, who))
  }
  if (state.to) names.add(state.to)
  const online = new Set(peopleHere(s.status).map((p) => p.name))
  sel.innerHTML = '<option value="">Everyone</option>' + [...names].sort().map((n) =>
    `<option value="${esc(n)}" ${n === state.to ? 'selected' : ''}>${esc(n === `${s.status.me.name}'s AI` ? 'Your AI' : n)} (direct${online.has(n) ? '' : ', offline'})</option>`).join('')
  sel.value = state.to
  sel.closest('.to').hidden = names.size === 0
  updatePlaceholder()
}

/**
 * Everyone who can be mentioned in this session: members, people online, and whoever has written,
 * and @Agents (every agent at once) while an agent other than me is connected.
 */
function mentionNames (s) {
  const names = new Set()
  const who = owners(s)
  if (s.status.me?.name) names.add(s.status.me.name)
  for (const p of peopleHere(s.status)) if (p.name) names.add(p.name)
  for (const m of s.status.members || []) if (m.name) names.add(m.name)
  for (const m of renderable(state.messages.get(current))) { if (m.by) names.add(shownName(m.by, who)); if (m.to) names.add(shownName(m.to, who)) }
  if ((s.status.peers || []).some((p) => p.kind === 'agent' && p.name !== s.status.me?.name)) names.add(ALL_AGENTS)
  return [...names]
}

/**
 * Typing @ in the composer offers the session's members; arrows pick, Enter or Tab
 * completes, Escape closes. Agents wake on a mention of their name, so it has to be exact.
 */
function bindMentions (input) {
  const menu = $('#mention-menu')
  let items = []
  let at = null
  let on = 0
  const close = () => { items = []; at = null; menu.hidden = true; menu.innerHTML = '' }
  const render = () => {
    menu.innerHTML = items.map((n, i) => `<button type="button" role="option" aria-selected="${i === on}" class="${i === on ? 'on' : ''}" data-name="${esc(n)}">${avatar(n, sum()?.status.peers.find((p) => p.name === n)?.color)}<span>${esc(n)}</span></button>`).join('')
    menu.hidden = false
  }
  const pick = (name) => {
    if (!at) return
    const r = completeMention(input.value, at, name)
    input.value = r.text
    input.setSelectionRange(r.caret, r.caret)
    close()
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus()
  }
  const update = () => {
    const s = sum()
    const found = s ? mentionAt(input.value, input.selectionStart) : null
    if (!found) return close()
    const me = s.status.me?.name
    const list = mentionCandidates(mentionNames(s).filter((n) => n !== me), found.query)
    if (!list.length) return close()
    at = found
    if (JSON.stringify(list) !== JSON.stringify(items)) on = 0
    items = list
    render()
  }
  input.addEventListener('input', update)
  input.addEventListener('click', update)
  input.addEventListener('keyup', (e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) update() })
  input.addEventListener('keydown', (e) => {
    if (!items.length) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); on = (on + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; render() } else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(items[on]) } else if (e.key === 'Escape') { e.preventDefault(); close() }
  }, true)
  input.addEventListener('blur', () => setTimeout(close, 150))
  menu.addEventListener('mousedown', (e) => e.preventDefault()) // keep the textarea focused
  menu.addEventListener('click', (e) => { const b = e.target.closest('[data-name]'); if (b) pick(b.dataset.name) })
}

function renderMessages (incoming = false, force = false) {
  const el = $('#messages')
  const s = sum()
  if (!el || !s) return
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  const who = owners(s)
  // A person's AI sessions working things out among themselves isn't shown: only what they say to people.
  const list = renderable(state.messages.get(current)).filter((m) => !ownAiChatter(m, who)) // peers can push anything into the room
  const name = s.status.me.name
  const colors = new Map(s.status.peers.map((p) => [p.name, p.color]))
  colors.set(name, s.status.me.color)
  const names = mentionNames(s)
  el.innerHTML = list.length
    ? list.map((m) => {
      const mine = m.by === name
      const by = shownName(m.by, who)
      const dm = m.to ? `<span class="dm">${mine || who.has(m.by) ? `to ${esc(m.to === name ? 'you' : m.to === `${name}'s AI` ? 'your AI' : shownName(m.to, who))}` : 'direct'}</span>` : ''
      const file = m.file ? `<a class="file-card" href="${fileCardHref(current, m.id, TOKEN)}" download="${esc(m.file.name)}">
          <span class="fi">${I.file}</span><span style="min-width:0"><div class="fn">${esc(m.file.name)}</div><div class="fs">${bytes(m.file.size)} · ${mine ? 'sent' : 'download'}</div></span></a>` : ''
      return `<div class="msg${mine ? ' mine' : ''}">${mine ? '' : avatar(by, colors.get(m.by))}
        <div style="min-width:0"><div class="head"><b${by !== m.by ? ` title="${esc(m.by)}"` : ''}>${mine ? 'You' : esc(by === `${name}'s AI` ? 'Your AI' : by)}</b>${dm}<span>${esc(clock(m.ts))}</span></div>
        <div class="bubble">${m.text ? `<div class="text">${textHtml(m.text, names, name, { meAgent: s.status.me.kind === 'agent' })}</div>` : ''}${file}</div></div></div>`
    }).join('')
    : '<div class="day-empty"><div><b>Say hi.</b></div><div class="hint">Messages, direct messages and files you share appear here. Drop a file on this panel to send it.</div></div>'
  if (force || nearBottom || (incoming && list[list.length - 1]?.by === name)) el.scrollTop = el.scrollHeight
}
