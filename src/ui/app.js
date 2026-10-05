// Quilt app: boot, live events, home screen, folder picker and invites.
// The session workspace lives in session.js. Plain ES modules, no build step.
import { TOKEN, I, state, $, esc, basename, toast, api, ask, decodeInvite, remember, recall, startDropdowns, avatar, loadAccessTypes, typeOptions } from './common.js'
import { renderShell, joinSessionDialog } from './home.js'
import { mountSession, sessionUpdated, sessionMessage, sessionFeed, sessionFileChanged, sessionLog, sessionUnmount } from './session.js'
import { quiltMark } from './mark.js'
import { renderSignIn } from './signin.js'
import { checkRelease, openReleaseNotes } from './releases.js'
import { agentPaste } from './invite.js'

// ---------------------------------------------------------------- boot --
const SIGNED_OUT = 'This computer was signed out. Sign in again.'

// Once per page, not per boot: signing in again calls boot() and mustn't add listeners twice.
startDropdowns()

async function boot () {
  if (!TOKEN) return renderLocked()
  // Shown only if loading takes a moment: the Q pieces itself together while we wait.
  const waiting = setTimeout(() => { if (!state.loaded) $('#app').innerHTML = `<div class="booting">${quiltMark({ word: false, loop: true })}</div>` }, 250)
  try {
    const acc = await api('GET', '/api/account')
    if (!acc.signedIn) {
      clearTimeout(waiting)
      return renderSignIn(acc.reason === 'revoked' ? SIGNED_OUT : '', boot)
    }
    state.account = acc.account
    const s = await api('GET', '/api/state')
    state.recent = s.recent
    state.defaults = s.defaults
    state.profile = s.profile
    state.maxFileBytes = s.maxFileBytes
    for (const sum of s.sessions) state.sessions.set(sum.id, sum)
    state.loaded = true
    clearTimeout(waiting)
    const last = recall('view')
    state.view = state.sessions.has(last) || last === 'settings' ? last : (state.sessions.size ? [...state.sessions.keys()][0] : 'home')
    if (isSession(state.view)) await loadMessages(state.view)
    if (!state.events) connectEvents()
    render()
    // Invite links that opened the desktop app wait until you're signed in.
    if (!boot.invites) { boot.invites = true; window.quiltDesktop?.onInvite(openInviteLink); window.quiltDesktop?.onReleaseNotes?.(openReleaseNotes) }
    // Is a newer Quilt out, and has this version's "what's new" been shown? Never blocks the app.
    checkRelease()
  } catch (err) {
    clearTimeout(waiting)
    if (!err.signedOut) renderLocked(err.message)
  }
}

/** Back to the sign-in screen: after Sign out, or when the API turned this computer away. */
export function signedOutNow (message = '') {
  sessionUnmount() // stops an open session view's timers and bindings
  state.events?.close()
  state.events = null
  state.loaded = false
  state.account = null
  for (const m of [state.sessions, state.messages, state.feeds, state.trees, state.files]) m.clear()
  document.querySelectorAll('.modal-back').forEach((m) => m.remove())
  renderSignIn(message, boot)
}

window.addEventListener('quilt-signed-out', () => signedOutNow(SIGNED_OUT))

