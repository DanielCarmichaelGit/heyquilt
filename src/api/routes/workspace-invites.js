// Inviting people to a workspace, and the invites waiting for you.
//
// A workspace admin invites a person they've worked with (or someone in the workspace's org)
// or anyone by email; nothing changes until that person accepts, in the app's home or on the
// website's dashboard. Agents have no inbox: they're still added straight away (members PUT).
//
// GET /v1/me/invites lists every invite waiting for the caller: workspace invites, and
// session invites with their join link (kept only for the account or address it was sent to).
// A person's confirmed sign-in address counts as theirs, so an invite sent to an email before
// they had an account is waiting when they sign up.
import { HttpError, needId, stripInvisible } from '../http.js'
import { emailDomain } from '../domains.js'
import { workspaceInviteEmail } from '../invite-email.js'
import { cleanAccess } from '../workspace-access.js'
import { workspaceReach } from '../workspace-reach.js'
import { typeOfGrant } from '../access.js'
import { collaboratorsOf } from './sessions.js'

export const WORKSPACE_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const STRICT_EMAIL = /^[^\s@,;<>"()\\]+@[^\s@,;<>"()\\]+$/
const PERSON = /^person:[A-Za-z0-9_-]{1,64}$/
const TAKEN = 'They already have an open invite. Cancel it first.'

