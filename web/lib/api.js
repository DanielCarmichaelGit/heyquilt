import 'server-only'
import { report } from './report.js'

// Calls the Quilt accounts API as the signed-in person (server-side only: the API
// address and the person's token never need to reach the browser for this).
// A call that fails (no answer, a 404 or a 5xx) or takes over 3 s is reported as an issue;
// the 4xx a route answers on purpose (409 "taken", 400 "empty") is the API working.
const SLOW_MS = 3000
// The query string goes first: a token followed by one would otherwise survive the
// replacements below untouched. Mirrors routeName (src/api/issues.js): an org slug groups
// under :slug (unless it's already an :id), and a device-link code groups under :code.
const nameOf = (method, path) => `${method} ${path.split('?')[0]
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
  .replace(/\/orgs\/(?!:id\b)[^/]+/, '/orgs/:slug')
  .replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/g, '/:token')
  .replace(/\/[A-Z0-9]{4}-[A-Z0-9]{4}(?=\/|$)/g, '/:code')}`.slice(0, 80)

export async function apiCall (user, method, path, body, { expect404 = false } = {}) {
  // Missing config must fail loudly in production rather than silently calling "undefined/v1/..."
  if (!process.env.QUILT_API_URL && process.env.NODE_ENV === 'production') {
    throw new Error('QUILT_API_URL is not set')
  }
  const started = Date.now()
  let result
  try {
    const res = await fetch(process.env.QUILT_API_URL + path, {
      method,
      headers: { authorization: `Bearer ${user.accessToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      // A hung API request would otherwise leave the page waiting forever.
      signal: AbortSignal.timeout(15000)
    })
    result = { ok: res.ok, status: res.status, data: await res.json().catch(() => null) }
  } catch {
    result = { ok: false, status: 0, data: null }
  }
  const durationMs = Date.now() - started
  const failed = result.status === 0 || (result.status === 404 && !expect404) || result.status >= 500
  if (failed || durationMs > SLOW_MS) {
    // Fire-and-forget: a report never delays the page. If the function host ends the request
    // before it lands, the report is lost, which is acceptable.
    report({ kind: 'action', name: nameOf(method, path), outcome: failed ? 'error' : 'slow', status: result.status || undefined, durationMs, message: failed ? (result.data?.error || `Quilt answered ${result.status}`) : '', userId: user?.id || null }).catch(() => {})
  }
  return result
}
