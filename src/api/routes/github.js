// Connecting GitHub (github-app.js): a person starts from the app or the website, GitHub asks them
// which repositories to install Quilt on and who they are, and comes back here. The relay then asks
// for a repository's credentials for a session's owner when an agent commits.
import crypto from 'node:crypto'
import { HttpError, Raw } from '../http.js'
import { githubApp, signState, readState, WRITE_ROLES, GitHubAppError } from '../github-app.js'

const PART = /^[A-Za-z0-9_.-]{1,100}$/
const ACCOUNT = /^person:([A-Za-z0-9_-]{1,64})$/
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest()
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/** The page GitHub sends people back to: plain, so it works from any browser. */
const page = (title, text) => new Raw(200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#fdf6f0;color:#2b2420;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}main{max-width:420px;text-align:center}h1{font-size:22px}</style>
<main><h1>${esc(title)}</h1><p>${esc(text)}</p></main>`, 'text/html; charset=utf-8')

export function githubRoutes ({ store, person, bearer, relaySecret, github: cfg, githubFetch, now, log }) {
  const app = cfg ? githubApp(cfg, { fetch: githubFetch, now }) : null
  const need = () => { if (!app) throw new HttpError(503, 'GitHub is not set up on this server') }
  const fromRelay = (req) => {
    if (!relaySecret) throw new HttpError(503, 'the relay is not set up on this server')
    if (!crypto.timingSafeEqual(digest(bearer(req)), digest(relaySecret))) throw new HttpError(401, 'only the relay may ask for this')
  }
  // Credentials per account and repository, kept until a few minutes before they run out.
  const cache = new Map()

  return [
    // Where to send a person to connect GitHub: installing the app, then back to the callback.
    ['POST', /^\/v1\/github\/connect$/, async (req) => {
      need()
      const { userId } = await person(req)
      return { url: app.installUrl(signState(cfg, userId, now())) }
    }],
    ['GET', /^\/v1\/me\/github$/, async (req) => {
      const { userId } = await person(req)
      const link = await store.githubLink(userId)
      return { available: !!app, connected: !!link, ...(link ? { login: link.login } : {}) }
    }],
    ['DELETE', /^\/v1\/me\/github$/, async (req) => {
      const { userId } = await person(req)
      await store.deleteGithubLink(userId)
      cache.clear()
      return { ok: true }
    }],
    // GitHub sends the person back here after the install, with who they are (code) and our state.
    ['GET', /^\/v1\/github\/(callback|setup)$/, async (req) => {
      need()
      const q = new URL(req.url, 'http://x').searchParams
      const userId = readState(cfg, q.get('state'), now())
      if (!userId) return page('Start from Quilt', 'Open Quilt and click Connect GitHub in the commit panel, so Quilt knows which account to connect. Quilt is installed on GitHub either way.')
      if (!q.get('code')) return page('GitHub did not sign you in', 'Try Connect GitHub again from Quilt.')
      let who
      try { who = await app.whoAuthorized(q.get('code')) } catch (err) { log(`github connect: ${err.message}`); return page('GitHub did not sign you in', 'Try Connect GitHub again from Quilt.') }
      await store.setGithubLink(userId, { githubId: who.id, login: who.login })
      cache.clear()
      return page(`Connected as @${who.login}`, 'Your agents can now commit to the repositories you installed Quilt on, as far as each session allows. You can close this tab.')
    }],
    // GitHub's events. Only a hint to look again: nothing in one is trusted (the relay asks GitHub itself).
    ['POST', /^\/v1\/github\/webhook$/, async () => ({ ok: true }), { maxBody: 1024 * 1024 }],
    // The relay, for an agent's commit: credentials for one repository, for the session's owner.
    ['POST', /^\/v1\/relay\/github-token$/, async (req, b) => {
      fromRelay(req)
      need()
      const m = ACCOUNT.exec(String(b.account || ''))
      const [owner, name] = String(b.repo || '').split('/')
      if (!m || !PART.test(owner || '') || !PART.test(name || '')) throw new HttpError(400, 'give the owner account and the repository (owner/name)')
      const link = await store.githubLink(m[1])
      if (!link) return { state: 'not-connected' }
      const key = `${m[1]}\0${owner}/${name}`.toLowerCase()
      const hit = cache.get(key)
      if (hit && hit.expiresAt - now() > 5 * 60 * 1000) return { state: 'ok', ...hit }
      try {
        const inst = await app.installation(owner, name)
        if (!inst) return { state: 'not-installed', login: link.login, installUrl: `https://github.com/apps/${cfg.slug}/installations/new` }
        const t = await app.repoToken(inst, name)
        const role = await app.role(t.token, owner, name, link.login)
        if (!WRITE_ROLES.includes(role)) return { state: 'no-access', login: link.login, role }
        const out = { token: t.token, expiresAt: t.expiresAt, login: link.login }
        cache.set(key, out)
        return { state: 'ok', ...out }
      } catch (err) {
        if (err instanceof GitHubAppError) { log(`github token for ${owner}/${name}: ${err.message}`); return { state: 'error', error: err.message } }
        throw err
      }
    }]
  ]
}
