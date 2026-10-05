// src/api/server.js
// The Quilt accounts API: links desktop apps to accounts (a device-code flow, like
// signing in to a TV app) and manages agents. Plain node:http, like the relay.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { newToken, hashToken, newUserCode, normalizeUserCode } from './tokens.js'
import { parsePublicKey, verifyDeviceLink } from '../identity.js'
import { signPass, passPublicKey, PASS_VERSION, PASS_TTL_MS } from '../passes.js'
import { HttpError, Raw } from './http.js'
import { DiskStore } from './file-store.js'
import { orgRoutes } from './routes/orgs.js'
import { memberRoutes } from './routes/members.js'
import { teamRoutes } from './routes/teams.js'
import { inviteRoutes } from './routes/invites.js'
import { agentRoutes } from './routes/agents.js'
import { makeAgentAuth } from './agent-auth.js'
import { agentInviteRoutes } from './routes/agent-invites.js'
import { joinRoutes } from './routes/join.js'
import { relayRoutes } from './routes/relay.js'
import { sessionRoutes } from './routes/sessions.js'
import { accessTypeRoutes } from './routes/access-types.js'
import { grantRoutes } from './routes/grants.js'
import { sessionInviteRoutes } from './routes/session-invites.js'
import { workspaceRoutes } from './routes/workspaces.js'
import { workspaceFileRoutes } from './routes/workspace-files.js'
import { HOSTED_RELAY } from '../settings.js'
import { roomAccess } from './access.js'
import { parseInvite } from '../ui/invite.js'
import { issueRoutes } from './routes/issues.js'
import { routeName, cleanEvent } from './issues.js'

const API_VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')).version

const LINK_TTL_MS = 10 * 60 * 1000
const ROOM = /^[A-Za-z0-9_-]{1,64}$/
// An approved link the app never collects stops working this long after its code expires.
const COLLECT_GRACE_MS = 5 * 60 * 1000
const POLL_INTERVAL_S = 3
const MAX_BODY = 16 * 1024
// A hosted agent's MCP request (a whole file, at most) and how long it may take on the relay.
const MAX_MCP_BODY = 2 * 1024 * 1024
const MCP_TIMEOUT_MS = 30 * 1000
// A pass minted for a hosted agent is reused until this close to its end: 5 minutes, so
// a change to its grant reaches it as soon as it reaches a connected app.
const PASS_REUSE_MARGIN_MS = 5 * 60 * 1000

