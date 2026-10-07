// Agents: swapping a refresh key, who an agent is, and a person's personal agents.
import { HttpError, needId } from '../http.js'
import { parsePublicKey, verifyAgentResume } from '../../identity.js'
import { keyStatus } from '../agent-auth.js'

// Never the key itself, just whether it has one. With a key it joins sessions from a computer
// running Quilt; without one it is hosted: it joins through the API's /mcp. Either way it can join.
const profileOf = (a) => ({ id: a.id, name: a.name, provider: a.provider, type: a.type, description: a.description, canJoinSessions: true, hosted: !a.publicKey })

export function agentRoutes ({ store, user, person, now, limitTokens, limitStarts, spendResume, resumeWindowMs, agentAuth, apiUrl }) {
  return [
    ['POST', /^\/v1\/agents\/token$/, async (req, body) => {
      limitTokens(req)
      return agentAuth.refresh(body.refreshKey)
    }],

    // An agent whose refresh key stopped working gets new keys with its resume key (every
    // agent gets one when it joins), or by signing for the key it joined with (agents on a
    // computer that joined before resume keys). A stolen refresh key alone can't do this,
    // and an agent a person revoked can't either: it's invited again.
    ['POST', /^\/v1\/agents\/resume$/, async (req, body) => {
      limitStarts(req)
      if (body.resumeKey !== undefined) return agentAuth.resumeByKey(body.resumeKey)
      const at = Number(body.at)
      if (!Number.isFinite(at) || Math.abs(now() - at) > resumeWindowMs) throw new HttpError(400, "this computer's clock is off; check its date and time")
      const agent = await store.agentById(needId(body.agentId, 'agent'))
      const key = agent && parsePublicKey(agent.publicKey)
      if (!key) throw new HttpError(404, 'no such agent')
      if (!verifyAgentResume(key, agent.id, at, body.signature)) throw new HttpError(401, "this agent's signature doesn't match")
      spendResume(String(body.signature), at)
      return agentAuth.resume(agent)
    }],

    ['GET', /^\/v1\/agents\/me$/, async (req) => {
      const { agent } = await agentAuth.agentFromRequest(req)
      const mcp = `${apiUrl}/mcp`
      if (!agent.orgId) return { agent: { ...profileOf(agent), kind: 'personal', org: null }, teams: [], role: null, mcp }
      const [org, m, teams] = await Promise.all([store.orgById(agent.orgId), store.memberByAgent(agent.orgId, agent.id), store.listTeams(agent.orgId)])
      const [role, mine] = await Promise.all([m?.roleId ? store.roleById(agent.orgId, m.roleId) : null, m ? store.teamsOfMember(m.id) : []])
      const names = new Map(teams.map((x) => [x.id, x.name]))
      return {
        agent: { ...profileOf(agent), kind: 'org', org: { slug: org.slug, name: org.name } },
        teams: mine.map((x) => ({ id: x.teamId, name: names.get(x.teamId) || '', access: x.access, scopes: x.scopes })),
        role: role ? { name: role.name } : null,
        mcp
      }
    }],

    // Listed on the website and in the app (a linked computer's token counts as its person).
    ['GET', /^\/v1\/agents$/, async (req) => {
      const u = await person(req)
      const agents = await store.listPersonalAgents(u.userId)
      return {
        agents: await Promise.all(agents.map(async (a) => ({
          ...profileOf(a),
          createdAt: a.createdAt,
          lastUsedAt: a.lastUsedAt,
          // Why an agent is signed out (reused or expired keys), so the dashboard can say so.
          status: keyStatus(await store.listAgentKeys(a.id), now())
        })))
      }
    }],

    ['DELETE', /^\/v1\/agents\/([^/]+)$/, async (req, body, [id]) => {
      const u = await user(req)
      const agent = await store.agentById(needId(id, 'agent'))
      // Someone else's agent gets the same answer as a missing one.
      if (!agent || agent.ownerUserId !== u.userId || agent.revokedAt) throw new HttpError(404, 'no such agent')
      await store.revokeAgent(agent.id)
      return { ok: true }
    }]
  ]
}
