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

/**
 * A live agent (not revoked) from the same owner as `ws`, or null: for a personal workspace
 * one of its owner's own agents, for an org's one of the org's agents still in it.
 */
export async function sameOwnerAgent (store, ws, agentId) {
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
 * `agentId`'s placement when it covers `ws`, before the workspace's override (so an admin
 * can still find an agent they kept out, to let it back in); null otherwise.
 */
export async function placementIn (store, ws, agentId) {
  if (!ws || !(await sameOwnerAgent(store, ws, agentId))) return null
  const placement = await store.agentPlacement(agentId)
  if (!placement || placement.reach === 'manual') return null
  if (placement.reach === 'workspaces' && !(placement.workspaceIds || []).includes(ws.id)) return null
  return placement
}

/**
 * How `agentId`'s placement reaches `ws`: { access, scopes, via: 'placed' | 'global', sessions }
 * or null. Ids in a placement that aren't `ws` are ignored, so a deleted workspace's id left
 * in the list never matters.
 */
export async function agentReach (store, ws, agentId) {
  const placement = await placementIn(store, ws, agentId)
  if (!placement) return null
  const override = await store.workspaceAgentOverride(ws.id, agentId)
  if (override?.excluded) return null
  return { access: placement.access, scopes: [...(placement.scopes || [])], via: placement.reach === 'all' ? 'global' : 'placed', sessions: override?.sessions ?? placement.sessions }
}

/** Whether `agentId` joins `session` (in `ws`) when it starts: { joins, via } (via null when nothing decided yes). */
async function decide (store, session, ws, agentId) {
  if (!UUID.test(String(agentId || ''))) return { joins: false, via: null }
  if (await store.sessionAgentExcluded(session.room, agentId)) return { joins: false, via: null }
  return inviteFor(store, ws, agentId)
}

/** What the workspace says about inviting `agentId` to its sessions, before any keep-out: { joins, via }. */
async function inviteFor (store, ws, agentId) {
  const no = { joins: false, via: null }
  if (!UUID.test(String(agentId || ''))) return no
  // A revoked agent never joins, whatever rows it left behind.
  const agent = await store.agentById(agentId)
  if (!agent || agent.revokedAt) return no
  const account = `agent:${agentId}`
  const member = await store.workspaceMember(ws.id, account)
  // A member row decides, but it makes an agent join every session only when the agent is
  // the workspace owner's own: anyone can add someone else's agent, never summon it.
  if (member && await stillInOrg(store, ws, account, null)) return { joins: member.sessions === 'all' && !!(await sameOwnerAgent(store, ws, agentId)), via: 'member' }
  const r = await agentReach(store, ws, agentId)
  if (r) return { joins: r.sessions === 'all', via: r.via }
  return no
}

/**
 * The room's session and its workspace, or null when it isn't in one. As in roomAccess, a
 * session counts as in a workspace only when its owner (as the relay reports it) put it there.
 */
async function sessionAndWorkspace (store, room) {
  const session = await store.sessionByRoom(room)
  if (!session || !session.workspaceId) return null
  if (!session.ownerAccount || session.ownerAccount !== session.workspaceLinkedBy) return null
  const ws = await store.workspaceById(session.workspaceId)
  return ws ? { session, ws } : null
}

/**
 * Whether an agent joins the session in `room` by itself: kept out of this session, no;
 * a member row in the session's workspace decides next (yes only for the workspace owner's
 * own agent); then its placement (with the workspace's override); otherwise no.
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

/**
 * A session's agents as its owner manages them (the session's People): every agent its
 * workspace invites to it, by name, with why (via 'member' | 'global' | 'placed'), who manages
 * that ('workspace', 'owner' or 'org') and whether its owner said Don't invite (excluded: the
 * keep-out). Sorted by name. A session outside a workspace invites nobody.
 */
export async function sessionAgents (store, room) {
  const sw = await sessionAndWorkspace(store, room)
  if (!sw) return []
  const { ws } = sw
  const excluded = new Set((await store.listSessionAgentExclusions(room)).map((e) => e.agentId))
  const ids = new Set()
  for (const m of await store.listWorkspaceMembers(ws.id)) if (m.account.startsWith('agent:')) ids.add(m.account.slice(6))
  for (const a of ws.orgId ? await store.listOrgAgents(ws.orgId) : await store.listPersonalAgents(ws.ownerUserId)) ids.add(a.id)
  const out = []
  for (const agentId of ids) {
    const d = await inviteFor(store, ws, agentId)
    if (!d.joins) continue
    const agent = await store.agentById(agentId)
    out.push({ agentId, name: agent?.name || '', via: d.via, managedBy: d.via === 'member' ? 'workspace' : ws.orgId ? 'org' : 'owner', excluded: excluded.has(agentId) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
