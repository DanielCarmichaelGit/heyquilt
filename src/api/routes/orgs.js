// Orgs: creating one, its settings and domain rule, ownership, and its roles.
import { HttpError, needId, cleanName } from '../http.js'
import { orgAccess } from '../org-access.js'
import { BUILTIN, normalizeGrants } from '../permissions.js'
import { emailDomain, isDomain, isPublicDomain } from '../domains.js'
import { uniqueSlug } from '../slugs.js'

const ROLE_ORDER = { owner: 0, admin: 1, member: 2 }
const RESERVED_ROLE_NAMES = new Set(['owner', 'admin', 'member'])
const checkNotReserved = (name) => {
  if (RESERVED_ROLE_NAMES.has(name.toLowerCase())) throw new HttpError(400, 'That name is reserved for a built-in role.')
}
const sortRoles = (roles) => [...roles].sort((a, b) => (ROLE_ORDER[a.builtin] ?? 3) - (ROLE_ORDER[b.builtin] ?? 3) || a.name.localeCompare(b.name))
const orgView = (o) => ({ id: o.id, name: o.name, slug: o.slug, domain: o.domain, domainRequests: o.domainRequests, createdAt: o.createdAt })
const roleView = (r) => ({ id: r.id, name: r.name, builtin: r.builtin, grants: normalizeGrants(r.grants), createdAt: r.createdAt })

