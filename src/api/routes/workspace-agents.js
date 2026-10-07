// Agents in workspaces: where an agent works (its placement, set by its owner), a
// workspace's say over an agent placed there (its override), workspace agent invites,
// a session owner keeping an agent out of one session, and an agent's own webhook for
// workspace events. Behind the QUILT_WORKSPACES flag: off, every route answers 404.
import { HttpError, needId } from '../http.js'
import { newToken, hashToken } from '../tokens.js'
import { orgAccess } from '../org-access.js'
import { cleanAccess, stillInOrg } from '../workspace-access.js'
import { workspaceReach } from '../workspace-reach.js'
import { cleanPlacement, placementIn, agentsJoiningSession, sessionAgents, sameOwnerAgent, SESSIONS } from '../agent-placement.js'
import { AGENT_INVITE_TTL_MS, inviteStatus } from './agent-invites.js'
import crypto from 'node:crypto'
import { parseWebhookUrl, newSecret, publicWebhookHost, deliverWebhook } from '../../webhooks.js'
import { parseInvite, buildInvite } from '../../ui/invite.js'
import { isHostedRelay, HOSTED_RELAY } from '../../settings.js'

const ROOM = /^[A-Za-z0-9_-]{1,64}$/
export const AGENT_WEBHOOK_EVENTS = ['session.started']
/** Why someone else's agent in a workspace is never invited to every session there. */
export const FOREIGN_JOINS = 'Only its owner can have an agent invited to every session.'

/** A placement as the routes answer it; an agent with none is 'manual' (it works only where it is added). */
export function placementView (agentId, p) {
  if (!p) return { agentId, reach: 'manual', workspaceIds: [], sessions: 'invited', access: 'edit', scopes: [], updatedAt: null }
  return { agentId, reach: p.reach, workspaceIds: [...(p.workspaceIds || [])], sessions: p.sessions, access: p.access, scopes: [...(p.scopes || [])], updatedAt: p.updatedAt ?? null }
}

/** A member agent's `sessions`: 'all' or 'invited', and only for an agent. Undefined keeps what the member has. */
export function cleanMemberSessions (value, kind) {
  if (value === undefined) return undefined
  if (kind !== 'agent') throw new HttpError(400, 'Only an agent joins sessions by itself.')
  if (!SESSIONS.includes(value)) throw new HttpError(400, 'Sessions is all or invited.')
  return value
}

/**
 * The agents in `ws` for its page: member agents (via 'member', managed by the workspace),
 * then agents of the workspace's owner placed there (via 'placed' or 'global', managed by
 * the owner or the org), with the workspace's override applied. Agents the workspace kept
 * out are listed (excluded: true) only for an admin, so they can be let back in. `foreign`
 * marks someone else's agent added here: it joins only when invited, whatever its row says.
 */
export async function workspaceAgents (store, ws, { admin = false } = {}) {
  const out = []
  const seen = new Set()
  for (const m of await store.listWorkspaceMembers(ws.id)) {
    if (!m.account.startsWith('agent:')) continue
    const agentId = m.account.slice(6)
    const agent = await store.agentById(agentId)
    if (!agent || agent.revokedAt || !(await stillInOrg(store, ws, m.account, null))) continue
    seen.add(agentId)
    const foreign = !(await sameOwnerAgent(store, ws, agentId))
    out.push({ account: m.account, agentId, name: agent.name, provider: agent.provider, via: 'member', access: m.access, sessions: foreign ? 'invited' : (m.sessions || 'invited'), managedBy: 'workspace', excluded: false, foreign })
  }
  const own = ws.orgId ? await store.listOrgAgents(ws.orgId) : ws.ownerUserId ? await store.listPersonalAgents(ws.ownerUserId) : []
  const placed = []
  for (const agent of own) {
    if (seen.has(agent.id)) continue
    const p = await placementIn(store, ws, agent.id)
    if (!p) continue
    const override = await store.workspaceAgentOverride(ws.id, agent.id)
    const excluded = !!override?.excluded
    if (excluded && !admin) continue
    placed.push({ account: `agent:${agent.id}`, agentId: agent.id, name: agent.name, provider: agent.provider, via: p.reach === 'all' ? 'global' : 'placed', access: p.access, sessions: override?.sessions ?? p.sessions, managedBy: ws.orgId ? 'org' : 'owner', excluded, foreign: false })
  }
  placed.sort((a, b) => a.name.localeCompare(b.name))
  return [...out, ...placed]
}

/** Every workspace an agent can find by its placement: its owner's personal ones, or its org's. */
export async function placementCandidates (store, agent) {
  if (!agent) return []
  if (agent.orgId) return store.listWorkspacesOfOrg(agent.orgId)
  return agent.ownerUserId ? store.listWorkspacesOwnedBy(agent.ownerUserId) : []
}

