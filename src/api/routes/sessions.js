// Your sessions on the dashboard: where you've been, your time there, and who you
// worked with (activity.js does the sums). Only sessions you were in, and only people
// who were there at the same time as you.
import { HttpError, Raw } from '../http.js'
import { auditTrail, auditCsv, MAX_ACTIONS } from '../audit.js'
import { summarize, collaborators, myVisits, isTimeZone, weekStart, monthStart, MAX_SESSIONS } from '../activity.js'
import { cleanSessionName, BAD_SESSION_NAME } from '../../session-name.js'

const ROOM = /^[A-Za-z0-9_-]{1,64}$/
const NO_SESSION = 'no such session'

/** An account's dashboard: its sessions, with the people in each, and the totals. */
export async function overviewOf (store, account, tz, t) {
  // The latest sessions, plus every one active this week or month, for the totals.
  const since = Math.min(weekStart(t, tz), monthStart(t, tz))
  const sessions = await store.accountSessions(account, { since, limit: MAX_SESSIONS })
  const visits = await store.visitsInRooms(sessions.map((s) => s.room))
  return summarize({ me: account, sessions, visits, now: t, tz })
}

/** People and agents this account has worked with: [{ account, name, kind, lastTogetherAt }], most recent first. */
export async function collaboratorsOf (store, account, t) {
  return collaborators((await overviewOf(store, account, 'UTC', t)).sessions)
}

export function sessionRoutes ({ store, now, person }) {
  const me = async (req) => `person:${(await person(req)).userId}`
  const zoneOf = (req) => {
    const tz = new URL(req.url, 'http://x').searchParams.get('tz') || 'UTC'
    if (!isTimeZone(tz)) throw new HttpError(400, 'tz must be an IANA time zone, like Europe/London')
    return tz
  }
  const overview = (account, tz) => overviewOf(store, account, tz, now())

  /** A session I was in, with every visit to it; 404 otherwise, whether or not it exists. */
  async function mine (account, room) {
    if (!ROOM.test(room)) throw new HttpError(404, NO_SESSION)
    const session = await store.sessionByRoom(room)
    const visits = session ? await store.visitsInRooms([room]) : []
    if (!visits.some((v) => v.account === account)) throw new HttpError(404, NO_SESSION)
    return { session, visits }
  }

  return [
    ['GET', /^\/v1\/me\/sessions$/, async (req) => overview(await me(req), zoneOf(req))],

    ['GET', /^\/v1\/me\/sessions\/([^/]+)$/, async (req, body, [room]) => {
      const account = await me(req)
      const { session, visits } = await mine(account, room)
      const [s] = summarize({ me: account, sessions: [session], visits, now: now() }).sessions
      return { session: { ...s, visits: myVisits({ me: account, visits }) } }
    }],

    // The owner's rename shows for everyone, and the relay's name no longer replaces it.
    ['PUT', /^\/v1\/me\/sessions\/([^/]+)$/, async (req, body, [room]) => {
      const account = await me(req)
      const name = cleanSessionName(body.name)
      if (!name) throw new HttpError(400, BAD_SESSION_NAME)
      const { session } = await mine(account, room)
      if (session.ownerAccount !== account) throw new HttpError(403, 'Only the session owner can rename it.')
      const renamed = await store.renameSession(room, name, now())
      return { session: { room, name: renamed.name } }
    }],

    // The audit trail, for the owner only: every visit, how it came in, why it ended, and
    // what it did. ?format=csv for a spreadsheet; ?from= and ?to= (epoch ms) narrow it.
    ['GET', /^\/v1\/me\/sessions\/([^/]+)\/audit$/, async (req, body, [room]) => {
      const account = await me(req)
      const { session, visits } = await mine(account, room)
      if (session.ownerAccount !== account) throw new HttpError(403, 'Only the session owner can see its audit trail.')
      const q = new URL(req.url, 'http://x').searchParams
      const t = now()
      const num = (k, d) => { const n = Number(q.get(k)); return q.has(k) && Number.isFinite(n) ? n : d }
      const from = num('from', 0)
      const to = num('to', t + 1)
      const inWindow = visits.filter((v) => v.startedAt < to && (v.endedAt == null || v.endedAt >= from))
      const actions = await store.actionsInRoom(room, { from, to, limit: MAX_ACTIONS + 1 })
      const truncated = actions.length > MAX_ACTIONS
      const revoked = new Map()
      for (const acc of new Set(inWindow.filter((v) => v.kind === 'agent').map((v) => v.account))) {
        const agent = await store.agentById(acc.slice('agent:'.length)).catch(() => null)
        if (agent && agent.revokedAt != null) revoked.set(acc, agent.revokedAt)
      }
      const trail = auditTrail({ visits: inWindow, actions: actions.slice(0, MAX_ACTIONS), revoked })
      if (q.get('format') === 'csv') return new Raw(200, auditCsv(trail), 'text/csv; charset=utf-8')
      return { session: { room, name: session.name }, from, to, truncated, visits: trail }
    }],

    // People and agents you've worked with, for invites (most recent first, at most 30).
    ['GET', /^\/v1\/me\/collaborators$/, async (req) => ({ collaborators: await collaboratorsOf(store, await me(req), now()) })]
  ]
}
