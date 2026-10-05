import { notFound } from 'next/navigation'
import AppHeader from '@/components/AppHeader.js'
import Notice from '@/components/Notice.js'
import ConfirmDelete from '@/components/ConfirmDelete.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { when } from '@/lib/org-view.js'
import { timeAgo } from '@/lib/activity-view.js'
import { updateWorkspace, deleteWorkspace, setMember, removeMember } from '../actions.js'

export const metadata = { title: 'Workspace' }

const COLORS = ['lilac', 'mint', 'peach', 'rose', 'periwinkle', 'sky']

/** Collaborators and agents not already a member, for the "Add" list. */
function addable (members, collaborators, agents) {
  const existing = new Set((members || []).map((m) => m.account))
  const out = new Map()
  for (const c of (collaborators || [])) if (!existing.has(c.account)) out.set(c.account, { account: c.account, name: c.name, kind: c.kind })
  for (const a of (agents || [])) {
    const account = `agent:${a.id}`
    if (!existing.has(account)) out.set(account, { account, name: a.name, kind: 'agent' })
  }
  return [...out.values()]
}

export default async function WorkspacePage ({ params, searchParams }) {
  const { id } = await params
  const q = await searchParams
  const user = await requireUser(`/dashboard/workspaces/${id}`)
  const r = await apiCall(user, 'GET', `/v1/workspaces/${encodeURIComponent(id)}`)
  if (r.status === 404) notFound()
  const w = r.data?.workspace
  if (!w) {
    return (
      <>
        <AppHeader user={user} space='personal' />
        <main className='wrap page stack'>
          <p className='notice bad'>Could not load this workspace right now.</p>
        </main>
      </>
    )
  }
  const { access = {}, canDelete = false, owner = {}, members = [], sessions = [] } = r.data
  const [collabsRes, agentsRes] = access.admin
    ? await Promise.all([apiCall(user, 'GET', '/v1/me/collaborators'), apiCall(user, 'GET', '/v1/agents')])
    : [null, null]
  const toAdd = access.admin ? addable(members, collabsRes?.data?.collaborators, agentsRes?.data?.agents) : []
  const now = Date.now()
  return (
    <>
      <AppHeader user={user} space='personal' />
      <main className='wrap page stack'>
        <h1 style={{ fontSize: 32 }}>{w.name}</h1>
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
                  <input type='hidden' name='id' value={w.id} />
                  <input type='hidden' name='account' value={p.account} />
                  <input type='hidden' name='access' value='view' />
                  <span><b>{p.name}</b> {p.kind === 'agent' && <span className='pill'>Agent</span>}</span>
                  <button className='btn ghost'>Add</button>
                </form>))}
            </div>)}
        </section>
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
      </main>
    </>
  )
}
