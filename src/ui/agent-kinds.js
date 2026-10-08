// Invite an agent, with workspaces on: a small menu anchored to the button, with the three
// kinds of agent (global, workspace, session), then where it goes for the last two, then the
// text to paste into the AI. With workspaces off the buttons never open it (see home.js and
// app.js). The markup is plain functions, so tests can draw it.
import { I, esc, api, state, basename, COLORS } from './common.js'
import { agentPaste } from './invite.js'

export const DOCS_URL = 'https://heyquilt.com/docs/agent-kinds'
export const KINDS = [
  ['global', 'Global agent', 'In all your workspaces, invited to their sessions', 'globe'],
  ['workspace', 'Workspace agent', 'In one workspace, invited to its sessions', 'grid'],
  ['session', 'Session agent', 'Invited to one session', 'link']
]
const NAMES = Object.fromEntries(KINDS.map(([k, name]) => [k, name]))

/** The workspaces a workspace agent can be invited to: your own, and org ones you admin. */
export const invitableWorkspaces = (list) => (list || []).filter((w) => w.admin && !w.archivedAt && (w.via === 'owner' || w.space?.kind === 'org'))

/** The sessions running on this computer that a session agent can be invited to. */
export const invitableSessions = (sessions) => [...(sessions || [])].filter((s) => s.invite)

/** The menu's first step: the kinds, and How agent kinds work. */
export function kindMenuHtml () {
  return `${KINDS.map(([kind, name, line, icon]) => `
    <button type="button" class="pop-item km-item" role="menuitem" data-kind="${kind}"><span class="km-ic">${I[icon]}</span><span class="km-t"><b>${name}</b><span>${line}</span></span></button>`).join('')}
    <div class="pop-sep"></div>
    <a class="pop-item km-docs" role="menuitem" href="${DOCS_URL}" target="_blank" rel="noopener">How agent kinds work${I.external}</a>
    <p class="error km-error" role="alert"></p>`
}

/**
 * The second step for a workspace or session agent: where it goes. `items` are
 * [{ id, name, color, current }]; the current one (where the menu was opened) comes first.
 */
export function pickHtml (kind, items) {
  const what = kind === 'workspace' ? 'workspace' : 'session'
  const list = [...items].sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0))
  const empty = kind === 'workspace' ? 'No workspace you can invite an agent to yet.' : 'No session is running. Open one, then invite from there.'
  return `
    <div class="km-head"><button type="button" class="btn sm ghost icon" data-km-back aria-label="Back to the kinds of agent">${I.arrowLeft}</button><b>${NAMES[kind]}</b></div>
    <div class="pop-label">Which ${what}</div>
    <div class="km-list">${list.length
      ? list.map((x) => `<button type="button" class="pop-item km-pick" role="menuitem" data-pick="${esc(x.id)}"><i class="km-dot" style="background:${esc(x.color)}"></i><span class="grow">${esc(x.name)}</span>${x.current ? `<span class="hint">This ${what}</span>` : ''}</button>`).join('')
      : `<p class="hint km-empty">${empty}</p>`}</div>
    <p class="error km-error" role="alert"></p>`
}

/** The line above the paste text: which kind of agent it makes, and where. */
export function kindLineHtml (kind, where = '') {
  const icon = I[KINDS.find(([k]) => k === kind)?.[3] || 'bot']
  const tail = kind === 'global' ? 'In all your workspaces, invited to their sessions.' : kind === 'workspace' ? `In ${esc(where)}, invited to its sessions.` : `Invited to ${esc(where)}.`
  return `<p class="hint km-kind"><span class="pill km-pill">${icon}${NAMES[kind]}</span>${tail}</p>`
}

/** The workspaces and sessions to pick from, the current ones marked. */
function choices (kind, { workspaceId, sessionId }) {
  if (kind === 'workspace') return invitableWorkspaces(state.workspaces).map((w) => ({ id: w.id, name: w.name, color: COLORS[w.color] || COLORS.lilac, current: w.id === workspaceId }))
  return invitableSessions(state.sessions?.values?.()).map((s) => ({ id: s.id, name: s.status?.sessionName || basename(s.dir), color: s.status?.connected ? 'var(--ok)' : 'var(--warn)', current: s.id === sessionId }))
}

/** Makes the invite for `kind` (at `id` for a workspace or session): { text, where }. */
export async function makeAgentInvite (kind, id, workspaceBody) {
  if (kind === 'global') return { text: agentPaste({ link: (await api('POST', '/api/agent-invites', { global: true })).link, invitedToSessions: true }), where: '' }
  if (kind === 'workspace') {
    const w = (state.workspaces || []).find((x) => x.id === id)
    const { link } = await api('POST', `/api/workspaces/${encodeURIComponent(id)}/agent-invites`, workspaceBody ? workspaceBody() : { access: 'edit', sessions: 'all' })
    return { text: agentPaste({ link, invitedToSessions: true }), where: w?.name || 'this workspace' }
  }
  const s = state.sessions.get(id)
  if (!s) throw new Error('That session is not running any more.')
  const { link } = await api('POST', '/api/agent-invites')
  return { text: agentPaste({ link, session: s.invite }), where: s.status?.sessionName || basename(s.dir) }
}

