// Who may let people into a controlled session: a per-room setting the owner picks.
// Pure and shared: the relay enforces it, the app shows it, tests check the maths.

export const ADMIT_BY = Object.freeze(['owner', 'editors', 'members'])
export const DEFAULT_ADMIT_BY = 'owner'

export const ADMIT_BY_LABELS = Object.freeze({
  owner: 'Only the owner',
  editors: 'Anyone who can edit',
  members: 'Anyone in the session'
})

export const BAD_ADMIT_BY = 'Who can let people in must be only the owner, anyone who can edit, or anyone in the session.'

/** A known admit-by value, or null. */
export function cleanAdmitBy (raw) {
  const v = String(raw || '').trim()
  return ADMIT_BY.includes(v) ? v : null
}

/**
 * May this approved person let people in, given the room's setting?
 * `access` is relay shape: { owner, role } (viewers never admit unless they are the owner).
 */
export function canAdmit (access, admitBy = DEFAULT_ADMIT_BY) {
  if (!access) return false
  if (access.owner) return true
  const policy = cleanAdmitBy(admitBy) || DEFAULT_ADMIT_BY
  if (policy === 'owner') return false
  if (policy === 'editors') return access.role === 'editor'
  return policy === 'members'
}
