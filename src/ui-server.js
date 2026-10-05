// Local web UI: start/join sessions, chat, share files, see collaborators.
// Listens on 127.0.0.1 only and requires a per-launch token, so web pages you
// visit can't drive it.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { runSession, decodeInvite, newConn, readConfig, recentSessions, forgetRecent, rememberWorkspace, forgetWorkspace } from './runner.js'
import { MAX_SHARED_FILE_BYTES } from './protocol.js'
import { getSettings, saveSettings, unsupportedRelay, relayUrl } from './settings.js'
import * as gitops from './git.js'
import { installedEditors, openIn } from './editors.js'
import { migrateDir } from './legacy.js'
import { writePrivateJson } from './private-file.js'
import { readAccount, saveAccount, clearAccount, startLink, waitForLink, fetchMe, signOut, revokeToken, accountFromProfile, renameSession, createAgentInvite, listAgents, listAccessTypes, listCollaborators, listGrants, putGrant, deleteGrant, inviteToSession, listSessionInvites, cancelSessionInvite, listWorkspaces, listOrgs, createWorkspace, getWorkspace, updateWorkspace, deleteWorkspace, putWorkspaceMember, removeWorkspaceMember, setSessionWorkspace } from './account.js'
import { effectiveAccess, builtinType } from './session-access.js'
import { cleanSessionName, BAD_SESSION_NAME, SESSION_NAME_MAX } from './session-name.js'
import { personPasses } from './pass-source.js'
import { INVALID_INVITE } from './ui/invite.js'
import { loadIdentity } from './identity.js'
import { currentVersion, localReleases, latestRelease, compareVersions, downloadUrl, seenVersion, markSeen } from './releases.js'
import { createReporter } from './report.js'

const TOOL_NAMES = ['Claude Code', 'Cursor', 'Codex', 'Windsurf', 'GitHub Copilot', 'Zed', 'Aider', 'Other']
const COLOR_RE = /^#[0-9a-f]{6}$/i
const THEMES = ['light', 'dark', 'system']
const SAVE_FAILED = "Quilt couldn't save your sign-in on this computer."
const SIGNED_OUT_MESSAGE = 'This computer was signed out. Sign in again.'
const LOCAL_RELAY_GONE = "This session ran on your computer's own relay, which Quilt no longer supports. Your files are untouched."
// Until this computer is signed in, only these answer.
const OPEN_ROUTES = new Set(['GET /api/account', 'POST /api/account/start', 'POST /api/account/cancel', 'POST /api/account/signout', 'GET /api/events', 'POST /api/shutdown', 'POST /api/report'])

/** Your profile and preferences, from ~/.quilt/settings.json with sensible defaults. */
function profile () {
  const s = getSettings()
  const account = readAccount()
  return {
    name: account ? account.account.name : os.userInfo().username,
    tool: s.tool || detectTool(),
    color: s.color || null,
    joinDir: s.joinDir || '~/quilt',
    shareAgent: s.shareAgent !== false,
    summarize: !!s.summarize,
    preferLocal: !!s.preferLocal,
    theme: THEMES.includes(s.theme) ? s.theme : 'light',
    report: s.report !== false
  }
}

/** Checks and saves profile/preference changes. Returns the new profile. */
function updateProfile (b) {
  const patch = {}
  // Your name is your account's: it's changed on the website.
  if ('name' in b) throw httpError(400, 'Change your name on heyquilt.com.')
  if ('tool' in b) {
    if (!TOOL_NAMES.includes(b.tool)) throw httpError(400, 'Pick an AI tool from the list.')
    patch.tool = b.tool
  }
  if ('color' in b) {
    if (b.color && !COLOR_RE.test(b.color)) throw httpError(400, 'That color isn\'t valid.')
    patch.color = b.color || undefined
  }
  if ('joinDir' in b) patch.joinDir = String(b.joinDir || '').trim() || undefined
  if ('shareAgent' in b) patch.shareAgent = b.shareAgent ? undefined : false
  if ('summarize' in b) patch.summarize = b.summarize ? true : undefined
  if ('preferLocal' in b) patch.preferLocal = b.preferLocal ? true : undefined
  if ('theme' in b) {
    if (!THEMES.includes(b.theme)) throw httpError(400, 'Pick Light, Dark or System.')
    patch.theme = b.theme === 'light' ? undefined : b.theme
  }
  if ('report' in b) patch.report = b.report ? undefined : false
  saveSettings(patch) // undefined values clear a setting
  return profile()
}

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui')
const LOGO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'logo.svg')
// Fonts are bundled from npm so the app works offline and never calls a font CDN.
const FONT_PACKAGES = ['poppins', 'ibm-plex-mono']
const require = createRequire(import.meta.url)
const fontFile = (pkg, file) => {
  if (!FONT_PACKAGES.includes(pkg) || !/^[a-z0-9-]+\.woff2$/.test(file)) return null
  const f = path.join(path.dirname(require.resolve(`@fontsource/${pkg}/package.json`)), 'files', file)
  return fs.existsSync(f) ? f : null
}
// Every module src/ui/*.js imports must be listed here, or the page fails to load (test/ui-static-allowlist.test.js).
export const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/common.js': ['common.js', 'text/javascript; charset=utf-8'],
  '/mark.js': ['mark.js', 'text/javascript; charset=utf-8'],
  '/invite.js': ['invite.js', 'text/javascript; charset=utf-8'],
  '/access-form.js': ['access-form.js', 'text/javascript; charset=utf-8'],
  '/session.js': ['session.js', 'text/javascript; charset=utf-8'],
  '/chat.js': ['chat.js', 'text/javascript; charset=utf-8'],
  '/feed.js': ['feed.js', 'text/javascript; charset=utf-8'],
  '/tool-logo.js': ['tool-logo.js', 'text/javascript; charset=utf-8'],
  '/tree.js': ['tree.js', 'text/javascript; charset=utf-8'],
  '/fileview.js': ['fileview.js', 'text/javascript; charset=utf-8'],
  '/merges.js': ['merges.js', 'text/javascript; charset=utf-8'],
  '/home.js': ['home.js', 'text/javascript; charset=utf-8'],
  '/signin.js': ['signin.js', 'text/javascript; charset=utf-8'],
  '/git.js': ['git.js', 'text/javascript; charset=utf-8'],
  '/releases.js': ['releases.js', 'text/javascript; charset=utf-8'],
  '/feed-convs.js': ['feed-convs.js', 'text/javascript; charset=utf-8'],
  '/board.js': ['board.js', 'text/javascript; charset=utf-8'],
  '/workspaces.js': ['workspaces.js', 'text/javascript; charset=utf-8']
}

