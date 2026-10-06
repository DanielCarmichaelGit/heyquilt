// Where agents work, in the app: an agent's row in Settings › Agents (with Available in and
// Joins once workspaces are on) and an agent's card on a workspace's page. The markup is plain
// functions, so tests can draw it; home.js and workspaces.js put it on the page.
import { I, esc, ago, avatar, colorFor, api, toast } from './common.js'

export const REACH_OPTIONS = [['manual', 'Only where I add it'], ['all', 'All my workspaces'], ['workspaces', 'Chosen workspaces']]
export const JOINS_OPTIONS = [['invited', 'When invited'], ['all', 'Every session']]
const options = (list, value) => list.map(([v, label]) => `<option value="${v}"${v === value ? ' selected' : ''}>${label}</option>`).join('')

/** Your own personal workspaces: the only ones one of your agents can be placed in. */
export const placeableWorkspaces = (list) => (list || []).filter((w) => w.space?.kind === 'personal' && w.via === 'owner')

/** One of your agents in Settings › Agents. With a placement (workspaces on), its Available in and Joins too. */
export function agentRow (a, place = null, workspaces = []) {
  const signedOut = a.status === 'reused' || a.status === 'expired'
  const state = signedOut ? '<span class="pill warn">signed out</span>' : a.canJoinSessions ? '' : '<span class="pill">registered only</span>'
  const when = a.lastUsedAt ? `last used ${ago(a.lastUsedAt)}` : `added ${ago(a.createdAt)}`
  return `<div class="kv agent-row"><span>${I.bot}</span><b>${esc(a.name)} ${state}</b><span class="hint">${esc(a.provider)} · ${esc(a.type)} · ${when}</span>${place ? placementHtml(a, place, workspaces) : ''}</div>`
}

/** What the workspace picker's button says: the chosen workspaces' names. */
export function pickedLabel (ids, workspaces) {
  const names = workspaces.filter((w) => ids.includes(w.id)).map((w) => w.name)
  return names.length ? names.join(', ') : workspaces.length ? 'Pick workspaces' : 'No workspaces yet'
}

/**
 * Available in, the chosen workspaces (a drop-down of checkboxes) and Joins, on two lines. The
 * picker keeps its place beside Available in while hidden and opens over the page, so choosing
 * never moves the rows.
 */
export function placementHtml (a, place, workspaces) {
  const ids = place.workspaceIds || []
  return `
    <div class="agent-place" data-agent-place="${esc(a.id)}">
      <span class="ap-l">Available in</span><select class="input sm" data-placement-reach aria-label="Where ${esc(a.name)} is available">${options(REACH_OPTIONS, place.reach)}</select>
      <details class="ap-pick"${place.reach === 'workspaces' ? '' : ' data-off'}>
        <summary class="input sm" data-placement-picked title="Which workspaces">${esc(pickedLabel(ids, workspaces))}</summary>
        <div class="ap-menu">${workspaces.length
          ? workspaces.map((w) => `<label><input type="checkbox" data-placement-ws value="${esc(w.id)}"${ids.includes(w.id) ? ' checked' : ''}><span>${esc(w.name)}</span></label>`).join('')
          : '<p class="hint">Make a workspace first.</p>'}</div>
      </details>
      <span class="ap-l">Joins</span><select class="input sm" data-placement-sessions aria-label="When ${esc(a.name)} joins sessions"${place.reach === 'manual' ? ' disabled' : ''}>${options(JOINS_OPTIONS, place.sessions)}</select>
    </div>`
}

/** The placement to save from what the row shows; access and folder limits stay as they were. */
export function placementBody (saved, { reach, sessions, workspaceIds }, workspaces) {
  const mine = new Set(workspaces.map((w) => w.id))
  return { reach, sessions, access: saved.access || 'edit', scopes: saved.scopes || [], workspaceIds: reach === 'workspaces' ? workspaceIds.filter((id) => mine.has(id)) : [] }
}