/** A relay address as join links carry it (ws:// or wss://, no trailing slash). */
const relayForm = (url) => String(url || '').replace(/\/+$/, '').replace(/^http(s?):\/\//, 'ws$1://')

export function workspaceAgentRoutes (ctx) {
  const { store, person, now, apiUrl, limitSend, limitAnnounce = () => {}, log = () => {}, workspaces = false } = ctx
  // The session-started hand-off: how webhooks are sent (tests record them), how host names
  // resolve, and whether a receiver on this computer is allowed (tests only).
  const { relayUrl = HOSTED_RELAY, webhookFetch = globalThis.fetch, webhookLookup, allowLocalWebhooks = false, trackDelivery = (p) => p } = ctx
  const ownRelay = relayForm(relayUrl)
  const { caller, reach } = workspaceReach(ctx)
  const gated = (fn) => (...args) => {
    if (!workspaces) throw new HttpError(404, 'not found')
    return fn(...args)
  }

  /** A placement body, checked, with every listed workspace one of `owns` (the owner's own). */
  async function placementFrom (body, owns) {
    const p = cleanPlacement(body)
    for (const id of p.workspaceIds) {
      const ws = await store.workspaceById(id)
      if (!ws || !owns(ws)) throw new HttpError(400, 'An agent can only be placed in its owner\'s own workspaces.')
    }
    return p
  }

  async function myAgent (req, id) {
    const u = await person(req)
    const agent = await store.agentById(needId(id, 'agent'))
    // Someone else's agent, an org's, or a revoked one: the same answer as a missing one.
    if (!agent || agent.ownerUserId !== u.userId || agent.revokedAt) throw new HttpError(404, 'no such agent')
    return { u, agent }
  }

  async function orgFor (req, slug) {
    const u = await person(req)
    return { u, ...(await orgAccess(store, u.userId, slug)) }
  }

  async function orgAgent (a, id) {
    const agent = await store.agentById(needId(id, 'agent'))
    if (!agent || agent.orgId !== a.org.id || agent.revokedAt) throw new HttpError(404, 'no such agent')
    return agent
  }

  /** The room's session when the caller owns it (as the relay reports it). */
  async function ownRoom (req, room) {
    const me = await caller(req)
    if (!ROOM.test(room)) throw new HttpError(404, 'no such session')
    const session = await store.sessionByRoom(room)
    if (!session) throw new HttpError(404, 'no such session')
    if (!session.ownerAccount || session.ownerAccount !== me.account) throw new HttpError(403, 'Only the session owner can do that.')
    return { me, session }
  }

  /** The room's session when the caller owns it, and the agent to keep out. */
  async function ownSession (req, room, agentId) {
    const { me, session } = await ownRoom(req, room)
    const agent = await store.agentById(needId(agentId, 'agent'))
    if (!agent) throw new HttpError(404, 'no such agent')
    return { me, session, agent }
  }

  async function meAsAgent (req) {
    const me = await caller(req)
    if (!me.account.startsWith('agent:')) throw new HttpError(403, 'Only an agent has a webhook here.')
    return me.agent || await store.agentById(me.account.slice(6))
  }

  /**
   * Sends one agent its session.started event, after checking its webhook still points at the
   * public internet as it resolves now (the URL was only checked as written when it was set).
   * Never throws: a skipped or failed send is logged, without the link.
   */
  async function sendSessionStarted (agentId, hook, payload) {
    try {
      let url
      try { url = parseWebhookUrl(hook.url, { allowLocal: allowLocalWebhooks }) } catch (e) {
        log(`session.started to agent ${agentId} skipped: ${hook.url}: ${e.message}`)
        return
      }
      if (!allowLocalWebhooks) {
        const host = await publicWebhookHost(url, webhookLookup ? { lookup: webhookLookup } : {})
        if (!host.ok) { log(`session.started to agent ${agentId} skipped: ${host.reason}`); return }
      }
      await deliverWebhook({ url, secret: hook.secret }, payload, { fetch: webhookFetch, now, log })
    } catch (err) {
      log(`session.started to agent ${agentId} failed: ${err?.message || err}`)
    }
  }

  const routes = [
    ['GET', /^\/v1\/me\/agents\/([^/]+)\/placement$/, async (req, body, [id]) => {
      const { agent } = await myAgent(req, id)
      return { placement: placementView(agent.id, await store.agentPlacement(agent.id)) }
    }],

    ['PUT', /^\/v1\/me\/agents\/([^/]+)\/placement$/, async (req, body, [id]) => {
      const { u, agent } = await myAgent(req, id)
      // A personal agent's workspaces are its owner's personal ones, never an org's.
      const p = await placementFrom(body, (ws) => !ws.orgId && ws.ownerUserId === u.userId)
      return { placement: placementView(agent.id, await store.putAgentPlacement({ agentId: agent.id, ...p, updatedBy: `person:${u.userId}` })) }
    }],

    ['GET', /^\/v1\/orgs\/([^/]+)\/agents$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      a.need('agents', 'r')
      const agents = await store.listOrgAgents(a.org.id)
      const placements = new Map((await store.listAgentPlacements(agents.map((x) => x.id))).map((p) => [p.agentId, p]))
      return { agents: agents.map((x) => ({ id: x.id, name: x.name, provider: x.provider, type: x.type, hosted: !x.publicKey, placement: placementView(x.id, placements.get(x.id)) })) }
    }],

    ['PUT', /^\/v1\/orgs\/([^/]+)\/agents\/([^/]+)\/placement$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      a.need('agents', 'u')
      // Placing an agent puts it in the org's workspaces, so it takes Workspaces: Update too.
      a.need('workspaces', 'u')
      const agent = await orgAgent(a, id)
      const p = await placementFrom(body, (ws) => ws.orgId === a.org.id)
      return { placement: placementView(agent.id, await store.putAgentPlacement({ agentId: agent.id, ...p, updatedBy: `person:${a.u.userId}` })) }
    }],

    // Only for an agent the workspace's owner placed there: an agent added by hand is
    // managed through its member row instead.
    ['PUT', /^\/v1\/workspaces\/([^/]+)\/agents\/([^/]+)$/, async (req, body, [id, agentId]) => {
      const r = await reach(req, id)
      r.needAdmin()
      if (!(await placementIn(store, r.ws, agentId))) throw new HttpError(404, 'that agent is not placed in this workspace')
      const b = body && typeof body === 'object' ? body : {}
      if (b.sessions !== undefined && b.sessions !== null && !SESSIONS.includes(b.sessions)) throw new HttpError(400, 'Sessions is all, invited or null.')
      if (b.excluded !== undefined && typeof b.excluded !== 'boolean') throw new HttpError(400, 'excluded is true or false.')
      const old = await store.workspaceAgentOverride(r.ws.id, agentId)
      const override = await store.putWorkspaceAgentOverride({
        workspaceId: r.ws.id,
        agentId,
        sessions: b.sessions !== undefined ? b.sessions : (old?.sessions ?? null),
        excluded: b.excluded !== undefined ? b.excluded : !!old?.excluded
      })
      return { override }
    }],

    ['DELETE', /^\/v1\/workspaces\/([^/]+)\/agents\/([^/]+)$/, async (req, body, [id, agentId]) => {
      const r = await reach(req, id)
      r.needAdmin()
      await store.deleteWorkspaceAgentOverride(r.ws.id, needId(agentId, 'agent'))
      return { ok: true }
    }],

    // A one-time link (good for an hour) for a new agent of the workspace's owner, which
    // joins as a member of this workspace. An org's needs Agents: Create too.
    ['POST', /^\/v1\/workspaces\/([^/]+)\/agent-invites$/, async (req, body, [id]) => {
      const r = await reach(req, id)
      r.needAdmin()
      if (!r.me.userId) throw new HttpError(403, 'agents do not invite agents')
      const workspaceAccess = cleanAccess(body.access ?? 'edit')
      const workspaceSessions = body.sessions ?? 'invited'
      if (!SESSIONS.includes(workspaceSessions)) throw new HttpError(400, 'Sessions is all or invited.')
      let home
      if (r.ws.orgId) {
        const a = await orgAccess(store, r.me.userId, (await store.orgById(r.ws.orgId)).slug)
        a.need('agents', 'c')
        home = { orgId: a.org.id }
      } else home = { ownerUserId: r.ws.ownerUserId }
      limitSend(r.me.userId)
      const token = newToken('qj_')
      const invite = await store.createAgentInvite({ tokenHash: hashToken(token), createdBy: r.me.userId, expiresAt: now() + AGENT_INVITE_TTL_MS, ...home, workspaceId: r.ws.id, workspaceAccess, workspaceSessions })
      return {
        invite: { id: invite.id, kind: invite.orgId ? 'org' : 'personal', status: inviteStatus(invite, now()), workspaceId: invite.workspaceId, workspaceAccess: invite.workspaceAccess, workspaceSessions: invite.workspaceSessions, createdAt: invite.createdAt, expiresAt: invite.expiresAt },
        link: `${apiUrl}/v1/join/${token}`
      }
    }],

    // The session's agents for its People: the ones its workspace invites (and why), and the
    // ones its owner keeps out (Don't invite), so the owner can change either.
    ['GET', /^\/v1\/sessions\/([^/]+)\/agents$/, async (req, body, [room]) => {
      await ownRoom(req, room)
      return { agents: await sessionAgents(store, room) }
    }],

    // The agents its owner keeps out of this session, so the app can offer to let them back in.
    ['GET', /^\/v1\/sessions\/([^/]+)\/agents\/excluded$/, async (req, body, [room]) => {
      await ownRoom(req, room)
      const agents = []
      for (const e of await store.listSessionAgentExclusions(room)) agents.push({ agentId: e.agentId, name: (await store.agentById(e.agentId))?.name || '' })
      return { agents }
    }],

    ['PUT', /^\/v1\/sessions\/([^/]+)\/agents\/([^/]+)\/exclude$/, async (req, body, [room, agentId]) => {
      const { me, agent } = await ownSession(req, room, agentId)
      await store.addSessionAgentExclusion({ room, agentId: agent.id, excludedBy: me.account })
      return { ok: true }
    }],

    ['DELETE', /^\/v1\/sessions\/([^/]+)\/agents\/([^/]+)\/exclude$/, async (req, body, [room, agentId]) => {
      const { agent } = await ownSession(req, room, agentId)
      await store.removeSessionAgentExclusion(room, agent.id)
      return { ok: true }
    }],

    // The session's owner, as soon as it has started a session in this workspace, hands over
    // its join link; every agent that joins the session by itself and has a webhook is sent it
    // at once. The link is used for these sends and never kept. 409 until the relay has said
    // who owns the session (the app tries again shortly).
    ['POST', /^\/v1\/workspaces\/([^/]+)\/sessions\/([^/]+)\/started$/, async (req, body, [id, room]) => {
      const r = await reach(req, id)
      if (!ROOM.test(room)) throw new HttpError(404, 'that session is not in this workspace')
      const session = await store.sessionByRoom(room)
      if (!session || session.workspaceId !== r.ws.id) throw new HttpError(404, 'that session is not in this workspace')
      if (session.workspaceLinkedBy !== r.me.account) throw new HttpError(403, 'Only the session owner can do that.')
      if (!session.ownerAccount) throw new HttpError(409, 'Quilt has not heard who owns this session yet; try again in a moment.')
      if (session.ownerAccount !== r.me.account) throw new HttpError(403, 'Only the session owner can do that.')
      let invite
      try { invite = parseInvite(String(body.link || ''), { allowRelay: (s) => isHostedRelay(s) || relayForm(s) === ownRelay }) } catch { throw new HttpError(400, 'link must be this session\'s Quilt invite link') }
      if (invite.room !== room || !invite.secret) throw new HttpError(400, 'link must be this session\'s Quilt invite link')
      // `agents` (optional): only these of the agents it invites, e.g. one invited again.
      const only = body.agents === undefined ? null : body.agents
      if (only !== null && (!Array.isArray(only) || only.length > 100 || only.some((x) => typeof x !== 'string'))) throw new HttpError(400, 'agents must be a list of agent ids.')
      limitAnnounce(room)
      // Sent as Quilt writes it, whatever surrounded it in the request.
      const link = buildInvite({ server: invite.relay || HOSTED_RELAY, room, secret: invite.secret }, isHostedRelay)
      const by = r.me.userId ? ((await store.profile(r.me.userId))?.name || '') : (r.me.agent?.name || '')
      const notified = []
      const withoutWebhook = []
      // An agent that started the session is in it already: it isn't sent its own link.
      const starter = session.ownerAccount.startsWith('agent:') ? session.ownerAccount.slice(6) : null
      for (const { agentId, via } of await agentsJoiningSession(store, room)) {
        if (agentId === starter || (only && !only.includes(agentId))) continue
        const hook = await store.agentWebhook(agentId)
        if (!hook) { withoutWebhook.push(agentId); continue }
        notified.push(agentId)
        const payload = { event: 'session.started', id: crypto.randomUUID(), ts: now(), workspace: { id: r.ws.id, name: r.ws.name }, room, name: session.name || '', link, by, via }
        trackDelivery(sendSessionStarted(agentId, hook, payload))
      }
      return { notified, withoutWebhook }
    }],

    // The agent's own webhook for workspace events. The secret signs deliveries; it is
    // answered on every PUT, and every PUT makes a new one.
    ['PUT', /^\/v1\/agents\/me\/webhook$/, async (req, body) => {
      const agent = await meAsAgent(req)
      let url
      try { url = parseWebhookUrl(body.url, { allowLocal: allowLocalWebhooks }) } catch (e) { throw new HttpError(400, e.message) }
      const hook = await store.putAgentWebhook({ agentId: agent.id, url, secret: newSecret() })
      return { url: hook.url, secret: hook.secret, events: [...AGENT_WEBHOOK_EVENTS] }
    }],

    ['DELETE', /^\/v1\/agents\/me\/webhook$/, async (req) => {
      const agent = await meAsAgent(req)
      await store.deleteAgentWebhook(agent.id)
      return { ok: true }
    }]
  ]
  return routes.map(([method, pattern, fn, ...options]) => [method, pattern, gated(fn), ...options])
}
