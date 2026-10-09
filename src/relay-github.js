// The relay's GitHub credentials for a session, from its owner's GitHub connection: the API mints
// them with Quilt's GitHub App for one repository at a time, and only when the owner's GitHub
// account may write to it (src/api/routes/github.js). The relay commits agents' work with them
// (relay-commit.js) and reads private repositories with them (relay-upstream.js), so an owner who
// connected GitHub never makes or pastes a token. Kept until a few minutes before they run out.

/**
 * { token } for owner/name (`full`), or { state } saying why not: 'not-connected' (the owner
 * hasn't connected GitHub), 'not-installed' (Quilt's app isn't on that repository), 'no-access'
 * (with `login`: the owner's GitHub account can't write there), 'off' (this relay has no API, or
 * the session has no account owner) or 'error'. Never throws.
 */
export async function appCredentials (room, full, { fresh = true } = {}) {
  const cfg = room.cfg || {}
  const owner = room.meta && room.meta.ownerSub
  if (!cfg.apiUrl || !cfg.relayApiSecret || !/^person:/.test(owner || '')) return { state: 'off' }
  const key = `${owner}\0${full}`.toLowerCase()
  const hit = room.appTokens && room.appTokens.get(key)
  if (hit && hit.token && hit.expiresAt - Date.now() > 5 * 60 * 1000) return { token: hit.token }
  // A "no" is remembered a minute (a commit) or ten (the relay's own looks at GitHub), so
  // sessions whose owner hasn't connected GitHub don't ask the API every time.
  if (hit && !hit.token && Date.now() - hit.at < (fresh ? 60 * 1000 : 10 * 60 * 1000)) return hit.no
  try {
    const res = await (room.apiFetch || globalThis.fetch)(`${String(cfg.apiUrl).replace(/\/+$/, '')}/v1/relay/github-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.relayApiSecret}` },
      body: JSON.stringify({ account: owner, repo: full })
    })
    const r = res.ok ? await res.json() : { state: 'error' }
    if (r.state === 'ok' && r.token) {
      if (!room.appTokens) room.appTokens = new Map()
      room.appTokens.set(key, { token: r.token, expiresAt: Number(r.expiresAt) || Date.now() + 30 * 60 * 1000 })
      return { token: r.token }
    }
    const no = { state: r.state || 'error', ...(r.login ? { login: r.login } : {}) }
    if (!room.appTokens) room.appTokens = new Map()
    room.appTokens.set(key, { no, at: Date.now() })
    return no
  } catch { return { state: 'error' } }
}