/** Saves each row's Available in, chosen workspaces and Joins as they change. */
export function bindPlacements (root, agents, places, workspaces) {
  root.querySelectorAll('[data-agent-place]').forEach((el) => {
    const i = agents.findIndex((a) => a.id === el.dataset.agentPlace)
    if (i >= 0 && places[i]) bindPlacement(el, agents[i], places[i], workspaces)
  })
  if (!bindPlacements.listening) {
    // A click anywhere else, or Escape, closes an open workspace picker.
    bindPlacements.listening = true
    document.addEventListener('mousedown', (e) => document.querySelectorAll('.ap-pick[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false }))
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.ap-pick[open]').forEach((d) => { d.open = false }) })
  }
}

function bindPlacement (el, a, place, workspaces) {
  let saved = place
  let chosen = [...(place.workspaceIds || [])]
  const reach = el.querySelector('[data-placement-reach]')
  const sessions = el.querySelector('[data-placement-sessions]')
  const pick = el.querySelector('.ap-pick')
  const boxes = () => [...el.querySelectorAll('[data-placement-ws]')]
  const paint = () => {
    pick.toggleAttribute('data-off', reach.value !== 'workspaces')
    if (reach.value !== 'workspaces') pick.open = false
    sessions.disabled = reach.value === 'manual'
    el.querySelector('[data-placement-picked]').textContent = pickedLabel(chosen, workspaces)
  }
  const save = async () => {
    try {
      saved = (await api('POST', `/api/agents/${encodeURIComponent(a.id)}/placement`, placementBody(saved, { reach: reach.value, sessions: sessions.value, workspaceIds: chosen }, workspaces))).placement
      toast('Saved')
    } catch (err) {
      toast(err.message)
      reach.value = saved.reach
      sessions.value = saved.sessions
      if (saved.reach === 'workspaces') chosen = [...saved.workspaceIds]
      boxes().forEach((b) => { b.checked = chosen.includes(b.value) })
    }
    paint()
  }
  reach.onchange = () => {
    paint()
    if (reach.value === 'workspaces' && !chosen.length) pick.open = true
    save()
  }
  sessions.onchange = save
  boxes().forEach((b) => { b.onchange = () => { chosen = boxes().filter((x) => x.checked).map((x) => x.value); paint(); save() } })
}

/** The pill on a workspace's agent card: why it is there. */
export function viaLabel (a, orgName = '') {
  if (a.via === 'member') return 'This workspace'
  if (a.managedBy === 'org') return `Added by ${orgName || 'the org'}`
  return a.via === 'global' ? 'Global' : 'Placed'
}

/**
 * An agent on a workspace's page: why it is there, whether it joins every session, and its
 * access. Admins change Joins here (the member's own setting, or the workspace's say over a
 * placed agent), remove an added agent, and keep a placed one out of this workspace.
 */
export function workspaceAgentCardHtml (a, { admin = false, orgName = '' } = {}) {
  const name = a.name || 'Agent'
  const member = a.via === 'member'
  const pill = `<span class="pill ws-via${a.via === 'global' ? ' violet' : ''}">${esc(viaLabel(a, orgName))}</span>`
  const joins = a.excluded
    ? '<span>Not in this workspace</span>'
    : admin
      ? `<span>Joins</span><select class="input xs" data-agent-joins="${esc(a.agentId)}" aria-label="When ${esc(name)} joins sessions here">${options([['all', 'Every session'], ['invited', 'When invited']], a.sessions)}</select>`
      : `<span>Joins ${a.sessions === 'all' ? 'every session' : 'when invited'}</span>`
  const accessPill = `<span class="pill">${a.access === 'edit' ? 'Can edit' : 'View only'}</span>`
  // Access on the first line; why it is here and Joins on the second; Remove (or Not in this
  // workspace) in the corner, so the card never wraps around its buttons.
  let side = accessPill
  let corner = ''
  if (admin && member) {
    side = `<select class="input sm" data-member-access="${esc(a.account)}" aria-label="Access for ${esc(name)}"><option value="edit" ${a.access === 'edit' ? 'selected' : ''}>Can edit</option><option value="view" ${a.access === 'view' ? 'selected' : ''}>View only</option></select>`
    corner = `<button class="btn sm ghost icon pc-x" data-member-remove="${esc(a.account)}" title="Remove" aria-label="Remove ${esc(name)}">${I.x}</button>`
  } else if (admin && a.excluded) {
    side = `<button class="btn sm" data-agent-include="${esc(a.agentId)}" title="Back in, with its own settings">Let back in</button>`
  } else if (admin) {
    corner = `<button class="btn sm ghost icon pc-x" data-agent-exclude="${esc(a.agentId)}" title="Not in this workspace" aria-label="Keep ${esc(name)} out of this workspace">${I.x}</button>`
  }
  return `
  <div class="pc agent${a.excluded ? ' out' : ''}${corner ? ' has-x' : ''}">${avatar(name, colorFor(name), false)}
    <div class="t"><b>${esc(name)}</b><span>${esc(a.provider ? `${a.provider} · agent` : 'agent')}</span></div>
    ${side}${corner}
    <div class="ws-scope">${pill}${joins}</div>
  </div>`
}
