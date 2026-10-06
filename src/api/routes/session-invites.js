// Inviting people and agents to a session, as an access type: by email, or someone the
// owner has worked with. The grant is made up front (keyed by the account, or by the
// email until someone signs in with it), so they get straight in. The invite link holds
// the room secret: it only passes through here into the email, and is never stored.
import { HttpError, UUID, stripInvisible } from '../http.js'
import { emailDomain } from '../domains.js'
import { sessionInviteEmail } from '../invite-email.js'
import { parseInvite } from '../../ui/invite.js'
import { ownType, typeOfGrant } from '../access.js'
import { sessionOwner, ACCOUNT, letAgentBackIn } from './grants.js'
import { collaboratorsOf } from './sessions.js'

export const SESSION_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const FORBIDDEN = 'Only the session owner can invite people.'
// One address, nothing a mail header could split (the same rule as org invites).
const STRICT_EMAIL = /^[^\s@,;<>"()\\]+@[^\s@,;<>"()\\]+$/

export function sessionInviteRoutes ({ store, person, now, site, mailer, log, limitSend, workspaces = false }) {
  const statusOf = (i) => (i.usedAt ? 'used' : i.cancelledAt ? 'cancelled' : i.expiresAt <= now() ? 'expired' : 'waiting')
  // The invite comes first, then its grant: one that loses a race to another open invite for
  // the same address or account (the database's unique index) changes nothing.
  async function createInvite (fields, duplicateMessage, grant) {
    let invite
    try {
      invite = await store.createSessionInvite({ ...fields, at: now() })
    } catch (err) {
      if (err.code === '23505') throw new HttpError(409, duplicateMessage)
      throw err
    }
    // No grant, no invite: an open one would block inviting them again.
    try { await store.putGrant(grant) } catch (err) { await store.cancelSessionInvite(invite.id).catch(() => {}); throw err }
    await letAgentBackIn(store, grant.room, grant.account, workspaces, log)
    return invite
  }
  // An account invite shows the name the owner saw, never the person's email.
  async function view (i) {
    const type = await typeOfGrant(store, { typeId: i.typeId })
    return { id: i.id, ...(i.email ? { email: i.email } : { account: i.account, name: i.accountName }), typeId: type.id, typeName: type.name, status: statusOf(i), createdAt: i.createdAt, expiresAt: i.expiresAt }
  }

  function cleanEmail (raw) {
    const email = String(raw || '').trim().toLowerCase()
    if (!email || email.length > 254 || !STRICT_EMAIL.test(email) || !emailDomain(email)) throw new HttpError(400, "That email doesn't look right.")
    return email
  }

  async function send (to, { userId, session, link }) {
    const inviter = await store.profile(userId)
    const inviterName = stripInvisible(inviter?.name || '').join('').trim() || undefined
    const msg = sessionInviteEmail({ inviterName, sessionName: session.name || 'Untitled session', link, site })
    try {
      await mailer.send({ to, ...msg })
    } catch (err) {
      log(`session invite email failed: ${err?.stack || err?.message || err}`)
      throw new HttpError(502, "The invite was saved, but the email didn't send. Cancel it and invite them again.")
    }
  }

  return [
    ['GET', /^\/v1\/sessions\/([^/]+)\/invites$/, async (req, body, [room]) => {
      await sessionOwner(store, person, req, room, FORBIDDEN)
      return { invites: await Promise.all((await store.listSessionInvites(room)).map(view)) }
    }],

    ['POST', /^\/v1\/sessions\/([^/]+)\/invites$/, async (req, body, [room]) => {
      const owner = await sessionOwner(store, person, req, room, FORBIDDEN)
      limitSend(owner.userId)
      const type = await ownType(store, owner.me, body.typeId)
      if (!type) throw new HttpError(400, 'no such access type')
      let inv = null
      try { inv = parseInvite(body.link, { allowRelay: () => true }) } catch {}
      if (!inv || inv.room !== room) throw new HttpError(400, "Send this session's invite link.")
      const link = String(body.link).trim()
      const to = body.to && typeof body.to === 'object' ? body.to : {}

      if (to.email !== undefined) {
        const email = cleanEmail(to.email)
        const taken = 'That address already has an open invite. Cancel it first.'
        if (await store.openSessionInvite(room, { email }, now())) throw new HttpError(409, taken)
        const invite = await createInvite({ room, email, typeId: type.id, invitedBy: owner.me, expiresAt: now() + SESSION_INVITE_TTL_MS }, taken,
          { room, account: `email:${email}`, typeId: type.id, grantedBy: owner.me })
        await send(email, { ...owner, link })
        return { invite: await view(invite) }
      }

      const account = String(to.account || '')
      if (!ACCOUNT.test(account)) throw new HttpError(400, 'Invite someone by email, or someone you have worked with.')
      if (account === owner.me) throw new HttpError(400, "That's you.")
      const who = (await collaboratorsOf(store, owner.me, now())).find((c) => c.account === account)
      if (!who) throw new HttpError(404, "You can invite people you've worked with, or anyone by email.")
      const taken = 'They already have an open invite. Cancel it first.'
      if (await store.openSessionInvite(room, { account }, now())) throw new HttpError(409, taken)
      // Inviting them again would overwrite the access they have, and cancelling that invite
      // would then take it all away.
      if (await store.grantFor(room, account)) throw new HttpError(409, 'They already have access to this session. Change it from the people menu.')
      const invite = await createInvite({ room, account, accountName: who.name, typeId: type.id, invitedBy: owner.me, expiresAt: now() + SESSION_INVITE_TTL_MS }, taken,
        { room, account, typeId: type.id, grantedBy: owner.me })
      // A person hears about it at their sign-in email (looked up here, never sent back). An
      // agent has no email: its grant just lets it straight in.
      if (who.kind === 'person') {
        const mail = await store.userEmail(account.slice('person:'.length))
        if (mail?.confirmed && mail.email) await send(mail.email, { ...owner, link })
      }
      return { invite: await view(invite) }
    }],

    // Cancelling also takes back the grant the invite made, unless someone already used it.
    ['DELETE', /^\/v1\/sessions\/([^/]+)\/invites\/([^/]+)$/, async (req, body, [room, id]) => {
      await sessionOwner(store, person, req, room, FORBIDDEN)
      const invite = UUID.test(id) ? await store.sessionInviteById(room, id) : null
      if (!invite) throw new HttpError(404, 'no such invite')
      if (!await store.cancelSessionInvite(invite.id)) throw new HttpError(409, 'That invite was already used or cancelled.')
      // Unless an open invite for the same address or account needs it, even one made just now.
      await store.deleteUnusedGrant(room, invite.email ? `email:${invite.email}` : invite.account, now())
      return { ok: true }
    }]
  ]
}
