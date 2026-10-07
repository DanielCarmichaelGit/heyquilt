// Where agents work, in the app: an agent's row in Settings › Agents (with Available in and
// Joins once workspaces are on) and an agent's card on a workspace's page. The markup is plain
// functions, so tests can draw it; home.js and workspaces.js put it on the page.
import { I, esc, ago, avatar, colorFor, api, toast, COLORS } from './common.js'

export const REACH_OPTIONS = [['all', 'All'], ['workspaces', 'Chosen'], ['manual', 'Where added']]
/** What Works in means, under the choice (when no workspaces are picked by hand). */
export const REACH_HINTS = { all: 'Global: in every workspace you own, and any you make later.', manual: 'Only in workspaces it is added to, from their page.' }
export const JOINS_OPTIONS = [['all', 'Every session'], ['invited', 'When invited']]
const JOINS_HINTS = { all: 'Joins each session in its workspaces as it starts.', invited: 'Joins a session only when someone invites it.', manual: 'Set on each workspace it is added to.' }
const options = (list, value) => list.map(([v, label]) => `<option value="${v}"${v === value ? ' selected' : ''}>${label}</option>`).join('')
const segs = (list, value, attr, label, disabled = false) =>
  `<div class="segmented sm" role="radiogroup" ${attr} aria-label="${esc(label)}"${disabled ? ' aria-disabled="true"' : ''}>${list.map(([v, l]) =>
    `<button type="button" role="radio" data-v="${v}" aria-checked="${v === value}" class="${v === value ? 'on' : ''}"${disabled ? ' disabled' : ''}>${l}</button>`).join('')}</div>`

/** Your own personal workspaces: the only ones one of your agents can be placed in. */
export const placeableWorkspaces = (list) => (list || []).filter((w) => w.space?.kind === 'personal' && w.via === 'owner')

/**
 * One of your agents in Settings › Agents. Without a placement (workspaces off) it is the row
 * Quilt has always shown; with one, a card with where it works and when it joins sessions.
 */
export function agentRow (a, place = null, workspaces = []) {
  const signedOut = a.status === 'reused' || a.status === 'expired'
  const state = signedOut ? '<span class="pill warn">signed out</span>' : a.canJoinSessions ? '' : '<span class="pill">registered only</span>'
  const when = a.lastUsedAt ? `last used ${ago(a.lastUsedAt)}` : `added ${ago(a.createdAt)}`
  if (place) return agentCardHtml(a, place, workspaces, { state, when })
  return `<div class="kv agent-row"><span>${I.bot}</span><b>${esc(a.name)} ${state}</b><span class="hint">${esc(a.provider)} · ${esc(a.type)} · ${when}</span></div>`
}

/** The chosen-workspace chips: each of your workspaces, pressed when the agent is in it. */
function chipsHtml (ids, workspaces) {
  if (!workspaces.length) return '<span class="ag-why">Make a workspace first.</span>'
  return workspaces.map((w) => `<button type="button" class="ag-chip" data-placement-ws value="${esc(w.id)}" aria-pressed="${ids.includes(w.id)}"><i style="background:${COLORS[w.color] || COLORS.lilac}"></i>${esc(w.name)}</button>`).join('')
}

/**
 * An agent's card: who it is (with a Global badge when it is in every workspace), Works in
 * (all workspaces, chosen ones as chips, or only where added) and Joins. The line under each
 * choice has a fixed height, so changing a choice never moves the card.
 */
export function agentCardHtml (a, place, workspaces, { state = '', when = '' } = {}) {
  const ids = place.workspaceIds || []
  const manual = place.reach === 'manual'
  return `
  <div class="ag-card" data-agent-place="${esc(a.id)}">
    <div class="ag-head">${avatar(a.name, colorFor(a.name), false)}
      <div class="ag-t"><b>${esc(a.name)}</b>${state ? ` ${state}` : ''}<span class="hint">${esc(a.provider)} · ${esc(a.type)} · ${when}</span></div>
      <span class="pill violet ag-global" data-ag-global${place.reach === 'all' ? '' : ' hidden'} title="In every workspace you own">${I.globe}Global</span>
    </div>
    <div class="ag-set">
      <div class="ag-g"><span class="ag-l">Works in</span>${segs(REACH_OPTIONS, place.reach, 'data-placement-reach', `Where ${a.name} works`)}
        <div class="ag-detail" data-ag-detail>${place.reach === 'workspaces' ? chipsHtml(ids, workspaces) : `<span class="ag-why">${esc(REACH_HINTS[place.reach])}</span>`}</div></div>
      <div class="ag-g"><span class="ag-l">Joins sessions</span>${segs(JOINS_OPTIONS, place.sessions, 'data-placement-sessions', `When ${a.name} joins sessions`, manual)}
        <div class="ag-detail"><span class="ag-why" data-ag-joins-why>${esc(JOINS_HINTS[manual ? 'manual' : place.sessions])}</span></div></div>
    </div>
  </div>`
}

