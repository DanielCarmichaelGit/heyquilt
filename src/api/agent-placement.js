// Where an agent works without being added by hand (its placement), and who joins a
// session inside a workspace. A placement never crosses owners: a personal agent reaches
// only its owner's personal workspaces, an org agent only its org's. A workspace can
// keep a placed agent out or change whether it joins sessions (its override), and a
// session owner can keep any agent out of one session (an exclusion).
import { HttpError, UUID } from './http.js'
import { ACCESS, stillInOrg } from './workspace-access.js'
import { cleanFolders } from '../session-access.js'

export const REACH = ['all', 'workspaces', 'manual']
export const SESSIONS = ['all', 'invited']
const MAX_WORKSPACES = 100

/** A placement as a route receives it, checked: { reach, workspaceIds, sessions, access, scopes }. HttpError 400 otherwise. */
export function cleanPlacement (body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  if (!REACH.includes(b.reach)) throw new HttpError(400, 'Reach is all, workspaces or manual.')
  if (!SESSIONS.includes(b.sessions)) throw new HttpError(400, 'Sessions is all or invited.')
  if (!ACCESS.includes(b.access)) throw new HttpError(400, 'Access is edit or view.')
  let workspaceIds = []
  if (b.reach === 'workspaces') {
    const raw = b.workspaceIds ?? []
    if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string' || !UUID.test(id))) throw new HttpError(400, 'workspaceIds must be a list of workspace ids.')
    workspaceIds = [...new Set(raw.map((id) => id.toLowerCase()))]
    if (workspaceIds.length > MAX_WORKSPACES) throw new HttpError(400, `A placement can list at most ${MAX_WORKSPACES} workspaces.`)
  }
  let scopes
  try { scopes = cleanFolders(b.scopes ?? []) } catch (e) { throw new HttpError(400, e.message) }
  return { reach: b.reach, workspaceIds, sessions: b.sessions, access: b.access, scopes }
}

/** A live agent (not revoked) from the same owner as `ws`, or null. */
async function sameOwnerAgent (store, ws, agentId) {
  if (!UUID.test(String(agentId || ''))) return null
  const agent = await store.agentById(agentId)
  if (!agent || agent.revokedAt) return null
  if (ws.orgId) {
    if (agent.orgId !== ws.orgId) return null
    // Removing an agent from its org revokes it; this keeps a half-removed one out too.
    if (!(await store.memberByAgent(ws.orgId, agentId))) return null
  } else if (!ws.ownerUserId || agent.ownerUserId !== ws.ownerUserId) return null
  return agent
}

/**
 * How `agentId`'s placement reaches `ws`: { access, scopes, via: 'placed' | 'global', sessions }
 * or null. Ids in a placement that aren't `ws` are ignored, so a deleted workspace's id left
 * in the list never matters.
 */
export async function agentReach (store, ws, agentId) {
  if (!ws || !(await sameOwnerAgent(store, ws, agentId))) return null
  const placement = await store.agentPlacement(agentId)
  if (!placement || placement.reach === 'manual') return null
  if (placement.reach === 'workspaces' && !(placement.workspaceIds || []).includes(ws.id)) return null
  const override = await store.workspaceAgentOverride(ws.id, agentId)
  if (override?.excluded) return null
  return { access: placement.access, scopes: [...(placement.scopes || [])], via: placement.reach === 'all' ? 'global' : 'placed', sessions: override?.sessions ?? placement.sessions }
}

/** Whether `agentId` joins `session` (in `ws`) when it starts: { joins, via } (via null when nothing decided yes). */
async function decide (store, session, ws, agentId) {
  const no = { joins: false, via: null }
  if (!UUID.test(String(agentId || ''))) return no
  if (await store.sessionAgentExcluded(session.room, agentId)) return no
  // A revoked agent never joins, whatever rows it left behind.
  const agent = await store.agentById(agentId)
  if (!agent || agent.revokedAt) return no
  const account = `agent:${agentId}`
  const member = await store.workspaceMember(ws.id, account)
  if (member && await stillInOrg(store, ws, account, null)) return { joins: member.sessions === 'all', via: 'member' }
  const r = await agentReach(store, ws, agentId)
  if (r) return { joins: r.sessions === 'all', via: r.via }
  return no
}

/** The room's session and its workspace, or null when it isn't in one. */
async function sessionAndWorkspace (store, room) {
  const session = await store.sessionByRoom(room)
  if (!session || !session.workspaceId) return null
  const ws = await store.workspaceById(session.workspaceId)
  return ws ? { session, ws } : null
}

/**
 * Whether an agent joins the session in `room` by itself: kept out of this session, no;
 * a member row in the session's workspace decides next; then its placement (with the
 * workspace's override); otherwise no.
 */
export async function agentJoinsSession (store, room, agentId) {
  const sw = await sessionAndWorkspace(store, room)
  if (!sw) return false
  return (await decide(store, sw.session, sw.ws, agentId)).joins
}

/** Every agent that joins the session in `room` by itself, with what decided it: [{ agentId, via }]. */
export async function agentsJoiningSession (store, room) {
  const sw = await sessionAndWorkspace(store, room)
  if (!sw) return []
  const { session, ws } = sw
  const members = (await store.listWorkspaceMembers(ws.id)).filter((m) => m.account.startsWith('agent:')).map((m) => m.account.slice(6))
  const own = ws.orgId ? await store.listOrgAgents(ws.orgId) : await store.listPersonalAgents(ws.ownerUserId)
  const out = []
  for (const agentId of new Set([...members, ...own.map((a) => a.id)])) {
    const d = await decide(store, session, ws, agentId)
    if (d.joins) out.push({ agentId, via: d.via })
  }
  return out
}
