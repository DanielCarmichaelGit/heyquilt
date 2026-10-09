// Quilt's GitHub App ("Quilt by heyquilt"): a person connects their GitHub account once, installs
// the app on the repositories they choose, and from then on the relay commits agents' work there
// (relay-commit.js) with short-lived credentials made for one repository at a time. Nobody creates
// or pastes a token, and nobody needs to be online.
//
// The app's private key lives only on this API. The relay asks for a repository's credentials
// for a session's owner (routes/github.js); they are given only when the owner's GitHub account
// may write to that repository, so a session can't point agents at a repository its owner can't
// push to just because the app is installed there.
//
// GitHub is the first host. The relay only sees { token, expiresAt } for a repository, so other
// hosts (GitLab, Bitbucket, Azure DevOps, Gitea) can be added the same way.
import crypto from 'node:crypto'

const API = 'https://api.github.com'
export const WRITE_ROLES = ['admin', 'maintain', 'write']
// What the relay's credentials may do: commit (contents, workflow files) and open pull requests.
export const COMMIT_PERMISSIONS = { contents: 'write', pull_requests: 'write', workflows: 'write', metadata: 'read' }

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')

/** The app's settings from the environment, or null when it isn't set up. The key may be base64 of the PEM. */
export function appConfig (env = process.env) {
  const id = String(env.GITHUB_APP_ID || '').trim()
  let key = String(env.GITHUB_APP_PRIVATE_KEY || '').trim()
  if (key && !key.includes('BEGIN')) { try { key = Buffer.from(key, 'base64').toString('utf8') } catch { key = '' } }
  const cfg = { id, key, slug: String(env.GITHUB_APP_SLUG || '').trim(), clientId: String(env.GITHUB_APP_CLIENT_ID || '').trim(), clientSecret: String(env.GITHUB_APP_CLIENT_SECRET || '').trim() }
  return cfg.id && cfg.key.includes('PRIVATE KEY') && cfg.slug && cfg.clientId && cfg.clientSecret ? cfg : null
}

/** The app's own sign-in (a JWT, ten minutes at most), for asking GitHub about installations. */
export function appJwt (cfg, now = Date.now()) {
  const iat = Math.floor(now / 1000) - 60 // GitHub's clock may be a little behind
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify({ iat, exp: iat + 9 * 60, iss: cfg.id }))
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), cfg.key)
  return `${head}.${body}.${b64url(sig)}`
}

/** A link's `state`: who started connecting (signed, for ten minutes), so the callback knows whose account it is. */
export function signState (cfg, userId, now = Date.now()) {
  const payload = `${userId}.${now + 10 * 60 * 1000}`
  const mac = crypto.createHmac('sha256', cfg.clientSecret).update(payload).digest('hex').slice(0, 32)
  return `${payload}.${mac}`
}

/** The user id in a state made by signState, or null (forged, or older than ten minutes). */
export function readState (cfg, state, now = Date.now()) {
  const m = /^([A-Za-z0-9_-]{1,64})\.(\d{1,16})\.([0-9a-f]{32})$/.exec(String(state || ''))
  if (!m) return null
  const want = crypto.createHmac('sha256', cfg.clientSecret).update(`${m[1]}.${m[2]}`).digest('hex').slice(0, 32)
  if (!crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[3]))) return null
  return Number(m[2]) >= now ? m[1] : null
}

export class GitHubAppError extends Error {
  constructor (status, message) { super(message); this.status = status }
}

/** The calls the API makes to GitHub for the app. `fetch` is for tests. */
export function githubApp (cfg, { fetch = globalThis.fetch, now = Date.now } = {}) {
  const call = async (method, url, { auth, body, form } = {}) => {
    const res = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
      method,
      headers: { 'user-agent': 'quilt-api', accept: 'application/json', 'x-github-api-version': '2022-11-28', ...(auth ? { authorization: auth } : {}), ...(body || form ? { 'content-type': 'application/json' } : {}) },
      ...(body || form ? { body: JSON.stringify(body || form) } : {})
    })
    let json = null
    try { json = await res.json() } catch {}
    if (!res.ok) throw new GitHubAppError(res.status, (json && json.message) || `GitHub answered ${res.status}`)
    return json
  }
  const asApp = () => `Bearer ${appJwt(cfg, now())}`
  return {
    /** The link that installs the app (or changes which repositories it has), carrying `state`. */
    installUrl: (state) => `https://github.com/apps/${cfg.slug}/installations/new?state=${encodeURIComponent(state)}`,
    /** Who signed in on GitHub: the code from the callback, exchanged and asked. { id, login }. */
    async whoAuthorized (code) {
      const t = await call('POST', 'https://github.com/login/oauth/access_token', { form: { client_id: cfg.clientId, client_secret: cfg.clientSecret, code } })
      if (!t || !t.access_token) throw new GitHubAppError(400, (t && (t.error_description || t.error)) || 'GitHub did not sign you in')
      const u = await call('GET', '/user', { auth: `Bearer ${t.access_token}` })
      return { id: Number(u.id), login: String(u.login) }
    },
    /** The app's installation on owner/name, or null when it isn't installed there. */
    async installation (owner, name) {
      try { return (await call('GET', `/repos/${owner}/${name}/installation`, { auth: asApp() })).id } catch (err) { if (err.status === 404) return null; throw err }
    },
    /** Credentials for one repository of an installation, for about an hour: { token, expiresAt }. */
    async repoToken (installationId, name) {
      const r = await call('POST', `/app/installations/${installationId}/access_tokens`, { auth: asApp(), body: { repositories: [name], permissions: COMMIT_PERMISSIONS } })
      return { token: r.token, expiresAt: Date.parse(r.expires_at) || now() + 50 * 60 * 1000 }
    },
    /** What `login` may do in owner/name ('admin', 'maintain', 'write', 'triage', 'read' or 'none'), asked with `token`. */
    async role (token, owner, name, login) {
      try {
        const r = await call('GET', `/repos/${owner}/${name}/collaborators/${encodeURIComponent(login)}/permission`, { auth: `Bearer ${token}` })
        return String((r && (r.role_name || r.permission)) || 'none')
      } catch (err) { if (err.status === 404 || err.status === 403) return 'none'; throw err }
    }
  }
}
