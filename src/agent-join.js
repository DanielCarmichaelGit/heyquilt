// `quilt agent join|whoami`: join Quilt as an agent from a terminal, the way an
// AI uses an invite link: send a short profile to the link, get keys back, and
// keep them in ~/.quilt/agents/<name>.json (readable only by you).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { quiltHome } from './legacy.js'
import { generateIdentity, signAgentResume } from './identity.js'
import { writePrivateJson } from './private-file.js'

export const DEFAULTS = { provider: 'Quilt CLI', type: 'command-line agent' }
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/
const NOT_A_LINK = "That doesn't look like an agent invite link. Copy the whole link from Quilt."
// Refresh a little early so the access key doesn't lapse mid-request.
const EARLY_MS = 60 * 1000
// A refresh lock is stale once the process holding it is gone; as a safety net, also once
// it is this old (a live holder never needs this long: its refresh times out first).
const LOCK_MAX_AGE_MS = 5 * 60 * 1000
const LOCK_RETRY_MS = 50
// A refresh the API has already done can't be undone: cutting it off loses the new keys,
// and the spent refresh key later revokes the agent. So it gets a long time to answer.
const REFRESH_TIMEOUT_MS = 120 * 1000
// How long to wait for another process's refresh before giving up: longer than a refresh can take.
const LOCK_WAIT_MS = 150 * 1000
/** For tests: how the refresh and lock timeouts nest. */
export const REFRESH_TIMING = Object.freeze({ refreshTimeoutMs: REFRESH_TIMEOUT_MS, lockWaitMs: LOCK_WAIT_MS, lockMaxAgeMs: LOCK_MAX_AGE_MS })

export function agentFile (name, dir = quiltHome()) {
  if (!NAME.test(String(name || ''))) throw new Error('--name must be 1 to 40 letters, numbers, dots, dashes or underscores')
  return path.join(dir, 'agents', `${name}.json`)
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** The API's address and the token in an invite link. Plain http is only
 * allowed for a local address (testing); anything else must be https. */
export function parseJoinLink (link) {
  let u
  try { u = new URL(String(link)) } catch { throw new Error(NOT_A_LINK) }
  const m = u.pathname.match(/^\/v1\/join\/(qj_[A-Za-z0-9_-]+)\/?$/)
  const protoOk = u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname))
  if (!m || !protoOk) throw new Error(NOT_A_LINK)
  return { api: u.origin, token: m[1] }
}

async function send (fetchImpl, api, method, route, body, key, extra = {}) {
  const res = await fetchImpl(String(api).replace(/\/+$/, '') + route, {
    ...extra,
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) }
}

/** Makes sure the agents directory exists, is not a symlink, and is private. */
function ensureAgentsDir (dir) {
  let st
  try { st = fs.lstatSync(dir) } catch (err) {
    if (err.code !== 'ENOENT') throw err
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    return
  }
  if (st.isSymbolicLink()) throw new Error(`Refusing to use ${dir}: it's a symlink`)
  // Tighten up permissions someone (or some older version) left too loose.
  if ((st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700)
}

/** Saves the agent's file privately (see private-file.js), in a private agents folder. */
function save (file, data) {
  ensureAgentsDir(path.dirname(file))
  writePrivateJson(file, data)
}

function load (file, name) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`No agent called ${name} here. Run: quilt agent join <link> --name ${name}`)
    throw new Error(`Couldn't read the saved agent file for ${name} (corrupt or unreadable): ${err.message}`)
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`Couldn't read the saved agent file for ${name} (corrupt or unreadable): ${err.message}`)
  }
}

/** Uses an invite link once and saves the agent's keys. */
export async function agentJoin ({ link, name, provider = DEFAULTS.provider, type = DEFAULTS.type, description = '', dir, fetch: fetchImpl = globalThis.fetch, log = console.log }) {
  const file = agentFile(name, dir)
  const { api, token } = parseJoinLink(link)
  // The agent's own Ed25519 key, for joining sessions in later versions.
  const identity = generateIdentity()
  const r = await send(fetchImpl, api, 'POST', `/v1/join/${token}`, { name, provider, type, description, publicKey: identity.publicKey })
  if (!r.ok) throw new Error(r.body?.error || `Couldn't join Quilt (${r.status}).`)
  const saved = { name, api, agentId: r.body.agentId, accessKey: r.body.accessKey, accessExpiresAt: r.body.accessExpiresAt, refreshKey: r.body.refreshKey, refreshExpiresAt: r.body.refreshExpiresAt, identity }
  save(file, saved)
  log(`Joined Quilt as ${name}. Keys saved in ${file}`)
  return saved
}

