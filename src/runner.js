// Starting and stopping a session for a folder. Shared by `quilt join` and
// `quilt ui` so both behave identically (config, STATUS.md, control API).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { Session } from './session.js'
import { startControl } from './control.js'
import { renderStatus } from './status.js'
import { startAgentReaders } from './agents/index.js'
import { relayUrl, isHostedRelay, getSettings } from './settings.js'
import { createSummarizer, createTaskTitler } from './summarize.js'
import { quiltHome, migrateDir } from './legacy.js'
import { writePrivateJson } from './private-file.js'
import { listProcesses } from './procs.js'
import { JOIN_HOST, INVALID_INVITE, buildInvite, parseInvite } from './ui/invite.js'
import { installHooks, HOOKS_FILE } from './setup.js'
import { releaseLeftoverHookClaims } from './hooks.js'

export { JOIN_HOST }

/**
 * An invite link: https://join.heyquilt.com/<room>#<secret> for sessions on Quilt's relay,
 * or https://<relay>/join/<room>#<secret> for any other relay (development relays).
 */
export function encodeInvite (c) {
  return buildInvite(c, isHostedRelay)
}

/**
 * Reads an invite link (or an older base64 code), with or without "quilt join" or "quilt:" in front.
 * A link naming its own relay is accepted only for Quilt's relay or the one this computer already
 * uses (QUILT_SERVER), so a crafted link can't hand this computer's pass and files to another relay.
 */
export function decodeInvite (code) {
  const r = parseInvite(code, { allowRelay: (s) => isHostedRelay(s) || s === relayUrl() })
  return { server: r.relay || relayUrl(), room: r.room, secret: r.secret }
}

/** A new room on Quilt's relay: `secret` invites people to edit, `viewSecret` to only watch. */
export function newConn (server = relayUrl()) {
  return {
    server,
    room: `room-${crypto.randomBytes(4).toString('hex')}`,
    secret: crypto.randomBytes(18).toString('base64url'),
    viewSecret: crypto.randomBytes(18).toString('base64url')
  }
}

export function readConfig (dir) {
  try { return JSON.parse(fs.readFileSync(path.join(migrateDir(dir), 'config.json'), 'utf8')) } catch { return null }
}

/** The other process syncing this exact folder ({ pid, port, token } from its daemon.json), or null. */
function otherSync (dir) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dir, '.quilt', 'daemon.json'), 'utf8'))
    if (info.pid === process.pid) return null
    process.kill(info.pid, 0)
    return info
  } catch {
    return null
  }
}

/** True if another process is already syncing this exact folder. */
export function runningElsewhere (dir) {
  return !!otherSync(dir)
}

/**
 * Says what is already syncing `dir`, so the person can stop it rather than guess: an AI
 * agent that joined from its tool's quilt MCP server, a `quilt join` in a terminal, another
 * copy of the app. Null when nothing else is.
 */
export async function describeOtherSync (dir) {
  const other = otherSync(dir)
  if (!other) return null
  let info = null
  try {
    const res = await fetch(`http://127.0.0.1:${other.port}/info`, { headers: { authorization: `Bearer ${other.token}` }, signal: AbortSignal.timeout(1500) })
    if (res.ok) info = await res.json()
  } catch {}
  const proc = listProcesses().find((p) => p.pid === other.pid)
  const who = info && info.kind === 'agent'
    ? `your AI agent "${info.name}" joined it from its tool's quilt MCP server (process ${other.pid}). Ask the agent to leave with quilt_leave_session, or close that tool`
    : proc && proc.kind === 'app'
      ? `another copy of the Quilt app (process ${other.pid}) has it open. Leave it there, or quit that app`
      : proc && proc.kind === 'sync'
        ? `a \`quilt join\` in a terminal (process ${other.pid}) is syncing it${info ? ` as "${info.name}"` : ''}. Stop that one (Ctrl-C there, or \`quilt stop\`)`
        : `another quilt process (${other.pid}) is syncing it${info ? ` as "${info.name}"` : ''}. Stop that one first`
  return `This folder is already being synced by another quilt process: ${who}, then rejoin here.`
}

/**
 * Starts syncing `dir`. `conn` is { server, room, secret }; `inviteServer`
 * optionally overrides the relay address given out in invites (e.g. a public
 * tunnel URL when the relay runs on this machine).
 */
