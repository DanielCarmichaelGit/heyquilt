// A session's audit trail, for its owner: every visit (who, a person or an agent, through
// the app or as a hosted agent, with which tool), when it started and ended and why, and
// what it did in between. Pure: routes/sessions.js hands it rows from the store.
// The relay reports what it saw (see src/presence.js); this adds what only the accounts
// API knows: an agent whose keys were revoked had its visit end because of that.

// A hosted agent counts as gone after this long without a call (the relay's HOSTED_ONLINE_MS).
export const HOSTED_QUIET_MS = 30 * 60 * 1000
export const MAX_ACTIONS = 5000

export const REASON_TEXT = {
  left: 'Left',
  disconnected: 'Connection dropped',
  removed: 'Removed by the owner',
  pass_expired: 'Sign-in ran out',
  session_ended: 'Session ended',
  relay_restart: 'Relay restarted',
  idle: 'Done working (went quiet)',
  replaced: 'Reconnected',
  needs_update: 'Sent away to update',
  revoked: 'Access revoked'
}

/**
 * Why a visit ended, with what the relay couldn't know: an agent whose keys were revoked
 * while it was in, or before it would have come back, ended because of that.
 */
export function endReasonOf (v, revokedAt) {
  if (v.endedAt == null) return null
  const r = v.endReason || null
  if (revokedAt == null || revokedAt < v.startedAt) return r
  if (r === 'idle') return revokedAt <= v.endedAt + HOSTED_QUIET_MS ? 'revoked' : r
  if (r === 'pass_expired' || r === 'disconnected' || r == null) return revokedAt <= v.endedAt ? 'revoked' : r
  return r
}

/**
 * The trail: visits newest first, each with its actions oldest first.
 * `revoked` maps an agent account ('agent:<id>') to when its keys were revoked.
 */
export function auditTrail ({ visits, actions, revoked = new Map() }) {
  const byVisit = new Map()
  for (const a of actions) {
    if (!byVisit.has(a.visitStartId)) byVisit.set(a.visitStartId, [])
    byVisit.get(a.visitStartId).push({ at: a.at, action: a.action, target: a.target || '' })
  }
  return [...visits]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((v) => ({
      account: v.account,
      name: v.accountName,
      kind: v.kind,
      via: v.via || null,
      tool: v.tool || null,
      startedAt: v.startedAt,
      endedAt: v.endedAt ?? null,
      endReason: endReasonOf(v, revoked.get(v.account) ?? null),
      actions: (byVisit.get(v.eventStartId) || []).sort((a, b) => a.at - b.at)
    }))
}

const iso = (t) => (t == null ? '' : new Date(t).toISOString())
const cell = (x) => {
  const s = String(x ?? '')
  // A cell a spreadsheet would run as a formula is quoted as text.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** The trail as CSV, one row per event (joined, an action, left), oldest first, times in UTC. */
export function auditCsv (trail) {
  const rows = []
  for (const v of trail) {
    const who = [v.name, v.account, v.kind]
    const how = [v.via || '', v.tool || '']
    rows.push([v.startedAt, ...who, 'joined', '', ...how])
    for (const a of v.actions) rows.push([a.at, ...who, a.action, a.target, ...how])
    if (v.endedAt != null) rows.push([v.endedAt, ...who, 'left', v.endReason || '', ...how])
  }
  rows.sort((a, b) => a[0] - b[0])
  const head = ['time_utc', 'member', 'account', 'kind', 'event', 'detail', 'via', 'tool']
  return [head, ...rows.map(([t, ...rest]) => [iso(t), ...rest])].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}
