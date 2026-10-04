// The caller's place in one org, and the checks every org route makes with it.
import { HttpError, needId } from './http.js'
import { BUILTIN, can, isSubset, normalizeGrants } from './permissions.js'

export async function orgAccess (store, userId, slug) {
  const org = await store.orgBySlug(String(slug || '').toLowerCase())
  const me = org && await store.memberOf(org.id, userId)
  // Non-members get the same answer as a missing org, so org addresses can't be probed.
  if (!me) throw new HttpError(404, 'no such org')
  const isOwner = org.ownerId === userId
  const role = me.roleId ? await store.roleById(org.id, me.roleId) : null
  const grants = isOwner ? BUILTIN.owner : normalizeGrants(role?.grants)
  const allowed = (resource, op) => isOwner || can(grants, resource, op)
  // No self-promotion: a role you make, edit or hand out holds nothing you don't.
  const covers = (g) => isOwner || isSubset(g, grants)
  return {
    org,
    me,
    role,
    isOwner,
    grants,
    can: allowed,
    covers,
    need (resource, op) { if (!allowed(resource, op)) throw new HttpError(403, "your role doesn't allow that") },
    needOwner () { if (!isOwner) throw new HttpError(403, 'only the owner can do that') },
    /** A role this caller may give someone: in this org, never Owner, within their own grid. Defaults to Member. */
    async assignable (roleId) {
      const r = roleId
        ? await store.roleById(org.id, needId(roleId, 'role'))
        : (await store.listRoles(org.id)).find((x) => x.builtin === 'member')
      if (!r) throw new HttpError(404, 'no such role')
      if (r.builtin === 'owner') throw new HttpError(403, 'ownership only moves by transfer')
      if (!covers(r.grants)) throw new HttpError(403, 'you can only give roles within your own permissions')
      return r
    }
  }
}

/** An account's grants in an org as { can }, or null when it isn't a member. Never throws. */
export async function orgGrantsFor (store, orgId, account) {
  const [kind, id] = account.split(':')
  const org = await store.orgById(orgId)
  if (!org) return null
  if (kind === 'person') {
    if (org.ownerId === id) return { can: () => true }
    const me = await store.memberOf(orgId, id)
    if (!me) return null
    const role = me.roleId ? await store.roleById(orgId, me.roleId) : null
    const grants = normalizeGrants(role?.grants)
    return { can: (resource, op) => can(grants, resource, op) }
  }
  // Agents in an org get team access, never a role (orgs spec), so no workspace permission from the org.
  return (await store.memberByAgent(orgId, id)) ? { can: () => false } : null
}
