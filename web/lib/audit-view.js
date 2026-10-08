// The audit trail page (/dashboard/sessions/[room]/audit): wording for each visit and
// action, from the accounts API's trail (src/api/audit.js). Pure, so it's testable.
import { formatDate, formatTime } from './activity-view.js'

const REASONS = {
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

const ACTIONS = {
  created: 'Created',
  edited: 'Edited',
  deleted: 'Deleted',
  claimed: 'Claimed',
  released: 'Released',
  requested: 'Asked for',
  handed_off: 'Handed off',
  withdrew: 'Withdrew a request',
  messaged: 'Sent a message',
  task: 'Changed task',
  tool: 'Used'
}

/** Why a visit ended, in words; an open visit is "Still here". */
export function reasonText (v) {
  if (v.endedAt == null) return 'Still here'
  return REASONS[v.endReason] || 'Left'
}

/** How a member came in: "Quilt app · Cursor", "Hosted agent · Codex". */
export function howText (v) {
  const via = v.via === 'hosted' ? 'Hosted agent' : v.via === 'app' ? 'Quilt app' : ''
  const tool = v.tool && v.tool !== via ? v.tool : ''
  return [via, tool].filter(Boolean).join(' · ') || 'Unknown'
}

/** One action: its time, what was done, and on what. */
export function actionLine (a, tz = 'UTC') {
  return { time: formatTime(a.at, tz), what: ACTIONS[a.action] || a.action, target: a.target || '' }
}

/** A visit's span: its date, and from and to. */
export function spanText (v, tz = 'UTC') {
  const from = `${formatDate(v.startedAt, tz)}, ${formatTime(v.startedAt, tz)}`
  if (v.endedAt == null) return `${from} to now`
  const sameDay = formatDate(v.startedAt, tz) === formatDate(v.endedAt, tz)
  return `${from} to ${sameDay ? formatTime(v.endedAt, tz) : `${formatDate(v.endedAt, tz)}, ${formatTime(v.endedAt, tz)}`}`
}

/** Visits filtered by kind: 'all', 'agent' or 'person'. */
export function filterVisits (visits, kind) {
  return kind === 'agent' || kind === 'person' ? visits.filter((v) => v.kind === kind) : visits
}
