// An AI opening an agent invite link. A GET without a name only explains, so
// link previews and scanners never use the invite up; a POST, or a GET with
// name, provider and type, uses it once and hands back the agent's first keys.
import { HttpError, Raw, cleanName, stripInvisible } from '../http.js'
import { hashToken } from '../tokens.js'
import { parsePublicKey } from '../../identity.js'
import { joinInstructions, joinNext } from '../join-text.js'
import { inviteStatus } from './agent-invites.js'

const MAX_DESCRIPTION = 180
const GONE = {
  used: 'this invite was already used; ask for a new one',
  expired: 'this invite has expired; ask for a new one',
  cancelled: 'this invite was cancelled; ask for a new one'
}

export function joinRoutes ({ store, now, apiUrl, limitJoin, agentAuth, log = () => {} }) {
  const inviteFor = async (token) => (String(token).startsWith('qj_') ? store.agentInviteByToken(hashToken(token)) : null)
  const statusOf = (invite) => (invite ? inviteStatus(invite, now()) : 'unknown')

  // Required as an actual string, never a stray number or object a loose client sent,
  // and never the literal <placeholder> text from the join instructions.
  function field (value, name, fallback) {
    if (value === undefined && fallback !== undefined) value = fallback
    if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string`)
    if (value.includes('<') || value.includes('>')) throw new HttpError(400, `${name} can't contain < or >`)
    return value
  }

  // The agent's profile, checked in full before the invite is touched.
  function profile (src) {
    const publicKey = src.publicKey == null || src.publicKey === '' ? null : String(src.publicKey)
    if (publicKey && !parsePublicKey(publicKey)) throw new HttpError(400, 'publicKey must be an Ed25519 key (spki, base64url)')
    return {
      name: cleanName(field(src.name, 'name'), 40, 'give your name (up to 40 characters)'),
      provider: cleanName(field(src.provider, 'provider'), 40, 'give your provider, e.g. Anthropic, OpenAI or Cursor'),
      type: cleanName(field(src.type, 'type'), 40, 'give your type, e.g. coding agent'),
      description: stripInvisible(field(src.description, 'description', '')).slice(0, MAX_DESCRIPTION).join('').trim(),
      publicKey
    }
  }

  async function join (token, src) {
    const invite = await inviteFor(token)
    const status = statusOf(invite)
    if (status === 'unknown') throw new HttpError(404, "this invite link isn't valid")
    if (status !== 'waiting') throw new HttpError(410, GONE[status])
    // Everything the agent sent is checked first, so a typo never burns the invite.
    const p = profile(src)
    if (p.publicKey && await store.agentByPublicKey(p.publicKey)) throw new HttpError(409, 'that publicKey already belongs to an agent')
    // Claim first, so two joins racing on one link can't both make an agent.
    if (!await store.claimAgentInvite(invite.id)) throw new HttpError(410, GONE.used)
    let agent
    try {
      agent = await store.createAgent({ ...p, ownerUserId: invite.ownerUserId, orgId: invite.orgId, invitedBy: invite.createdBy })
      if (invite.orgId) {
        const m = await store.addAgentMember({ orgId: invite.orgId, agentId: agent.id, roleId: invite.roleId })
        for (const x of invite.teams) {
          // A team deleted since the invite was made is skipped.
          if (await store.teamById(invite.orgId, x.teamId)) await store.addTeamMember({ teamId: x.teamId, memberId: m.id, access: x.access, scopes: x.scopes })
        }
      }
      // A workspace's invite (workspace-agents.js) makes the agent one of its members.
      if (invite.workspaceId) {
        await store.putWorkspaceMember({ workspaceId: invite.workspaceId, account: `agent:${agent.id}`, access: invite.workspaceAccess || 'edit', sessions: invite.workspaceSessions || 'invited', addedBy: invite.createdBy })
      }
      await store.setInviteAgent(invite.id, agent.id)
      const keys = await agentAuth.mintKeys(agent.id)
      return { ...keys, api: apiUrl, refresh: `${apiUrl}/v1/agents/token`, mcp: `${apiUrl}/mcp`, next: joinNext({ name: agent.name, apiUrl, hasKey: !!agent.publicKey }) }
    } catch (err) {
      // Undo the half-made agent and reopen the link, so the AI can simply try again.
      // But if the agent couldn't be deleted, it may still be half-wired into the org
      // (team membership, etc): leave the invite used rather than hand out a link that
      // would make a second, equally broken agent on top of the first.
      let deleted = !agent
      // Member rows name the agent as text, so deleting it leaves them: remove this one first.
      if (agent && invite.workspaceId) await store.removeWorkspaceMember(invite.workspaceId, `agent:${agent.id}`).catch(() => {})
      if (agent) {
        try { await store.deleteAgent(agent.id); deleted = true } catch (delErr) {
          log(`join rollback: couldn't delete half-made agent ${agent.id}: ${delErr?.stack || delErr?.message || delErr}`)
        }
      }
      if (deleted) await store.releaseAgentInvite(invite.id).catch(() => {})
      throw err
    }
  }

  return [
    ['POST', /^\/v1\/join\/([^/]+)$/, async (req, body, [token]) => {
      limitJoin(req)
      return join(token, body)
    }],

    ['GET', /^\/v1\/join\/([^/]+)$/, async (req, body, [token]) => {
      limitJoin(req)
      const q = new URL(req.url, 'http://x').searchParams
      // Only a GET that names the agent uses the invite.
      if (['name', 'provider', 'type'].some((k) => q.has(k))) return join(token, Object.fromEntries(q))
      const invite = await inviteFor(token)
      const status = statusOf(invite)
      const text = joinInstructions({ link: `${apiUrl}/v1/join/${encodeURIComponent(token)}`, apiUrl, status, expiresAt: invite?.expiresAt })
      return new Raw(status === 'waiting' ? 200 : status === 'unknown' ? 404 : 410, text)
    }]
  ]
}