let open = null

/** Closes the menu (and gives the button its focus back when `refocus`). */
export function closeKindMenu (refocus = false) {
  if (!open) return
  const { menu, btn, off } = open
  open = null
  off.abort()
  menu.remove()
  btn.setAttribute('aria-expanded', 'false')
  if (refocus) btn.focus()
}

/**
 * Puts the menu under the button (or above it when there's no room), inside the window, and
 * answers the side it took. Later steps pass that side back, so the menu never jumps across
 * the button when a step is shorter or taller.
 */
function place (menu, btn, side = null) {
  const r = btn.getBoundingClientRect()
  const w = menu.offsetWidth
  // Its left edge under the button's; or, when that runs off the window, its right edge under the button's.
  const left = r.left + w > window.innerWidth - 8 ? r.right - w : r.left
  menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - w - 8))}px`
  const below = window.innerHeight - r.bottom
  const at = side || (below < menu.offsetHeight + 12 && r.top > below ? 'above' : 'below')
  menu.style.top = at === 'below' ? `${r.bottom + 4}px` : ''
  menu.style.bottom = at === 'above' ? `${window.innerHeight - r.top + 4}px` : ''
  // A taller step scrolls inside the room on its side rather than running off the window.
  menu.style.maxHeight = `${Math.max(160, Math.min(420, (at === 'below' ? below : r.top) - 12))}px`
  return at
}

/**
 * Opens the menu at `btn`. opts: workspaceId / sessionId (where it was opened, picked first),
 * workspaceBody() (a workspace agent's { access, sessions }; Edit, every session otherwise),
 * onInvite({ kind, text, where }) once the invite is made.
 */
export function openKindMenu (btn, { workspaceId = '', sessionId = '', workspaceBody = null, onInvite = () => {} } = {}) {
  if (open?.btn === btn) { closeKindMenu(true); return }
  closeKindMenu()
  const menu = document.createElement('div')
  menu.className = 'popover kind-menu'
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', 'Invite an agent')
  const off = new AbortController()
  open = { menu, btn, off }
  btn.setAttribute('aria-expanded', 'true')
  const items = () => [...menu.querySelectorAll('[role=menuitem]:not(:disabled)')]
  let side = null
  const show = (html) => {
    menu.innerHTML = html
    side = place(menu, btn, side)
    items()[0]?.focus()
  }
  const busy = (on) => { for (const b of menu.querySelectorAll('button')) b.disabled = on; menu.setAttribute('aria-busy', String(on)) }
  const make = async (kind, id) => {
    busy(true)
    try {
      const made = await makeAgentInvite(kind, id, workspaceBody)
      closeKindMenu()
      onInvite({ kind, ...made })
    } catch (err) {
      busy(false)
      const e = menu.querySelector('.km-error')
      if (e) e.textContent = err.message
    }
  }
  let kind = null
  menu.addEventListener('click', (e) => {
    if (e.target.closest('.km-docs')) { closeKindMenu(); return }
    if (e.target.closest('[data-km-back]')) { kind = null; show(kindMenuHtml()); return }
    const k = e.target.closest('[data-kind]')
    if (k) {
      kind = k.dataset.kind
      if (kind === 'global') make('global')
      else show(pickHtml(kind, choices(kind, { workspaceId, sessionId })))
      return
    }
    const p = e.target.closest('[data-pick]')
    if (p && kind) make(kind, p.dataset.pick)
  })
  menu.addEventListener('keydown', (e) => {
    const list = items()
    const i = list.indexOf(document.activeElement)
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeKindMenu(true); return }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus()
    }
    if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); list[e.key === 'Home' ? 0 : list.length - 1]?.focus() }
    if (e.key === 'Tab') closeKindMenu()
  })
  document.body.append(menu)
  show(kindMenuHtml())
  const outside = (e) => { if (!menu.contains(e.target) && !btn.contains(e.target)) closeKindMenu() }
  document.addEventListener('mousedown', outside, { signal: off.signal })
  btn.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeKindMenu(true) } }, { signal: off.signal })
  window.addEventListener('resize', () => closeKindMenu(), { signal: off.signal })
  document.addEventListener('scroll', (e) => { if (!menu.contains(e.target)) closeKindMenu() }, { capture: true, signal: off.signal })
}
