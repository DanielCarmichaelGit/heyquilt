// Workspaces: a container owned by a person or an org, holding sessions and members.
// Behind the QUILT_WORKSPACES flag (startApi({ workspaces })): off, every route answers 404.
import { HttpError, cleanName } from '../http.js'
import { orgAccess } from '../org-access.js'
import { workspaceAccess, cleanColor, cleanDescription, cleanAccess, autoColor } from '../workspace-access.js'
import { workspaceReach } from '../workspace-reach.js'
import { listedFiles, usageView } from './workspace-files.js'

const ROOM = /^[A-Za-z0-9_-]{1,64}$/
const ACCOUNT = /^(person|agent):[A-Za-z0-9_-]{1,64}$/
const OPEN_MS = 10 * 60 * 1000

export function workspaceRoutes (ctx) {
  const { store, now, workspaces = false } = ctx
  const { caller, grantsIn, reach } = workspaceReach(ctx)
  /** A handler that answers 404 while the flag is off (a route's own 404, not a missing route). */
  const gated = (fn) => (...args) => {
    if (!workspaces) throw new HttpError(404, 'not found')
    return fn(...args)
  }

  const nameOf = async (account) => {
    const [kind, id] = account.split(':')
    if (kind === 'agent') return (await store.agentById(id))?.name
    return (await store.profile(id))?.name
  }
  const kindOf = (account) => account.split(':')[0]
  const isOpen = (s, t) => t - s.lastActiveAt < OPEN_MS
  const sessionView = (s, t) => ({ room: s.room, name: s.name, ownerAccount: s.ownerAccount, lastActiveAt: s.lastActiveAt, open: isOpen(s, t) })

  async function spaceOf (ws) {
    if (!ws.orgId) return { kind: 'personal' }
    const org = await store.orgById(ws.orgId)
    return { kind: 'org', slug: org?.slug || '', name: org?.name || '' }
  }

  async function listView (ws, access, t) {
    const sessions = await store.listWorkspaceSessions(ws.id)
    const members = await store.listWorkspaceMembers(ws.id)
    return {
      id: ws.id, name: ws.name, description: ws.description, color: ws.color, createdAt: ws.createdAt, archivedAt: ws.archivedAt,
      space: await spaceOf(ws), access: access.access, admin: access.admin, via: access.via,
      // files: the row's count, kept by every upload, delete and sweep (setWorkspaceUsage).
      counts: { sessions: sessions.length, members: members.length, open: sessions.filter((s) => isOpen(s, t)).length, files: ws.fileCount ?? 0 }
    }
  }

  const routes = [
    // Every workspace the caller can reach: their own, their orgs' (per their role), and the ones they're a member of.
    ['GET', /^\/v1\/me\/workspaces$/, async (req) => {
      const me = await caller(req)
      const t = now()
      const seen = new Map()
      const add = async (ws) => {
        if (seen.has(ws.id)) return
        const access = await workspaceAccess(store, ws, me.account, { orgGrants: await grantsIn(ws, me) })
        if (access) seen.set(ws.id, await listView(ws, access, t))
      }
      if (me.userId) {
        for (const ws of await store.listWorkspacesOwnedBy(me.userId)) await add(ws)
        for (const org of await store.orgsForUser(me.userId)) for (const ws of await store.listWorkspacesOfOrg(org.id)) await add(ws)
      }
      for (const ws of await store.listWorkspacesForMember(me.account)) await add(ws)
      return { workspaces: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)) }
    }],

    ['POST', /^\/v1\/workspaces$/, async (req, body) => {
      const me = await caller(req)
      if (!me.userId) throw new HttpError(403, 'agents do not make workspaces')
      const name = cleanName(body.name, 80, 'give the workspace a name')
      // Colour and description are set later, in settings; a new workspace gets a colour from its name.
      const fields = { name, description: cleanDescription(body.description), color: cleanColor(body.color) || autoColor(name), createdBy: me.account }
      if (body.org) {
        const a = await orgAccess(store, me.userId, body.org)
        a.need('workspaces', 'c')
        return { workspace: await store.createWorkspace({ ...fields, orgId: a.org.id }) }
      }
      return { workspace: await store.createWorkspace({ ...fields, ownerUserId: me.userId }) }
    }],

    ['GET', /^\/v1\/workspaces\/([^/]+)$/, async (req, body, [id]) => {
      const { ws, access, canDelete } = await reach(req, id)
      const t = now()
      const members = await Promise.all((await store.listWorkspaceMembers(ws.id)).map(async (m) => ({ account: m.account, name: (await nameOf(m.account)) || '', kind: kindOf(m.account), access: m.access, addedAt: m.addedAt })))
      const ownerAccount = ws.ownerUserId ? `person:${ws.ownerUserId}` : null
      const owner = ownerAccount ? { account: ownerAccount, name: (await nameOf(ownerAccount)) || '' } : { account: null, name: (await store.orgById(ws.orgId))?.name || '' }
      const sessions = (await store.listWorkspaceSessions(ws.id)).map((s) => sessionView(s, t))
      const files = await listedFiles(store, await store.listWorkspaceFiles(ws.id))
      return { workspace: ws, access, canDelete, owner, members, sessions, files, usage: await usageView(store, ws, ctx) }
    }],

    ['PATCH', /^\/v1\/workspaces\/([^/]+)$/, async (req, body, [id]) => {
      const r = await reach(req, id)
      r.needAdmin()
      const patch = {}
      if (body.name !== undefined) patch.name = cleanName(body.name, 80, 'give the workspace a name')
      if (body.description !== undefined) patch.description = cleanDescription(body.description)
      if (body.color !== undefined) patch.color = cleanColor(body.color)
      if (body.archived !== undefined) patch.archivedAt = body.archived ? now() : null
      return { workspace: await store.updateWorkspace(r.ws.id, patch) }
    }],

    ['DELETE', /^\/v1\/workspaces\/([^/]+)$/, async (req, body, [id]) => {
      const r = await reach(req, id)
      if (r.ws.orgId) {
        if (!r.me.userId) throw new HttpError(403, 'agents do not delete workspaces')
        const a = await orgAccess(store, r.me.userId, (await store.orgById(r.ws.orgId)).slug)
        a.need('workspaces', 'd')
      } else if (r.access.via !== 'owner') throw new HttpError(403, 'only the owner can delete a workspace')
      await store.deleteWorkspace(r.ws.id)
      return { ok: true }
    }],

    ['PUT', /^\/v1\/workspaces\/([^/]+)\/members\/([^/]+)$/, async (req, body, [id, account]) => {
      const r = await reach(req, id)
      r.needAdmin()
      if (!ACCOUNT.test(account)) throw new HttpError(400, 'that is not an account')
      const access = cleanAccess(body.access)
      const [kind, who] = account.split(':')
      if (kind === 'agent' ? !(await store.agentById(who)) : !(await store.profile(who))) throw new HttpError(404, 'no such account')
      if (r.ws.orgId && kind === 'person' && !(await store.memberOf(r.ws.orgId, who))) throw new HttpError(404, 'that person is not in the org')
      if (r.ws.orgId && kind === 'agent' && !(await store.memberByAgent(r.ws.orgId, who))) throw new HttpError(404, 'that agent is not in the org')
      return { member: await store.putWorkspaceMember({ workspaceId: r.ws.id, account, access, addedBy: r.me.account }) }
    }],

    ['DELETE', /^\/v1\/workspaces\/([^/]+)\/members\/([^/]+)$/, async (req, body, [id, account]) => {
      const r = await reach(req, id)
      r.needAdmin()
      if (!(await store.removeWorkspaceMember(r.ws.id, account))) throw new HttpError(404, 'not a member')
      return { ok: true }
    }],

    // Puts a session in the workspace. The app calls this as soon as it has made the room,
    // usually before the relay's first presence report. The API records who linked it, never
    // an owner: only the relay names that, and members get in only once the two agree (access.js).
    ['POST', /^\/v1\/workspaces\/([^/]+)\/sessions$/, async (req, body, [id]) => {
      const r = await reach(req, id)
      if (r.access.access !== 'edit') throw new HttpError(403, 'you can only view this workspace')
      const room = String(body.room || '')
      if (!ROOM.test(room)) throw new HttpError(400, 'room must be a session name')
      const existing = await store.sessionByRoom(room)
      if (existing && existing.ownerAccount && existing.ownerAccount !== r.me.account) throw new HttpError(403, 'only the session owner can move it')
      return { session: await store.setSessionWorkspace(room, r.ws.id, { linkedBy: r.me.account, at: now() }) }
    }],

    ['DELETE', /^\/v1\/workspaces\/([^/]+)\/sessions\/([^/]+)$/, async (req, body, [id, room]) => {
      const r = await reach(req, id)
      const s = await store.sessionByRoom(room)
      if (!s || s.workspaceId !== r.ws.id) throw new HttpError(404, 'that session is not in this workspace')
      if (s.ownerAccount !== r.me.account && !r.access.admin) throw new HttpError(403, 'only the session owner or a workspace admin can do that')
      await store.setSessionWorkspace(room, null, { linkedBy: null, at: now() })
      return { ok: true }
    }]
  ]
  return routes.map(([method, pattern, fn, ...options]) => [method, pattern, gated(fn), ...options])
}
