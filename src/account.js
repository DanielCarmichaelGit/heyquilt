// This computer's sign-in: the token the accounts API gave it when you approved
// it on heyquilt.com, kept in ~/.quilt/account.json (readable only by you).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { quiltHome } from './legacy.js'
import { signDeviceLink } from './identity.js'
import { isSymlink, writePrivateJson } from './private-file.js'

export const API_URL = 'https://api.heyquilt.com'
export const NOT_SIGNED_IN = 'Run quilt login first.'
export const SIGNED_OUT = 'This computer was signed out. Sign in again.'

/** The accounts API. QUILT_API_URL overrides it, for development and tests. */
export const apiUrl = () => String(process.env.QUILT_API_URL || API_URL).replace(/\/+$/, '')
export const accountFile = () => path.join(quiltHome(), 'account.json')

/** { token, account: { id, name, email }, signedInAt }, or null when signed out (or the file is a symlink or unreadable). */
export function readAccount (file = accountFile()) {
  try {
    if (isSymlink(file)) return null
    const a = JSON.parse(fs.readFileSync(file, 'utf8'))
    return a && typeof a.token === 'string' && a.token.startsWith('qd_') && a.account ? a : null
  } catch {
    return null
  }
}

export function saveAccount (data, file = accountFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  writePrivateJson(file, data)
  return data
}

export function clearAccount (file = accountFile()) {
  fs.rmSync(file, { force: true })
}

const BAD_REPLY = 'The sign-in service sent an unexpected reply. Try again.'

/** { id, name, email }, from a profile the server sent back. Throws clearly rather than
 * crashing when the server sent something unexpected (no profile at all). */
export const accountFromProfile = (p) => {
  if (!p || typeof p !== 'object') throw new Error(BAD_REPLY)
  return { id: p.id, name: p.name, email: p.email || '' }
}

async function call (fetchImpl, api, method, route, body, token, extra = {}) {
  let res
  try {
    res = await fetchImpl(api + route, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      ...extra
    })
  } catch (err) {
    throw new Error(`Couldn't reach Quilt (${err.cause?.code || err.message}).`)
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) throw Object.assign(new Error(data?.error || `Quilt answered ${res.status}.`), { status: res.status })
  // A 2xx with a body that isn't JSON (or is `null`/not an object) isn't something callers
  // can use: better a clear message than a crash on whatever field they read next.
  if (!data || typeof data !== 'object') throw new Error(BAD_REPLY)
  return data
}

/** Starts linking this computer to an account: { deviceCode, userCode, verificationUrl, interval, expiresIn }. */
export async function startLink ({ identity, api = apiUrl(), fetch: fetchImpl = globalThis.fetch } = {}) {
  return call(fetchImpl, api, 'POST', '/v1/device/start', {
    publicKey: identity.publicKey,
    deviceName: os.hostname().replace(/\.local$/, ''),
    platform: process.platform
  })
}

/** One poll: { status: 'pending' } or { status: 'approved', token, profile }. Throws with .status 410 (expired) or 403 (declined). */
export async function pollLink ({ identity, deviceCode, api = apiUrl(), fetch: fetchImpl = globalThis.fetch } = {}) {
  return call(fetchImpl, api, 'POST', '/v1/device/poll', { deviceCode, signature: signDeviceLink(identity, deviceCode) })
}

/**
 * Polls at the link's interval until someone approves it on the website.
 * Rejects with .expired, .denied, or .cancelled (once `stopped()` says so).
 */
export async function waitForLink ({ identity, link, api, fetch, stopped = () => false, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now }) {
  const until = now() + link.expiresIn * 1000
  while (now() < until) {
    await sleep(link.interval * 1000)
    if (stopped()) throw Object.assign(new Error('Signing in was cancelled.'), { cancelled: true })
    let r
    try {
      r = await pollLink({ identity, deviceCode: link.deviceCode, api, fetch })
    } catch (err) {
      if (err.status === 410) break
      if (err.status === 403) throw Object.assign(new Error('Sign-in was declined in the browser.'), { denied: true })
      // A network error, a transient 5xx, or 429 (rate limited): try again at the next
      // interval rather than giving up on the sign-in. Anything else (400, 401, 404, …) is fatal.
      if (err.status && !(err.status >= 500 || err.status === 429)) throw err
      continue
    }
    if (r.status === 'approved') return r
  }
  throw Object.assign(new Error('The code expired.'), { expired: true })
}

