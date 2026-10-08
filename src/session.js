// A sync session: mirrors a project folder into a shared Yjs document and
// back. Any tool that edits files on disk (Claude Code, Cursor, Codex, vim...)
// participates automatically; concurrent edits are merged character by
// character by the CRDT.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import * as Y from 'yjs'
import { watch } from 'chokidar'
import { Connection } from './connection.js'
import { loadIdentity } from './identity.js'
import { writePrivateJson } from './private-file.js'
import { MAX_SHARED_FILE_BYTES } from './protocol.js'
import { formatBytes, pullAdvice } from './status.js'
import {
  loadIgnore, IGNORE_FILES, isIgnored, isSafeRelPath, resolveInside, looksBinary, sha1, walk,
  toPosix, globMatcher, MAX_TEXT_BYTES, MAX_BINARY_BYTES, LARGE_FILE_BYTES, MAX_STORED_BINARY_BYTES
} from './fsutil.js'
import { deriveWrapKey, newFileKey, wrapKey, unwrapKey, encryptBlob, decryptBlob, blobId } from './largefiles.js'
import { applyTextDiff } from './textdiff.js'
import { migrateDir } from './legacy.js'
import { withComments, addComment as putComment } from './task-comments.js'
import { readTasks, addTask as putTask, updateTask as patchTask, deleteTask as dropTask, planAutoTask, nextTask, pickupMode } from './tasks.js'
import { getSettings } from './settings.js'
import { HistoryLog, queryHistory, parseSince, currentTask } from './history.js'
import { historyMarks, awayChanges, mergeCatchUp, emptyCatchUp } from './catchup.js'
import { Inbox } from './inbox.js'
import { personaName, cleanLabel, labelFromBranch, labelFromText, labelFromFile, gitBranch, aiName } from './persona.js'
import { aiOwners, ownAiChatter } from './ui/chat.js'
import { chatAbout, waitingOn, queuedFor, renderQueueNotice, askForIt, answered, addressees, unaddressed, sentByAnother, renderRepeat } from './duties.js'
import { makeSubscription, deliverEvents } from './webhooks.js'
import { pickChecklist } from './agent-task-workflow.js'
import { changeRefusal, TALK_REFUSED } from './session-access.js'
import { canAdmit } from './admit-policy.js'
import { merge3, withMarkers, hasMarkers } from './merge3.js'
import { openMerge, updateMerge, readMerges, pruneMerges, cleanName } from './merges.js'
import { ensureQuiltIgnored } from './gitignore.js'
import { gitDir, headKey, headRef, gitRuns, askTwice, lastCallTimedOut, busy as gitBusy, leftoverLock, STALE_LOCK_MS, indexStamp, classify, filesAt, changesBetween, commitsBetween, treeState, branchTip, watchGit, unmergedPaths, stashStamp, upstreamAdds, pullState, SETTLE_MS, BURST_PATHS, upstreamOf, fetchUpstream, isAncestor, stagedAgainst, fastForward, resetIndex, blobAt, hasFilesUnder, repoBranches } from './gitstate.js'
import { planCatchUp, catchUpAdvice } from './upstream.js'
import { cleanGit, branchBoard } from './branches.js'
import { DEFAULT_KEY } from './branchdocs.js'

export { applyTextDiff }

const LOCAL = Symbol('local')
const STILL_MARKED = 'this file has conflict markers in it; finish editing it (or choose Keep mine) first'
const COLORS = ['#b9432b', '#3b6a9a', '#4a7a45', '#855a9c', '#a8701c', '#2e7a80', '#9c4f6b']
const RECENT_MS = 2 * 60 * 1000
const AGENT_FEED_CAP = 300
/** Whether a process is still running (EPERM: it is, but someone else's). */
function processAlive (pid) {
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}
const PERSONA_AWAY_MS = 30 * 60 * 1000 // an AI session not heard from this long is no longer shown as here
const AUTO_CLAIM_QUIET_MS = 5 * 60 * 1000 // a file we stopped editing this long ago is let go of
// Our AI stopped working (its chat reader says so) while someone waits for a file it held: this long
// for it to hand the file on itself, then Quilt hands it on for it.
const HANDOFF_GRACE_MS = 2 * 60 * 1000
const NOTICE_CAP = 20
const CATCH_UP_KEEP_MS = 3 * 24 * 60 * 60 * 1000 // an unread "while you were away" goes after this
const CATCH_UP_FILES = 200 // paths kept per person in it
// A file removed to make way for a pull is kept for everyone this long; with no pull by then, the removal was meant.
const PULL_WAIT_MS = 60 * 1000
// chokidar drops a 'change' for a path within 50ms of the previous one (no
// trailing event), so each change is re-checked once that window has passed.
const WATCH_RECHECK_MS = 80
// On macOS, Node's fs.watch shares one FSEvents stream per process and
// rebuilds it whenever a watch is added (a new folder, another session), so an
// event in that gap is never delivered. The folder is re-scanned this often
// to catch anything the watcher missed.
const RECONCILE_MS = 1000
// Failed large-file uploads and downloads are tried again this often (and on reconnecting).
const RETRY_MS = 30 * 1000
// Large uploads and downloads each hold the whole file in memory (twice), so only this many run at once.
const MAX_TRANSFERS = 2
// Queued when HEAD moves, so a checkout that changes no file still runs flushPending. Never syncable (.quilt is ignored).
const HEAD_CHANGED = '.quilt/HEAD-changed'
// Settles in a row that couldn't ask git (about a minute) before saying so; the folder stays held regardless.
const GIT_FAILURES_TO_SAY = 30
const FLUSH_MS = 40 // file changes are flushed this long after the first
// How often a folder looks for commits its branch is behind (fetching its upstream first).
const UPSTREAM_MS = Number(process.env.QUILT_UPSTREAM_MS) || 60 * 1000
const INDEX_WATCH_MS = 8000 // after a bring-in, how long the index is checked against what another git may write back

export class Session extends EventEmitter {
  constructor ({ dir, server, room, secret, key = '', viewSecret = '', name, tool = 'unknown', color = null, prefer = 'remote', kind = 'human', shareAgent = true, summarize = null, identity = null, passes = null, startName = '', autoClaimQuietMs = AUTO_CLAIM_QUIET_MS, handoffGraceMs = HANDOFF_GRACE_MS, aiTasks = null, webhookTransport = null, pullWaitMs = PULL_WAIT_MS, bringInUpstream = true }) {
    super()
    this.pullWaitMs = pullWaitMs
    this.bringInUpstream = bringInUpstream // false: commits come in only when someone pulls (tests of the pull path)
    this.pull = null // { upstream, behind, adds: [{ path, same, waiting }] }: what a pull would bring over files the session put here
    this.pullWait = new Map() // path -> { since, stash, timer }: removed to make way for a pull, kept for everyone meanwhile
    this.pullWaitOver = new Set() // waited for and no pull came: not waited for again until the next fetch
    this.pullSaid = ''
    this.root = path.resolve(dir)
    this.server = server
    this.room = room
    this.secret = secret
    this.key = key
    this.viewSecret = viewSecret
    this.name = name
    this.identity = identity
    // Signs in to a relay that requires it (see pass-source.js), with passes for this room.
    this.passes = passes && passes.forRoom ? passes.forRoom(room) : passes
    this.tool = tool
    this.color = color
    this.prefer = prefer
    this.stateDir = migrateDir(this.root)
    this.stateFile = path.join(this.stateDir, 'state.bin')

    this.roomFile = path.join(this.stateDir, 'room.bin')
    // Two documents: the room's (chat, tasks, the agent feed, commit requests, activity) and
    // the one for the branch this folder syncs (its files and what goes with them; see
    // bindBranchDoc). state.bin keeps the branch's, room.bin the room's.
    this.doc = new Y.Doc()
    this.branch = null // the branch this folder syncs, as the relay names it (∅: the room's default, for a folder without git)
    this.branchList = [] // the session's branches, from the relay: [{ key, by, at, base, default, hosted }]
    this.localBranches = [] // this repo's own branches (refs/heads), for the branch menu
    this.legacyState = false // state.json from before branch documents: its state.bin is the room's old single document
    this.bindBranchDoc(new Y.Doc())
    this.uploading = new Map() // path -> hash being uploaded
    this.downloading = new Map() // path -> hash being downloaded
    this.largeFilesOff = false // the relay has no file storage (an older relay)
    this.storedOnDisk = new Map() // path -> hash of the stored large file actually in the folder (saved in state.json)
    this.retry = new Map() // path -> 'upload'|'download' that failed and is tried again later
    // path -> { hash, inline } the relay refused to store for good; tried again only once the file changes.
    // `inline`: it may travel inside the document instead.
    this.uploadRefused = new Map()
    this.transfers = 0 // large uploads and downloads running
    this.transferQueue = [] // resolvers waiting for one to finish
    this.stopped = false
    // pattern -> { by, pattern, note, ts }. The relay owns claims (it checks
    // who asks), so they live outside the shared doc; we keep the last list.
    this.claims = new Map()
    this.chat = this.doc.getArray('chat') // { by, text, ts }
    this.activity = this.doc.getArray('activity') // { by, path, kind, detail, ts }
    this.agentFeed = this.doc.getArray('agentFeed') // { id, by, tool, conv, kind, text, ts }
    this.commitRequests = this.doc.getMap('commitRequests') // id -> { id, by, message, ts, state: 'open'|'done', doneBy, hash }
    this.tasks = this.doc.getMap('tasks') // id -> { id, title, column, by, assignee, forAi, tool, files, conv, verified, qaNotes, recurring, cron, order, ts }
    this.taskComments = this.doc.getMap('taskComments') // task id -> [{ id, by, text, ts }] (task-comments.js)
    // Mentions, direct messages and tasks handed to this member (or their AI), for agents to wake on.
    this.inboxTracker = new Inbox()
    // Shared by every AI session working as this member (each runs its own `quilt mcp`): messages
    // marked as needing no reply, and what each session sent lately, so only one answers each person.
    this.settledIds = new Set()
    this.aiSent = [] // [{ via, targets, text, ts }]
    // Each AI session working through this app (its `quilt mcp`, by its `via` id) under a name of
    // its own: "<first name> · <label>" (persona.js). via -> { via, name, label, aliases, tool,
    // ppid, named, inbox, seenAt, touchedAt }. Its messages, claims, inbox and duties are its own.
    this.personas = new Map()
    this.autoVia = new Map() // a file claimed for one AI session as it edited -> that session's via
    // The agent's webhook subscription (webhooks.js), kept in .quilt/webhook.json: inbox events are POSTed there.
    this.webhook = null
    this.webhookTransport = webhookTransport // { fetch, delays } for tests
    this.webhookSending = Promise.resolve()
    this.relayProblem = null // why the relay can't be reached, when we know (setRelayProblem)
    this.agentPrompts = new Map() // conv -> latest prompt line, so an edit can be titled after the question that started it
    this.merging = new Set() // paths held out of normal sync until their offline merge has run
    this.catchUp = null // "while you were away" (catchup.js), until the person dismisses it
    this.settleTried = new Set() // claimed merges already tried against a session version (id:sha1)
    this.awayBackups = null // while joining: copies of ours kept in .quilt/conflicts, for the catch-up
    this.work = null // { state: 'working'|'done', note, ts }: what an agent says it's doing
    // Claims follow edits (see autoClaim): path -> when this person last changed it. Released when
    // their AI goes idle, when the file has been quiet for autoClaimQuietMs, and at stop.
    this.autoClaims = new Map()
    this.queueNoticed = new Map() // claim pattern -> when our AI was last told someone waits for it
    this.autoClaimQuietMs = autoClaimQuietMs
    this.handoffGraceMs = handoffGraceMs
    // Whether our AI takes work from the board by itself (tasks.js PICKUP_MODES); null: this person's setting.
    this.aiTasks = aiTasks
    this.autoClaimTimer = setInterval(() => this.releaseQuietAutoClaims(), Math.max(50, Math.min(60_000, Math.floor(autoClaimQuietMs / 3))))
    if (this.autoClaimTimer.unref) this.autoClaimTimer.unref()
    // What this person's AI should hear next time it talks to Quilt (an edit of its that was undone).
    this.notices = []

    this.ig = loadIgnore(this.root)
    this.lastKnown = new Map() // path -> text content, or "bin:<sha1>"
    // path -> sha1 of lastKnown when state.json was last saved (null: a state file from before this was kept).
    this.known = null
    // path -> why the shared version could not be written. Tried again by
    // retryFailed; meanwhile what's on disk is never taken for a local edit.
    this.writeFailed = new Map()
    this.pending = new Set()
    this.flushTimer = null
    this.rechecks = new Map() // path -> timer
    this.diskStats = new Map() // path -> stat signature, for the periodic re-scan
    this.reconcileTimer = null
    this.ready = false
    this.myEdits = new Map() // path -> ts of my last edit
    this.lastActivityPush = new Map()
    this.warnedLarge = new Set()
    this.agents = new Set()
    this.focus = ''
    this.kind = kind === 'agent' ? 'agent' : 'human' // an AI agent that joined by itself
    this.agentSharing = shareAgent !== false
    // (kind, text) -> Promise<{ text, how }>; when set, prompts and replies are summarized before sharing.
    this.summarizer = summarize
    this.summaryQueue = Promise.resolve()
    // (request, files) -> Promise<string|null>; when set, auto tasks get a short title.
    this.taskTitler = null
    // Paused: tasks made from AI chats added too many tickets nobody needed.
    this.autoTasks = false
    this.agentState = null
    this.access = null // from the relay: { state, role, scopes, owner, controlled }
    this.members = [] // everyone approved into a controlled session
    this.waiting = [] // people asking to join (shown to anyone who may let people in)
    this.admitBy = 'owner' // who may let people in (from the relay)
    this.sessionName = '' // what the owner named the session (the relay sends it with the member list)
    this.startName = startName // a new session's name (its folder), sent once the relay lets us in as owner
    this.startNameSent = false
    this.logs = [] // the last 200 log lines (for status and tests)
    // Git awareness (gitstate.js): a git operation in this folder is recognised, not broadcast as edits.
    this.git = null // { key, branch, sha } this folder was on when the session started (null: not a repo)
    this.gitSeen = null // the head last seen by classifyBurst
    this.gitIndex = null // indexStamp at the last flush
    this.gitWatcher = null
    this.hold = null // { kind: 'busy'|'settling'|'switching', since, prevHead, to? } while this folder's sync is held
    this.heldPaths = new Set() // paths that changed (here or in the room) while held
    this.heldConflicts = new Set() // paths git left a conflict in during this hold (see noteConflict)
    this.stashSeen = null // the stash's mark when the folder was last quiet: a change by the settle means the person stashed
    this.headChangedAt = 0
    this.settleTimer = null
    this.savedGit = null // { key, sha, held } from state.json: the branch synced, and whether a hold was on, at the last stop
    this.rejoin = false // restarted held: when the hold ends, every path is checked, not only those seen changing
    this.gitFailures = 0 // settles in a row that couldn't ask git
    // Commits made outside the session that this branch is behind (see bringIn): { name, url, sha,
    // behind, ahead, diverged, conflicts, waiting, checkedAt } of the branch's upstream, or null.
    this.upstream = null
    this.upstreamTimer = null
    this.upstreamFetch = false
    this.upstreamPoll = null
    this.upstreamSaid = '' // the advice last given, so it's given once per state
    this.upstreamDeferred = null // the commit this folder let another member's folder bring in first
    this.indexLate = null // the commit the last bring-in moved to: its index is checked for a few seconds (fixIndex)
    this.indexWatchUntil = 0
    this.repo = null // every branch and worktree of the repository (repoBranches), shown to the room
    this.burstByIndex = false // the last isBurst saw the index change
    this.gitChain = Promise.resolve() // git work in this folder, one piece at a time (see gitTask)
    this.classifying = null // { behind } while a burst is classified: the folder is held meanwhile (see held)
    this.checkingBack = false // a look at HEAD while switched away is queued (checkBackOnBranch)
    this.leftoverLock = null // the stamp of an index.lock left behind by a crashed git, paid no attention to
    this.settleGen = 0 // counts settleSoon calls (see onSettled)
    this.lastFileEventAt = 0 // the watcher's last event in the working tree
    this.savedRole = null // this member's role at the last stop (state.json), until the relay says
    this.quiltIgnoreSaid = false
    this.holdAwaitsSync = false // a hold resumed at start settles only once the relay has synced
    if (passes) this.adoptPass(passes.payload)
  }

  /**
   * With sign-in on, the relay knows you by your pass: use its name (and agent
   * badge) here too, so what we write as ours matches what others see.
   */
  adoptPass (p) {
    if (!p) return
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : this.name
    const kind = p.kind === 'agent' ? 'agent' : this.kind
    if (name === this.name && kind === this.kind) return
    this.name = name
    this.kind = kind
    if (this.conn && this.conn.awareness.getLocalState()) {
      this.conn.awareness.setLocalStateField('name', name)
      this.conn.awareness.setLocalStateField('kind', kind)
    }
    this.emit('identity', { name, kind })
  }

  /**
   * A git folder's .gitignore ignores .quilt/ (gitignore.js), so git leaves this
   * session's state alone. Before the watcher starts: the line is shared like any
   * edit of .gitignore, and partners' git ignores it too.
   */
  ignoreQuiltState ({ share = false } = {}) {
    // An edit we may not make (a viewer, or an editor kept to other folders)
    // would only be refused (and kept aside) at every start.
    if (this.access && this.access.state === 'approved' ? this.writeRefusal('.gitignore') : this.savedRole === 'viewer') return
    const r = ensureQuiltIgnored(this.root)
    if (r.added) {
      this.ig = loadIgnore(this.root)
      if (share) this.queue('.gitignore') // the watcher's first scan takes the folder as it is
      if (!this.quiltIgnoreSaid) this.log('Added .quilt/ to .gitignore so git leaves Quilt\'s state alone.')
      this.quiltIgnoreSaid = true
    } else if (r.error && !this.quiltIgnoreSaid) {
      this.quiltIgnoreSaid = true
      this.log(`⚠️ couldn't add .quilt/ to .gitignore (${r.error.message}); git stash -u or git clean could take Quilt's state away`)
    }
  }

  log (msg) { this.logs.push(msg); if (this.logs.length > 200) this.logs.shift(); this.emit('log', msg) }

  /**
   * Points the folder's file state at a branch document: files (path -> Y.Text), blobs
   * (path -> { hash, data } or { hash, size, stored: { id, key } }), fileKeys (keyId ->
   * { wraps, ts }: keys for large files, wrapped for editors and viewers), merges (merge
   * records, see merges.js), tallies ("<name>\0<path>" -> what each person changed, each
   * writing only their own keys) and the chronology (every change with its diff and task).
   */
  bindBranchDoc (doc) {
    this.bdoc = doc
    this.files = doc.getMap('files')
    this.blobs = doc.getMap('blobs')
    this.fileKeys = doc.getMap('fileKeys')
    this.merges = doc.getMap('merges')
    this.tallies = doc.getMap('changes')
    this.history = new HistoryLog(doc, doc.getArray('history'), { origin: LOCAL })
  }

  /** A change to this branch's files and the room's record of it, made together (each document sends its own update). */
  transact (fn, origin = LOCAL) { this.bdoc.transact(() => this.doc.transact(fn, origin), origin) }

  /** The relay's list of the session's branches. */
  setBranches (list) {
    this.branchList = (Array.isArray(list) ? list : []).filter((b) => b && typeof b.key === 'string')
    this.scheduleStatusWrite()
  }

  async start ({ waitTimeoutMs = 0 } = {}) {
    fs.mkdirSync(this.stateDir, { recursive: true })
    this.loadWebhook()
    const hadState = this.loadState()
    // Back in a folder we synced before: the line is an offline edit, merged once synced. A first
    // join adds it after taking the room's files (reconcileFirstJoin), which may replace .gitignore.
    if (hadState) this.ignoreQuiltState()
    this.git = await headKey(this.root)
    this.gitSeen = this.git
    // A repo whose git can't be run (not on the PATH of an app started from the Dock, say) or
    // didn't answer in time, as against a branch with no commits yet, which git reads fine.
    const headTimedOut = !this.git && lastCallTimedOut(this.root)
    const gitUnreadable = !this.git && !!gitDir(this.root) && (headTimedOut || !(headRef(this.root) && await gitRuns(this.root)))
    if (hadState) this.loadClaims()
    // Restarted on another branch, or mid-hold: nothing in this tree is the session's offline work (see resumeHold).
    const resumed = hadState && this.resumeHold()
    // The branch document this folder syncs: the branch it syncs in git (still the one it was paused off, until
    // the folder follows git), ∅ (the room's default) without git.
    this.branch = this.git ? this.git.key : (gitDir(this.root) && headRef(this.root)) || DEFAULT_KEY

    this.conn = new Connection({
      server: this.server,
      room: this.room,
      secret: this.secret,
      key: this.key,
      viewSecret: this.viewSecret,
      kind: this.kind,
      name: this.name,
      identity: this.identity || loadIdentity(),
      passes: this.passes,
      tool: this.tool,
      doc: this.doc,
      // An app's saved document from before branch documents is the room's old one: the relay kept it as that branch's.
      // base: the commit a branch new to the session starts from (a partner without it locally creates it there).
      branch: { key: this.branch, doc: this.bdoc, ...(this.git && this.git.sha ? { base: this.git.sha } : {}), ...(this.legacyState && this.savedGit ? { adopt: this.savedGit.key } : {}) },
      beforeRemote: () => { if (this.ready) this.flushPending() }
    })
    this.conn.on('status', (s) => {
      this.log(s === 'connected' ? `connected to relay` : 'disconnected from relay, reconnecting…')
      this.scheduleStatusWrite()
      if (s === 'connected') this.retryFailed()
    })
    this.retryTimer = setInterval(() => this.retryFailed(), RETRY_MS)
    this.retryTimer.unref()
    this.conn.on('warn', (m) => this.emit('debug', m))
    this.conn.on('fatal', (err) => this.emit('fatal', err))
    this.conn.on('pass', (p) => this.adoptPass(p))
    this.conn.on('problem', (msg) => this.setRelayProblem(msg))
    this.conn.on('claims', (list) => this.setClaims(list))
    this.conn.on('access', (a) => this.setAccess(a))
    this.conn.on('members', (m) => this.setMembers(m))
    this.conn.on('branches', (list) => this.setBranches(list))
    this.conn.on('branch-joined', (r) => { if (typeof r.branch === 'string' && r.branch) { this.branch = r.branch; this.scheduleStatusWrite() } })
    this.conn.on('branch-refused', (why) => this.log(`⚠️ the relay refused this folder's branch: ${why}`))
    this.setupPresence()

    this.loadCatchUp()
    this.awayBackups = []
    if (hadState) {
      // We've synced this folder before: hold what was edited while we were
      // away, let the relay tell us what the others did, then merge the two.
      // Restarted on another branch, or mid-hold: nothing in this tree is the session's offline work.
      const marks = historyMarks(this.history.entries()) // what we had seen: the catch-up is the rest
      if (gitUnreadable) this.saysGitUnreadable(resumed)
      const offline = resumed ? { entries: [], take: [], downloads: [] } : this.captureOffline()
      this.goLive()
      if (offline.entries.length) this.log(`${offline.entries.length} file(s) changed while you were away; merging once the relay has synced…`)
      const synced = this.conn.waitForSync()
      synced.then(() => this.mergeOffline(offline)).then((mine) => {
        if (mine) this.noteCatchUp({ ...awayChanges(this.history.entries(), marks, this.name), since: this.savedSeenAt, mine })
      }).catch((err) => {
        // Never synced (the relay refused us): nothing can be merged, so nothing stays held.
        for (const e of offline.entries) this.merging.delete(e.rel)
        this.awayBackups = null
        this.emit('debug', `offline merge did not run: ${err && err.message}`)
      })
      if (resumed) {
        // The doc loaded from disk is the room as it was at the last stop: the hold settles
        // against the room as it is now. Never synced: the hold stays on and nothing is shared.
        this.holdAwaitsSync = true
        synced.then(() => { this.holdAwaitsSync = false; this.settleSoon() }, () => {})
      }
    } else {
      if (gitUnreadable) this.saysGitUnreadable(false)
      this.log('waiting for relay…')
      const sync = this.conn.waitForSync()
      // In a session with an owner we may have to wait for them to let us in.
      let onAccess
      const pending = new Promise((resolve) => {
        onAccess = (a) => { if (a.state === 'pending') resolve('pending') }
        this.conn.on('access', onAccess)
      })
      let timer
      const timeout = waitTimeoutMs ? new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out connecting to relay')), waitTimeoutMs) }) : null
      try {
        const first = await Promise.race([sync.then(() => 'synced'), pending, ...(timeout ? [timeout] : [])])
        if (first === 'pending') {
          // Finish joining in the background once let in.
          this.admitted = sync.then(async () => {
            this.noteFirstJoin(this.reconcileFirstJoin())
            this.goLive()
            this.ignoreQuiltState({ share: true })
            await this.startWatcher()
            this.log('✅ you were let in')
            this.emit('status-changed')
          }).catch(() => {})
          return this
        }
      } finally {
        clearTimeout(timer)
        this.conn.off('access', onAccess)
      }
      this.noteFirstJoin(this.reconcileFirstJoin())
      this.goLive()
      this.ignoreQuiltState({ share: true })
    }
    await this.startWatcher()
    return this
  }

  // --------------------------------------------------------------- access --

  setAccess (a) {
    const was = this.access
    this.access = a
    if (a.state === 'approved' && a.owner) this.sendStartName()
    if (a.state === 'pending' && (!was || was.state !== 'pending')) this.log(`⏳ waiting for the session owner to let you in (you were invited to ${a.invitedAs === 'viewer' ? 'view' : 'edit'})`)
    if (a.state === 'approved' && was && (was.role !== a.role || String(was.scopes) !== String(a.scopes) || String(was.scopesExcept || []) !== String(a.scopesExcept || []))) {
      const except = a.role !== 'viewer' && a.scopesExcept && a.scopesExcept.length ? `, except ${a.scopesExcept.join(', ')}` : ''
      this.log(`🔑 you can now ${a.role === 'viewer' ? 'only view this session' : a.scopes.length ? `change files in ${a.scopes.join(', ')}` : 'change any file'}${except}`)
    }
    if (a.state === 'approved' && (was ? was.talk !== false : true) && a.talk === false) this.log(`🔇 ${TALK_REFUSED}`)
    if (a.state === 'approved' && was && was.talk === false && a.talk !== false) this.log('💬 you can post in this session again')
    // Partners see you sharing your AI chat only while it can reach them.
    if (a.state === 'approved' && (was?.talk === false) !== (a.talk === false)) this.publishAgentState()
    if (a.refused) this.log(`🔒 the relay undid your change to ${a.refused.join(', ')}: ${a.why}`)
    this.emit('access', a)
    this.scheduleStatusWrite()
  }

