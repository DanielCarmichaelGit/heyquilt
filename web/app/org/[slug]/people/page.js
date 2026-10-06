import { notFound } from 'next/navigation'
import Notice from '@/components/Notice.js'
import AgentInvite from '@/components/AgentInvite.js'
import AgentInviteList from '@/components/AgentInviteList.js'
import AgentPlacement from '@/components/AgentPlacement.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { orgMe } from '@/lib/org.js'
import { allowed, assignableRoles } from '@/lib/org-view.js'
import { HOSTED_NOTE } from '@/lib/agent-view.js'
import { workspacesOn } from '@/lib/workspaces.js'
import { orgWorkspaces } from '@/lib/agent-placement.js'
import { setRole, removeMember, setAgentTeam, createOrgAgentInvite, cancelOrgAgentInvite, orgAgentInviteWaiting, saveOrgAgentPlacement } from './actions.js'
import { leaveOrg } from '../actions.js'

export const metadata = { title: 'People' }

function Hidden ({ slug, id, memberId }) {
  return (
    <>
      <input type='hidden' name='slug' value={slug} />
      <input type='hidden' name='id' value={id} />
      {memberId && <input type='hidden' name='memberId' value={memberId} />}
    </>
  )
}

function RoleForm ({ slug, m, roles, allowNone }) {
  return (
    <form action={setRole} className='row'>
      <Hidden slug={slug} id={m.id} />
      <select className='input' name='roleId' defaultValue={m.roleId || ''} aria-label={`Role for ${m.name || m.email}`}>
        {allowNone && <option value=''>No role</option>}
        {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      <button className='btn ghost'>Save</button>
    </form>
  )
}

// An agent's teams: access and folders, editable with Team membership: Update.
function AgentTeams ({ slug, m, canEdit }) {
  if (!m.teams.length) return <span className='muted'>Not in any teams you can see.</span>
  return m.teams.map((t) => canEdit
    ? (
      <form key={t.id} action={setAgentTeam} className='row'>
        <Hidden slug={slug} id={t.id} memberId={m.id} />
        <b>{t.name}</b>
        <select className='input' name='access' defaultValue={t.access} aria-label={`Access to ${t.name}`}>
          <option value='viewer'>Viewer</option>
          <option value='editor'>Editor</option>
        </select>
        <input className='input' name='folders' defaultValue={(t.scopes || []).join(', ')} placeholder='All folders' aria-label={`Folders in ${t.name}`} />
        <button className='btn ghost'>Save</button>
      </form>)
    : <span key={t.id} className='muted'>{t.name}: {t.access}{t.scopes?.length ? `, folders ${t.scopes.join(', ')}` : ''}</span>)
}

export default async function People ({ params, searchParams }) {
  const { slug } = await params
  const q = await searchParams
  const user = await requireUser(`/org/${slug}/people`)
  const me = await orgMe(user.accessToken, slug)
  if (!allowed(me, 'members', 'r') && !allowed(me, 'agents', 'r')) notFound()
  // Changing a person's role is Members: Update together with Roles: Update;
  // an agent's is Agents: Update. Removing an agent revokes it (Agents: Delete).
  const canAssign = allowed(me, 'members', 'u') && allowed(me, 'roles', 'u')
  const canRemove = allowed(me, 'members', 'd')
  const canSetAgentRole = allowed(me, 'agents', 'u')
  const canRevoke = allowed(me, 'agents', 'd')
  const canEditTeams = allowed(me, 'team_members', 'u')
  const canInvite = allowed(me, 'agents', 'c')
  const [membersRes, rolesRes, teamsRes, invitesRes] = await Promise.all([
    apiCall(user, 'GET', `/v1/orgs/${slug}/members`),
    canAssign || canSetAgentRole || canInvite ? apiCall(user, 'GET', `/v1/orgs/${slug}/roles`) : null,
    canInvite && allowed(me, 'team_members', 'c') ? apiCall(user, 'GET', `/v1/orgs/${slug}/teams`) : null,
    canInvite ? apiCall(user, 'GET', `/v1/orgs/${slug}/agent-invites`) : null
  ])
  const members = membersRes.data?.members || []
  // With workspaces on, Agents: Update and Workspaces: Update (placing an agent puts it in the
  // org's workspaces), each agent's Available in and Joins, among the org's workspaces.
  const placing = canSetAgentRole && allowed(me, 'workspaces', 'u') && await workspacesOn(user.accessToken)
  const [orgAgentsRes, workspacesRes] = placing
    ? await Promise.all([apiCall(user, 'GET', `/v1/orgs/${slug}/agents`), apiCall(user, 'GET', '/v1/me/workspaces')])
    : [null, null]
  const placements = new Map((orgAgentsRes?.data?.agents || []).map((a) => [a.id, a.placement]))
  const workspaces = orgWorkspaces(workspacesRes?.data?.workspaces, slug)
  const roles = assignableRoles(rolesRes?.data?.roles, me)
  const pick = (list) => list.map(({ id, name }) => ({ id, name }))
  const canPick = (m) => roles.length > 0 && (!m.roleId || roles.some((r) => r.id === m.roleId))
  return (
    <div className='stack'>
      <section className='card stack'>
        <h2>People and agents</h2>
        <Notice q={q} />
        {!membersRes.ok && <p className='notice bad'>Couldn't load the member list right now.</p>}
        <div>
          {members.map((m) => m.kind === 'agent'
            ? (
              <div key={m.id} className='list-row'>
                <span className='stack' style={{ gap: 6 }}>
                  <span>
                    <b>{m.name}</b> <span className='pill'>Agent</span> {m.hosted && <span className='pill'>Hosted</span>} <span className='muted'>{m.provider} · {m.type}</span>
                  </span>
                  {m.hosted && <span className='muted'>{HOSTED_NOTE}</span>}
                  <AgentTeams slug={slug} m={m} canEdit={canEditTeams} />
                </span>
                <span className='row'>
                  {canSetAgentRole && canPick(m)
                    ? <RoleForm slug={slug} m={m} roles={roles} allowNone />
                    : <span className='pill'>{m.role || 'No role'}</span>}
                  {canRevoke && (
                    <form action={removeMember}>
                      <Hidden slug={slug} id={m.id} />
                      <button className='btn ghost danger'>Revoke</button>
                    </form>)}
                </span>
                {/* Under the row, full width (the row wraps). */}
                {placing && placements.has(m.agentId) && <div style={{ flexBasis: '100%' }}><AgentPlacement agent={{ id: m.agentId, name: m.name, placement: placements.get(m.agentId) }} workspaces={workspaces} action={saveOrgAgentPlacement} slug={slug} allLabel={`All ${me.org.name} workspaces`} /></div>}
              </div>)
            : (
              <div key={m.id} className='list-row'>
                <span>
                  <b>{m.name || m.email}</b> {m.isYou && <span className='pill'>You</span>} {m.isOwner && <span className='pill'>Owner</span>}
                  <br />
                  <span className='muted'>{m.email}{m.teams.length ? ` · ${m.teams.map((t) => t.name).join(', ')}` : ''}</span>
                </span>
                <span className='row'>
                  {canAssign && !m.isOwner && !m.isYou && m.roleId && roles.some((r) => r.id === m.roleId)
                    ? <RoleForm slug={slug} m={m} roles={roles} />
                    : <span className='pill'>{m.role || 'No role'}</span>}
                  {m.isYou && !m.isOwner && (
                    <form action={leaveOrg}><input type='hidden' name='slug' value={slug} /><button className='btn ghost danger'>Leave</button></form>)}
                  {canRemove && !m.isYou && !m.isOwner && (
                    <form action={removeMember}>
                      <Hidden slug={slug} id={m.id} />
                      <button className='btn ghost danger'>Remove</button>
                    </form>)}
                </span>
              </div>))}
        </div>
      </section>
      {canInvite && (
        <section className='card stack'>
          <h2>Invite an agent</h2>
          <p className='muted'>Choose what the agent gets, then paste the one-time link into your AI. It joins {me.org.name} as an agent with its own keys.</p>
          <AgentInvite action={createOrgAgentInvite} waiting={orgAgentInviteWaiting} slug={slug} roles={pick(roles)} teams={pick(teamsRes?.data?.teams || [])} />
          <AgentInviteList invites={(invitesRes?.data?.invites || []).slice(0, 10)} cancel={cancelOrgAgentInvite} slug={slug} />
        </section>)}
    </div>
  )
}
