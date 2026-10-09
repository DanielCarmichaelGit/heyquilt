import { apiCall } from '@/lib/api.js'
import { acceptInvite, declineInvite } from '@/app/dashboard/actions.js'

// Invites waiting for you: workspaces to accept or decline, and sessions to open in the Quilt
// app with the link their owner sent. Nothing at all when there are none (or the API is down).
export default async function InvitesWaiting ({ user, back = '/dashboard' }) {
  const r = await apiCall(user, 'GET', '/v1/me/invites')
  const invites = r.ok ? (r.data?.invites || []) : []
  if (!invites.length) return null
  const hidden = (id) => (<><input type='hidden' name='id' value={id} /><input type='hidden' name='back' value={back} /></>)
  return (
    <section className='card stack'>
      <h2>Invites for you</h2>
      <div>
        {invites.map((i) => (
          <div key={i.id} className='list-row'>
            {i.kind === 'workspace'
              ? (
                <span className='stack' style={{ gap: 2 }}>
                  <span><b>{i.from?.name || 'Someone'}</b> invited you to the <b>{i.workspace.name}</b> workspace{i.workspace.org ? ` in ${i.workspace.org}` : ''}</span>
                  <span className='muted'>{i.access === 'view' ? 'View only' : 'Can edit'}</span>
                </span>)
              : (
                <span className='stack' style={{ gap: 2 }}>
                  <span><b>{i.from?.name || 'Someone'}</b> invited you to the session <b>{i.session.name}</b></span>
                  <span className='muted'>{i.access}{i.link ? ' · opens in the Quilt app' : ' · open the link in the email they sent'}</span>
                </span>)}
            <span className='row' style={{ gap: 8 }}>
              <form action={declineInvite}>{hidden(i.id)}<button className='btn ghost'>Decline</button></form>
              {i.kind === 'workspace'
                ? <form action={acceptInvite}>{hidden(i.id)}<button className='btn primary'>Accept</button></form>
                : i.link && <a className='btn primary' href={i.link}>Join</a>}
            </span>
          </div>))}
      </div>
    </section>
  )
}
