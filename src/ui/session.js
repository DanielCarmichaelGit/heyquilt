// The session workspace: file tree on the left; in the middle the Loom (everyone's
// AI conversations at once), one person's AI chat, a shared file or the task board;
// the team chat on the right.
import { TOKEN, I, state, $, esc, basename, bytes, clock, ago, avatar, colorFor, toast, api, ask, remember, recall, toolsOf, busyPeople, NO_POSTING, ACCOUNT_KEY, loadAccessTypes, typeOptions, accessLine, loadingHtml } from './common.js'
import { openInvite, renderTabs, markRead } from './app.js'
import { renderFeed } from './feed.js'
import { renderLoom, resetLoom, focusFile, showsLoom } from './loom.js'
import { buildLoom, foldAiLanes } from './loom-model.js'
import { conversations } from './feed-convs.js'
import { renderTree, openTreeMenu, closeTreeMenu, claimFolder, changeCardHtml, showChangeCard, hideChangeCard } from './tree.js'
import { renderFileView, renderFileTabs } from './fileview.js'
import { rolledOff } from './diffview.js'
import { changesMarkup, bindChanges, unbindChanges, changesChanged, fileChanges } from './changes.js'
import { quiltMark } from './mark.js'
import { openSettings } from './home.js'
import { fileCardHref, renderable, textHtml, mentionAt, mentionCandidates, completeMention, ALL_AGENTS, typingNames, typingHtml, TYPING_MS, foldPersonas, aiOwners, shownName, ownAiChatter } from './chat.js'
import { renderBoard, taskNotesModalHtml, openTaskMenu, foldPlan, matchesSearch } from './board.js'
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
      fileTab: {}, // file path -> 'changes' when its Changes tab is shown (absent: the file)
      mergeSel: null, // merge id shown in the compare view
      expanded: {},
      stale: {}, // file path -> changed while not visible
      loom: { chat: true, tasks: true, density: 'detailed', layout: 'lanes', hidden: [] },
      ...(saved || {}),
      drawer: null
    })
    const w = state.ws.get(id)
    // The Loom is where the AI area starts: once, for a session opened before it existed.
    if (!w.loomSeen) { w.loomSeen = true; w.aiSel = null }
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
  pendingAssign = null
  resetLoom()
  boardQuery = '' // a search is for the board it was typed on
  filterOpen = false
  mounted = new AbortController()
  // The first time a session opens in this app, its loading screen stays over it until its files
  // and AI feeds are in, then fades, so nothing pops in afterwards. Later visits draw from memory.
  const firstVisit = !state.trees.has(id)

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
          <button class="pop-item" role="menuitem" id="move-ws-btn" hidden>Move to a workspace…</button>
          <button class="pop-item" role="menuitem" data-session-settings>Session settings…</button>
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
        <div class="typing" id="typing" role="status" aria-live="polite" hidden></div>
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
  </div>${firstVisit ? `<div class="sv-loading" id="sv-loading">${loadingHtml({ label: 'Loading session', name: sum()?.status?.sessionName || basename(sum()?.dir || '') })}</div>` : ''}`

  bindTop()
  bindAccess()
  for (const el of [$('#merges'), $('#main')]) bindMerges(el, { sessionId: () => current, onCompare: openMerge, editors: editorsByPreference })
  bindChanges(id, mounted.signal, { onOpen: (path) => openFile(path, { tab: 'changes' }) })
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
  renderTyping()
  renderRecipients()
  renderComposer()
  grantLoad = grantsLoading()
  // The approve control and the people menu offer access types once they're here.
  const accessLoad = loadAccessTypes().then(() => { if (current === id) { renderAccess(); refreshPeople() } })
  const loads = [accessLoad, loadTree(), loadFeeds()]
  if (firstVisit) {
    // In once everything is here, or after a few seconds at most (a slow feed never locks you out).
    Promise.race([Promise.allSettled(loads), new Promise((resolve) => setTimeout(resolve, 6000))]).then(() => {
      const cover = $('#sv-loading')
      if (current !== id || !cover) return
      cover.classList.add('done')
      setTimeout(() => cover.remove(), 300)
    })
  }
  const shown = ws(id).mode === 'merge' && shownMerge()
  if (shown && !shown.binary) refreshFile(shown.path, false) // the cached copy may be from before
  loadNewPeople(id)
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
  pendingAssign = null
  unbindChanges()
  current = null
}

// ------------------------------------------------------------ live events --
let lastAccessState = null
export function sessionUpdated (id) {
  if (id !== current) return
  const accState = sum().status.access?.state || null
  if (accState !== lastAccessState) { lastAccessState = accState; renderMain(); loadTree() }
  loadNewPeople(id)
  renderTop()
  renderMainBar()
  renderTyping()
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
  if (w.mode === 'ai' && !w.aiSel) renderMain() // the Loom shows chat too
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
    if (!feeds.has(e.by)) { if (id === current) loadFeed(e.by); continue } // fetched whole, this entry included
    const list = feeds.get(e.by)
    if (!list.some((x) => x.id === e.id)) list.push(e)
    if (list.length > 300) list.splice(0, list.length - 300)
    touched.add(e.by)
  }
  if (id !== current) return
  const w = ws(id)
  if (w.mode === 'ai' && (!w.aiSel || touched.has(w.aiSel))) renderMain()
  renderMainBar()
}

export function sessionFileChanged (id, { path }) {
  if (id !== current) return
  scheduleTree()
  changesChanged()
  const w = ws(id)
  if (w.mode === 'merge' && shownMerge()?.path === path) refreshFile(path, false)
  if (w.fileTabs.includes(path)) {
    if (w.mode === 'files' && w.fileSel === path) { refreshFile(path, true); scheduleHistory(path) } else { w.stale[path] = true; histories.delete(fileKey(path)); renderMainBar() }
  }
}

/** The Loom shows everyone's AI feed: fetch each person's once (someone new, when they join). */
function loadNewPeople (id) {
  const feeds = state.feeds.get(id)
  const st = sum().status
  for (const p of [st.me, ...st.peers]) if (p && p.name && !feeds?.has(p.name)) loadFeed(p.name)
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
  $('#move-ws-btn').onclick = moveToWorkspace
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
  moreMenu.addEventListener('click', (e) => { setMore(false); if (e.target.closest('[data-session-settings]')) openSessionSettings() })
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

  menu.addEventListener('click', async (e) => {
    if (e.target.closest('[data-session-settings]')) { openSessionSettings(); return }
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
  menu.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (e.target.closest('.pm-member') || e.target.closest('.pm-gh')) return
    const input = menu.querySelector('#focus-input')
    await api('POST', `/api/sessions/${current}/focus`, { text: input.value }).catch((err) => toast(err.message))
    toast(input.value ? 'Focus shared' : 'Focus cleared')
    input.blur()
  })

  $('#toggle-tree').onclick = () => toggleDrawer('tree')
  $('#toggle-chat').onclick = () => { toggleDrawer('chat'); $('#chat-badge').hidden = true }
  $('#scrim').onclick = () => toggleDrawer(null)
}

/** The Session settings window's controls: your AI chat's sharing, and (for the owner) who can get in and what they may do. */
function bindSessionSettings (root) {
  root.addEventListener('change', async (e) => {
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
      } catch (err) { toast(err.message); refreshPeople({ force: true }) }
      return
    }
    if (!e.target.matches('[data-summarize]')) return
    const on = e.target.checked
    try {
      await api('POST', `/api/sessions/${current}/summarize`, { on })
      toast(on ? 'Your prompts and replies are summarized before sharing' : 'Sharing your AI chat word for word')
    } catch (err) { toast(err.message); e.target.checked = !on }
  })
  root.addEventListener('change', async (e) => {
    const f = e.target.closest('.pm-member.edit')
    // Access types are saved with Save (below), not on every change; a chat link's time with Extend.
    if (!f || f.classList.contains('pm-access') || f.classList.contains('pm-chat')) return
    try {
      await api('POST', `/api/sessions/${current}/members/set`, { key: f.dataset.key, role: f.role.value, ...(f.scopes ? { scopes: parseScopes(f.scopes.value) } : {}) })
      toast('Access updated')
    } catch (err) { toast(err.message) }
  })
  root.addEventListener('click', (e) => {
    if (!e.target.closest('[data-retry-grants]')) return
    grantLoad = grantsLoading()
    refreshPeople({ force: true })
    loadGrants()
  })
  root.addEventListener('click', async (e) => {
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
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-remove]')
    if (!b) return
    const f = b.closest('.pm-member')
    if (!await ask({ title: `Remove ${f.querySelector('.nm').textContent.trim()}?`, message: 'They\'ll need a new invite and your approval to come back.', ok: 'Remove', danger: true })) return
    try { const r = await api('POST', `/api/sessions/${current}/members/remove`, { key: f.dataset.key }); toast(r.warning || 'Removed') } catch (err) { toast(err.message) }
    // In a workspace, a removed agent is no longer invited here (the removal answers once that is written): list it now.
    if (state.workspacesOn && f.dataset.key.startsWith('agent:')) loadSessionAgents()
  })
  // Invited from the workspace: Don't invite (a keep-out) and Invite (which sends it the link now).
  root.addEventListener('click', async (e) => {
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
  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-gh-clear]')) {
      try { await api('POST', `/api/sessions/${current}/github-token`, { token: '' }); toast('The relay no longer has a GitHub token') } catch (err) { toast(err.message) }
      refreshPeople({ force: true })
      return
    }
    if (e.target.closest('[data-end-session]')) {
      if (!await ask({ title: 'End this session for everyone?', message: 'Everyone is disconnected, and the session and its stored files are deleted from the relay. Your own folder is not touched.', ok: 'End session', danger: true })) return
      try { await api('POST', `/api/sessions/${current}/end`); toast('Session ended') } catch (err) { toast(err.message) }
      return
    }
  })
  root.addEventListener('submit', async (e) => {
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
      refreshPeople()
    } catch (err) { toast(err.message) } finally { save.disabled = false }
  })
  root.addEventListener('submit', async (e) => {
    const f = e.target.closest('.pm-gh')
    if (!f) return
    e.preventDefault()
    const token = f.token.value.trim()
    if (!token) return toast('Paste a token first')
    const save = f.querySelector('[type=submit]')
    save.disabled = true
    try {
      await api('POST', `/api/sessions/${current}/github-token`, { token })
      f.token.value = ''
      toast('Token saved: the relay brings in commits while everyone\'s offline')
      refreshPeople({ force: true })
    } catch (err) { toast(err.message) } finally { save.disabled = false }
  })
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
  if (!a || (!a.tool && a.status !== 'unavailable' && a.sharing !== false)) return '' // nothing to say: no line
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
      const tag = note ? (g.hold.kind === 'switching' ? (g.hold.waiting === 'refused' ? `not syncing · ${esc(g.hold.to || '?')} isn't in the session` : g.hold.waiting === 'retrying' ? `waiting for ${esc(g.hold.to || '?')}…` : `moving to ${esc(g.hold.to || '?')}…`) : g.hold.conflict ? 'paused: resolve the git conflict' : 'syncing paused: git is busy') : ''
      const up = g.upstream
      const behind = !tag && up && (up.behind || up.diverged) ? `<span class="tag${needsHand(up) ? ' warn' : ''}">${needsHand(up) ? 'needs a pull' : `${up.behind} behind`}</span>` : ''
      const full = g.full ? '<span class="tag warn" title="This branch is over the session\'s size limit: new changes aren\'t saved. Start a fresh copy with git checkout -b.">full</span>' : ''
      label.innerHTML = `${I.branch}<span class="branch-name">${esc(g.key)}</span>${tag ? `<span class="tag" title="${tag}">${tag}</span>` : ''}${behind}${full}`
      label.title = g.hold ? (g.hold.kind === 'switching' ? (g.hold.waiting === 'refused' ? `The session can't take ${g.hold.to || 'this branch'}, so this folder isn't syncing. Check out ${g.key} again in git to keep syncing there.` : `You checked out ${g.hold.to || 'another branch'} in git: this folder is moving to that branch's work in the session. The branch it left keeps its own.`) : g.hold.conflict ? `git left a conflict in ${g.hold.conflict.join(', ')} on this computer. Resolve it and git add it; Quilt then shares your resolution.` : 'Quilt waits for git to finish, then catches up.') : `This folder is on ${g.key}${up ? `, ${upstreamText(up)}` : ''}${g.full ? '. Over the size limit: new changes aren\'t saved.' : ''}. Click for every branch in the session.`
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
  refreshPeople()
  renderAccess()
  renderCatchUp($('#catchup'), st.catchUp, { colors: new Map([st.me, ...st.peers].map((p) => [p.name, p.color])) })
  renderMerges()
  renderCommitChip()
  $('#rename-btn').hidden = !st.access?.owner
  $('#move-ws-btn').hidden = !(st.access?.owner && state.workspacesOn && (state.workspaces || []).some((w) => w.access === 'edit'))
  renderTaskButton()
  $('#chat-sub').textContent = st.peers.length ? `with ${peopleHere(st).map((p) => p.sessions && p.mine ? 'your AI' : p.name).join(', ')}` : 'just you so far'
}