  setMembers ({ members, pending, sessionName, admitBy }) {
    this.members = members || []
    if (typeof sessionName === 'string') this.sessionName = sessionName
    if (admitBy !== undefined) this.admitBy = admitBy
    if (pending !== undefined) {
      const list = pending || []
      const known = new Set(this.waiting.map((p) => p.key))
      for (const p of list) if (!known.has(p.key)) this.log(`🙋 ${p.name}${p.kind === 'agent' ? ' (an agent)' : ''} wants to join as ${p.invitedAs === 'viewer' ? 'a viewer' : 'an editor'}`)
      this.waiting = list
    }
    this.emit('members', { members: this.members, pending: this.waiting })
    this.emit('status-changed')
  }

  /** Why we may not change rel, or null if we may. */
  writeRefusal (rel) {
    const a = this.access
    if (!a || a.state !== 'approved') return null
    return changeRefusal(a, rel)
  }

  /** May we post to chat and the feed? (The session's owner can say no; the relay undoes posts then.) */
  mayTalk () {
    return !(this.access && this.access.state === 'approved' && this.access.talk === false)
  }

  get isOwner () { return !!(this.access && this.access.owner) }
  /**
   * May this session let people in (owner, or under the room's who-can-admit setting)?
   * A relay older than admitBy sends no canAdmit: work it out, so its owner still sees who's waiting.
   */
  get canAdmit () {
    const a = this.access
    if (!a || a.state !== 'approved') return false
    if (typeof a.canAdmit === 'boolean') return a.canAdmit
    return canAdmit(a, a.admitBy || this.admitBy)
  }

  /**
   * Owner only: let someone in, as an access type (`typeId`, with the `access` it comes to:
   * { files, folders, foldersExcept, talk }), or, as before access types, with a role and
   * the folders they may change.
   */
  approve (key, { role, scopes, typeId, access } = {}) { return this.conn.adminRequest({ op: 'approve', key, role, scopes, typeId, access }) }
  deny (key) { return this.conn.adminRequest({ op: 'deny', key }) }
  setMember (key, { role, scopes, access } = {}) { return this.conn.adminRequest({ op: 'set', key, role, scopes, access }) }
  removeMember (key) { return this.conn.adminRequest({ op: 'remove', key }) }
  /** Owner only: who may let people into this session (owner | editors | members). */
  setAdmitBy (admitBy) { return this.conn.adminRequest({ op: 'admitBy', admitBy }) }

  /** Owner only: names the session for everyone in it (1 to 80 characters). */
  rename (name) { return this.conn.adminRequest({ op: 'name', name }) }

  /** A new session is named after its folder, once, as soon as the relay lets us in as its owner. */
  sendStartName () {
    if (!this.startName || this.startNameSent) return
    this.startNameSent = true
    this.rename(this.startName).catch((err) => this.log(`couldn't name the session: ${err.message}`))
  }

  goLive () {
    this.observeBranch()
    this.shareKeysWithViewers()
    this.chat.observe((ev, tr) => {
      for (const item of ev.changes.added) {
        for (const msg of item.content.getContent()) {
          // A malformed message (a modified client can push anything) is skipped, never fatal to the rest.
          try {
            if (!this.canSee(msg)) continue
            this.emit('message', this.describeMessage(msg))
            if (tr.origin === LOCAL || msg.by === this.name) continue
            this.log(`💬 ${formatMessage(msg)}`)
            if (msg.file) {
              this.fetchFile(msg).then(
                (dest) => this.log(`📎 received ${msg.file.name} from ${msg.by} → ${path.relative(this.root, dest)}`),
                (err) => this.log(`could not download ${msg.file.name}: ${err.message} (retry with: quilt get ${msg.id})`)
              )
            }
          } catch (err) {
            this.emit('debug', `skipping a bad chat message: ${err.message}`)
          }
        }
      }
      // What the person writes here (to "<them>'s AI", or one of their AI sessions) wakes that session.
      this.scanInbox({ quiet: tr.origin === LOCAL, personas: false })
      this.scheduleStatusWrite()
    })
    this.activity.observe(() => this.scheduleStatusWrite())
    this.tasks.observe((ev, tr) => {
      this.scanInbox({ quiet: tr.origin === LOCAL })
      this.scheduleStatusWrite()
    })
    this.taskComments.observe(() => this.scheduleStatusWrite())
    this.commitRequests.observe((ev, tr) => {
      for (const [id, change] of ev.changes.keys) {
        const r = this.commitRequests.get(id)
        if (tr.origin === LOCAL || !r) continue
        if (change.action === 'add') this.log(`📌 ${r.by} asked for a commit: ${r.message}`)
        else if (r.state === 'done') this.log(`✅ ${r.doneBy || 'the host'} committed ${r.hash ? r.hash.slice(0, 7) : ''} (${r.message})`)
      }
      this.emit('status-changed')
    })
    this.agentFeed.observe((ev) => {
      const added = []
      for (const item of ev.changes.added) for (const e of item.content.getContent()) if (e && e.id) added.push(e)
      if (added.length) this.emit('agent-feed', added)
    })
    this.doc.on('update', () => this.scheduleStateSave())
    this.ready = true
    this.scanInbox({ quiet: true }) // take stock: what is already here wakes nobody
    this.fetchMissedFiles()
    this.scheduleStateSave()
    this.scheduleStatusWrite()
  }

  /** Watches the branch document: the room's changes to files reach the disk. Done again for each branch the folder moves to. */
  observeBranch () {
    this.files.observeDeep((events, tr) => {
      if (tr.origin === LOCAL) return
      const paths = new Set()
      for (const ev of events) {
        if (ev.target === this.files) for (const k of ev.changes.keys.keys()) paths.add(k)
        else if (ev.path.length) paths.add(ev.path[0])
      }
      this.applyRemote(paths)
    })
    this.blobs.observe((ev, tr) => {
      if (tr.origin === LOCAL) return
      const paths = [...ev.changes.keys.keys()]
      for (const k of paths) this.retry.delete(k)
      this.applyRemote(paths)
    })
    this.fileKeys.observe(() => {
      this.shareKeysWithViewers()
      // Files whose key just arrived can be downloaded now.
      for (const [rel, b] of this.blobs) if (b && b.stored && this.lastKnown.get(rel) !== `bin:${b.hash}`) this.writeOut(rel)
    })
    this.merges.observe(() => { this.scheduleStatusWrite(); this.emit('merges', this.mergeList()) })
    this.bdoc.on('update', () => this.scheduleStateSave())
  }

  // ---------------------------------------------------------------- state --