export async function runSession ({ dir, conn, name, tool, color = null, shareByDefault = true, summarizeByDefault = false, joined = false, prefer = 'remote', inviteServer, onLog, onFatal, onDebug, kind = 'human', agentFeed = true, readerOptions = {}, passes = null, identity = null, startName = '', workspace = '' }) {
  dir = path.resolve(dir)
  if (!/^wss?:\/\//.test(conn.server)) throw new Error('The relay address must start with ws:// or wss://')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  if (!fs.statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`)
  const busy = await describeOtherSync(dir)
  if (busy) throw new Error(busy)

  // With passes, the relay knows you by your account (or agent): its name and agent
  // badge come from the pass. The session starts with the name saved on this computer
  // (or one already fetched) and takes the pass's once it arrives, without waiting for
  // one here, so being offline doesn't stop a session from starting.
  const p = passes && passes.payload
  if (p && p.name) name = p.name
  if (p && p.kind === 'agent') kind = 'agent'
  name = (name || os.userInfo().username).trim()
  tool = tool || 'unknown'
  const invite = encodeInvite({ ...conn, server: inviteServer || conn.server })
  // Only the person who made the room has the view-only secret.
  const viewInvite = conn.viewSecret ? encodeInvite({ ...conn, secret: conn.viewSecret, server: inviteServer || conn.server }) : null
  const previous = readConfig(dir)
  // Sharing your AI chat follows your setting; a pause or resume is remembered for this folder.
  const shareAgent = previous && previous.room === conn.room && typeof previous.shareAgent === 'boolean' ? previous.shareAgent : shareByDefault !== false
  const summarize = previous && previous.room === conn.room && typeof previous.summarize === 'boolean' ? previous.summarize : !!summarizeByDefault
  // The workspace carries over only for the same room: a new room in this folder starts outside any.
  const savedWorkspace = workspace || (previous && previous.room === conn.room ? previous.workspace : '') || ''
  fs.mkdirSync(path.join(dir, '.quilt'), { recursive: true })
  const configFile = path.join(dir, '.quilt', 'config.json')
  // It holds the room secret: written privately and atomically (see private-file.js).
  writePrivateJson(configFile, { ...conn, name, tool, kind, inviteServer: inviteServer || undefined, shareAgent, summarize, workspace: savedWorkspace || undefined })
  // Keeps the saved name in step with the pass's (the rest of the file may have changed since).
  const saveName = (name) => {
    try { writePrivateJson(configFile, { ...JSON.parse(fs.readFileSync(configFile, 'utf8')), name }) } catch {}
  }
  ensureGitExclude(dir)

  const session = new Session({ dir, ...conn, name, tool, color, prefer, kind, shareAgent, identity, passes, startName })
  const summarizer = () => createSummarizer({ onWarn: (msg) => session.log(`✂️  ${msg}`) })
  if (summarize) session.summarizer = summarizer()
  session.taskTitler = createTaskTitler({ onWarn: (msg) => session.log(`📋 ${msg}`) })
  if (onLog) session.on('log', onLog)
  if (onDebug) session.on('debug', onDebug)
  session.on('fatal', (err) => onFatal && onFatal(err))
  const statusFile = path.join(dir, '.quilt', 'STATUS.md')
  session.on('status-changed', () => {
    // Read config fresh: the workspace can change after the session started (the app's
    // "move to workspace", or a later quilt_start_session call writing it here).
    try { fs.writeFileSync(statusFile, renderStatus({ ...session.status(), workspace: readConfig(dir)?.workspace })) } catch {}
  })

  try {
    await session.start({ waitTimeoutMs: 15000 })
  } catch (err) {
    await session.stop().catch(() => {})
    throw err
  }
  // The pass may have named us differently from the name we started with.
  if (session.name !== name) saveName(session.name)
  session.on('identity', ({ name }) => saveName(name))
  const control = await startControl(session, { invite, viewInvite, joined })
  remember({ dir, room: conn.room, server: conn.server, name: session.name, tool, kind, workspace: savedWorkspace })

  // Claude Code claims files as it edits them (src/hooks.js). The hooks live in the shared
  // .claude/settings.json so everyone in the session follows the same rule.
  try { if (installHooks(dir)) session.log('🪝 added Quilt\'s Claude Code hooks to .claude/settings.json: files are claimed as they are edited') } catch {}
  releaseLeftoverHookClaims(session).then((n) => { if (n) session.log(`🔓 released ${n} claim(s) left by an earlier AI session`) }).catch(() => {})

  // Claude Code claims files as it edits them (src/hooks.js). The hooks go in this person's own
  // settings file; everyone's session writes its own, so the rule holds for everyone in the room.
  try { if (installHooks(dir)) session.log(`🪝 added Quilt's Claude Code hooks to ${HOOKS_FILE}: files are claimed as they are edited`) } catch {}
  releaseLeftoverHookClaims(session).then((n) => { if (n) session.log(`🔓 released ${n} claim(s) left by an earlier AI session`) }).catch(() => {})

  // Share this person's AI chat (Claude Code, Cursor) with the room.
  const readers = agentFeed
    ? startAgentReaders({
      dir,
      ...readerOptions,
      onEntries: (entries) => session.pushAgentEntries(entries),
      onState: (state) => session.setAgentState(state),
      onLog: (line) => onLog && onLog(line)
    })
    : null

  let stopped = false
  return {
    session,
    invite,
    viewInvite,
    summarizer,
    dir,
    stop: async () => {
      if (stopped) return
      stopped = true
      if (readers) readers.stop()
      await control.close()
      await session.stop()
    }
  }
}

/** Keep .quilt/ and this person's hook settings out of git without editing the (synced) .gitignore. */
function ensureGitExclude (dir) {
  const exclude = path.join(dir, '.git', 'info', 'exclude')
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) return
    let text = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : ''
    for (const line of ['.quilt/', HOOKS_FILE]) {
      if (text.split('\n').includes(line)) continue
      fs.mkdirSync(path.dirname(exclude), { recursive: true })
      text = `${text && !text.endsWith('\n') ? `${text}\n` : text}${line}\n`
      fs.writeFileSync(exclude, text)
    }
  } catch {}
}

