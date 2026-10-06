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
import { readTasks, addTask as putTask, updateTask as patchTask, deleteTask as dropTask, planAutoTask } from './tasks.js'
import { HistoryLog, queryHistory, parseSince, currentTask } from './history.js'
import { Inbox } from './inbox.js'
import { chatAbout, waitingOn, queuedFor, renderQueueNotice, askForIt } from './duties.js'
import { makeSubscription, deliverEvents } from './webhooks.js'
import { pickChecklist } from './agent-task-workflow.js'
import { changeRefusal, TALK_REFUSED } from './session-access.js'
import { canAdmit } from './admit-policy.js'
import { merge3, withMarkers, hasMarkers } from './merge3.js'
import { aiMerge, findMergeCli } from './merge-ai.js'
import { openMerge, updateMerge, readMerges, pruneMerges, cleanName } from './merges.js'
import { ensureQuiltIgnored } from './gitignore.js'
import { gitDir, headKey, headRef, gitRuns, askTwice, lastCallTimedOut, busy as gitBusy, leftoverLock, STALE_LOCK_MS, indexStamp, classify, filesAt, changesBetween, commitsBetween, treeState, branchTip, watchGit, unmergedPaths, stashStamp, upstreamAdds, pullState, SETTLE_MS, BURST_PATHS } from './gitstate.js'

export { applyTextDiff }

const LOCAL = Symbol('local')
const STILL_MARKED = 'this file has conflict markers in it; finish editing it (or choose Keep mine) first'
const COLORS = ['#b9432b', '#3b6a9a', '#4a7a45', '#855a9c', '#a8701c', '#2e7a80', '#9c4f6b']
const RECENT_MS = 2 * 60 * 1000
const AGENT_FEED_CAP = 300
const AUTO_CLAIM_QUIET_MS = 5 * 60 * 1000 // a file we stopped editing this long ago is let go of
const NOTICE_CAP = 20
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

