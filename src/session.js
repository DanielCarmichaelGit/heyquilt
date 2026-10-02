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
import { formatBytes } from './status.js'
import {
  loadIgnore, IGNORE_FILES, isIgnored, isSafeRelPath, resolveInside, looksBinary, sha1, walk,
  toPosix, globMatcher, MAX_TEXT_BYTES, MAX_BINARY_BYTES, LARGE_FILE_BYTES, MAX_STORED_BINARY_BYTES
} from './fsutil.js'
import { deriveWrapKey, newFileKey, wrapKey, unwrapKey, encryptBlob, decryptBlob, blobId } from './largefiles.js'
import { applyTextDiff } from './textdiff.js'
import { migrateDir } from './legacy.js'

export { applyTextDiff }

const LOCAL = Symbol('local')
const COLORS = ['#b9432b', '#3b6a9a', '#4a7a45', '#855a9c', '#a8701c', '#2e7a80', '#9c4f6b']
const RECENT_MS = 2 * 60 * 1000
const AGENT_FEED_CAP = 300
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

export class Session extends EventEmitter {
  constructor ({ dir, server, room, secret, key = '', viewSecret = '', name, tool = 'unknown', color = null, prefer = 'remote', kind = 'human', shareAgent = true, summarize = null, identity = null, passes = null }) {
    super()
    this.root = path.resolve(dir)
    this.server = server
    this.room = room
    this.secret = secret
    this.key = key
    this.viewSecret = viewSecret
    this.name = name
    this.identity = identity
    this.passes = passes // signs in to a relay that requires it (see pass-source.js)
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
    // "<name>\0<path>" -> { by, path, added, removed, edits, kind, ts }: what each
    // person has changed in this room, every edit counted. Each person writes
    // only their own keys, so there is nothing to merge.
    this.tallies = this.doc.getMap('changes')
    this.agentFeed = this.doc.getArray('agentFeed') // { id, by, tool, conv, kind, text, ts }
    this.commitRequests = this.doc.getMap('commitRequests') // id -> { id, by, message, ts, state: 'open'|'done', doneBy, hash }
    this.work = null // { state: 'working'|'done', note, ts }: what an agent says it's doing

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
    this.agentState = null
    this.access = null // from the relay: { state, role, scopes, owner, controlled }
    this.members = [] // everyone approved into a controlled session
    this.waiting = [] // people asking to join (only the owner hears about them)
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

  log (msg) { this.emit('log', msg) }

  async start ({ waitTimeoutMs = 0 } = {}) {
    fs.mkdirSync(this.stateDir, { recursive: true })
    const hadState = this.loadState()
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
      // We've synced this folder before: fold in anything edited while we were
      // away, then let the CRDT merge it with whatever the others did.
      this.reconcileOffline()
      this.goLive()
    } else {
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
    }
    await this.startWatcher()
    return this
  }

  // --------------------------------------------------------------- access --

  setAccess (a) {
    const was = this.access
    this.access = a
    if (a.state === 'pending' && (!was || was.state !== 'pending')) this.log(`⏳ waiting for the session owner to let you in (you were invited to ${a.invitedAs === 'viewer' ? 'view' : 'edit'})`)
    if (a.state === 'approved' && was && (was.role !== a.role || String(was.scopes) !== String(a.scopes))) {
      this.log(`🔑 you can now ${a.role === 'viewer' ? 'only view this session' : a.scopes.length ? `change files in ${a.scopes.join(', ')}` : 'change any file'}`)
    }
    if (a.refused) this.log(`🔒 the relay undid your change to ${a.refused.join(', ')}: ${a.why}`)
    this.emit('access', a)
    this.scheduleStatusWrite()
  }

  setMembers ({ members, pending }) {
    this.members = members || []
    if (pending) {
      const known = new Set(this.waiting.map((p) => p.key))
      for (const p of pending) if (!known.has(p.key)) this.log(`🙋 ${p.name}${p.kind === 'agent' ? ' (an agent)' : ''} wants to join as ${p.invitedAs === 'viewer' ? 'a viewer' : 'an editor'}`)
      this.waiting = pending
    }
    this.emit('members', { members: this.members, pending: this.waiting })
    this.emit('status-changed')
  }

  /** Why we may not change rel, or null if we may. */
  writeRefusal (rel) {
    const a = this.access
    if (!a || a.state !== 'approved') return null
    if (a.role === 'viewer') return 'you can only view this session'
    if (a.scopes && a.scopes.length && !a.scopes.some((sc) => globMatcher(sc)(rel))) return `you may only change files in ${a.scopes.join(', ')}`
    return null
  }

  get isOwner () { return !!(this.access && this.access.owner) }