export function orgRoutes ({ store, user, person }) {
  const orgFor = async (req, slug) => { const u = await user(req); return { u, ...(await orgAccess(store, u.userId, slug)) } }

  // Two orgs made at once can pick the same slug; the unique index decides and we try the next.
  // first: true (a team sign-up's first dashboard visit) asks the store to
  // hand back an org the owner is already in, rather than making a second one
  // when two tabs (or a double click) both raced here with no org yet.
  async function createOrg (name, ownerId, first = false) {
    for (let attempt = 0; ; attempt++) {
      const slug = await uniqueSlug(name, async (s) => !!await store.orgBySlug(s))
      try {
        return await store.createOrg({ name, slug, ownerId, grants: BUILTIN, first })
      } catch (err) {
        if (err?.code !== '23505' || attempt >= 2) throw err
      }
    }
  }

  // Only a domain the caller has proved they get mail at, and never a public provider's.
  async function ownDomain (userId, domain) {
    if (!isDomain(domain)) throw new HttpError(400, "that isn't a domain")
    if (isPublicDomain(domain)) throw new HttpError(400, "public email domains can't be used")
    const mine = await store.userEmail(userId)
    if (!mine?.confirmed || emailDomain(mine.email) !== domain) throw new HttpError(403, 'you can only use the domain of your own confirmed email')
    return domain
  }

  async function roleIn (a, id) {
    const role = await store.roleById(a.org.id, needId(id, 'role'))
    if (!role) throw new HttpError(404, 'no such role')
    return role
  }

  return [
    ['GET', /^\/v1\/orgs$/, async (req) => {
      // The app lists your orgs too (where a new workspace goes), so a computer's qd_ token works here.
      const u = await person(req)
      const orgs = await store.orgsForUser(u.userId)
      return {
        orgs: await Promise.all(orgs.map(async (o) => ({
          ...orgView(o), isOwner: o.ownerId === u.userId, role: (await store.roleById(o.id, o.roleId))?.name || null
        })))
      }
    }],

    // Only an org account can create an org, and only when it isn't in one yet
    // (first: true, checked again by createOrg itself against a race).
    ['POST', /^\/v1\/orgs$/, async (req, body) => {
      const u = await user(req)
      if (body.first !== true || await store.profileKind(u.userId) !== 'org') {
        throw new HttpError(403, 'Orgs are created by signing up as an org.')
      }
      return { org: orgView(await createOrg(cleanName(body.name, 80, 'give the org a name'), u.userId, true)) }
    }],

    ['GET', /^\/v1\/orgs\/([^/]+)\/me$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      return {
        org: { ...orgView(a.org), ownerId: a.org.ownerId },
        role: a.role && { id: a.role.id, name: a.role.name, builtin: a.role.builtin },
        grants: a.grants,
        isOwner: a.isOwner,
        memberId: a.me.id
      }
    }],

    ['PUT', /^\/v1\/orgs\/([^/]+)$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      a.need('org', 'u')
      const patch = {}
      if (body.name !== undefined) patch.name = cleanName(body.name, 80, 'give the org a name')
      if (body.domain !== undefined) {
        const d = body.domain == null ? '' : String(body.domain).trim().toLowerCase().replace(/\.$/, '')
        // Re-saving the current domain (say, alongside a rename) doesn't need re-proving.
        patch.domain = !d ? null : d === a.org.domain ? d : await ownDomain(a.u.userId, d)
      }
      if (body.domainRequests !== undefined) patch.domainRequests = body.domainRequests === true
      if (!Object.keys(patch).length) return { org: orgView(a.org) }
      const domain = 'domain' in patch ? patch.domain : a.org.domain
      if (patch.domainRequests && !domain) throw new HttpError(400, 'set a domain first')
      if (!domain) patch.domainRequests = false
      return { org: orgView(await store.updateOrg(a.org.id, patch)) }
    }],

    ['DELETE', /^\/v1\/orgs\/([^/]+)$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      a.needOwner()
      await store.deleteOrg(a.org.id)
      return { ok: true }
    }],

    ['POST', /^\/v1\/orgs\/([^/]+)\/transfer$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      a.needOwner()
      const to = await store.memberById(a.org.id, needId(body.memberId, 'member'))
      if (!to?.userId) throw new HttpError(404, 'no such member')
      if (to.userId === a.u.userId) throw new HttpError(400, 'you already own this org')
      try {
        await store.transferOrg(a.org.id, a.u.userId, to.userId)
      } catch (err) {
        // Defensive: the checks above should make these unreachable, but a store
        // that finds otherwise should answer cleanly rather than with a 500.
        if (err?.code === 'QO001') throw new HttpError(404, 'the current owner is no longer a member of this org')
        if (err?.code === 'QO002') throw new HttpError(400, 'that member is not part of this org')
        // Someone else already became owner between this page loading and the click.
        if (err?.code === 'QO003') throw new HttpError(409, 'Ownership already changed. Reload and try again.')
        throw err
      }
      return { ok: true }
    }],

    ['GET', /^\/v1\/orgs\/([^/]+)\/roles$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      // People who hand out roles (changing members, inviting) need the list to pick from.
      if (!a.can('members', 'u') && !a.can('invites', 'c')) a.need('roles', 'r')
      return { roles: sortRoles(await store.listRoles(a.org.id)).map(roleView) }
    }],

    ['POST', /^\/v1\/orgs\/([^/]+)\/roles$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      a.need('roles', 'c')
      const grants = normalizeGrants(body.grants)
      if (!a.covers(grants)) throw new HttpError(403, 'a role can only have permissions you have')
      const name = cleanName(body.name, 40, 'give the role a name')
      checkNotReserved(name)
      return { role: roleView(await store.createRole({ orgId: a.org.id, name, grants })) }
    }],

    ['PUT', /^\/v1\/orgs\/([^/]+)\/roles\/([^/]+)$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      a.need('roles', 'u')
      const role = await roleIn(a, id)
      if (role.builtin === 'owner') throw new HttpError(403, "the Owner role can't be edited")
      if (!a.covers(role.grants)) throw new HttpError(403, "this role has permissions you don't have")
      const patch = {}
      if (body.name !== undefined) {
        const name = cleanName(body.name, 40, 'give the role a name')
        if (role.builtin && name !== role.name) throw new HttpError(400, 'built-in roles keep their names')
        if (!role.builtin) checkNotReserved(name)
        patch.name = name
      }
      if (body.grants !== undefined) {
        patch.grants = normalizeGrants(body.grants)
        if (!a.covers(patch.grants)) throw new HttpError(403, 'a role can only have permissions you have')
      }
      if (!Object.keys(patch).length) return { role: roleView(role) }
      return { role: roleView(await store.updateRole(role.id, patch)) }
    }],

    ['DELETE', /^\/v1\/orgs\/([^/]+)\/roles\/([^/]+)$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      a.need('roles', 'd')
      const role = await roleIn(a, id)
      if (role.builtin) throw new HttpError(400, "built-in roles can't be deleted")
      if (!a.covers(role.grants)) throw new HttpError(403, "this role has permissions you don't have")
      if (await store.roleInUse(role.id)) throw new HttpError(409, 'this role is still assigned; move its people to another role first')
      await store.deleteRole(role.id)
      return { ok: true }
    }]
  ]
}
