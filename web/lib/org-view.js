// Pure helpers for the Org area, no Next imports, so they're unit-tested directly.
import { can, isSubset } from './permissions.js'

/** Whether the viewer may do `op` on `resource` in this org (the owner may do everything). */
export function allowed (me, resource, op) {
  return !!me && (me.isOwner || can(me.grants, resource, op))
}

/** The Org area's tabs, per the viewer's Read permissions. Everyone sees their own teams. */
export function orgTabs (slug, me) {
  const base = `/org/${slug}`
  return [
    { href: base, label: 'Overview' },
    (allowed(me, 'members', 'r') || allowed(me, 'agents', 'r')) && { href: `${base}/people`, label: 'People' },
    { href: `${base}/teams`, label: 'Teams' },
    allowed(me, 'workspaces', 'r') && { href: `${base}/workspaces`, label: 'Workspaces' },
    allowed(me, 'roles', 'r') && { href: `${base}/roles`, label: 'Roles' },
    allowed(me, 'invites', 'r') && { href: `${base}/invites`, label: 'Invites' },
    allowed(me, 'org', 'r') && { href: `${base}/settings`, label: 'Settings' }
  ].filter(Boolean)
}

// Messages come back through the query string; show them only if they look like ours.
const SAFE = /^[\p{L}\p{N}\s.,;:'’()@?!_–—-]{1,200}$/u
export function safeMessage (s) {
  if (!s) return null
  return typeof s === 'string' && SAFE.test(s) ? s : 'Something went wrong. Try again.'
}

// Pages render on the server (UTC on Netlify), so the zone is pinned and labelled.
// dateStyle/timeStyle can't be combined with timeZoneName (it throws), hence the fields.
const WHEN = { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' }
/** A date for server-rendered pages: epoch ms (API) or an ISO string (Supabase). */
export function when (t) {
  return t ? new Date(t).toLocaleString('en', WHEN) : 'never'
}

/** Roles the viewer may hand out: never Owner, and only within their own grid. */
export function assignableRoles (roles, me) {
  return (roles || []).filter((r) => r.builtin !== 'owner' && (me.isOwner || isSubset(r.grants, me.grants)))
}

/** The org's people who aren't in this team yet, for the "add" picker. */
export function peopleNotIn (people, members) {
  const inTeam = new Set((members || []).map((m) => m.memberId))
  return (people || []).filter((p) => !inTeam.has(p.memberId))
}

const GONE = { accepted: 'This invite was already used.', cancelled: 'This invite was cancelled.', expired: 'This invite has expired. Ask for a new one.' }
/** Why an invite can't be used any more (null while it's pending). */
export function inviteGone (status) {
  return Object.hasOwn(GONE, status) ? GONE[status] : null
}

// Tokens are minted as `qi_` plus 32 random bytes, base64url-encoded (43 chars, no padding).
const INVITE_TOKEN = /^qi_[A-Za-z0-9_-]{43}$/
/** Whether a string could be one of our invite tokens, checked before it ever reaches the API. */
export function isInviteToken (t) {
  return typeof t === 'string' && INVITE_TOKEN.test(t)
}