// --------------------------------------------------------------- commits --
// Agents commit their own work through the relay (quilt_commit, relay-commit.js), within what the
// owner lets them: picked here. When they can't, they ask (commit.js): in a folder with git each
// request has a Commit button (exactly its files, then a push). "Not committed yet" shows the
// uncommitted work here by who made it, so nothing finished sits unshipped unnoticed.
let commitWork = null // GET uncommitted, while the panel is open
let commitGithub = null // the owner's GitHub connection (GET /api/github), while the panel is open
function bindCommitChip () {
  const wrap = $('#commit-wrap')
  const chip = $('#commit-chip')
  const panel = $('#commit-panel')
  const setOpen = (open) => {
    panel.hidden = !open
    chip.setAttribute('aria-expanded', String(open))
    if (open) { renderCommitPanel(); loadCommitWork() }
  }
  chip.onclick = () => setOpen(panel.hidden)
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setOpen(false); chip.focus() } })
  document.addEventListener('mousedown', (e) => { if (!wrap.contains(e.target) && !e.target.closest('.modal, .dialog')) setOpen(false) }, { signal: mounted.signal })
  panel.addEventListener('change', async (e) => {
    if (!e.target.matches('[data-agent-commits]')) return
    try {
      const r = await api('POST', `/api/sessions/${current}/agent-commits`, { mode: e.target.value })
      toast(AGENT_COMMIT_WORDS[r.agentCommits])
    } catch (err) { toast(err.message); renderCommitPanel() }
  })
  panel.addEventListener('click', async (e) => {
    if (e.target.closest('[data-gh-connect]')) {
      try {
        const { url } = await api('POST', '/api/github/connect')
        window.open(url, '_blank', 'noopener')
        toast('Finish in your browser, then come back')
      } catch (err) { toast(err.message) }
      return
    }
    const b = e.target.closest('[data-done], [data-commit], [data-commit-group]')
    if (!b) return
    b.disabled = true
    try {
      if (b.dataset.done) {
        const id = b.dataset.done === 'all' ? null : b.dataset.done
        const r = await api('POST', `/api/sessions/${current}/commit-request/done`, id ? { id } : {})
        toast(r.done === 1 ? 'Closed' : `Closed ${r.done}`)
      } else if (b.dataset.commit) {
        b.textContent = 'Committing…'
        const r = await api('POST', `/api/sessions/${current}/commit-request/commit`, { id: b.dataset.commit })
        toast(r.hash ? `Committed ${r.hash.slice(0, 7)}${r.pushed ? ' and pushed' : `; not pushed: ${r.pushError || 'no upstream'}`}` : 'Already in git: closed')
      } else {
        const g = (commitWork?.groups || [])[Number(b.dataset.commitGroup)]
        if (!g) return
        const who = g.by || 'unknown'
        const message = await ask({ title: `Commit ${g.by ? `${g.by}'s` : 'these'} changes`, message: `${g.files.length} file${g.files.length === 1 ? '' : 's'}: ${g.files.slice(0, 6).join(', ')}${g.files.length > 6 ? ', …' : ''}. Quilt commits exactly these and pushes.`, ok: 'Commit and push', input: { label: 'Commit message', placeholder: `Changes by ${who}` } })
        if (!message) { b.disabled = false; return }
        const req = await api('POST', `/api/sessions/${current}/commit-request`, { message: message.trim(), files: g.files, ...(g.by ? { by: g.by } : {}) })
        const r = await api('POST', `/api/sessions/${current}/commit-request/commit`, { id: req.id })
        toast(r.hash ? `Committed ${r.hash.slice(0, 7)}${r.pushed ? ' and pushed' : `; not pushed: ${r.pushError || 'no upstream'}`}` : 'Already in git')
      }
      loadCommitWork()
    } catch (err) { toast(err.message); b.disabled = false; loadCommitWork() }
  })
}

async function loadCommitWork () {
  if ($('#commit-panel').hidden) return
  const st = sum().status
  if (st.access?.owner) { try { commitGithub = await api('GET', '/api/github') } catch { commitGithub = null } }
  if (st.canCommit) { try { commitWork = await api('GET', `/api/sessions/${current}/uncommitted`) } catch { commitWork = null } }
  renderCommitPanel()
}

function renderCommitChip () {
  const chip = $('#commit-chip')
  if (!chip) return
  const st = sum().status
  const open = (st.commits || []).filter((r) => r.state === 'open')
  const left = st.uncommitted && st.uncommitted.files ? st.uncommitted : null
  chip.hidden = !open.length && !left
  if (chip.hidden) { $('#commit-panel').hidden = true; return }
  const busy = busyPeople(st)
  chip.className = `commit-chip${open.length && !busy.length ? ' ready' : ''}${!open.length ? ' quiet' : ''}`
  chip.innerHTML = open.length
    ? `${I.branch}<span>${open.length === 1 ? 'Commit requested' : `${open.length} commits requested`}${busy.length ? ` · ${busy.length} working` : ''}</span>`
    : `${I.branch}<span>${left.files} not committed</span>`
  chip.title = open.length ? open.map((r) => `${r.by}: ${r.message}`).join('\n') : `Files changed in this folder that are not in git yet${left.people.length ? `, by ${left.people.join(', ')}` : ''}`
  if (!$('#commit-panel').hidden) renderCommitPanel()
}

/** Open requests (Commit, Close), the uncommitted work here by who made it, and committing by itself. */
function renderCommitPanel () {
  const panel = $('#commit-panel')
  if (!panel) return
  const st = sum().status
  const open = (st.commits || []).filter((r) => r.state === 'open')
  const work = st.canCommit ? commitWork : null
  const held = new Map((work?.requests || []).map((r) => [r.id, r]))
  const fileList = (files) => `<details><summary>${files.length} file${files.length === 1 ? '' : 's'}</summary><ul class="commit-files">${files.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></details>`
  const req = (r) => {
    const w = held.get(r.id)
    const why = r.error ? `Last try: ${r.error}` : w && w.blocker && w.blocker !== 'just asked' ? (w.blocker === 'nothing to commit' ? 'Already in git: it closes by itself.' : `Needs a look: ${w.blocker}.`) : ''
    return `<li><b>${esc(r.by)}</b>${r.task ? ` <span class="hint">· task</span>` : ''}<div>${esc(r.message)}</div>
      ${Array.isArray(r.files) && r.files.length ? fileList(r.files) : ''}
      ${why ? `<p class="commit-why">${esc(why)}</p>` : ''}
      <div class="commit-acts">${st.canCommit ? `<button type="button" class="btn sm" data-commit="${esc(r.id)}">Commit and push</button>` : ''}<button type="button" class="btn sm ghost" data-done="${esc(r.id)}" title="Close it without a commit from Quilt (committed by hand, or not needed)">Close</button></div></li>`
  }
  const groups = (work?.groups || []).map((g, i) => `<li><b>${esc(g.by || 'Not on record')}</b>${fileList(g.files)}<div class="commit-acts"><button type="button" class="btn sm ghost" data-commit-group="${i}">Commit…</button></div></li>`).join('')
  const html = `
    ${open.length ? `<h4>Asked to be committed</h4><ul class="commit-reqs">${open.map(req).join('')}</ul>` : '<p class="hint">No open commit requests.</p>'}
    ${st.canCommit ? `<h4>Not committed yet</h4>${work ? (groups ? `<ul class="commit-reqs">${groups}</ul>` : '<p class="hint">Everything here is in git.</p>') : '<p class="hint">Looking…</p>'}` : '<p class="hint">A person with git on this branch commits these; you are told the commit.</p>'}
    ${st.access?.owner ? `<label class="commit-auto">Agents may commit <select data-agent-commits>${Object.entries(AGENT_COMMIT_CHOICES).map(([v, l]) => `<option value="${v}"${(st.agentCommits || 'branches') === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <span class="hint">${githubLine(st)}</span></label>` : ''}
    ${open.length > 1 ? '<div class="commit-foot"><button type="button" class="btn sm ghost" data-done="all">Close all</button></div>' : ''}`
  // Status comes in often: redrawn only when something in it changed, so an open menu or a
  // file list someone expanded stays as it is.
  if (panel.dataset.html === html) return
  panel.dataset.html = html
  panel.innerHTML = html
}

/** How agents get to commit: the owner's GitHub connection (or a token), or what to do to connect it. */
function githubLine (st) {
  const g = commitGithub
  if (g && g.connected) return `Through your GitHub (@${esc(g.login)}), on the repositories you installed Quilt on. <button type="button" class="linkish" data-gh-connect>Add repositories</button>`
  if (g && g.available) return `${st.access.githubToken ? 'They commit with the session\'s GitHub token. ' : ''}<button type="button" class="btn sm" data-gh-connect>Connect GitHub</button> One click: pick the repositories, and agents commit without anyone online.`
  return st.access.githubToken ? 'They commit with the session\'s GitHub token.' : 'They need GitHub connected: sign in to Quilt first.'
}

const AGENT_COMMIT_CHOICES = { off: 'Not at all (they ask)', branches: 'To branches of their own', any: 'To any branch' }
const AGENT_COMMIT_WORDS = { off: 'Agents ask a person to commit', branches: 'Agents commit to branches of their own, with pull requests', any: 'Agents may commit to any branch' }

async function askForCommit () {
  const message = await ask({ title: 'Ask for a commit', message: 'Of everything you changed that is not in git yet. A person with git on this branch commits it, and you are told the commit.', ok: 'Ask', input: { label: 'What is the commit for?', placeholder: 'Pricing page and download button' } })
  if (!message) return
  try {
    const r = await api('POST', `/api/sessions/${current}/commit-request`, { message: message.trim() })
    toast(`Asked for a commit of ${r.files.length} file${r.files.length === 1 ? '' : 's'}`)
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

/**
 * The owner moves this session into a workspace (or from one to another). Its people and
 * agents come along when you manage that workspace; the toast says who was added.
 */
async function moveToWorkspace () {
  const s = sum()
  const options = (state.workspaces || []).filter((w) => w.access === 'edit' && w.id !== s.workspace)
  if (!options.length) return toast(s.workspace ? 'No other workspace you can edit.' : 'No workspace you can edit. Make one on Home first.')
  const now = (state.workspaces || []).find((w) => w.id === s.workspace)
  const choice = await ask({
    title: 'Move to a workspace',
    message: `${now ? `It is in ${now.name} now. ` : ''}Everyone with access to this session (people and agents) is added to the workspace, when you manage it.`,
    input: { select: options.map((w) => ({ value: w.id, label: w.space?.kind === 'org' ? `${w.name} · ${w.space.name}` : w.name })) },
    ok: 'Move'
  })
  if (!choice) return
  try {
    const r = await api('POST', `/api/workspaces/${encodeURIComponent(choice)}/sessions/move`, { session: current })
    const name = options.find((w) => w.id === choice)?.name || 'the workspace'
    s.workspace = choice
    const who = (r.added || []).map((a) => a.name || 'someone')
    toast(r.peopleNeedAdmin
      ? `Moved to ${name}. Only its admins can add this session's people to it.`
      : who.length ? `Moved to ${name}, with ${who.length <= 3 ? who.join(', ') : `${who.slice(0, 3).join(', ')} and ${who.length - 3} more`}` : `Moved to ${name}`)
    // Workspace counts and members changed: refresh them, and this session's top bar.
    try { const l = await api('GET', '/api/workspaces'); state.workspaces = l.workspaces || state.workspaces } catch {}
    renderTop()
  } catch (err) { toast(err.message) }
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

/** Owner controls for everyone who has been let in, shown in Session settings. */
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
    ${githubTokenHtml(acc)}
    ${wsAgents.id === current ? sessionAgentsHtml(wsAgents.agents, st) : ''}<div class="pm-foot"><button type="button" class="btn sm ghost danger" data-end-session>End session for everyone</button></div>`
}

/**
 * The owner's GitHub token: the relay brings commits in from a private repository with it while
 * nobody's folder is online, and commits members' work with it (quilt_commit) when it can write.
 * Never shown back: only whether one is set.
 */
export function githubTokenHtml (acc) {
  if (!acc || !acc.owner) return ''
  const set = !!acc.githubToken
  return `<div class="pm-section"><div class="pm-title">GitHub</div>
    <form class="pm-gh pm-admit" autocomplete="off">
      <label for="pm-gh-token"><span>GitHub token for this session's repository</span></label>
      <input class="input" id="pm-gh-token" type="password" name="token" autocomplete="off" spellcheck="false" placeholder="${set ? 'A token is set: paste another to replace it' : 'github_pat_… for this repository'}" aria-label="GitHub token">
      <div class="pm-gh-row"><button type="submit" class="btn sm">Save token</button>${set ? '<button type="button" class="btn sm ghost" data-gh-clear>Remove token</button>' : ''}</div>
      <div class="hint">With "Contents: Read" Quilt brings in commits while everyone's offline (private repositories need it). With "Contents: Read and write" (and "Pull requests: Read and write") agents can commit their own work, within what you let them in the commit panel, without anyone online. It stays on the relay and is never shown to anyone, you included.</div>
    </form></div>`
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
  refreshPeople({ force: true })
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
  refreshPeople({ force: true })
}

/** Redraws whatever shows people and access: the people menu and the Session settings window, when open. */
function refreshPeople (opts = {}) {
  if (!$('#people-menu').hidden) renderPeopleMenu()
  if (document.querySelector('.session-settings-back')) renderSessionSettings(opts)
}

/** Who is here and what each is working on, at a glance. Access and sharing live in Session settings. */
function renderPeopleMenu () {
  const st = sum().status
  const menu = $('#people-menu')
  const focusEl = menu.querySelector('#focus-input')
  const typing = focusEl && document.activeElement === focusEl ? focusEl.value : null
  const self = personInfo(st.me.name)
  const message = (name) => `<button class="btn sm ghost icon pm-dm" data-dm="${esc(name)}" title="Message ${esc(name)}" aria-label="Message ${esc(name)}">${I.chat}</button>`
  const row = (p) => {
    const editing = p.editing && p.editing[0] ? `<span class="pm-sub">Editing <code>${esc(p.editing[0].path)}</code></span>` : ''
    return `<div class="pm-row">
      <button class="pm-open" data-person="${esc(p.name)}" title="Open ${p.isMe ? 'your' : `${esc(p.name)}'s`} AI chat">${avatar(p.name, p.color, p.online)}
        <span class="pm-main">
          <span class="pm-name">${esc(p.isMe ? `${p.name} (you)` : p.name)}${p.kind === 'agent' ? `<span class="tag bot">${I.bot}agent</span>` : ''}${toolsOf(p).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</span>
          ${p.focus && !p.isMe ? `<span class="pm-sub pm-what">${esc(p.focus)}</span>` : ''}
          ${editing}
          ${agentLine(p) ? `<span class="pm-sub">${agentLine(p)}</span>` : ''}
        </span></button>
      ${p.isMe ? '' : message(p.name)}
    </div>`
  }
  // A person's AI sessions are one row, "Daniel's AI", with what each is working on under it.
  const aiRow = (g) => `<div class="pm-row">
      <div class="pm-open" title="${g.sessions.length === 1 ? 'One chat' : `${g.sessions.length} chats`}: a message goes to the one active last">${avatar(g.name, null, true)}
        <span class="pm-main">
          <span class="pm-name">${esc(g.mine ? 'Your AI' : g.name)}<span class="tag bot">${I.bot}AI</span>${g.agents.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</span>
          ${g.sessions.map((x) => `<span class="pm-sub pm-what" title="${esc(x.name)}">${esc(x.focus || x.name.split(' · ').slice(1).join(' · ') || x.tool || 'AI')}</span>`).join('')}
        </span></div>
      ${message(g.name)}
    </div>`
  const here = peopleHere(st)
  const myAi = here.find((p) => p.sessions && p.mine)
  const others = here.filter((p) => p !== myAi)
  menu.innerHTML = `
    <div class="pm-head"><span>People</span><span class="pm-count">${here.length + 1} here</span></div>
    <div class="pm-list">
      ${row(self)}
      <form class="pm-focus"><input class="input" id="focus-input" placeholder="What are you working on?" aria-label="Your focus" value="${esc(typing ?? st.me.focus ?? '')}"></form>
      ${myAi ? aiRow(myAi) : ''}
      <div class="pm-sep"></div>
      ${others.length ? others.map((p) => p.sessions ? aiRow(p) : row(personInfo(p.name))).join('') : '<div class="pm-empty">Nobody else is here yet. Use <b>Invite</b> to bring someone in.</div>'}
    </div>
    <div class="pm-foot"><button type="button" class="btn sm ghost" data-session-settings>${I.gear}<span>Session settings</span></button></div>`
  if (typing != null) {
    const el = menu.querySelector('#focus-input')
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }
}

/** Your AI chat's sharing in this session: two plain switches. */
function sharingHtml (st) {
  const a = st.me.agent || {}
  // Without posting rights there's nothing to share: the feed is posting too.
  const muted = mayNotPost()
  const sharing = a.sharing !== false && !muted
  const body = a.status === 'unavailable'
    ? `<div class="hint warn">${esc(a.reason || 'Your AI feed is unavailable')}</div>`
    : `<label class="pm-switch ${muted ? 'off' : ''}"><span><b>Share my AI chat</b><small>${muted ? NO_POSTING : 'Others see your prompts and your AI\'s replies.'}</small></span><input type="checkbox" role="switch" data-share ${sharing ? 'checked' : ''} ${muted ? 'disabled' : ''}></label>
        <label class="pm-switch ${sharing ? '' : 'off'}"><span><b>Summarize it first</b><small>Share short summaries instead of every word.</small></span><input type="checkbox" role="switch" data-summarize ${a.summarized ? 'checked' : ''} ${sharing ? '' : 'disabled'}></label>`
  return `<div class="pm-section"><div class="pm-title">Your AI chat</div><div class="pm-card pm-settings">${body}</div></div>`
}

/** The Session settings window: your sharing, and who can get in and what they may do here. */
function openSessionSettings () {
  document.querySelector('.session-settings-back')?.remove()
  $('#people-menu').hidden = true
  $('#people-btn').setAttribute('aria-expanded', 'false')
  const back = document.createElement('div')
  back.className = 'modal-back top session-settings-back'
  back.innerHTML = `<div class="card modal session-settings" role="dialog" aria-modal="true" aria-labelledby="ss-title">
      <div class="ss-head"><h3 id="ss-title">Session settings</h3><p class="lead">For this session only.</p>
        <button type="button" class="btn sm ghost icon ss-close" data-close-ss aria-label="Close">${I.x}</button></div>
      <div class="ss-body"></div>
    </div>`
  document.body.appendChild(back)
  const close = () => back.remove()
  back.addEventListener('mousedown', (e) => { if (e.target === back) close() })
  back.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close() } })
  back.querySelector('[data-close-ss]').onclick = close
  bindSessionSettings(back)
  renderSessionSettings({ force: true })
  if (sum().status.access?.owner) { loadGrants(); if (state.workspacesOn) loadSessionAgents() }
  back.querySelector('[data-close-ss]').focus()
}

function renderSessionSettings ({ force = false } = {}) {
  const box = document.querySelector('.session-settings-back .ss-body')
  if (!box || !current) return
  const st = sum().status
  // Don't redraw under the owner while they change someone's access (unless fresh grants
  // arrived: then the form is redrawn from them, and keeps its focus).
  const active = box.contains(document.activeElement) && document.activeElement.closest('.pm-member') ? document.activeElement : null
  if (!force && active && box.querySelector('.pm-member.edit')) return
  const refocus = active && active.name ? [active.closest('.pm-member').dataset.key, active.name] : null
  box.innerHTML = sharingHtml(st) + membersHtml(st)
  if (refocus) [...box.querySelectorAll('.pm-member')].find((f) => f.dataset.key === refocus[0])?.elements?.[refocus[1]]?.focus()
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
    if (tab && tab.dataset.kind === 'loom') { openLoom(); return }
    if (close) {
      e.stopPropagation()
      const key = close.dataset.close
      const isAi = close.dataset.kind === 'ai'
      const list = isAi ? w.aiTabs : w.fileTabs
      const i = list.indexOf(key)
      if (i !== -1) list.splice(i, 1)
      if (!isAi && w.fileTab) delete w.fileTab[key]
      // Closing a person's AI tab goes back to the Loom; a file tab to the file beside it, or the Loom.
      if (isAi && w.aiSel === key) w.aiSel = null
      if (!isAi && w.fileSel === key) w.fileSel = list[Math.min(i, list.length - 1)] || null
      if (!isAi && w.mode === 'files' && !w.fileSel) w.mode = 'ai'
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
    const t = e.target.closest('[data-fvtab]')
    if (t) showFileTab(t.dataset.fvtab)
    const f = e.target.closest('[data-fv]')
    if (f && f.dataset.fv === 'claim') claimPath(ws(current).fileSel, '')
    if (f && f.dataset.fv === 'release') releasePattern(f.dataset.pattern)
  })
}

function openLoom () {
  const w = ws(current)
  w.aiSel = null
  w.mode = 'ai'
  saveWs(current)
  renderMainBar()
  renderMain()
  renderTreePane()
  renderTop()
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

/** Opens a file tab; `tab: 'changes'` shows its Changes tab, otherwise the tab it was on. */
function openFile (path, { tab } = {}) {
  const w = ws(current)
  if (!w.fileTabs.includes(path)) w.fileTabs.push(path)
  w.fileSel = path
  w.mode = 'files'
  if (!w.fileTab) w.fileTab = {}
  if (tab === 'changes') w.fileTab[path] = 'changes'
  else if (tab === 'file') delete w.fileTab[path]
  loadHistory(path)
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
  const loomOn = w.mode === 'ai' && !w.aiSel
  const st = sum().status
  const anyWorking = [st.me, ...st.peers].some((p) => p?.agent && p.agent.sharing !== false && p.agent.status === 'working')
  const loomTab = `<div class="ws-tab loom-tab${loomOn ? ' on' : ''}" role="tab" aria-selected="${loomOn}" tabindex="0" data-kind="loom" data-tab="loom" title="Everyone's AI conversations, chat and task notes at once">
      <span class="ico">${I.users}</span><span class="nm">Everyone</span>${anyWorking ? '<span class="pulse" title="An AI is working"></span>' : ''}</div>`
  el.innerHTML = loomTab + (w.aiTabs.length ? '<span class="ws-tab-sep"></span>' : '') + w.aiTabs.map((name) => {
    const p = personInfo(name)
    const working = p.agent && p.agent.sharing !== false && p.agent.status === 'working'
    return `<div class="ws-tab${aiOn(name) ? ' on' : ''}" role="tab" aria-selected="${aiOn(name)}" tabindex="0" data-kind="ai" data-tab="${esc(name)}" title="${esc(p.isMe ? 'Your AI chat' : `${name}'s AI chat`)}">
      ${avatar(name, p.color, p.online)}<span class="nm">${esc(p.isMe ? 'Your AI' : `${name}'s AI`)}</span>${working ? '<span class="pulse" title="AI is working"></span>' : ''}
      <button class="x" data-kind="ai" data-close="${esc(name)}" aria-label="Close ${esc(name)}">${I.x}</button></div>`
  }).join('') + (w.fileTabs.length ? '<span class="ws-tab-sep"></span>' : '') +
  w.fileTabs.map((path) => `<div class="ws-tab${fileOn(path) ? ' on' : ''}" role="tab" aria-selected="${fileOn(path)}" tabindex="0" data-kind="file" data-tab="${esc(path)}" title="${esc(path)}">
      <span class="ico">${I.file}</span><span class="nm">${esc(basename(path))}</span>${w.stale[path] ? '<span class="changed" title="Changed"></span>' : ''}
      <button class="x" data-kind="file" data-close="${esc(path)}" aria-label="Close ${esc(basename(path))}">${I.x}</button></div>`).join('') +
  (w.mergeSel ? mergeTabHtml(w) : '')
  $('#mainbar').hidden = false
}

function mergeTabHtml (w) {
  const m = shownMerge()
  const on = w.mode === 'merge'
  const name = m ? `Merge ${basename(m.path)}` : 'Merge'
  return `<span class="ws-tab-sep"></span><div class="ws-tab${on ? ' on' : ''}" role="tab" aria-selected="${on}" tabindex="0" data-kind="merge" data-tab="${esc(w.mergeSel)}" title="${esc(m ? `Compare the two versions of ${m.path}` : 'Merge')}">
      <span class="ico">${I.branch}</span><span class="nm">${esc(name)}</span>
      <button class="x" data-kind="merge" data-close="${esc(w.mergeSel)}" aria-label="Close merge">${I.x}</button></div>`
}

// A card being renamed, or a drag in progress, must not be rebuilt under the pointer.
let draggingTask = false
let boardDirty = false
// Who the next task is for, chosen before Add: `p:name`, `a:name`, or '' for nobody.
// null until chosen: the add form then follows the board's Show choice.
let pendingAssign = null

function renderTaskButton () {
  const btn = $('#tasks-btn')
  if (!btn || !current) return
  const open = (sum()?.status.tasks || []).filter((t) => !t.archived && (t.column === 'todo' || t.column === 'doing')).length
  const n = $('#tasks-count')
  if (n) { n.hidden = open === 0; n.textContent = String(open) }
  const on = ws(current).mode === 'tasks'
  btn.classList.toggle('on', on)
  btn.setAttribute('aria-pressed', String(on))
}

function editingTask () {
  const el = document.activeElement
  if (!el?.closest) return false
  return !!el.closest('.task-edit, .task-assign, .task-file, .task-file-form, .task-cron, .task-cron-form, .task-add-assign, .task-show')
}

function taskPeople (st) {
  // A person's AI sessions are assigned as "their AI" (forAi), not one by one.
  return [st.me, ...(st.peers || [])].filter((p) => p && p.name && !p.persona).map((p) => ({
    name: p.name,
    color: p.color,
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

// ------------------------------------------------------ board: folding --
// The board always fits: when its columns can't all sit side by side, the ones
// you're not using fold to a thin strip (name and count), so nothing is ever off
// to the side. foldPlan (board.js) decides which; this lays it out and keeps your
// choices per session: the columns you opened (most recent first) and folded.
const boardCounts = new Map() // session -> { column: count } at the last layout, to pulse a folded column that grew
let unfoldTimer = null // a dragged card resting on a strip opens that column

function boardChoices () {
  const w = ws(current)
  return { picked: w.boardOpen || [], folded: w.boardFolded || [], counts: boardCounts.get(current) || {} }
}

/**
 * Folds and opens the columns to fit the board's width. `animate` when you opened or folded one:
 * a fresh render or a resize lands in place, or every status tick would replay the folding.
 */
function layoutBoard (root = $('#main'), { animate = false } = {}) {
  const board = root?.querySelector('.board')
  const cols = board?.querySelector('.board-cols')
  if (!cols) return
  if (!animate) cols.classList.add('still')
  const all = [...cols.querySelectorAll('.board-col')]
  const counts = {}
  for (const col of all) counts[col.dataset.column] = col.querySelectorAll('.task').length // every card, found by a search or not
  const pad = parseFloat(getComputedStyle(cols).paddingLeft) || 0
  const plan = foldPlan({ ...boardChoices(), counts, room: cols.clientWidth - 2 * pad })
  const open = new Set(plan.open)
  board.dataset.layout = plan.layout
  const before = boardCounts.get(current)
  for (const col of all) {
    const id = col.dataset.column
    const isOpen = open.has(id)
    col.classList.toggle('folded', !isOpen)
    // Hidden parts can't be tabbed into or read out: the strip when open, the cards when folded.
    col.querySelector('.board-strip').inert = isOpen
    for (const part of col.querySelectorAll(':scope > h3, :scope > .board-list')) part.inert = !isOpen
    // The last open column can't be folded: something is always open.
    const fold = col.querySelector('.board-fold')
    if (fold) fold.hidden = isOpen && open.size === 1
    if (!isOpen && before && counts[id] > (before[id] ?? counts[id])) {
      const strip = col.querySelector('.board-strip')
      strip.classList.remove('grew')
      void strip.offsetWidth // restart the animation
      strip.classList.add('grew')
    }
  }
  boardCounts.set(current, counts)
  if (!animate) {
    void cols.offsetWidth // settle without transitions, then let later changes animate
    cols.classList.remove('still')
  }
}

/** Opens a column: it becomes the most recent, so the least recent open one folds to make room. */
function openColumn (id, { focus = false } = {}) {
  const w = ws(current)
  const { order, folded } = foldPlan({ ...boardChoices(), room: 0 })
  w.boardOpen = [id, ...order.filter((x) => x !== id)]
  w.boardFolded = folded.filter((x) => x !== id)
  saveWs(current)
  layoutBoard(undefined, { animate: true })
  if (focus) $(`#main .board-col[data-column="${id}"]`)?.focus({ preventScroll: true }) // the strip clicked is gone: focus its column
}

/** Folds a column to its strip, and keeps it folded until it's opened again. */
function foldColumn (id) {
  const w = ws(current)
  const { order, folded } = foldPlan({ ...boardChoices(), room: 0 })
  w.boardFolded = [...new Set([...folded, id])]
  w.boardOpen = [...order.filter((x) => x !== id), id]
  saveWs(current)
  layoutBoard(undefined, { animate: true })
  $(`#main .board-col[data-column="${id}"] .board-strip`)?.focus()
}

function cancelUnfold () {
  clearTimeout(unfoldTimer)
  unfoldTimer = null
}

// -------------------------------------------------------- board: search --
// The search box hides the cards that don't hold every word typed (board.js
// searchText), in every column. Column and strip counts become the matches, and a
// folded column with matches stands out, so nothing found hides in a strip.
let boardQuery = ''

function searchBoard (root = $('#main')) {
  const input = root?.querySelector('#board-search')
  if (!input) return
  if (input.value !== boardQuery) input.value = boardQuery
  const q = boardQuery.trim()
  let found = 0
  let total = 0
  for (const col of root.querySelectorAll('.board-col')) {
    let n = 0
    const cards = col.querySelectorAll('.task')
    for (const card of cards) {
      const show = !q || matchesSearch(card.dataset.search || '', q)
      card.hidden = !show
      if (show) n++
    }
    total += cards.length
    found += n
    const shown = q ? n : cards.length
    const count = col.querySelector('h3 .board-n')
    if (count) count.textContent = shown
    const strip = col.querySelector('.board-strip-n')
    if (strip) { strip.textContent = shown; strip.dataset.n = shown }
    col.classList.toggle('search-hit', !!q && n > 0)
    col.classList.toggle('search-miss', !!q && !n)
    let none = col.querySelector('.board-nomatch')
    if (q && !n && cards.length) {
      if (!none) {
        none = document.createElement('p')
        none.className = 'board-empty board-nomatch'
        col.querySelector('.board-list')?.appendChild(none)
      }
      none.textContent = 'No matching tickets.'
    } else none?.remove()
  }
  root.querySelector('.board')?.classList.toggle('searching', !!q)
  const n = root.querySelector('.board-search-n')
  if (n) n.textContent = q ? `${found} of ${total}` : ''
  labelFilter(root, { q, found })
}

// ------------------------------------------------------- board: filter --
// Search and Show live behind one Filter button (board.js filterHtml). The button
// says what's on: "agents" · Sam · 8 of 19, accented, with an × to clear it all.
let filterOpen = false

function labelFilter (root, { q = boardQuery.trim(), found = null } = {}) {
  const box = root?.querySelector('#board-filter')
  if (!box) return
  const showing = box.dataset.showLabel || ''
  const total = Number(box.dataset.total) || 0
  const visible = found ?? root.querySelectorAll('.board-col .task:not([hidden])').length
  const on = !!(q || showing)
  const parts = [q && `“${q}”`, showing, on && !root.querySelector('.board.archived') && `${visible} of ${total}`].filter(Boolean)
  const label = box.querySelector('.board-filter-label')
  if (label) label.textContent = on ? parts.join(' · ') : 'Filter'
  box.querySelector('[data-filter-toggle]')?.setAttribute('title', on ? `Filtered: ${parts.join(' · ')}` : 'Search and filter tickets (/)')
  box.classList.toggle('on', on)
  for (const x of box.querySelectorAll('[data-filter-clear]')) x.hidden = !on
}

/** Opens or closes the Filter panel; it stays open across repaints until closed. */
function setFilterOpen (open, { focus } = {}) {
  filterOpen = open
  const panel = $('#board-filter-panel')
  const btn = $('#board-filter [data-filter-toggle]')
  if (!panel || !btn) return
  panel.hidden = !open
  btn.setAttribute('aria-expanded', String(open))
  if (open && focus === 'search') { const i = $('#board-search'); i?.focus(); i?.select() }
  if (open && focus === 'first') ($('#board-search') || panel.querySelector('[aria-checked="true"]'))?.focus()
  if (!open && focus === 'button') btn.focus()
}

function clearFilters () {
  boardQuery = ''
  const w = ws(current)
  if (w.show) { w.show = ''; saveWs(current); paintBoard({ force: true }) } else searchBoard()
}

// ------------------------------------------------------ board: archived --
// Typing in the archive's filter hides the rows whose title doesn't match, and
// opens the groups so matches show; the groups you folded are kept per session.
let archiveQuery = ''

function filterArchive (root = $('#main')) {
  const input = root?.querySelector('#archive-filter')
  if (!input) return
  if (input.value !== archiveQuery) input.value = archiveQuery
  const q = archiveQuery.trim().toLowerCase()
  const closed = ws(current).archiveClosed || []
  let any = false
  for (const group of root.querySelectorAll('.archive-group')) {
    let n = 0
    for (const row of group.querySelectorAll('.task-archived')) {
      const show = !q || row.dataset.title.includes(q)
      row.hidden = !show
      if (show) n++
    }
    group.hidden = !n
    group.querySelector('[data-group-count]').textContent = n
    group.open = q ? n > 0 : !closed.includes(group.dataset.group)
    any ||= n > 0
  }
  root.querySelector('.board-archive-none').hidden = any || !q
}

/** Asks before removing an archived task for good: the row turns into a confirmation. */
function askRemove (row, ask) {
  row.classList.toggle('confirming', ask)
  if (ask) row.querySelector('[data-task-remove-cancel]')?.focus() // the safe choice has focus
  else row.querySelector('[data-task-remove-ask]')?.focus()
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
  el.addEventListener('input', (e) => {
    if (e.target.id === 'board-search') { boardQuery = e.target.value; searchBoard(el); return }
    if (e.target.id !== 'archive-filter') return
    archiveQuery = e.target.value
    filterArchive(el)
  })
  // "/" from anywhere on the board (not while typing) goes to the search.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || !current || ws(current).mode !== 'tasks') return
    if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return
    if (!$('#board-filter')) return
    e.preventDefault()
    setFilterOpen(true, { focus: $('#board-search') ? 'search' : 'first' })
  }, { signal: mounted.signal })
  // A click outside the Filter panel closes it.
  document.addEventListener('mousedown', (e) => {
    if (filterOpen && !e.target.closest?.('#board-filter')) setFilterOpen(false)
  }, { signal: mounted.signal })
  // Folding a group is remembered, but not the opening that filtering does.
  el.addEventListener('toggle', (e) => {
    const group = e.target.closest?.('.archive-group')
    if (!group || archiveQuery.trim()) return
    const w = ws(current)
    const closed = new Set(w.archiveClosed || [])
    if (group.open) closed.delete(group.dataset.group)
    else closed.add(group.dataset.group)
    w.archiveClosed = [...closed]
    saveWs(current)
  }, true)
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    const row = e.target.closest?.('.task-archived.confirming')
    if (row) { e.preventDefault(); askRemove(row, false); return }
    if (e.target.id === 'archive-filter' && archiveQuery) { e.preventDefault(); archiveQuery = ''; filterArchive(el) }
    if (filterOpen && e.target.closest?.('#board-filter')) { e.preventDefault(); setFilterOpen(false, { focus: 'button' }); return }
    if (e.target.closest?.('[data-filter-toggle]') && boardQuery) { e.preventDefault(); boardQuery = ''; searchBoard(el) }
  })
  // The board's width changes with the window and with the file tree and chat beside it.
  const resized = new ResizeObserver(() => { if (current && ws(current).mode === 'tasks') layoutBoard(el) })
  resized.observe(el)
  mounted.signal.addEventListener('abort', () => resized.disconnect())
  el.addEventListener('click', (e) => {
    if (e.target.closest?.('[data-filter-toggle]')) { setFilterOpen(!filterOpen, { focus: filterOpen ? null : 'first' }); return }
    if (e.target.closest?.('[data-filter-clear]')) { clearFilters(); return }
    const pick = e.target.closest?.('[data-show-pick]')
    if (pick) {
      // Kept per session, like the rest of the workspace. The panel stays open to try another.
      const value = pick.dataset.showPick
      ws(current).show = value
      saveWs(current)
      paintBoard({ force: true })
      const again = [...document.querySelectorAll('#board-filter [data-show-pick]')].find((b) => b.dataset.showPick === value)
      again?.focus()
      return
    }
    const unfold = e.target.closest?.('[data-unfold]')
    if (unfold) { openColumn(unfold.dataset.unfold, { focus: true }); return }
    const fold = e.target.closest?.('[data-fold]')
    if (fold) foldColumn(fold.dataset.fold)
  })
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
      await changeTasks('', { title, ...who }, () => { pendingAssign = null })
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
    if (e.target.closest('[data-archived-toggle]')) {
      // The board shows the archived tasks in place of its columns.
      ws(current).archived = !ws(current).archived
      archiveQuery = ''
      paintBoard({ force: true })
      if (ws(current).archived) $('#archive-filter')?.focus()
      return
    }
    const ask = e.target.closest('[data-task-remove-ask], [data-task-remove-cancel]')
    if (ask) { askRemove(ask.closest('.task-archived'), ask.matches('[data-task-remove-ask]')); return }
    const more = e.target.closest('[data-task-more]')
    if (more) {
      const id = more.closest('.task')?.dataset.task
      const task = (sum()?.status.tasks || []).find((t) => t.id === id)
      if (!task) return
      const update = async (path, body) => {
        try { await changeTasks(path, body) } catch (err) { toast(err.message) }
      }
      openTaskMenu(more, task, {
        // The board may have been redrawn since the menu opened: find the card again.
        edit: () => {
          const title = [...document.querySelectorAll('.task')].find((c) => c.dataset.task === id)?.querySelector('.task-title')
          if (title) beginEdit(title)
        },
        recur: () => update('/update', { id, recurring: !task.recurring }),
        archive: () => update('/update', { id, archived: true }),
        remove: () => update('/delete', { id })
      })
      return
    }
    const unarchive = e.target.closest('[data-task-unarchive]')
    if (unarchive) {
      const id = unarchive.closest('[data-task]')?.dataset.task
      if (!id) return
      try { await changeTasks('/update', { id, archived: false }) }
      catch (err) { toast(err.message) }
      return
    }
    const notes = e.target.closest('[data-task-notes]')
    if (notes) {
      const id = notes.closest('[data-task]')?.dataset.task
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
      const id = e.target.closest('[data-task]')?.dataset.task
      if (!id) return
      try { await changeTasks('/delete', { id }) }
      catch (err) { toast(err.message) }
      return
    }
    const title = e.target.closest('.task-title')
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
    if (!col) { cancelUnfold(); return }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    for (const n of el.querySelectorAll('.board-col.over')) if (n !== col) { n.classList.remove('over'); cancelUnfold() }
    col.classList.add('over')
    // Resting on a folded column opens it, so the card can go where it belongs in the list.
    // Dropping on the strip right away puts it at the end.
    if (col.classList.contains('folded') && !unfoldTimer) {
      unfoldTimer = setTimeout(() => { unfoldTimer = null; if (col.classList.contains('over')) openColumn(col.dataset.column) }, 500)
    }
  })
  el.addEventListener('drop', async (e) => {
    cancelUnfold()
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
    cancelUnfold()
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
    // Restoring the last archived task goes back to the board, and stays there.
    if (w.archived && !(st.tasks || []).some((t) => t.archived)) w.archived = false
    // Showing one person's tasks: a new task is theirs too, unless the add form says otherwise.
    const show = typeof w.show === 'string' ? w.show : ''
    const assignTo = pendingAssign ?? (/^[pa]:/.test(show) ? show : '')
    const html = renderBoard(st.tasks || [], me(), taskPeople(st), assignTo, { archived: !!w.archived, show, closedGroups: w.archiveClosed || [] })
    // Status ticks arrive every few seconds. Re-rendering an unchanged board
    // would throw away hover, selection and scroll for nothing.
    if (html === lastBoard.html && lastBoard.el && el.firstElementChild === lastBoard.el) return
    const scroll = boardScroll(el)
    const box = ['archive-filter', 'board-search'].includes(document.activeElement?.id) ? document.activeElement : null
    const typing = box ? { id: box.id, at: box.selectionStart } : null
    el.innerHTML = html
    lastBoard = { html, el: el.firstElementChild }
    layoutBoard(el)
    restoreBoardScroll(el, scroll)
    filterArchive(el)
    searchBoard(el)
    if (filterOpen) setFilterOpen(true)
    labelFilter(el)
    if (typing) {
      const input = $(`#${typing.id}`)
      input?.focus()
      try { input?.setSelectionRange(typing.at, typing.at) } catch {}
    }
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
      if (!people.length && !state.feeds.get(current)?.get(st.me.name)?.length) {
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
      renderLoomView(el)
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
    renderFileView(el, {
      path: w.fileSel,
      file: cached ? cached.file : null,
      meta: treeMeta(w.fileSel),
      me: me(),
      prevText: cached ? cached.prevText : null,
      tab: fileTabOf(w.fileSel),
      history: histories.get(fileKey(w.fileSel)) || null,
      summary: fileChanges(w.fileSel),
      people: { who: (name) => name === me() ? 'you' : name, colorOf: (name) => personInfo(name).color }
    })
    if (cached && fileTabOf(w.fileSel) === 'file') cached.prevText = null // highlight once, on the File tab
  }
}

const fileKey = (path) => `${current}\n${path}`
const fileTabOf = (path) => (ws(current).fileTab || {})[path] === 'changes' ? 'changes' : 'file'

function showFileTab (tab) {
  const w = ws(current)
  if (!w.fileSel) return
  if (!w.fileTab) w.fileTab = {}
  if (tab === 'changes') w.fileTab[w.fileSel] = 'changes'
  else delete w.fileTab[w.fileSel]
  saveWs(current)
  renderMain()
  $('#main .fv-tabs [aria-selected="true"]')?.focus()
  if (tab === 'changes') loadHistory(w.fileSel)
}

// ------------------------------------------------------- a file's changes --
const histories = new Map() // fileKey -> history entries, newest first
const historyTimers = new Map()

/** A save is recorded in the history alongside the file: read it again once that has landed. */
function scheduleHistory (path) {
  clearTimeout(historyTimers.get(path))
  historyTimers.set(path, setTimeout(() => { historyTimers.delete(path); loadHistory(path) }, 500))
}

async function loadHistory (path) {
  const id = current
  try {
    const { entries } = await api('GET', `/api/sessions/${id}/history?path=${encodeURIComponent(path)}`)
    if (id !== current) return
    histories.set(`${id}\n${path}`, entries)
    const w = ws(id)
    if (w.mode !== 'files' || w.fileSel !== path) return
    if (fileTabOf(path) === 'changes') renderMain()
    else renderFileTabs($('#main'), { tab: 'file', history: entries, summary: fileChanges(path) }) // the count only: freshly changed lines stay lit
  } catch {}
}

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

// ------------------------------------------------------------------ Loom --
function loomPrefs (w) {
  const p = w.loom && typeof w.loom === 'object' ? w.loom : {}
  const names = (list) => Array.isArray(list) ? list.filter((n) => typeof n === 'string') : []
  w.loom = {
    chat: p.chat !== false,
    tasks: p.tasks !== false,
    density: p.density === 'compact' ? 'compact' : 'detailed',
    layout: p.layout === 'merged' ? 'merged' : 'lanes',
    hidden: names(p.hidden),
    pinned: names(p.pinned), // lanes kept open when they don't all fit
    opened: names(p.opened).slice(0, 20) // lanes opened from a strip, latest first
  }
  return w.loom
}

function renderLoomView (el) {
  const s = sum()
  const st = s.status
  // Each person's AI sessions share one lane, "<person>'s AI", as in chat.
  const { personOf, ...data } = foldAiLanes({
    people: [
      { ...st.me, isMe: true, online: st.connected },
      ...st.peers.map((p) => ({ ...p, online: p.hosted ? 'http' : true, optional: !!p.persona }))
    ],
    owners: owners(s),
    feeds: state.feeds.get(current) || new Map(),
    messages: renderable(state.messages.get(current)),
    tasks: st.tasks || [],
    claims: st.claims || []
  })
  loomPersonOf = personOf
  const prefs = loomPrefs(ws(current))
  renderLoom(el, {
    build: (merged, width) => buildLoom({ ...data, show: prefs, hidden: prefs.hidden, merged, width, pinned: prefs.pinned, opened: prefs.opened }),
    prefs,
    me: st.me.name,
    names: mentionNames(s),
    meAgent: st.me.kind === 'agent',
    onAction: loomAction
  })
}

let loomPersonOf = new Map() // a "<person>'s AI" lane -> the person whose AI chat it opens

function loomAction (kind, value) {
  const w = ws(current)
  const prefs = loomPrefs(w)
  if (kind === 'person') return openPerson(loomPersonOf.get(value) || value)
  if (kind === 'conv') { openPerson(loomPersonOf.get(value.name) || value.name); pickConv(value.conv); return }
  if (kind === 'file') return openFile(value)
  if (kind === 'task') {
    const task = (sum().status.tasks || []).find((t) => t.id === value)
    if (task) openTaskNotes(task)
    return
  }
  if (kind === 'hide') prefs.hidden = [...new Set([...prefs.hidden, value])]
  else if (kind === 'unhide') prefs.hidden = prefs.hidden.filter((n) => n !== value)
  else if (kind === 'toggle') prefs[value] = prefs[value] === false
  else if (kind === 'density') prefs.density = value
  else if (kind === 'layout') prefs.layout = value
  else if (kind === 'pin') prefs.pinned = prefs.pinned.includes(value) ? prefs.pinned.filter((n) => n !== value) : [...prefs.pinned, value]
  else if (kind === 'open-lane') { prefs.opened = [value, ...prefs.opened.filter((n) => n !== value)].slice(0, 20); prefs.layout = 'lanes' }
  saveWs(current)
  renderMain()
}

const feedsLoading = new Set()
async function loadFeed (name) {
  const id = current
  const key = `${id}|${name}`
  if (feedsLoading.has(key)) return
  feedsLoading.add(key)
  try {
    const { entries } = await api('GET', `/api/sessions/${id}/feed?who=${encodeURIComponent(name)}`)
    if (!state.feeds.has(id)) state.feeds.set(id, new Map())
    state.feeds.get(id).set(name, entries)
    feedsLoading.delete(key)
    if (id === current && ws(id).mode === 'ai' && (!ws(id).aiSel || ws(id).aiSel === name)) renderMain()
  } catch (err) {
    setTimeout(() => feedsLoading.delete(key), 30000) // not again on every status tick
    if (ws(id).aiSel === name) toast(err.message)
  }
}

function loadFeeds () {
  if (!state.feeds.has(current)) state.feeds.set(current, new Map())
  return Promise.all(ws(current).aiTabs.map((name) => loadFeed(name)))
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
  // The rows were replaced: keep the card on the one still under the pointer, with fresh numbers.
  if (cardPath) {
    const row = treeRow(cardPath)
    const under = cardPointer && document.elementFromPoint(cardPointer.x, cardPointer.y)?.closest('[data-file]')
    if (row && (under === row || row.matches(':focus-visible'))) showTreeCard(row)
    else hideTreeCard()
  }
}

// ------------------------------------------------------------- change card --
// Hovering a file the session changed shows its +/−, who made them and when
// (tree.js draws it). It waits a moment so a pointer passing over the tree
// doesn't flash cards, then follows from row to row at once. Arrowing to a row
// shows it too; a click doesn't, it opens the file.
const CARD_DELAY = 300
let cardPath = null // the file whose card is showing
let cardTimer = null
let cardWarmUntil = 0 // just closed: the next row's card shows at once
let cardPointer = null // where the pointer last was over the tree, to find its row after a re-render

const treeRow = (path) => [...document.querySelectorAll('#tree [data-file]')].find((r) => r.dataset.file === path)

function restoreRowTitle (path) {
  const row = path && treeRow(path)
  if (row?.dataset.title) { row.title = row.dataset.title; delete row.dataset.title }
}

/** How much of a file's changes the history still has a diff for: 'all', 'some', 'none', or null until read. */
function keptOf (path) {
  const entries = histories.get(fileKey(path))
  if (!entries) return null
  if (!entries.length) return 'none'
  return rolledOff(entries, fileChanges(path)).length ? 'some' : 'all'
}

// The card reads the file's history to say whether the Changes tab has a diff; it may have
// changed since, so it's read again each time a card opens (it's local and small).
const keptReading = new Set()
async function readKept (path) {
  if (keptReading.has(path)) return
  keptReading.add(path)
  const id = current
  try {
    const { entries } = await api('GET', `/api/sessions/${id}/history?path=${encodeURIComponent(path)}`)
    if (id !== current) return
    histories.set(fileKey(path), entries)
    if (cardPath === path) { const row = treeRow(path); if (row) showTreeCard(row, { fresh: false }) }
  } catch {} finally { keptReading.delete(path) }
}

function showTreeCard (row, { fresh = true } = {}) {
  const f = fileChanges(row.dataset.file)
  if (!f) { hideTreeCard(); return }
  if (fresh && row.dataset.file !== cardPath) readKept(row.dataset.file)
  if (cardPath !== row.dataset.file) restoreRowTitle(cardPath) // moving row to row: the card follows
  cardPath = row.dataset.file
  // The row's own tooltip (its full path) would pop up over the card: the card shows the path.
  if (row.title) { row.dataset.title = row.title; row.removeAttribute('title') }
  showChangeCard(row, changeCardHtml(f, {
    who: (name) => name === me() ? 'you' : name,
    colorOf: (name) => personInfo(name).color,
    kept: keptOf(row.dataset.file)
  }))
}

function hideTreeCard ({ warm = true } = {}) {
  clearTimeout(cardTimer)
  if (!cardPath) return
  restoreRowTitle(cardPath)
  cardPath = null
  if (warm) cardWarmUntil = Date.now() + CARD_DELAY
  hideChangeCard()
}

function cardSoon (row) {
  clearTimeout(cardTimer)
  if (!fileChanges(row.dataset.file)) { hideTreeCard(); return }
  readKept(row.dataset.file) // during the wait, so the card opens knowing
  const now = cardPath || Date.now() < cardWarmUntil
  cardTimer = setTimeout(() => showTreeCard(row), now ? 0 : CARD_DELAY)
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
    const changes = e.target.closest('[data-changes]')
    if (changes) { e.stopPropagation(); openFile(changes.dataset.changes, { tab: 'changes' }); return }
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
  el.addEventListener('mousemove', (e) => { cardPointer = { x: e.clientX, y: e.clientY } }, { passive: true })
  el.addEventListener('mouseover', (e) => {
    const row = e.target.closest?.('[data-file]')
    if (row && showsLoom($('#main'))) focusFile($('#main'), row.dataset.file) // the Loom lights who worked on it
    if (row && row.dataset.file !== cardPath) cardSoon(row)
  })
  el.addEventListener('mouseout', (e) => {
    const row = e.target.closest?.('[data-file]')
    if (!row || row.contains(e.relatedTarget)) return
    if (showsLoom($('#main'))) focusFile($('#main'), null)
    clearTimeout(cardTimer)
    cardTimer = setTimeout(hideTreeCard, 80) // the next row's mouseover cancels this
  })
  // Keyboard focus shows it; a click's focus doesn't (the click opens the file).
  el.addEventListener('focusin', (e) => {
    const row = e.target.closest?.('[data-file]')
    if (row && row.matches(':focus-visible')) showTreeCard(row)
  })
  el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget)) hideTreeCard({ warm: false }) })
  el.addEventListener('mousedown', () => hideTreeCard({ warm: false }))
  el.addEventListener('scroll', () => hideTreeCard({ warm: false }), { passive: true })
  window.addEventListener('blur', () => hideTreeCard({ warm: false }), { signal: mounted.signal })
  mounted.signal.addEventListener('abort', () => hideTreeCard({ warm: false }))
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && cardPath) { hideTreeCard({ warm: false }); return }
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
  // Partners see "… is typing" while there is text in the box: said again every few seconds
  // while keys come, taken back when the box is cleared or loses focus (sending clears it too).
  let typingSaid = 0
  const sayTyping = (on) => {
    if (mayNotPost()) return
    if (on && Date.now() - typingSaid < TYPING_MS / 2) return
    if (!on && !typingSaid) return
    typingSaid = on ? Date.now() : 0
    api('POST', `/api/sessions/${id}/typing`, { on, to: state.to || null }).catch(() => {})
  }
  input.addEventListener('input', () => sayTyping(!!input.value.trim()))
  input.addEventListener('blur', () => sayTyping(false))
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
      typingSaid = 0 // sending cleared it
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

/** "Dana is typing…" under the messages, with a small chatting animation, while partners type. */
function renderTyping () {
  const el = $('#typing')
  const s = sum()
  if (!el || !s) return
  const html = typingHtml(typingNames(s.status.peers, s.status.me?.name))
  if (el.innerHTML === html) return
  const list = $('#messages')
  const nearBottom = list && list.scrollHeight - list.scrollTop - list.clientHeight < 80
  el.innerHTML = html
  el.hidden = !html
  if (nearBottom) list.scrollTop = list.scrollHeight
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