export function workspaceInviteRoutes (ctx) {
  const { store, person, now, site, mailer, log = () => {}, limitSend = () => {}, workspaces = false } = ctx
  const { reach } = workspaceReach(ctx)
  const gated = (fn) => (...args) => {
    if (!workspaces) throw new HttpError(404, 'not found')
    return fn(...args)
  }
  const statusOf = (i) => (i.acceptedAt ? 'accepted' : i.declinedAt ? 'declined' : i.cancelledAt ? 'cancelled' : i.expiresAt <= now() ? 'expired' : 'waiting')
  // An account invite shows the name the inviter saw, never the person's email.
  const view = (i) => ({ id: i.id, ...(i.email ? { email: i.email } : { account: i.account, name: i.accountName }), access: i.access, status: statusOf(i), createdAt: i.createdAt, expiresAt: i.expiresAt })
  const nameOf = async (account) => {
    const [kind, id] = String(account || '').split(':')
    const raw = kind === 'agent' ? (await store.agentById(id).catch(() => null))?.name : kind === 'person' ? (await store.profile(id))?.name : ''
    return stripInvisible(raw || '').join('').trim()
  }

  function cleanEmail (raw) {
    const email = String(raw || '').trim().toLowerCase()
    if (!email || email.length > 254 || !STRICT_EMAIL.test(email) || !emailDomain(email)) throw new HttpError(400, "That email doesn't look right.")
    return email
  }

  /** Who the caller is to an invite: their account, and their confirmed sign-in address (if any). */
  async function mine (req) {
    const { userId } = await person(req)
    const mail = await store.userEmail(userId)
    const email = mail?.confirmed && mail.email ? String(mail.email).toLowerCase() : null
    return { userId, account: `person:${userId}`, email }
  }

  async function send (to, { inviter, ws, access }) {
    const msg = workspaceInviteEmail({ inviterName: (await nameOf(inviter)) || undefined, workspaceName: ws.name, access, site })
    try {
      await mailer.send({ to, ...msg })
    } catch (err) {
      log(`workspace invite email failed: ${err?.stack || err?.message || err}`)
      throw new HttpError(502, "The invite was saved, but the email didn't send. It still shows in their Quilt; cancel and invite again to resend it.")
    }
  }

  async function create (fields) {
    try {
      return await store.createWorkspaceInvite({ ...fields, at: now() })
    } catch (err) {
      if (err.code === '23505') throw new HttpError(409, TAKEN)
      throw err
    }
  }

  /** Whether `account` is already in the workspace: its owner or a member. */
  async function alreadyIn (ws, account) {
    return (ws.ownerUserId && account === `person:${ws.ownerUserId}`) || !!(await store.workspaceMember(ws.id, account))
  }

  /** An invite waiting for the caller; 404 for anything else (theirs or not, so ids can't be probed). */
  async function waitingFor (me, id) {
    const i = await store.workspaceInviteById(needId(id, 'invite'))
    if (!i || !((i.account && i.account === me.account) || (i.email && i.email === me.email))) throw new HttpError(404, 'no such invite')
    if (statusOf(i) !== 'waiting') throw new HttpError(410, statusOf(i) === 'expired' ? 'This invite has expired. Ask for a new one.' : `This invite was already ${statusOf(i)}.`)
    return i
  }

  const routes = [
    ['GET', /^\/v1\/workspaces\/([^/]+)\/invites$/, gated(async (req, body, [id]) => {
      const r = await reach(req, id)
      r.needAdmin()
      return { invites: (await store.listWorkspaceInvites(r.ws.id)).map(view) }
    })],

    // { to: { email } | { account: 'person:<id>' }, access }. A person, by account, is someone
    // the inviter has worked with or someone in the workspace's org.
    ['POST', /^\/v1\/workspaces\/([^/]+)\/invites$/, gated(async (req, body, [id]) => {
      const r = await reach(req, id)
      r.needAdmin()
      if (!r.me.userId) throw new HttpError(403, 'Agents add agents; people invite people.')
      limitSend(r.me.userId)
      const access = cleanAccess(body.access || 'edit')
      const to = body.to && typeof body.to === 'object' ? body.to : {}
      const base = { workspaceId: r.ws.id, access, invitedBy: r.me.account, expiresAt: now() + WORKSPACE_INVITE_TTL_MS }

      if (to.email !== undefined) {
        const email = cleanEmail(to.email)
        if (await store.openWorkspaceInvite(r.ws.id, { email }, now())) throw new HttpError(409, 'That address already has an open invite. Cancel it first.')
        const invite = await create({ ...base, email })
        await send(email, { inviter: r.me.account, ws: r.ws, access })
        return { invite: view(invite) }
      }

      const account = String(to.account || '')
      if (!PERSON.test(account)) throw new HttpError(400, 'Invite a person by email, or someone you have worked with. Agents are added, not invited.')
      if (account === r.me.account) throw new HttpError(400, "That's you.")
      const userId = account.slice('person:'.length)
      const known = (await collaboratorsOf(store, r.me.account, now())).find((c) => c.account === account)
      const inOrg = r.ws.orgId && await store.memberOf(r.ws.orgId, userId)
      if (!known && !inOrg) throw new HttpError(404, "You can invite people you've worked with, or anyone by email.")
      if (await alreadyIn(r.ws, account)) throw new HttpError(409, 'They are already in this workspace.')
      if (await store.openWorkspaceInvite(r.ws.id, { account }, now())) throw new HttpError(409, TAKEN)
      const name = known?.name || await nameOf(account)
      const invite = await create({ ...base, account, accountName: String(name || '').slice(0, 64) })
      // They hear about it at their sign-in email too (looked up here, never sent back).
      const mail = await store.userEmail(userId)
      if (mail?.confirmed && mail.email) await send(mail.email, { inviter: r.me.account, ws: r.ws, access })
      return { invite: view(invite) }
    })],

    ['DELETE', /^\/v1\/workspaces\/([^/]+)\/invites\/([^/]+)$/, gated(async (req, body, [id, inviteId]) => {
      const r = await reach(req, id)
      r.needAdmin()
      const i = await store.workspaceInviteById(needId(inviteId, 'invite'))
      if (!i || i.workspaceId !== r.ws.id) throw new HttpError(404, 'no such invite')
      if (!await store.answerWorkspaceInvite(i.id, 'cancelled')) throw new HttpError(409, 'That invite was already answered or cancelled.')
      return { ok: true }
    })],

    // Every invite waiting for you, newest first: workspaces (with workspaces on) and sessions.
    ['GET', /^\/v1\/me\/invites$/, async (req) => {
      const me = await mine(req)
      const t = now()
      const out = []
      if (workspaces) {
        for (const i of await store.workspaceInvitesFor(me, t)) {
          const ws = await store.workspaceById(i.workspaceId)
          if (!ws) continue
          const org = ws.orgId ? await store.orgById(ws.orgId) : null
          out.push({ kind: 'workspace', id: i.id, workspace: { id: ws.id, name: ws.name, color: ws.color, org: org ? org.name : null }, access: i.access, from: { account: i.invitedBy, name: await nameOf(i.invitedBy) }, createdAt: i.createdAt, expiresAt: i.expiresAt })
        }
      }
      for (const i of await store.sessionInvitesFor(me, t)) {
        // An invite made before links were kept can't be joined from here: it's in their email.
        const type = await typeOfGrant(store, { typeId: i.typeId })
        out.push({ kind: 'session', id: i.id, session: { room: i.room, name: i.sessionName || 'Untitled session' }, link: i.link || null, access: type.name, from: { account: i.invitedBy, name: await nameOf(i.invitedBy) }, createdAt: i.createdAt, expiresAt: i.expiresAt })
      }
      return { invites: out.sort((a, b) => b.createdAt - a.createdAt) }
    }],

    // Accepting a workspace invite makes you a member. (A session invite is accepted by
    // joining with its link: the grant it made lets you straight in.)
    ['POST', /^\/v1\/me\/invites\/([^/]+)\/accept$/, gated(async (req, body, [id]) => {
      const me = await mine(req)
      const i = await waitingFor(me, id)
      const ws = await store.workspaceById(i.workspaceId)
      if (!ws) throw new HttpError(404, 'That workspace was deleted.')
      if (ws.orgId && !(await store.memberOf(ws.orgId, me.userId))) {
        const org = await store.orgById(ws.orgId)
        throw new HttpError(403, `This workspace belongs to ${org?.name || 'an org'}. Ask them to add you to the org, then accept again.`)
      }
      if (!await store.answerWorkspaceInvite(i.id, 'accepted', me.account)) throw new HttpError(410, 'This invite was already answered.')
      // Never lower the access someone already has.
      const had = await store.workspaceMember(ws.id, me.account)
      const owner = ws.ownerUserId === me.userId
      if (!owner && !(had && had.access === 'edit')) await store.putWorkspaceMember({ workspaceId: ws.id, account: me.account, access: i.access, addedBy: i.invitedBy })
      return { workspace: { id: ws.id, name: ws.name } }
    })],

    // Declining: a workspace invite is answered; a session invite is cancelled and the access
    // it gave is taken back (unless another open invite still needs it).
    ['POST', /^\/v1\/me\/invites\/([^/]+)\/decline$/, async (req, body, [id]) => {
      const me = await mine(req)
      const inviteId = needId(id, 'invite')
      const s = await store.sessionInviteForMe(inviteId, me)
      if (s) {
        if (!await store.cancelSessionInvite(s.id)) throw new HttpError(410, 'This invite was already used or cancelled.')
        await store.deleteUnusedGrant(s.room, s.email ? `email:${s.email}` : s.account, now())
        return { ok: true }
      }
      if (!workspaces) throw new HttpError(404, 'no such invite')
      const i = await waitingFor(me, inviteId)
      if (!await store.answerWorkspaceInvite(i.id, 'declined')) throw new HttpError(410, 'This invite was already answered.')
      return { ok: true }
    }]
  ]
  return routes
}
