import { cookies } from 'next/headers'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import AppHeader from '@/components/AppHeader.js'
import Avatars from '@/components/Avatars.js'
import SessionName from '@/components/SessionName.js'
import TimeZoneCookie from '@/components/TimeZoneCookie.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { TZ_COOKIE, tzFrom, isRoom, formatDuration, timeAgo, formatDate, visitLine, ownerLine } from '@/lib/activity-view.js'
import { renameSession } from '../../actions.js'

export const metadata = { title: 'Session' }

// One session you were in: who owns it, your time, who was there with you, and your visits.
export default async function SessionPage ({ params }) {
  const { room } = await params
  if (!isRoom(room)) notFound()
  const user = await requireUser(`/dashboard/sessions/${room}`)
  const rawTz = (await cookies()).get(TZ_COOKIE)?.value || ''
  const tz = tzFrom(rawTz)
  const res = await apiCall(user, 'GET', `/v1/me/sessions/${room}`)
  if (res.status === 404) notFound()
  const s = res.ok ? res.data?.session : null
  const now = Date.now()
  return (
    <>
      <AppHeader user={user} space='personal' />
      <main className='wrap page stack'>
        <TimeZoneCookie current={rawTz} />
        <p><Link href='/dashboard'>Back to your dashboard</Link></p>
        {!s
          ? <p className='notice bad'>Could not load this session right now.</p>
          : (
            <>
              <h1 style={{ fontSize: 32 }}><SessionName room={s.room} name={s.name} canRename={s.mine} action={renameSession} /></h1>
              <section className='card stack'>
                <div className='row' style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                  <p className='muted'>{ownerLine(s)}</p>
                  {s.mine && <Link className='btn' href={`/dashboard/sessions/${s.room}/audit`}>Audit trail</Link>}
                </div>
                <div className='summary-grid'>
                  <div><span className='muted'>Started</span><br /><b>{formatDate(s.createdAt, tz)}</b></div>
                  <div><span className='muted'>Last active</span><br /><b>{timeAgo(s.lastActiveAt, now, tz)}</b></div>
                  <div><span className='muted'>Your time</span><br /><b>{formatDuration(s.myTotalMs)}</b></div>
                </div>
              </section>
              <section className='card stack'>
                <h2>People and agents</h2>
                {!s.people.length && <p className='muted'>Nobody else was here while you were.</p>}
                {s.people.map((p) => (
                  <div key={p.account} className='list-row'>
                    <span className='row' style={{ gap: 10 }}>
                      <Avatars people={[p]} max={1} />
                      <span><b>{p.name}</b>{p.kind === 'agent' && <> <span className='pill'>Agent</span></>}</span>
                    </span>
                    <span className='muted'>{formatDuration(p.togetherMs)} together · last together {timeAgo(p.lastTogetherAt, now, tz)}</span>
                  </div>))}
              </section>
              <section className='card stack'>
                <h2>Your recent visits</h2>
                {s.visits.map((v, i) => {
                  const line = visitLine(v, tz)
                  return (
                    <div key={`${v.startedAt}-${i}`} className='list-row'>
                      <b>{line.date}</b>
                      <span className='muted'>{line.from} to {line.to}</span>
                    </div>
                  )
                })}
              </section>
            </>)}
      </main>
    </>
  )
}