function connectEvents () {
  const es = state.events = new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}`)
  // The browser reopens a dropped stream by itself, but whatever was pushed meanwhile is
  // gone (a partner back after a blip, say), and nothing pushes again until something
  // changes. So after a reopen, fetch the state over again.
  let opened = false
  es.addEventListener('open', () => {
    if (!opened) { opened = true; return }
    resync()
  })
  es.addEventListener('session', (e) => {
    const sum = JSON.parse(e.data)
    const prev = state.sessions.get(sum.id)
    // Session summaries don't carry the full log; keep what we have.
    state.sessions.set(sum.id, prev ? { ...sum, logs: prev.logs } : sum)
    if (state.view === sum.id) sessionUpdated(sum.id)
    else renderTabs()
  })
  es.addEventListener('feed', (e) => {
    const { id, entries } = JSON.parse(e.data)
    sessionFeed(id, entries)
  })
  es.addEventListener('file-changed', (e) => {
    const { id, ...change } = JSON.parse(e.data)
    sessionFileChanged(id, change)
  })
  es.addEventListener('message', (e) => {
    const { id, message } = JSON.parse(e.data)
    const list = state.messages.get(id)
    if (list && !list.some((m) => m.id === message.id)) list.push(message)
    if (state.view === id) {
      sessionMessage(id, message)
      if (document.visibilityState === 'visible') markRead(id)
    } else renderTabs()
    if (message.by !== state.sessions.get(id)?.status.me.name && document.visibilityState !== 'visible') {
      document.title = `• ${message.by}: ${message.text || message.file?.name || ''}`.slice(0, 60)
    }
  })
  es.addEventListener('log', (e) => {
    const { id, ts, line } = JSON.parse(e.data)
    const s = state.sessions.get(id)
    if (s) { s.logs.push({ ts, line }); if (s.logs.length > 200) s.logs.shift() }
    if (state.view === id) sessionLog(id)
  })
  es.addEventListener('stopped', (e) => {
    const { id } = JSON.parse(e.data)
    state.sessions.delete(id)
    state.messages.delete(id)
    state.feeds.delete(id)
    state.trees.delete(id)
    if (state.view === id) state.view = 'home'
    render()
    // The folder moves from "open" to "recent", but the recent list is the
    // server's: draw Home again once the fresh one arrives, or the session you
    // just left is missing from it until the next visit.
    refreshRecent().then(() => { if (state.view === 'home') render() })
  })
  es.addEventListener('signed-out', (e) => {
    const { reason } = JSON.parse(e.data)
    signedOutNow(reason === 'revoked' ? SIGNED_OUT : '')
  })
}

const isSession = (view) => view !== 'home' && view !== 'settings'

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    document.title = 'quilt'
    if (isSession(state.view)) markRead(state.view)
  }
})

export async function loadMessages (id) {
  const { messages } = await api('GET', `/api/sessions/${id}/messages`)
  state.messages.set(id, messages)
}

export async function markRead (id) {
  const list = state.messages.get(id) || []
  if (!list.some((m) => m.unread)) return
  for (const m of list) m.unread = false
  await api('POST', `/api/sessions/${id}/read`).catch(() => {})
}

async function refreshRecent () {
  try {
    const s = await api('GET', '/api/state')
    state.recent = s.recent
    state.profile = s.profile
  } catch {}
}

/** Brings every session's summary (and the recent list) up to date with the server. */
async function resync () {
  let s
  try { s = await api('GET', '/api/state') } catch { return }
  state.recent = s.recent
  state.profile = s.profile
  const live = new Set()
  for (const sum of s.sessions) {
    live.add(sum.id)
    const prev = state.sessions.get(sum.id)
    state.sessions.set(sum.id, prev ? { ...sum, logs: prev.logs } : sum)
  }
  for (const id of [...state.sessions.keys()]) if (!live.has(id)) state.sessions.delete(id)
  if (isSession(state.view)) {
    if (state.sessions.has(state.view)) sessionUpdated(state.view)
    else { state.view = 'home'; render() }
  } else if (state.view === 'home') render()
  else renderTabs()
}

export async function go (view) {
  state.view = view
  state.pending = []
  state.to = ''
  remember('view', view)
  if (view === 'home') await refreshRecent()
  if (isSession(view) && !state.messages.has(view)) await loadMessages(view)
  render()
  if (isSession(view)) markRead(view)
}

// --------------------------------------------------------------- render --
export async function shutdown () {
  if (!await ask({ title: 'Shut down Quilt?', message: 'This stops every session and this app. Your files stay where they are.', ok: 'Shut down', danger: true })) return
  try {
    await api('POST', '/api/shutdown')
    state.events?.close() // don't re-render or reconnect as sessions stop
    renderLocked('quilt is shut down. You can close this tab.')
  } catch (err) {
    toast(err.message)
  }
}

document.addEventListener('click', (e) => { if (e.target.closest('[data-shutdown]')) shutdown() })

export function render () {
  sessionUnmount()
  if (!isSession(state.view)) {
    renderShell(state.view)
  } else {
    mountSession(state.view)
    bindTopbar()
  }
}

export function renderLocked (msg) {
  $('#app').innerHTML = `
    <div class="home"><div class="hero">
      <div class="wordmark">${quiltMark({ sew: 'first' })}</div>
      <p class="tagline">${esc(msg || 'Open Quilt using the link printed in your terminal by')} ${msg ? '' : '<code>quilt ui</code>.'}</p>
    </div></div>`
}

export function renderTabs () {
  const el = $('#tabs')
  if (!el) return
  // One session is the normal case; tabs only help when there are several.
  el.hidden = state.sessions.size < 2 && state.view !== 'home'
  el.innerHTML = [...state.sessions.values()].map((s) => {
    const unread = s.status.unread
    return `<button class="tab${state.view === s.id ? ' on' : ''}" data-go="${s.id}">
      <span class="dot" style="background:${s.status.connected ? 'var(--ok)' : 'var(--warn)'}"></span>
      ${esc(s.status.sessionName || basename(s.dir))}
      ${unread && state.view !== s.id ? `<span class="badge">${unread}</span>` : ''}
    </button>`
  }).join('')
}

export function bindTopbar () {
  renderTabs()
  document.querySelectorAll('[data-go]').forEach((b) => { if (!b.closest('#tabs')) b.onclick = () => go(b.dataset.go) })
  $('#tabs')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-go]')
    if (b) go(b.dataset.go)
  })
}

// In the desktop app, clicking an invite link opens the join dialog with it filled in.
async function openInviteLink (link) {
  document.querySelectorAll('.modal-back').forEach((m) => m.remove())
  if (state.view !== 'home') await go('home')
  joinSessionDialog(link)
}

// -------------------------------------------------------- folder picker --
export async function pickFolder (input) {
  if (window.quiltDesktop) {
    const dir = await window.quiltDesktop.pickFolder(input.value)
    if (dir) { input.value = dir; input.dispatchEvent(new Event('input', { bubbles: true })) }
    return
  }
  const back = document.createElement('div')
  back.className = 'modal-back'
  back.innerHTML = `<div class="card modal" role="dialog" aria-modal="true" aria-labelledby="pick-title">
    <h3 id="pick-title">Choose a folder</h3>
    <p class="lead">Pick the project folder, or type a path. New folders are created for you.</p>
    <div class="row"><button class="btn icon" id="pick-up" title="Up" aria-label="Up">${I.up}</button><input class="input grow mono" id="pick-path"><button class="btn" id="pick-go">Go</button></div>
    <div class="dirlist" id="pick-list"></div>
    <div class="hint" id="pick-note"></div>
    <div class="actions"><button class="btn ghost" id="pick-cancel">Cancel</button><button class="btn primary" id="pick-use">Use this folder</button></div>
  </div>`
  document.body.appendChild(back)
  let done
  const closed = new Promise((resolve) => { done = resolve })
  const close = () => { back.remove(); done() }
  let current = null
  const load = async (p) => {
    try {
      const d = await api('GET', `/api/fs?path=${encodeURIComponent(p)}`)
      current = d
      $('#pick-path', back).value = d.path
      $('#pick-up', back).disabled = !d.parent
      $('#pick-list', back).innerHTML = d.dirs.length
        ? d.dirs.map((n) => `<button data-dir="${esc(n)}">${I.folder}<span>${esc(n)}</span></button>`).join('')
        : '<div class="empty-note" style="padding:14px">No subfolders</div>'
      $('#pick-note', back).textContent = d.hasSession ? 'This folder has been used with Quilt before.' : d.isEmpty ? 'This folder is empty.' : ''
      $('#pick-list', back).querySelectorAll('[data-dir]').forEach((b) => {
        b.onclick = () => load(`${d.path.replace(/[\\/]$/, '')}/${b.dataset.dir}`)
      })
    } catch (err) {
      $('#pick-note', back).textContent = err.message
    }
  }
  $('#pick-up', back).onclick = () => current?.parent && load(current.parent)
  $('#pick-go', back).onclick = () => load($('#pick-path', back).value)
  $('#pick-path', back).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); load(e.target.value) } }
  $('#pick-cancel', back).onclick = close
  $('#pick-use', back).onclick = () => { input.value = $('#pick-path', back).value; close() }
  back.onclick = (e) => { if (e.target === back) close() }
  back.onkeydown = (e) => { if (e.key === 'Escape') close() }
  await load(input.value || state.defaults.home)
  $('#pick-path', back).focus()
  return closed
}


// --------------------------------------------------------------- invite --
export function openInvite (id) {
  const s = state.sessions.get(id)
  if (!s) return
  const d = decodeInvite(s.invite)
  // The owner of a session with approvals can invite people as an access type.
  const owner = !!(s.viewInvite && s.status.access?.owner)
  const back = document.createElement('div')
  back.className = 'modal-back'
  back.innerHTML = `<div class="card modal" role="dialog" aria-modal="true" aria-labelledby="inv-title">
    <h3 id="inv-title">Invite someone</h3>
    <p class="lead">Send them a link. Clicking it opens the session in Quilt (after signing in). It also works with <code>quilt join &lt;link&gt;</code>.</p>
    <div class="label" style="margin-bottom:6px">${s.viewInvite ? 'Can edit' : 'Invite link'}</div>
    <div class="codebox"><code id="inv-code">${esc(s.invite)}</code><button class="btn icon" data-copy="inv-code" title="Copy" aria-label="Copy invite link">${I.copy}</button></div>
    ${s.viewInvite ? `<div class="label" style="margin-bottom:6px">View only</div>
    <div class="codebox"><code id="inv-view">${esc(s.viewInvite)}</code><button class="btn icon" data-copy="inv-view" title="Copy" aria-label="Copy view-only link">${I.copy}</button></div>` : ''}
    ${d ? `<p class="hint">Room <code>${esc(d.room)}</code> via <code>${esc(d.server)}</code></p>` : ''}
    <p class="hint">${s.viewInvite ? 'Everyone who uses a link waits until you let them in, and you can change what they may do later from the people menu.' : 'Anyone with this link can edit the project. Only share it with people you trust.'}</p>
    ${owner ? `<div class="inv-section" id="inv-access">
      <div class="label inv-agent-label">Invite as</div>
      <select class="input" id="inv-type" aria-label="Invite as"></select>
      <p class="hint">People you invite here get straight in with this access once they sign in. No waiting for you.</p>
      <div class="label inv-sub">People you've worked with</div>
      <div class="inv-list" id="inv-people"><p class="hint">Loading…</p></div>
      <div class="label inv-sub">Invite by email</div>
      <form class="row" id="inv-email-form">
        <input class="input grow" type="email" id="inv-email" placeholder="name@example.com" aria-label="Email address" required>
        <button class="btn primary" type="submit">Send invite</button>
      </form>
      <div class="label inv-sub">Pending invites</div>
      <div class="inv-list" id="inv-pending"></div>
      <p class="error" id="inv-error"></p>
    </div>` : ''}
    <div class="label inv-agent-label">Your AI</div>
    <div id="inv-agent" class="inv-agent">
      <p class="hint">An AI that already has the Quilt command just needs the link above: tell it "Join my Quilt session: &lt;link&gt;". To add an AI that isn't registered with Quilt yet, make it an agent invite and paste the text into it. It joins as your own agent, listed in Settings.</p>
      <button class="btn" type="button" id="inv-agent-make">${I.bot}<span>Invite an AI agent</span></button>
      <p class="error" id="inv-agent-error"></p>
    </div>
    ${s.status.access?.owner ? `<div class="label inv-agent-label">A chat AI</div>
    <div id="inv-chat" class="inv-agent">
      <p class="hint">For ChatGPT, claude.ai, Grok and other AIs you use in a chat window: make a chat link and paste it into the chat. It can read and send messages, read and add tasks, read files, and add pictures, documents and notes. It can't change existing files. It shows up in the session as its own member; remove it there to end the link.</p>
      <button class="btn" type="button" id="inv-chat-make">${I.link}<span>Make a chat link</span></button>
      <p class="error" id="inv-chat-error"></p>
    </div>` : ''}
    <div class="actions"><button class="btn primary" id="inv-done">Done</button></div>
  </div>`
  document.body.appendChild(back)
  const close = () => back.remove()
  back.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]')
    if (!b) return
    const el = $(`#${b.dataset.copy}`, back)
    try { await navigator.clipboard.writeText(el.textContent); toast('Copied') } catch {
      const r = document.createRange(); r.selectNodeContents(el)
      getSelection().removeAllRanges(); getSelection().addRange(r); toast('Press ⌘/Ctrl+C to copy')
    }
  })
  $('#inv-agent-make', back).onclick = async () => {
    const btn = $('#inv-agent-make', back)
    btn.disabled = true
    try {
      const inv = await api('POST', '/api/agent-invites')
      $('#inv-agent', back).innerHTML = agentInviteHtml(agentPaste({ link: inv.link, invite: s.invite }), 'inv-agent-text')
    } catch (err) {
      btn.disabled = false
      $('#inv-agent-error', back).textContent = err.message
    }
  }
  const chatMake = $('#inv-chat-make', back)
  if (chatMake) {
    chatMake.onclick = async () => {
      chatMake.disabled = true
      try {
        const r = await api('POST', `/api/sessions/${id}/chat-link`, {})
        const until = new Date(r.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        $('#inv-chat', back).innerHTML = `<p class="hint">Paste this into the chat. It works until ${esc(until)} and shows in the session as <b>${esc(r.name)}</b>. Anyone with it can act as ${esc(r.name)}, so only paste it there.</p>
          <div class="codebox"><code id="inv-chat-text">${esc(`Open this link and follow it to join our Quilt session: ${r.url}`)}</code><button class="btn icon" data-copy="inv-chat-text" title="Copy" aria-label="Copy chat link">${I.copy}</button></div>`
      } catch (err) {
        chatMake.disabled = false
        $('#inv-chat-error', back).textContent = err.message
      }
    }
  }
  $('#inv-done', back).onclick = close
  back.onclick = (e) => { if (e.target === back) close() }
  if (owner) bindInviteAs(id, back)
}