/** Your profile ({ id, name, email, … }) from this computer's token. Throws with .status 401 once it's revoked. */
export async function fetchMe ({ token, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  return (await call(fetchImpl, api, 'GET', '/v1/me', null, token)).profile
}

/**
 * The owner renames a session on heyquilt.com: { session: { room, name } }. Throws with
 * .status: 404 until the relay has reported the session, 403 for anyone but the owner.
 */
export async function renameSession ({ token, room, name, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  return call(fetchImpl, api, 'PUT', `/v1/me/sessions/${encodeURIComponent(room)}`, { name }, token)
}

/**
 * Forgets this computer's sign-in right away, then tries to revoke the token on the
 * server (best effort: it may be revoked already, or Quilt unreachable or slow). The
 * file goes first so a stuck or slow server can never make `quilt logout` hang.
 */
export async function signOut ({ token, api = apiUrl(), fetch: fetchImpl = globalThis.fetch, file = accountFile(), revokeTimeoutMs = 5000 } = {}) {
  clearAccount(file)
  await revokeToken({ token, api, fetch: fetchImpl, timeoutMs: revokeTimeoutMs })
}

/** A one-time agent invite link for this computer's account: { link, id, expiresAt }. Throws with .status 401 once the token is revoked. */
export async function createAgentInvite ({ token, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'POST', '/v1/agent-invites', {}, token)
  if (!r.link || !r.invite) throw new Error(BAD_REPLY)
  return { link: r.link, id: r.invite.id, expiresAt: r.invite.expiresAt }
}

/** This account's agents (not revoked), as the API lists them. Throws with .status 401 once the token is revoked. */
export async function listAgents ({ token, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'GET', '/v1/agents', null, token)
  if (!Array.isArray(r.agents)) throw new Error(BAD_REPLY)
  return r.agents
}

// Access types, grants and session invites, as this computer's account (see
// docs/superpowers/specs/2026-10-02-access-types-and-invites-design.md). Each throws with
// .status when the API says no (401 once the token is revoked).
const room$ = (room) => `/v1/sessions/${encodeURIComponent(room)}`

/** The built-in access types, then this account's own. */
export async function listAccessTypes ({ token, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'GET', '/v1/access-types', null, token)
  if (!Array.isArray(r.types)) throw new Error(BAD_REPLY)
  return r.types
}

/** People and agents this account has worked with: [{ account, name, kind, lastTogetherAt }]. */
export async function listCollaborators ({ token, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'GET', '/v1/me/collaborators', null, token)
  if (!Array.isArray(r.collaborators)) throw new Error(BAD_REPLY)
  return r.collaborators
}

/** The owner's grants in a session: [{ account, typeId, typeName, tighten, access }]. */
export async function listGrants ({ token, room, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'GET', `${room$(room)}/grants`, null, token)
  if (!Array.isArray(r.grants)) throw new Error(BAD_REPLY)
  return r.grants
}

/** Gives `account` an access type in the owner's session, narrowed by `tighten`: the grant, with the access it comes to. */
export async function putGrant ({ token, room, account, typeId, tighten = {}, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'PUT', `${room$(room)}/grants/${encodeURIComponent(account)}`, { typeId, tighten }, token)
  if (!r.grant || !r.grant.access) throw new Error(BAD_REPLY)
  return r.grant
}

export async function deleteGrant ({ token, room, account, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  await call(fetchImpl, api, 'DELETE', `${room$(room)}/grants/${encodeURIComponent(account)}`, null, token)
}

/** Invites `to` ({ email } or { account }) to the owner's session as `typeId`. `link` is the session's invite link, for the email. */
export async function inviteToSession ({ token, room, typeId, to, link, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'POST', `${room$(room)}/invites`, { typeId, to, link }, token)
  if (!r.invite) throw new Error(BAD_REPLY)
  return r.invite
}

export async function listSessionInvites ({ token, room, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'GET', `${room$(room)}/invites`, null, token)
  if (!Array.isArray(r.invites)) throw new Error(BAD_REPLY)
  return r.invites
}

export async function cancelSessionInvite ({ token, room, id, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  await call(fetchImpl, api, 'DELETE', `${room$(room)}/invites/${encodeURIComponent(id)}`, null, token)
}

// Workspaces (see docs/superpowers/specs/2026-10-03-workspaces-design.md). Each throws with
// .status when the API says no: 404 when the workspaces flag is off on the API.
const ws$ = (id) => `/v1/workspaces/${encodeURIComponent(id)}`

/** The orgs this account belongs to ({ slug, name, ... }), for "Where" a new workspace goes. */
export async function listOrgs ({ token, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'GET', '/v1/orgs', null, token)
  if (!Array.isArray(r.orgs)) throw new Error(BAD_REPLY)
  return r.orgs
}

export async function listWorkspaces ({ token, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'GET', '/v1/me/workspaces', null, token)
  if (!Array.isArray(r.workspaces)) throw new Error(BAD_REPLY)
  return r.workspaces
}
export async function createWorkspace ({ token, name, description = '', color = '', org, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'POST', '/v1/workspaces', { name, description, color, ...(org ? { org } : {}) }, token)
  if (!r.workspace) throw new Error(BAD_REPLY)
  return r.workspace
}
export async function getWorkspace ({ token, id, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'GET', ws$(id), null, token)
  if (!r.workspace) throw new Error(BAD_REPLY)
  return r
}
export async function updateWorkspace ({ token, id, patch, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'PATCH', ws$(id), patch, token)
  if (!r.workspace) throw new Error(BAD_REPLY)
  return r.workspace
}
export async function deleteWorkspace ({ token, id, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  await call(fetchImpl, api, 'DELETE', ws$(id), null, token)
}
export async function putWorkspaceMember ({ token, id, account, access, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'PUT', `${ws$(id)}/members/${encodeURIComponent(account)}`, { access }, token)
  if (!r.member) throw new Error(BAD_REPLY)
  return r.member
}
export async function removeWorkspaceMember ({ token, id, account, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  await call(fetchImpl, api, 'DELETE', `${ws$(id)}/members/${encodeURIComponent(account)}`, null, token)
}
export async function setSessionWorkspace ({ token, id, room, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'POST', `${ws$(id)}/sessions`, { room }, token)
  if (!r.session) throw new Error(BAD_REPLY)
  return r.session
}
export async function unsetSessionWorkspace ({ token, id, room, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  await call(fetchImpl, api, 'DELETE', `${ws$(id)}/sessions/${encodeURIComponent(room)}`, null, token)
}

// Workspace files (phase 2). Each throws with .status when the API says no.
const file$ = (id, fileId) => `${ws$(id)}/files/${encodeURIComponent(fileId)}`
export async function listWorkspaceFiles ({ token, id, folder, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'GET', `${ws$(id)}/files${folder !== undefined ? `?folder=${encodeURIComponent(folder)}` : ''}`, null, token)
  if (!Array.isArray(r.files)) throw new Error(BAD_REPLY)
  return r.files
}
export async function createWorkspaceFile ({ token, id, path, size, mime = '', sha256 = '', note = '', api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'POST', `${ws$(id)}/files`, { path, size, mime, sha256, note }, token)
  if (!r.file || !r.upload) throw new Error(BAD_REPLY)
  return r
}
export async function confirmWorkspaceFile ({ token, id, fileId, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'POST', `${file$(id, fileId)}/done`, {}, token)
  if (!r.file) throw new Error(BAD_REPLY)
  return r.file
}
export async function workspaceFileDownload ({ token, id, fileId, version, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'GET', `${file$(id, fileId)}/download${version ? `?version=${encodeURIComponent(version)}` : ''}`, null, token)
  if (!r.url) throw new Error(BAD_REPLY)
  return r
}
export async function updateWorkspaceFile ({ token, id, fileId, patch, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'PATCH', file$(id, fileId), patch, token)
  if (!r.file) throw new Error(BAD_REPLY)
  return r.file
}
export async function deleteWorkspaceFile ({ token, id, fileId, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  await call(fetchImpl, api, 'DELETE', file$(id, fileId), null, token)
}
export async function createWorkspaceFolder ({ token, id, path, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'POST', `${ws$(id)}/folders`, { path }, token)
  if (!r.file) throw new Error(BAD_REPLY)
  return r.file
}
export async function listWorkspaceFileVersions ({ token, id, fileId, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'GET', `${file$(id, fileId)}/versions`, null, token)
  if (!Array.isArray(r.versions)) throw new Error(BAD_REPLY)
  return r.versions
}

/** Revokes a token on the server, best effort, without touching account.json. */
export async function revokeToken ({ token, api = apiUrl(), fetch: fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  if (token) await call(fetchImpl, api, 'POST', '/v1/me/signout', {}, token, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => {})
}
