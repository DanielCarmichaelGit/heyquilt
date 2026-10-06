import { notFound } from 'next/navigation'
import Notice from '@/components/Notice.js'
import ConfirmDelete from '@/components/ConfirmDelete.js'
import WorkspaceFiles from '@/components/WorkspaceFiles.js'
import WorkspaceAgents from '@/components/WorkspaceAgents.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { orgMe } from '@/lib/org.js'
import { when } from '@/lib/org-view.js'
import { timeAgo } from '@/lib/activity-view.js'
import { peopleOnly } from '@/lib/agent-placement.js'
import { updateWorkspace, deleteWorkspace, setMember, removeMember, setAgentJoins, keepAgentOut, letAgentBackIn } from '../actions.js'

export const metadata = { title: 'Workspace' }

const COLORS = ['lilac', 'mint', 'peach', 'rose', 'periwinkle', 'sky']

/** Org members not already a workspace member, for the "Add" list. */
function addable (members, orgMembers) {
  const existing = new Set((members || []).map((m) => m.account))
  const out = []
  for (const m of (orgMembers || [])) {
    const account = `${m.kind === 'agent' ? 'agent' : 'person'}:${m.kind === 'agent' ? m.agentId : m.userId}`
    if (!existing.has(account)) out.push({ account, name: m.name, kind: m.kind })
  }
  return out
}

export default async function WorkspacePage ({ params, searchParams }) {
  const { slug, id } = await params
  const q = await searchParams
  const user = await requireUser(`/org/${slug}/workspaces/${id}`)
  const { org } = await orgMe(user.accessToken, slug)
  const r = await apiCall(user, 'GET', `/v1/workspaces/${encodeURIComponent(id)}`)
  if (r.status === 404) notFound()
  const w = r.data?.workspace
  if (!w) return <p className='notice bad'>Could not load this workspace right now.</p>
  // Another org's workspace (or a personal one) is not on this org's pages.
  if (w.orgId !== org.id) notFound()
  const { access = {}, canDelete = false, owner = {}, members: all = [], agents = [], sessions = [], files = [], usage } = r.data
  // Agents get their own rows, with why they are here; a member agent missing from `agents`
  // (revoked, or gone from the org) stays under Members so it can be removed.
  const members = peopleOnly(all, agents)
  const membersRes = access.admin ? await apiCall(user, 'GET', `/v1/orgs/${slug}/members`) : null
  const toAdd = access.admin ? addable([...all, ...agents], membersRes?.data?.members) : []
  const now = Date.now()
  return (
    <div className='stack'>
      <h2 style={{ fontSize: 24 }}>{w.name}</h2>
      <Notice q={q} />
      <p className='muted'>
        {w.description || ''}
        {w.description ? ' · ' : ''}
        {owner.account ? `Owned by ${owner.name}` : ''}
        {' · '}<span className='pill'>You: {access.access}</span>
        {w.archivedAt && <> · <span className='pill'>Archived</span></>}
      </p>
      {access.admin && (
        <section className='card stack'>
          <h2>Settings</h2>
          <form action={updateWorkspace} className='stack'>
            <input type='hidden' name='slug' value={slug} />
            <input type='hidden' name='id' value={w.id} />
            <input className='input' name='name' defaultValue={w.name} maxLength={80} required aria-label='Workspace name' />
            <input className='input' name='description' defaultValue={w.description || ''} maxLength={500} aria-label='Description' />
            <select className='input' name='color' defaultValue={w.color || 'lilac'} aria-label='Colour'>
              {COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <input type='hidden' name='was_archived' value={w.archivedAt ? 'on' : ''} />
            <label className='row'><input type='checkbox' name='archived' defaultChecked={!!w.archivedAt} /> Archived</label>
            <div className='row'>
              <button className='btn primary'>Save</button>
              {canDelete && <ConfirmDelete action={deleteWorkspace} what='this workspace' note='Its sessions are kept, unassigned.' />}
            </div>
          </form>
        </section>)}
      <section className='card stack'>
        <h2>Members</h2>
        {!members.length && <p className='muted'>No members yet.</p>}
        {members.map((m) => (
          <div key={m.account} className='list-row'>
            <span><b>{m.name}</b> {m.kind === 'agent' && <span className='pill'>Agent</span>}</span>
            <span className='row'>
              {access.admin
                ? (
                  <form action={setMember} className='row'>
                    <input type='hidden' name='slug' value={slug} />
                    <input type='hidden' name='id' value={w.id} />
                    <input type='hidden' name='account' value={m.account} />
                    <select className='input' name='access' defaultValue={m.access} aria-label={`Access for ${m.name}`}>
                      <option value='edit'>Edit</option>
                      <option value='view'>View</option>
                    </select>
                    <button className='btn ghost'>Save</button>
                  </form>)
                : <span className='pill'>{m.access}</span>}
              {access.admin && (
                <form action={removeMember}>
                  <input type='hidden' name='slug' value={slug} />
                  <input type='hidden' name='id' value={w.id} />
                  <input type='hidden' name='account' value={m.account} />
                  <button className='btn ghost danger'>Remove</button>
                </form>)}
            </span>
          </div>))}
        {access.admin && toAdd.length > 0 && (
          <div className='stack'>
            <b>Add</b>
            {toAdd.map((p) => (
              <form key={p.account} action={setMember} className='list-row'>
                <input type='hidden' name='slug' value={slug} />
                <input type='hidden' name='id' value={w.id} />
                <input type='hidden' name='account' value={p.account} />
                <input type='hidden' name='access' value='view' />
                <span><b>{p.name}</b> {p.kind === 'agent' && <span className='pill'>Agent</span>}</span>
                <button className='btn ghost'>Add</button>
              </form>))}
          </div>)}
      </section>
      <WorkspaceAgents agents={agents} admin={!!access.admin} orgName={owner.name} id={w.id} slug={slug} actions={{ setMember, removeMember, setAgentJoins, keepAgentOut, letAgentBackIn }} />
      <WorkspaceFiles files={files} usage={usage} downloadHref={(f) => `/api/workspaces/${encodeURIComponent(w.id)}/files/${encodeURIComponent(f.id)}`} />
      <section className='card stack'>
        <h2>Sessions</h2>
        {!sessions.length && <p className='muted'>No sessions yet.</p>}
        {sessions.map((s) => (
          <div key={s.room} className='list-row'>
            <b>{s.name || s.room}</b>
            <span className='muted'>{s.open && <span className='pill'>Open</span>} Active {timeAgo(s.lastActiveAt, now)}</span>
          </div>))}
      </section>
      <p className='muted'>Created {when(w.createdAt)}</p>
    </div>
  )
}