// The page's Content-Security-Policy: scripts only from our own files (no inline script or
// event handlers, the second line of defence against injected markup), fonts and the event
// stream from this server, inline style attributes allowed since the UI sets them, and
// Google's favicon service (plus its gstatic.com redirect hosts) for provider logos.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://www.google.com https://*.gstatic.com",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ')

// preview: for development only (`quilt ui --preview`). Opening the bare address hands out the
// link, so a dev preview pane can show the app. Any local page could then open it too.
export async function startUi ({ port = 7420, onShutdown, preview = false, reporter, slowMs = 3000 } = {}) {
  // What this app tells Quilt about itself (see report.js). Off with the "report" setting.
  reporter = reporter || createReporter({ token: () => readAccount()?.token || null, enabled: () => getSettings().report !== false })
  // Body fields worth keeping with a route's outcome: which editor, which kind of start. Never free text.
  const CONTEXT_FIELDS = { 'POST /api/sessions/:id/open-in': ['app'], 'POST /api/sessions': ['mode', 'tool', 'prefer'] }
  const contextFor = (key, body) => Object.fromEntries((CONTEXT_FIELDS[key] || []).filter((f) => typeof body?.[f] === 'string').map((f) => [f, body[f].slice(0, 40)]))
  // Not recorded: reports about reports. (The event stream never reaches the dispatch block
  // below — it returns earlier — so it needs no entry here.)
  const UNRECORDED = new Set(['POST /api/report'])
  function recordRoute (key, { startedAt, status, body, error }) {
    // The reporter's own `enabled()` is the single gate on the "report" setting.
    if (UNRECORDED.has(key)) return
    const durationMs = Date.now() - startedAt
    const outcome = error ? 'error' : durationMs > slowMs ? 'slow' : 'ok'
    // A successful read (GET) isn't worth a row: the renderer polls and refreshes
    // constantly, and an `ok` there would just be a usage log nobody was told about.
    // Every non-GET outcome, and every slow or failed GET, is still kept.
    if (outcome === 'ok' && key.startsWith('GET ')) return
    reporter.record({ kind: 'action', name: key, outcome, status, durationMs, message: error ? error.message : '', context: contextFor(key, body) })
  }
  const token = crypto.randomBytes(18).toString('base64url')
  const runs = new Map() // id -> { run, logs: [] }
  const clients = new Set() // SSE responses
  let passes = null // this computer's passes, shared by all its sessions
  let link = null // signing in: what startLink returned, plus { state, error }
  let signedOutReason = null // 'revoked' once the API turned this computer's token away
  let checkedToken = false // asked the API about the saved token since the app started
  let workspacesOn = false // cached result of the last GET /api/workspaces probe

  const accountPasses = () => {
    if (passes) return passes
    const account = readAccount()
    if (!account) throw Object.assign(httpError(401, 'Sign in to Quilt first.'), { signedOut: true })
    passes = personPasses({ token: account.token })
    return passes
  }

  /** Forgets this computer's sign-in and stops its sessions. 'revoked': the API turned the token away. */
  async function signedOut (reason) {
    // Forget the sign-in first, so a start can't pick it up again while sessions stop.
    passes = null
    clearAccount()
    for (const id of [...runs.keys()]) await stop(id)
    signedOutReason = reason
    broadcast('signed-out', { reason })
  }

  async function accountState () {
    let account = readAccount()
    if (account && !checkedToken) {
      checkedToken = true
      try {
        // Picks up a name changed on heyquilt.com, and notices a computer signed out from there.
        const fresh = { ...account, account: accountFromProfile(await fetchMe({ token: account.token })) }
        saveAccount(fresh)
        account = fresh
      } catch (err) {
        if (err.status === 401) { await signedOut('revoked'); account = null }
        // Anything else (offline): keep the saved sign-in.
      }
    }
    return {
      signedIn: !!account,
      account: account ? account.account : null,
      reason: account ? null : signedOutReason,
      link: link ? { state: link.state, userCode: link.userCode, verificationUrl: link.verificationUrl, error: link.error } : null
    }
  }

  /** Starts linking this computer; the website approves it, and we collect the token in the background. */
  async function beginLink () {
    if (readAccount()) throw httpError(409, 'Already signed in.')
    const identity = loadIdentity()
    const mine = { ...await startLink({ identity }), state: 'waiting', error: null }
    link = mine
    waitForLink({ identity, link: mine, stopped: () => link !== mine }).then((r) => {
      // Approved after it was cancelled or replaced: don't leave that token live on the server.
      if (link !== mine) return revokeToken({ token: r.token })
      // Not saved (or an odd reply), so this computer isn't signed in: don't leave the token live either.
      const failed = (message) => {
        revokeToken({ token: r.token })
        mine.state = 'failed'
        mine.error = message
      }
      let account
      try { account = accountFromProfile(r.profile) } catch (err) { return failed(err.message) }
      try {
        saveAccount({ token: r.token, account, signedInAt: Date.now() })
      } catch {
        return failed(SAVE_FAILED)
      }
      link = null
      passes = null
      signedOutReason = null
      checkedToken = true
      broadcast('signed-in', {})
    }, (err) => {
      if (link !== mine) return
      mine.state = err.expired ? 'expired' : err.denied ? 'denied' : 'failed'
      mine.error = err.message
    })
    return accountState()
  }

  const idFor = (dir) => crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 10)
  // Recent sessions not open now. Ones that ran on another relay are marked: they can't reopen.
  const recentList = () => recentSessions().filter((r) => !runs.has(idFor(r.dir))).map((r) => ({ ...r, unsupported: unsupportedRelay(r.server) }))
  const broadcast = (type, data) => {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of clients) res.write(frame)
  }
  const summary = (id) => {
    const r = runs.get(id)
    return { id, dir: r.run.dir, invite: r.run.invite, viewInvite: r.run.viewInvite, status: r.run.session.status(), logs: r.logs.slice(-80), git: hostsGit(r), workspace: readConfig(r.run.dir)?.workspace || '' }
  }
  const pushStatus = (id) => runs.has(id) && broadcast('session', summary(id))
  // Git lives only on the host's computer (sync never writes inside .git), so
  // only a session you started, on a folder that's a repo, gets git actions.
  // Git lives with the session's owner. Sessions without an owner (older
  // clients) fall back to "didn't join it from an invite".
  const hostsGit = (r) => gitops.hostsGit(r.run.session, { joined: r.joined })

  async function start ({ mode, dir, tool, invite, prefer, repo, branch, newBranch, base, workspace }) {
    const me = profile()
    // Every session signs in to the relay as this computer's account.
    const sessionPasses = accountPasses()
    // Signing out (or in again) replaces `passes`, so a start that outlives the sign-in it began under can tell.
    const current = () => passes === sessionPasses
    const outlived = () => readAccount()
      ? httpError(409, 'Your sign-in changed while this session was starting. Start it again.')
      : Object.assign(httpError(401, 'Sign in to Quilt first.'), { signedOut: true })
    if (mode === 'github') {
      // Clone first, then start a normal session on the clone.
      const repoName = String(repo || '').split('/').pop()
      dir = path.resolve(expandHome(dir || underJoinDir(me.joinDir, repoName || 'repo', 'That repository name is not valid.')))
      if (runs.has(idFor(dir))) throw httpError(400, 'A session is already running in that folder.')
      await gitops.cloneRepo({ repo, dir, branch, newBranch, base })
      if (!current()) throw outlived()
      mode = 'create'
    }
    tool = tool || me.tool
    prefer = prefer || (me.preferLocal ? 'local' : 'remote')
    if (mode === 'join' && !dir) {
      const inv = decodeInvite(invite || '')
      dir = underJoinDir(me.joinDir, inv.room)
    }
    if (!dir) throw new Error('Choose a project folder.')
    dir = path.resolve(expandHome(dir))
    const id = idFor(dir)
    if (runs.has(id)) return summary(id)

    let conn
    let inviteServer
    if (mode === 'join') {
      conn = decodeInvite(invite || '')
    } else if (mode === 'rejoin') {
      const saved = readConfig(dir)
      if (!saved) throw new Error('No previous session in that folder.')
      if (unsupportedRelay(saved.server)) throw httpError(400, LOCAL_RELAY_GONE)
      conn = { server: saved.server, room: saved.room, secret: saved.secret, ...(saved.viewSecret ? { viewSecret: saved.viewSecret } : {}) }
      inviteServer = unsupportedRelay(saved.inviteServer) ? undefined : saved.inviteServer
      tool = tool || saved.tool
    } else {
      conn = newConn()
    }

    const entry = { logs: [], joined: mode === 'join' }
    const log = (line) => {
      entry.logs.push({ ts: Date.now(), line })
      if (entry.logs.length > 200) entry.logs.shift()
      broadcast('log', { id, ts: Date.now(), line })
    }
    try {
      entry.run = await runSession({
        dir,
        conn,
        // The account's name until the first pass names us (the same name, from the API).
        name: me.name,
        tool,
        color: me.color,
        shareByDefault: me.shareAgent,
        summarizeByDefault: me.summarize,
        joined: mode === 'join',
        prefer: prefer === 'local' ? 'local' : 'remote',
        inviteServer,
        passes: sessionPasses,
        // A new session is named after its folder (the owner can rename it later).
        startName: mode === 'create' ? cleanSessionName([...path.basename(dir)].slice(0, SESSION_NAME_MAX).join('')) || '' : '',
        workspace: workspace || '',
        onLog: log,
        onFatal: async (err) => {
          log(`stopped: ${err.message}`)
          await stop(id)
          // Only this sign-in's passes may sign it out: a stale session's 401 is about a token already gone.
          if (err.signedOut && current()) await signedOut('revoked')
        }
      })
    } catch (err) {
      if (!current()) throw outlived()
      if (err.signedOut) {
        await signedOut('revoked')
        throw Object.assign(httpError(401, err.message), { signedOut: true })
      }
      throw err
    }
    if (!current()) {
      // Signed out while it was starting: it must not keep running on the old sign-in.
      await entry.run.stop().catch(() => {})
      throw outlived()
    }
    runs.set(id, entry)
    const s = entry.run.session
    s.on('status-changed', () => pushStatus(id))
    s.on('access', () => pushStatus(id))
    s.on('message', (m) => broadcast('message', { id, message: m }))
    s.on('agent-feed', (entries) => broadcast('feed', { id, entries }))
    s.on('file-changed', (e) => broadcast('file-changed', { id, ...e }))
    // Presence changes (e.g. focus, recently edited files) also refresh the view.
    s.conn.awareness.on('change', () => pushStatus(id))
    if (workspace && mode === 'create') {
      // Put the new room in its workspace before anyone else connects. A failure is logged, never
      // fatal, and the session is outside any workspace here too, as it is on the API.
      // mode was reassigned to 'create' for github clones above, so this covers both.
      await asAccount((token) => setSessionWorkspace({ token, id: workspace, room: conn.room })).catch((err) => {
        log(`could not add this session to its workspace: ${err.message}`)
        forgetWorkspace(entry.run.dir)
      })
    }
    return summary(id)
  }

  async function stop (id) {
    const r = runs.get(id)
    if (!r) return
    runs.delete(id)
    await r.run.stop()
    broadcast('stopped', { id })
  }

  const get = (id) => {
    const r = runs.get(id)
    if (!r) throw httpError(404, 'That session is not running.')
    return r.run.session
  }

  /**
   * The owner renames a session: on the relay, so everyone in it sees the new name, then on
   * heyquilt.com. Until the relay has reported a new session there (within a minute) the
   * website answers 404, and the relay's own report carries the new name instead.
   */
  async function rename (id, raw) {
    const s = get(id)
    if (!s.isOwner) throw httpError(403, 'Only the session owner can rename it.')
    const name = cleanSessionName(raw)
    if (!name) throw httpError(400, BAD_SESSION_NAME)
    await s.rename(name)
    try {
      await renameSession({ token: readAccount()?.token, room: s.room, name })
    } catch (err) {
      if (err.status !== 404) throw httpError(502, `Renamed here, but heyquilt.com didn't take it: ${err.message}`)
    }
    return { name }
  }

  /** The session's folder, if this app may run git in it. */
  const gitDir = (id) => {
    get(id)
    const r = runs.get(id)
    if (!hostsGit(r)) throw httpError(400, r.joined ? 'Only the person who started this session can use git here.' : 'This folder isn\'t a git repository.')
    return r.run.dir
  }
  // One git action at a time per session; the reply includes the new status.
  const gitAction = async (id, fn) => {
    const dir = gitDir(id)
    const r = runs.get(id)
    if (r.gitBusy) throw httpError(409, 'Git is still busy with the last action.')
    r.gitBusy = true
    try {
      const result = await fn(dir)
      return { ...result, status: await gitops.status(dir) }
    } finally { r.gitBusy = false }
  }

  // Agent invites and the list of your agents come from the accounts API, as this computer's account.
  // A 401 there is checked against /v1/me before it counts: only a token the API no longer knows
  // signs the app out (an older API that doesn't take the app's token for these yet just errors).
  const asAccount = async (fn) => {
    const account = readAccount()
    if (!account) throw Object.assign(httpError(401, 'Sign in to Quilt first.'), { signedOut: true })
    try {
      return await fn(account.token)
    } catch (err) {
      if (err.status !== 401) throw err
      let revoked = false
      try { await fetchMe({ token: account.token }) } catch (e) { revoked = e.status === 401 }
      if (!revoked) throw httpError(502, `Quilt's accounts service turned this down: ${err.message}`)
      await signedOut('revoked')
      throw Object.assign(httpError(401, SIGNED_OUT_MESSAGE), { signedOut: true })
    }
  }

  // Workspaces live on the accounts API behind a flag: a 404 means off, and the app shows today's home.
  const workspaceList = () => asAccount(async (token) => {
    try {
      const workspaces = await listWorkspaces({ token })
      workspacesOn = true
      return { on: true, workspaces }
    } catch (err) {
      if (err.status === 404) { workspacesOn = false; return { on: false, workspaces: [] } }
      throw err
    }
  })
  const needWorkspaceId = (id) => { if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw httpError(400, 'Which workspace?'); return id }
  const ofWorkspace = (id) => ({
    running: [...runs.keys()].filter((k) => (readConfig(runs.get(k).run.dir) || {}).workspace === id),
    recent: recentList().filter((r) => r.workspace === id)
  })

  // Access types and invites (the owner's): the API keeps grants, the relay applies them.
  const ACCOUNT = /^(person|agent):[A-Za-z0-9_-]{1,64}$/
  const owned = (id) => {
    const s = get(id)
    if (!s.isOwner) throw httpError(403, 'Only the session owner can do that.')
    return s
  }
  const typeById = async (token, typeId) => {
    // The built-ins are known here, so letting someone in as one works while the API is down.
    const type = builtinType(typeId) || (await listAccessTypes({ token })).find((t) => t.id === typeId)
    if (!type) throw httpError(400, 'Pick an access type.')
    return type
  }
  /** Runs `fn` against the API; anything but a 401 (which signs out) becomes a warning instead of an error. */
  const tryApi = async (fn) => {
    try { await fn(); return '' } catch (err) {
      if (err.status === 401) throw err
      return err.message
    }
  }

  /**
   * Lets someone in as an access type: the grant goes to the API first (so their next pass
   * carries it), then the relay lets them in with the access it comes to. Someone who isn't
   * an account (an older app) is still let in, with a warning that nothing was saved.
   */
  async function approveAs (id, { key, typeId }) {
    const s = owned(id)
    return asAccount(async (token) => {
      const type = await typeById(token, typeId)
      let access = effectiveAccess(type, {})
      let warning = ''
      if (ACCOUNT.test(String(key))) warning = await tryApi(async () => { access = (await putGrant({ token, room: s.room, account: key, typeId })).access })
      await s.approve(key, { typeId, access })
      return warning ? { ok: true, warning: `Let in, but their access wasn't saved on heyquilt.com: ${warning}` } : { ok: true }
    })
  }

  /** Changes someone's access type and how it's narrowed: the API, then the relay at once. */
  async function setAccess (id, { key, typeId, tighten }) {
    const s = owned(id)
    if (!ACCOUNT.test(String(key))) throw httpError(400, 'They joined before access types. Change their role instead.')
    return asAccount(async (token) => {
      const grant = await putGrant({ token, room: s.room, account: key, typeId, tighten })
      await s.setMember(key, { access: grant.access })
      return { grant }
    })
  }

  /**
   * Removes someone, and their grant, so they wait for the owner if they come back. The relay
   * removes them either way; if the grant couldn't be deleted, their next pass would let them
   * straight back in, so the owner is told.
   */
  async function removeMember (id, key) {
    const s = owned(id)
    let warning = ''
    if (ACCOUNT.test(String(key))) {
      try {
        warning = await asAccount((token) => tryApi(() => deleteGrant({ token, room: s.room, account: key })))
      } catch (err) {
        warning = err.message
      }
    }
    await s.removeMember(key)
    return warning ? { ok: true, warning: `Removed, but their access is still saved on heyquilt.com, so they can get back in: ${warning}` } : { ok: true }
  }

  /** Invites someone by email or account. The email carries the session's link: the view link for a view-only type. */
  async function invite (id, { typeId, to }) {
    const s = owned(id)
    const run = runs.get(id).run
    return asAccount(async (token) => {
      const type = await typeById(token, typeId)
      const link = type.files === 'view' && run.viewInvite ? run.viewInvite : run.invite
      return { invite: await inviteToSession({ token, room: s.room, typeId, to, link }) }
    })
  }

  const api = {
    'GET /api/account': () => accountState(),
    'GET /api/access-types': () => asAccount(async (token) => ({ types: await listAccessTypes({ token }) })),
    'GET /api/collaborators': () => asAccount(async (token) => ({ collaborators: await listCollaborators({ token }) })),
    'GET /api/sessions/:id/grants': (b, id) => { const s = owned(id); return asAccount(async (token) => ({ grants: await listGrants({ token, room: s.room }) })) },
    'POST /api/sessions/:id/members/access': (b, id) => setAccess(id, b),
    'GET /api/sessions/:id/invites': (b, id) => { const s = owned(id); return asAccount(async (token) => ({ invites: await listSessionInvites({ token, room: s.room }) })) },
    'POST /api/sessions/:id/invites': (b, id) => invite(id, b),
    'POST /api/sessions/:id/invites/cancel': (b, id) => {
      const s = owned(id)
      if (!b.inviteId) throw httpError(400, 'Which invite?')
      return asAccount(async (token) => { await cancelSessionInvite({ token, room: s.room, id: String(b.inviteId) }); return { ok: true } })
    },
    'GET /api/agents': () => asAccount(async (token) => ({ agents: await listAgents({ token }) })),
    'POST /api/agent-invites': () => asAccount((token) => createAgentInvite({ token })),
    'GET /api/workspaces': () => workspaceList(),
    'GET /api/orgs': () => asAccount(async (token) => ({ orgs: await listOrgs({ token }) })),
    'POST /api/workspaces': (b) => asAccount(async (token) => ({ workspace: await createWorkspace({ token, name: String(b.name || ''), description: String(b.description || ''), color: String(b.color || ''), org: b.org ? String(b.org) : undefined }) })),
    'GET /api/workspaces/:id': (b, id) => asAccount(async (token) => ({ ...(await getWorkspace({ token, id: needWorkspaceId(id) })), ...ofWorkspace(id) })),
    'POST /api/workspaces/:id/update': (b, id) => asAccount(async (token) => ({ workspace: await updateWorkspace({ token, id: needWorkspaceId(id), patch: { name: b.name, description: b.description, color: b.color, archived: b.archived } }) })),
    'POST /api/workspaces/:id/delete': (b, id) => asAccount(async (token) => { await deleteWorkspace({ token, id: needWorkspaceId(id) }); return { ok: true } }),
    'POST /api/workspaces/:id/members': (b, id) => asAccount(async (token) => ({ member: await putWorkspaceMember({ token, id: needWorkspaceId(id), account: String(b.account || ''), access: String(b.access || '') }) })),
    'POST /api/workspaces/:id/members/remove': (b, id) => asAccount(async (token) => { await removeWorkspaceMember({ token, id: needWorkspaceId(id), account: String(b.account || '') }); return { ok: true } }),
    'POST /api/workspaces/:id/sessions/move': (b, id) => asAccount(async (token) => {
      const dir = path.resolve(expandHome(String(b.dir || '')))
      const saved = readConfig(dir)
      if (!saved) throw httpError(404, 'No session in that folder.')
      await setSessionWorkspace({ token, id: needWorkspaceId(id), room: saved.room })
      writePrivateJson(path.join(dir, '.quilt', 'config.json'), { ...saved, workspace: id })
      rememberWorkspace(dir, id)
      return { ok: true }
    }),
    'POST /api/account/start': () => beginLink(),
    'POST /api/account/cancel': () => { link = null; return accountState() },
    'POST /api/account/signout': async () => {
      const account = readAccount()
      // Forget the sign-in first, so a start can't pick it up again while sessions stop.
      passes = null
      link = null
      clearAccount()
      for (const id of [...runs.keys()]) await stop(id)
      await signOut({ token: account?.token })
      signedOutReason = null
      return { ok: true }
    },
    'GET /api/state': () => ({
      sessions: [...runs.keys()].map(summary),
      recent: recentList(),
      defaults: { home: os.homedir(), cwd: process.cwd(), tools: TOOL_NAMES, editors: installedEditors(), relay: relayUrl() },
      profile: profile(),
      maxFileBytes: MAX_SHARED_FILE_BYTES,
      workspacesOn
    }),
    'POST /api/sessions': (b) => start(b),
    'POST /api/sessions/:id/open-in': async (b, id) => { await openIn(String(b.app || ''), get(id).root); return { ok: true } },
    'GET /api/sessions/:id/merges': (b, id) => ({ merges: get(id).mergeList() }),
    'POST /api/sessions/:id/merges/resolve': (b, id) => { const r = get(id).resolveMerge(String(b.id || ''), { how: b.how }); pushStatus(id); return r },
    'POST /api/sessions/:id/merges/send': async (b, id) => {
      const s = get(id)
      const mergeId = String(b.id || '')
      const { prompt } = s.prepareMergeSend(mergeId)
      const app = String(b.app || '')
      const mergePath = s.mergeList().find((m) => m.id === mergeId)?.path || mergeId
      // The headless run can take minutes; openIn returns once it's started, and logs how it went when it's done.
      const { copied, started } = await openIn(app, s.root, {
        prompt,
        onDone: (result) => s.log(result.ok
          ? `Claude Code finished merging ${mergePath}; a session opened`
          : 'Claude Code could not run; the prompt is on your clipboard')
      })
      return { copied, started, app }
    },
    'POST /api/sessions/:id/stop': (b, id) => stop(id).then(() => ({ ok: true })),
    'POST /api/sessions/:id/say': (b, id) => get(id).say(b.text, { to: b.to || null }),
    'POST /api/sessions/:id/focus': (b, id) => { get(id).setFocus(b.text); return { ok: true } },
    'POST /api/sessions/:id/claim': (b, id) => get(id).claim(b.pattern, b.note),
    'POST /api/sessions/:id/release': async (b, id) => ({ released: await get(id).release(b.pattern) }),
    'POST /api/sessions/:id/read': (b, id) => { get(id).messages({ limit: 500 }); pushStatus(id); return { ok: true } },
    'GET /api/sessions/:id/messages': (b, id) => ({ messages: get(id).messages({ limit: 200, markRead: false }) }),
    'GET /api/sessions/:id/tasks': (b, id) => ({ tasks: get(id).taskList() }),
    'POST /api/sessions/:id/tasks': (b, id) => ({ task: get(id).addTask(b), tasks: get(id).taskList() }),
    'POST /api/sessions/:id/tasks/update': (b, id) => ({ task: get(id).updateTask(b), tasks: get(id).taskList() }),
    'POST /api/sessions/:id/tasks/delete': (b, id) => { get(id).deleteTask(b.id); return { tasks: get(id).taskList() } },
    'GET /api/sessions/:id/feed': (b, id, url) => {
      const s = get(id)
      return { entries: s.agentFeedFor(url.searchParams.get('who') || s.name) }
    },
    'GET /api/sessions/:id/tree': (b, id) => get(id).tree(),
    'GET /api/sessions/:id/file': (b, id, url) => {
      const f = get(id).readShared(url.searchParams.get('path'))
      if (!f) throw httpError(404, 'That file is not in this session.')
      return f
    },
    'POST /api/sessions/:id/members/approve': async (b, id) => b.typeId ? approveAs(id, b) : (await get(id).approve(b.key, { role: b.role, scopes: b.scopes }), { ok: true }),
    'POST /api/sessions/:id/members/deny': async (b, id) => (await get(id).deny(b.key), { ok: true }),
    'POST /api/sessions/:id/members/set': async (b, id) => (await get(id).setMember(b.key, { role: b.role, scopes: b.scopes }), { ok: true }),
    'POST /api/sessions/:id/members/remove': (b, id) => removeMember(id, b.key),
    'POST /api/sessions/:id/rename': (b, id) => rename(id, b.name),
    'POST /api/sessions/:id/end': async (b, id) => { await get(id).endForEveryone(); await stop(id); return { ok: true } },
    'POST /api/sessions/:id/summarize': (b, id) => {
      const r = runs.get(id)
      if (!r) throw httpError(404, 'That session is not running.')
      return { on: r.run.session.setSummarize(b.on ? r.run.summarizer() : null) }
    },
    'POST /api/sessions/:id/sharing': (b, id) => ({ on: get(id).setAgentSharing(b.on !== false) }),
    'POST /api/recent/forget': (b) => { forgetRecent(path.resolve(expandHome(String(b.dir || '')))); return { recent: recentList() } },
    // Release notes and the update check. The newest local notes are "unseen" until the app shows them.
    'GET /api/version': async () => {
      const version = currentVersion()
      const latest = await latestRelease()
      return {
        version,
        releases: localReleases(),
        unseen: compareVersions(seenVersion(), version) < 0,
        latest,
        outOfDate: !!latest && compareVersions(latest.version, version) > 0,
        downloadUrl: downloadUrl()
      }
    },
    'POST /api/version/seen': () => { markSeen(currentVersion()); return { ok: true } },
    'GET /api/settings': () => profile(),
    'POST /api/settings': (b) => updateProfile(b),
    'POST /api/report': (b) => {
      reporter.record({ kind: 'error', name: String(b.name || 'renderer').slice(0, 80), outcome: 'error', message: String(b.message || '').slice(0, 500), context: typeof b.context === 'object' && b.context ? b.context : {} })
      return { ok: true }
    },
    'GET /api/github/status': () => gitops.ghStatus(),
    'GET /api/github/repos': async (b, id, url) => ({ repos: await gitops.listRepos({ limit: url.searchParams.get('limit') || 100 }) }),
    'GET /api/github/branches': (b, id, url) => gitops.listBranches(url.searchParams.get('repo')),
    'GET /api/sessions/:id/git': (b, id) => gitops.status(gitDir(id)),
    'POST /api/sessions/:id/git/pull': (b, id) => gitAction(id, (dir) => gitops.pull(dir, { base: b.base })),
    'POST /api/sessions/:id/git/commit': (b, id) => gitAction(id, async (dir) => {
      const r = await gitops.commit(dir, b.message)
      get(id).resolveCommitRequests({ hash: r.hash })
      return r
    }),
    'POST /api/sessions/:id/commit-request': (b, id) => get(id).requestCommit(b.message),
    'POST /api/sessions/:id/git/pr': (b, id) => gitAction(id, (dir) => gitops.pushAndOpenPr(dir, { title: b.title, body: b.body, base: b.base })),
    'GET /api/fs': (b, id, url) => listDir(url.searchParams.get('path') || os.homedir()),
    // Reply first, then shut down, so the page hears back before we exit.
    'POST /api/shutdown': () => {
      if (!onShutdown) throw httpError(501, 'Shut down is not available here.')
      setTimeout(onShutdown, 100)
      return { ok: true }
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }

    // DNS-rebinding guard: only answer requests addressed to localhost.
    const host = (req.headers.host || '').replace(/:\d+$/, '')
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return json(403, { error: 'forbidden host' })

    if (preview && req.method === 'GET' && url.pathname === '/' && !url.searchParams.get('t')) {
      res.writeHead(302, { location: `/?t=${token}`, 'cache-control': 'no-store' })
      return res.end()
    }
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname]
      const headers = { 'content-type': type, 'cache-control': 'no-store' }
      if (url.pathname === '/') headers['content-security-policy'] = CSP
      res.writeHead(200, headers)
      const body = fs.readFileSync(path.join(UI_DIR, file))
      // The theme goes on <html> before anything paints, so dark mode never flashes light.
      if (url.pathname === '/') return res.end(String(body).replace('<html lang="en">', `<html lang="en" data-theme="${profile().theme}">`))
      return res.end(body)
    }
    const font = req.method === 'GET' && url.pathname.match(/^\/fonts\/([a-z-]+)\/([^/]+)$/)
    if (font) {
      const f = fontFile(font[1], font[2])
      if (!f) return json(404, { error: 'not found' })
      res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=31536000, immutable' })
      return res.end(fs.readFileSync(f))
    }
    if (req.method === 'GET' && (url.pathname === '/logo.svg' || url.pathname === '/favicon.svg')) {
      res.writeHead(200, { 'content-type': 'image/svg+xml' })
      return res.end(fs.readFileSync(LOGO))
    }

    const supplied = req.headers['x-quilt-token'] || url.searchParams.get('t')
    if (supplied !== token) return json(401, { error: 'Open quilt from the link printed by `quilt ui`.' })

    try {
      if (!OPEN_ROUTES.has(`${req.method} ${url.pathname}`) && !readAccount()) return json(401, { error: 'Sign in to Quilt first.', signedOut: true })
      if (req.method === 'GET' && url.pathname === '/api/events') return events(req, res)

      let m = url.pathname.match(/^\/api\/sessions\/([a-f0-9]+)\/send$/)
      if (req.method === 'POST' && m) return json(200, await receiveUpload(req, get(m[1])))
      m = url.pathname.match(/^\/api\/sessions\/([a-f0-9]+)\/files\/([a-f0-9]+)$/)
      if (req.method === 'GET' && m) return await serveFile(res, get(m[1]), m[2])

      const pathKey = url.pathname
        .replace(/^\/api\/sessions\/[a-f0-9]+/, '/api/sessions/:id')
        .replace(/^\/api\/workspaces\/[^/]+/, '/api/workspaces/:id')
      const sid = (url.pathname.match(/^\/api\/sessions\/([a-f0-9]+)/) || url.pathname.match(/^\/api\/workspaces\/([^/]+)/) || [])[1]
      const key = `${req.method} ${pathKey}`
      const handler = api[key]
      if (!handler) {
        reporter.record({ kind: 'http404', name: key.slice(0, 80), outcome: 'error', status: 404 })
        return json(404, { error: 'not found' })
      }
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = raw ? JSON.parse(raw) : {}
      const startedAt = Date.now()
      try {
        const out = await handler(body, sid, url)
        json(200, out)
        return recordRoute(key, { startedAt, status: 200, body })
      } catch (err) {
        recordRoute(key, { startedAt, status: err.status || 400, body, error: err })
        throw err
      }
    } catch (err) {
      return json(err.status || 400, { error: err.message, ...(err.signedOut ? { signedOut: true } : {}) })
    }
  })

  function events (req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(': hi\n\n')
    clients.add(res)
    const ping = setInterval(() => res.write(': ping\n\n'), 15000)
    req.on('close', () => { clearInterval(ping); clients.delete(res) })
  }

  async function receiveUpload (req, session) {
    const name = path.basename(decodeURIComponent(req.headers['x-filename'] || 'file')) || 'file'
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-up-'))
    const file = path.join(dir, name)
    try {
      let size = 0
      const out = fs.createWriteStream(file)
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_SHARED_FILE_BYTES) { out.destroy(); throw httpError(413, 'File is too large.') }
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
      const to = req.headers['x-to'] ? decodeURIComponent(req.headers['x-to']) : null
      const text = req.headers['x-text'] ? decodeURIComponent(req.headers['x-text']) : ''
      return await session.sendFile(file, { to, text })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  async function serveFile (res, session, msgId) {
    const msg = session.messages({ limit: 500, markRead: false }).find((m) => m.id === msgId)
    if (!msg || !msg.file) throw httpError(404, 'No such file.')
    const local = msg.file.localPath ? path.join(session.root, msg.file.localPath) : await session.fetchFile(msgId)
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${msg.file.name.replace(/[^\w.\- ]/g, '_')}"`
    })
    fs.createReadStream(local).pipe(res)
  }

  const listen = (p) => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(p, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  try { await listen(port) } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err
    await listen(0)
  }
  const actualPort = server.address().port

  return {
    url: `http://127.0.0.1:${actualPort}/?t=${token}`,
    port: actualPort,
    token,
    report: (event) => reporter.record(event),
    flushReports: () => reporter.flush(),
    close: async () => {
      link = null
      for (const id of [...runs.keys()]) await stop(id)
      for (const res of clients) res.end()
      await reporter.close()
      await new Promise((r) => server.close(r))
    }
  }
}