export class Session extends EventEmitter {
  constructor ({ dir, server, room, secret, key = '', viewSecret = '', name, tool = 'unknown', color = null, prefer = 'remote', kind = 'human', shareAgent = true, summarize = null, identity = null, passes = null, startName = '', autoClaimQuietMs = AUTO_CLAIM_QUIET_MS, webhookTransport = null, pullWaitMs = PULL_WAIT_MS }) {
    super()
    this.pullWaitMs = pullWaitMs
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

    this.doc = new Y.Doc()
    this.files = this.doc.getMap('files') // path -> Y.Text
    this.blobs = this.doc.getMap('blobs') // path -> { hash, data(base64) } or { hash, size, stored: { id, key } }
    // keyId -> { wraps, ts }: file keys for large files, each wrapped for editors and viewers.
    this.fileKeys = this.doc.getMap('fileKeys')
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
    // The chronology: every change with its diff and the task it was for (src/history.js).
    this.history = new HistoryLog(this.doc, this.doc.getArray('history'), { origin: LOCAL })
    // "<name>\0<path>" -> { by, path, added, removed, edits, kind, ts }: what each
    // person has changed in this room, every edit counted. Each person writes
    // only their own keys, so there is nothing to merge.
    this.tallies = this.doc.getMap('changes')
    this.agentFeed = this.doc.getArray('agentFeed') // { id, by, tool, conv, kind, text, ts }
    this.commitRequests = this.doc.getMap('commitRequests') // id -> { id, by, message, ts, state: 'open'|'done', doneBy, hash }
    this.tasks = this.doc.getMap('tasks') // id -> { id, title, column, by, assignee, forAi, tool, files, conv, order, ts }
    // Mentions, direct messages and tasks handed to this member (or their AI), for agents to wake on.
    this.inboxTracker = new Inbox()
    // The agent's webhook subscription (webhooks.js), kept in .quilt/webhook.json: inbox events are POSTed there.
    this.webhook = null
    this.webhookTransport = webhookTransport // { fetch, delays } for tests
    this.webhookSending = Promise.resolve()
    this.agentPrompts = new Map() // conv -> latest prompt line, so an edit can be titled after the question that started it
    this.merges = this.doc.getMap('merges') // id -> merge record (see merges.js)
    this.merging = new Set() // paths held out of normal sync until their offline merge has run
    this.mergeCliMissing = false // logged once per session
    this.work = null // { state: 'working'|'done', note, ts }: what an agent says it's doing
    // Claims follow edits (see autoClaim): path -> when this person last changed it. Released when
    // their AI goes idle, when the file has been quiet for autoClaimQuietMs, and at stop.
    this.autoClaims = new Map()
    this.queueNoticed = new Map() // claim pattern -> when our AI was last told someone waits for it
    this.autoClaimQuietMs = autoClaimQuietMs
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
      doc: this.doc,
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
    this.conn.on('claims', (list) => this.setClaims(list))
    this.conn.on('access', (a) => this.setAccess(a))
    this.conn.on('members', (m) => this.setMembers(m))
    this.setupPresence()

    if (hadState) {
      // We've synced this folder before: hold what was edited while we were
      // away, let the relay tell us what the others did, then merge the two.
      // Restarted on another branch, or mid-hold: nothing in this tree is the session's offline work.
      const resumed = this.resumeHold()
      if (gitUnreadable) this.saysGitUnreadable(resumed)
      const offline = resumed ? { entries: [], take: [], downloads: [] } : this.captureOffline()
      this.goLive()
      if (offline.entries.length) this.log(`${offline.entries.length} file(s) changed while you were away; merging once the relay has synced…`)
      const synced = this.conn.waitForSync()
      synced.then(() => this.mergeOffline(offline)).catch((err) => {
        // Never synced (the relay refused us): nothing can be merged, so nothing stays held.
        for (const e of offline.entries) this.merging.delete(e.rel)
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
            this.reconcileFirstJoin()
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
      this.reconcileFirstJoin()
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
      this.scanInbox({ quiet: tr.origin === LOCAL })
      this.scheduleStatusWrite()
    })
    this.activity.observe(() => this.scheduleStatusWrite())
    this.tasks.observe((ev, tr) => {
      this.scanInbox({ quiet: tr.origin === LOCAL })
      this.scheduleStatusWrite()
    })
    this.commitRequests.observe((ev, tr) => {
      for (const [id, change] of ev.changes.keys) {
        const r = this.commitRequests.get(id)
        if (tr.origin === LOCAL || !r) continue
        if (change.action === 'add') this.log(`📌 ${r.by} asked for a commit: ${r.message}`)
        else if (r.state === 'done') this.log(`✅ ${r.doneBy || 'the host'} committed ${r.hash ? r.hash.slice(0, 7) : ''} (${r.message})`)
      }
      this.emit('status-changed')
    })
    this.merges.observe(() => { this.scheduleStatusWrite(); this.emit('merges', this.mergeList()) })
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

  // ---------------------------------------------------------------- state --

  loadState () {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(this.stateDir, 'state.json'), 'utf8'))
      if (meta.room !== this.room || meta.server !== this.server) return false
      Y.applyUpdate(this.doc, fs.readFileSync(this.stateFile), LOCAL)
      this.storedOnDisk = new Map(Object.entries(meta.storedOnDisk || {}))
      this.known = meta.known ? new Map(Object.entries(meta.known)) : null
      // No gitKey (an older state file): taken as the branch the folder is on now.
      this.savedRole = typeof meta.role === 'string' ? meta.role : null
      this.savedGit = typeof meta.gitKey === 'string' && meta.gitKey ? { key: meta.gitKey, sha: typeof meta.gitSha === 'string' ? meta.gitSha : null, held: !!meta.gitHeld } : null
      return true
    } catch {
      return false
    }
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
    const tmp = this.stateFile + '.tmp'
    fs.writeFileSync(tmp, Y.encodeStateAsUpdate(this.doc))
    fs.renameSync(tmp, this.stateFile)
    // Hashes of what we last wrote or read for each path: on the next start they
    // tell a file the room changed behind our back from one edited offline.
    const known = {}
    for (const [rel, key] of this.lastKnown) known[rel] = sha1(key)
    fs.writeFileSync(path.join(this.stateDir, 'state.json'), JSON.stringify({ room: this.room, server: this.server, storedOnDisk: Object.fromEntries(this.storedOnDisk), known, ...this.gitState(), ...this.roleState() }))
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
    if (this.stopped) { for (const e of entries) this.merging.delete(e.rel); return } // the next start captures them again
    const counts = { pushed: 0, merged: 0, ai: 0, conflict: 0 }
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
          if (this.stopped) continue // it may have stopped part way: keep its base
          held.delete(e.rel)
        } catch (err) {
          this.merging.delete(e.rel)
          this.log(`could not merge ${e.rel}: ${err.message}`)
          if (this.setAside(e.rel)) held.delete(e.rel) // ours is in .quilt/conflicts: nothing left to merge
          counts.conflict++
        }
        this.saveHeldBases([...held.values()])
      }
    }
    await Promise.all([worker(), worker()])
    for (const e of entries) this.merging.delete(e.rel)
    if (this.stopped) return // merging.json keeps what's left, for the next start
    // After the merges, not before: a take write can create a folder where a
    // file deleted offline was, and that deletion must be shared first.
    for (const rel of take) this.tryWrite(rel)
    for (const rel of downloads) {
      const b = this.blobs.get(rel)
      if (b && b.stored) this.downloadLarge(rel, b) // the session may have deleted or replaced it meanwhile
    }
    pruneMerges(this.doc, this.merges, LOCAL)
    const parts = []
    if (counts.pushed) parts.push(`${counts.pushed} shared`)
    if (counts.merged) parts.push(`${counts.merged} merged`)
    if (counts.ai) parts.push(`${counts.ai} merged by AI (have a look)`)
    if (counts.conflict) parts.push(`${counts.conflict} need${counts.conflict === 1 ? 's' : ''} merging`)
    if (parts.length) this.log(`${counts.conflict ? '⚠️ ' : '✅ '}your offline changes: ${parts.join(', ')}`)
    this.emit('merges', this.mergeList())
    this.scheduleStatusWrite()
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
    const claimedByOther = claim && claim.by !== this.name
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
    const cli = findMergeCli()
    if (!cli && !this.mergeCliMissing) {
      this.mergeCliMissing = true
      this.log('overlapping changes go straight to merge conflicts: no AI tool (claude, codex or cursor-agent) is installed to merge with')
    }
    const ai = await aiMerge({ path: rel, base: base || '', ours, theirs, mine: this.name, theirsBy, cli })
    // Stopped while the AI ran: leave the disk and the doc alone; the next start merges it again.
    if (this.stopped) { release(); return null }
    // The AI merged the version it was shown. If the session changed it again
    // meanwhile, applying that merge would undo those edits: a person decides.
    const now = this.sharedKey(rel)
    if (ai.text && now === theirs) {
      // The AI can take a while: if the file changed again meanwhile, keep that copy before replacing it.
      const onDisk = this.readDisk(rel)
      if (onDisk && onDisk.key !== undefined && onDisk.key !== ours) this.keepConflict(rel, onDisk)
      // The record first, so an applied AI merge always has one to review.
      // theirsBy is peer-written (an activity entry): flatten it so a stray
      // control character can't make openMerge throw and drop the record.
      const rec = openMerge(this.doc, this.merges, { path: rel, by: this.name, byId: this.myKey(), others: theirsBy ? [cleanName(theirsBy)] : [], kind: 'ai', ours, base, theirsHash: sha1(theirs), binary: false, via }, LOCAL)
      // The local copies are for Send to… and review; the record already has
      // ours (an "ai" record is never local), so a failed write mustn't stop the merge it describes.
      try {
        this.writeMergeFiles(rec.id, { base, ours, theirs })
      } catch (err) {
        this.log(`could not keep the versions of ${rel} under .quilt/merges: ${err.message}`)
      }
      this.applyMerged(rel, ai.text, `by AI with ${theirsBy || 'the session'}'s changes`, { pulled })
      release()
      return 'ai'
    }
    const reason = ai.text ? 'the session changed it again while the AI was merging' : ai.refused
    return this.openConflict({ rel, base, ours, theirs: now, theirsBy: this.lastEditorOf(rel), disk, kind: 'conflict', reason, binary: false, via })
  }

  /** Writes a merged text to the shared doc and the disk as one edit of ours (`pulled`: one a git pull brought). */
  applyMerged (rel, text, detail, { pulled = false } = {}) {
    const abs = resolveInside(this.root, rel)
    this.doc.transact(() => {
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
    const rec = openMerge(this.doc, this.merges, {
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
    if (claim && claim.by !== this.name && (disk ? disk.key : undefined) !== this.sharedKey(rel)) {
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
      this.doc.transact(() => {
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
    this.doc.transact(() => {
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
    if (claim && claim.by === this.name) this.reclaim(rel)
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
    this.doc.transact(() => this.fileKeys.set(id, { wraps, ts: Date.now() }), LOCAL)
    return { id, key }
  }

  /** The owner (the only one with the view secret) makes every key open for viewers too. */
  shareKeysWithViewers () {
    if (!this.viewSecret) return
    const vk = deriveWrapKey(this.viewSecret, this.room)
    for (const [id, key] of this.fileKeysICanOpen()) {
      const entry = this.fileKeys.get(id)
      if (entry.wraps.some((w) => unwrapKey(w, vk))) continue
      this.doc.transact(() => this.fileKeys.set(id, { ...entry, wraps: [...entry.wraps, wrapKey(key, vk)] }), LOCAL)
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
      this.doc.transact(() => {
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
        if (e.type === 'head') { this.headChangedAt = Date.now(); this.queue(HEAD_CHANGED) } else if (e.type === 'busy') { this.setHold('busy'); this.settleSoon() } else if (e.type === 'fetch') { this.pullWaitOver.clear(); this.refreshPull() } else this.settleSoon() // idle, index
        if (this.hold && this.hold.kind === 'switching') this.checkBackOnBranch()
      })
      if (this.hold && this.hold.kind === 'switching') this.checkBackOnBranch() // back before the watcher started?
      else this.settleSoon() // a hold resumed at start ends once the tree has settled
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
      agent: { tool: null, status: 'idle', sharing: this.agentSharing }
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

  /** The shared board: To do, In progress, Done. Everyone in the room sees the same list. */
  taskList () { return readTasks(this.tasks) }

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
  inboxReader () { return { name: this.name, asAi: this.kind !== 'agent' } }

  /**
   * Looks for new mentions, direct messages and handed-over tasks. `quiet` takes
   * stock without waking anyone (our own changes, and everything there before we were ready).
   */
  scanInbox ({ quiet = false } = {}) {
    let events
    try {
      events = this.inboxTracker.scan({
        messages: this.chat.toArray().filter((m) => this.canSee(m)),
        tasks: this.taskList(),
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

  /** Inbox events after sequence number `after` (0 for all kept), and the latest number. */
  inbox ({ after = 0 } = {}) { return this.inboxTracker.since(after) }

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

  // ------------------------------------------------------------ messaging --

  /**
   * Posts a chat message. `to` makes it a direct message: it is only shown to
   * that person (it still travels through the shared room, so it isn't secret
   * from the relay or a modified client).
   */
  say (text, { to = null, file = null } = {}) {
    if (!this.mayTalk()) throw new Error(TALK_REFUSED)
    text = String(text || '').slice(0, 4000)
    if (!text && !file) throw new Error('message is empty')
    to = to ? String(to).trim() : null
    if (to === this.name) throw new Error('that is you')
    const msg = { id: crypto.randomBytes(8).toString('hex'), by: this.name, to, text, ts: Date.now() }
    if (file) msg.file = file
    this.doc.transact(() => {
      this.chat.push([msg])
      if (this.chat.length > 500) this.chat.delete(0, this.chat.length - 500)
    }, LOCAL)
    this.markRead([msg.id])
    this.scheduleStatusWrite()
    const online = !to || this.peerNames().includes(to)
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
    return validMessage(msg) && (!msg.to || msg.to === this.name || msg.by === this.name)
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
    return this.chat.toArray().filter((m) => this.canSee(m) && m.by !== this.name && !read.has(m.id)).length
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
  async claim (pattern, note = '') {
    pattern = String(pattern ?? '').trim()
    if (!pattern) throw new Error('pattern required')
    await this.conn.claimRequest({ op: 'claim', pattern, note: String(note) })
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
      if (c && c.by === this.name && c.queue && c.queue.length) continue
      this.autoClaims.delete(rel)
      if (!c || c.by !== this.name || !this.conn) continue
      done.push(this.conn.claimRequest({ op: 'release', pattern: rel }).catch(() => {}))
    }
    await Promise.all(done)
    return done.length
  }

  releaseQuietAutoClaims () {
    if (!this.ready || this.stopped) return
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
  async prepareEdit (paths) {
    const files = []
    for (const p of [...new Set((paths || []).map((x) => String(x || '').replace(/\\/g, '/').replace(/^\.\//, '')))]) {
      if (!p) continue
      if (!this.syncable(p)) { files.push({ path: p, shared: false }); continue }
      const held = (c) => ({ by: c.by, pattern: c.pattern, note: c.note || '', queue: c.queue || [] })
      let c = this.claimFor(p)
      if (c && c.by === this.name) {
        if (this.autoClaims.has(p)) this.autoClaims.set(p, Date.now())
        files.push({ path: p, shared: true, ok: true, mine: true })
        continue
      }
      if (c) { files.push({ path: p, shared: true, ok: false, claim: held(c) }); continue }
      try {
        if (!this.conn) throw new Error('not connected')
        await this.conn.claimRequest({ op: 'claim', pattern: p, note: this.focus ? `editing: ${this.focus}` : 'editing' })
        this.autoClaims.set(p, Date.now())
        files.push({ path: p, shared: true, ok: true, claimed: true })
      } catch (err) {
        c = this.claimFor(p)
        files.push(c && c.by !== this.name ? { path: p, shared: true, ok: false, claim: held(c) } : { path: p, shared: true, ok: false, error: err.message })
      }
    }
    const chat = this.chatAbout(files.filter((f) => f.shared).map((f) => f.path))
    if (files.some((f) => f.claimed)) this.reportWorking(this.focus || '')
    return { me: this.name, files, chat }
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
  duties () {
    return { me: this.name, waiting: waitingOn(this.chat.toArray().filter((m) => this.canSee(m)), this.name), queued: this.queued() }
  }

  // ------------------------------------------------------------ file queue --
  // A file someone else holds is asked for in its claim's queue, not taken; its holder hands it
  // on with their context when done (the relay keeps the queue, see server.js).

  /** Files we hold that someone is waiting for: [{ pattern, queue }]. */
  queued () { return queuedFor([...this.claims.values()], this.name) }

  /** Asks for a file someone else holds. Resolves to { request, position, holder, pattern }. */
  async requestFile (file, { title = '', description = '', task = '' } = {}) {
    const rel = String(file || '').replace(/\\/g, '/').replace(/^\.\//, '')
    if (!rel) throw new Error('path required')
    return this.conn.claimRequest({ op: 'request', path: rel, title: String(title), description: String(description), ...(task ? { task: String(task) } : {}) })
  }

  /** Hands a file we hold to someone waiting for it (the first, or `to`: a name or request id), with our context. */
  async handoff (file, { to = '', context = '' } = {}) {
    const rel = String(file || '').replace(/\\/g, '/').replace(/^\.\//, '')
    const r = await this.conn.claimRequest({ op: 'handoff', pattern: rel, to: String(to || ''), context: String(context) })
    this.autoClaims.delete(r.pattern)
    return r
  }

  /** Takes back one of our requests. */
  async withdrawRequest (request) {
    const r = await this.conn.claimRequest({ op: 'withdraw', request: String(request || '') })
    return r.withdrawn || 0
  }

  /**
   * We just changed a file someone is waiting for: our AI hears it with its next answer (once a
   * minute per file at most), so it hands the file on when done instead of forgetting them.
   */
  noteQueuedEdit (rel) {
    const c = this.claimFor(rel)
    if (!c || c.by !== this.name || !c.queue || !c.queue.length) return
    const last = this.queueNoticed.get(c.pattern) || 0
    if (Date.now() - last < 60 * 1000) return
    this.queueNoticed.set(c.pattern, Date.now())
    this.notice(renderQueueNotice([{ pattern: c.pattern, queue: c.queue }]))
  }

  /** Done with a piece of work: lets go of the claims that followed our edits and says we're done. */
  async finishEditing () {
    const released = await this.releaseAutoClaims()
    if (this.work?.state === 'working') this.setWork('done')
    this.workFromEdits = false
    return { released }
  }

  /** Releases one of our claims, or all of them with '*'. Resolves to the number released. */
  async release (pattern = '*') {
    const r = await this.conn.claimRequest({ op: 'release', pattern: String(pattern) })
    return r.released || 0
  }

  /** The owner clears every claim held by someone who isn't in the session. Resolves to the number released. */
  async clearInactiveClaims () {
    const r = await this.conn.claimRequest({ op: 'clear-inactive' })
    return r.released || 0
  }

  /** Takes the relay's claim list, logging what changed. */
  setClaims (list) {
    const next = new Map()
    for (const c of Array.isArray(list) ? list : []) if (c && typeof c.pattern === 'string' && typeof c.by === 'string') next.set(c.pattern, c)
    if (this.ready) {
      for (const [p, c] of next) {
        const was = this.claims.get(p)
        if (c.by !== this.name && (!was || was.by !== c.by)) this.log(`🔒 ${c.by} claimed ${c.pattern}${c.note ? ` — ${c.note}` : ''}`)
      }
      for (const [p, c] of this.claims) if (!next.has(p) && c.by !== this.name) this.log(`🔓 ${c.by} released ${p}`)
    }
    this.claims = next
    try { fs.writeFileSync(path.join(this.stateDir, 'claims.json'), JSON.stringify([...next.values()])) } catch {}
    this.scheduleStatusWrite()
    this.emit('claims', [...next.values()])
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
    if (how === 'mine' || how === 'hand') {
      const claim = this.claimFor(rec.path)
      if (claim && claim.by !== this.name) throw new Error(`${rec.path} is claimed by ${claim.by}${claim.note ? ` (${claim.note})` : ''}; ask them, or wait for the release`)
    }
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
      return updateMerge(this.doc, this.merges, id, { state: 'editing', how: 'hand', resolvedBy: this.name }, LOCAL)
    }
    const out = updateMerge(this.doc, this.merges, id, { state: 'done', how, resolvedBy: this.name }, LOCAL)
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

  /** A file being edited by hand lost its markers: that merge is settled. */
  closeHandMerge (rel, text) {
    const rec = this.mergeList().find((m) => m.path === rel && m.state === 'editing')
    if (!rec || hasMarkers(text)) return
    updateMerge(this.doc, this.merges, rec.id, { state: 'done', how: 'hand', resolvedBy: this.name }, LOCAL)
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
          .map(([p, ts]) => ({ path: p, secondsAgo: Math.round((now - ts) / 1000) }))
      })
    }
    return {
      room: this.room,
      server: this.server,
      connected: !!(this.conn && this.conn.connected),
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
      merges: this.mergeList().map(({ ours, base, ...m }) => m),
      activity: this.activity.toArray().slice(-30),
      changes: this.changes().people.map((p) => ({ ...p, files: p.files.slice(0, 10), pulled: p.pulled && { ...p.pulled, files: p.pulled.files.slice(0, 10) } })),
      chat: this.messages({ limit: 20, markRead: false }),
      unread: this.unreadCount(),
      fileCount: this.files.size + this.blobs.size,
      git: this.git ? { branch: this.git.branch, key: this.git.key, hold: this.hold ? { kind: this.hold.kind, since: this.hold.since, to: this.hold.to || null, conflict: this.hold.conflict || null } : null, pull: this.pull } : null
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
    if (this.autoClaims.size && this.conn && !this.stopped) {
      await Promise.race([this.releaseAutoClaims(), new Promise((r) => setTimeout(r, 2000))])
    }
    this.stopped = true
    clearInterval(this.retryTimer)
    if (this.watcher) await this.watcher.close()
    for (const t of this.rechecks.values()) clearTimeout(t)
    this.rechecks.clear()
    clearInterval(this.reconcileTimer)
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