export function startApi ({ port = 0, host = '127.0.0.1', store, verifyUser, siteUrl, apiUrl = 'https://api.heyquilt.com', mailer = { send: async () => { throw new Error('no mailer configured') } }, now = Date.now, log = () => {}, startLimit = 10, inviteLimit = 10, inviteSendLimit = 20, tokenLimit = 30, joinLimit = 20, trustProxy = false, maxStartKeys = 10_000, passKey = '', passLimit = 60, relayUrl = HOSTED_RELAY, mcpLimit = 600, reportKey = '', reportLimit = 10, slowMs = 2000, pruneEveryMs = 60 * 60 * 1000, keepEventsMs = 30 * 24 * 60 * 60 * 1000, keepIssuesMs = 90 * 24 * 60 * 60 * 1000, pruneStartMs = 10_000, relaySecret = '', workspaces = false, fileStore = null, maxFileBytes = 500 * 1024 * 1024, workspaceQuotaBytes = 5 * 1024 * 1024 * 1024, maxWorkspaceFiles = 2000 }) {
  // PASS_SIGNING_KEY. A bad one should stop the API at start, not fail every pass later.
  if (passKey) passPublicKey(passKey)
  const site = String(siteUrl || '').replace(/\/+$/, '')
  // Where agents reach this API: invite links and the join instructions point here.
  const api = String(apiUrl).replace(/\/+$/, '')
  // Workspace files' bytes: the API's own disk (signed links it serves itself) unless a
  // store (Supabase) was given. Defaulted so tests and a plain local run need nothing.
  const files = fileStore || new DiskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-api-files-')))
  // The relay that hosts the agents' MCP (/mcp here hands requests on to it).
  const relay = String(relayUrl).replace(/\/+$/, '').replace(/^ws(s?):\/\//, 'http$1://')

  const bearer = (req) => (String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i) || [])[1] || ''
  async function user (req) {
    const u = await verifyUser(bearer(req))
    if (!u) throw new HttpError(401, 'sign in first')
    return u
  }

  async function device (req) {
    const d = await store.deviceByToken(hashToken(bearer(req)))
    if (!d) throw new HttpError(401, 'this computer is signed out')
    await store.touchDevice(d.id)
    return d
  }

  /** A signed-in person, from the website (JWT) or from the app on a linked computer (qd_ token). */
  async function person (req) {
    if (bearer(req).startsWith('qd_')) return { userId: (await device(req)).userId, email: '' }
    return user(req)
  }

  // A few tries per minute per address is plenty for a person. Behind Fly,
  // Fly-Client-IP is the real peer; X-Forwarded-For isn't used because Fly appends
  // to whatever the client sent, so its first entry is client-controlled.
  // `keyOf` lets a limiter key on something other than the caller's IP (e.g. a
  // signed-in user id for invite sending) and `windowMs` lets it use a longer window.
  function makeLimiter (limit, message, { windowMs = 60_000, keyOf } = {}) {
    const hits = new Map()
    const byIp = (req) => (trustProxy && String(req.headers['fly-client-ip'] || '').trim()) || req.socket.remoteAddress
    const check = (req) => {
      const key = (keyOf || byIp)(req)
      const recent = (hits.get(key) || []).filter((t) => now() - t < windowMs)
      if (recent.length >= limit) throw new HttpError(429, message)
      hits.set(key, [...recent, now()])
      // Keep the map bounded: forget keys with nothing in the last window.
      if (hits.size > maxStartKeys) for (const [k, ts] of hits) if (ts.every((t) => now() - t >= windowMs)) hits.delete(k)
    }
    check.size = () => hits.size
    return check
  }
  const limitStarts = makeLimiter(startLimit, 'too many sign-in attempts; try again in a minute')
  const limitInvites = makeLimiter(inviteLimit, 'too many tries; wait a minute and try again')
  // Sending (or resending) an email invite, capped per signed-in user rather than per IP.
  const limitInviteSend = makeLimiter(inviteSendLimit, 'too many invites sent; wait a bit and try again', { windowMs: 60 * 60_000, keyOf: (userId) => userId })
  const limitTokens = makeLimiter(tokenLimit, 'too many key refreshes; try again in a minute')
  const limitJoin = makeLimiter(joinLimit, 'too many tries; wait a minute and try again')
  // Passes, per token (keyed on its hash, counted once the token checks out).
  const limitPasses = makeLimiter(passLimit, 'too many passes; try again in a minute', { keyOf: (tokenHash) => tokenHash })
  // Reports with no sign-in (the app before it's linked): a few batches a minute per address.
  const limitReports = makeLimiter(reportLimit, 'too many reports; try again in a minute')
  const agentAuth = makeAgentAuth({ store, now, bearer })
  // Hosted MCP calls, per agent.
  const limitMcp = makeLimiter(mcpLimit, 'too many requests; slow down', { keyOf: (agentId) => agentId })

  /** Who a pass is for: a linked computer's account, or an agent and the key it registered. */
  async function passHolder (req) {
    if (bearer(req).startsWith('qa_')) {
      const { agent } = await agentAuth.agentFromRequest(req)
      // No key: a hosted agent. Its pass works over HTTPS (the relay's /mcp), never for a WebSocket.
      return { sub: agent.id, kind: 'agent', name: agent.name.slice(0, 64), key: agent.publicKey || '' }
    }
    const d = await device(req)
    const p = await store.profile(d.userId)
    return { sub: d.userId, kind: 'person', name: ((p && p.name) || 'Quilt user').slice(0, 64), key: d.publicKey }
  }

  const needPassKey = () => { if (!passKey) throw new HttpError(503, 'passes are not set up on this server') }

  /**
   * A signed pass for `holder`. For a room, it also carries the room, when it was issued
   * (the relay won't let an older pass undo a removal), what its holder may do there
   * (see access.js), and a person's confirmed email.
   */
  async function mintPass (holder, room) {
    const iat = now()
    const exp = iat + PASS_TTL_MS
    const payload = { v: PASS_VERSION, ...holder, exp }
    if (room) {
      const mail = holder.kind === 'person' ? await store.userEmail(holder.sub) : null
      const email = mail?.confirmed ? String(mail.email || '').toLowerCase() : ''
      Object.assign(payload, { room, iat, access: await roomAccess(store, room, `${holder.kind}:${holder.sub}`, email) }, email ? { email } : {})
    }
    return { pass: signPass(payload, passKey), expiresAt: exp }
  }

  /** A person's profile and sign-in email, which the app keeps in account.json. */
  async function profileWithEmail (userId) {
    const p = await store.profile(userId)
    return p && { ...p, email: (await store.userEmail(userId))?.email || '' }
  }

  const COLOR = /^#[0-9a-fA-F]{6}$/
  function cleanProfile (b) {
    const out = {}
    if (b.name !== undefined) { const n = String(b.name).trim().slice(0, 60); if (!n) throw new HttpError(400, 'name is empty'); out.name = n }
    if (b.color !== undefined) { if (b.color !== null && !COLOR.test(b.color)) throw new HttpError(400, 'color must be #RRGGBB'); out.color = b.color }
    if (b.tool !== undefined) out.tool = b.tool === null ? null : String(b.tool).slice(0, 40)
    return out
  }

  const routes = [
    ['GET', /^\/healthz$/, async () => ({ ok: true })],

    ['POST', /^\/v1\/device\/start$/, async (req, body) => {
      limitStarts(req)
      const { publicKey, deviceName, platform } = body
      if (!parsePublicKey(publicKey)) throw new HttpError(400, 'publicKey must be an Ed25519 key (spki, base64url)')
      const deviceCode = newToken('dc_')
      let userCode
      do userCode = newUserCode(); while (await store.linkByUserCode(userCode))
      await store.createLink({
        deviceCodeHash: hashToken(deviceCode), userCode, publicKey,
        deviceName: String(deviceName || 'A computer').slice(0, 80), platform: String(platform || '').slice(0, 20),
        expiresAt: now() + LINK_TTL_MS
      })
      return { deviceCode, userCode, verificationUrl: `${site}/link?code=${userCode}`, interval: POLL_INTERVAL_S, expiresIn: LINK_TTL_MS / 1000 }
    }],

    ['POST', /^\/v1\/device\/poll$/, async (req, body) => {
      const link = await store.linkByDeviceCode(hashToken(body.deviceCode))
      if (!link) throw new HttpError(404, 'unknown device code')
      const waiting = link.status === 'pending' || link.status === 'approving'
      if (link.status === 'consumed' || (waiting && link.expiresAt < now())) throw new HttpError(410, 'expired')
      if (link.status === 'approved' && link.expiresAt + COLLECT_GRACE_MS < now()) throw new HttpError(410, 'expired')
      if (link.status === 'denied') throw new HttpError(403, 'denied')
      // Pending polls skip the signature check so the app can poll cheaply; they
      // reveal nothing. Only collecting the token needs proof of the key.
      if (waiting) return [202, { status: 'pending' }]
      // Proof of possession: anyone can start a link with a computer's public key
      // (it's shared with session members), but only the computer can sign for it.
      if (!verifyDeviceLink(parsePublicKey(link.publicKey), String(body.deviceCode), body.signature)) throw new HttpError(401, "this computer's signature doesn't match")
      // Approved: claim the link before minting, so two polls racing on the same
      // link can't both win a token — only the caller that flips it gets one.
      if (!await store.claimLink(link.id, 'approved', 'consumed')) throw new HttpError(410, 'expired')
      const token = newToken('qd_')
      await store.setDeviceToken(link.deviceId, hashToken(token))
      return { status: 'approved', token, profile: await profileWithEmail(link.userId) }
    }],

    ['GET', /^\/v1\/device\/link\/([^/]+)$/, async (req, body, [code]) => {
      await user(req)
      const link = await openLink(code)
      return { userCode: link.userCode, deviceName: link.deviceName, platform: link.platform, expiresAt: link.expiresAt }
    }],

    ['POST', /^\/v1\/device\/approve$/, async (req, body) => {
      const u = await user(req)
      const link = await openLink(body.userCode)
      // Claim the link first, so two approvals racing on one code can't both make a device.
      if (!await store.claimLink(link.id, 'pending', 'approving')) throw new HttpError(410, 'this code has expired or was already used')
      if (!body.approve) { await store.updateLink(link.id, { status: 'denied', userId: u.userId }); return { status: 'denied' } }
      let device
      try {
        device = await store.upsertDevice({ userId: u.userId, name: link.deviceName, platform: link.platform, publicKey: link.publicKey })
      } catch (err) {
        // Put the link back so the person can retry rather than being stuck mid-approval.
        await store.updateLink(link.id, { status: 'pending' }).catch(() => {})
        throw err
      }
      await store.updateLink(link.id, { status: 'approved', userId: u.userId, deviceId: device.id })
      return { status: 'approved', device: { id: device.id, name: device.name } }
    }],

    ['GET', /^\/v1\/me$/, async (req) => {
      const d = await device(req)
      return { profile: await profileWithEmail(d.userId), device: { id: d.id, name: d.name } }
    }],

    ['PUT', /^\/v1\/me\/profile$/, async (req, body) => {
      const d = await device(req)
      const patch = cleanProfile(body)
      if (!Object.keys(patch).length) return { profile: await store.profile(d.userId) }
      return { profile: await store.updateProfile(d.userId, patch) }
    }],

    ['POST', /^\/v1\/me\/signout$/, async (req) => {
      const d = await device(req)
      await store.revokeDevice(d.id)
      return { ok: true }
    }],

    // A pass lets its holder into sessions on the relay for 10 minutes (see src/passes.js).
    // With { room }, it is for that room only and carries what its holder may do there.
    ['POST', /^\/v1\/passes$/, async (req, body) => {
      needPassKey()
      const holder = await passHolder(req)
      limitPasses(hashToken(bearer(req)))
      if (body.room !== undefined && !ROOM.test(String(body.room))) throw new HttpError(400, 'room must be a session name')
      return mintPass(holder, body.room)
    }],

    // The relay's QUILT_PASS_PUBLIC_KEY. Public: it only checks passes.
    ['GET', /^\/v1\/passes\/key$/, async () => {
      needPassKey()
      return { publicKey: passPublicKey(passKey) }
    }],

    ['DELETE', /^\/v1\/me\/account$/, async (req) => {
      const u = await user(req)
      // Every org keeps exactly one owner, so an owner hands it on (or deletes it) first.
      if ((await store.orgsForUser(u.userId)).some((o) => o.ownerId === u.userId)) throw new HttpError(409, 'you own an org; transfer it or delete it first')
      await store.deleteUser(u.userId)
      return { ok: true }
    }]
  ]

  // Org routes live in their own modules and share the caller check and the limiter.
  const ctx = { store, user, person, device, bearer, now, site, apiUrl: api, mailer, log, limit: limitInvites, limitSend: limitInviteSend, limitTokens, limitJoin, agentAuth, reportKey, limitReports, relaySecret, files, maxFileBytes, workspaceQuotaBytes, maxWorkspaceFiles }
  routes.push(...orgRoutes(ctx), ...memberRoutes(ctx), ...teamRoutes(ctx), ...inviteRoutes(ctx), ...agentRoutes(ctx), ...agentInviteRoutes(ctx), ...joinRoutes(ctx), ...relayRoutes(ctx), ...sessionRoutes(ctx), ...accessTypeRoutes(ctx), ...grantRoutes(ctx), ...sessionInviteRoutes(ctx), ...issueRoutes(ctx))
  // Always routed: with the flag off each answers a plain 404 of its own, so the app's
  // check at every launch isn't filed as a missing route.
  routes.push(...workspaceRoutes({ ...ctx, workspaces }))
  const wsFiles = workspaceFileRoutes({ ...ctx, workspaces })
  routes.push(...wsFiles.routes)

  async function openLink (code) {
    const userCode = normalizeUserCode(code)
    const link = userCode && await store.linkByUserCode(userCode)
    if (!link) throw new HttpError(404, 'no such code')
    if (link.status !== 'pending' || link.expiresAt < now()) throw new HttpError(410, 'this code has expired or was already used')
    return link
  }

  // The API's own trouble, straight into the store: no-route 404s, crashes (5xx) and
  // slow requests of any status; the 4xx a route throws on purpose (including a
  // deliberate 404, like an expired invite or an org you've left) is only kept when
  // it was slow, and then as `slow`, never as an error. Never awaited by the request,
  // and a failure to record is only logged — nothing here may escape and disturb an
  // already-sent reply.
  function recordOwn ({ method, pathname, status, startedAt, message, noRoute }) {
    try {
      const durationMs = now() - startedAt
      const slow = durationMs > slowMs
      const crash = status >= 500
      const http404 = status === 404 && noRoute
      if (!crash && !http404 && !slow) return
      // A scanner path outside /v1/ (wp-login.php, .env, …) has no route shape worth
      // keeping per-path; group every one of those under one name instead of letting
      // each distinct path become its own permanent issue.
      const name = http404 && !pathname.startsWith('/v1/') ? `${method} (no route)` : routeName(method, pathname)
      const event = cleanEvent({
        kind: http404 ? 'http404' : 'action',
        name,
        outcome: crash || http404 ? 'error' : 'slow',
        status, durationMs, message
      }, { surface: 'api', appVersion: API_VERSION, now })
      Promise.resolve().then(() => store.recordEvents([event])).catch((err) => log(`issue record failed: ${err?.message || err}`))
    } catch (err) { log(`issue record failed: ${err?.message || err}`) }
  }

  const server = http.createServer(async (req, res) => {
    const startedAt = now()
    // The parsed pathname (not the raw url string) decides this: it's what a route
    // actually matches against, so "/v1/../v1/join/x" counts as a join link too.
    let pathname
    try { pathname = new URL(req.url, 'http://x').pathname } catch { pathname = '' }
    // Join links are secrets in a URL: never cache them, and ask crawlers not to index them.
    const extra = pathname.startsWith('/v1/join/') ? { 'x-robots-tag': 'noindex' } : {}
    const send = (status, data, type = 'application/json', message = '', noRoute = false) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra, ...cors(req) })
      res.end(type === 'application/json' ? JSON.stringify(data) : data)
      recordOwn({ method: req.method, pathname, status, startedAt, message, noRoute })
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'cache-control': 'no-store', ...extra, ...cors(req), 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE', 'access-control-allow-headers': 'authorization,content-type', 'access-control-max-age': '600' })
      return res.end()
    }
    try {
      if (pathname.startsWith('/v1/file-data/') && files instanceof DiskStore) return await serveFileData(req, res, send, pathname.slice('/v1/file-data/'.length))
      if (pathname === '/mcp') return await proxyMcp(req, res, send)
      const url = new URL(req.url, 'http://x')
      const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname))
      if (!route) throw Object.assign(new HttpError(404, 'not found'), { noRoute: true })
      // A route may take a bigger body than usual (the relay's presence reports): route[3].maxBody.
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req, route[3]?.maxBody || MAX_BODY) : {}
      const out = await route[2](req, body, url.pathname.match(route[1]).slice(1).map(decodePart))
      if (out instanceof Raw) send(out.status, out.body, out.type)
      else if (Array.isArray(out)) send(out[0], out[1])
      else send(200, out)
    } catch (err) {
      // A unique index said no. Agents share one index on their public key; everything
      // else that's unique (a taken team or role name) gets the generic message.
      if (err?.code === '23505') {
        const detail = `${err.constraint || ''} ${err.message || ''} ${err.details || ''}`
        return send(409, { error: detail.includes('public_key') ? 'That public key already belongs to an agent.' : 'that name is already taken' })
      }
      // A foreign-key check said no (something from another org, or still referenced): a conflict, not a crash.
      if (err?.code === '23503') return send(409, { error: 'that is still in use' })
      // Supabase errors are plain objects, so fall back to their JSON.
      if (!(err instanceof HttpError)) log(`api error: ${err?.stack || err?.message || JSON.stringify(err)}`)
      send(err.status || 500, { error: err instanceof HttpError ? err.message : 'internal error' }, 'application/json', err instanceof HttpError ? err.message : String(err?.message || err?.stack || JSON.stringify(err) || 'error'), !!err.noRoute)
    }
  })

  // Hosted agents' MCP: the agent's access key signs it in here; the relay gets the same
  // request with a pass for the agent, and its answer comes straight back. Stateless on
  // both sides, so each request stands alone. The pass is for the room the agent is joining
  // (named in quilt_join_session) or is in (the relay says which in x-quilt-room), so it
  // carries the agent's grant there.
  const mintedPasses = new Map() // `${agent id}\n${room}` -> { pass, exp }
  const agentRooms = new Map() // agent id -> the room the relay last said it is in
  const forget = (map) => { if (map.size > maxStartKeys) map.delete(map.keys().next().value) }
  async function proxyMcp (req, res, send) {
    needPassKey()
    if (!bearer(req).startsWith('qa_')) throw new HttpError(401, 'send your agent access key as "Authorization: Bearer <accessKey>"')
    const { agent } = await agentAuth.agentFromRequest(req)
    limitMcp(agent.id)
    const body = ['POST', 'PUT'].includes(req.method) ? await readRaw(req, MAX_MCP_BODY) : undefined
    const holder = { sub: agent.id, kind: 'agent', name: agent.name.slice(0, 64), key: agent.publicKey || '' }
    const passFor = async (room) => {
      const cacheKey = `${agent.id}\n${room}`
      let minted = mintedPasses.get(cacheKey)
      if (!minted || minted.exp - now() < PASS_REUSE_MARGIN_MS) {
        const { pass, expiresAt } = await mintPass(holder, room)
        minted = { pass, exp: expiresAt }
        mintedPasses.set(cacheKey, minted)
        if (mintedPasses.size > maxStartKeys) for (const [k, v] of mintedPasses) if (v.exp <= now()) mintedPasses.delete(k)
        forget(mintedPasses)
      }
      return minted.pass
    }
    const ask = async (room) => {
      const headers = { 'x-quilt-pass': await passFor(room) }
      for (const h of ['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id']) if (req.headers[h]) headers[h] = String(req.headers[h])
      try {
        return await fetch(`${relay}/mcp`, { method: req.method, headers, body, signal: AbortSignal.timeout(MCP_TIMEOUT_MS) })
      } catch (err) {
        log(`mcp relay error: ${err.message}`)
        throw new HttpError(502, 'the session relay did not answer; try again in a moment')
      }
    }
    const room = joiningRoom(body) || agentRooms.get(agent.id) || ''
    let upstream = await ask(room)
    // The relay needs a pass for the room the agent is in (this server forgot it, after a
    // restart): ask again, once, with one for the room it names. Tool calls are only refused
    // there, never carried out, so the same call is safe to send again.
    const named = upstream.headers.get('x-quilt-room') || ''
    if (upstream.headers.get('x-quilt-retry') === 'room-pass' && ROOM.test(named) && named !== room) {
      await upstream.arrayBuffer().catch(() => {})
      upstream = await ask(named)
    }
    if (upstream.ok) {
      const inRoom = upstream.headers.get('x-quilt-room') || ''
      if (ROOM.test(inRoom)) { agentRooms.set(agent.id, inRoom); forget(agentRooms) } else agentRooms.delete(agent.id)
    }
    const type = upstream.headers.get('content-type') || 'application/json'
    const out = Buffer.from(await upstream.arrayBuffer())
    res.writeHead(upstream.status, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(out)
  }

  // The disk store's links: PUT streams an upload to the API's disk within the signed size; GET streams it back.
  async function serveFileData (req, res, send, key) {
    const q = new URL(req.url, 'http://x').searchParams
    const method = req.method
    if (!['PUT', 'GET'].includes(method) || q.get('m') !== method) return send(405, { error: 'method not allowed' })
    const size = method === 'PUT' ? Number(q.get('n')) : undefined
    const name = q.get('name') || ''
    const type = q.get('type') || ''
    if (!files.verify(key, method, q.get('exp'), q.get('sig'), size, name, type)) return send(403, { error: 'this link is not valid' })
    const file = files.file(key)
    if (method === 'PUT') {
      const tmp = `${file}.part`
      let out = null
      let failed = null
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        out = fs.createWriteStream(tmp)
        // Without this, a write failure (disk full, permission denied) is an
        // unhandled 'error' event on the stream, which crashes the whole process.
        out.on('error', (err) => { failed = failed || err })
        let got = 0
        for await (const chunk of req) {
          if (failed) throw failed
          got += chunk.length
          if (got > size) throw new HttpError(413, 'more bytes than the link allows')
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
          if (failed) throw failed
        }
        if (failed) throw failed
        await new Promise((resolve, reject) => out.end((err) => (err || failed ? reject(err || failed) : resolve())))
        fs.renameSync(tmp, file)
        return send(200, { ok: true })
      } catch (err) {
        if (out) out.destroy()
        fs.rmSync(tmp, { force: true })
        return send(err.status || 500, { error: err.message })
      }
    }
    let stat
    try { stat = fs.statSync(file) } catch { return send(404, { error: 'not found' }) }
    const headers = { 'content-type': type || 'application/octet-stream', 'content-length': stat.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...cors(req) }
    if (name) headers['content-disposition'] = `attachment; filename="${name.replace(/["\r\n]/g, '')}"`
    res.writeHead(200, headers)
    fs.createReadStream(file).pipe(res)
  }

  // Only the website may call the API from a browser.
  function cors (req) {
    return site && req.headers.origin === site ? { 'access-control-allow-origin': site, vary: 'origin' } : {}
  }

  // Events are the detail (kept 30 days); issues are the summary people read (kept
  // 90 days, so slower-moving problems don't vanish while their events still would).
  async function pruneNow () {
    try { await store.pruneEvents(now() - keepEventsMs) } catch (err) { log(`issue prune failed: ${err?.message || err}`) }
    try { await store.pruneIssues(now() - keepIssuesMs) } catch (err) { log(`issue prune failed: ${err?.message || err}`) }
    // Workspace files: uploads that never landed, and deleted files past their 30 days
    // (only with the flag on: before then the tables may not exist yet).
    if (workspaces) try { await wsFiles.sweep() } catch (err) { log(`file sweep failed: ${err?.message || err}`) }
  }
  const prune = setInterval(() => { pruneNow() }, pruneEveryMs)
  prune.unref()
  // Also soon after start, since every deploy restarts the hourly clock.
  const firstPrune = setTimeout(() => { pruneNow() }, pruneStartMs)
  firstPrune.unref()

  return new Promise((resolve) => server.listen(port, host, () => {
    const p = server.address().port
    resolve({ port: p, url: `http://${host}:${p}`, close: () => { clearInterval(prune); clearTimeout(firstPrune); return new Promise((r) => server.close(r)) }, startKeys: () => limitStarts.size(), sweepFiles: (at) => wsFiles.sweep(at) })
  }))
}

/** The room a quilt_join_session call in this MCP request joins, or '' (any other request). */
export function joiningRoom (body) {
  if (!body || !body.length) return ''
  try {
    const msg = JSON.parse(body.toString('utf8'))
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      if (m?.method === 'tools/call' && m.params?.name === 'quilt_join_session') return parseInvite(String(m.params.arguments?.invite || ''), { allowRelay: () => true }).room
    }
  } catch {}
  return ''
}

function decodePart (s) {
  try { return decodeURIComponent(s) } catch { throw new HttpError(400, 'bad path') }
}

function readRaw (req, max) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', (c) => { size += c.length; if (size > max) { req.destroy(); reject(new HttpError(413, 'too large')) } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function readJson (req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); reject(new HttpError(413, 'too large')) } else chunks.push(c) })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return reject(new HttpError(400, 'bad json')) }
      // Handlers read fields off the body; null, arrays and scalars carry none.
      resolve(body && typeof body === 'object' && !Array.isArray(body) ? body : {})
    })
    req.on('error', reject)
  })
}
