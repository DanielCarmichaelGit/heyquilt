// Where an agent works, on the website: its placement form (Works in and Invited to new
// sessions) and why an agent is on a workspace's page. Pure, so it's unit-tested directly.
// The words match the app's (src/ui/agent-place.js).

export const REACH = ['manual', 'all', 'workspaces']
export const JOINS = ['invited', 'all']

/** Works in's choices. `allLabel` names "all" for an org ("All Acme workspaces"). */
export function reachOptions (allLabel = 'All workspaces (global)') {
  return [['all', allLabel], ['workspaces', 'Chosen workspaces'], ['manual', 'Only where added']]
}

/** What Works in means, under the choices. */
export const REACH_HINTS = { manual: 'Only in workspaces it is added to, from their page.', all: 'Global: in every workspace, and any made later.', workspaces: 'Only the workspaces ticked here.' }

// A workspace invites its agents to a new session (sends them the link); the session's owner lets them in.
export const JOINS_OPTIONS = [['invited', 'Not automatically'], ['all', 'Every session']]

/** A placement as the API answers it, with the defaults of an agent that has none. */
export function placementOf (p) {
  return {
    reach: REACH.includes(p?.reach) ? p.reach : 'manual',
    sessions: JOINS.includes(p?.sessions) ? p.sessions : 'invited',
    access: p?.access === 'view' ? 'view' : 'edit',
    workspaceIds: Array.isArray(p?.workspaceIds) ? p.workspaceIds.map(String) : [],
    scopes: Array.isArray(p?.scopes) ? p.scopes.map(String) : []
  }
}

/**
 * The placement to PUT from the form. Access and folder limits aren't on the form: they come
 * back as hidden fields, so a save keeps them. Workspaces count only for "Chosen workspaces".
 */
export function placementFromForm (formData) {
  const reach = String(formData.get('reach') || '')
  const sessions = String(formData.get('sessions') || '')
  const ids = [...new Set(formData.getAll('workspaceId').map(String).filter(Boolean))]
  return {
    reach: REACH.includes(reach) ? reach : 'manual',
    sessions: JOINS.includes(sessions) ? sessions : 'invited',
    access: formData.get('access') === 'view' ? 'view' : 'edit',
    scopes: formData.getAll('scope').map(String).filter(Boolean),
    workspaceIds: reach === 'workspaces' ? ids : []
  }
}

/**
 * The workspaces a placement form offers, and the chosen ones it can't show (in a workspace
 * the person can't see): those are kept as they are, so a save never drops them.
 */
export function placementChoices (place, workspaces) {
  const shown = (workspaces || []).map((w) => ({ id: w.id, name: w.name }))
  const ids = new Set(shown.map((w) => w.id))
  return { shown, hidden: placementOf(place).workspaceIds.filter((id) => !ids.has(id)) }
}

/** Your own personal workspaces: the only ones one of your agents can be placed in. */
export const personalWorkspaces = (list) => (list || []).filter((w) => w.space?.kind === 'personal' && w.via === 'owner')

/** An org's workspaces: the only ones its agents can be placed in. */
export const orgWorkspaces = (list, slug) => (list || []).filter((w) => w.space?.kind === 'org' && w.space.slug === slug)

/** The pill on a workspace's agent: why it is there. */
export function viaLabel (a, orgName = '') {
  if (a?.via === 'member') return 'This workspace'
  if (a?.managedBy === 'org') return `Added by ${orgName || 'the org'}`
  return a?.via === 'global' ? 'Global' : 'Placed'
}

/** Why someone else's agent in a workspace is never invited to every session there (the API's words). */
export const FOREIGN_JOINS = 'Only its owner can have an agent invited to every session.'

/** Whether it is invited to new sessions, said in words (for someone who can't change it). */
export const joinsText = (sessions) => sessions === 'all' ? 'Invited to new sessions' : 'Not invited automatically'

/** A workspace page's member list without the agents shown with their own rows. */
export function peopleOnly (members, agents) {
  const listed = new Set((agents || []).map((a) => a.account))
  return (members || []).filter((m) => !listed.has(m.account))
}