async function refresh (saved, file, fetchImpl) {
  const r = await send(fetchImpl, saved.api, 'POST', '/v1/agents/token', { refreshKey: saved.refreshKey }, null, { signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) })
  if (r.status === 401 && saved.identity) return resume(saved, file, fetchImpl, r)
  if (!r.ok) throw refused(r, `Couldn't refresh the agent's keys (${r.status}).`)
  return keep(saved, file, r.body)
}

/**
 * The refresh key was turned away: most often a refresh the API made whose reply never
 * arrived (the computer slept or went offline), so the key we kept was already spent and
 * the API revoked the agent's keys. The agent signs for the key it joined with and gets
 * new ones. `turnedAway` is the refresh's reply, the error to give if this fails too.
 */
async function resume (saved, file, fetchImpl, turnedAway) {
  // The API's clock, not a test's: the signature has to be close to it.
  const at = Date.now()
  const r = await send(fetchImpl, saved.api, 'POST', '/v1/agents/resume', { agentId: saved.agentId, at, signature: signAgentResume(saved.identity, saved.agentId, at) }, null, { signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) })
  if (r.ok) return keep(saved, file, r.body)
  // An API without resume, or that doesn't know the agent: the refresh's answer says what happened.
  if (r.status === 404) throw refused(turnedAway, `Couldn't refresh the agent's keys (${turnedAway.status}).`)
  // Revoked by a person, a signature that doesn't match, or a clock that's off: signed out.
  if (r.status === 400 || r.status === 401) throw Object.assign(refused(r, `Couldn't sign the agent back in (${r.status}).`), { status: 401 })
  throw refused(r, `Couldn't sign the agent back in (${r.status}).`)
}

const refused = (r, fallback) => Object.assign(new Error(r.body?.error || fallback), { status: r.status })

function keep (saved, file, body) {
  const next = { ...saved, accessKey: body.accessKey, accessExpiresAt: body.accessExpiresAt, refreshKey: body.refreshKey, refreshExpiresAt: body.refreshExpiresAt }
  // Save straight away: the old refresh key is spent, and using it again would revoke the agent.
  save(file, next)
  return next
}

/** A saved agent's file: { name, api, agentId, accessKey, refreshKey, …, identity }. */
export function readAgent ({ name, dir }) {
  return load(agentFile(name, dir), name)
}

const readLock = (lock) => { try { return fs.readFileSync(lock, 'utf8') } catch { return null } }

/** Whether a lock holding `contents` ("<pid>.<token>") and last changed at `mtimeMs` is stale. */
function lockIsStale (contents, mtimeMs) {
  if (Date.now() - mtimeMs > LOCK_MAX_AGE_MS) return true
  const pid = Number(String(contents).split('.')[0])
  // No pid yet (its holder has only just made it): only age can make it stale.
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    return err.code === 'ESRCH' // EPERM: running, as someone else
  }
}

/**
 * Removes the lock when its holder is gone, unless it changed while we looked.
 * Returns true when the lock is gone (so try to take it again). Two processes
 * removing one crashed holder's lock at the very same instant can both get in;
 * that needs a crash and a tie, so it is accepted. (`between` lets tests step in
 * between the two reads.)
 */
export function takeOverStale (lock, between = () => {}) {
  let seen, st
  try {
    seen = fs.readFileSync(lock, 'utf8')
    st = fs.statSync(lock)
  } catch {
    return true // gone already
  }
  if (!lockIsStale(seen, st.mtimeMs)) return false
  between()
  if (readLock(lock) !== seen) return false
  fs.rmSync(lock, { force: true })
  return true
}

/**
 * Runs `fn` holding `<file>.lock`, so only one process at a time refreshes an agent's
 * keys: a refresh key used twice gets the agent revoked for good.
 */
