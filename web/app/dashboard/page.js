import { cookies } from 'next/headers'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import AppHeader from '@/components/AppHeader.js'
import FirstOrg from '@/components/FirstOrg.js'
import Avatars from '@/components/Avatars.js'
import SessionName from '@/components/SessionName.js'
import TimeZoneCookie from '@/components/TimeZoneCookie.js'
import InvitesWaiting from '@/components/InvitesWaiting.js'
import { requireUser } from '@/lib/session.js'
import { createClient } from '@/lib/supabase/server.js'
import { apiCall } from '@/lib/api.js'
import { myOrgs } from '@/lib/org.js'
import { SPACE_COOKIE, spaceHome } from '@/lib/space.js'
import { safeMessage } from '@/lib/org-view.js'
import { countLabel } from '@/lib/dashboard-view.js'
import { TZ_COOKIE, tzFrom, formatDuration, timeAgo, EMPTY_SESSIONS } from '@/lib/activity-view.js'
import { askToJoin, renameSession } from './actions.js'

export const metadata = { title: 'Dashboard' }

export default async function Dashboard ({ searchParams }) {
  const q = await searchParams
  const user = await requireUser('/dashboard')
  const orgs = await myOrgs(user.accessToken)
  // Come back to the space the person chose last, if they're still in it.
  const jar = await cookies()
  const home = spaceHome(jar.get(SPACE_COOKIE)?.value, orgs)
  if (home !== '/dashboard') redirect(home)
  // Times are in the visitor's time zone, which their browser puts in a cookie (TimeZoneCookie).
  const rawTz = jar.get(TZ_COOKIE)?.value || ''
  const tz = tzFrom(rawTz)
  const supabase = await createClient()
  // The overview: counts that link to the Computers and Agents pages, plus anything to act on.
  // Independent calls, so they run together rather than one after another.
  const [{ count: computers }, agentsRes, discover, { data: profile }, activity] = await Promise.all([
    supabase.from('devices').select('id', { count: 'exact', head: true }).is('revoked_at', null),
    apiCall(user, 'GET', '/v1/agents'),
    // Orgs on the person's own (confirmed, non-public) email domain that take join requests.
    apiCall(user, 'GET', '/v1/orgs/discover'),
    // Only an org account ever gets a FirstOrg card, even if a personal account somehow has stray org_name metadata.
    supabase.from('profiles').select('kind').eq('id', user.id).maybeSingle(),
    // Your sessions, your time in them and who you worked with (the relay reports who was where).
    apiCall(user, 'GET', `/v1/me/sessions?tz=${encodeURIComponent(tz)}`)
  ])
  // The API lists only agents that aren't revoked.
  const agents = agentsRes.ok ? (agentsRes.data?.agents || []).length : null
  const joinable = discover.data?.orgs || []
  const totals = activity.data?.totals || { collaboratingThisWeek: 0, topCollaborators: [] }
  const sessions = activity.data?.sessions || []
  const now = Date.now()
  return (
    <>
      <AppHeader user={user} space='personal' />
      <main className='wrap page stack'>
        <h1 style={{ fontSize: 32 }}>Dashboard</h1>
        {q.password && <p className='notice'>Password updated.</p>}
        {q.left && <p className='notice'>You left the org.</p>}
        {q.orgDeleted && <p className='notice'>The org was deleted.</p>}
        {!orgs.length && user.orgName && profile?.kind === 'org' && <FirstOrg name={user.orgName} />}
        {q.asked && <p className='notice'>Asked. Someone at the org will let you in.</p>}
        {q.error && <p className='notice bad'>{safeMessage(q.error)}</p>}
        {q.message && <p className='notice'>{safeMessage(q.message)}</p>}
        <InvitesWaiting user={user} back='/dashboard' />
        {joinable.length > 0 && (
          <section className='card stack'>
            <h2>Orgs at {discover.data.domain}</h2>
            {joinable.map((o) => (
              <div key={o.slug} className='list-row'>
                <b>{o.name}</b>
                {o.requested
                  ? <span className='pill'>Requested</span>
                  : <form action={askToJoin}><input type='hidden' name='slug' value={o.slug} /><button className='btn'>Ask to join</button></form>}
              </div>))}
          </section>)}
        <TimeZoneCookie current={rawTz} />
        {!activity.ok && <p className='notice bad'>Could not load your sessions right now.</p>}
        {activity.ok && (
          <section className='card summary-grid'>
            <div className='stack' style={{ gap: 4 }}>
              <span className='muted'>Time collaborating this week</span>
              <b className='big-number'>{formatDuration(totals.collaboratingThisWeek)}</b>
            </div>
            <div className='stack' style={{ gap: 8 }}>
              <span className='muted'>Worked with most this month</span>
              {totals.topCollaborators.length
                ? (
                  <div className='row'>
                    {totals.topCollaborators.map((c) => (
                      <span key={c.account} className='row' style={{ gap: 8 }}>
                        <Avatars people={[c]} max={1} />
                        <span><b>{c.name}</b>{c.kind === 'agent' && <> <span className='pill'>Agent</span></>}<br /><span className='muted'>{formatDuration(c.ms)}</span></span>
                      </span>))}
                  </div>)
                : <span className='muted'>Nobody yet this month.</span>}
            </div>
          </section>)}
        {activity.ok && (
          <section className='card stack'>
            <h2>Your sessions</h2>
            {!sessions.length && <p className='muted'>{EMPTY_SESSIONS}</p>}
            <div>
              {sessions.map((s) => (
                <div key={s.room} className='list-row'>
                  <span className='stack' style={{ gap: 2 }}>
                    <SessionName room={s.room} name={s.name} canRename={s.mine} action={renameSession} href={`/dashboard/sessions/${s.room}`} />
                    <span className='muted'>Active {timeAgo(s.lastActiveAt, now, tz)} · {formatDuration(s.myTotalMs)} for you</span>
                  </span>
                  <Avatars people={s.people} />
                </div>))}
            </div>
          </section>)}
        <div className='overview-grid'>
          <section className='card stack'>
            <h2>Computers</h2>
            <p className='muted'>{countLabel(computers, 'computer linked', 'computers linked', 'No computers linked yet.')}</p>
            <div><Link className='btn' href='/dashboard/computers'>Manage computers</Link></div>
          </section>
          <section className='card stack'>
            <h2>Agents</h2>
            <p className='muted'>{countLabel(agents, 'agent', 'agents', 'No agents yet.')}</p>
            <div><Link className='btn' href='/dashboard/agents'>Manage agents</Link></div>
          </section>
        </div>
      </main>
    </>
  )
}
