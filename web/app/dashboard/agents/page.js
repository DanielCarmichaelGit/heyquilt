import AppHeader from '@/components/AppHeader.js'
import AgentInvite from '@/components/AgentInvite.js'
import AgentInviteList from '@/components/AgentInviteList.js'
import AppKeyForm from '@/components/AppKeyForm.js'
import AgentPlacement from '@/components/AgentPlacement.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { when } from '@/lib/org-view.js'
import { agentStatus, AGENT_JOIN_COMMAND, HOSTED_NOTE, APP_NOTE } from '@/lib/agent-view.js'
import { workspacesOn } from '@/lib/workspaces.js'
import { personalWorkspaces } from '@/lib/agent-placement.js'
import { revokeAgent, createAgentInvite, cancelAgentInvite, agentInviteWaiting, connectApp, newAppKey, revokeAppKey, saveAgentPlacement } from '../actions.js'

export const metadata = { title: 'Agents' }

export default async function Agents () {
  const user = await requireUser('/dashboard/agents')
  const [agentsRes, invitesRes] = await Promise.all([
    apiCall(user, 'GET', '/v1/agents'),
    apiCall(user, 'GET', '/v1/agent-invites')
  ])
  // The API lists only agents that aren't revoked.
  const agents = agentsRes.data?.agents || []
  // Each agent's app keys (never the keys themselves, just their names and use).
  const keysOf = Object.fromEntries(await Promise.all(agents.map(async (a) => {
    const r = await apiCall(user, 'GET', `/v1/agents/${a.id}/keys`)
    return [a.id, r.data?.keys || []]
  })))
  const invites = (invitesRes.data?.invites || []).slice(0, 10)
  // With workspaces on, each agent's Available in and Joins, among your own workspaces.
  const on = await workspacesOn(user.accessToken)
  const [placements, workspacesRes] = on
    ? await Promise.all([
      Promise.all(agents.map((a) => apiCall(user, 'GET', `/v1/me/agents/${encodeURIComponent(a.id)}/placement`))),
      apiCall(user, 'GET', '/v1/me/workspaces')
    ])
    : [[], null]
  const workspaces = personalWorkspaces(workspacesRes?.data?.workspaces)
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
              {agents.map((a, i) => {
                const s = agentStatus(a.status)
                const placement = placements[i]
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
                          <span className='muted'>{a.type === 'app' ? APP_NOTE : HOSTED_NOTE}</span>
                        </>)}
                      {keysOf[a.id].length > 0 && (
                        <>
                          <br />
                          <span className='muted'>App keys: </span>
                          {keysOf[a.id].map((k) => (
                            <form key={k.id} action={revokeAppKey} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginRight: 10 }}>
                              <input type='hidden' name='agentId' value={a.id} />
                              <input type='hidden' name='id' value={k.id} />
                              <span className='pill' title={`Made ${when(k.createdAt)} · last used ${when(k.lastUsedAt)}`}>{k.name}</span>
                              <button className='btn ghost danger' style={{ padding: '2px 8px' }} aria-label={`Revoke the ${k.name} key`}>Revoke</button>
                            </form>
                          ))}
                        </>)}
                      <details style={{ marginTop: 6 }}>
                        <summary className='muted' style={{ cursor: 'pointer' }}>New app key</summary>
                        <AppKeyForm action={newAppKey} agentId={a.id} label='Make key' placeholder='What it is for, e.g. Zapier' />
                      </details>
                    </span>
                    <form action={revokeAgent}><input type='hidden' name='id' value={a.id} /><button className='btn ghost danger'>Revoke</button></form>
                    {/* Under the row, full width (the row wraps). */}
                    {on && placement?.ok && <div style={{ flexBasis: '100%' }}><AgentPlacement agent={{ ...a, placement: placement.data.placement }} workspaces={workspaces} action={saveAgentPlacement} /></div>}
                  </div>
                )
              })}
            </div>)}
        </section>
        <section className='card stack'>
          <h2>Connect an app</h2>
          <p className='muted'>For an automation app that takes an API key (Pipedream, Zapier, Make, n8n, or a script of your own). Quilt adds an agent named for the app and gives you its key, shown once. Paste the key into the app; it acts in your sessions as that agent until you revoke it here.</p>
          <AppKeyForm action={connectApp} defaultName='Pipedream' />
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
