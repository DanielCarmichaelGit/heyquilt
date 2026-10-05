// Who is calling a workspace route, and what they may do in the workspace. Shared by
// the workspace routes and the workspace file routes.
import { HttpError, needId } from './http.js'
import { orgGrantsFor } from './org-access.js'
import { workspaceAccess } from './workspace-access.js'

const NOT_FOUND = 'no such workspace'

/** Whether a caller's access lets them see the workspace's files (the spec's Access rule 2):
 * explicit members (even view) and admins do; an org member who reaches the workspace only
 * through Workspaces: Read sees the page, but not its files. */
export const canSeeFiles = (access) => !(access.via === 'org' && access.access === 'view')

export function workspaceReach ({ store, person, agentAuth, bearer }) {
  /** The caller as an account string: a person (website or linked computer) or an agent (qa_ key). */
  async function caller (req) {
    if (bearer(req).startsWith('qa_')) { const { agent } = await agentAuth.agentFromRequest(req); return { account: `agent:${agent.id}`, userId: null, agent } }
    const p = await person(req)
    return { account: `person:${p.userId}`, userId: p.userId }
  }

  /** The caller's org access for a workspace's org, or null (a person outside it, or an agent). Never throws. */
  const grantsIn = (ws, me) => (ws.orgId ? orgGrantsFor(store, ws.orgId, me.account) : null)

  /** A workspace the caller may at least see, with their access; 404 otherwise (outsiders can't probe ids). */
  async function reach (req, id) {
    const me = await caller(req)
    const ws = await store.workspaceById(needId(id, 'workspace'))
    const orgGrants = ws && await grantsIn(ws, me)
    const access = ws && await workspaceAccess(store, ws, me.account, { orgGrants })
    if (!access) throw new HttpError(404, NOT_FOUND)
    // Who may delete it, as the DELETE route decides: the owner of a personal one; for an
    // org's, a person whose role holds Workspaces: Delete (never an agent).
    const canDelete = ws.orgId ? !!(me.userId && orgGrants && orgGrants.can('workspaces', 'd')) : access.via === 'owner'
    return { me, ws, access, canDelete, needAdmin () { if (!access.admin) throw new HttpError(403, "you don't manage this workspace") } }
  }

  return { caller, grantsIn, reach }
}