/** The owner's invite panel: "Invite as" a type, people you've worked with, by email, and pending invites. */
function bindInviteAs (id, back) {
  const error = (msg) => { $('#inv-error', back).textContent = msg || '' }
  const typeId = () => $('#inv-type', back).value
  const invite = async (to, done) => {
    error('')
    try {
      await api('POST', `/api/sessions/${id}/invites`, { typeId: typeId(), to })
      toast(done)
      await pending()
    } catch (err) { error(err.message) }
  }
  async function pending () {
    const el = $('#inv-pending', back)
    try {
      const open = (await api('GET', `/api/sessions/${id}/invites`)).invites.filter((i) => i.status === 'waiting')
      el.innerHTML = open.length
        ? open.map((i) => `<div class="inv-row"><span class="grow">${esc(i.email || i.name)}<span class="hint"> · ${esc(i.typeName)}</span></span><button class="btn sm ghost" type="button" data-cancel-invite="${esc(i.id)}">Cancel</button></div>`).join('')
        : '<p class="hint">No pending invites.</p>'
    } catch (err) { el.innerHTML = `<p class="hint">${esc(err.message)}</p>` }
  }
  async function people () {
    const el = $('#inv-people', back)
    try {
      const list = (await api('GET', '/api/collaborators')).collaborators
      el.innerHTML = list.length
        ? list.map((c) => `<div class="inv-row">${avatar(c.name, null)}<span class="grow">${esc(c.name)}${c.kind === 'agent' ? `<span class="tag bot">${I.bot}agent</span>` : ''}</span><button class="btn sm" type="button" data-invite-account="${esc(c.account)}" data-name="${esc(c.name)}">Invite</button></div>`).join('')
        : "<p class=\"hint\">Nobody yet. People and agents you've been in a session with show up here.</p>"
    } catch (err) { el.innerHTML = `<p class="hint">${esc(err.message)}</p>` }
  }
  ;(state.accessTypes ? Promise.resolve(state.accessTypes) : loadAccessTypes()).then((types) => {
    const sel = $('#inv-type', back)
    if (types) sel.innerHTML = typeOptions()
    else { sel.innerHTML = '<option value="builtin:edit">Can edit</option><option value="builtin:view">View only</option>' }
  })
  people()
  pending()
  back.addEventListener('click', async (e) => {
    const inv = e.target.closest('[data-invite-account]')
    if (inv) { inv.disabled = true; await invite({ account: inv.dataset.inviteAccount }, `Invited ${inv.dataset.name}`); inv.disabled = false; return }
    const cancel = e.target.closest('[data-cancel-invite]')
    if (cancel) {
      try { await api('POST', `/api/sessions/${id}/invites/cancel`, { inviteId: cancel.dataset.cancelInvite }); toast('Invite cancelled'); await pending() } catch (err) { error(err.message) }
    }
  })
  $('#inv-email-form', back).onsubmit = async (e) => {
    e.preventDefault()
    const input = $('#inv-email', back)
    await invite({ email: input.value.trim() }, 'Invite sent')
    if (!$('#inv-error', back).textContent) input.value = ''
  }
}

/** A fresh agent invite, as the text to paste into an AI, with Copy. */
export function agentInviteHtml (text, id) {
  return `<p class="hint"><b>Paste this into your AI.</b> It works once, within an hour. Anyone with it can join as your agent, so only give it to your own AI.</p>
    <div class="codebox"><code id="${id}" class="paste">${esc(text)}</code><button class="btn icon" data-copy="${id}" title="Copy" aria-label="Copy agent invite">${I.copy}</button></div>`
}

boot()
