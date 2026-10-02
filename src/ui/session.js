// The session workspace: file tree on the left, a partner's live AI chat or a
// shared file in the middle, and the team chat on the right.
import { TOKEN, I, state, $, esc, basename, bytes, clock, avatar, toast, api, ask, remember, recall, toolsOf, busyPeople } from './common.js'
import { openInvite, renderTabs, markRead } from './app.js'
import { renderFeed } from './feed.js'
import { renderTree, openTreeMenu, closeTreeMenu, claimFolder } from './tree.js'
import { renderFileView } from './fileview.js'
import { gitMarkup, bindGit, unbindGit, renderGitButton, gitFilesChanged, gitSessionChanged } from './git.js'
import { changesMarkup, bindChanges, unbindChanges, changesChanged } from './changes.js'
import { quiltMark } from './mark.js'
import { fileCardHref, renderable } from './chat.js'

let current = null // session id being shown
let timers = []
let mounted = null // AbortController for document-level listeners of this mount

// ------------------------------------------------------------ layout state --
// Per session: mode ('ai' | 'files'), open tabs per mode, expanded folders.
function ws (id) {
  if (!state.ws.has(id)) {
    let saved = null
    try { saved = JSON.parse(recall(`ws-${id}`, 'null')) } catch {}
    state.ws.set(id, {
      mode: 'ai',
      aiTabs: [],
      aiSel: null,
      fileTabs: [],
      fileSel: null,
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

function personInfo (name) {
  const st = sum().status
  if (name === st.me.name) return { ...st.me, online: st.connected, isMe: true }
  const p = st.peers.find((x) => x.name === name)
  return p ? { ...p, online: true } : { name, online: false, agent: null }
}

// ------------------------------------------------------------------ mount --
export function mountSession (id) {
  current = id
  mounted = new AbortController()

  $('#app').innerHTML = `
  <div class="ws" id="ws">
    <header class="ws-top">
      <button class="brand" data-go="home" aria-label="Home">${quiltMark({ sew: 'first' })}</button>
      <nav class="tabs" id="tabs" aria-label="Sessions"></nav>
      <span class="spacer"></span>
      <span class="access-pill" id="access-pill" hidden></span>
      <button class="commit-chip" id="commit-chip" hidden></button>
      <button class="btn sm ghost icon narrow-only" id="toggle-tree" title="Files" aria-label="Show files">${I.tree}</button>
      <div class="people" id="people">
        <button class="people-btn" id="people-btn" aria-haspopup="true" aria-expanded="false" aria-controls="people-menu"></button>
        <div class="popover people-menu" id="people-menu" role="dialog" aria-label="People in this session" hidden></div>
      </div>
      ${changesMarkup()}
      ${gitMarkup()}
      ${openInMarkup()}
      <button class="btn sm primary" id="invite-btn">${I.link}<span class="wide-only">Invite</span></button>
      <button class="btn sm ghost icon narrow-only" id="toggle-chat" title="Chat" aria-label="Show chat">${I.chat}<span class="badge" id="chat-badge" hidden></span></button>
      <div class="overflow">
        <button class="btn sm ghost icon" id="more-btn" title="More" aria-label="More" aria-haspopup="true" aria-expanded="false">${I.more}</button>
        <div class="popover more-menu" id="more-menu" role="menu" hidden>
          <button class="pop-item" role="menuitem" id="ask-commit">Ask for a commit…</button>
          <button class="pop-item" role="menuitem" id="leave-btn">Leave this session</button>
          <button class="pop-item" role="menuitem" data-shutdown>Shut down Quilt</button>
        </div>
      </div>
    </header>
    <div class="ws-body" id="ws-body">
      <aside class="ws-tree" aria-label="Project files">
        <div class="pane-head"><span>Files</span><span class="hint" id="file-count"></span></div>
        <div class="tree-scroll" id="tree"></div>
      </aside>
      <main class="ws-main">
        <div class="requests" id="requests" hidden></div>
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
          <div class="box">
            <button type="button" class="btn ghost icon" id="attach-btn" title="Send a file" aria-label="Send a file">${I.clip}</button>
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
  bindGit(id, mounted.signal)
  bindChanges(id, mounted.signal, { onOpen: openFile })
  bindMain()
  bindTreeEvents()
  bindChat()
  renderTop()
  renderMainBar()
  renderMain()
  renderTreePane()
  renderMessages(false, true)
  renderRecipients()
  loadTree()
  loadFeeds()
  autoOpenNewPeople(id) // everyone already here gets a tab on first visit
  // Relative times ("4s ago") and recent-edit badges age out.
  timers.push(setInterval(() => { renderTreePane(); renderTop() }, 15000))
}

export function sessionUnmount () {
  for (const t of timers) clearInterval(t)
  timers = []
  if (mounted) mounted.abort()
  mounted = null
  closeTreeMenu()
  unbindGit()
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
  if (ws(id).mode === 'ai') renderMain()
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
  gitFilesChanged()
  changesChanged()
  const w = ws(id)
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
  $('#invite-btn').onclick = () => openInvite(current)
  bindOpenIn()
  $('#ask-commit').onclick = askForCommit
  $('#commit-chip').onclick = () => {
    if (sum().git) $('#git-btn')?.click()
    else toast($('#commit-chip').title)
  }
  $('#leave-btn').onclick = async () => {
    if (!await ask({ title: 'Leave this session?', message: 'Quilt stops syncing this folder. Your files stay where they are, and you can rejoin later.', ok: 'Leave', danger: true })) return
    await api('POST', `/api/sessions/${current}/stop`).catch((err) => toast(err.message))
  }
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
  const open = () => { clearTimeout(hoverTimer); if (menu.hidden) { menu.hidden = false; openedAt = Date.now(); btn.setAttribute('aria-expanded', 'true'); renderPeopleMenu() } }
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
    if (!f) return
    try {
      await api('POST', `/api/sessions/${current}/members/set`, { key: f.dataset.key, role: f.role.value, ...(f.scopes ? { scopes: parseScopes(f.scopes.value) } : {}) })
      toast('Access updated')
    } catch (err) { toast(err.message) }
  })
  menu.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-remove]')
    if (!b) return
    const f = b.closest('.pm-member')
    if (!await ask({ title: `Remove ${f.querySelector('.nm').textContent.trim()}?`, message: 'They\'ll need a new invite and your approval to come back.', ok: 'Remove', danger: true })) return
    try { await api('POST', `/api/sessions/${current}/members/remove`, { key: f.dataset.key }); toast('Removed') } catch (err) { toast(err.message) }
  })
  menu.addEventListener('click', async (e) => {
    if (e.target.closest('[data-end-session]')) {
      if (!await ask({ title: 'End this session for everyone?', message: 'Everyone is disconnected, and the session and its stored files are deleted from the relay. Your own folder is not touched.', ok: 'End session', danger: true })) return
      try { await api('POST', `/api/sessions/${current}/end`); toast('Session ended') } catch (err) { toast(err.message) }
      return
    }
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

function agentLine (p) {
  const a = p.agent
  if (!a || (!a.tool && a.status !== 'unavailable' && a.sharing !== false)) return p.online ? 'No AI activity found yet' : ''
  if (a.sharing === false) return `<span class="ai-state paused">${p.isMe ? 'You paused sharing' : 'Paused sharing'}</span>`
  if (a.status === 'unavailable') return `<span class="ai-state off" title="${esc(a.reason || '')}">${esc(a.tool || 'AI')} feed unavailable</span>`
  if (a.status === 'working') return `<span class="ai-state working"><span class="pulse"></span>${esc(a.tool || 'AI')} is working…</span>`
  return `<span class="ai-state">${a.tool ? `${esc(a.tool)} idle` : 'AI idle'}</span>`
}

function renderTop () {
  if (!current || !$('#people-btn')) return
  renderTabs()
  renderGitButton()
  const st = sum().status
  const people = [st.me, ...st.peers]
  const shown = people.slice(0, 4)
  $('#people-btn').innerHTML = `<span class="stack">${shown.map((p, i) => `<span style="z-index:${10 - i}">${avatar(p.name, p.color)}</span>`).join('')}</span>
    <span class="count">${people.length}</span><span class="conn ${st.connected ? 'ok' : 'warn'}" title="${st.connected ? 'Connected' : 'Reconnecting…'}"></span>`
  $('#people-btn').setAttribute('aria-label', `${people.length} ${people.length === 1 ? 'person' : 'people'} in this session${st.connected ? '' : ', reconnecting'}`)
  if (!$('#people-menu').hidden) renderPeopleMenu()
  renderAccess()
  renderCommitChip()
  $('#chat-sub').textContent = st.peers.length ? `with ${st.peers.map((p) => p.name).join(', ')}` : 'just you so far'
}

// ---------------------------------------------------------- commit timing --
function renderCommitChip () {
  const chip = $('#commit-chip')
  if (!chip) return
  const s = sum()
  const st = s.status
  const open = (st.commits || []).filter((r) => r.state === 'open')
  const busy = busyPeople(st)
  chip.hidden = !open.length
  if (!open.length) return
  chip.className = `commit-chip${busy.length ? '' : ' ready'}`
  chip.innerHTML = busy.length
    ? `${I.branch}<span>Commit requested · waiting on ${busy.length}</span>`
    : `${I.branch}<span>Ready to commit</span>`
  chip.title = `${open.map((r) => `${r.by}: ${r.message}`).join('\n')}${busy.length ? `\nStill working: ${busy.join(', ')}` : ''}`
  gitSessionChanged()
}

async function askForCommit () {
  const message = await ask({ title: 'Ask for a commit', message: 'The host commits once everyone\'s AI is idle.', ok: 'Ask', input: { label: 'What is the commit for?', placeholder: 'Pricing page and download button' } })
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

/** The access pill, the owner's request bar, and the "waiting to be let in" screen. */
function renderAccess () {
  const st = sum().status
  const acc = st.access || {}
  const pill = $('#access-pill')
  if (pill) {
    const text = acc.state === 'pending' ? 'Waiting to be let in'
      : acc.controlled && acc.role === 'viewer' ? 'View only'
        : acc.controlled && acc.scopes && acc.scopes.length ? `Can change ${scopesText(acc.scopes)}` : ''
    pill.hidden = !text
    pill.textContent = text
    pill.className = `access-pill${acc.state === 'pending' ? ' wait' : ''}`
  }
  const bar = $('#requests')
  if (!bar) return
  const waiting = st.waiting || []
  // Don't redraw while the owner is filling in a request.
  if (bar.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return
  bar.hidden = !waiting.length
  bar.innerHTML = waiting.map((p) => `
    <form class="request" data-key="${esc(p.key)}">
      ${avatar(p.name, null)}
      <div class="rq-main"><b>${esc(p.name)}</b>${p.kind === 'agent' ? `<span class="tag bot">${I.bot}agent</span>` : ''}
        <span class="hint">wants to join · invited to ${p.invitedAs === 'viewer' ? 'view' : 'edit'}</span></div>
      <select class="input" name="role" aria-label="Role for ${esc(p.name)}">
        <option value="editor" ${p.invitedAs !== 'viewer' ? 'selected' : ''}>Can edit</option>
        <option value="viewer" ${p.invitedAs === 'viewer' ? 'selected' : ''}>View only</option>
      </select>
      ${p.kind === 'agent' ? `<input class="input" name="scopes" placeholder="All folders (or e.g. src, docs)" aria-label="Folders ${esc(p.name)} may change" title="Folders this agent may change, separated by commas">` : ''}
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
      await api('POST', `/api/sessions/${current}/members/approve`, { key: f.dataset.key, role: f.role.value, scopes: f.scopes ? parseScopes(f.scopes.value) : [] })
      toast('Let in')
    } catch (err) { toast(err.message); btn.disabled = false }
  })
  bar.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-deny]')) return
    const f = e.target.closest('form')
    try { await api('POST', `/api/sessions/${current}/members/deny`, { key: f.dataset.key }); toast('Denied') } catch (err) { toast(err.message) }
  })
}