  loadState () {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(this.stateDir, 'state.json'), 'utf8'))
      if (meta.room !== this.room || meta.server !== this.server) return false
      // state.bin: the branch document this folder synced. From before branch documents it is the
      // room's one document, which the relay kept as that branch's (Room.migrateLegacy).
      Y.applyUpdate(this.bdoc, fs.readFileSync(this.stateFile), LOCAL)
      try { Y.applyUpdate(this.doc, fs.readFileSync(this.roomFile), LOCAL) } catch {} // none from before: the relay sends it
      this.legacyState = meta.layout !== 2
      this.storedOnDisk = new Map(Object.entries(meta.storedOnDisk || {}))
      this.known = meta.known ? new Map(Object.entries(meta.known)) : null
      // No gitKey (an older state file): taken as the branch the folder is on now.
      this.savedRole = typeof meta.role === 'string' ? meta.role : null
      this.savedSeenAt = typeof meta.seenAt === 'number' ? meta.seenAt : null
      this.savedGit = typeof meta.gitKey === 'string' && meta.gitKey ? { key: meta.gitKey, sha: typeof meta.gitSha === 'string' ? meta.gitSha : null, held: !!meta.gitHeld } : null
      return true
    } catch {
      return false
    }
  }

  // ------------------------------------------------------------ catch-up --

  get catchUpFile () { return path.join(this.stateDir, 'catchup.json') }

  /** A catch-up the person hasn't dismissed yet survives a restart, for a few days. */
  loadCatchUp () {
    try {
      const c = JSON.parse(fs.readFileSync(this.catchUpFile, 'utf8'))
      if (c && Array.isArray(c.people) && Date.now() - (c.at || 0) < CATCH_UP_KEEP_MS) this.catchUp = c
    } catch {}
  }

  saveCatchUp () {
    try {
      if (!this.catchUp) fs.rmSync(this.catchUpFile, { force: true })
      else writePrivateJson(this.catchUpFile, this.catchUp)
    } catch (err) {
      this.emit('debug', `could not save the catch-up: ${err.message}`)
    }
  }

  /** A copy of ours kept in .quilt/conflicts while joining: the catch-up says where. */
  noteBackup (rel, dest) {
    if (this.awayBackups) this.awayBackups.push({ path: rel, copy: path.relative(this.root, dest).split(path.sep).join('/') })
  }

  noteFirstJoin ({ pulled } = {}) {
    this.noteCatchUp({ people: [], partial: false, first: true, pulled: pulled || 0, since: null, mine: null })
  }

  /** What changed while we were away, folded into any catch-up not yet dismissed. */
  noteCatchUp ({ people, partial, first = false, pulled = 0, since, mine }) {
    const next = {
      at: Date.now(),
      since: since || null,
      first,
      pulled,
      partial,
      // A few hundred paths at most: status goes out on every change.
      people: people.map((p) => ({ ...p, fileCount: p.files.length, files: p.files.slice(0, CATCH_UP_FILES) })),
      backups: (this.awayBackups || []).slice(0, CATCH_UP_FILES),
      mine: { shared: mine?.shared || 0, merged: mine?.merged || [], conflicts: mine?.conflicts || [] }
    }
    this.awayBackups = null
    if (emptyCatchUp(next)) return
    this.catchUp = mergeCatchUp(this.catchUp, next)
    this.saveCatchUp()
    const others = next.people.map((p) => `${p.name} changed ${p.fileCount} file${p.fileCount === 1 ? '' : 's'}`)
    if (others.length) this.log(`👋 while you were away: ${others.join(', ')}`)
    this.scheduleStatusWrite()
  }

  dismissCatchUp () {
    this.catchUp = null
    this.saveCatchUp()
    this.scheduleStatusWrite()
    return { ok: true }
  }

  scheduleStateSave () {
    if (this.stateTimer) return
    this.stateTimer = setTimeout(() => this.saveState(), 1000)
  }

  /** saveState now, and never throws (a hold must start even if the state can't be written). */
  saveStateNow () {
    try { this.saveState() } catch (err) { this.log(`could not save the session's state: ${err.message}`) }
  }

  saveState () {
    clearTimeout(this.stateTimer)
    this.stateTimer = null
    const save = (file, doc) => { fs.writeFileSync(file + '.tmp', Y.encodeStateAsUpdate(doc)); fs.renameSync(file + '.tmp', file) }
    save(this.stateFile, this.bdoc)
    save(this.roomFile, this.doc)
    // Hashes of what we last wrote or read for each path: on the next start they
    // tell a file the room changed behind our back from one edited offline.
    const known = {}
    for (const [rel, key] of this.lastKnown) known[rel] = sha1(key)
    // When we were last in touch with the session: "you left 3h ago" on the next catch-up.
    if (this.conn && this.conn.connected) this.savedSeenAt = Date.now()
    fs.writeFileSync(path.join(this.stateDir, 'state.json'), JSON.stringify({ room: this.room, server: this.server, layout: 2, branch: this.branch, storedOnDisk: Object.fromEntries(this.storedOnDisk), known, ...this.gitState(), ...this.roleState(), ...(this.savedSeenAt ? { seenAt: this.savedSeenAt } : {}) }))
  }

  /** This member's role, so the next start knows it before the relay says (ignoreQuiltState). */
  roleState () {
    const role = this.access && this.access.state === 'approved' ? this.access.role : this.savedRole
    return role ? { role } : {}
  }

  /**
   * What state.json keeps of git: the branch this session syncs, the commit
   * it was last seen at there, and whether a hold was on. The next start
   * reads them in resumeHold.
   */
  gitState () {
    if (!this.git) return this.savedGit ? { gitKey: this.savedGit.key, gitSha: this.savedGit.sha, gitHeld: this.savedGit.held } : {}
    const seen = this.hold ? this.hold.prevHead : this.gitSeen
    // A burst still being classified counts as held: a crash then restarts held, never sharing what git did.
    return { gitKey: this.git.key, gitSha: seen && seen.key === this.git.key ? seen.sha : null, gitHeld: this.held() }
  }

  // ------------------------------------------------------------ reconcile --

  sharedPaths () {
    return new Set([...this.files.keys(), ...this.blobs.keys()])
  }

  syncable (rel) {
    return isSafeRelPath(rel) && !isIgnored(this.ig, rel)
  }

  /**
   * Back in a folder we synced before: note every file edited while away as
   * { rel, base, ours } (base: the shared version we last had; ours: what's
   * on disk; a key is text, "bin:<sha1>", or null for "gone") and keep those
   * paths out of normal sync until mergeOffline has merged them against what
   * the session did meanwhile. Nothing is pushed here.
   */
  captureOffline () {
    const onDisk = new Set(walk(this.root, this.ig))
    const downloads = []
    const take = [] // shared versions that never reached the folder: written now, not pushed back
    const entries = []
    // A merge that was interrupted (quit or crash after the relay synced) left
    // its bases behind: the saved doc may already hold the session's version,
    // so it is no base any more.
    const prior = this.readHeldBases()
    const hold = (rel, base, ours) => {
      if (prior.has(rel)) base = prior.get(rel)
      this.merging.add(rel)
      entries.push({ rel, base, ours })
    }
    for (const rel of this.sharedPaths()) {
      if (!this.syncable(rel)) continue
      const known = this.sharedKey(rel)
      if (known !== undefined) this.lastKnown.set(rel, known)
      const b = this.blobs.get(rel)
      const had = this.storedOnDisk.get(rel)
      if (b && b.stored && had !== b.hash) {
        // Its download hadn't finished when we stopped, so the folder doesn't
        // have it yet: fetch it rather than share what's on disk. Anything
        // other than the version we last wrote was edited offline; keep it.
        const disk = this.readDisk(rel)
        if (disk && disk.key !== undefined && !(disk.binary && disk.hash === had)) this.keepConflict(rel, disk)
        if (disk && disk.key !== undefined) this.lastKnown.set(rel, disk.key)
        else this.lastKnown.delete(rel)
        onDisk.delete(rel)
        downloads.push(rel)
        continue
      }
      if (onDisk.has(rel)) continue
      // Not in the folder: deleted while offline, unless it was never written (the write failed) and is still due.
      if (this.known && !this.known.has(rel)) take.push(rel)
      else hold(rel, known, null)
    }
    for (const rel of onDisk) {
      const was = this.known && this.known.get(rel)
      const shared = this.sharedKey(rel)
      const disk = this.readDisk(rel)
      if (was && shared !== undefined && disk && disk.key !== undefined && disk.key !== shared && sha1(disk.key) === was) {
        // The folder still has the version we last wrote, so the room moved
        // on without the change reaching the disk: take it, don't undo it.
        // (It's what we last wrote, so replacing it keeps no conflict copy.)
        this.lastKnown.set(rel, disk.key)
        take.push(rel)
        continue
      }
      if (!disk || disk.skip || disk.tooLarge) continue
      if (disk.key === shared) { this.lastKnown.set(rel, disk.key); continue }
      hold(rel, shared, disk.key)
    }
    this.saveHeldBases(entries)
    return { entries, take, downloads }
  }

  get heldBasesFile () { return path.join(this.stateDir, 'merging.json') }

  /** rel -> base (undefined: the session didn't have the file) left by an unfinished offline merge. */
  readHeldBases () {
    const out = new Map()
    let saved
    try { saved = JSON.parse(fs.readFileSync(this.heldBasesFile, 'utf8')) } catch { return out }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return out
    for (const [rel, base] of Object.entries(saved)) {
      if (base === null) out.set(rel, undefined)
      else if (typeof base === 'string') out.set(rel, base)
    }
    return out
  }

  /** Keeps the bases of the held paths until they are merged, so a quit or crash in between can't lose them. */
  saveHeldBases (entries) {
    try {
      if (!entries.length) { fs.rmSync(this.heldBasesFile, { force: true }); return }
      writePrivateJson(this.heldBasesFile, Object.fromEntries(entries.map((e) => [e.rel, e.base ?? null])))
    } catch (err) {
      this.log(`could not save the offline merge's bases: ${err.message}`)
    }
  }

  /** Runs once the relay has synced: merges every captured path against the session's version. */
  async mergeOffline ({ entries, take, downloads }) {
    if (this.stopped) { for (const e of entries) this.merging.delete(e.rel); return null } // the next start captures them again
    const counts = { pushed: 0, merged: 0, ai: 0, conflict: 0 }
    const paths = { merged: [], conflict: [] } // for the catch-up
    const queue = entries.slice()
    // Still to merge, as merging.json has them: a path drops out once merged,
    // and stays if its merge failed or the session stopped first.
    const held = new Map(entries.map((e) => [e.rel, e]))
    const worker = async () => {
      while (queue.length && !this.stopped) {
        const e = queue.shift()
        try {
          const r = await this.mergeOne(e)
          if (r) counts[r]++
          if (paths[r]) paths[r].push(e.rel)
          if (this.stopped) continue // it may have stopped part way: keep its base
          held.delete(e.rel)
        } catch (err) {
          this.merging.delete(e.rel)
          this.log(`could not merge ${e.rel}: ${err.message}`)
          if (this.setAside(e.rel)) held.delete(e.rel) // ours is in .quilt/conflicts: nothing left to merge
          counts.conflict++
          paths.conflict.push(e.rel)
        }
        this.saveHeldBases([...held.values()])
      }
    }
    await Promise.all([worker(), worker()])
    for (const e of entries) this.merging.delete(e.rel)
    if (this.stopped) return null // merging.json keeps what's left, for the next start
    // After the merges, not before: a take write can create a folder where a
    // file deleted offline was, and that deletion must be shared first.
    for (const rel of take) this.tryWrite(rel)
    for (const rel of downloads) {
      const b = this.blobs.get(rel)
      if (b && b.stored) this.downloadLarge(rel, b) // the session may have deleted or replaced it meanwhile
    }
    pruneMerges(this.bdoc, this.merges, LOCAL)
    const parts = []
    if (counts.pushed) parts.push(`${counts.pushed} shared`)
    if (counts.merged) parts.push(`${counts.merged} merged`)
    if (counts.ai) parts.push(`${counts.ai} merged by AI (have a look)`)
    if (counts.conflict) parts.push(`${counts.conflict} need${counts.conflict === 1 ? 's' : ''} merging`)
    if (parts.length) this.log(`${counts.conflict ? '⚠️ ' : '✅ '}your offline changes: ${parts.join(', ')}`)
    this.emit('merges', this.mergeList())
    this.scheduleStatusWrite()
    this.settleReleasedMerges()
    return { shared: counts.pushed, merged: paths.merged, conflicts: paths.conflict }
  }

  /**
   * A merge that failed part way: ours goes to .quilt/conflicts and the
   * session's version onto the disk, so a later edit never pushes ours raw.
   * True when it did both.
   */
  setAside (rel) {
    try {
      const disk = this.readDisk(rel)
      if (disk && disk.key !== undefined && disk.key !== this.sharedKey(rel)) {
        this.keepConflict(rel, disk)
        this.lastKnown.set(rel, disk.key) // already kept: writeOut needn't copy it again
      }
      return this.tryWrite(rel)
    } catch (err) {
      this.log(`could not put the session's version of ${rel} back: ${err.message}`)
      return false
    }
  }

  /** This machine's public key, for merge records (Connection loads it when the session wasn't given one). */
  myKey () { return (this.identity || this.conn?.identity)?.publicKey || null }

  /** Merges one captured path. Returns what happened, or null when nothing needed doing. */
  async mergeOne ({ rel, base, via = null }) {
    const release = () => this.merging.delete(rel)
    const disk = this.readDisk(rel)
    if (disk && (disk.skip || disk.tooLarge)) { release(); return null }
    const ours = disk ? disk.key : null // re-read: it may have changed again before the relay synced
    const theirs = this.sharedKey(rel)
    const theirsBy = this.lastEditorOf(rel)
    // Claimed by someone else meanwhile: a record, even if they haven't changed it yet (ingest would reject it).
    const claim = this.claimFor(rel)
    const claimedByOther = claim && !this.ownClaim(claim)
    const pulled = via === 'pull'
    if (theirs === base && !claimedByOther) { release(); return this.ingest(rel, { pulled }) ? 'pushed' : null } // nobody else touched it
    if (ours === theirs || (ours === null && theirs === undefined)) {
      release()
      if (ours === null) this.lastKnown.delete(rel); else this.lastKnown.set(rel, ours)
      return null
    }
    // Not on disk and never known here (a file new from the room) is no change of ours either.
    if (ours === base || (ours === null && base === undefined)) {
      // Only they changed it. (lastKnown may hold a newer doc's text when the base came from merging.json.)
      release()
      if (ours !== null) this.lastKnown.set(rel, ours)
      this.tryWrite(rel)
      return null
    }
    const binary = [base, ours, theirs].some((k) => typeof k === 'string' && k.startsWith('bin:'))
    if (claimedByOther) return this.openConflict({ rel, base, ours, theirs, theirsBy, disk, kind: 'claimed', claimedBy: claim.by, binary, via })
    if (binary || ours === null || theirs === undefined) return this.openConflict({ rel, base, ours, theirs, theirsBy, disk, kind: 'conflict', binary, via })
    const { text, conflicts } = merge3(base || '', ours, theirs)
    if (!conflicts.length) {
      this.applyMerged(rel, text, `with ${theirsBy || 'the session'}'s changes`, { pulled })
      release()
      return 'merged'
    }
    // Both sides changed the same lines: the people involved settle it (Quilt never merges with an AI).
    return this.openConflict({ rel, base, ours, theirs, theirsBy, disk, kind: 'conflict', binary: false, via })
  }

  /** Writes a merged text to the shared doc and the disk as one edit of ours (`pulled`: one a git pull brought). */
  applyMerged (rel, text, detail, { pulled = false } = {}) {
    const abs = resolveInside(this.root, rel)
    this.transact(() => {
      this.blobs.delete(rel)
      let ytext = this.files.get(rel)
      if (!ytext) { ytext = new Y.Text(); this.files.set(rel, ytext) }
      const before = ytext.toString()
      applyTextDiff(ytext, text)
      this.recordActivity(rel, 'merged', detail, { before, after: text }, { pulled }) // the chronology keeps the merge's diff
    }, LOCAL)
    if (this.held()) {
      // git is at work on the folder: the merge reaches the disk when the hold ends (lastKnown, the base then, stays).
      this.heldPaths.add(rel)
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      this.writeFile(rel, abs, text)
      this.lastKnown.set(rel, text)
    }
    this.setOnDisk(rel, null)
    this.noteMyEdit(rel, { pulled })
    this.log(`🧵 merged ${rel} ${detail}`)
  }

  /**
   * The two sides cannot be combined on their own: the session's version
   * stays on disk and in the doc, ours is kept in the record and under
   * .quilt/merges/<id>/, and everyone sees the record until someone settles it.
   */
  openConflict ({ rel, base, ours, theirs, theirsBy, disk, kind, reason = null, claimedBy = null, binary, via = null }) {
    const text = (k) => (typeof k === 'string' && !k.startsWith('bin:') ? k : null)
    // theirsBy and claimedBy are peer-written (an activity entry, a claim):
    // flatten them so a stray control character can't make openMerge throw
    // and leave this conflict silently unrecorded.
    const by = theirsBy ? cleanName(theirsBy) : null
    const claimant = claimedBy ? cleanName(claimedBy) : null
    const rec = openMerge(this.bdoc, this.merges, {
      path: rel,
      by: this.name,
      byId: this.myKey(),
      others: by ? [by] : [],
      kind,
      ours: binary ? null : text(ours),
      oursDeleted: ours === null,
      via,
      base: binary ? null : text(base),
      theirsHash: theirs === undefined ? null : sha1(theirs),
      binary,
      claimedBy: claimant,
      // One line of at most 500 characters, or the record would be invalid.
      // eslint-disable-next-line no-control-regex
      reason: reason ? String(reason).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500) || null : null
    }, LOCAL)
    this.writeMergeFiles(rec.id, { base, ours, theirs, disk })
    // The session's version goes back on disk (or the file goes, if the session
    // deleted it). lastKnown is set to ours first so writeOut doesn't also copy
    // it to .quilt/conflicts: the merge folder already has it.
    this.merging.delete(rel)
    if (ours === null) this.lastKnown.delete(rel); else this.lastKnown.set(rel, ours)
    this.tryWrite(rel)
    const who = claimant ? `${claimant} has it claimed` : by ? `${by} changed it too` : 'it changed in the session too'
    this.log(`⚠️  ${rel} needs merging: ${who}${reason ? ` (${reason})` : ''}. Your version is kept; see Merges in the app.`)
    this.emit('file-changed', { path: rel, by: by || 'partner' })
    return 'conflict'
  }

  /** Keeps the three versions of a merge on this machine, for Send to… and for files too big for the record. */
  writeMergeFiles (id, { base, ours, theirs, disk = null }) {
    if (!id) return
    const dir = this.mergeDir(id)
    fs.mkdirSync(dir, { recursive: true })
    const put = (name, key, buf) => {
      if (buf) { fs.writeFileSync(path.join(dir, name), buf); return }
      if (typeof key === 'string' && !key.startsWith('bin:')) fs.writeFileSync(path.join(dir, name), key)
    }
    put('base', base)
    put('ours', ours, disk && disk.binary ? disk.buf : null)
    if (typeof theirs === 'string' && theirs.startsWith('bin:')) {
      const shared = this.blobs.get(this.mergeList().find((m) => m.id === id)?.path)
      if (shared && shared.data) fs.writeFileSync(path.join(dir, 'theirs'), Buffer.from(shared.data, 'base64'))
    } else put('theirs', theirs)
  }

  reconcileFirstJoin () {
    const onDisk = new Set(walk(this.root, this.ig))
    let pulled = 0; let pushed = 0; let backedUp = 0
    const backupDir = path.join(this.stateDir, 'conflicts', new Date().toISOString().replace(/[:.]/g, '-'))
    for (const rel of this.sharedPaths()) {
      if (!this.syncable(rel)) continue
      const disk = this.readDisk(rel)
      const shared = this.sharedKey(rel)
      const b = this.blobs.get(rel)
      if (disk && disk.key === shared) {
        this.lastKnown.set(rel, shared)
        if (b && b.stored) this.setOnDisk(rel, b.hash)
        continue
      }
      if (disk && this.prefer === 'local') continue // pushed below
      if (disk && disk.skip) {
        // A folder where the room has a file: moved into the backup, like a differing file is copied there.
        let st = null
        if (!disk.outside) try { st = fs.lstatSync(path.join(this.root, ...rel.split('/'))) } catch {}
        if (!st || !st.isDirectory()) continue // a link or special file: left alone, as the live sync leaves it
        this.moveToBackup(rel, backupDir)
        for (const p of onDisk) if (p.startsWith(rel + '/')) onDisk.delete(p)
        backedUp++
      } else if (disk) {
        const dest = path.join(backupDir, ...rel.split('/'))
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(path.join(this.root, ...rel.split('/')), dest)
        this.noteBackup(rel, dest)
        backedUp++
        // Already backed up: the download needn't keep another copy.
        if (b && b.stored && disk.key !== undefined) this.lastKnown.set(rel, disk.key)
      } else {
        // A file where the room has a folder: moved into the backup so the folder can be made.
        const moved = this.clearParents(rel, backupDir)
        if (moved) { onDisk.delete(moved); backedUp++ }
      }
      if (!this.tryWrite(rel)) continue
      onDisk.delete(rel)
      pulled++
    }
    // What the folder brings to the room is its starting point, not a change anyone made.
    this.seeding = true
    try {
      for (const rel of onDisk) {
        if (this.lastKnown.has(rel)) continue
        if (this.ingest(rel)) pushed++
      }
    } finally { this.seeding = false }
    this.log(`initial sync: ${pulled} file(s) pulled, ${pushed} pushed` +
      (backedUp ? `, ${backedUp} local version(s) backed up to ${path.relative(this.root, backupDir)}` : ''))
    return { pulled }
  }

  /** The shared content of a path in lastKnown format. */
  sharedKey (rel) {
    const t = this.files.get(rel)
    if (t) return t.toString()
    const b = this.blobs.get(rel)
    if (b) return `bin:${b.hash}`
    return undefined
  }

  /**
   * What the folder holds at rel: text, a binary buffer, nothing (null), or a
   * reason not to use it. `outside`: a parent is a link leading out of the
   * project, so the file is never read (it may be anyone's).
   */
  readDisk (rel) {
    let abs
    try { abs = resolveInside(this.root, rel) } catch { return { skip: true, outside: true } }
    let st
    try { st = fs.lstatSync(abs) } catch { return null }
    if (!st.isFile()) return { skip: true }
    if (st.size > MAX_STORED_BINARY_BYTES) return { tooLarge: true }
    const buf = fs.readFileSync(abs)
    if (looksBinary(buf)) {
      if (buf.length > MAX_BINARY_BYTES && this.largeFilesOff) return { tooLarge: true }
      const hash = sha1(buf)
      return { binary: true, buf, hash, key: `bin:${hash}` }
    }
    if (buf.length > MAX_TEXT_BYTES) return { tooLarge: true }
    const text = buf.toString('utf8')
    return { text, key: text }
  }

  // ------------------------------------------------------- local -> shared --

  queue (rel) {
    this.pending.add(rel)
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flushPending(), FLUSH_MS)
  }

  flushPending () {
    clearTimeout(this.flushTimer)
    this.flushTimer = null
    const paths = [...this.pending]
    this.pending.clear()
    if (this.classifying) {
      // A burst is being classified: these wait behind it, and are looked at together once it's known.
      for (const rel of paths) this.classifying.behind.add(rel)
      return
    }
    if (this.hold) {
      for (const rel of paths) if (rel !== HEAD_CHANGED) this.heldPaths.add(rel)
      if (this.hold.kind === 'switching') this.checkBackOnBranch() // in case the watcher missed the way back
      // Only a change here puts the settle off: the flush before each update from the room
      // (beforeRemote) has none, and a partner typing must not hold this folder for good.
      else if (paths.length) this.settleSoon()
      return
    }
    if (this.git && this.isBurst(paths)) return this.startClassify(paths)
    this.ingestAll(paths)
  }

  ingestAll (paths) {
    for (const rel of paths) {
      try { this.ingest(rel) } catch (err) { this.log(`could not sync ${rel}: ${err.message}`) }
    }
  }

  // ------------------------------------------------------------------ git --
  // A git operation in a synced folder (stash, reset, pull, rebase, checkout)
  // rewrites files in a burst. Those are not edits: the folder's sync is held
  // until git is done, then the room's work is put back (discard), the new
  // commits are merged into it (advance), or the folder pauses (switch).

  /** Did git just touch this folder? (index written, HEAD moved, an operation in progress, or a flood of paths) */
  isBurst (paths) {
    const stamp = indexStamp(this.root)
    const indexChanged = stamp !== this.gitIndex
    this.gitIndex = stamp
    this.burstByIndex = indexChanged
    return indexChanged || Date.now() - this.headChangedAt < 2000 || !!this.gitBusy() || paths.length >= BURST_PATHS ||
      // A session file gone from here: git is asked first whether a fetched pull brings it (making way, not a deletion).
      paths.some((rel) => this.syncable(rel) && this.sharedKey(rel) !== undefined && !this.onDisk(rel))
  }

  /** The git operation under way in this folder, or null; a leftover index.lock doesn't count. */
  gitBusy () { return gitBusy(this.root, undefined, this.leftoverLock) }

  /** Whether the folder's sync is held: git is at work on it, or a burst of changes is being classified. */
  held () { return !!(this.hold || this.classifying) }

  /**
   * Runs git work in this folder one piece at a time, in order (a burst's
   * classification, a settle, a look at HEAD), each skipped once stopped.
   */
  gitTask (fn) {
    const run = this.gitChain.then(() => this.stopped ? undefined : fn())
    this.gitChain = run.catch(() => {})
    return run
  }

  /**
   * Asks git what a burst was, off the event loop. Until it's known the
   * folder is held as during a hold: nothing is shared or written, and later
   * flushes wait behind it.
   */
  startClassify (paths) {
    const c = this.classifying = { behind: new Set() }
    this.gitTask(() => this.classifyBurst(paths, c)).catch((err) => {
      this.log(`could not read git: ${err.message}`)
      if (this.classifying !== c || this.stopped) return
      // Never held for good: held as git being busy, and asked again every SETTLE_MS.
      const behind = this.endClassify(c)
      for (const rel of paths) if (rel !== HEAD_CHANGED) this.heldPaths.add(rel)
      this.setHold('busy')
      this.settleSoon()
      this.requeue(behind)
    })
  }

  /** The burst is known: the folder is no longer held for it. Returns the paths that waited behind it. */
  endClassify (c) {
    if (this.classifying !== c) return []
    this.classifying = null
    return [...c.behind]
  }

  requeue (paths) {
    if (!this.stopped) for (const rel of paths) this.queue(rel)
  }

  async classifyBurst (all, c) {
    let paths = all.filter((p) => p !== HEAD_CHANGED)
    let again = false
    let r
    for (;;) {
      await this.noteCommits()
      r = await classify(this.root, { changed: paths, before: this.gitSeen, leftover: this.leftoverLock, indexWrote: this.burstByIndex || again })
      if (this.stopped) return
      // git wrote the index, yet HEAD hasn't moved and the paths aren't clean: a checkout or a pull
      // can be in the instant between writing the index and moving the branch. Asked once more, a flush later.
      if (r.kind !== 'edit' || !r.head || !paths.length || !this.burstByIndex || r.putBack.length || again || this.hold) break
      again = true
      await new Promise((resolve) => setTimeout(resolve, FLUSH_MS))
      if (this.stopped) return
      const more = [...c.behind].filter((p) => p !== HEAD_CHANGED)
      c.behind.clear()
      paths = [...new Set([...paths, ...more])]
      this.isBurst(paths) // the index as the next flush would see it
    }
    const runs = r.head ? true : await gitRuns(this.root) // asked while still held
    if (this.stopped) return
    // Removed files the fetched upstream adds: making way for a pull (git won't pull over untracked files), kept for everyone.
    if (r.head && (r.kind === 'edit' || r.kind === 'discard')) r.awaitPull = await this.makingWay(paths)
    if (this.stopped) return
    const behind = this.endClassify(c)
    try { this.settleBurst(r, paths, again, runs) } finally { this.requeue(behind) }
  }

  /** Acts on what git says a burst was (classifyBurst). Nothing here waits on git. */
  settleBurst (r, paths, again, runs) {
    if (r.awaitPull && r.awaitPull.length) {
      this.waitForPull(r.awaitPull, r.kind === 'discard')
      const away = new Set(r.awaitPull)
      paths = paths.filter((rel) => !away.has(rel))
    }
    if (this.hold) {
      // git's watcher started a hold meanwhile: the burst is held with the rest.
      for (const rel of paths) this.heldPaths.add(rel)
      if (this.hold.kind === 'switching') this.checkBackOnBranch()
      else this.settleSoon()
      return
    }
    if (!r.head) return this.headless(paths, runs) // this.git is set, so this is a repo
    this.gitFailures = 0
    this.gitSeen = r.head
    if (r.kind === 'edit') {
      // git wrote the index and put some of these paths back (a stash in the same flush as an
      // untracked file's save): held, so the settle restores those and shares only the rest.
      if (paths.length && (this.burstByIndex || again) && r.putBack.length) {
        for (const rel of paths) this.heldPaths.add(rel)
        this.setHold('settling', { prevHead: r.prevHead })
        this.settleSoon()
        return
      }
      // What changed while git was asked (from the room, or a retried write) was held. A path
      // outside the burst whose disk is as Quilt left it gets the room's version as it is; the
      // rest merge against the version both sides last had, as a settle merges what changed during a hold.
      const late = [...this.heldPaths]
      this.heldPaths.clear()
      const waited = new Set(late)
      const burst = new Set(paths)
      this.ingestAll(paths.filter((rel) => !waited.has(rel)))
      const entries = []
      for (const rel of late) {
        if (!this.syncable(rel) || this.merging.has(rel)) continue
        if (!burst.has(rel) && this.untouchedHere(rel)) this.tryWrite(rel)
        else entries.push({ rel, base: this.lastKnown.get(rel) })
      }
      if (entries.length) this.mergeHeld(entries).catch((err) => this.log(`could not merge: ${err.message}`))
      return
    }
    for (const rel of paths) this.heldPaths.add(rel)
    if (r.kind === 'busy') {
      this.setHold('busy', { prevHead: r.prevHead })
      if (r.conflict) this.noteConflict(r.conflict)
      this.settleSoon() // polls until the operation is over, in case its end goes unseen
    } else if (r.kind === 'switch') {
      this.setHold('switching', { prevHead: r.prevHead, to: r.head.key })
      this.logSwitch(r.head.key)
    } else { // discard, advance
      this.setHold('settling', { prevHead: r.prevHead })
      this.settleSoon()
    }
  }

  /** The disk at rel is as Quilt last wrote or read it (or still absent, for a path it never had). */
  untouchedHere (rel) {
    const disk = this.readDisk(rel)
    if (disk && (disk.skip || disk.tooLarge)) return false
    return (disk ? disk.key : undefined) === this.lastKnown.get(rel)
  }

  /**
   * HEAD can't be read as a commit. A branch with no commits yet (`git
   * checkout --orphan`, git itself running: `runs`) is a switch to it;
   * otherwise git can't be asked here.
   */
  headless (paths = [], runs = false) {
    const ref = headRef(this.root)
    if (ref && this.git && ref !== this.git.key && runs) {
      for (const rel of paths) this.heldPaths.add(rel)
      this.setHold('switching', { to: ref })
      this.logSwitch(ref)
      return
    }
    this.gitUnreadable(paths)
  }

  /**
   * git can't be run (missing, or HEAD unreadable) in a folder that is a repo:
   * whatever happened can't be told apart from an edit, so the folder stays
   * held and nothing is shared. Asked again every SETTLE_MS, for good.
   */
  gitUnreadable (paths = []) {
    for (const rel of paths) this.heldPaths.add(rel)
    if (++this.gitFailures === GIT_FAILURES_TO_SAY) this.log('⚠️ Quilt can\'t read git here; this folder stays paused')
    this.setHold('busy') // a switching hold stays as it is
    this.settleSoon()
  }

  /**
   * Commits made here of work the room already has (`git commit` touches no
   * file, so no burst saw them) move gitSeen forward, so a later pull or
   * rebase is measured from them: otherwise the room's text, now committed,
   * would look like a change of the room's against the older commit and clash
   * with what the operation made of it. Read from the branch, not HEAD: a
   * rebase has already moved HEAD away when its first files land.
   */
  async noteCommits () {
    const seen = this.gitSeen
    if (!seen || !seen.branch) return
    const tip = await branchTip(this.root, seen.branch)
    if (!tip || tip === seen.sha) return
    const changes = await changesBetween(this.root, seen.sha, tip)
    if (!changes) return // git could not say: gitSeen stays, and the burst merges against it
    const changed = [...changes.keys()].filter((rel) => this.syncable(rel))
    const now = await filesAt(this.root, tip, changed)
    if (!now) return
    for (const rel of changed) if ((now.get(rel) ?? undefined) !== this.lastKnown.get(rel)) return // new content: the burst merges it
    const next = { ...seen, sha: tip }
    if (this.gitSeen === seen) this.gitSeen = next // unless a newer head was seen meanwhile
    // A hold that started from this head (setHold) measures from the commits too.
    if (this.hold && this.hold.prevHead === seen) this.hold.prevHead = next
  }

  logSwitch (key) {
    this.log(`⏸️ You're on ${key}; this session syncs ${this.git.key}. Sync resumes when you're back on ${this.git.key}.`)
  }

  setHold (kind, extra = {}) {
    // A switch ends only on the way back (checkBackOnBranch): git at work on the other branch doesn't change it.
    if (this.hold && (this.hold.kind === kind || this.hold.kind === 'switching')) return
    // The git watcher can start a hold before any burst is classified: commits of the room's work
    // move its starting point on, asked before it can settle (gitTask runs in order).
    if (!this.hold) this.gitTask(() => this.noteCommits()).catch(() => {})
    // since: when the folder was first held (the app's "git is busy" note waits on it), kept across kinds.
    this.hold = { kind, since: this.hold ? this.hold.since : Date.now(), ...(this.hold ? { prevHead: this.hold.prevHead } : {}), ...extra }
    if (!this.hold.prevHead) this.hold.prevHead = this.gitSeen
    this.emit('hold', this.hold)
    this.scheduleStatusWrite()
    // state.json's gitHeld at once: a crash a moment later must restart held, not as an offline rejoin.
    this.saveStateNow()
  }

  releaseHold () {
    this.hold = null
    this.heldConflicts.clear()
    clearTimeout(this.settleTimer); this.settleTimer = null
    this.emit('hold', null)
    this.scheduleStatusWrite()
    // Not at once: the settle writes back and merges just after this, and a crash before
    // those finish must still restart held (and settle again) rather than as an offline rejoin.
    this.scheduleStateSave()
  }

  /** (Re)arms the settle timer: the hold ends SETTLE_MS after the last file or git event. */
  settleSoon () {
    if (!this.hold || this.hold.kind === 'switching' || this.stopped || this.holdAwaitsSync) return
    clearTimeout(this.settleTimer)
    const gen = ++this.settleGen
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      this.gitTask(() => this.onSettled(gen)).catch((err) => {
        this.log(`could not settle: ${err.message}`)
        this.settleSoon() // every hold has a way out: asked again
      })
    }, SETTLE_MS)
    this.settleTimer.unref()
  }

  /** Whether a hold is on that a settle may end now. */
  settleable () {
    return !!this.hold && this.hold.kind !== 'switching' && !this.stopped && !this.holdAwaitsSync
  }

  /** `gen`: the settleSoon that armed it. A later one (a file or git event since) means not settled yet. */
  async onSettled (gen = this.settleGen) {
    if (!this.settleable()) return
    let busy = this.gitBusy()
    if (busy === 'index-lock' && Date.now() - this.lastFileEventAt >= STALE_LOCK_MS) {
      // Only the index lock, there a while, and the tree quiet as long (a long checkout writes files
      // all along): a git that crashed may have left it.
      const stamp = await leftoverLock(this.root)
      if (!this.settleable()) return
      if (stamp) {
        this.leftoverLock = stamp
        this.log('⚠️ a leftover .git/index.lock is being ignored; delete it if git complains')
        busy = this.gitBusy()
      }
    }
    if (busy) { this.setHold('busy'); this.settleSoon(); return } // still mid-operation: look again later
    // git left a conflict for the person (a `stash pop` that clashed has no marker file): their
    // resolution is shared once git has it (git add), never git's conflict markers.
    const conflicts = await unmergedPaths(this.root)
    if (!this.settleable()) return
    if (conflicts && conflicts.size) { this.setHold('busy'); this.noteConflict([...conflicts]); this.settleSoon(); return }
    const head = await headKey(this.root)
    if (!this.settleable()) return
    if (!head) {
      const runs = await gitRuns(this.root)
      return this.settleable() ? this.headless([], runs) : undefined
    }
    if (this.git && head.key !== this.git.key) {
      // Landed on another branch while settling: pause instead.
      this.setHold('switching', { to: head.key })
      this.logSwitch(head.key)
      return
    }
    const plan = await this.planSettle(head)
    if (!this.settleable()) return
    // A file or git event since this settle's timer was armed (it armed another), or a path the room
    // changed that the plan never saw: the folder hasn't settled. Asked again, the hold on meanwhile.
    if (gen !== this.settleGen || (plan && [...this.heldPaths].some((rel) => !plan.considered.has(rel)))) { this.settleSoon(); return }
    if (!plan) return this.gitUnreadable()
    const from = this.hold.prevHead // where HEAD was before git moved it: the pull's commits are from..head
    // Out of normal sync from here on: a partner's edit arriving
    // during a merge must not land on a pulled file before it is merged.
    for (const e of plan.advance) this.merging.add(e.rel)
    this.heldPaths.clear()
    this.rejoin = false
    this.gitFailures = 0
    this.gitSeen = head
    // What git wrote is accounted for here: the next flush is an edit unless git moves again.
    this.gitIndex = indexStamp(this.root)
    this.headChangedAt = 0
    const stash = stashStamp(this.root)
    const why = this.hold.back ? 'back' : stash !== this.stashSeen ? 'stash' : 'reset'
    this.stashSeen = stash
    this.releaseHold()
    // Made way for a pull that has landed now: those files are the pull's (merged in plan.advance).
    for (const rel of [...this.pullWait.keys()]) if (this.onDisk(rel)) this.endPullWait(rel)
    if (plan.awaitPull && plan.awaitPull.length) {
      this.waitForPull(plan.awaitPull.filter((a) => a.stash).map((a) => a.rel), true)
      this.waitForPull(plan.awaitPull.filter((a) => !a.stash).map((a) => a.rel), false)
    }
    this.writeBack(plan.discarded, why)
    if (plan.advance.length) this.pullWaitOver.clear() // new commits: what was waited for is a different question now
    this.refreshPull()
    // Not awaited: merging (an AI merge can take a while) never holds up the next git work.
    this.mergeSettled(plan, { from, to: head }).catch((err) => this.log(`could not merge: ${err.message}`))
  }

  async mergeSettled (plan, { from = null, to = null } = {}) {
    await this.mergeHeld(plan.edited)
    const { conflicts, changed } = await this.mergeHeld(plan.advance)
    const n = plan.advance.length
    if (n) this.log(`🔀 Merged the commits you pulled into the session's work (${n} file${n === 1 ? '' : 's'}${conflicts ? `, ${conflicts} need${conflicts === 1 ? 's' : ''} merging` : ''})`)
    // Commits that only moved HEAD over work the room already has (your own commit) change nothing: no event.
    if (changed) await this.notePull({ from, to, files: changed })
  }

  /**
   * One line for the whole pull in the activity log ("pulled 45 commits from main · 269 files"),
   * in place of an entry per file: the pull brought other people's work, not edits of ours.
   */
  async notePull ({ from, to, files }) {
    let commits = null
    if (from && from.sha && to && to.sha && from.sha !== to.sha) commits = await commitsBetween(this.root, from.sha, to.sha)
    const branch = (to && to.branch) || null
    const what = [commits ? `${commits} commit${commits === 1 ? '' : 's'}` : 'commits', branch ? `from ${branch}` : ''].filter(Boolean).join(' ')
    const detail = `${what} · ${files} file${files === 1 ? '' : 's'}`
    this.log(`⬇️ shared as one pull: ${detail}`)
    // Someone who may not post can't add lines of their own to the log (the relay would undo it).
    if (this.stopped || !this.mayTalk()) return
    this.doc.transact(() => {
      this.activity.push([{ by: this.name, path: '', kind: 'pulled', detail, ts: Date.now() }])
      if (this.activity.length > 300) this.activity.delete(0, this.activity.length - 300)
    }, LOCAL)
  }

  /**
   * What ending the hold does, all asked of git before anything changes, in a
   * handful of git calls whatever the number of paths. Null only when git
   * can't be run (the hold stays on); a git call that fails is retried once
   * (one that timed out is not), then the settle goes on with less (never
   * parks the folder for good).
   * - advance: each path the new commits changed, merged three-way into the
   *   doc: base = the file at the old commit, ours = the disk, theirs = the room.
   * - discarded: held paths git put back (clean, and tracked or gone from
   *   disk: stash, reset, restore). The room's version goes back on disk.
   * - edited: every other held path, changed here or in the room while held.
   *   Merged against the version both sides last had, so an edit made during
   *   a hold (a commit, an agent's `git status`) is shared, never reverted.
   * - considered: every path the plan looked at. One held while git was being
   *   asked that isn't among them means the folder hasn't settled (onSettled).
   */
  async planSettle (head) {
    const prev = this.hold.prevHead
    const paths = new Set(this.heldPaths)
    // Restarted held: changes made while stopped were never seen, so every path is checked.
    if (this.rejoin) for (const rel of [...this.sharedPaths(), ...walk(this.root, this.ig)]) paths.add(rel)
    const free = (rel) => this.syncable(rel) && !this.merging.has(rel)
    const twice = (ask) => askTwice(this.root, ask) // not again after a timeout: that would stall the app as long again
    let changes = new Map()
    if (prev && prev.sha && prev.sha !== head.sha) {
      changes = await twice(() => changesBetween(this.root, prev.sha, head.sha))
      if (!changes) {
        if (!(await gitRuns(this.root))) return null
        // Each held path is then checked against HEAD below: the pulled ones look discarded and get the room's version.
        this.log('⚠️ git could not list what the new commits changed; the session\'s version of those files is kept')
        changes = new Map()
      }
    }
    const changed = [...changes.keys()].filter(free)
    const old = await filesAt(this.root, prev?.sha, changed.filter((rel) => changes.get(rel) !== 'A'))
    if (!old) return null
    if (old.failed) this.log(`⚠️ git could not read ${old.failed} file${old.failed === 1 ? '' : 's'} at the old commit; merged without a base (a merge record at worst)`)
    // A file git made the person resolve (stash pop, rebase) holds their merge of the commits and the
    // session's work: merged against the session's version this disk had, it is taken as resolved.
    const advance = changed.map((rel) => ({ rel, base: this.heldConflicts.has(rel) && this.lastKnown.has(rel) ? this.lastKnown.get(rel) : old.get(rel) ?? undefined, via: 'pull' }))
    const rest = [...paths].filter((rel) => !changes.has(rel) && free(rel))
    const tree = rest.length ? await twice(() => treeState(this.root, rest)) : { dirty: new Set(), tracked: new Set() }
    if (!tree) {
      if (!(await gitRuns(this.root))) return null
      // git can't say which paths it put back. Each is merged against the file at HEAD: a discarded
      // one (the disk is HEAD's) takes the room's version, an edited one merges three-way. Never
      // against lastKnown: after a stash that is the room's version, and the stashed-away disk would win.
      const atHead = await filesAt(this.root, head.sha, rest)
      if (!atHead) return null
      this.log(`⚠️ git could not say what it changed here; ${rest.length} held file${rest.length === 1 ? '' : 's'} merged against your last commit`)
      return { advance, discarded: [], edited: rest.map((rel) => ({ rel, base: atHead.get(rel) ?? undefined, via: this.rejoin ? undefined : 'hold' })), considered: new Set([...paths, ...changes.keys()]) }
    }
    const discarded = []; const edited = []
    for (const rel of rest) {
      // git calls an untracked or ignored file clean too, but nothing put it back to a commit: that is an edit.
      if (!tree.dirty.has(rel) && (tree.tracked.has(rel) || !this.onDisk(rel))) discarded.push(rel)
      else edited.push({ rel, base: this.lastKnown.get(rel), via: this.rejoin ? undefined : 'hold' })
    }
    const gone = [...discarded, ...edited.map((e) => e.rel)].filter((rel) => !changes.has(rel))
    const away = new Set(await this.makingWay(gone))
    return {
      advance,
      discarded: discarded.filter((rel) => !away.has(rel)),
      edited: edited.filter((e) => !away.has(e.rel)),
      awaitPull: [...away].map((rel) => ({ rel, stash: discarded.includes(rel) })),
      considered: new Set([...paths, ...changes.keys()])
    }
  }

  onDisk (rel) {
    try { fs.lstatSync(path.join(this.root, ...rel.split('/'))); return true } catch { return false }
  }

  /**
   * At start, before captureOffline: the folder is on another branch than the
   * one this session syncs, or it stopped mid-hold. Its tree is then not the
   * session's work plus offline edits (it is another branch, or what git left
   * half-done), so nothing is captured from it: the hold carries on, and when
   * it ends (back on the branch, settled) every path is restored or merged
   * against the version the session had when it stopped.
   */
  resumeHold () {
    const saved = this.savedGit
    if (!saved) return false
    const head = this.git // null: git can't say where HEAD is (an unborn branch, or git not running)
    if (!head && !gitDir(this.root)) return false
    const at = head ? head.key : headRef(this.root) // null: unreadable, and not on a named branch
    const away = !!at && at !== saved.key
    if (head && !away && !saved.held) return false
    this.git = { key: saved.key, branch: saved.key.startsWith('@') ? null : saved.key, sha: saved.sha }
    this.gitSeen = head
    // An unfinished offline merge's bases are no bases for this hold; left, the next start would read them.
    fs.rmSync(this.heldBasesFile, { force: true })
    // The base for merging what the folder holds once it's back: the session's version at the last stop.
    for (const rel of this.sharedPaths()) {
      const k = this.sharedKey(rel)
      if (this.syncable(rel) && k !== undefined) this.lastKnown.set(rel, k)
    }
    this.rejoin = true
    // Back on the branch but git can't be read: held as busy, asked again every SETTLE_MS (see gitUnreadable).
    const kind = away ? 'switching' : head ? 'settling' : 'busy'
    this.hold = { kind, since: Date.now(), prevHead: saved.sha ? { ...this.git } : null, ...(away ? { to: at } : {}) }
    if (away) this.logSwitch(at)
    return true
  }

  /** Said once at start: the folder is a repo, but git can't be read here. */
  saysGitUnreadable (held) {
    if (held) {
      this.gitFailures = GIT_FAILURES_TO_SAY // said here: gitUnreadable doesn't say it again
      this.log('⚠️ Quilt can\'t read git here; this folder stays paused')
    } else {
      this.log('⚠️ Quilt can\'t read git here, so a git command in this folder is shared like any edit')
    }
  }

  /** While switched away: did HEAD come back to the branch this session syncs? */
  checkBackOnBranch () {
    const away = () => this.git && this.hold && this.hold.kind === 'switching' && !this.stopped
    if (!away()) return
    // .git/HEAD first (no git call): this runs on every flush while away.
    const ref = headRef(this.root)
    if (this.git.branch ? ref !== this.git.key : ref !== null) return
    if (this.checkingBack) return // one look is already on its way
    this.checkingBack = true
    this.gitTask(async () => {
      const head = await headKey(this.root)
      if (!away() || !head || head.key !== this.git.key) return
      // Back: let it settle, then merge whatever the commits did and restore the rest.
      this.hold = { kind: 'settling', since: Date.now(), prevHead: this.hold.prevHead, back: true }
      this.emit('hold', this.hold)
      this.scheduleStatusWrite()
      this.settleSoon()
    }).catch((err) => this.log(`could not read git: ${err.message}`)).finally(() => { this.checkingBack = false })
  }

  /**
   * Of these paths, the ones gone from this folder that the fetched upstream
   * adds, and that the session has: they were moved out of the way of a pull.
   */
  async makingWay (paths) {
    const gone = paths.filter((rel) => this.syncable(rel) && !this.onDisk(rel) && this.sharedKey(rel) !== undefined && !this.pullWaitOver.has(rel))
    if (!gone.length) return []
    const up = await upstreamAdds(this.root, gone)
    return up ? [...up.keys()] : []
  }

  /** rel is in the way of a fetched pull (as last asked of git), and the session has it. */
  blocksPull (rel) {
    return !!(this.pull && this.pull.adds.some((a) => a.path === rel && !a.waiting) && this.sharedKey(rel) !== undefined && !this.pullWaitOver.has(rel))
  }

  /** Keeps files removed (or stashed: `stash`) to make way for a pull for everyone, until it lands or PULL_WAIT_MS passes. */
  waitForPull (rels, stash) {
    const fresh = rels.filter((rel) => !this.pullWait.has(rel))
    if (!fresh.length) return
    for (const rel of fresh) {
      const timer = setTimeout(() => this.pullWaitEnded(rel), this.pullWaitMs)
      timer.unref()
      this.pullWait.set(rel, { since: Date.now(), stash, timer })
    }
    this.log(`⏳ ${fresh.join(', ')} out of the way for a pull: kept for everyone until it lands.`)
    this.refreshPull()
  }

  endPullWait (rel) {
    const w = this.pullWait.get(rel)
    if (!w) return
    clearTimeout(w.timer)
    this.pullWait.delete(rel)
  }

  /** No pull came in time: a removal was meant (shared as a deletion), a stash puts the session's copy back. */
  pullWaitEnded (rel) {
    const w = this.pullWait.get(rel)
    if (!w || this.stopped) return
    if (this.held()) { w.timer = setTimeout(() => this.pullWaitEnded(rel), SETTLE_MS); w.timer.unref(); return } // after git is done
    this.pullWait.delete(rel)
    if (this.onDisk(rel)) return
    this.pullWaitOver.add(rel)
    if (w.stash) {
      this.log(`↩️ No pull came: ${rel} is back from the session.`)
      this.writeBack([rel])
    } else {
      this.log(`🗑️ No pull came: ${rel} is deleted for everyone.`)
      try { this.ingest(rel) } catch (err) { this.log(`could not sync ${rel}: ${err.message}`) } // as a deletion, not asked of git again
    }
    this.refreshPull()
  }

  /** Asks git what a pull would bring over files the session put here (after a fetch, a settle, a start). */
  refreshPull () {
    if (!this.git || this.stopped) return
    this.gitTask(async () => {
      const st = await pullState(this.root)
      if (!this.stopped) this.setPull(st)
    }).catch(() => {})
  }

  setPull (st) {
    const adds = []
    for (const [rel, key] of st ? st.adds : []) {
      const waiting = this.pullWait.has(rel)
      if (!waiting && !this.onDisk(rel)) continue // not in the way
      if (this.sharedKey(rel) === undefined) continue // not the session's: git's usual advice applies
      const disk = waiting ? null : this.readDisk(rel)
      const here = disk && disk.key !== undefined ? disk.key : this.sharedKey(rel)
      adds.push({ path: rel, same: here === key, waiting })
    }
    adds.sort((a, b) => a.path < b.path ? -1 : 1)
    this.pull = st ? { upstream: st.upstream, behind: st.behind, adds } : null
    // Told once per set of files in the way (at the top of the AI's next quilt answer, and in the log).
    const said = adds.filter((a) => !a.waiting).map((a) => `${a.path}:${a.same}`).join('|')
    if (said && said !== this.pullSaid) {
      const text = pullAdvice(this.pull)
      this.notice(text)
      this.log(`⬇️ ${text}`)
    }
    this.pullSaid = said
    this.scheduleStatusWrite()
  }

  // ------------------------------------------------------------ upstream --
  // Commits made outside the session (pushed from a worktree, merged on GitHub,
  // or another worktree moving this branch) come in without anyone pulling:
  // the folder's branch moves forward to them, with the session's uncommitted
  // work merged into their files (upstream.js). Never a history merge: a branch
  // that has commits of its own the upstream lacks is left to a person or AI.

  /** Looks again shortly (a branch moved, a fetch landed); several asks in a row make one look. */
  checkUpstreamSoon ({ fetch = false, delay = SETTLE_MS } = {}) {
    if (!this.git || !this.git.branch || this.stopped) return
    this.upstreamFetch = this.upstreamFetch || fetch
    if (this.upstreamTimer) return // one look is already on its way: it takes this ask too
    this.upstreamTimer = setTimeout(() => {
      this.upstreamTimer = null
      const f = this.upstreamFetch
      this.upstreamFetch = false
      this.gitTask(() => this.checkUpstream({ fetch: f })).catch((err) => this.log(`could not check for new commits: ${err.message}`))
    }, delay)
    this.upstreamTimer.unref()
  }

  /** Nothing under way here: no hold, no burst, no file changes waiting, no git operation. */
  quietForUpstream () {
    return !this.stopped && !!this.git && !!this.git.branch && !this.held() && !this.pending.size &&
      Date.now() - this.lastFileEventAt >= SETTLE_MS && !this.gitBusy() && this.ready !== false
  }

  /**
   * The look itself (in gitTask order). Asks git where the branch and its upstream are,
   * fetching first when asked, and catches up when the branch is behind. Returns the state.
   */
  async checkUpstream ({ fetch = false, now = false } = {}) {
    if (!this.git || !this.git.branch || this.stopped) return this.upstream
    if (!this.quietForUpstream()) {
      if (!this.hold) this.checkUpstreamSoon({ fetch }) // busy for a moment: asked again once it's quiet
      return this.upstream
    }
    const head = await headKey(this.root)
    if (!head || head.key !== this.git.key) return this.upstream
    await this.fixIndex()
    let up = await upstreamOf(this.root)
    if (up && fetch && up.remote && await fetchUpstream(this.root, up.remote)) up = await upstreamOf(this.root)
    this.refreshRepo()
    if (this.stopped || !this.quietForUpstream()) return this.upstream
    // The branch moved without this folder's files moving with it: another worktree of the
    // repository moved it (a commit made here was taken in by noteCommits instead).
    const seen = this.gitSeen
    if (this.bringInUpstream && seen && seen.sha && seen.key === head.key && seen.sha !== head.sha) {
      await this.noteCommits()
      if (this.gitSeen && this.gitSeen.sha !== head.sha && await isAncestor(this.root, seen.sha, head.sha)) {
        await this.bringIn(seen.sha, head.sha, { moveRef: false, up, now: true })
      }
    }
    if (!up || !up.sha) { this.setUpstream(up ? { ...up, behind: 0, ahead: 0 } : null); return this.upstream }
    if (!this.bringInUpstream) return this.upstream
    const at = (this.gitSeen && this.gitSeen.sha) || head.sha
    if (up.sha === at) { this.setUpstream({ ...up, behind: 0, ahead: 0 }); return this.upstream }
    const behind = await commitsBetween(this.root, at, up.sha)
    const ahead = await commitsBetween(this.root, up.sha, at)
    if (behind === null || ahead === null) return this.upstream
    if (!behind) { this.setUpstream({ ...up, behind, ahead }); return this.upstream }
    if (ahead) { this.setUpstream({ ...up, behind, ahead, diverged: true }); return this.upstream }
    await this.bringIn(at, up.sha, { moveRef: true, up: { ...up, behind, ahead }, now })
    return this.upstream
  }

  /**
   * Brings commits `from`..`to` into this folder and the session: every file they changed is
   * merged with the session's uncommitted work, then the branch moves to `to` (moveRef) or,
   * when it already has, the index follows it. All or nothing: one file that can't be merged
   * cleanly and nothing is written; the AIs are told which, and why.
   */
  async bringIn (from, to, { moveRef, up = null, now = false }) {
    const branch = this.git.branch
    const upName = up ? up.name : branch
    const state = (extra) => this.setUpstream({ ...(up || { name: upName }), behind: extra.behind ?? (up ? up.behind : 0), ahead: 0, ...extra })
    // Another member's folder on this branch, with its own upstream, takes it first: two folders
    // sharing the same commits at once would share them twice. This one waits one look.
    if (!now && this.upstreamDeferred !== to && this.otherCatcherFirst()) {
      this.upstreamDeferred = to
      state({ waiting: 'another member is bringing these commits in' })
      return
    }
    const staged = await stagedAgainst(this.root, from)
    if (staged !== false) { state({ waiting: staged ? 'changes are staged for a commit here' : 'git could not say what is staged' }); return }
    const changes = await changesBetween(this.root, from, to)
    if (!changes) return
    // A member's folder on this branch is already at `to`, in step with the session: the session's
    // files are that commit plus the session's work already (that folder brought it in, or someone
    // there resolved it by hand). This folder follows: only files the session doesn't share are merged.
    const following = this.memberAt(to)
    const paths = [...changes.keys()].filter((rel) => !following || !this.syncable(rel))
    const scope = new Map([...changes].filter(([rel]) => !following || !this.syncable(rel)))
    const [base, theirs] = [await filesAt(this.root, from, paths), await filesAt(this.root, to, paths)]
    if (!base || !theirs || this.stopped || !this.quietForUpstream()) return
    for (const rel of paths) {
      if (!this.syncable(rel)) continue
      const claim = this.claimFor(rel)
      if (claim && !this.ownClaim(claim)) { state({ waiting: `${claim.by} holds ${rel}` }); return }
      if (this.writeRefusal(rel)) { state({ waiting: `you may not change ${rel} in this session` }); return }
    }
    const diskKey = (rel) => {
      const d = this.readDisk(rel)
      if (!d) return null
      return d.skip || d.tooLarge ? undefined : d.key
    }
    // The session and this folder must agree first: a change still on its way waits for the next look.
    for (const rel of paths) {
      if (!this.syncable(rel)) continue
      if ((diskKey(rel) ?? undefined) !== this.sharedKey(rel)) { this.checkUpstreamSoon(); return }
    }
    // Files the session moved: same name, somewhere the old commit didn't have them.
    const goneHere = new Set(paths.filter((rel) => base.get(rel) && diskKey(rel) === null).map((rel) => rel.slice(rel.lastIndexOf('/') + 1)))
    const moved = new Map()
    if (goneHere.size) {
      const cands = [...this.sharedPaths()].filter((rel) => goneHere.has(rel.slice(rel.lastIndexOf('/') + 1)) && !changes.has(rel))
      const atFrom = cands.length ? await filesAt(this.root, from, cands) : new Map()
      if (!atFrom) return
      for (const rel of cands) if (atFrom.get(rel) === null) { const k = diskKey(rel); if (k) moved.set(rel, k) }
    }
    // Folders the session emptied, that the new commits add files to (a reorganisation they predate).
    const emptied = new Set()
    for (const rel of paths) {
      if (base.get(rel) !== null || theirs.get(rel) === null) continue
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
      if (emptied.has(dir) || [...this.sharedPaths()].some((p) => (dir ? p.startsWith(dir + '/') : !p.includes('/')))) continue
      if (await hasFilesUnder(this.root, from, dir)) emptied.add(dir)
    }
    const plan = planCatchUp({ changes: scope, base, theirs, disk: diskKey, moved, emptied })
    if (this.stopped || !this.quietForUpstream()) return
    if (plan.conflicts.length) {
      const behind = up ? up.behind : await commitsBetween(this.root, from, to)
      state({ behind, conflicts: plan.conflicts })
      return
    }
    // The branch first: if it moved meanwhile, nothing has been written.
    if (moveRef ? !(await fastForward(this.root, branch, from, to)) : !(await resetIndex(this.root, to))) {
      this.checkUpstreamSoon()
      return
    }
    this.gitSeen = { key: branch, branch, sha: to }
    // The index follows at the next look if git couldn't set it, or if another git that read it
    // just before (an AI's `git status`) writes its old copy back over it: checked for a few seconds.
    this.indexLate = to
    this.indexWatchUntil = Date.now() + INDEX_WATCH_MS
    for (const ms of [500, 2000, INDEX_WATCH_MS]) setTimeout(() => this.gitTask(() => this.fixIndex()).catch(() => {}), ms).unref()
    let written = 0
    for (const [rel, key] of plan.writes) {
      try {
        const abs = resolveInside(this.root, rel)
        if (key === null) {
          fs.rmSync(abs, { force: true })
          removeEmptyParents(this.root, path.dirname(abs))
        } else {
          const data = key.startsWith('bin:') ? await blobAt(this.root, to, rel) : key
          if (data === null) throw new Error('git could not read it')
          fs.mkdirSync(path.dirname(abs), { recursive: true })
          this.writeFile(rel, abs, data)
        }
        written++
        if (this.syncable(rel)) this.ingest(rel, { pulled: true })
      } catch (err) { this.log(`could not bring in ${rel}: ${err.message}`) }
    }
    // What git and Quilt just wrote is accounted for: the next flush is no burst of git's.
    this.gitIndex = indexStamp(this.root)
    this.headChangedAt = 0
    this.upstreamDeferred = null
    const count = await commitsBetween(this.root, from, to)
    if (following) this.log(`⬇️ ${branch} follows ${following}'s folder to ${to.slice(0, 7)} (${count ?? 'new'} commit${count === 1 ? '' : 's'} from ${upName}); the session already has their files`)
    const moves = plan.moves.length ? `; followed ${plan.moves.map((m) => `${m.from} → ${m.to}`).join(', ')}` : ''
    if (!following) this.log(`⬇️ brought in ${count ?? 'new'} commit${count === 1 ? '' : 's'} from ${upName} (${written} file${written === 1 ? '' : 's'})${moves}`)
    if (written && !following) await this.notePull({ from: { sha: from }, to: { sha: to, branch }, files: written })
    if (plan.strays.length) {
      const list = plan.strays.slice(0, 5).join(', ') + (plan.strays.length > 5 ? ', …' : '')
      this.notice(`The commits Quilt just brought in from ${upName} add ${list} to a folder the session had emptied (moved elsewhere?). Check whether they belong where the session moved the rest.`)
    }
    this.setUpstream({ ...(up || { name: upName }), sha: up ? up.sha : to, behind: 0, ahead: 0, brought: { count, files: written, at: Date.now() } })
  }

  /**
   * Just after a bring-in, the index must be the new commit's. A git that read the index before
   * and wrote it back after (status refreshing it) leaves the old commit's there, which reads as
   * "the session staged a revert": set again. Only while the bring-in is recent, and only when
   * HEAD is still where it put it: later staging is the person's.
   */
  async fixIndex () {
    const sha = this.indexLate
    if (!sha || this.stopped || !this.git) return
    if (Date.now() > this.indexWatchUntil) { this.indexLate = null; return }
    const head = await headKey(this.root)
    if (!head || head.sha !== sha || this.gitBusy()) return
    if (await stagedAgainst(this.root, sha) && await resetIndex(this.root, sha)) this.gitIndex = indexStamp(this.root)
  }

  /**
   * Asked for by an AI (quilt_sync_branch): fetch and bring commits in now, without waiting for
   * the next look or another member's folder. What happened: { branch, upstream, moved, busy }.
   */
  async syncBranchNow () {
    if (!this.git) return { git: false }
    if (!this.git.branch) return { git: true, branch: null }
    // A save or a git command a moment ago: give it a few seconds to settle first.
    for (let i = 0; i < 30 && !this.quietForUpstream() && !this.hold; i++) await new Promise((r) => setTimeout(r, 200))
    const before = this.gitSeen && this.gitSeen.sha
    const busy = this.hold ? this.hold.kind : this.quietForUpstream() ? null : 'files are still changing here'
    if (!busy) await this.gitTask(() => this.checkUpstream({ fetch: true, now: true }))
    return { git: true, branch: this.git.branch, busy, upstream: this.upstream, moved: !!(this.gitSeen && before && this.gitSeen.sha !== before) }
  }

  /** A member whose folder is on this branch at `sha`, in step with the session (not held), or null. */
  memberAt (sha) {
    if (!this.conn || !this.conn.awareness) return null
    const me = this.conn.awareness.clientID
    for (const [id, st] of this.conn.awareness.getStates()) {
      if (id === me || !st || !st.git || !st.name) continue
      if (st.git.branch === this.git.branch && st.git.sha === sha && !st.git.held) return st.name
    }
    return null
  }

  /** Whether another member's folder on this branch is first in line to bring commits in (the lowest client id). */
  otherCatcherFirst () {
    if (!this.conn || !this.conn.awareness) return false
    const me = this.conn.awareness.clientID
    for (const [id, st] of this.conn.awareness.getStates()) {
      if (id === me || !st || !st.git) continue
      if (st.git.branch === this.git.branch && !st.git.held && id < me) return true
    }
    return false
  }

  setUpstream (up) {
    const next = up ? {
      name: up.name, url: up.url || null, sha: up.sha || null, behind: up.behind || 0, ahead: up.ahead || 0,
      diverged: !!up.diverged, conflicts: up.conflicts || [], waiting: up.waiting || null, brought: up.brought || (this.upstream && this.upstream.brought) || null, checkedAt: Date.now()
    } : null
    this.upstream = next
    // Told once per state (at the top of the AI's next quilt answer, and in the log).
    const said = next && (next.diverged || next.conflicts.length) ? catchUpAdvice({ branch: this.git.branch, upstream: next.name, ...next }) : ''
    if (said && said !== this.upstreamSaid) { this.notice(said); this.log(`⬇️ ${said}`) }
    this.upstreamSaid = said
    this.shareGit()
    this.scheduleStatusWrite()
  }

  /** Reads every branch and worktree of the repository again (for the room's branch list). */
  refreshRepo () {
    repoBranches(this.root).then((r) => {
      if (!r || this.stopped) return
      const real = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
      const home = real(this.root)
      this.repo = {
        worktrees: r.worktrees.map((w) => ({ name: real(w.path) === home ? '.' : path.basename(w.path), branch: w.branch, sha: w.sha })),
        branches: r.branches.slice(0, 30)
      }
      this.shareGit()
    }).catch(() => {})
  }

  /** What this folder tells the room about git: its branch, its upstream, the repository's branches and worktrees. */
  gitSummary () {
    if (!this.git) return null
    const u = this.upstream
    return {
      branch: this.git.branch,
      key: this.git.key,
      sha: this.gitSeen ? this.gitSeen.sha : this.git.sha,
      held: this.hold ? this.hold.kind : null,
      on: this.hold && this.hold.kind === 'switching' ? this.hold.to : this.git.key,
      upstream: u ? { name: u.name, url: u.url, behind: u.behind, ahead: u.ahead, diverged: u.diverged, conflicts: u.conflicts.length, waiting: u.waiting, checkedAt: u.checkedAt } : null,
      repo: this.repo
    }
  }

  shareGit () {
    if (!this.conn || !this.conn.awareness) return
    const g = this.gitSummary()
    if (JSON.stringify(g) !== JSON.stringify(this.conn.awareness.getLocalState()?.git ?? null)) this.conn.awareness.setLocalStateField('git', g)
  }

  /** git left a conflict here (`stash pop`, a merge, a rebase): held until it's resolved, said once per hold. */
  noteConflict (paths) {
    if (!this.hold) return
    for (const rel of paths) this.heldConflicts.add(rel)
    const fresh = !this.hold.conflict
    this.hold.conflict = [...this.heldConflicts]
    if (!fresh) return
    const list = this.hold.conflict.slice(0, 3).join(', ') + (this.hold.conflict.length > 3 ? ', …' : '')
    this.log(`⏸️ git left a conflict in ${list} on this computer; Quilt shares your resolution once you resolve it and git add it.`)
    this.emit('hold', this.hold)
    this.scheduleStatusWrite()
  }

  /** Puts the room's version of each path back on disk (a discard on this machine never discards the room's work). */
  writeBack (paths, say = false) {
    let n = 0
    for (const rel of paths) {
      if (!this.syncable(rel) || this.merging.has(rel)) continue
      const disk = this.readDisk(rel)
      if (disk && (disk.skip || disk.tooLarge)) continue
      if ((disk ? disk.key : undefined) === this.sharedKey(rel)) { if (disk) this.lastKnown.set(rel, disk.key); continue }
      // What's on disk is what git put there (it has its own copy): no need to keep one under .quilt/conflicts.
      if (disk) this.lastKnown.set(rel, disk.key); else this.lastKnown.delete(rel)
      if (this.tryWrite(rel)) n++
    }
    if (!say || !n) return
    const files = `${n} file${n === 1 ? '' : 's'}`
    if (say === 'back') this.log(`▶️ Back on ${this.git.key}: caught up with the session (${files}).`)
    else if (say === 'reset') this.log(`↩️ Quilt kept the session's work: git put ${files} back to your last commit on this computer only, and the session's version is back.`)
    else this.log(`↩️ Quilt kept the session's work; your stash still has your copy. (${files})`)
  }

  /** Runs mergeOne over held entries ({ rel, base }), keeping each out of normal sync while it runs. Returns the conflicts. */
  /** Merges each entry into the room: how many need a person (conflicts), and how many changed the room (changed). */
  async mergeHeld (entries) {
    for (const e of entries) this.merging.add(e.rel)
    let conflicts = 0
    let changed = 0
    for (const e of entries) {
      if (this.stopped) break
      try {
        const r = await this.mergeOne(e)
        if (r === 'conflict') conflicts++
        else if (r) changed++
      } catch (err) { this.log(`could not merge ${e.rel}: ${err.message}`) }
      this.merging.delete(e.rel)
    }
    for (const e of entries) this.merging.delete(e.rel)
    return { conflicts, changed }
  }

  /**
   * Pushes the on-disk state of a path into the shared doc. Returns true if anything changed.
   * `pulled`: git brought this version (a pull), so it is not an edit of ours: never claimed, and counted as the pull's.
   */
  ingest (rel, { pulled = false } = {}) {
    if (!this.syncable(rel)) return false
    if (this.merging.has(rel)) return false // its offline merge hasn't run yet; see mergeOffline
    if (this.held()) { this.heldPaths.add(rel); return false } // git is at work in this folder; see onSettled
    if (this.pullWait.has(rel)) { if (!this.onDisk(rel)) return false; this.endPullWait(rel) } // made way for a pull: not a deletion
    // A plain `rm` of a file a fetched pull would bring (git said to remove it): making way, not a deletion.
    if (!this.onDisk(rel) && this.blocksPull(rel)) { this.waitForPull([rel], false); return false }
    if (this.downloading.has(rel)) return false // our copy is being replaced by a download
    if (this.writeFailed.has(rel)) return false // the shared version never reached the disk: what's there is no edit of ours
    if (IGNORE_FILES.includes(path.posix.basename(rel))) this.ig = loadIgnore(this.root)
    const disk = this.readDisk(rel)
    if (disk && (disk.skip || disk.tooLarge)) {
      if (disk.tooLarge && !this.warnedLarge.has(rel)) {
        this.warnedLarge.add(rel)
        this.log(`skipping ${rel}: file too large to sync`)
      }
      return false
    }
    const stored = this.blobs.get(rel)
    if (stored && stored.stored && this.storedOnDisk.get(rel) !== stored.hash &&
        (!disk || (disk.binary && disk.hash === this.storedOnDisk.get(rel)))) {
      // The folder still has the version before (or nothing): a download is
      // due, not a local change. Never share the stale copy.
      this.downloadLarge(rel, stored)
      return false
    }

    const claim = this.claimFor(rel)
    if (claim && !this.ownClaim(claim) && (disk ? disk.key : undefined) !== this.sharedKey(rel)) {
      this.rejectClaimed(rel, disk, claim)
      return false
    }
    const refusal = this.writeRefusal(rel)
    if (refusal && (disk ? disk.key : undefined) !== this.sharedKey(rel)) {
      this.rejectLocal(rel, disk, refusal)
      return false
    }
    // A change of ours to a file nobody holds claims it for us while our AI works on it. A person
    // typing by hand while their AI sits idle keeps editing live with everyone, as before.
    if (disk && !pulled && this.ready && !this.seeding && disk.key !== this.sharedKey(rel) && (!claim || this.autoClaims.has(rel)) && this.aiMayBeEditing()) this.autoClaim(rel)

    if (!disk) {
      if (!this.files.has(rel) && !this.blobs.has(rel)) { this.lastKnown.delete(rel); return false }
      this.closeHandMerge(rel, null) // deleting a file being merged by hand settles it too
      this.transact(() => {
        const was = this.files.get(rel)
        const before = was ? was.toString() : undefined
        this.files.delete(rel)
        this.blobs.delete(rel)
        this.recordActivity(rel, 'deleted', '', { before, after: before === undefined ? undefined : '' }, { pulled })
      }, LOCAL)
      this.lastKnown.delete(rel)
      this.setOnDisk(rel, null)
      this.noteMyEdit(rel, { pulled })
      return true
    }

    if (disk.key === this.sharedKey(rel)) {
      this.lastKnown.set(rel, disk.key)
      if (stored && stored.stored) this.setOnDisk(rel, stored.hash)
      return false
    }
    if (disk.binary && disk.buf.length >= LARGE_FILE_BYTES && !this.largeFilesOff) {
      const refused = this.uploadRefused.get(rel)
      if (!refused || refused.hash !== disk.hash) { this.uploadLarge(rel, disk, { pulled }); return false }
      if (!refused.inline || disk.buf.length > MAX_BINARY_BYTES) return false
      // Storage refused it, but it's small enough to share inside the document.
    }

    if (!disk.binary) this.closeHandMerge(rel, disk.text)
    let detail = ''
    this.transact(() => {
      const existed = this.files.has(rel) || this.blobs.has(rel)
      let texts
      if (disk.binary) {
        this.files.delete(rel)
        this.blobs.set(rel, { hash: disk.hash, data: disk.buf.toString('base64') })
        detail = `${disk.buf.length} bytes`
      } else {
        this.blobs.delete(rel)
        let ytext = this.files.get(rel)
        if (!ytext) {
          ytext = new Y.Text()
          this.files.set(rel, ytext)
        }
        texts = { before: ytext.toString(), after: disk.text }
        detail = applyTextDiff(ytext, disk.text)
      }
      this.recordActivity(rel, existed ? 'edited' : 'created', detail, texts, { pulled })
    }, LOCAL)
    this.lastKnown.set(rel, disk.key)
    this.setOnDisk(rel, null)
    this.noteMyEdit(rel, { pulled })
    if (!pulled) this.noteQueuedEdit(rel)
    return true
  }

  /** Someone else claimed rel: keep our version aside, put the shared one back on disk, and tell our AI. */
  rejectClaimed (rel, disk, claim) {
    const why = `it is claimed by ${claim.by}${claim.note ? ` (${claim.note})` : ''}`
    this.rejectLocal(rel, disk, why, claim.by)
    this.notice(`Your change to ${rel} was undone: ${why}. ${askForIt(rel, claim)}`)
  }

  /** Queues a line for this person's AI; the local MCP server hands pending notices over with its next answer. */
  notice (text) {
    this.notices.push(text)
    if (this.notices.length > NOTICE_CAP) this.notices.splice(0, this.notices.length - NOTICE_CAP)
  }

  takeNotices () {
    const out = this.notices
    this.notices = []
    return out
  }

  /** We may not change rel: keep our version aside and put the shared one back on disk. */
  rejectLocal (rel, disk, reason, by = null) {
    let kept = ''
    if (disk) {
      const dest = path.join(this.stateDir, 'rejected', `${Date.now()}`, ...rel.split('/'))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, disk.binary ? disk.buf : disk.text)
      kept = `; your version saved to ${path.relative(this.root, dest)}`
    }
    const abs = path.join(this.root, ...rel.split('/'))
    const t = this.files.get(rel)
    const b = this.blobs.get(rel)
    if (b && b.stored) {
      this.downloadLarge(rel, b)
    } else if (t || b) {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, t ? t.toString() : Buffer.from(b.data, 'base64'))
      this.lastKnown.set(rel, this.sharedKey(rel))
    } else {
      fs.rmSync(abs, { force: true })
      removeEmptyParents(this.root, path.dirname(abs))
      this.lastKnown.delete(rel)
    }
    this.log(`🔒 your change to ${rel} was undone: ${reason}${kept}`)
    this.emit('file-changed', { path: rel, by: by || this.lastEditorOf(rel) || 'partner' })
  }

  /**
   * `texts` is { before, after } for text files, so the chronology keeps the diff. `pulled`: a git pull
   * brought it: counted as the pull's, and left out of the activity log (notePull writes one line for it all).
   */
  recordActivity (rel, kind, detail, texts, { pulled = false } = {}) {
    const now = Date.now()
    this.tally(rel, kind, detail, now, texts, pulled)
    this.history.record({ by: this.name, path: rel, kind, detail, before: texts?.before, after: texts?.after, task: pulled ? null : this.currentTask(), pulled, ts: now })
    if (pulled) return
    const last = this.lastActivityPush.get(rel)
    // Collapse bursts of edits to the same file into one entry.
    if (kind === 'edited' && last && now - last < 20000) return
    this.lastActivityPush.set(rel, now)
    this.activity.push([{ by: this.name, path: rel, kind, detail, ts: now }])
    if (this.activity.length > 300) this.activity.delete(0, this.activity.length - 300)
  }

  /**
   * Add one change of mine to the running count for rel (`detail` is "+a -r" for text). What a pull
   * brought is counted apart from my own edits (its own key), so Changes can show it as the pull's.
   */
  tally (rel, kind, detail, now, texts, pulled = false) {
    if (this.seeding) return
    const key = pulled ? `${this.name}\0pull\0${rel}` : `${this.name}\0${rel}`
    const cur = this.tallies.get(key) || { added: 0, removed: 0, edits: 0, kind: 'edited' }
    const m = /^\+(\d+) -(\d+)$/.exec(detail || '')
    // Deleting a text file removes all of its lines.
    const gone = kind === 'deleted' && typeof texts?.before === 'string' ? lineCount(texts.before) : 0
    const state = kind === 'deleted' ? 'deleted' : kind === 'created' || cur.kind === 'created' ? 'created' : 'edited'
    this.tallies.set(key, {
      by: this.name,
      path: rel,
      added: cur.added + (m ? +m[1] : 0),
      removed: cur.removed + (m ? +m[2] : 0) + gone,
      edits: cur.edits + 1,
      kind: state,
      ...(pulled ? { pulled: true } : {}),
      ts: now
    })
  }

  /**
   * What has changed in this room and by whom: per person (most recent first,
   * with their own files, and apart from them what their git pulls brought) and
   * per file (with each person's share). Read from the shared doc, so everyone
   * sees the same breakdown.
   */
  changes () {
    const people = new Map()
    const files = new Map()
    const group = () => ({ added: 0, removed: 0, edits: 0, ts: 0, files: [] })
    for (const t of this.tallies.values()) {
      if (!t || !t.by || !isSafeRelPath(t.path)) continue
      const p = people.get(t.by) || { name: t.by, ...group(), pulled: null }
      const g = t.pulled ? (p.pulled = p.pulled || group()) : p
      g.added += t.added; g.removed += t.removed; g.edits += t.edits; g.ts = Math.max(g.ts, t.ts)
      g.files.push({ path: t.path, added: t.added, removed: t.removed, edits: t.edits, kind: t.kind, ts: t.ts })
      p.ts = Math.max(p.ts, t.ts)
      people.set(t.by, p)
      const f = files.get(t.path) || { path: t.path, ...group(), by: [] }
      f.added += t.added; f.removed += t.removed; f.edits += t.edits; f.ts = Math.max(f.ts, t.ts)
      f.by.push({ name: t.by, added: t.added, removed: t.removed, edits: t.edits, kind: t.kind, ts: t.ts, ...(t.pulled ? { pulled: true } : {}) })
      files.set(t.path, f)
    }
    const newest = (a, b) => b.ts - a.ts
    const out = { people: [...people.values()].sort(newest), files: [...files.values()].sort(newest) }
    for (const p of out.people) {
      p.files.sort(newest); p.fileCount = p.files.length
      if (p.pulled) { p.pulled.files.sort(newest); p.pulled.fileCount = p.pulled.files.length }
    }
    for (const f of out.files) { delete f.files; f.by.sort(newest); f.kind = f.by[0].kind } // the latest change says whether it's new, edited or gone
    return out
  }

  /** `pulled`: git brought it, so partners see the file change but not us "editing" it. */
  noteMyEdit (rel, { pulled = false } = {}) {
    const now = Date.now()
    this.emit('file-changed', { path: rel, by: this.name })
    if (pulled) return
    this.myEdits.set(rel, now)
    this.updatePresence()
  }

  // ------------------------------------------------------- shared -> local --

  fromRemote (rel) {
    const claim = this.claimFor(rel)
    if (claim && this.ownClaim(claim)) this.reclaim(rel)
    else this.writeOut(rel)
  }

  /**
   * Applies a remote update path by path. One that can't be written (a
   * read-only or in-the-way file, a folder that can't be made) never stops
   * the others: it's noted in writeFailed and tried again later.
   */
  applyRemote (paths) {
    const failed = []
    for (const p of paths) {
      try { this.fromRemote(p); this.writeFailed.delete(p) } catch { failed.push(p) }
    }
    // One may have needed another in the same update to go first (a file
    // removed where a folder now goes), so each gets a second go.
    for (const p of failed) this.tryWrite(p, true)
  }

  /** writeOut (or, `live`, fromRemote), with a failure logged and remembered instead of thrown. */
  tryWrite (rel, live = false) {
    try {
      if (live) this.fromRemote(rel)
      else this.writeOut(rel)
      this.writeFailed.delete(rel)
      return true
    } catch (err) {
      this.writeFailed.set(rel, err.message)
      this.log(`could not write ${rel}: ${err.message}; it will be tried again`)
      return false
    }
  }

  /**
   * A partner changed a path we claimed (their quilt should have refused, so
   * it's an old or misbehaving client): keep their version aside and put ours
   * back into the shared doc.
   */
  reclaim (rel) {
    if (!this.syncable(rel)) return
    const t = this.files.get(rel)
    const b = this.blobs.get(rel)
    if ((t || (b && !b.stored)) && this.sharedKey(rel) !== this.lastKnown.get(rel)) {
      const dest = path.join(this.stateDir, 'rejected', `${Date.now()}`, ...rel.split('/'))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, t ? t.toString() : Buffer.from(b.data, 'base64'))
    }
    // Outside the observer, so the revert goes out as its own update.
    queueMicrotask(() => {
      try {
        if (this.ingest(rel)) this.log(`🔒 reverted a partner's change to ${rel}, which you claimed; theirs is in .quilt/rejected`)
      } catch (err) { this.log(`could not revert ${rel}: ${err.message}`) }
    })
  }

  writeOut (rel) {
    if (!this.syncable(rel)) return
    if (this.merging.has(rel)) return // mergeOffline writes this path once it has merged it
    if (this.held()) { this.heldPaths.add(rel); return } // written back when the hold ends (writeBack)
    if (this.pullWait.has(rel) && !this.onDisk(rel)) return // out of the way for a pull: putting it back would block it
    let abs
    try { abs = resolveInside(this.root, rel) } catch (err) { this.log(err.message); return }
    const shared = this.sharedKey(rel)
    const disk = this.readDisk(rel)
    if (disk && (disk.skip || disk.tooLarge)) return
    const known = this.lastKnown.get(rel)

    if (this.ready && disk && disk.key !== known && disk.key !== shared) {
      // The file changed locally in the instant before this remote change
      // arrived. Keep a copy so nothing is lost.
      this.keepConflict(rel, disk)
    }

    if (shared === undefined) {
      if (disk) {
        fs.rmSync(abs, { force: true })
        removeEmptyParents(this.root, path.dirname(abs))
      }
      this.lastKnown.delete(rel)
      this.setOnDisk(rel, null)
    } else {
      const b = this.blobs.get(rel)
      if (b && b.stored) {
        // Written once it's downloaded; downloadLarge sets lastKnown and says who changed it.
        if (!disk || disk.key !== shared) { this.downloadLarge(rel, b); return }
        this.setOnDisk(rel, b.hash)
      } else if (!disk || disk.key !== shared) {
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        const t = this.files.get(rel)
        this.writeFile(rel, abs, t ? t.toString() : Buffer.from(b.data, 'base64'))
      }
      if (!b || !b.stored) this.setOnDisk(rel, null)
      this.lastKnown.set(rel, shared)
    }
    if (IGNORE_FILES.includes(path.posix.basename(rel))) this.ig = loadIgnore(this.root)

    if (this.ready) {
      this.emit('file-changed', { path: rel, by: this.lastEditorOf(rel) || 'partner' })
      const mine = this.myEdits.get(rel)
      if (mine && Date.now() - mine < RECENT_MS) {
        const who = this.lastEditorOf(rel)
        this.log(`👀 ${who || 'your partner'} just changed ${rel}, which you edited recently`)
      }
    }
  }

  /** Keeps our version of rel aside before something replaces it. */
  keepConflict (rel, disk) {
    const dest = path.join(this.stateDir, 'conflicts', `${Date.now()}`, ...rel.split('/'))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, disk.binary ? disk.buf : disk.text)
    this.noteBackup(rel, dest)
    this.log(`⚠️  simultaneous edit on ${rel}; your version saved to ${path.relative(this.root, dest)}`)
  }

  /** Writes the shared version of rel. A read-only copy of ours is made writable, or moved aside if it can't be. */
  writeFile (rel, abs, data) {
    try {
      fs.writeFileSync(abs, data)
      return this.noteWritten(rel, abs)
    } catch (err) {
      if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err
    }
    try {
      fs.chmodSync(abs, (fs.statSync(abs).mode & 0o7777) | 0o200)
      fs.writeFileSync(abs, data)
    } catch {
      this.moveAside(rel, abs)
      fs.writeFileSync(abs, data)
    }
    this.noteWritten(rel, abs)
  }

  /**
   * The re-scan learns of a file Quilt wrote at once: the watcher can miss
   * events in a folder Quilt just created, and a file the re-scan never saw
   * would never be noticed gone.
   */
  noteWritten (rel, abs) {
    try {
      const st = fs.lstatSync(abs)
      this.diskStats.set(rel, `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`)
    } catch {}
  }

  /** Moves whatever sits at rel (first join: a folder, or a file where a folder must go) into the backup folder. */
  moveToBackup (rel, backupDir) {
    const dest = path.join(backupDir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.renameSync(path.join(this.root, ...rel.split('/')), dest)
  }

  /**
   * A plain file sitting where one of rel's parent folders must go is moved
   * into backupDir; returns its path. A link in the way is left alone (where
   * it leads is not ours to move).
   */
  clearParents (rel, backupDir) {
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i++) {
      let st
      try { st = fs.lstatSync(path.join(this.root, ...parts.slice(0, i))) } catch { return null }
      if (st.isDirectory()) continue
      if (!st.isFile()) return null
      const anc = parts.slice(0, i).join('/')
      this.moveToBackup(anc, backupDir)
      return anc
    }
    return null
  }

  /** Moves our copy of rel into the conflicts folder (for files too big to copy through memory). */
  moveAside (rel, abs) {
    const dest = path.join(this.stateDir, 'conflicts', `${Date.now()}`, ...rel.split('/'))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    try { fs.renameSync(abs, dest) } catch { fs.copyFileSync(abs, dest) }
    this.log(`⚠️  ${rel} is being replaced by the shared version; yours was moved to ${path.relative(this.root, dest)}`)
  }

  lastEditorOf (rel) {
    for (let i = this.activity.length - 1; i >= 0; i--) {
      const a = this.activity.get(i)
      if (a.path === rel) return a.by === this.name ? null : a.by
    }
    return null
  }

  // ------------------------------------------------------- large files --

  /** Records which stored version of rel is in the folder (null: none, or it isn't a stored file). */
  setOnDisk (rel, hash) {
    if ((this.storedOnDisk.get(rel) || null) === (hash || null)) return
    if (hash) this.storedOnDisk.set(rel, hash)
    else this.storedOnDisk.delete(rel)
    this.scheduleStateSave()
  }

  /** Tries failed uploads, downloads and writes again. */
  retryFailed () {
    if (!this.ready || this.stopped) return
    const failed = [...this.retry]
    this.retry.clear()
    for (const [rel, kind] of failed) {
      if (kind === 'upload') { this.queue(rel); continue }
      const b = this.blobs.get(rel)
      if (b && b.stored && this.lastKnown.get(rel) !== `bin:${b.hash}`) this.writeOut(rel)
    }
    for (const rel of [...this.writeFailed.keys()]) this.tryWrite(rel, true)
  }

  wrapKeys () {
    const keys = [deriveWrapKey(this.secret, this.room)]
    if (this.viewSecret) keys.push(deriveWrapKey(this.viewSecret, this.room))
    return keys
  }

  /** The file keys this app can open (with `mine`, by default every wrap key it has): keyId -> key. */
  fileKeysICanOpen (mine = this.wrapKeys()) {
    const out = new Map()
    for (const [id, entry] of this.fileKeys) {
      for (const w of (entry && entry.wraps) || []) {
        const key = mine.map((wk) => unwrapKey(w, wk)).find(Boolean)
        if (key) { out.set(id, key); break }
      }
    }
    return out
  }

  /**
   * The key for new uploads: the first one our own secret opens, or a new one.
   * Not one only the view secret opens: anyone who can view could have made
   * that, and editors couldn't open what we stored with it.
   */
  currentFileKey () {
    const open = this.fileKeysICanOpen([deriveWrapKey(this.secret, this.room)])
    if (open.size) {
      const id = [...open.keys()].sort()[0]
      return { id, key: open.get(id) }
    }
    const key = newFileKey()
    const id = crypto.randomBytes(4).toString('hex')
    const wraps = this.wrapKeys().map((wk) => wrapKey(key, wk))
    this.bdoc.transact(() => this.fileKeys.set(id, { wraps, ts: Date.now() }), LOCAL)
    return { id, key }
  }

  /** The owner (the only one with the view secret) makes every key open for viewers too. */
  shareKeysWithViewers () {
    if (!this.viewSecret) return
    const vk = deriveWrapKey(this.viewSecret, this.room)
    for (const [id, key] of this.fileKeysICanOpen()) {
      const entry = this.fileKeys.get(id)
      if (entry.wraps.some((w) => unwrapKey(w, vk))) continue
      this.bdoc.transact(() => this.fileKeys.set(id, { ...entry, wraps: [...entry.wraps, wrapKey(key, vk)] }), LOCAL)
    }
  }

  /** Headers for the relay's session routes: the room secret, and a pass when signed in. */
  async relayHeaders (extra = {}) {
    return {
      'x-quilt-secret': this.secret,
      ...(this.key ? { 'x-quilt-key': this.key } : {}),
      ...(this.passes ? { 'x-quilt-pass': await this.passes.get() } : {}),
      ...extra
    }
  }

  async blobRequest (id, action, body = {}) {
    const res = await fetch(`${this.httpBase()}/blobs/${encodeURIComponent(this.room)}/${id}/${action}`, {
      method: 'POST',
      headers: await this.relayHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(body)
    })
    if (!res.ok) throw Object.assign(new Error(await res.text()), { status: res.status })
    return res.json()
  }

  /** Waits for a free transfer slot; call doneTransfer() when finished. */
  async startTransfer () {
    if (this.transfers < MAX_TRANSFERS) { this.transfers++; return }
    await new Promise((resolve) => this.transferQueue.push(resolve))
  }

  doneTransfer () {
    const next = this.transferQueue.shift()
    if (next) next() // the slot passes straight on
    else this.transfers--
  }

  /** Encrypts and uploads a large file, then points the shared document at it. */
  async uploadLarge (rel, disk, { pulled = false } = {}) {
    const { hash, key: diskKey } = disk
    disk = null // read again once it's our turn, so waiting uploads don't hold files in memory
    if (this.uploading.get(rel) === hash) return
    this.uploading.set(rel, hash)
    // If a partner's version lands while this uploads, theirs wins (ours is kept as a conflict copy).
    const sharedBefore = this.sharedKey(rel)
    await this.startTransfer()
    try {
      if (this.stopped) return
      const cur = this.readDisk(rel)
      if (!cur || cur.key !== diskKey) return // it changed again; that change is already queued
      const { id: keyId, key } = this.currentFileKey()
      const id = blobId(key, hash)
      // Encrypted first: the upload link is signed for exactly the size we send.
      const sealed = encryptBlob(cur.buf, key)
      const size = cur.buf.length
      const target = await this.blobRequest(id, 'upload', { size: sealed.length })
      if (!target.exists) {
        const res = await fetch(new URL(target.url, this.httpBase() + '/'), {
          method: target.method || 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: sealed
        })
        if (!res.ok && !(await alreadyStored(res))) throw Object.assign(new Error(`upload failed (HTTP ${res.status})`), { status: res.status, put: true })
      }
      const now = this.readDisk(rel)
      if (!now || now.key !== diskKey) return // it changed again; that change is already queued
      if (this.sharedKey(rel) !== sharedBefore || this.downloading.has(rel)) return // a partner's newer version wins
      const existed = this.files.has(rel) || this.blobs.has(rel)
      this.transact(() => {
        this.files.delete(rel)
        this.blobs.set(rel, { hash, size, stored: { id, key: keyId } })
        this.recordActivity(rel, existed ? 'edited' : 'created', `${size} bytes`, undefined, { pulled })
      }, LOCAL)
      this.lastKnown.set(rel, diskKey)
      this.setOnDisk(rel, hash)
      this.retry.delete(rel)
      this.uploadRefused.delete(rel)
      this.noteMyEdit(rel, { pulled })
    } catch (err) {
      this.uploadFailed(rel, hash, err)
    } finally {
      this.doneTransfer()
      if (this.uploading.get(rel) === hash) this.uploading.delete(rel)
    }
  }

  /** Decides what to do after an upload failed: try later, share it another way, or give up until it changes. */
  uploadFailed (rel, hash, err) {
    const warnOnce = (msg) => {
      if (this.warnedLarge.has(rel)) return
      this.warnedLarge.add(rel)
      this.log(msg)
    }
    if (err.status === 404 && !err.put) {
      // An older relay without file storage: share it inside the document if it fits.
      this.largeFilesOff = true
      this.queue(rel)
    } else if (err.status === 413) {
      // Over the relay's size limit, or the session's storage is full.
      this.uploadRefused.set(rel, { hash, inline: false })
      warnOnce(`skipping ${rel}: the relay won't store it (${err.message}). It will be tried again if the file changes.`)
    } else if (err.status === 403 && !err.put) {
      // Our invite only lets us view (even if we may edit now), so we can't store files.
      this.uploadRefused.set(rel, { hash, inline: true })
      let size = Infinity
      try { size = fs.statSync(path.join(this.root, ...rel.split('/'))).size } catch {}
      if (size <= MAX_BINARY_BYTES) this.queue(rel)
      else warnOnce(`skipping ${rel}: you joined with a view-only invite, so files over ${MAX_BINARY_BYTES / 1024 / 1024} MB can't be shared from here`)
    } else if (!err.status || err.status >= 500) {
      // Network trouble or a relay or storage hiccup: try again later.
      this.log(`could not upload ${rel}: ${err.message}`)
      this.retry.set(rel, 'upload')
    } else {
      this.log(`could not upload ${rel}: ${err.message}`)
    }
  }

  /** Downloads and decrypts a large file, then writes it into the folder. */
  async downloadLarge (rel, entry) {
    if (this.downloading.get(rel) === entry.hash) return
    this.downloading.set(rel, entry.hash)
    const before = this.readDisk(rel)?.key
    let started = false
    try {
      if (!this.fileKeysICanOpen().has(entry.stored.key)) return // its key hasn't arrived yet; the fileKeys observer retries
      await this.startTransfer()
      started = true
      if (this.stopped) return
      const cur0 = this.blobs.get(rel)
      if (!cur0 || cur0.hash !== entry.hash) return // replaced while waiting; that version is on its way
      const key = this.fileKeysICanOpen().get(entry.stored.key)
      const { url } = await this.blobRequest(entry.stored.id, 'download')
      const res = await fetch(new URL(url, this.httpBase() + '/'))
      if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`)
      const buf = decryptBlob(Buffer.from(await res.arrayBuffer()), key)
      if (sha1(buf) !== entry.hash) throw new Error('the downloaded file did not match')
      const cur = this.blobs.get(rel)
      if (!cur || cur.hash !== entry.hash) return // replaced meanwhile; that version is on its way
      if (this.stopped) return
      if (this.held()) { this.heldPaths.add(rel); return } // git is at work on the folder: written back when the hold ends
      const abs = resolveInside(this.root, rel)
      let st = null
      try { st = fs.lstatSync(abs) } catch {}
      if (st && !st.isFile()) {
        // A link or folder in its place: never write through it, maybe out of the project.
        this.log(`not writing ${rel}: something other than a plain file is in its place. Move it away to get the shared version.`)
        return
      }
      let now = null
      try { now = this.readDisk(rel) } catch { now = { unreadable: true } }
      if (now && (now.tooLarge || now.unreadable)) {
        this.moveAside(rel, abs) // we can't tell what it is, so it's kept rather than replaced
      } else if (now && now.key !== undefined && now.key !== this.lastKnown.get(rel) && now.key !== `bin:${entry.hash}`) {
        // Edited while it downloaded (ingest waits for downloads): keep that version.
        this.keepConflict(rel, now)
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      // O_NOFOLLOW: if a link appeared since the check, fail rather than follow it.
      fs.writeFileSync(abs, buf, { flag: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0) })
      this.lastKnown.set(rel, `bin:${entry.hash}`)
      this.setOnDisk(rel, entry.hash)
      this.retry.delete(rel)
      if (this.ready) this.emit('file-changed', { path: rel, by: this.lastEditorOf(rel) || 'partner' })
    } catch (err) {
      this.log(`could not download ${rel}: ${err.message}`)
      this.retry.set(rel, 'download')
    } finally {
      if (started) this.doneTransfer()
      if (this.downloading.get(rel) === entry.hash) this.downloading.delete(rel)
      // Look again at anything ingest skipped meanwhile. Only if the folder
      // changed, so a download that can't happen yet doesn't loop.
      if (!this.stopped && this.readDisk(rel)?.key !== before) this.queue(rel)
    }
  }

  /** Owner only: deletes the session from the relay and sends everyone away. */
  endForEveryone () { return this.conn.adminRequest({ op: 'end' }) }

  // --------------------------------------------------------------- watcher --

  async startWatcher () {
    this.gitIndex = indexStamp(this.root)
    this.stashSeen = stashStamp(this.root)
    this.refreshPull() // a fetch before this start may already have something to say
    if (this.git) {
      this.gitWatcher = watchGit(this.root, (e) => {
        if (this.stopped) return
        if (e.type === 'head') { this.headChangedAt = Date.now(); this.queue(HEAD_CHANGED) } else if (e.type === 'busy') { this.setHold('busy'); this.settleSoon() } else if (e.type === 'fetch') { this.pullWaitOver.clear(); this.refreshPull(); this.checkUpstreamSoon() } else if (e.type === 'ref') { this.checkUpstreamSoon() } else this.settleSoon() // idle, index
        if (this.hold && this.hold.kind === 'switching') this.checkBackOnBranch()
      })
      if (this.hold && this.hold.kind === 'switching') this.checkBackOnBranch() // back before the watcher started?
      else this.settleSoon() // a hold resumed at start ends once the tree has settled
      this.upstreamPoll = setInterval(() => this.checkUpstreamSoon({ fetch: true }), UPSTREAM_MS)
      this.upstreamPoll.unref()
      this.checkUpstreamSoon({ fetch: true })
    }
    this.scanDisk({ baseline: true }) // the folder was just reconciled; the first re-scan catches anything since
    this.watcher = watch(this.root, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (p) => {
        const rel = toPosix(path.relative(this.root, p))
        return rel !== '' && !rel.startsWith('..') && isIgnored(this.ig, rel)
      }
    })
    const onFile = (p) => {
      this.lastFileEventAt = Date.now()
      const rel = toPosix(path.relative(this.root, p))
      if (rel && !rel.startsWith('..')) this.queue(rel)
    }
    const onChange = (p) => {
      onFile(p)
      const rel = toPosix(path.relative(this.root, p))
      if (!rel || rel.startsWith('..')) return
      clearTimeout(this.rechecks.get(rel))
      this.rechecks.set(rel, setTimeout(() => { this.rechecks.delete(rel); if (this.ready) this.queue(rel) }, WATCH_RECHECK_MS))
    }
    this.watcher.on('add', onFile).on('change', onChange).on('unlink', onFile)
    this.watcher.on('unlinkDir', (p) => {
      this.lastFileEventAt = Date.now()
      const relDir = toPosix(path.relative(this.root, p))
      for (const rel of this.sharedPaths()) if (rel.startsWith(relDir + '/')) this.queue(rel)
    })
    this.watcher.on('error', (err) => this.log(`watcher error: ${err.message}`))
    await new Promise((resolve) => this.watcher.once('ready', resolve))
    this.reconcileTimer = setInterval(() => { if (this.ready) this.scanDisk() }, RECONCILE_MS)
    this.reconcileTimer.unref()
    this.scanDisk()
  }

  /** Stats the folder and queues every path that appeared, changed or vanished since the last scan. */
  scanDisk ({ baseline = false } = {}) {
    const seen = new Set()
    for (const rel of walk(this.root, this.ig)) {
      let st
      try { st = fs.lstatSync(path.join(this.root, ...rel.split('/'))) } catch { continue }
      seen.add(rel)
      const sig = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`
      if (this.diskStats.get(rel) === sig) continue
      if (!baseline) this.queue(rel)
      this.diskStats.set(rel, sig)
    }
    for (const rel of this.diskStats.keys()) {
      if (!seen.has(rel)) { this.diskStats.delete(rel); this.queue(rel) }
    }
  }

  // ----------------------------------------------------- presence & social --

  setupPresence () {
    const color = this.color || COLORS[Math.abs(hashCode(this.name)) % COLORS.length]
    this.conn.awareness.setLocalState({
      name: this.name, tool: this.tool, color, focus: '', editing: {}, agents: [], kind: this.kind,
      agent: { tool: null, status: 'idle', sharing: this.agentSharing }, git: this.gitSummary()
    })
    this.conn.awareness.on('change', ({ added, removed }, origin) => {
      if (origin === 'local' || origin === 'connection') return
      for (const id of added) {
        const s = this.conn.awareness.getStates().get(id)
        if (s && id !== this.doc.clientID) this.log(`👋 ${s.name} joined (${s.tool})`)
      }
      if (removed.length) this.log(`${removed.length === 1 ? 'a partner' : `${removed.length} partners`} left`)
      this.scheduleStatusWrite()
    })
  }

  updatePresence () {
    const now = Date.now()
    if (this.presenceTimer) return
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null
      const editing = {}
      for (const [p, ts] of this.myEdits) {
        if (now - ts < RECENT_MS * 2) editing[p] = ts
        else this.myEdits.delete(p)
      }
      this.conn.awareness.setLocalStateField('editing', editing)
    }, 500)
  }

  // ------------------------------------------------------- commit timing --

  /** An agent says it's working or done (people's AI status comes from their chat reader). */
  setWork (state, note = '') {
    this.work = state === 'working' || state === 'done' ? { state, note: String(note).slice(0, 200), ts: Date.now() } : null
    this.workFromEdits = false // said on purpose now (prepareEdit sets it again when it is the one saying so)
    if (this.conn) this.conn.awareness.setLocalStateField('work', this.work)
    this.scheduleStatusWrite()
    return this.work
  }

  /** Asks the host to commit once everyone's AI is idle. */
  requestCommit (message) {
    message = String(message || '').trim().slice(0, 500)
    if (!message) throw new Error('say what the commit is for')
    if (this.access && this.access.state === 'approved' && this.access.role === 'viewer') throw new Error('viewers can’t ask for commits')
    // A commit request is a message to the host: the relay undoes it from someone who may not post.
    if (!this.mayTalk()) throw new Error(TALK_REFUSED)
    const r = { id: crypto.randomBytes(6).toString('hex'), by: this.name, message, ts: Date.now(), state: 'open' }
    this.doc.transact(() => {
      this.commitRequests.set(r.id, r)
      // Keep the list short: drop old finished requests.
      const done = [...this.commitRequests.values()].filter((x) => x.state === 'done').sort((a, b) => a.ts - b.ts)
      for (const x of done.slice(0, Math.max(0, done.length - 20))) this.commitRequests.delete(x.id)
    }, LOCAL)
    this.log(`📌 you asked for a commit: ${message}`)
    return r
  }

  // ------------------------------------------------------------- tasks --

  /** The shared board: To do, In progress, QA, Done. Everyone in the room sees the same list. */
  taskList () { return withComments(readTasks(this.tasks), this.taskComments) }

  /** Adds a comment to a task as this person: a work note, a handoff, why it went to whom. */
  commentTask ({ id, text } = {}) {
    if (!this.mayTalk()) throw new Error(TALK_REFUSED)
    const comment = putComment(this.doc, this.taskComments, readTasks(this.tasks), { taskId: id, by: this.name, text }, LOCAL)
    return { comment, task: this.taskList().find((t) => t.id === id) }
  }

  /**
   * The In-progress task this person (or, when their AI is working, their AI) is on,
   * so a change can be filed under it. Null when there is none.
   */
  currentTask () {
    const aiWorking = this.kind !== 'agent' && this.agentState?.status === 'working'
    return currentTask(this.taskList(), this.name, { preferAi: aiWorking })
  }

  /** The project's own checks under "Verifying a change" in AGENTS.md (or CLAUDE.md); '' when there are none. */
  readChecklist () {
    const read = (f) => { try { return fs.readFileSync(path.join(this.root, f), 'utf8') } catch { return '' } }
    return pickChecklist(read('AGENTS.md'), read('CLAUDE.md'))
  }

  /**
   * What an agent needs when it picks up a task: the task, recent chronology for
   * its files (or the project when it lists none), claims that touch them, and the checklist.
   */
  taskBrief (id) {
    const task = this.taskList().find((t) => t.id === id)
    if (!task) throw new Error('no such task')
    const files = task.files || []
    const all = this.history.entries()
    const history = (files.length ? all.filter((e) => files.includes(e.path)) : all).slice(-8)
    const claims = [...this.claims.values()]
      .filter((c) => !files.length || files.some((f) => globMatcher(c.pattern)(f)))
      .map((c) => ({ by: c.by, pattern: c.pattern, note: c.note }))
    return { task, history, claims, checklist: this.readChecklist(), me: this.name }
  }

  /**
   * The chronology, filtered: { path, by, since, task, limit }. `since` is "2h",
   * "3d", "today", "yesterday" or a date.
   */
  historyQuery ({ path, by, since, task, limit } = {}) {
    const from = parseSince(since)
    if (from === undefined) throw new Error('since: use a duration like 2h or 3d, "today", "yesterday", or a date')
    return queryHistory(this.history.entries(), { path, by, since: from ?? undefined, task, limit: Math.min(Number(limit) || 50, 500) })
  }

  /** `input` is a title, or { title, assignee, forAi, to_ai, tool, files }. "me" means this person. */
  addTask (input) {
    const fields = typeof input === 'string' ? { title: input } : { ...(input || {}) }
    this.prepareAssign(fields, { creating: true })
    return putTask(this.doc, this.tasks, {
      title: fields.title,
      by: this.name,
      assignee: fields.assignee,
      forAi: fields.forAi,
      tool: fields.tool,
      files: fields.files,
      column: fields.column,
      conv: fields.conv
    }, LOCAL)
  }

  updateTask (fields) {
    const f = { ...(fields || {}) }
    this.prepareAssign(f)
    return patchTask(this.doc, this.tasks, f, LOCAL)
  }

  /** Rewrites "me" to this person and fills in an AI tool when we know whose it is. */
  prepareAssign (fields, { creating = false } = {}) {
    if (typeof fields.assignee === 'string' && fields.assignee.trim() === 'me') fields.assignee = this.name
    if (fields.to_ai != null && fields.forAi == null) fields.forAi = !!fields.to_ai
    delete fields.to_ai
    delete fields.by
    if (fields.forAi !== true || fields.tool) return
    const name = fields.assignee != null ? String(fields.assignee).trim() : ''
    if (name === this.name || (creating && !name)) fields.tool = this.tool
    else if (name) {
      const peer = this.status().peers.find((p) => p.name === name)
      if (peer?.tool && peer.tool !== 'unknown') fields.tool = peer.tool
    }
  }

  deleteTask (id) { dropTask(this.doc, this.tasks, id, LOCAL) }

  // ------------------------------------------------------------- inbox --

  /** Who the inbox is for: this agent, or this person's AI (tasks for "their AI" are its). */
  inboxReader () {
    // This person's AI sessions, through this app or another Quilt of theirs in the room: a
    // session writing to its person is talking to the person, not to their other sessions.
    const own = [...this.personas.values()].flatMap((p) => [p.name, ...(p.aliases || [])])
    if (this.conn && this.conn.awareness) {
      for (const st of this.conn.awareness.getStates().values()) {
        if (!st || st.name !== this.name || !Array.isArray(st.personas)) continue
        for (const x of st.personas) if (x && typeof x.name === 'string') own.push(x.name)
      }
    }
    // With no AI session of ours live, what is written to "<me>'s AI" waits here for the next one.
    const aliases = this.kind !== 'agent' && !this.leadPersona() ? [aiName(this.name)] : []
    return { name: this.name, aliases, asAi: this.kind !== 'agent', agent: this.kind === 'agent', own }
  }

  /**
   * Looks for new mentions, direct messages and handed-over tasks. `quiet` takes
   * stock without waking anyone (our own changes, and everything there before we were ready).
   */
  scanInbox ({ quiet = false, personas = quiet } = {}) {
    let events
    try {
      const messages = this.chat.toArray().filter((m) => this.canSee(m))
      const tasks = this.taskList()
      // Each AI session's own inbox: what is said and handed to it by name.
      for (const p of this.personas.values()) p.inbox.scan({ messages, tasks, reader: this.personaReader(p) }, { quiet: personas || !this.ready })
      events = this.inboxTracker.scan({
        messages,
        tasks,
        reader: this.inboxReader()
      }, { quiet: quiet || !this.ready })
    } catch (err) {
      this.emit('debug', `inbox: ${err.message}`)
      return
    }
    if (!events.length) return
    this.emit('inbox', events)
    if (this.webhook) this.sendWebhook(events)
  }

  /**
   * Inbox events after sequence number `after` (0 for all kept), and the latest number. A message
   * already answered (by any AI session working as this member, or the person) or settled as
   * needing no reply is left out, so a second session doesn't answer it again; `all` keeps them.
   */
  inbox ({ after = 0, all = false, via = null } = {}) {
    const p = this.persona(via)
    const r = (p ? p.inbox : this.inboxTracker).since(after)
    if (all) return r
    const msgs = this.chat.toArray().filter((m) => this.canSee(m))
    const me = p ? [p.name, ...p.aliases, aiName(this.name)] : [this.name, aiName(this.name)]
    const open = (e) => (e.kind !== 'dm' && e.kind !== 'mention') || e.queue ||
      (!this.settledIds.has(e.id) && !answered(msgs, me, e.by, e.ts))
    return { ...r, events: r.events.filter(open) }
  }

  /** Marks direct messages and mentions as needing no reply, for every AI session working as this member. */
  settle (ids) {
    const known = new Set(this.chat.toArray().map((m) => m && m.id))
    const done = (Array.isArray(ids) ? ids : []).map(String).filter((id) => known.has(id))
    for (const id of done) this.settledIds.add(id)
    if (this.settledIds.size > 1000) this.settledIds = new Set([...this.settledIds].slice(-500))
    return { settled: done }
  }

  /** Everyone this member could address: who is here and who has been in the chat. */
  memberNames (me = this.name) {
    const names = new Set(this.peerNames())
    if (me !== this.name) names.add(this.name) // an AI session may write to its own person
    for (const p of this.status().peers) if (p.persona && p.of && !p.mine) names.add(aiName(p.of)) // "Brandon's AI"
    for (const m of this.chat.toArray()) if (m && this.canSee(m)) { if (m.by) names.add(m.by); if (m.to) names.add(m.to) }
    names.delete(me)
    return [...names].filter((n) => typeof n === 'string' && n)
  }

  // ---------------------------------------------------------- webhook --

  get webhookFile () { return path.join(this.stateDir, 'webhook.json') }

  loadWebhook () {
    try {
      const w = JSON.parse(fs.readFileSync(this.webhookFile, 'utf8'))
      this.webhook = w && typeof w.url === 'string' && typeof w.secret === 'string' && Array.isArray(w.events) ? w : null
    } catch { this.webhook = null }
  }

  /**
   * Subscribes this member's webhook: from now on each inbox event (a mention, a direct
   * message, a task handed over) is POSTed to `url`, signed with `secret` (made when not
   * given). Kept on disk for this folder. Returns the subscription (`made`: the secret is new).
   */
  setWebhook ({ url, secret, events, bearer } = {}) {
    const sub = makeSubscription({ url, secret, events, bearer }, { allowLocal: true })
    this.webhook = { url: sub.url, secret: sub.secret, events: sub.events, since: sub.since, ...(sub.bearer ? { bearer: sub.bearer } : {}) }
    fs.writeFileSync(this.webhookFile, JSON.stringify(this.webhook))
    return { ...this.webhook, made: sub.made }
  }

  /** Removes the webhook; true when there was one. */
  clearWebhook () {
    const had = !!this.webhook
    this.webhook = null
    try { fs.rmSync(this.webhookFile, { force: true }) } catch {}
    return had
  }

  /** The subscription without its secret, or null. */
  webhookInfo () { return this.webhook ? { url: this.webhook.url, events: this.webhook.events, since: this.webhook.since, bearer: !!this.webhook.bearer } : null }

  /** POSTs `events` to the webhook, one after another, in order; failures are logged, never thrown. */
  sendWebhook (events) {
    const sub = this.webhook
    const t = this.webhookTransport || {}
    const opts = { log: (m) => this.log(m), ...(t.fetch ? { fetch: t.fetch } : {}), ...(t.delays ? { delays: t.delays } : {}) }
    this.webhookSending = this.webhookSending.then(() => deliverEvents(sub, events, { room: this.room, to: this.name }, opts)).catch(() => {})
    return this.webhookSending
  }

  /** Marks open requests as done by a commit. */
  resolveCommitRequests ({ hash = '', ids = null } = {}) {
    const open = [...this.commitRequests.values()].filter((r) => r.state === 'open' && (!ids || ids.includes(r.id)))
    if (!open.length) return 0
    this.doc.transact(() => {
      for (const r of open) this.commitRequests.set(r.id, { ...r, state: 'done', doneBy: this.name, hash, doneAt: Date.now() })
    }, LOCAL)
    return open.length
  }

  /**
   * Who's still working, open commit requests, and whether it's a good moment
   * to commit. `includeMe: false` leaves out our own AI (it's the one asking).
   */
  commitStatus ({ includeMe = true } = {}) {
    const st = this.status()
    const people = [...(includeMe ? [{ ...st.me, work: this.work, isMe: true }] : []), ...st.peers]
    const busy = []
    for (const p of people) {
      const a = p.agent
      if (a && a.sharing !== false && a.status === 'working') busy.push({ name: p.name, why: `${p.isMe ? 'your' : `${p.name}'s`} ${a.tool || 'AI'} is working` })
      else if (p.work && p.work.state === 'working') busy.push({ name: p.name, why: `${p.isMe ? 'you are' : `${p.name} is`} working${p.work.note ? `: ${p.work.note}` : ''}` })
    }
    const requests = [...this.commitRequests.values()].sort((a, b) => a.ts - b.ts)
    return {
      open: requests.filter((r) => r.state === 'open'),
      recent: requests.filter((r) => r.state === 'done').slice(-5),
      busy,
      ready: busy.length === 0
    }
  }

  setFocus (text) {
    this.focus = String(text || '').slice(0, 500)
    this.conn.awareness.setLocalStateField('focus', this.focus)
    this.scheduleStatusWrite()
  }

  addAgent (client) {
    if (!client) return
    this.agents.add(String(client).slice(0, 80))
    this.conn.awareness.setLocalStateField('agents', [...this.agents])
  }

  // ------------------------------------------------- AI sessions (persona.js) --
  // Several AI sessions often work through this one app (two Claude Code chats, Cursor, Codex).
  // Each is a member of its own, named after its work, so partners message the right one and
  // its claims go idle when it stops, not when its person does.

  /**
   * An AI session (one `quilt mcp`, by its `via` id) says hello. Its name is taken from the git
   * branch in its folder when that names the work, otherwise from its tool until it says what
   * it is doing. Resolves to { name, named }; calling again keeps the name.
   */
  registerPersona ({ via, tool = '', cwd = '', ppid = null, pids = null } = {}) {
    const chain = (Array.isArray(pids) ? pids : [ppid]).map(Number).filter((n) => n > 1).slice(0, 2)
    via = String(via || '')
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(via)) throw new Error('bad session id')
    // An agent that joined as its own member is this session: it already has a name of its own.
    if (this.kind === 'agent') return { name: this.name, own: true }
    const now = Date.now()
    let p = this.personas.get(via)
    // The same tool session again (its `quilt mcp` restarted, or a second one from the same
    // process): it keeps its name, claims and inbox instead of becoming "… 2".
    if (!p && chain[0]) {
      const same = [...this.personas.values()].find((q) => q.chain && q.chain[0] === chain[0])
      if (same) {
        this.personas.delete(same.via)
        for (const [rel, v] of this.autoVia) if (v === same.via) this.autoVia.set(rel, via)
        same.via = via
        this.personas.set(via, same)
        p = same
      }
    }
    if (!p) {
      const fromBranch = labelFromBranch(gitBranch(cwd && fs.existsSync(cwd) ? cwd : this.root))
      const label = fromBranch || cleanLabel(tool) || 'AI'
      p = { via, rid: via, label, name: '', aliases: [], tool: String(tool || '').slice(0, 40), chain, named: fromBranch ? 'branch' : null, inbox: new Inbox(), seenAt: now, touchedAt: 0, focus: '' }
      p.name = this.freePersonaName(label)
      this.personas.set(via, p)
      // What is already in the chat wakes nobody.
      p.inbox.scan({ messages: this.chat.toArray().filter((m) => this.canSee(m)), tasks: this.taskList(), reader: this.personaReader(p) }, { quiet: true })
      if (!this.personaTimer) {
        this.personaTimer = setInterval(() => this.publishPersonas(), 60 * 1000)
        if (this.personaTimer.unref) this.personaTimer.unref()
      }
      this.log(`🤖 ${p.name} (${p.tool || 'AI'}) is working through this app`)
    } else {
      if (tool) p.tool = String(tool).slice(0, 40)
      if (chain.length) p.chain = chain
      p.seenAt = now
    }
    this.publishPersonas()
    return { name: p.name, named: p.named }
  }

  /** "Daniel · file-queue", or with " 2" when someone in the session already has that name. */
  freePersonaName (label, except = null) {
    const taken = new Set(this.status().peers.filter((x) => !x.mine).map((x) => x.name))
    taken.add(this.name)
    for (const q of this.personas.values()) if (q !== except) taken.add(q.name)
    const base = personaName(this.name, label)
    let name = base
    for (let i = 2; taken.has(name); i++) name = `${base} ${i}`
    return name
  }

  persona (via) { return via ? this.personas.get(String(via)) || null : null }

  /** Who an action from this AI session is by: its own name, or this member's. */
  actorName (via) { const p = this.persona(via); return p ? p.name : this.name }

  /** The claim request fields that make the relay act for an AI session (server.js claimant). */
  as (via) { const p = this.persona(via); return p ? { as: { id: p.rid || p.via, label: p.label } } : {} }

  /** Whether a name is this member's or one of its AI sessions' (now or before a rename). */
  isMine (name) {
    if (!name) return false
    if (name === this.name || name === aiName(this.name)) return true
    for (const p of this.personas.values()) if (p.name === name || p.aliases.includes(name)) return true
    return false
  }

  /** Whether a claim is this member's or one of its AI sessions': files on this disk are ours to write. */
  ownClaim (c) { return !!c && (c.by === this.name || c.of === this.name || this.isMine(c.by)) }

  /** Whether one AI session holds a claim (not this member, nor another of its sessions). */
  claimHeldBy (c, via) {
    const p = this.persona(via)
    return !!c && !!p && (c.by === p.name || p.aliases.includes(c.by))
  }

  /**
   * How an AI session reads the inbox. What is written to "<person>'s AI" goes to one session
   * only, the one of ours active most recently, so a question is answered once.
   */
  personaReader (p) {
    const aliases = p === this.leadPersona() ? [...p.aliases, aiName(this.name)] : p.aliases
    // Its sibling sessions here don't wake it: they work for the same person.
    const own = [...this.personas.values()].filter((q) => q !== p).flatMap((q) => [q.name, ...q.aliases])
    return { name: p.name, aliases, asAi: false, agent: true, of: this.name, own }
  }

  /** The AI session of ours that answers for "<person>'s AI": the live one heard from last, or null. */
  leadPersona () {
    const now = Date.now()
    let lead = null
    for (const p of this.personas.values()) if (now - p.seenAt < PERSONA_AWAY_MS && (!lead || p.seenAt > lead.seenAt)) lead = p
    return lead
  }

  /** Renames an AI session ("self": it chose; "text": from what it said it does). The old name still reaches it. */
  renamePersona (via, label, how = 'self') {
    const p = this.persona(via)
    if (!p) throw new Error('this AI session has not said hello to Quilt yet')
    const clean = cleanLabel(label)
    if (!clean) throw new Error('give a few words about what you work on')
    const name = this.freePersonaName(clean, p)
    if (name === p.name) return { name }
    if (!p.aliases.includes(p.name)) p.aliases.push(p.name)
    p.aliases = p.aliases.filter((n) => n !== name).slice(-5)
    p.label = clean
    p.name = name
    p.named = how
    this.publishPersonas()
    this.log(`🤖 ${p.aliases[p.aliases.length - 1]} is now ${name}`)
    return { name }
  }

  /** The first thing an unnamed AI session says it is doing names it (its focus, a task, what it shares). */
  personaSays (via, text) {
    const p = this.persona(via)
    if (!p || !text) return
    p.focus = String(text).slice(0, 200)
    if (!p.named) {
      const label = labelFromText(text)
      if (label) { this.renamePersona(via, label, 'text'); return }
    }
    this.publishPersonas()
  }

  /**
   * What the person asked their AI session (its tool's prompt hook): the first prompt names a
   * session that has no name yet. Not while this person keeps their AI chat to themselves.
   */
  personaPrompt (via, text) {
    const p = this.persona(via)
    if (!p || p.named || this.agentSharing === false) return
    const label = labelFromText(text)
    if (label) this.renamePersona(via, label, 'prompt')
  }

  /** An AI session used a Quilt tool: it is here, and its claims' idle time starts again (once a minute at most). */
  touchPersona (via) {
    const p = this.persona(via)
    if (!p) return
    const now = Date.now()
    const wasAway = now - p.seenAt > PERSONA_AWAY_MS
    p.seenAt = now
    if (wasAway) this.publishPersonas()
    if (now - p.touchedAt < 60 * 1000 || !this.conn) return
    p.touchedAt = now
    this.conn.claimRequest({ op: 'touch', ...this.as(via) }).catch(() => {})
  }

  /** The AI session a hook belongs to: the one whose tool process is among the hook's parents. */
  personaFor (pids) {
    // The tool process can be the parent of `quilt mcp` or one level up (behind a shell), and
    // several tools can share an app further up: the closest common parent wins.
    const list = (Array.isArray(pids) ? pids : []).map(Number).filter((n) => n > 1)
    let best = null
    for (const p of this.personas.values()) {
      (p.chain || []).forEach((pid, i) => {
        const at = list.indexOf(pid)
        if (at >= 0 && (!best || at + i < best.score)) best = { via: p.via, score: at + i }
      })
    }
    return best ? best.via : null
  }

  /** Tells the session which AI sessions work here (those heard from in the last half hour). */
  publishPersonas () {
    if (!this.conn) return
    const now = Date.now()
    // A session whose tool process has ended is gone: its name is free again.
    for (const p of [...this.personas.values()]) if (p.chain && p.chain[0] && !processAlive(p.chain[0])) this.personas.delete(p.via)
    const live = [...this.personas.values()].filter((p) => now - p.seenAt < PERSONA_AWAY_MS)
    const list = live.map((p) => ({ name: p.name, tool: p.tool, ...(p.focus ? { focus: p.focus } : {}) }))
    const was = JSON.stringify(this.conn.awareness.getLocalState()?.personas || [])
    if (JSON.stringify(list) !== was) this.conn.awareness.setLocalStateField('personas', list)
  }

  // ------------------------------------------------------------ messaging --

  /**
   * Posts a chat message. `to` makes it a direct message: it is only shown to
   * that person (it still travels through the shared room, so it isn't secret
   * from the relay or a modified client).
   */
  /**
   * Posts a chat message. From an AI (`agent`: the MCP server or the CLI), it must say who it is
   * for (@Name or `to`, or `everyone`), and `via` (one AI session) may not repeat what another
   * session working as this member already sent the same person since they last wrote, unless `also`.
   */
  say (text, { to = null, file = null, agent = false, via = null, everyone = false, also = false } = {}) {
    if (!this.mayTalk()) throw new Error(TALK_REFUSED)
    text = String(text || '').slice(0, 4000)
    if (!text && !file) throw new Error('message is empty')
    to = to ? String(to).trim() : null
    const by = this.actorName(via) // an AI session speaks under its own name
    if (to === by || (to && via && this.persona(via) && to === aiName(this.name))) throw new Error('that is you')
    const names = agent ? this.memberNames(by) : []
    const targets = agent ? addressees(text, to, names) : []
    if (agent && !file) {
      const why = unaddressed(text, { to, everyone, names })
      if (why) throw new Error(why)
      const now = Date.now()
      this.aiSent = this.aiSent.filter((x) => x.ts > now - 60 * 60 * 1000)
      const hit = !also && sentByAnother(this.aiSent, { via, targets, messages: this.chat.toArray().filter((m) => this.canSee(m)), now })
      if (hit) throw new Error(renderRepeat(hit, now))
    }
    const msg = { id: crypto.randomBytes(8).toString('hex'), by, to, text, ts: Date.now() }
    if (this.persona(via)) msg.of = this.name // people see it as from "<person>'s AI"
    if (file) msg.file = file
    this.doc.transact(() => {
      this.chat.push([msg])
      if (this.chat.length > 500) this.chat.delete(0, this.chat.length - 500)
    }, LOCAL)
    this.markRead([msg.id])
    if (via) this.aiSent.push({ via: String(via), targets, text, ts: msg.ts })
    this.scheduleStatusWrite()
    const online = !to || this.peerNames().includes(to) || this.status().peers.some((p) => p.persona && p.of && aiName(p.of) === to)
    return { ...this.describeMessage(msg), recipientOnline: online }
  }

  /** Uploads a file to the relay and posts it as a message. */
  async sendFile (filePath, { to = null, text = '' } = {}) {
    if (!this.mayTalk()) throw new Error(TALK_REFUSED)
    const abs = path.resolve(this.root, filePath)
    const st = fs.statSync(abs)
    if (!st.isFile()) throw new Error(`${filePath} is not a file`)
    if (st.size > MAX_SHARED_FILE_BYTES) throw new Error(`${filePath} is larger than ${MAX_SHARED_FILE_BYTES / 1024 / 1024} MB`)
    const res = await fetch(`${this.httpBase()}/files/${encodeURIComponent(this.room)}`, {
      method: 'POST',
      headers: await this.relayHeaders({ 'content-type': 'application/octet-stream' }),
      body: fs.readFileSync(abs)
    })
    if (!res.ok) throw new Error(`upload failed: ${await res.text()}`)
    const fileId = await res.text()
    return this.say(text, { to, file: { id: fileId, name: path.basename(abs), size: st.size } })
  }

  /** Downloads a message's attachment (to .quilt/inbox/ by default). */
  async fetchFile (msgOrId, dest) {
    const msg = typeof msgOrId === 'string' ? this.chat.toArray().find((m) => validMessage(m) && (m.id === msgOrId || (m.file && m.file.id === msgOrId))) : msgOrId
    if (!msg || !msg.file || !this.canSee(msg)) throw new Error('no such file')
    const target = dest ? path.resolve(dest) : this.inboxPath(msg)
    const finalPath = fs.existsSync(target) && fs.statSync(target).isDirectory() ? path.join(target, safeName(msg.file.name)) : target
    if (!dest) {
      // Belt and braces: the id and name are sanitised, so this can't escape the inbox; never let it anyway.
      const inside = path.relative(path.join(this.stateDir, 'inbox'), finalPath)
      if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('refusing to save a file outside the inbox')
    }
    const res = await fetch(`${this.httpBase()}/files/${encodeURIComponent(this.room)}/${encodeURIComponent(msg.file.id)}`, {
      headers: await this.relayHeaders()
    })
    if (!res.ok) throw new Error(`download failed: ${await res.text()}`)
    fs.mkdirSync(path.dirname(finalPath), { recursive: true })
    fs.writeFileSync(finalPath, Buffer.from(await res.arrayBuffer()))
    return finalPath
  }

  /** Downloads unread files that were sent while we were offline. */
  fetchMissedFiles () {
    for (const m of this.messages({ unreadOnly: true, markRead: false, limit: 50 })) {
      if (!m.file || m.file.localPath) continue
      this.fetchFile(m.id).then(
        (dest) => this.log(`📎 received ${m.file.name} from ${m.by} while you were away → ${path.relative(this.root, dest)}`),
        () => {}
      )
    }
  }

  inboxPath (msg) {
    return path.join(this.stateDir, 'inbox', `${msg.id.slice(0, 6)}-${safeName(msg.file.name)}`)
  }

  /**
   * Owner only: a link a chat-only AI (ChatGPT, claude.ai, Grok…) pastes in and works through by
   * opening pages: read and send messages, read and add tasks, read files, add pictures,
   * documents and notes (see chat-links.js). It joins as its own member; removing it ends the link.
   * It works for ten minutes unless `minutes` says otherwise, and the owner can extend it.
   */
  async createChatLink ({ name = '', minutes } = {}) {
    if (!this.conn) throw new Error('not connected to the relay')
    if (!this.canAdmit) throw new Error('only people who may let others into this session can make a chat link')
    const r = await this.conn.adminRequest({ op: 'chatlink', name: String(name || ''), ...(minutes ? { minutes: Number(minutes) } : {}) })
    return { url: `${this.httpBase()}/c/${this.room}/${r.token}`, name: r.name, expiresAt: r.expiresAt }
  }

  /** Whoever may let people in: a chat link (by its member key, or its name) works for `minutes` from now. One that ran out can't be. */
  async extendChatLink (who, minutes) {
    if (!this.conn) throw new Error('not connected to the relay')
    if (!this.canAdmit) throw new Error('only people who may let others into this session can extend a chat link')
    const m = this.members.find((x) => x.chat && (x.key === who || x.name === who))
    if (!m) throw new Error(`no chat link called ${who}; it may have run out (make a new one)`)
    const r = await this.conn.adminRequest({ op: 'chatextend', key: m.key, minutes: Number(minutes) })
    return { name: r.name, expiresAt: r.expiresAt }
  }

  httpBase () {
    return this.server.replace(/^ws/, 'http').replace(/\/+$/, '')
  }

  /** Whether a message is meant for me: a well-formed one that is public, mine, or addressed to me. */
  canSee (msg) {
    return validMessage(msg) && (!msg.to || this.isMine(msg.to) || this.isMine(msg.by))
  }

  peerNames () {
    return this.status().peers.map((p) => p.name)
  }

  describeMessage (msg) {
    const out = { ...msg, unread: msg.by !== this.name && !this.readIds().has(msg.id) }
    if (msg.file && validMessage(msg)) {
      const local = this.inboxPath(msg)
      out.file = { ...msg.file, localPath: fs.existsSync(local) ? path.relative(this.root, local) : null }
    }
    return out
  }

  /** Messages visible to me, oldest first. */
  messages ({ limit = 50, unreadOnly = false, markRead = true, withName = null } = {}) {
    let list = this.chat.toArray().filter((m) => this.canSee(m))
    if (withName) list = list.filter((m) => m.by === withName || m.to === withName)
    let out = list.map((m) => this.describeMessage(m))
    if (unreadOnly) out = out.filter((m) => m.unread)
    out = out.slice(-limit)
    if (markRead) this.markRead(out.map((m) => m.id))
    return out
  }

  unreadCount () {
    const read = this.readIds()
    const list = this.chat.toArray().filter((m) => this.canSee(m))
    // A person's AI sessions writing to each other isn't shown in the chat, so it isn't unread either.
    const owners = aiOwners({ messages: list, people: [this.name, ...(this.members || []).map((m) => m && m.name)] })
    for (const p of this.personas.values()) owners.set(p.name, this.name)
    return list.filter((m) => m.by !== this.name && !read.has(m.id) && !ownAiChatter(m, owners)).length
  }

  readIds () {
    if (!this._read) {
      try { this._read = new Set(JSON.parse(fs.readFileSync(path.join(this.stateDir, 'read.json'), 'utf8'))) } catch { this._read = new Set() }
    }
    return this._read
  }

  markRead (ids) {
    const read = this.readIds()
    let changed = false
    for (const id of ids) if (!read.has(id)) { read.add(id); changed = true }
    if (!changed) return
    const live = new Set(this.chat.toArray().map((m) => m && m.id))
    for (const id of read) if (!live.has(id)) read.delete(id)
    try { fs.writeFileSync(path.join(this.stateDir, 'read.json'), JSON.stringify([...read])) } catch {}
    this.scheduleStatusWrite()
  }

  /** Asks the relay for a claim; it refuses overlaps with anyone else's. */
  async claim (pattern, note = '', via = null) {
    pattern = String(pattern ?? '').trim()
    if (!pattern) throw new Error('pattern required')
    await this.conn.claimRequest({ op: 'claim', pattern, note: String(note), ...this.as(via) })
    this.autoClaims.delete(pattern) // claimed by hand now: ours until we release it
    return { ok: true }
  }

  // --------------------------------------------------- claims follow edits --
  // Whatever tool made the change, a file we edit is claimed for us (so a partner's AI is refused
  // and told, instead of overwriting us), and let go when we are done: when our AI goes idle, when
  // the file has been quiet for a while, or when the session stops. Claims made on purpose
  // (quilt_claim, the app, `quilt claim`) are never touched here.

  /** An agent session, or a person whose AI is working or whose tool Quilt can't read: an edit is probably the AI's. */
  aiMayBeEditing () {
    return this.kind === 'agent' || this.agentState?.status !== 'idle' || this.work?.state === 'working'
  }

  autoClaim (rel) {
    const first = !this.autoClaims.has(rel)
    this.autoClaims.set(rel, Date.now())
    if (!first || !this.conn) return
    const note = this.focus ? `editing: ${this.focus}` : 'editing'
    this.conn.claimRequest({ op: 'claim', pattern: rel, note }).catch((err) => {
      // Lost the race to a partner, or an overlapping claim: their copy wins; ours is undone on the next sync.
      this.autoClaims.delete(rel)
      this.log(`could not claim ${rel} for you: ${err.message}`)
    })
  }

  /**
   * Releases the claims Quilt made for us. `only(rel, lastEdit)` picks which; all of them by default.
   * One someone is waiting for in its file queue is kept: our AI hands it off, with its context.
   */
  async releaseAutoClaims (only = () => true) {
    const done = []
    for (const [rel, ts] of this.autoClaims) {
      if (!only(rel, ts)) continue
      const c = this.claims.get(rel)
      if (c && this.ownClaim(c) && c.queue && c.queue.length) continue
      const via = this.autoVia.get(rel)
      this.autoClaims.delete(rel)
      this.autoVia.delete(rel)
      if (!c || !this.ownClaim(c) || !this.conn) continue
      done.push(this.conn.claimRequest({ op: 'release', pattern: rel, ...this.as(via) }).catch(() => {}))
    }
    await Promise.all(done)
    return done.length
  }

  releaseQuietAutoClaims () {
    if (!this.ready || this.stopped) return
    this.handOnForgotten().catch(() => {})
    const cutoff = Date.now() - this.autoClaimQuietMs
    this.releaseAutoClaims((rel, ts) => ts <= cutoff).then(() => {
      // "Working" that only an edit check said lapses with its files, so a commit isn't held up by an agent that never said done.
      if (this.workFromEdits && !this.autoClaims.size && this.work?.state === 'working' && Date.now() - (this.agentReportedAt || 0) >= this.autoClaimQuietMs) this.finishEditing().catch(() => {})
    }).catch(() => {})
  }

  /**
   * The check every agent makes before it changes files, whatever tool it runs in (the local
   * MCP's quilt_before_edit, or a Claude Code hook): for each path, whether it is ours to edit
   * (a file nobody holds is claimed for us, and let go like any claim that follows edits), and
   * what people said about those files in chat, as context. When no chat reader can see
   * our AI work, it is marked working, so the host doesn't commit under it.
   */
  async prepareEdit (paths, via = null) {
    const files = []
    const p0 = this.persona(via)
    for (const p of [...new Set((paths || []).map((x) => String(x || '').replace(/\\/g, '/').replace(/^\.\//, '')))]) {
      if (!p) continue
      if (!this.syncable(p)) { files.push({ path: p, shared: false }); continue }
      const held = (c) => ({ by: c.by, pattern: c.pattern, note: c.note || '', queue: c.queue || [] })
      // An AI session's files are its own: another session of this same person is refused too.
      const mine = (c) => p0 ? this.claimHeldBy(c, via) : c.by === this.name
      let c = this.claimFor(p)
      if (c && mine(c)) {
        if (this.autoClaims.has(p)) this.autoClaims.set(p, Date.now())
        files.push({ path: p, shared: true, ok: true, mine: true })
        continue
      }
      if (c) { files.push({ path: p, shared: true, ok: false, claim: held(c) }); continue }
      try {
        if (!this.conn) throw new Error('not connected')
        const focus = (p0 && p0.focus) || this.focus
        // A session still named after its tool takes a name from the first file it edits.
        if (p0 && !p0.named && labelFromFile(p)) this.renamePersona(via, labelFromFile(p), 'file')
        await this.conn.claimRequest({ op: 'claim', pattern: p, note: focus ? `editing: ${focus}` : 'editing', ...this.as(via) })
        this.autoClaims.set(p, Date.now())
        if (p0) this.autoVia.set(p, via)
        files.push({ path: p, shared: true, ok: true, claimed: true })
      } catch (err) {
        c = this.claimFor(p)
        files.push(c && !mine(c) ? { path: p, shared: true, ok: false, claim: held(c) } : { path: p, shared: true, ok: false, error: err.message })
      }
    }
    const chat = this.chatAbout(files.filter((f) => f.shared).map((f) => f.path))
    if (files.some((f) => f.claimed)) this.reportWorking(this.focus || '')
    return { me: p0 ? p0.name : this.name, files, chat }
  }

  /**
   * An agent said (over MCP) that it is at work. Unless a chat reader already sees it working,
   * it counts as working for commits and for claims that follow edits, until it says done or
   * goes quiet (nothing reported, no claimed file touched, for the quiet time).
   */
  reportWorking (note = '') {
    this.agentReportedAt = Date.now()
    if (this.agentState?.status === 'working' || this.work?.state === 'working') return
    this.setWork('working', note)
    this.workFromEdits = true
  }

  /**
   * What an agent shares about its work over MCP (quilt_share), for any tool: the request it
   * took, its plan or result, the files it changed. It reaches partners' feeds and opens or
   * extends an In progress task exactly like a chat Quilt reads itself. A tool whose chat
   * Quilt already reads is not shared twice.
   */
  shareAgentWork ({ tool = this.tool, request = '', summary = '', files = [] } = {}) {
    const label = String(tool || 'AI')
    if (this.agentState?.tool === label && this.agentState.status !== 'unavailable') return { shared: 0, automatic: true }
    const now = Date.now()
    const base = { tool: label, conv: `mcp-${label}`, ts: now }
    const nid = () => `mcp-${now}-${crypto.randomBytes(4).toString('hex')}`
    const entries = []
    const req = String(request || '').trim()
    const sum = String(summary || '').trim()
    if (req) entries.push({ ...base, id: nid(), kind: 'prompt', text: req.slice(0, 2000) })
    if (sum) entries.push({ ...base, id: nid(), kind: 'reply', text: sum.slice(0, 4000) })
    for (const f of (files || []).slice(0, 30)) {
      const p = String(f || '').replace(/\\/g, '/').replace(/^\.\//, '')
      if (p && !p.startsWith('..') && !path.isAbsolute(p)) entries.push({ ...base, id: nid(), kind: 'action', text: `Edited ${p}` })
    }
    if (!entries.length) return { shared: 0 }
    if (req) this.reportWorking(req.slice(0, 200))
    else this.agentReportedAt = now
    this.pushAgentEntries(entries, { shared: true })
    return { shared: entries.length }
  }

  /** What people said in chat lately about one of `paths` (duties.js): context for an agent about to edit them. */
  chatAbout (paths) {
    if (!paths.length) return []
    return chatAbout(paths, { messages: this.chat.toArray().filter((m) => this.canSee(m)), me: this.name })
  }

  /**
   * What this member owes before work moves on: direct messages and mentions not answered yet,
   * and files they hold that someone is waiting for in the file queue (`queued`, see duties.js).
   */
  duties (via = null) {
    const p = this.persona(via)
    const me = p ? [p.name, ...p.aliases] : this.name
    const pickup = this.pickupMode()
    return {
      me: p ? p.name : this.name,
      waiting: waitingOn(this.chat.toArray().filter((m) => this.canSee(m)), me, { agent: !!p || this.kind === 'agent', settled: this.settledIds }),
      queued: this.queued(via),
      pickup,
      next: nextTask(this.taskList(), { name: this.name, asAi: this.kind !== 'agent' }, pickup)
    }
  }

  /** Whether our AI picks up tasks by itself: "off", "mine" or "any" (Settings, read fresh so a change applies at once). */
  pickupMode () {
    if (this.aiTasks != null) return pickupMode(this.aiTasks)
    try { return pickupMode(getSettings().aiTasks) } catch { return 'off' }
  }

  // ------------------------------------------------------------ file queue --
  // A file someone else holds is asked for in its claim's queue, not taken; its holder hands it
  // on with their context when done (the relay keeps the queue, see server.js).

  /** Files we hold that someone is waiting for: [{ pattern, queue }]. */
  queued (via = null) {
    const p = this.persona(via)
    return p ? [p.name, ...p.aliases].flatMap((n) => queuedFor([...this.claims.values()], n)) : queuedFor([...this.claims.values()], this.name)
  }

  /** Asks for a file someone else holds. Resolves to { request, position, holder, pattern }. */
  async requestFile (file, { title = '', description = '', task = '', via = null } = {}) {
    const rel = String(file || '').replace(/\\/g, '/').replace(/^\.\//, '')
    if (!rel) throw new Error('path required')
    return this.conn.claimRequest({ op: 'request', path: rel, title: String(title), description: String(description), ...(task ? { task: String(task) } : {}), ...this.as(via) })
  }

  /** Hands a file we hold to someone waiting for it (the first, or `to`: a name or request id), with our context. */
  async handoff (file, { to = '', context = '', via = null } = {}) {
    const rel = String(file || '').replace(/\\/g, '/').replace(/^\.\//, '')
    const r = await this.conn.claimRequest({ op: 'handoff', pattern: rel, to: String(to || ''), context: String(context), ...this.as(via) })
    this.autoClaims.delete(r.pattern)
    this.autoVia.delete(r.pattern)
    return r
  }

  /** Takes back one of our requests. */
  async withdrawRequest (request, via = null) {
    const r = await this.conn.claimRequest({ op: 'withdraw', request: String(request || ''), ...this.as(via) })
    return r.withdrawn || 0
  }

  /**
   * We just changed a file someone is waiting for: our AI hears it with its next answer (once a
   * minute per file at most), so it hands the file on when done instead of forgetting them.
   */
  noteQueuedEdit (rel) {
    const c = this.claimFor(rel)
    if (!c || !this.ownClaim(c) || !c.queue || !c.queue.length) return
    const last = this.queueNoticed.get(c.pattern) || 0
    if (Date.now() - last < 60 * 1000) return
    this.queueNoticed.set(c.pattern, Date.now())
    this.notice(renderQueueNotice([{ pattern: c.pattern, queue: c.queue }]))
  }

  /**
   * Files Quilt claimed for our AI that someone waits for, which our AI stopped working on without
   * handing on: Quilt hands each to the first in its queue, with what it knows as context, so the
   * queue moves whatever tool the AI runs in (and whether or not it called quilt_handoff).
   * Stopped means: its chat reader says it is idle and the file has been quiet for handoffGraceMs,
   * or (no reader can see it) quiet for autoClaimQuietMs.
   */
  async handOnForgotten (now = Date.now()) {
    if (!this.conn || this.agentState?.status === 'working') return 0
    const seen = this.agentState?.tool && this.agentState.status === 'idle'
    const cutoff = now - (seen ? this.handoffGraceMs : this.autoClaimQuietMs)
    let handed = 0
    for (const [rel, ts] of [...this.autoClaims]) {
      if (ts > cutoff) continue
      const c = this.claims.get(rel)
      if (!c || !this.ownClaim(c) || !c.queue || !c.queue.length) continue
      const via = this.autoVia.get(rel) // claimed for one of our AI sessions
      const who = this.persona(via) ? this.actorName(via) : `${this.name}'s AI`
      const focus = (this.persona(via) && this.persona(via).focus) || this.focus
      const ago = Math.max(1, Math.round((now - ts) / 60000))
      const context = `Handed on by Quilt: ${who} stopped working on ${rel} without handing it on.` +
        `${focus ? ` It was working on: ${focus}.` : ''} Its last change was ${ago} minute${ago === 1 ? '' : 's'} ago; quilt_history shows what changed.`
      try {
        const r = await this.handoff(rel, { context, via })
        handed++
        this.notice(`Quilt handed ${rel} to ${r.to}, who was waiting for it, because you had stopped working on it. Ask for it again with quilt_request_file if you still need it.`)
        this.log(`🤝 handed ${rel} to ${r.to}: they were waiting and your AI had stopped`)
      } catch {}
    }
    return handed
  }

  /** Done with a piece of work: lets go of the claims that followed our edits and says we're done. */
  async finishEditing (via = null) {
    // One AI session finishing lets go of what was claimed for it; the others keep theirs.
    const released = await this.releaseAutoClaims(this.persona(via) ? (rel) => this.autoVia.get(rel) === via : () => true)
    if (this.work?.state === 'working') this.setWork('done')
    this.workFromEdits = false
    return { released }
  }

  /** Releases one of our claims, or all of them with '*'. Resolves to the number released. */
  async release (pattern = '*', via = null) {
    const r = await this.conn.claimRequest({ op: 'release', pattern: String(pattern), ...this.as(via) })
    return r.released || 0
  }

  /** The owner clears every claim held by someone who isn't in the session. Resolves to the number released. */
  async clearInactiveClaims () {
    const r = await this.conn.claimRequest({ op: 'clear-inactive' })
    return r.released || 0
  }

  /**
   * Why we can't reach the relay (e.g. no session pass), or null once that's fixed.
   * Logged once per new reason, not on every retry, and shown in status.
   */
  setRelayProblem (msg) {
    msg = msg || null
    if (msg === this.relayProblem) return
    this.relayProblem = msg
    if (msg) this.log(`⚠️ ${msg}. Retrying…`)
    this.emit('status-changed')
  }

  /** Takes the relay's claim list, logging what changed. */
  setClaims (list) {
    const next = new Map()
    for (const c of Array.isArray(list) ? list : []) if (c && typeof c.pattern === 'string' && typeof c.by === 'string') next.set(c.pattern, c)
    if (this.ready) {
      for (const [p, c] of next) {
        const was = this.claims.get(p)
        if (!this.ownClaim(c) && (!was || was.by !== c.by)) this.log(`🔒 ${c.by} claimed ${c.pattern}${c.note ? ` — ${c.note}` : ''}`)
      }
      for (const [p, c] of this.claims) if (!next.has(p) && !this.ownClaim(c)) this.log(`🔓 ${c.by} released ${p}`)
    }
    this.claims = next
    try { fs.writeFileSync(path.join(this.stateDir, 'claims.json'), JSON.stringify([...next.values()])) } catch {}
    if (this.ready) this.settleReleasedMerges()
    this.scheduleStatusWrite()
    this.emit('claims', [...next.values()])
  }

  /**
   * Our offline edits that waited only because someone held the file: once
   * they let go, combine them with the session's version, as an offline merge
   * would have. A clash stays open for the person to settle; so does a file
   * edited again since (the person is already on it).
   */
  settleReleasedMerges () {
    for (const rec of this.mergeList()) {
      if (rec.kind !== 'claimed' || rec.state !== 'open' || rec.by !== this.name || rec.binary || rec.oursDeleted || rec.theirsHash === null) continue
      if (this.mergeHeldBy(rec) || this.writeRefusal(rec.path) || this.merging.has(rec.path)) continue
      const theirs = this.sharedKey(rec.path)
      if (typeof theirs !== 'string' || theirs.startsWith('bin:')) continue
      const tried = `${rec.id}:${sha1(theirs)}`
      if (this.settleTried.has(tried)) continue
      this.settleTried.add(tried)
      const disk = this.readDisk(rec.path)
      if (!disk || disk.key !== theirs) continue
      const { ours, base } = this.mergeTexts(rec)
      if (typeof ours !== 'string') continue
      const holder = rec.claimedBy || rec.others[0] || 'someone'
      const { text, conflicts } = merge3(base || '', ours, theirs)
      if (conflicts.length) { this.log(`⚠️  ${holder} let go of ${rec.path}, but your changes clash with theirs: see Merges`); continue }
      try {
        this.applyMerged(rec.path, text, `with ${holder}'s changes, once they let go of it`)
        updateMerge(this.bdoc, this.merges, rec.id, { state: 'done', resolvedBy: this.name, reason: `Combined automatically once ${holder} let go of it` }, LOCAL)
      } catch (err) {
        this.log(`could not combine ${rec.path}: ${err.message}`)
        continue
      }
      this.log(`✅ ${holder} let go of ${rec.path}: your changes were combined with theirs`)
      if (this.catchUp?.mine?.conflicts.includes(rec.path)) {
        const m = this.catchUp.mine
        m.conflicts = m.conflicts.filter((p) => p !== rec.path)
        if (!m.merged.includes(rec.path)) m.merged.push(rec.path)
        this.saveCatchUp()
      }
    }
  }

  /** Last known claims, so they're enforced before the relay answers (or while offline). */
  loadClaims () {
    try {
      for (const c of JSON.parse(fs.readFileSync(path.join(this.stateDir, 'claims.json'), 'utf8'))) this.claims.set(c.pattern, c)
    } catch {}
  }

  /**
   * The claim that owns rel. The relay refuses overlapping claims, but a glob
   * pair can start overlapping once a new file matches both; every client
   * then picks the same owner: the earliest claim (ties broken by name, then
   * pattern).
   */
  claimFor (rel) {
    let owner = null
    for (const c of this.claims.values()) {
      if (!c || !globMatcher(c.pattern)(rel)) continue
      if (!owner || c.ts < owner.ts || (c.ts === owner.ts && (c.by < owner.by || (c.by === owner.by && c.pattern < owner.pattern)))) owner = c
    }
    return owner
  }

  // ------------------------------------------------------------ merges --

  mergeList () { return readMerges(this.merges) }

  /** Where this machine keeps a merge's base, ours and theirs (and PROMPT.md for Send to…). */
  mergeDir (id) { return path.join(this.stateDir, 'merges', id) }

  /** The three versions of a merge: from the record, or from this machine's merge folder when they were too big to share. */
  mergeTexts (rec) {
    const dir = this.mergeDir(rec.id)
    const local = (name) => { try { return fs.readFileSync(path.join(dir, name), 'utf8') } catch { return null } }
    const ours = rec.oursDeleted ? null : rec.ours ?? (rec.local ? local('ours') : null)
    const base = rec.base ?? (rec.local ? local('base') : null)
    const theirs = this.files.get(rec.path)?.toString() ?? null
    return { ours, base, theirs }
  }

  /**
   * Settles a merge: `mine` writes the returning person's version, `theirs`
   * keeps the session's, `hand` puts conflict markers in the file for someone
   * to edit (the record closes when the file next syncs without them),
   * `agent` and `review` just close it (the file is already as wanted).
   */
  resolveMerge (id, { how } = {}) {
    const rec = this.mergeList().find((m) => m.id === id)
    if (!rec) throw new Error('no such merge')
    if (rec.state === 'done') throw new Error('that merge is already settled')
    if (!['mine', 'theirs', 'hand', 'agent', 'review'].includes(how)) throw new Error('say how: mine, theirs, hand, agent or review')
    // A record anyone can write names any path: never touch one the session doesn't sync (.env, .git, ignored files).
    if (!this.syncable(rec.path) && how !== 'agent' && how !== 'review') throw new Error(`${rec.path} is not synced in this session, so Quilt will not write it`)
    // The doc holds the markers now, so "theirs" would be marker text.
    if (rec.state === 'editing' && (how === 'theirs' || how === 'hand')) throw new Error(STILL_MARKED)
    // Settling is an edit of the session: viewers (and agents outside their folders) only see the record.
    const refusal = this.writeRefusal(rec.path)
    if (refusal) throw new Error(refusal)
    if (how === 'mine' || how === 'hand') this.mergeHeldCheck(rec)
    const onlyThere = () => new Error(`${rec.by === this.name ? 'your' : `${rec.by}'s`} version of ${rec.path} is only in the merge folder on ${rec.by === this.name ? 'the computer you merged on' : 'their computer'}`)
    const { ours, base, theirs } = this.mergeTexts(rec)
    if (how === 'mine') {
      let data = null // null: deleted while away, so keeping mine deletes it in the session too
      if (!rec.oursDeleted) {
        // Binary versions never go in the record: only the opener's machine has ours.
        data = ours
        if (rec.binary) {
          try { data = fs.readFileSync(path.join(this.mergeDir(rec.id), 'ours')) } catch {}
        }
        if (data === null) throw onlyThere()
      }
      this.keepMine(rec.path, data)
    } else if (how === 'theirs') {
      this.tryWrite(rec.path)
    } else if (how === 'hand') {
      if (!rec.binary && !rec.oursDeleted && ours === null) throw onlyThere()
      if (rec.binary || ours === null || theirs === null) throw new Error('markers only work when both sides have a text version: keep mine or keep theirs instead')
      this.applyMerged(rec.path, withMarkers(base || '', ours, theirs, { mine: rec.by, theirs: rec.others[0] || 'session' }), 'with conflict markers to edit by hand')
      return updateMerge(this.bdoc, this.merges, id, { state: 'editing', how: 'hand', resolvedBy: this.name }, LOCAL)
    }
    const out = updateMerge(this.bdoc, this.merges, id, { state: 'done', how, resolvedBy: this.name }, LOCAL)
    this.log(`✅ ${rec.path}: merge settled (${how === 'mine' ? `${rec.by}'s version` : how === 'theirs' ? "the session's version" : how === 'agent' ? 'merged by an AI' : 'reviewed'})`)
    this.scheduleStatusWrite()
    return out
  }

  /**
   * Keep mine: the disk first, then the doc, so a failed write never leaves
   * the session with ours while the record stays open. `data` null deletes.
   */
  keepMine (rel, data) {
    if (this.merging.has(rel) || this.downloading.has(rel)) throw new Error(`${rel} is still syncing; try again in a moment`)
    const abs = resolveInside(this.root, rel)
    if (data === null) {
      fs.rmSync(abs, { force: true })
      removeEmptyParents(this.root, path.dirname(abs))
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      this.writeFile(rel, abs, data)
    }
    this.writeFailed.delete(rel) // the disk now holds a version we chose, not a stale one
    if (this.ingest(rel)) return
    // Nothing pushed: fine if the session already has it, or a large file is on its way up.
    const want = data === null ? undefined : Buffer.isBuffer(data) ? `bin:${sha1(data)}` : data
    if (this.sharedKey(rel) === want || (Buffer.isBuffer(data) && this.uploading.get(rel) === sha1(data))) return
    throw new Error(`could not share ${rel}; the merge stays open`)
  }

  /** Who else holds a merge's file right now, or null: settling it (or sending it to an AI) writes the file. */
  mergeHeldBy (rec) {
    const claim = this.claimFor(rec.path)
    return claim && !this.ownClaim(claim) ? claim : null
  }

  mergeHeldCheck (rec) {
    const claim = this.mergeHeldBy(rec)
    if (claim) throw new Error(`${rec.path} is claimed by ${claim.by}${claim.note ? ` (${claim.note})` : ''}. Ask ${claim.by} for it to merge the two, or keep ${claim.by}'s version.`)
  }

  /** A merge as status shows it: without its texts, with who holds the file and whether we asked for it. */
  mergeStatus ({ ours, base, ...m }) {
    const claim = m.state === 'done' ? null : this.mergeHeldBy(m)
    return claim ? { ...m, heldBy: claim.by, asked: (claim.queue || []).some((r) => r.by === this.name) } : m
  }

  /** A file being edited by hand lost its markers: that merge is settled. */
  closeHandMerge (rel, text) {
    const rec = this.mergeList().find((m) => m.path === rel && m.state === 'editing')
    if (!rec || hasMarkers(text)) return
    updateMerge(this.bdoc, this.merges, rec.id, { state: 'done', how: 'hand', resolvedBy: this.name }, LOCAL)
    this.log(`✅ ${rel}: merged by hand`)
  }

  /** What a coding tool is asked to do for Send to…: names the three files, the path and the merge id. */
  mergePromptFor (rec) {
    const dir = path.relative(this.root, this.mergeDir(rec.id)).split(path.sep).join('/')
    const other = rec.others[0] || 'someone in the session'
    return `Merge conflict in \`${rec.path}\` (Quilt merge ${rec.id}).

${rec.by} changed this file while away from the session; meanwhile ${other} changed it in the session. Quilt could not combine the two on its own. Please merge them:

- \`${dir}/base\`: the version both started from
- \`${dir}/ours\`: ${rec.by}'s version (offline)${rec.oursDeleted ? ' — deleted' : ''}
- \`${dir}/theirs\`: the session's version (${other})${rec.theirsHash === null ? ' — deleted' : ''}
- \`${rec.path}\`: currently the session's version

Write the merged result to \`${rec.path}\`, keeping every change from both sides and changing no behaviour. If the two really cannot both be true, say so and ask ${rec.by} and ${other} in the chat (quilt_message) rather than picking one.
When the file is right, call the \`quilt_resolve_merge\` tool with id \`${rec.id}\` and how \`agent\` (or tell the person to click Resolved in Quilt).
`
  }

  /** Writes the three versions and PROMPT.md for a tool to work from; returns the prompt. */
  prepareMergeSend (id) {
    const rec = this.mergeList().find((m) => m.id === id)
    if (!rec) throw new Error('no such merge')
    if (rec.state === 'editing') throw new Error(STILL_MARKED)
    // The prompt asks a tool to write rec.path: never one the session doesn't sync.
    if (!this.syncable(rec.path)) throw new Error(`${rec.path} is not synced in this session, so Quilt will not send it`)
    this.mergeHeldCheck(rec)
    const dir = this.mergeDir(id)
    fs.mkdirSync(dir, { recursive: true })
    const { ours, base, theirs } = this.mergeTexts(rec)
    // base and ours never change; theirs is rewritten, as the session may have moved on.
    const put = (name, text) => { if (text !== null && !fs.existsSync(path.join(dir, name))) fs.writeFileSync(path.join(dir, name), text) }
    put('base', base)
    put('ours', ours)
    if (theirs !== null) fs.writeFileSync(path.join(dir, 'theirs'), theirs)
    const prompt = this.mergePromptFor(rec)
    fs.writeFileSync(path.join(dir, 'PROMPT.md'), prompt)
    return { prompt, dir }
  }

  // ------------------------------------------------------------ AI feed --

  /**
   * Opens or extends a shared task when this person's AI edits files for a
   * request that is not already on the board. Failures stay out of the feed.
   */
  noteAgentWork (entries, { shared = false } = {}) {
    // Paused for AI chats Quilt reads; work an agent shares itself (quilt_share) still goes on the board.
    if (!this.autoTasks && !shared) return
    let ops = []
    try {
      ops = planAutoTask({
        entries,
        tasks: this.taskList(),
        prompts: this.agentPrompts,
        now: Date.now(),
        me: this.name,
        sharing: this.agentSharing
      })
    } catch (err) {
      this.log(`could not read an AI chat for tasks: ${err.message}`)
      return
    }
    for (const op of ops) {
      try {
        if (op.update) this.updateTask(op.update)
        else if (op.create) {
          const task = this.addTask({
            title: op.create.title,
            assignee: this.name,
            forAi: true,
            tool: op.create.tool || this.tool,
            files: op.create.files,
            column: 'doing',
            conv: op.create.conv
          })
          this.log(`📋 task from your AI chat: ${task.title}`)
          this.retitleTask(task, op.create.request, op.create.files)
        }
      } catch (err) {
        this.log(`could not add a task from your AI chat: ${err.message}`)
      }
    }
  }

  /**
   * Swaps an auto task's stand-in title for a short one ("Add dark mode") once
   * `taskTitler` answers, unless someone renamed or removed the task meanwhile.
   */
  async retitleTask (task, request, files) {
    if (!this.taskTitler || !request) return
    const title = await this.taskTitler(request, files).catch(() => null)
    if (!title || title === task.title) return
    const now = this.taskList().find((t) => t.id === task.id)
    if (!now || now.title !== task.title) return
    try { this.updateTask({ id: task.id, title }) } catch {}
  }

  /** Adds entries from this person's AI chat reader. Dedupes by id, keeps the newest 300 per person. */
  pushAgentEntries (entries, { shared = false } = {}) {
    if (!entries || !entries.length) return 0
    this.noteAgentWork(entries, { shared })
    if (!this.agentSharing) return 0
    if (this.summarizer) {
      // Summaries take a moment; keep batches in order.
      const batch = entries
      this.summaryQueue = this.summaryQueue.then(async () => {
        const out = await Promise.all(batch.map(async (e) => {
          if (!e || (e.kind !== 'prompt' && e.kind !== 'reply')) return e
          const s = await this.summarizer(e.kind, e.text).catch(() => ({ text: e.text, how: 'as-is' }))
          return s.how === 'as-is' ? e : { ...e, text: s.text, summary: s.how }
        }))
        if (this.agentSharing) this.shareAgentEntries(out)
      })
      return entries.length
    }
    return this.shareAgentEntries(entries)
  }

  shareAgentEntries (entries) {
    if (!this.mayTalk()) return 0
    const indexById = new Map()
    this.agentFeed.forEach((e, i) => { if (e && e.by === this.name && e.id) indexById.set(e.id, i) })
    const fresh = []
    const replacements = []
    for (const e of entries) {
      if (!e || !e.id) continue
      const id = String(e.id)
      const text = String(e.text || '')
      const existing = indexById.get(id)
      if (existing != null) {
        const cur = this.agentFeed.get(existing)
        // A later read can clean text that was already shared (same id). Leave summaries alone.
        if (cur && !cur.summary && cur.text !== text) replacements.push({ index: existing, entry: { ...cur, text } })
        continue
      }
      indexById.set(id, -1)
      fresh.push({ id, by: this.name, tool: e.tool || null, conv: e.conv || null, kind: e.kind, text, ts: e.ts || Date.now(), ...(e.summary ? { summary: e.summary } : {}) })
    }
    if (!fresh.length && !replacements.length) return 0
    this.doc.transact(() => {
      for (const r of replacements.sort((a, b) => b.index - a.index)) {
        this.agentFeed.delete(r.index, 1)
        this.agentFeed.insert(r.index, [r.entry])
      }
      if (fresh.length) {
        this.agentFeed.push(fresh)
        this.trimAgentFeed()
      }
    }, LOCAL)
    return fresh.length + replacements.length
  }

  trimAgentFeed (cap = AGENT_FEED_CAP) {
    const idx = []
    this.agentFeed.forEach((e, i) => { if (e && e.by === this.name) idx.push(i) })
    const extra = idx.length - cap
    // Delete from the end backwards so earlier indexes stay valid.
    for (let k = extra - 1; k >= 0; k--) this.agentFeed.delete(idx[k], 1)
  }

  /** Turns sharing of your AI chat on or off, leaving a marker in the feed. */
  setAgentSharing (on) {
    on = !!on
    // Sharing your AI chat posts it to the feed: not for someone who may not post.
    if (on && !this.mayTalk()) throw new Error(TALK_REFUSED)
    if (on === this.agentSharing) return on
    const marker = { id: `${on ? 'resumed' : 'paused'}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, by: this.name, tool: null, conv: null, kind: on ? 'resumed' : 'paused', text: '', ts: Date.now() }
    if (this.mayTalk()) {
      this.doc.transact(() => {
        this.agentFeed.push([marker])
        this.trimAgentFeed()
      }, LOCAL)
    }
    this.agentSharing = on
    this.publishAgentState()
    this.saveConfig({ shareAgent: on })
    this.scheduleStatusWrite()
    return on
  }

  /** Turns summaries of your AI chat on or off for this folder (remembered). */
  setSummarize (fn) {
    this.summarizer = fn || null
    this.saveConfig({ summarize: !!fn })
    this.publishAgentState()
    this.scheduleStatusWrite()
    return !!fn
  }

  saveConfig (patch) {
    try {
      const file = path.join(this.stateDir, 'config.json')
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
      writePrivateJson(file, { ...cfg, ...patch })
    } catch {}
  }

  /** Live status from the AI chat reader ("working", "idle", "unavailable"). */
  setAgentState (state) {
    const was = this.agentState?.status
    this.agentState = state ? { tool: state.tool || null, status: state.status || 'idle', ...(state.reason ? { reason: state.reason } : {}), ...(state.notes ? { notes: state.notes } : {}) } : null
    this.publishAgentState()
    // Our AI finished its turn: the files Quilt claimed for it while it worked are free again.
    if (was === 'working' && this.agentState?.status !== 'working' && this.autoClaims.size) this.releaseAutoClaims().catch(() => {})
  }

  publishAgentState () {
    if (!this.conn) return
    const st = this.agentState || { tool: null, status: 'idle' }
    // While paused, partners only learn that sharing is off, not whether you're working.
    const shared = this.agentSharing && this.mayTalk() ? { ...st, sharing: true, ...(this.summarizer ? { summarized: true } : {}) } : { tool: st.tool, status: 'idle', sharing: false }
    this.conn.awareness.setLocalStateField('agent', shared)
  }

  /** One person's AI feed, oldest first. */
  agentFeedFor (name, { limit = AGENT_FEED_CAP } = {}) {
    return this.agentFeed.toArray().filter((e) => e && e.by === name).slice(-limit)
  }

  // ---------------------------------------------------------- shared files --

  /**
   * Every shared path with who last edited it (from activity and live
   * presence) and the claim covering it. Read from the shared doc.
   */
  tree () {
    const edited = new Map()
    const note = (p, by, ts) => {
      const cur = edited.get(p)
      if (!cur || ts > cur.ts) edited.set(p, { by, ts })
    }
    for (const a of this.activity) if (a && a.path && a.kind !== 'deleted') note(a.path, a.by, a.ts)
    const states = this.conn ? this.conn.awareness.getStates() : new Map()
    for (const [id, st] of states) {
      if (!st || !st.name) continue
      const editing = id === this.doc.clientID ? Object.fromEntries(this.myEdits) : (st.editing || {})
      for (const [p, ts] of Object.entries(editing)) note(p, st.name, ts)
    }
    // `active` is false when whoever holds it isn't in the session (older relays don't say: active).
    const shown = (c) => ({ by: c.by, ...(typeof c.byId === 'string' ? { byId: c.byId } : {}), pattern: c.pattern, note: c.note, ts: c.ts, active: c.active !== false, ...(typeof c.activeAt === 'number' ? { activeAt: c.activeAt } : {}), queue: Array.isArray(c.queue) ? c.queue.map((r) => ({ id: r.id, path: r.path, by: r.by, title: r.title, description: r.description || '', task: r.task || '', ts: r.ts })) : [] })
    const claimFor = (p) => {
      const c = this.claimFor(p)
      return c ? shown(c) : null
    }
    const out = []
    for (const p of this.sharedPaths()) {
      if (!isSafeRelPath(p)) continue
      const blob = this.blobs.get(p)
      out.push({ path: p, binary: !!blob && !this.files.has(p), edited: edited.get(p) || null, claim: claimFor(p) })
    }
    out.sort((a, b) => a.path.localeCompare(b.path))
    return {
      files: out,
      // Claims on folders or globs that don't match a file yet still show up.
      claims: [...this.claims.values()].map(shown)
    }
  }

  /** Contents of one shared file, straight from the shared doc (never from disk). */
  readShared (rel) {
    rel = String(rel || '').replace(/^\.\//, '')
    if (!isSafeRelPath(rel)) return null
    const t = this.files.get(rel)
    if (t) return { path: rel, text: t.toString() }
    const b = this.blobs.get(rel)
    if (b) return { path: rel, binary: true, size: b.size ?? (Math.floor(b.data.length * 3 / 4) - (b.data.endsWith('==') ? 2 : b.data.endsWith('=') ? 1 : 0)) }
    return null
  }

  status () {
    const now = Date.now()
    const states = this.conn ? this.conn.awareness.getStates() : new Map()
    const peers = []
    for (const [id, s] of states) {
      if (id === this.doc.clientID || !s || !s.name) continue
      peers.push({
        name: s.name,
        tool: s.tool,
        color: s.color,
        kind: s.kind || 'human',
        agent: s.agent || null,
        agents: s.agents || [],
        work: s.work || null,
        focus: s.focus || '',
        editing: Object.entries(s.editing || {})
          .sort((a, b) => b[1] - a[1])
          .map(([p, ts]) => ({ path: p, secondsAgo: Math.round((now - ts) / 1000) })),
        git: cleanGit(s.git)
      })
    }
    // AI sessions working through someone's app (persona.js) are members of their own here,
    // ours included (so the person can write to one of their own sessions).
    for (const [id, s] of states) {
      if (!s || !s.name || !Array.isArray(s.personas)) continue
      for (const x of s.personas) {
        if (!x || typeof x.name !== 'string' || !x.name || peers.some((p) => p.name === x.name)) continue
        peers.push({ name: x.name.slice(0, 80), tool: typeof x.tool === 'string' ? x.tool.slice(0, 40) : '', kind: 'agent', persona: true, of: s.name, ...(id === this.doc.clientID ? { mine: true } : {}), agent: null, agents: [], work: null, focus: typeof x.focus === 'string' ? x.focus.slice(0, 200) : '', editing: [] })
      }
    }
    // Agents working over HTTP (the hosted MCP, chat links) have no live connection, so no
    // presence: the relay marks them online for a few minutes after each call instead.
    for (const m of this.members) {
      if (m.online && m.kind === 'agent' && m.name !== this.name && !peers.some((p) => p.name === m.name)) {
        peers.push({ name: m.name, tool: '', kind: 'agent', hosted: true, ...(m.lastSeen ? { lastSeen: m.lastSeen } : {}), agent: null, agents: [], work: null, focus: '', editing: [] })
      }
    }
    return {
      room: this.room,
      server: this.server,
      branch: this.branch,
      connected: !!(this.conn && this.conn.connected),
      ...(this.relayProblem ? { problem: this.relayProblem } : {}),
      access: this.access,
      sessionName: this.sessionName,
      members: this.members,
      ...(this.canAdmit ? { waiting: this.waiting } : {}),
      admitBy: this.access?.admitBy || this.admitBy || 'owner',
      me: {
        name: this.name,
        tool: this.tool,
        kind: this.kind,
        focus: this.focus,
        agents: [...this.agents],
        color: this.conn?.awareness.getLocalState()?.color,
        agent: { ...(this.agentState || { status: 'idle' }), sharing: this.agentSharing, summarized: !!this.summarizer },
        work: this.work
      },
      peers,
      claims: [...this.claims.values()].sort((a, b) => a.ts - b.ts),
      commits: [...this.commitRequests.values()].sort((a, b) => a.ts - b.ts),
      tasks: this.taskList(),
      // Without the texts (up to 400 KB a record): status goes out on every
      // change. The full records are at GET /merges and the app's merges route.
      merges: this.mergeList().map((m) => this.mergeStatus(m)),
      catchUp: this.catchUp,
      activity: this.activity.toArray().slice(-30),
      changes: this.changes().people.map((p) => ({ ...p, files: p.files.slice(0, 10), pulled: p.pulled && { ...p.pulled, files: p.pulled.files.slice(0, 10) } })),
      chat: this.messages({ limit: 20, markRead: false }),
      unread: this.unreadCount(),
      fileCount: this.files.size + this.blobs.size,
      git: this.git ? { branch: this.git.branch, key: this.git.key, hold: this.hold ? { kind: this.hold.kind, since: this.hold.since, to: this.hold.to || null, conflict: this.hold.conflict || null } : null, pull: this.pull, upstream: this.upstream, repo: this.repo } : null,
      branches: branchBoard([{ name: this.name, git: this.gitSummary() }, ...peers.map((p) => ({ name: p.name, git: p.git, persona: !!p.persona }))])
    }
  }

  scheduleStatusWrite () {
    if (this.statusTimer || !this.ready) return
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      this.emit('status-changed')
    }, 300)
  }

  async stop () {
    for (const w of this.pullWait.values()) clearTimeout(w.timer)
    this.ready = false
    clearInterval(this.autoClaimTimer)
    clearInterval(this.personaTimer)
    if (this.autoClaims.size && this.conn && !this.stopped) {
      await Promise.race([this.releaseAutoClaims(), new Promise((r) => setTimeout(r, 2000))])
    }
    this.stopped = true
    clearInterval(this.retryTimer)
    if (this.watcher) await this.watcher.close()
    for (const t of this.rechecks.values()) clearTimeout(t)
    this.rechecks.clear()
    clearInterval(this.reconcileTimer)
    clearInterval(this.upstreamPoll)
    clearTimeout(this.upstreamTimer)
    if (this.gitWatcher) await this.gitWatcher.close()
    this.flushPending()
    clearTimeout(this.settleTimer)
    clearTimeout(this.statusTimer)
    clearTimeout(this.presenceTimer)
    if (this.conn) this.conn.close()
    this.saveState()
    await new Promise((r) => setTimeout(r, 100))
  }
}

export function formatMessage (m) {
  const head = m.to ? `${m.by} → ${m.to} (direct)` : m.by
  const file = m.file ? ` 📎 ${m.file.name} (${formatBytes(m.file.size)})` : ''
  return `${head}: ${m.text}${file}`
}

/**
 * Storage refused an upload because that file is already there: as good as
 * done, since ids come from the content. The relay's disk answers 409;
 * Supabase answers 400 or 409 saying the object already exists.
 */
async function alreadyStored (res) {
  if (res.status !== 409 && res.status !== 400) return false
  if (res.status === 409) return true
  const body = await res.text().catch(() => '')
  return /exists|duplicate/i.test(body)
}

// Message and file ids as quilt makes them (8 and 16 random bytes in hex).
const HEX_ID = /^[0-9a-f]{8,64}$/i

/**
 * A chat message a well-behaved client made: its id, and its file's id, are
 * hex, so they're safe in a file name and in a URL. Anything else (a
 * modified client can push any object) is skipped everywhere.
 */
function validMessage (m) {
  if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !HEX_ID.test(m.id)) return false
  if (m.file == null) return true
  return typeof m.file === 'object' && typeof m.file.id === 'string' && HEX_ID.test(m.file.id)
}

function safeName (name) {
  const base = path.basename(String(name)).replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '')
  return base.slice(0, 120) || 'file'
}

function hashCode (s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

function removeEmptyParents (root, dir) {
  while (dir.startsWith(root + path.sep)) {
    try { fs.rmdirSync(dir) } catch { return }
    dir = path.dirname(dir)
  }
}

/** How many lines `text` has (a final newline does not start another). */
function lineCount (text) {
  if (!text) return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}
