// Org permissions: a grid of resources × create/read/update/delete. Pure, so the
// API and the website (web/lib/permissions.js is a copy) agree on every check.

export const OPS = ['c', 'r', 'u', 'd']

// Which checkboxes each row has. Cells the spec marks "—" aren't ops at all;
// Billing is reserved for per-seat plans and has none yet.
export const ALLOWED = {
  org: ['r', 'u'],
  members: ['r', 'u', 'd'],
  agents: ['c', 'r', 'u', 'd'],
  teams: ['c', 'r', 'u', 'd'],
  team_members: ['c', 'r', 'u', 'd'],
  invites: ['c', 'r', 'u', 'd'],
  roles: ['c', 'r', 'u', 'd'],
  workspaces: ['c', 'r', 'u', 'd'],
  billing: []
}

export const RESOURCES = Object.keys(ALLOWED)

export const LABELS = {
  org: 'Org settings',
  members: 'Members',
  agents: 'Agents',
  teams: 'Teams',
  team_members: 'Team membership',
  invites: 'User invites',
  roles: 'Roles',
  workspaces: 'Workspaces',
  billing: 'Billing'
}

// Checkbox values arrive as true, 'on' or 'true' depending on who sends them.
const truthy = (v) => v === true || v === 1 || v === 'true' || v === 'on'

/** Keeps only real rows and ops, as `{ resource: { op: true } }` with no false cells. */
export function normalizeGrants (input) {
  const out = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out
  for (const resource of RESOURCES) {
    if (!Object.hasOwn(input, resource)) continue
    const row = input[resource]
    if (!row || typeof row !== 'object') continue
    const ops = {}
    for (const op of ALLOWED[resource]) if (truthy(row[op])) ops[op] = true
    if (Object.keys(ops).length) out[resource] = ops
  }
  return out
}

export function can (grants, resource, op) {
  return !!(Object.hasOwn(ALLOWED, resource) && ALLOWED[resource].includes(op) && truthy(grants?.[resource]?.[op]))
}

/** True when every checkbox in `a` is also in `b` — the no-self-promotion rule. */
export function isSubset (a, b) {
  return Object.entries(normalizeGrants(a)).every(([resource, ops]) => Object.keys(ops).every((op) => can(b, resource, op)))
}

const everything = () => Object.fromEntries(RESOURCES
  .filter((r) => ALLOWED[r].length)
  .map((r) => [r, Object.fromEntries(ALLOWED[r].map((op) => [op, true]))]))

// Owner is also special-cased in every check (always allowed, never editable or
// assignable); its stored grid is just "everything" for display.
export const BUILTIN = {
  owner: everything(),
  admin: everything(),
  member: { teams: { r: true }, workspaces: { r: true } }
}