function listDir (p) {
  const dir = path.resolve(expandHome(p))
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
  return {
    path: dir,
    parent: path.dirname(dir) !== dir ? path.dirname(dir) : null,
    dirs,
    hasSession: fs.existsSync(path.join(migrateDir(dir), 'config.json')),
    isEmpty: entries.filter((e) => e.name !== '.DS_Store').length === 0
  }
}

/** The AI coding tool this person most likely uses, from what it has left in their home folder. */
function detectTool () {
  const home = os.homedir()
  const found = [['.claude', 'Claude Code'], ['.cursor', 'Cursor'], ['.codex', 'Codex'], ['.codeium/windsurf', 'Windsurf']]
    .map(([dir, tool]) => {
      try { return { tool, used: fs.statSync(path.join(home, dir)).mtimeMs } } catch { return null }
    })
    .filter(Boolean)
    .sort((a, b) => b.used - a.used)
  return found[0]?.tool || 'Claude Code'
}

function expandHome (p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
}

/**
 * The folder for `name` (a room or repo name) inside the join folder. Invites only carry plain
 * room names, but a name that would land anywhere else (`..`, a path) is refused all the same.
 */
export function underJoinDir (joinDir, name, message = INVALID_INVITE) {
  const root = path.resolve(expandHome(joinDir))
  const dir = path.resolve(root, String(name))
  if (path.dirname(dir) !== root) throw httpError(400, message)
  return dir
}

function httpError (status, message) {
  return Object.assign(new Error(message), { status })
}
