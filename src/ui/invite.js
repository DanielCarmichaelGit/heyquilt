// Invite link helpers: pure functions only, no Node built-ins, so this one file loads
// unmodified in the CLI/runner (Node) and in the app's browser UI. Both sides build and
// parse invite links here; nowhere else should match these shapes with its own regex.
import { agentGuide } from './agent-guide.js'

/** Where invites live on the website. The relay is implied: Quilt's own. */
export const JOIN_HOST = 'join.heyquilt.com'
export const JOIN_URL = `https://${JOIN_HOST}`

export const MISSING_SECRET = 'This link is missing part of it. Ask for a new invite.'
export const INVALID_INVITE = 'That invite link is not valid. Copy the whole link they sent.'

// A room name becomes a folder name when joining, so it may never carry a path.
const ROOM = /^[A-Za-z0-9_-]{1,64}$/

function base64urlToJson (raw) {
  try {
    return JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')))
  } catch {
    return null
  }
}

/**
 * An invite link: https://join.heyquilt.com/<room>#<secret> for sessions on Quilt's relay, or
 * https://<relay>/join/<room>#<secret> for any other relay (development relays). The secret
 * sits after `#`, so browsers never send it anywhere. `isHosted(server)` tells the forms apart.
 */
export function buildInvite (c, isHosted) {
  const room = encodeURIComponent(c.room)
  const secret = encodeURIComponent(c.secret || '')
  if (isHosted(c.server)) return `${JOIN_URL}/${room}#${secret}`
  const base = String(c.server).replace(/\/+$/, '').replace(/^ws(s?):\/\//, 'http$1://')
  return `${base}/join/${room}#${secret}`
}

/**
 * Reads an invite link (or an older base64 code), with or without "quilt join" or "quilt:" in
 * front. A join.heyquilt.com link has no relay of its own (`relay: null`, caller fills in
 * Quilt's relay) and throws MISSING_SECRET if its secret is missing. An old-style relay link
 * keeps its own relay, but only if `allowRelay(relay)` says yes: a link must never point the
 * app at a relay it doesn't already use. Throws INVALID_INVITE when nothing matches, the room
 * isn't a plain name, or the relay isn't allowed.
 */
export function parseInvite (code, { allowRelay = () => false } = {}) {
  const raw = String(code || '').trim().replace(/^quilt join\s+/, '').replace(/^quilt:/, '').split(/\s/)[0].replace(/^["']|["']$/g, '')
  const j = raw.match(/^https:\/\/join\.heyquilt\.com\/([A-Za-z0-9_-]{1,64})\/?(?:#(.*))?$/)
  if (j) {
    let secret = ''
    try { secret = decodeURIComponent(j[2] || '') } catch {}
    if (!secret) throw new Error(MISSING_SECRET)
    return { relay: null, room: j[1], secret }
  }
  let r = null
  const m = raw.match(/^(https?):\/\/(.+)\/join\/([^/#?]+)\/?(?:#(.*))?$/)
  if (m) {
    try {
      r = { relay: `${m[1] === 'https' ? 'wss' : 'ws'}://${m[2]}`, room: decodeURIComponent(m[3]), secret: decodeURIComponent(m[4] || '') }
    } catch {}
  }
  if (!r) {
    const j2 = base64urlToJson(raw)
    if (j2 && j2.s && j2.r) r = { relay: String(j2.s), room: String(j2.r), secret: String(j2.k || '') }
  }
  if (!r || !ROOM.test(r.room) || !allowRelay(r.relay)) throw new Error(INVALID_INVITE)
  return r
}

/**
 * What to paste into an AI so it joins Quilt as your agent: `link` is a one-time agent
 * invite from the accounts API, `invite` (optional) the session to join once it has.
 * Plain text, with the commands the AI (or the person) runs.
 */
export function agentPaste ({ link, invite = null, name = 'my-agent' } = {}) {
  const lines = [
    'Join Quilt as my AI agent.',
    `1. Register (once; the link works one time, within an hour): run \`quilt agent join ${link} --name ${name}\`. Pick a short name instead of ${name} if you like.`
  ]
  lines.push(invite
    ? `2. Join my session: use the quilt_join_session tool with ${invite}, or run \`quilt join ${invite} --agent ${name}\` in the project folder.`
    : '2. To join one of my sessions later, use the quilt_join_session tool with the invite link I send you, or run `quilt join <invite link> --agent <name>` in the project folder.')
  lines.push('The quilt command comes with the Quilt app (menu: Install the Quilt Command…).')
  lines.push(`If you cannot run commands, open ${link} instead and follow it to join over HTTP.`)
  let apiUrl
  try { apiUrl = new URL(link).origin } catch {}
  lines.push('', agentGuide({ apiUrl }))
  return lines.join('\n')
}