/** The placement to save from what the card shows; access and folder limits stay as they were. */
export function placementBody (saved, { reach, sessions, workspaceIds }, workspaces) {
  const mine = new Set(workspaces.map((w) => w.id))
  return { reach, sessions, access: saved.access || 'edit', scopes: saved.scopes || [], workspaceIds: reach === 'workspaces' ? workspaceIds.filter((id) => mine.has(id)) : [] }
}

/** Saves each card's Works in, chosen workspaces and Joins as they change. */
export function bindPlacements (root, agents, places, workspaces) {
  root.querySelectorAll('[data-agent-place]').forEach((el) => {
    const i = agents.findIndex((a) => a.id === el.dataset.agentPlace)
    if (i >= 0 && places[i]) bindPlacement(el, agents[i], places[i], workspaces)
  })
}

/** One card: what it shows follows the choices, each change saves, and a failed save puts the card back. */
export function bindPlacement (el, a, place, workspaces) {
  let saved = place
  let shown = { reach: place.reach, sessions: place.sessions, workspaceIds: [...(place.workspaceIds || [])] }
  const reachEl = el.querySelector('[data-placement-reach]')
  const joinsEl = el.querySelector('[data-placement-sessions]')
  const paint = () => {
    const manual = shown.reach === 'manual'
    for (const b of reachEl.querySelectorAll('[data-v]')) { const on = b.dataset.v === shown.reach; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)) }
    for (const b of joinsEl.querySelectorAll('[data-v]')) { const on = b.dataset.v === shown.sessions; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); b.disabled = manual }
    if (manual) joinsEl.setAttribute('aria-disabled', 'true'); else joinsEl.removeAttribute('aria-disabled')
    el.querySelector('[data-ag-global]').hidden = shown.reach !== 'all'
    el.querySelector('[data-ag-detail]').innerHTML = shown.reach === 'workspaces' ? chipsHtml(shown.workspaceIds, workspaces) : `<span class="ag-why">${esc(REACH_HINTS[shown.reach])}</span>`
    el.querySelector('[data-ag-joins-why]').textContent = JOINS_HINTS[manual ? 'manual' : shown.sessions]
  }
  const save = async () => {
    paint()
    try {
      saved = (await api('POST', `/api/agents/${encodeURIComponent(a.id)}/placement`, placementBody(saved, shown, workspaces))).placement
      toast('Saved')
    } catch (err) {
      toast(err.message)
      shown = { reach: saved.reach, sessions: saved.sessions, workspaceIds: [...(saved.workspaceIds || [])] }
      paint()
    }
  }
  el.addEventListener('click', (e) => {
    const r = e.target.closest('[data-placement-reach] [data-v]')
    const j = e.target.closest('[data-placement-sessions] [data-v]')
    const c = e.target.closest('[data-placement-ws]')
    if (r && r.dataset.v !== shown.reach) { shown.reach = r.dataset.v; return save() }
    if (j && !j.disabled && j.dataset.v !== shown.sessions) { shown.sessions = j.dataset.v; return save() }
    if (c) {
      shown.workspaceIds = shown.workspaceIds.includes(c.value) ? shown.workspaceIds.filter((id) => id !== c.value) : [...shown.workspaceIds, c.value]
      return save()
    }
  })
}

/** Why someone else's agent in a workspace never joins every session there (the API's words). */
export const FOREIGN_JOINS = 'Only its owner can make an agent join every session.'

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
  const global = a.via === 'global'
  const pill = `<span class="pill ws-via${global ? ' violet' : ''}"${global ? ' title="In every workspace its owner has. Set in Settings › Agents."' : ''}>${global ? I.globe : ''}${esc(viaLabel(a, orgName))}</span>`
  // Someone else's agent added here joins only when invited: only its owner can change that.
  let joins = `<span>Joins ${a.sessions === 'all' ? 'every session' : 'when invited'}</span>`
  if (a.excluded) joins = '<span>Not in this workspace</span>'
  else if (admin && a.foreign) joins = `<span title="${esc(FOREIGN_JOINS)}">Joins when invited</span>`
  else if (admin) joins = `<span>Joins</span><select class="input xs" data-agent-joins="${esc(a.agentId)}" aria-label="When ${esc(name)} joins sessions here">${options([['all', 'Every session'], ['invited', 'When invited']], a.sessions)}</select>`
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

/** A session's people menu (owner, workspaces on): agents kept out of this session, each with Let back in. */
export function keptOutHtml (agents) {
  if (!agents?.length) return ''
  return `<div class="pm-section pm-kept-out"><div class="pm-title">Kept out of this session</div>
    ${agents.map((a) => `<div class="pm-member"><span class="nm">${esc(a.name || 'Agent')} (agent)</span><button type="button" class="btn sm" data-let-in="${esc(a.agentId)}">Let back in</button></div>`).join('')}</div>`
}
