// Agent invites: a signed-in person makes a one-time link (good for an hour)
// that their AI uses to join, as their personal agent or as an org's agent with
// the role, teams and folders chosen here. Only the link's hash is stored.
// Personal invites can be made from the website or from the Quilt app (`person`);
// org invites only from the website (`user`). With workspaces on, a personal invite can be
// for a global agent (`global: true`): it joins placed in all its owner's workspaces.
import { HttpError, needId } from '../http.js'
import { newToken, hashToken } from '../tokens.js'
import { orgAccess } from '../org-access.js'
import { accessOf, cleanScopes } from '../team-access.js'

export const AGENT_INVITE_TTL_MS = 60 * 60 * 1000
const MAX_TEAMS = 50

export const inviteStatus = (i, at) => (i.cancelledAt ? 'cancelled' : i.usedAt ? 'used' : i.expiresAt <= at ? 'expired' : 'waiting')

export function agentInviteRoutes ({ store, user, person, now, apiUrl, limitSend, workspaces = false }) {
  const orgFor = async (req, slug) => { const u = await user(req); return { u, ...(await orgAccess(store, u.userId, slug)) } }
  const teamNames = async (orgId) => new Map((await store.listTeams(orgId)).map((x) => [x.id, x.name]))

  async function view (i, names = new Map(), roleName = null) {
    const agent = i.usedByAgentId ? await store.agentById(i.usedByAgentId) : null
    return {
      id: i.id,
      kind: i.orgId ? 'org' : 'personal',
      status: inviteStatus(i, now()),
      usedBy: agent ? { id: agent.id, name: agent.name, provider: agent.provider } : null,
      ...(i.global ? { global: true } : {}),
      role: roleName,
      teams: i.teams.map((x) => ({ id: x.teamId, name: names.get(x.teamId) || '', access: x.access, scopes: x.scopes })),
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
      usedAt: i.usedAt
    }
  }

  // The link is shown once; only its hash is kept.
  async function make (userId, fields) {
    const token = newToken('qj_')
    const invite = await store.createAgentInvite({ tokenHash: hashToken(token), createdBy: userId, expiresAt: now() + AGENT_INVITE_TTL_MS, ...fields })
    return { invite, link: `${apiUrl}/v1/join/${token}` }
  }

  // What an org invite hands out, checked against the inviter's own rights now.
  async function orgChoices (a, body) {
    const role = body.roleId ? await a.assignable(body.roleId) : null
    const list = body.teams ?? []
    if (!Array.isArray(list) || list.length > MAX_TEAMS) throw new HttpError(400, 'teams must be a list')
    if (list.length) a.need('team_members', 'c')
    const teams = []
    for (const item of list) {
      const team = await store.teamById(a.org.id, needId(item?.teamId, 'team'))
      if (!team) throw new HttpError(404, 'no such team')
      if (teams.some((x) => x.teamId === team.id)) throw new HttpError(400, 'each team can only be picked once')
      // Viewer unless the inviter chose editor: an agent starts read-only.
      teams.push({ teamId: team.id, access: accessOf(item.access ?? 'viewer'), scopes: cleanScopes(item.scopes ?? []) })
    }
    return { role, teams }
  }

  async function cancel (i) {
    if (!await store.cancelAgentInvite(i.id)) throw new HttpError(409, 'this invite was already used or cancelled')
    return { ok: true }
  }

  return [
    ['POST', /^\/v1\/agent-invites$/, async (req, body) => {
      const u = await person(req)
      limitSend(u.userId)
      // Only with workspaces on, and only a real true: anything else is the invite as it always was.
      const global = workspaces && body?.global === true
      const { invite, link } = await make(u.userId, { ownerUserId: u.userId, ...(global ? { global: true } : {}) })
      return { invite: await view(invite), link }
    }],

    ['GET', /^\/v1\/agent-invites$/, async (req) => {
      const u = await person(req)
      return { invites: await Promise.all((await store.listAgentInvites({ ownerUserId: u.userId })).map((i) => view(i))) }
    }],

    ['DELETE', /^\/v1\/agent-invites\/([^/]+)$/, async (req, body, [id]) => {
      const u = await person(req)
      const i = await store.agentInviteById(needId(id, 'invite'))
      if (!i || i.ownerUserId !== u.userId) throw new HttpError(404, 'no such invite')
      return cancel(i)
    }],

    ['POST', /^\/v1\/orgs\/([^/]+)\/agent-invites$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      a.need('agents', 'c')
      limitSend(a.u.userId)
      const { role, teams } = await orgChoices(a, body)
      const { invite, link } = await make(a.u.userId, { orgId: a.org.id, roleId: role ? role.id : null, teams })
      return { invite: await view(invite, await teamNames(a.org.id), role ? role.name : null), link }
    }],

    ['GET', /^\/v1\/orgs\/([^/]+)\/agent-invites$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      a.need('agents', 'c')
      const [invites, names, roles] = await Promise.all([store.listAgentInvites({ orgId: a.org.id }), teamNames(a.org.id), store.listRoles(a.org.id)])
      const roleName = new Map(roles.map((r) => [r.id, r.name]))
      return { invites: await Promise.all(invites.map((i) => view(i, names, roleName.get(i.roleId) || null))) }
    }],

    ['DELETE', /^\/v1\/orgs\/([^/]+)\/agent-invites\/([^/]+)$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      a.need('agents', 'c')
      const i = await store.agentInviteById(needId(id, 'invite'))
      if (!i || i.orgId !== a.org.id) throw new HttpError(404, 'no such invite')
      return cancel(i)
    }]
  ]
}