// ------------------------------------------------- whose folder is it? --
// A folder is a person's unless it is an agent's own copy of a room, and that is known
// by its name: "quilt-<room>-<agent>" (or "quilt-<room>" from older versions), which is
// how agents' copies are always made. Who ran it last says nothing: an agent run in a
// person's folder (an older version, a `quilt join --agent` there) must not make it the
// agent's, or the person loses it from Recent and can't get back in.

const expandHome = (p) => p === '~' ? os.homedir() : String(p).startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p
const slug = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'

/** True if `dir` is an agent's own copy of `room`. */
export function isAgentCopy (dir, room) {
  const base = path.basename(path.resolve(dir))
  return base === `quilt-${room}` || base.startsWith(`quilt-${room}-`)
}

/** A folder a person synced from this computer (the app, or `quilt join`): any synced folder that isn't an agent's copy. */
export function personsFolder (dir) {
  const saved = readConfig(dir)
  return !!saved && !isAgentCopy(dir, saved.room)
}

/**
 * Where an agent keeps its own copy of a room: "quilt-<room>-<agent>" under this computer's
 * join folder (the app's "Join into" setting, ~/quilt by default), so it never lands inside
 * a person's project, and two agents on one computer never share a copy.
 */
export function agentCopyFolder (room, agent) {
  const root = path.resolve(expandHome(getSettings().joinDir || '~/quilt'))
  const dir = path.resolve(root, `quilt-${room}-${slug(agent)}`)
  if (path.dirname(dir) !== root) throw new Error(INVALID_INVITE)
  return dir
}

// Recently used folders, for the UI's "rejoin" list.
const recentFile = () => path.join(quiltHome(), 'recent.json')

/** A person's recent folders. An agent's own copies of rooms are its to rejoin, not the app's. */
export function recentSessions () {
  try {
    return JSON.parse(fs.readFileSync(recentFile(), 'utf8')).filter((r) => !isAgentCopy(r.dir, r.room) && fs.existsSync(path.join(r.dir, '.quilt', 'config.json')))
  } catch {
    return []
  }
}

/** Drops a folder from the recent list (its files and settings stay). */
export function forgetRecent (dir) {
  try {
    const list = JSON.parse(fs.readFileSync(recentFile(), 'utf8')).filter((r) => r.dir !== dir)
    fs.writeFileSync(recentFile(), JSON.stringify(list, null, 2))
  } catch {}
}

/** Takes a folder's session out of its workspace on this computer: its config and the recent list. */
export function forgetWorkspace (dir) {
  const saved = readConfig(dir)
  if (saved && saved.workspace) {
    const { workspace, ...rest } = saved
    try { writePrivateJson(path.join(dir, '.quilt', 'config.json'), rest) } catch {}
  }
  rememberWorkspace(dir, '')
}

/** Records which workspace a remembered folder's session is in. */
export function rememberWorkspace (dir, workspace) {
  try {
    const list = JSON.parse(fs.readFileSync(recentFile(), 'utf8')).map((r) => (r.dir === dir ? { ...r, workspace } : r))
    fs.writeFileSync(recentFile(), JSON.stringify(list, null, 2))
  } catch {}
}

function remember (entry) {
  // An agent's run in a person's folder isn't theirs to put on the list, or to rename there.
  if (entry.kind === 'agent' && !isAgentCopy(entry.dir, entry.room)) return
  try {
    const list = recentSessions().filter((r) => r.dir !== entry.dir)
    list.unshift({ ...entry, lastUsed: Date.now() })
    fs.mkdirSync(path.dirname(recentFile()), { recursive: true })
    fs.writeFileSync(recentFile(), JSON.stringify(list.slice(0, 12), null, 2))
  } catch {}
}
