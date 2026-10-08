// The relay reports who is in which session and when (src/presence.js on the relay). It
// signs in with RELAY_API_SECRET. Each event applies once: replays are ignored.
import crypto from 'node:crypto'
import { HttpError, UUID, stripInvisible } from '../http.js'
import { DAY_MS } from '../activity.js'
import { cleanSessionName } from '../../session-name.js'
import { END_REASONS, ACTIONS } from '../../presence.js'

export const MAX_EVENTS = 500
// 500 events of a few hundred bytes each: more than the API's usual 16 KB.
export const PRESENCE_BODY = 512 * 1024
export const KEEP_MS = 365 * DAY_MS
export const SEEN_MS = 7 * DAY_MS
const ROOM = /^[A-Za-z0-9_-]{1,64}$/
const ACCOUNT = /^(person|agent):[A-Za-z0-9_-]{1,64}$/

const VIA = ['app', 'hosted']
/** A short label: printable, at most `n` characters. */
const label = (x, n) => stripInvisible(x).slice(0, n).join('').replace(/[\u0000-\u001f\u007f]/g, '').trim()

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest()

/** An event as the store takes it, or null when it isn't one (it is skipped, not retried). */
export function cleanEvent (e, now) {
  if (!e || typeof e !== 'object' || !UUID.test(String(e.id)) || !ROOM.test(String(e.room)) || !Number.isFinite(e.at)) return null
  // The relay's clock may run ahead; nothing is recorded in the future.
  const at = Math.min(e.at, now)
  if (at < now - KEEP_MS) return null
  const base = { id: String(e.id).toLowerCase(), type: e.type, room: e.room, at }
  if (e.type === 'start') {
    if (!ACCOUNT.test(String(e.account))) return null
    const name = stripInvisible(e.name).slice(0, 64).join('').trim() || 'Quilt user'
    const how = { ...(VIA.includes(e.via) ? { via: e.via } : {}), ...(label(e.tool, 40) ? { tool: label(e.tool, 40) } : {}) }
    return { ...base, account: e.account, name, owner: e.owner === true, ...how }
  }
  if (e.type === 'end') {
    if (!ACCOUNT.test(String(e.account)) || !UUID.test(String(e.start))) return null
    return { ...base, account: e.account, start: String(e.start).toLowerCase(), ...(END_REASONS.includes(e.reason) ? { reason: e.reason } : {}) }
  }
  if (e.type === 'act') {
    if (!ACCOUNT.test(String(e.account)) || !UUID.test(String(e.start)) || !ACTIONS.includes(e.action)) return null
    return { ...base, account: e.account, start: String(e.start).toLowerCase(), action: e.action, target: label(e.target, 300) }
  }
  if (e.type === 'name') {
    const name = cleanSessionName(e.name)
    return name ? { ...base, name } : null
  }
  return null
}

export function relayRoutes ({ store, now, log, bearer, relaySecret }) {
  let prunedAt = 0
  const fromRelay = (req) => {
    if (!relaySecret) throw new HttpError(503, 'presence is not set up on this server')
    // Hashed first so the comparison takes the same time whatever was sent.
    if (!crypto.timingSafeEqual(digest(bearer(req)), digest(relaySecret))) throw new HttpError(401, 'only the relay may report presence')
  }

  return [
    ['POST', /^\/v1\/relay\/presence$/, async (req, body) => {
      fromRelay(req)
      if (!Array.isArray(body.events)) throw new HttpError(400, 'events must be a list')
      if (body.events.length > MAX_EVENTS) throw new HttpError(413, `at most ${MAX_EVENTS} events at a time`)
      const t = now()
      const events = body.events.map((e) => cleanEvent(e, t)).filter(Boolean)
      const applied = events.length ? await store.ingestPresence(events, t) : 0
      // Visits older than 12 months go once a day, when the relay next reports (the API has no timer).
      if (t - prunedAt >= DAY_MS) {
        prunedAt = t
        await store.pruneActivity({ before: t - KEEP_MS, seenBefore: t - SEEN_MS })
          .catch((err) => log(`could not prune session activity: ${err?.message || err}`))
      }
      return { ok: true, applied, skipped: body.events.length - events.length }
    }, { maxBody: PRESENCE_BODY }]
  ]
}
