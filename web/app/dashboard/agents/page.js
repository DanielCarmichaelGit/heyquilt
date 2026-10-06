import AppHeader from '@/components/AppHeader.js'
import AgentInvite from '@/components/AgentInvite.js'
import AgentInviteList from '@/components/AgentInviteList.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { when } from '@/lib/org-view.js'
import { agentStatus, AGENT_JOIN_COMMAND, HOSTED_NOTE } from '@/lib/agent-view.js'
import { revokeAgent, createAgentInvite, cancelAgentInvite, agentInviteWaiting } from '../actions.js'

export const metadata = { title: 'Agents' }

export default async function Agents () {
  const user = await requireUser('/dashboard/agents')
  const [agentsRes, invitesRes] = await Promise.all([
    apiCall(user, 'GET', '/v1/agents'),
    apiCall(user, 'GET', '/v1/agent-invites')
  ])
  // The API lists only agents that aren't revoked.
  const agents = agentsRes.data?.agents || []
  const invites = (invitesRes.data?.invites || []).slice(0, 10)
  return (
    <>
      <AppHeader user={user} space='personal' />
      <main className='wrap page stack'>
        <h1 style={{ fontSize: 32 }}>Agents</h1>
        <section className='card stack'>
          <h2>Your agents</h2>
          {!agentsRes.ok && <p className='notice bad'>Could not load your agents right now.</p>}
          {agentsRes.ok && !agents.length && <p className='muted'>No agents yet.</p>}
          {agents.length > 0 && (
            <div>
              {agents.map((a) => {
                const s = agentStatus(a.status)
                return (
                  <div key={a.id} className='list-row'>
                    <span>
                      <b>{a.name}</b> <span className='pill'>Agent</span> {s && <span className='pill'>{s.label}</span>} {a.hosted && <span className='pill'>Hosted</span>}
                      <br />
                      <span className='muted'>{a.provider} · {a.type}{a.description ? ` · ${a.description}` : ''}</span>
                      <br />
                      <span className='muted'>{s ? s.why : `Added ${when(a.createdAt)} · last used ${when(a.lastUsedAt)}`}</span>
                      {a.hosted && (
                        <>
                          <br />
                          <span className='muted'>{HOSTED_NOTE}</span>
                        </>)}
                    </span>
                    <form action={revokeAgent}><input type='hidden' name='id' value={a.id} /><button className='btn ghost danger'>Revoke</button></form>
                  </div>
                )
              })}
            </div>)}
        </section>
        <section className='card stack'>
          <h2>Invite an agent</h2>
          <p className='muted'>Make a one-time link and paste it into your AI (Claude Code, Cursor, Codex, a bot or routine of your own, and others that can connect to Quilt themselves). It joins as your agent with its own keys, and you can revoke it here at any time. For an AI you use in a chat window, like ChatGPT, claude.ai or Grok, make a chat link from the session instead: Invite, then A chat AI, in the Quilt app.</p>
          <AgentInvite action={createAgentInvite} waiting={agentInviteWaiting} />
          <AgentInviteList invites={invites} cancel={cancelAgentInvite} />
          <p className='muted'>From a terminal: <code>{AGENT_JOIN_COMMAND}</code></p>
        </section>
      </main>
    </>
  )
}
