// Invites waiting for you, on Home: workspaces to accept or decline, and sessions to join
// (with the link the owner sent) or decline. Loaded when Home opens and every minute after.
import { I, state, $, esc, toast, api, avatar } from './common.js'

const sessionAccess = (i) => (i.access ? ` · ${esc(i.access)}` : '')

function rowHtml (i) {
  const from = i.from?.name || 'Someone'
  if (i.kind === 'workspace') {
    const where = `the <b>${esc(i.workspace.name)}</b> workspace${i.workspace.org ? ` in ${esc(i.workspace.org)}` : ''}`
    return `
      <div class="session-row invite-row">
        ${avatar(from, null)}
        <div class="meta"><div class="name"><span><b>${esc(from)}</b> invited you to ${where}</span></div>
          <div class="sub">${i.access === 'view' ? 'View only' : 'Can edit'}</div></div>
        <div class="facts"></div>
        <div class="acts"><button class="btn sm ghost" data-invite-decline="${esc(i.id)}">Decline</button><button class="btn sm primary" data-invite-accept="${esc(i.id)}">Accept</button></div>
      </div>`
  }
  return `
      <div class="session-row invite-row">
        ${avatar(from, null)}
        <div class="meta"><div class="name"><span><b>${esc(from)}</b> invited you to the session <b>${esc(i.session.name)}</b></span></div>
          <div class="sub">${i.link ? 'Session' : 'Open the link in the email they sent to join'}${sessionAccess(i)}</div></div>
        <div class="facts"></div>
        <div class="acts"><button class="btn sm ghost" data-invite-decline="${esc(i.id)}">Decline</button>${i.link ? `<button class="btn sm primary" data-invite-join="${esc(i.id)}">Join</button>` : ''}</div>
      </div>`
}

export function invitesHtml () {
  const list = state.invites || []
  if (!list.length) return ''
  return `
    <div class="sec-head"><h2>Invites for you</h2><span class="count">${list.length}</span></div>
    <div class="card session-list">${list.map(rowHtml).join('')}</div>`
}

/** Fetches your invites; true when the list changed. Quiet when signed out or offline. */
export async function loadInvites () {
  try {
    const { invites } = await api('GET', '/api/invites')
    const before = JSON.stringify(state.invites || [])
    state.invites = invites
    return JSON.stringify(invites) !== before
  } catch { return false }
}

/** Fills Home's invites slot and answers its buttons. `joinDialog(link)` opens Join; `after()` refreshes what an accept changes. */
export function bindInvites (root, { joinDialog, after }) {
  const slot = root.querySelector('#invites-slot')
  if (!slot) return
  const paint = () => { slot.innerHTML = invitesHtml(); slot.hidden = !(state.invites || []).length }
  paint()
  loadInvites().then((changed) => { if (changed && root.isConnected) paint() })
  slot.onclick = async (e) => {
    const b = e.target.closest('[data-invite-accept],[data-invite-decline],[data-invite-join]')
    if (!b) return
    const id = b.dataset.inviteAccept || b.dataset.inviteDecline || b.dataset.inviteJoin
    const inv = (state.invites || []).find((i) => i.id === id)
    if (!inv) return
    if (b.dataset.inviteJoin) return joinDialog(inv.link)
    b.disabled = true
    try {
      if (b.dataset.inviteAccept) {
        await api('POST', `/api/invites/${encodeURIComponent(id)}/accept`, {})
        toast(`You're in ${inv.workspace.name}`)
      } else {
        await api('POST', `/api/invites/${encodeURIComponent(id)}/decline`, {})
        toast('Invite declined')
      }
      state.invites = state.invites.filter((i) => i.id !== id)
      paint()
      if (b.dataset.inviteAccept) await after()
    } catch (err) {
      b.disabled = false
      toast(err.message)
    }
  }
}