export async function withLock (file, fn) {
  const lock = `${file}.lock`
  const token = `${process.pid}.${crypto.randomBytes(8).toString('hex')}`
  const until = Date.now() + LOCK_WAIT_MS
  for (;;) {
    let fd = null
    try {
      fd = fs.openSync(lock, 'wx', 0o600)
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    if (fd !== null) {
      try { fs.writeSync(fd, token) } finally { fs.closeSync(fd) }
      try {
        return await fn()
      } finally {
        // Only our own lock, never one another process has since made.
        if (readLock(lock) === token) fs.rmSync(lock, { force: true })
      }
    }
    if (takeOverStale(lock)) continue
    if (Date.now() > until) throw new Error(`Another Quilt process is stuck refreshing the agent's keys. Remove ${lock} and try again.`)
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
  }
}

/** The saved agent with a working access key, refreshed first when it has (nearly) run out. */
export async function agentAccess ({ name, dir, fetch: fetchImpl = globalThis.fetch, now = Date.now }) {
  const file = agentFile(name, dir)
  const fresh = (saved) => saved.accessExpiresAt - EARLY_MS > now()
  const saved = load(file, name)
  if (fresh(saved)) return saved
  return withLock(file, () => {
    // Another process may have refreshed while we waited: use its keys.
    const latest = load(file, name)
    return fresh(latest) ? latest : refresh(latest, file, fetchImpl)
  })
}

/**
 * The API turned `accessKey` away before it ran out (its keys were revoked): signs back in
 * with the agent's key. Resolves to the saved agent with new keys, the keys another process
 * already got, or null for an agent without a key of its own.
 */
export async function agentResume ({ name, dir, accessKey, fetch: fetchImpl = globalThis.fetch }) {
  const file = agentFile(name, dir)
  return withLock(file, () => {
    const latest = load(file, name)
    if (latest.accessKey !== accessKey) return latest
    if (!latest.identity) return null
    return resume(latest, file, fetchImpl, { status: 401, body: { error: "This agent's keys were revoked. Invite it again." } })
  })
}

/** Who the agent is, refreshing its keys first when the access key has (nearly) run out. */
export async function agentWhoami ({ name, dir, fetch: fetchImpl = globalThis.fetch, now = Date.now }) {
  const saved = await agentAccess({ name, dir, fetch: fetchImpl, now })
  let r = await send(fetchImpl, saved.api, 'GET', '/v1/agents/me', null, saved.accessKey)
  if (r.status === 401) {
    const back = await agentResume({ name, dir, accessKey: saved.accessKey, fetch: fetchImpl })
    if (back) r = await send(fetchImpl, back.api, 'GET', '/v1/agents/me', null, back.accessKey)
  }
  if (!r.ok) throw new Error(r.body?.error || `Couldn't reach Quilt (${r.status}).`)
  return r.body
}

/** The names of the agents saved on this computer. */
export function savedAgents (dir = quiltHome()) {
  try {
    return fs.readdirSync(path.join(dir, 'agents')).filter((f) => f.endsWith('.json') && !f.startsWith('.')).map((f) => f.slice(0, -5)).sort()
  } catch {
    return []
  }
}

/** Which saved agent a session joins as: the one named, or the only one there is. */
export function pickAgent ({ agent, dir } = {}) {
  if (agent) return agent
  const all = savedAgents(dir)
  if (all.length === 1) return all[0]
  if (!all.length) throw new Error('This computer has no Quilt agent yet. The person you work with can invite one on heyquilt.com, then run: quilt agent join <link> --name <name>')
  throw new Error(`This computer has several Quilt agents (${all.join(', ')}). Say which one to join as.`)
}

export function describeAgent (me) {
  const where = me.agent.kind === 'org' ? `an agent in ${me.agent.org.name}` : 'your personal agent'
  const lines = [`${me.agent.name} (${me.agent.provider}, ${me.agent.type}): ${where}`]
  if (me.role) lines.push(`Role: ${me.role.name}`)
  for (const t of me.teams) lines.push(`Team ${t.name}: ${t.access}${t.scopes.length ? `, folders ${t.scopes.join(', ')}` : ''}`)
  return lines.join('\n')
}
