// Who gets what in a session: the owner gives someone (an account) an access type,
// optionally narrowed. The API is where access lives; passes carry it to the relay.
import { HttpError } from '../http.js'
import { cleanTighten } from '../../session-access.js'
import { ownType, grantView } from '../access.js'

export const ROOM = /^[A-Za-z0-9_-]{1,64}$/
export const ACCOUNT = /^(person|agent):[A-Za-z0-9_-]{1,64}$/
const EMAIL_KEY = /^[^\s@,;<>"()\\]+@[^\s@,;<>"()\\]+$/
export const NOT_YET = "That session hasn't reached heyquilt.com yet. Try again in a minute."

/**
 * The session's owner, from their request: { me: 'person:<id>', userId, session }. 404 for a
 * session the API hasn't heard of (the relay reports new ones within seconds), 403 for anyone else.
 */
export async function sessionOwner (store, person, req, room, forbidden = 'Only the session owner can change who gets in.') {
  const { userId } = await person(req)
  const me = `person:${userId}`
  if (!ROOM.test(room)) throw new HttpError(404, NOT_YET)
  const session = await store.sessionByRoom(room)
  if (!session) throw new HttpError(404, NOT_YET)
  if (session.ownerAccount !== me) throw new HttpError(403, forbidden)
  return { me, userId, session }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The owner letting an agent into a session again (a grant) also ends keeping it out of that
 * session, which removing it from a session in a workspace starts. Only with workspaces on.
 */
export async function letAgentBackIn (store, room, account, workspaces) {
  if (!workspaces || !String(account).startsWith('agent:') || !UUID.test(account.slice(6))) return
  await store.removeSessionAgentExclusion(room, account.slice(6))
}

export function grantRoutes ({ store, person, now = Date.now, workspaces = false }) {
  return [
    ['GET', /^\/v1\/sessions\/([^/]+)\/grants$/, async (req, body, [room]) => {
      await sessionOwner(store, person, req, room)
      return { grants: await Promise.all((await store.listGrants(room)).map((g) => grantView(store, g))) }
    }],

    ['PUT', /^\/v1\/sessions\/([^/]+)\/grants\/([^/]+)$/, async (req, body, [room, account]) => {
      const { me } = await sessionOwner(store, person, req, room)
      if (!ACCOUNT.test(account)) throw new HttpError(400, 'Grants are for people and agents (person:<id> or agent:<id>).')
      if (account === me) throw new HttpError(400, 'The owner always has full access.')
      const type = await ownType(store, me, body.typeId)
      if (!type) throw new HttpError(400, 'no such access type')
      let tighten
      try { tighten = cleanTighten(body.tighten) } catch (err) { throw new HttpError(400, err.message) }
      const grant = await store.putGrant({ room, account, typeId: type.id, tighten, grantedBy: me })
      await letAgentBackIn(store, room, account, workspaces)
      return { grant: await grantView(store, grant) }
    }],

    ['DELETE', /^\/v1\/sessions\/([^/]+)\/grants\/([^/]+)$/, async (req, body, [room, account]) => {
      await sessionOwner(store, person, req, room)
      // An account, or an email invite's grant (left by an invite that expired, say).
      const email = account.startsWith('email:') ? account.slice('email:'.length) : ''
      if (!ACCOUNT.test(account) && !(email && EMAIL_KEY.test(email))) throw new HttpError(400, 'no such account')
      await store.deleteGrant(room, account)
      // Their open invite would still list as waiting, for access they no longer have.
      const open = await store.openSessionInvite(room, email ? { email } : { account }, now())
      if (open) await store.cancelSessionInvite(open.id)
      return { ok: true }
    }]
  ]
}