/** Owner controls for everyone who has been let in, shown in the people menu. */
function membersHtml (st) {
  const acc = st.access || {}
  if (!acc.controlled) return ''
  const list = (st.members || []).filter((m) => m.role !== 'owner')
  if (!acc.owner) {
    return list.length || st.members?.length ? `<div class="pm-section"><div class="pm-title">Access</div>
      ${(st.members || []).map((m) => `<div class="pm-member"><span class="nm">${esc(m.name)}${m.kind === 'agent' ? ' (agent)' : ''}</span><span class="tag">${roleLabel(m.role)}</span>${m.scopes && m.scopes.length ? `<span class="hint">${esc(scopesText(m.scopes))}</span>` : ''}</div>`).join('')}</div>` : ''
  }
  return `<div class="pm-section"><div class="pm-title">Who can get in</div>
    ${list.length ? list.map((m) => `
      <form class="pm-member edit" data-key="${esc(m.key)}">
        <span class="nm" title="${m.online ? 'Online' : 'Offline'}"><span class="dot" style="background:${m.online ? 'var(--ok)' : 'var(--faint)'}"></span>${esc(m.name)}${m.kind === 'agent' ? ' (agent)' : ''}</span>
        <select class="input" name="role" aria-label="Role for ${esc(m.name)}">
          <option value="editor" ${m.role === 'editor' ? 'selected' : ''}>Can edit</option>
          <option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>View only</option>
        </select>
        ${m.kind === 'agent' ? `<input class="input" name="scopes" value="${esc(scopesText(m.scopes))}" placeholder="All folders" aria-label="Folders ${esc(m.name)} may change" title="Folders this agent may change, separated by commas">` : ''}
        <button type="button" class="btn sm ghost icon" data-remove title="Remove ${esc(m.name)}" aria-label="Remove ${esc(m.name)}">${I.x}</button>
      </form>`).join('') : '<div class="pm-empty">Only you so far. People you let in show up here.</div>'}
    </div>
    <div class="pm-foot"><button type="button" class="btn sm ghost danger" data-end-session>End session for everyone</button></div>`
}

