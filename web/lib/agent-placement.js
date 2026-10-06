// Where an agent works, on the website: its placement form (Available in and Joins) and why
// an agent is on a workspace's page. Pure, so it's unit-tested directly. The words match
// the app's (src/ui/agent-place.js).

export const REACH = ['manual', 'all', 'workspaces']
export const JOINS = ['invited', 'all']

/** Available in's choices. `allLabel` names "all" for an org ("All Acme workspaces"). */
export function reachOptions (allLabel = 'All my workspaces') {
  return [['manual', 'Only where I add it'], ['all', allLabel], ['workspaces', 'Chosen workspaces']]
}

/** What Available in means, under the choices. */
export const REACH_HINTS = { manual: 'Add it from a workspace’s page.', all: 'Every workspace now, and new ones.', workspaces: 'Only the workspaces ticked here.' }

export const JOINS_OPTIONS = [['invited', 'When invited'], ['all', 'Every session']]

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

/** Why someone else's agent in a workspace never joins every session there (the API's words). */
export const FOREIGN_JOINS = 'Only its owner can make an agent join every session.'

/** Joins, said in words (for someone who can't change it). */
export const joinsText = (sessions) => sessions === 'all' ? 'Joins every session' : 'Joins when invited'

/** A workspace page's member list without the agents shown with their own rows. */
export function peopleOnly (members, agents) {
  const listed = new Set((agents || []).map((a) => a.account))
  return (members || []).filter((m) => !listed.has(m.account))
}
