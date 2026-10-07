// Access types and grants for the API's routes: finding a type (a built-in, or one of
// the owner's own) and what a grant comes to.
import { UUID } from './http.js'
import { builtinType, effectiveAccess, FALLBACK_TYPE } from '../session-access.js'
import { workspaceAccess } from './workspace-access.js'
import { orgGrantsFor } from './org-access.js'

// The owner's access, as a pass carries it. The relay keeps its own record of who owns a
// room; this only says the API agrees.
export const OWNER_ACCESS = Object.freeze({ owner: true, files: 'edit', folders: Object.freeze([]), foldersExcept: Object.freeze([]), talk: true })

/** A built-in, or one of `ownerAccount`'s own types; null otherwise (someone else's, or none). */
export async function ownType (store, ownerAccount, typeId) {
  const id = String(typeId || '')
  const b = builtinType(id)
  if (b) return b
  if (!UUID.test(id)) return null
  const t = await store.accessTypeById(id)
  return t && t.ownerAccount === ownerAccount ? t : null
}

/** A grant's type: View only when its own is gone (deleted while this was read). */
export async function typeOfGrant (store, grant) {
  return builtinType(grant.typeId) || (UUID.test(grant.typeId) && await store.accessTypeById(grant.typeId)) || builtinType(FALLBACK_TYPE)
}

/** A grant as the owner sees it: its type's name and what it comes to. */
export async function grantView (store, grant) {
  const type = await typeOfGrant(store, grant)
  return { account: grant.account, typeId: type.id, typeName: type.name, tighten: grant.tighten || {}, access: effectiveAccess(type, grant.tighten), updatedAt: grant.updatedAt }
}

/**
 * What `account` may do in `room`, for its pass: the owner's access, its grant's, or null
 * (no grant: the owner lets them in, or not). `email` is a person's confirmed sign-in
 * address: an open invite to it becomes their grant now, and the invite is used.
 */
export async function roomAccess (store, room, account, email = '') {
  const session = await store.sessionByRoom(room)
  if (!session) return null
  if (session.ownerAccount === account) return OWNER_ACCESS
  if (email) await store.claimEmailInvites(room, email.toLowerCase(), account)
  const grant = await store.grantFor(room, account)
  if (grant) {
    await store.useAccountInvites(room, account)
    return effectiveAccess(await typeOfGrant(store, grant), grant.tighten)
  }
  // No grant of its own: a session inside a workspace admits the workspace's people, but
  // only when its owner (as the relay reports it) put it there. Anyone else's link, or one
  // made before the relay has named an owner, lets nobody in.
  if (!session.workspaceId || !session.ownerAccount || session.ownerAccount !== session.workspaceLinkedBy) return null
  // A workspace's agents are invited to its sessions (sent the link), never let in by it:
  // like anyone with a link they wait, and the session owner lets them in (a grant, above).
  if (account.startsWith('agent:')) return null
  const ws = await store.workspaceById(session.workspaceId)
  if (!ws) return null
  const wa = await workspaceAccess(store, ws, account, { orgGrants: ws.orgId ? await orgGrantsFor(store, ws.orgId, account) : null })
  if (!wa) return null
  return effectiveAccess(builtinType(wa.access === 'edit' ? 'builtin:edit' : 'builtin:view'), {})
}