  /** Owner only: let someone in, with a role and (for agents) the folders they may change. */
  approve (key, { role, scopes } = {}) { return this.conn.adminRequest({ op: 'approve', key, role, scopes }) }
  deny (key) { return this.conn.adminRequest({ op: 'deny', key }) }
  setMember (key, { role, scopes } = {}) { return this.conn.adminRequest({ op: 'set', key, role, scopes }) }
  removeMember (key) { return this.conn.adminRequest({ op: 'remove', key }) }

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
      this.scheduleStatusWrite()
    })
    this.activity.observe(() => this.scheduleStatusWrite())
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
      return true
    } catch {
      return false
    }
  }

  scheduleStateSave () {
    if (this.stateTimer) return
    this.stateTimer = setTimeout(() => this.saveState(), 1000)
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
    fs.writeFileSync(path.join(this.stateDir, 'state.json'), JSON.stringify({ room: this.room, server: this.server, storedOnDisk: Object.fromEntries(this.storedOnDisk), known }))
  }

  // ------------------------------------------------------------ reconcile --

  sharedPaths () {
    return new Set([...this.files.keys(), ...this.blobs.keys()])
  }

  syncable (rel) {
    return isSafeRelPath(rel) && !isIgnored(this.ig, rel)
  }

  reconcileOffline () {
    const onDisk = new Set(walk(this.root, this.ig))
    const downloads = []
    const take = [] // shared versions that never reached the folder: written now, not pushed back
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
      else this.ingest(rel)
    }
    for (const rel of onDisk) {
      const was = this.known && this.known.get(rel)
      if (was && this.sharedKey(rel) !== undefined) {
        const disk = this.readDisk(rel)
        if (disk && disk.key !== undefined && disk.key !== this.sharedKey(rel) && sha1(disk.key) === was) {
          // The folder still has the version we last wrote, so the room moved
          // on without the change reaching the disk: take it, don't undo it.
          take.push(rel)
          continue
        }
      }
      this.ingest(rel)
    }
    for (const rel of take) this.tryWrite(rel)
    for (const rel of downloads) this.downloadLarge(rel, this.blobs.get(rel))
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
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flushPending(), 40)
  }

  flushPending () {
    clearTimeout(this.flushTimer)
    this.flushTimer = null
    const paths = [...this.pending]
    this.pending.clear()
    for (const rel of paths) {
      try { this.ingest(rel) } catch (err) { this.log(`could not sync ${rel}: ${err.message}`) }
    }
  }

  /** Pushes the on-disk state of a path into the shared doc. Returns true if anything changed. */
  ingest (rel) {
    if (!this.syncable(rel)) return false
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

    if (!disk) {
      if (!this.files.has(rel) && !this.blobs.has(rel)) { this.lastKnown.delete(rel); return false }
      this.doc.transact(() => {
        this.files.delete(rel)
        this.blobs.delete(rel)
        this.recordActivity(rel, 'deleted', '')
      }, LOCAL)
      this.lastKnown.delete(rel)
      this.setOnDisk(rel, null)
      this.noteMyEdit(rel)
      return true
    }

    if (disk.key === this.sharedKey(rel)) {
      this.lastKnown.set(rel, disk.key)
      if (stored && stored.stored) this.setOnDisk(rel, stored.hash)
      return false
    }
    if (disk.binary && disk.buf.length >= LARGE_FILE_BYTES && !this.largeFilesOff) {
      const refused = this.uploadRefused.get(rel)
      if (!refused || refused.hash !== disk.hash) { this.uploadLarge(rel, disk); return false }
      if (!refused.inline || disk.buf.length > MAX_BINARY_BYTES) return false
      // Storage refused it, but it's small enough to share inside the document.
    }

    let detail = ''
    this.doc.transact(() => {
      const existed = this.files.has(rel) || this.blobs.has(rel)
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
        detail = applyTextDiff(ytext, disk.text)
      }
      this.recordActivity(rel, existed ? 'edited' : 'created', detail)
    }, LOCAL)
    this.lastKnown.set(rel, disk.key)
    this.setOnDisk(rel, null)
    this.noteMyEdit(rel)
    return true
  }

  /** Someone else claimed rel: keep our version aside and put the shared one back on disk. */
  rejectClaimed (rel, disk, claim) {
    this.rejectLocal(rel, disk, `it is claimed by ${claim.by}${claim.note ? ` (${claim.note})` : ''}`, claim.by)
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

  recordActivity (rel, kind, detail) {
    const now = Date.now()
    this.tally(rel, kind, detail, now)
    const last = this.lastActivityPush.get(rel)
    // Collapse bursts of edits to the same file into one entry.
    if (kind === 'edited' && last && now - last < 20000) return
    this.lastActivityPush.set(rel, now)
    this.activity.push([{ by: this.name, path: rel, kind, detail, ts: now }])
    if (this.activity.length > 300) this.activity.delete(0, this.activity.length - 300)
  }

  /** Add one change of mine to the running count for rel (`detail` is "+a -r" for text). */
  tally (rel, kind, detail, now) {
    if (this.seeding) return
    const key = `${this.name}\0${rel}`
    const cur = this.tallies.get(key) || { added: 0, removed: 0, edits: 0, kind: 'edited' }
    const m = /^\+(\d+) -(\d+)$/.exec(detail || '')
    const state = kind === 'deleted' ? 'deleted' : kind === 'created' || cur.kind === 'created' ? 'created' : 'edited'
    this.tallies.set(key, {
      by: this.name,
      path: rel,
      added: cur.added + (m ? +m[1] : 0),
      removed: cur.removed + (m ? +m[2] : 0),
      edits: cur.edits + 1,
      kind: state,
      ts: now
    })
  }

  /**
   * What has changed in this room and by whom: per person (most recent first,
   * with their files) and per file (with each person's share). Read from the
   * shared doc, so everyone sees the same breakdown.
   */
  changes () {
    const people = new Map()
    const files = new Map()
    for (const t of this.tallies.values()) {
      if (!t || !t.by || !isSafeRelPath(t.path)) continue
      const p = people.get(t.by) || { name: t.by, added: 0, removed: 0, edits: 0, ts: 0, files: [] }
      p.added += t.added; p.removed += t.removed; p.edits += t.edits; p.ts = Math.max(p.ts, t.ts)
      p.files.push({ path: t.path, added: t.added, removed: t.removed, edits: t.edits, kind: t.kind, ts: t.ts })
      people.set(t.by, p)
      const f = files.get(t.path) || { path: t.path, added: 0, removed: 0, edits: 0, ts: 0, by: [] }
      f.added += t.added; f.removed += t.removed; f.edits += t.edits; f.ts = Math.max(f.ts, t.ts)
      f.by.push({ name: t.by, added: t.added, removed: t.removed, edits: t.edits, kind: t.kind, ts: t.ts })
      files.set(t.path, f)
    }
    const newest = (a, b) => b.ts - a.ts
    const out = { people: [...people.values()].sort(newest), files: [...files.values()].sort(newest) }
    for (const p of out.people) { p.files.sort(newest); p.fileCount = p.files.length }
    for (const f of out.files) f.by.sort(newest)
    return out
  }

  noteMyEdit (rel) {
    const now = Date.now()
    this.emit('file-changed', { path: rel, by: this.name })
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
      return
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
  async uploadLarge (rel, disk) {
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
        this.recordActivity(rel, existed ? 'edited' : 'created', `${size} bytes`)
      }, LOCAL)
      this.lastKnown.set(rel, diskKey)
      this.setOnDisk(rel, hash)
      this.retry.delete(rel)
      this.uploadRefused.delete(rel)
      this.noteMyEdit(rel)
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
    if (this.conn) this.conn.awareness.setLocalStateField('work', this.work)
    this.scheduleStatusWrite()
    return this.work
  }

  /** Asks the host to commit once everyone's AI is idle. */
  requestCommit (message) {
    message = String(message || '').trim().slice(0, 500)
    if (!message) throw new Error('say what the commit is for')
    if (this.access && this.access.state === 'approved' && this.access.role === 'viewer') throw new Error('viewers can’t ask for commits')
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
    return { ok: true }
  }

  /** Releases one of our claims, or all of them with '*'. Resolves to the number released. */
  async release (pattern = '*') {
    const r = await this.conn.claimRequest({ op: 'release', pattern: String(pattern) })
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

  // ------------------------------------------------------------ AI feed --

  /** Adds entries from this person's AI chat reader. Dedupes by id, keeps the newest 300 per person. */
  pushAgentEntries (entries) {
    if (!this.agentSharing || !entries || !entries.length) return 0
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
    if (on === this.agentSharing) return on
    const marker = { id: `${on ? 'resumed' : 'paused'}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, by: this.name, tool: null, conv: null, kind: on ? 'resumed' : 'paused', text: '', ts: Date.now() }
    this.doc.transact(() => {
      this.agentFeed.push([marker])
      this.trimAgentFeed()
    }, LOCAL)
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
    this.agentState = state ? { tool: state.tool || null, status: state.status || 'idle', ...(state.reason ? { reason: state.reason } : {}), ...(state.notes ? { notes: state.notes } : {}) } : null
    this.publishAgentState()
  }

  publishAgentState () {
    if (!this.conn) return
    const st = this.agentState || { tool: null, status: 'idle' }
    // While paused, partners only learn that sharing is off, not whether you're working.
    const shared = this.agentSharing ? { ...st, sharing: true, ...(this.summarizer ? { summarized: true } : {}) } : { tool: st.tool, status: 'idle', sharing: false }
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
    const claimFor = (p) => {
      const c = this.claimFor(p)
      return c ? { by: c.by, pattern: c.pattern, note: c.note } : null
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
      claims: [...this.claims.values()].map((c) => ({ by: c.by, pattern: c.pattern, note: c.note, ts: c.ts }))
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
      members: this.members,
      ...(this.isOwner ? { waiting: this.waiting } : {}),
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
      activity: this.activity.toArray().slice(-30),
      changes: this.changes().people.map((p) => ({ ...p, files: p.files.slice(0, 10) })),
      chat: this.messages({ limit: 20, markRead: false }),
      unread: this.unreadCount(),
      fileCount: this.files.size + this.blobs.size
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
    this.ready = false
    this.stopped = true
    clearInterval(this.retryTimer)
    if (this.watcher) await this.watcher.close()
    for (const t of this.rechecks.values()) clearTimeout(t)
    this.rechecks.clear()
    clearInterval(this.reconcileTimer)
    this.flushPending()
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
