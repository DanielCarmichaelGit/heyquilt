import { cookies } from 'next/headers'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import AppHeader from '@/components/AppHeader.js'
import Avatars from '@/components/Avatars.js'
import TimeZoneCookie from '@/components/TimeZoneCookie.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { TZ_COOKIE, tzFrom, isRoom, sessionTitle } from '@/lib/activity-view.js'
import { reasonText, howText, actionLine, spanText, filterVisits } from '@/lib/audit-view.js'

export const metadata = { title: 'Audit trail' }

const FILTERS = [['all', 'Everyone'], ['agent', 'Agents'], ['person', 'People']]

// A session's audit trail, for its owner: who came in and how, when they left and why,
// and what they did in between.
export default async function AuditPage ({ params, searchParams }) {
  const { room } = await params
  if (!isRoom(room)) notFound()
  const who = (await searchParams)?.who || 'all'
  const user = await requireUser(`/dashboard/sessions/${room}/audit`)
  const rawTz = (await cookies()).get(TZ_COOKIE)?.value || ''
  const tz = tzFrom(rawTz)
  const res = await apiCall(user, 'GET', `/v1/me/sessions/${room}/audit`)
  if (res.status === 404) notFound()
  const forbidden = res.status === 403
  const trail = res.ok ? res.data : null
  const visits = trail ? filterVisits(trail.visits, who) : []
  return (
    <>
      <AppHeader user={user} space='personal' />
      <main className='wrap page stack'>
        <TimeZoneCookie current={rawTz} />
        <p><Link href={`/dashboard/sessions/${room}`}>Back to the session</Link></p>
        {forbidden && <p className='notice bad'>Only the session owner can see its audit trail.</p>}
        {!forbidden && !trail && <p className='notice bad'>Could not load the audit trail right now.</p>}
        {trail && (
          <>
            <div className='row' style={{ justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 12 }}>
              <h1 style={{ fontSize: 32 }}>Audit trail: {sessionTitle(trail.session.name)}</h1>
              <a className='btn' href={`/dashboard/sessions/${room}/audit/csv`} download>Download CSV</a>
            </div>
            <p className='muted'>Every person and agent that joined this session: how they connected, when they left and why, and what they did in between. Files are listed by path; contents and messages are never recorded. Times are in {tz}.</p>
            <nav className='row' style={{ gap: 8 }} aria-label='Show'>
              {FILTERS.map(([k, label]) => (
                <Link key={k} href={k === 'all' ? `/dashboard/sessions/${room}/audit` : `/dashboard/sessions/${room}/audit?who=${k}`} className={`pill${who === k ? ' active' : ''}`} aria-current={who === k ? 'page' : undefined}>{label}</Link>
              ))}
            </nav>
            {trail.truncated && <p className='notice'>This session has more actions than fit on one page. The CSV has the same limit; ask us for a full export.</p>}
            {!visits.length && <p className='muted'>Nothing recorded yet.</p>}
            {visits.map((v, i) => (
              <section key={`${v.account}-${v.startedAt}-${i}`} className='card stack'>
                <div className='list-row'>
                  <span className='row' style={{ gap: 10 }}>
                    <Avatars people={[{ account: v.account, name: v.name, kind: v.kind }]} max={1} />
                    <span><b>{v.name}</b>{v.kind === 'agent' && <> <span className='pill'>Agent</span></>}<br /><span className='muted'>{howText(v)}</span></span>
                  </span>
                  <span className='audit-when'>
                    <b>{reasonText(v)}</b><br />
                    <span className='muted'>{spanText(v, tz)}</span>
                  </span>
                </div>
                {v.actions.length > 0
                  ? (
                    <details>
                      <summary>{v.actions.length} {v.actions.length === 1 ? 'action' : 'actions'}</summary>
                      <ul className='audit-actions'>
                        {v.actions.map((a, j) => {
                          const line = actionLine(a, tz)
                          return <li key={j}><span className='muted'>{line.time}</span> {line.what} {line.target && <code>{line.target}</code>}</li>
                        })}
                      </ul>
                    </details>)
                  : <p className='muted'>No actions recorded.</p>}
              </section>
            ))}
          </>)}
      </main>
    </>
  )
}