function renderPeopleMenu () {
  const st = sum().status
  const menu = $('#people-menu')
  const focusEl = menu.querySelector('#focus-input')
  const typing = focusEl && document.activeElement === focusEl ? focusEl.value : null
  // Don't redraw under the owner while they change someone's access.
  if (menu.querySelector('.pm-member.edit') && menu.contains(document.activeElement) && document.activeElement.closest('.pm-member')) return
  const self = personInfo(st.me.name)
  const a = st.me.agent || {}
  // Your AI chat: two plain switches instead of a button plus a checkbox.
  const sharing = a.sharing !== false
  const shareLine = a.status === 'unavailable'
    ? `<div class="pm-card"><div class="hint warn">${esc(a.reason || 'Your AI feed is unavailable')}</div></div>`
    : `<div class="pm-card pm-settings">
        <label class="pm-switch"><span><b>Share my AI chat</b><small>Others see your prompts and your AI's replies.</small></span><input type="checkbox" role="switch" data-share ${sharing ? 'checked' : ''}></label>
        <label class="pm-switch ${sharing ? '' : 'off'}"><span><b>Summarize it first</b><small>Share short summaries instead of every word.</small></span><input type="checkbox" role="switch" data-summarize ${a.summarized ? 'checked' : ''} ${sharing ? '' : 'disabled'}></label>
      </div>`
  const row = (p) => {
    const editing = p.editing && p.editing[0] ? `<div class="pm-sub">Editing <code>${esc(p.editing[0].path)}</code></div>` : ''
    return `<div class="pm-row">
      <button class="pm-open" data-person="${esc(p.name)}" title="Open ${p.isMe ? 'your' : `${esc(p.name)}'s`} AI chat">${avatar(p.name, p.color, p.online)}
        <span class="pm-main">
          <span class="pm-name">${esc(p.isMe ? `${p.name} (you)` : p.name)}${p.kind === 'agent' ? `<span class="tag bot">${I.bot}agent</span>` : ''}${toolsOf(p).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</span>
          ${p.focus && !p.isMe ? `<span class="pm-sub">${esc(p.focus)}</span>` : ''}
          ${editing}
          <span class="pm-sub">${agentLine(p)}</span>
        </span></button>
      ${p.isMe ? '' : `<button class="btn sm ghost" data-dm="${esc(p.name)}">Message</button>`}
    </div>`
  }
  const others = st.peers.length
    ? st.peers.map((p) => row(personInfo(p.name))).join('')
    : '<div class="pm-empty">Nobody else is here yet. Use <b>Invite</b> to bring someone in.</div>'
  menu.innerHTML = `
    <div class="pm-head"><span>People</span><span class="pm-count">${st.peers.length + 1} here</span></div>
    <div class="pm-section">
      <div class="pm-title">You</div>
      <div class="pm-card">
        ${row(self)}
        <form class="pm-focus"><input class="input" id="focus-input" placeholder="What are you working on?" aria-label="Your focus" value="${esc(typing ?? st.me.focus ?? '')}"></form>
      </div>
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
}

// ------------------------------------------------------ main area (AI/Files) --
function bindMain () {
  $('#main-tabs').addEventListener('click', (e) => {
    const close = e.target.closest('[data-close]')
    const tab = e.target.closest('[data-tab]')
    const w = ws(current)
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
      <button class="x" data-kind="file" data-close="${esc(path)}" aria-label="Close ${esc(basename(path))}">${I.x}</button></div>`).join('')
  $('#mainbar').hidden = !w.aiTabs.length && !w.fileTabs.length
}

function renderMain () {
  const el = $('#main')
  if (!current || !el) return
  const w = ws(current)
  const st = sum().status
  if (st.access && st.access.state === 'pending') {
    el.innerHTML = `<div class="main-empty">
      <div class="ill">${I.lock}</div>
      <h3>Waiting to be let in</h3>
      <p class="hint">The person who started this session needs to approve you. Files will appear here as soon as they do. You can leave this open.</p>
    </div>`
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
    renderFeed(el, { entries, person: w.aiSel, isMe: !!p.isMe, color: p.color, agent: p.agent, online: p.online })
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
  if (w.mode === 'files' && w.fileSel === path) renderMain()
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

function bindTreeEvents () {
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
    claim: claimCovering(path, kind),
    onOpen: () => openFile(path),
    onClaim: (note) => claimPath(path, note),
    onRelease: () => releasePattern(claimCovering(path, kind).pattern)
  })
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
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit() }
  })
  $('#to-select').onchange = (e) => { state.to = e.target.value; updatePlaceholder() }
  $('#attach-btn').onclick = () => $('#file-input').click()
  $('#file-input').onchange = (e) => { addFiles(e.target.files); e.target.value = '' }
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
      $('#send-btn').disabled = false
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

function updatePlaceholder () {
  const input = $('#msg-input')
  if (!input) return
  const who = state.to ? state.to : 'everyone'
  input.placeholder = state.pending.length ? `Add a note for ${who} (optional)…` : `Message ${who}…`
}

function renderRecipients () {
  const s = sum()
  const sel = $('#to-select')
  if (!s || !sel) return
  const names = new Set(s.status.peers.map((p) => p.name))
  for (const m of renderable(state.messages.get(current))) {
    if (m.by !== s.status.me.name) names.add(m.by)
    if (m.to && m.to !== s.status.me.name) names.add(m.to)
  }
  if (state.to) names.add(state.to)
  const online = new Set(s.status.peers.map((p) => p.name))
  sel.innerHTML = '<option value="">Everyone</option>' + [...names].sort().map((n) =>
    `<option value="${esc(n)}" ${n === state.to ? 'selected' : ''}>${esc(n)} (direct${online.has(n) ? '' : ', offline'})</option>`).join('')
  sel.value = state.to
  sel.closest('.to').hidden = names.size === 0
  updatePlaceholder()
}

function renderMessages (incoming = false, force = false) {
  const el = $('#messages')
  const s = sum()
  if (!el || !s) return
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  const list = renderable(state.messages.get(current)) // peers can push anything into the room
  const name = s.status.me.name
  const colors = new Map(s.status.peers.map((p) => [p.name, p.color]))
  colors.set(name, s.status.me.color)
  el.innerHTML = list.length
    ? list.map((m) => {
      const mine = m.by === name
      const dm = m.to ? `<span class="dm">${mine ? `to ${esc(m.to)}` : 'direct'}</span>` : ''
      const file = m.file ? `<a class="file-card" href="${fileCardHref(current, m.id, TOKEN)}" download="${esc(m.file.name)}">
          <span class="fi">${I.file}</span><span style="min-width:0"><div class="fn">${esc(m.file.name)}</div><div class="fs">${bytes(m.file.size)} · ${mine ? 'sent' : 'download'}</div></span></a>` : ''
      return `<div class="msg${mine ? ' mine' : ''}">${mine ? '' : avatar(m.by, colors.get(m.by))}
        <div style="min-width:0"><div class="head"><b>${mine ? 'You' : esc(m.by)}</b>${dm}<span>${esc(clock(m.ts))}</span></div>
        <div class="bubble">${m.text ? `<div class="text">${esc(m.text)}</div>` : ''}${file}</div></div></div>`
    }).join('')
    : '<div class="day-empty"><div><b>Say hi.</b></div><div class="hint">Messages, direct messages and files you share appear here. Drop a file on this panel to send it.</div></div>'
  if (force || nearBottom || (incoming && list[list.length - 1]?.by === name)) el.scrollTop = el.scrollHeight
}
