// Who may do what in a workspace (the spec's "Access" section), and the field cleaners
// the routes share. Pure apart from one store read.
import { HttpError, stripInvisible } from './http.js'

export const COLORS = ['lilac', 'mint', 'peach', 'rose', 'periwinkle', 'sky']
export const ACCESS = ['edit', 'view']
const MAX_DESCRIPTION = 500

export function cleanColor (value) {
  if (value === undefined || value === null || value === '') return ''
  if (!COLORS.includes(value)) throw new HttpError(400, 'Pick one of the workspace colours.')
  return value
}

/** A colour for a workspace that was made without one: the same name always gets the same one. */
export function autoColor (name) {
  let h = 0
  for (const c of String(name || '')) h = (h * 31 + c.codePointAt(0)) >>> 0
  return COLORS[h % COLORS.length]
}

export function cleanDescription (value) {
  const chars = stripInvisible(String(value ?? ''))
  if (chars.length > MAX_DESCRIPTION) throw new HttpError(400, `Keep the description under ${MAX_DESCRIPTION} characters.`)
  return chars.join('').trim()
}

export function cleanAccess (value) {
  if (!ACCESS.includes(value)) throw new HttpError(400, 'Access is edit or view.')
  return value
}

/**
 * `account`'s place in `workspace`: { access, admin, via } or null.
 * Personal: the owner is admin. Org: Workspaces: Update is admin; Workspaces: Read alone
 * is view. A member row gives its access and beats org Read; in an org workspace it counts
 * only while its person or agent is still in the org. `orgGrants` is the caller's org
 * access ({ can }) or null when they aren't in the org.
 */
export async function workspaceAccess (store, workspace, account, { orgGrants = null } = {}) {
  if (workspace.ownerUserId && account === `person:${workspace.ownerUserId}`) return { access: 'edit', admin: true, via: 'owner' }
  if (workspace.orgId && orgGrants && orgGrants.can('workspaces', 'u')) return { access: 'edit', admin: true, via: 'org' }
  const member = await store.workspaceMember(workspace.id, account)
  if (member && await stillInOrg(store, workspace, account, orgGrants)) return { access: member.access, admin: false, via: 'member' }
  if (workspace.orgId && orgGrants && orgGrants.can('workspaces', 'r')) return { access: 'view', admin: false, via: 'org' }
  return null
}

/** Whether a member row still counts: always in a personal workspace; in an org's, only for its people and agents. */
async function stillInOrg (store, workspace, account, orgGrants) {
  if (!workspace.orgId) return true
  const [kind, id] = account.split(':')
  if (kind === 'agent') return !!(await store.memberByAgent(workspace.orgId, id))
  return !!orgGrants
}
