// Client connection to the relay: keeps a Y.Doc and presence in sync over a
// WebSocket, reconnecting with backoff. Edits made while offline are merged on
// reconnect by the CRDT.
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import crypto from 'node:crypto'
import * as Y from 'yjs'
import {
  MSG_SYNC, MSG_AWARENESS, MSG_QUERY_AWARENESS, MSG_AUTH, MSG_CLAIM, MSG_CLAIMS,
  MSG_ACCESS, MSG_ADMIN, MSG_MEMBERS, MSG_PASS, MSG_BRANCH, MSG_BRANCHES,
  CLOSE_AUTH_FAILED, CLOSE_NAME_TAKEN, CLOSE_ROOM_FULL, CLOSE_DENIED, CLOSE_ENDED, CLOSE_PASS_EXPIRED,
  encoding, decoding, syncProtocol, awarenessProtocol,
  ROOM_DOC, FEATURES, syncHeader,
  syncStep1Message, updateMessage, awarenessMessage, bytesMessage, jsonMessage
} from './protocol.js'
import { signChallenge, RESERVED_ROOM } from './identity.js'
import { PASS_REFRESH_MS } from './pass-source.js'

const ROOM_FULL_MESSAGE = 'This session is over the relay\'s size limit, so new changes can\'t be saved there. Start a new session, or host your own relay with a higher limit.'

const REQUEST_TIMEOUT_MS = 10000
const IDENTITY_CHANGED = "This computer's Quilt identity changed. Sign out and sign in again."
// Never quote the relay URL in errors: it names the room, and older relays may log it.
const BAD_ADDRESS = "Couldn't connect to the relay: the address isn't valid."
// A pass that lapses this soon after connecting wasn't really valid: after a few in a
// row, the clock is the likely culprit, and reconnecting won't help.
const QUICK_EXPIRY_MS = 60 * 1000
const MAX_QUICK_EXPIRIES = 5
// The relay pings every 30s. A connection that hears nothing for this long is dead
// (a laptop that slept, a network that silently dropped): the socket would otherwise
// look open for minutes while partners vanish and nothing syncs.
export const LIVENESS_MS = 75 * 1000
const HANDSHAKE_MS = 20 * 1000
const CLOCK_WRONG = "Your computer's clock looks wrong, so Quilt can't stay signed in. Check the date and time."

export const REMOTE = Symbol('remote')

/** Whether a saved copy of document `epoch` is of another document than the relay's (the branch was started again since). */
const staleEpoch = (epoch, reply) => !!epoch && !!reply.epoch && epoch !== reply.epoch

export class Connection extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.server  ws:// or wss:// base URL of the relay
   * @param {string} opts.room
   * @param {string} opts.secret
   * @param {string} opts.name       who we are in the room
   * @param {{ publicKey: string, privateKey: string }} opts.identity  proves the name is ours
   * @param {string} [opts.viewSecret]  when creating a room: the secret for view-only invites
   * @param {'human'|'agent'} [opts.kind]
   * @param {import('yjs').Doc} opts.doc
   * @param {() => void} [opts.beforeRemote] called before remote changes are applied
   * @param {import('./pass-source.js').PassSource} [opts.passes]  signs in to a relay that requires passes
   * @param {number} [opts.passRefreshMs]  how often to send the relay a fresh pass while connected
   * @param {number} [opts.livenessMs]  give up on a connection that stays silent this long
   * @param {string} [opts.tool]  the app or AI tool this is, for the session's audit trail
   */
  constructor ({ server, room, secret, key, viewSecret, kind = 'human', name, identity, doc, branch = null, onStaleBranch = null, beforeRemote, features = FEATURES, passes = null, passRefreshMs = PASS_REFRESH_MS, livenessMs = LIVENESS_MS, tool = '' }) {
    super()
    if (room === RESERVED_ROOM) throw new Error(`"${RESERVED_ROOM}" is not a session name`)
    // Secrets travel in headers, never in the URL: proxies log URLs, and Fly's did (issue 011).
    // Only who we are stays in the query string. `key` (the relay key) is only needed to
    // create a room on a relay that requires one.
    const q = new URLSearchParams({ name, key: identity.publicKey, kind })
    if (features) q.set('features', features)
    this.headers = { 'x-quilt-secret': secret || '' }
    if (key) this.headers['x-quilt-key'] = key
    if (viewSecret) this.headers['x-quilt-view-secret'] = viewSecret
    // Header values must be plain ASCII.
    const label = String(tool || '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 40)
    if (label && label !== 'unknown') this.headers['x-quilt-tool'] = label
    this.access = null // what the relay says we may do: { state, role, scopes, owner, controlled }
    this.url = `${server.replace(/\/+$/, '')}/${encodeURIComponent(room)}?${q}`
    this.passes = passes
    this.passRefreshMs = passRefreshMs
    this.passTimer = null
    this.livenessMs = livenessMs
    this.livenessTimer = null
    this.passStale = false // after a 4419 close (or a refused pass): get a new pass, not the cached one
    this.passRetried = false // a refused pass gets one retry with a fresh pass before it's fatal
    this.connectedAt = 0
    this.quickExpiries = 0 // 4419 closes in a row that came soon after connecting
    this.room = room
    this.identity = identity
    this.requests = new Map() // id -> { resolve, reject, timer }
    this.doc = doc
    this.beforeRemote = beforeRemote || (() => {})
    this.awareness = new awarenessProtocol.Awareness(doc)
    this.ws = null
    this.connected = false
    this.synced = false
    this.closed = false
    this.backoff = 500
    // Besides the room's document, the one branch this connection syncs (see setBranch). The
    // relay forgets it on every disconnect, so each (re)connection joins it again (startSync).
    this.branchKey = null
    this.branchDoc = null
    this.joinExtra = {} // sent with the first automatic join: adopt (the branch an older app's saved document is), base (HEAD, for a new branch)
    this.joining = null // { id, key, doc } while joinBranch waits for the relay
    this.autoJoin = null // the id of the automatic join, whose refusal is said (branch-refused)
    this.roomSynced = false
    this.branchSynced = false
    // Which document of the branch this app's copy belongs to (the relay starts a new one when a
    // branch is started again after being removed). While the relay hasn't said, a saved copy is
    // held back (branchHeld); a copy of an older one is never merged in: onStaleBranch(reply)
    // gives the document to sync instead.
    this.branchEpoch = (branch && branch.epoch) || null
    this.branchHeld = false
    this.onStaleBranch = onStaleBranch
    this._onBranchUpdate = (update, origin) => {
      if (origin !== REMOTE && this.branchKey !== null && !this.branchHeld) this.send(updateMessage(update, this.branchKey))
    }
    if (branch) {
      this.setBranch(branch.key, branch.doc)
      this.joinExtra = { ...(branch.adopt ? { adopt: branch.adopt } : {}), ...(branch.base ? { base: branch.base } : {}) }
    }

    this._onUpdate = (update, origin) => {
      if (origin !== REMOTE) this.send(updateMessage(update))
    }
    this._onAwareness = ({ added, updated, removed }, origin) => {
      if (origin === 'local') this.send(awarenessMessage(this.awareness, added.concat(updated, removed)))
    }
    doc.on('update', this._onUpdate)
    this.awareness.on('update', this._onAwareness)
    this.connect()
  }

  connect () {
    if (this.closed) return
    if (!this.passes) return this.open(this.headers)
    const getting = this.passStale ? this.passes.fresh() : this.passes.get()
    getting.then((pass) => {
      if (this.closed) return
      // Only now: if fetching failed, the retry must still ask for a fresh pass.
      this.passStale = false
      // The relay would refuse a pass for another key with "update and sign in", which isn't the
      // fix: ~/.quilt/identity.json changed since this computer signed in.
      const payload = this.passes.payload
      if (payload && payload.key && payload.key !== this.identity.publicKey) {
        this.emit('fatal', new Error(IDENTITY_CHANGED))
        return this.close()
      }
      this.emit('pass', this.passes.payload)
      this.emit('problem', null)
      this.open({ ...this.headers, 'x-quilt-pass': pass })
    }, (err) => {
      if (this.closed) return
      if (err.signedOut) {
        this.emit('fatal', err)
        return this.close()
      }
      this.emit('warn', `couldn't get a session pass: ${err.message}; retrying`)
      // Without a pass nothing connects, so say why where people can see it (not only in debug).
      this.emit('problem', `Couldn't get a session pass: ${err.message}`)
      setTimeout(() => this.connect(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, 10000)
    })
  }

  /** Opens the relay connection, sending the secrets (and the pass) as `headers`. */
  open (headers) {
    let ws
    try {
      // A handshake that never answers (a network gone away) must end too, so the reconnect runs.
      ws = new WebSocket(this.url, { headers, handshakeTimeout: HANDSHAKE_MS })
    } catch {
      // Later, so whoever made this connection is listening (and never with ws's error, which quotes the URL).
      setImmediate(() => {
        if (this.closed) return
        this.emit('fatal', new Error(BAD_ADDRESS))
        this.close()
      })
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    // The relay first asks us to sign a challenge; sync starts once we have.
    ws.on('open', () => { this.authed = false })

    ws.on('message', (data) => {
      try {
        if (this.authed) this.handle(new Uint8Array(data))
        else this.authenticate(new Uint8Array(data))
      } catch (err) { this.emit('warn', `error handling message from relay: ${err.stack}`) }
    })

    // Anything from the relay (its pings included) proves the connection is alive.
    const heard = () => {
      clearTimeout(this.livenessTimer)
      this.livenessTimer = setTimeout(() => {
        if (this.ws !== ws || this.closed) return
        this.emit('warn', 'the relay went quiet; reconnecting')
        ws.retrying = true
        ws.terminate() // 'close' fires and the reconnect with backoff runs
      }, this.livenessMs)
      this.livenessTimer.unref?.()
    }
    ws.on('open', heard)
    ws.on('ping', heard)
    ws.on('message', heard)

    ws.on('unexpected-response', (req, res) => {
      const reason = res.statusMessage || `HTTP ${res.statusCode}`
      if (res.statusCode === 401 && this.passes && !this.passRetried) {
        // The cached pass may have run out by the relay's clock: try once more with a fresh one.
        this.passRetried = true
        this.passStale = true
        this.passes.forget()
        this.emit('warn', 'the relay turned the session pass away; trying a fresh one')
        ws.retrying = true // we closed it on purpose: no "closed before the connection was established" warning
        ws.terminate()
      } else if (res.statusCode === 403 && /relay key/i.test(reason)) {
        this.emit('fatal', new Error('This relay needs a relay key to start new sessions. Join a session someone started there with their invite link instead.'))
        this.close()
      } else if (res.statusCode === 401 || res.statusCode === 400 || res.statusCode === 403) {
        this.emit('fatal', new Error(`Relay refused connection: ${reason}`))
        this.close()
      } else if (res.statusCode === 413) {
        this.emit('fatal', new Error(ROOM_FULL_MESSAGE))
        this.close()
      } else if (res.statusCode === 410) {
        this.emit('fatal', Object.assign(new Error(reason), { ended: true }))
        this.close()
      } else {
        // Not final (429, or a proxy's 502/503 while the relay restarts): end the handshake
        // ourselves so `close` fires and the reconnect with backoff runs. With a listener on
        // this event, ws leaves the request open otherwise, and nothing would ever retry.
        this.emit('warn', res.statusCode === 429 ? 'relay says there are too many connections from this network; retrying' : `relay responded ${reason}; retrying`)
        ws.retrying = true
        ws.terminate()
      }
    })

    ws.on('error', (err) => { if (!ws.retrying) this.emit('warn', `connection error: ${err.message}`) })

    ws.on('close', (code, reason) => {
      clearInterval(this.passTimer)
      if (this.ws === ws) clearTimeout(this.livenessTimer)
      const upSince = this.connectedAt
      this.connectedAt = 0
      // Count 4419s that came soon after connecting (or before signing in finished); any other
      // end to a connection that got going resets the count.
      if (code === CLOSE_PASS_EXPIRED) this.quickExpiries = !upSince || Date.now() - upSince < QUICK_EXPIRY_MS ? this.quickExpiries + 1 : 0
      else if (upSince) this.quickExpiries = 0
      if (code === CLOSE_PASS_EXPIRED && this.quickExpiries >= MAX_QUICK_EXPIRIES) {
        this.emit('fatal', new Error(CLOCK_WRONG))
        this.close()
      } else if (code === CLOSE_PASS_EXPIRED) {
        // Not fatal: reconnect (below) with a fresh pass.
        this.passStale = true
        this.emit('warn', String(reason) || 'session pass expired; reconnecting')
      } else if (code === CLOSE_ENDED) {
        this.emit('fatal', Object.assign(new Error(String(reason) || 'The owner ended this session'), { ended: true }))
        this.close()
      } else if (code === CLOSE_DENIED) {
        this.emit('fatal', Object.assign(new Error(String(reason) || 'The session owner did not let you in'), { denied: true }))
        this.close()
      } else if (code === CLOSE_AUTH_FAILED || code === CLOSE_NAME_TAKEN) {
        this.emit('fatal', new Error(`Relay refused connection: ${String(reason) || 'identity check failed'}`))
        this.close()
      } else if (code === CLOSE_ROOM_FULL) {
        this.emit('fatal', new Error(ROOM_FULL_MESSAGE))
        this.closed = true
      }
      const wasConnected = this.connected
      this.connected = false
      this.synced = false
      this.roomSynced = false
      this.branchSynced = false
      this.branchHeld = false
      this.joining = null
      this.authed = false
      if (this.ws === ws) this.ws = null
      for (const [id, r] of this.requests) { clearTimeout(r.timer); r.reject(new Error('disconnected from relay')); this.requests.delete(id) }
      // Peers' presence is stale once we're disconnected.
      const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID)
      awarenessProtocol.removeAwarenessStates(this.awareness, others, 'connection')
      // Forget how far their clocks had got, or the states the relay sends back on reconnect
      // (the same clocks, nothing changed) are ignored and partners stay invisible until
      // their next renewal, up to 15s later. A clock of -1 keeps them as known clients, so
      // their return is an update, not a fresh "joined".
      for (const id of others) {
        const m = this.awareness.meta.get(id)
        if (m) this.awareness.meta.set(id, { ...m, clock: -1 })
      }
      if (wasConnected && !this.closed) this.emit('status', 'disconnected')
      if (!this.closed) {
        setTimeout(() => this.connect(), this.backoff)
        this.backoff = Math.min(this.backoff * 2, 10000)
      }
    })
  }

  authenticate (buf) {
    const dec = decoding.createDecoder(buf)
    if (decoding.readVarUint(dec) !== MSG_AUTH) {
      this.emit('fatal', new Error('The relay runs an older quilt that cannot check identities; update it'))
      return this.close()
    }
    const nonce = decoding.readVarUint8Array(dec)
    this.ws.send(bytesMessage(MSG_AUTH, signChallenge(this.identity, this.room, nonce)))
    // The relay handles messages in order, so we can start syncing right away.
    // (If we have to wait for the owner, it ignores this and we start again once let in.)
    this.authed = true
    this.connected = true
    this.connectedAt = Date.now()
    this.passRetried = false
    // After a pass that lapsed right away, keep backing off rather than reconnecting at full speed.
    if (!this.quickExpiries) this.backoff = 500
    this.emit('status', 'connected')
    this.startSync()
    this.startPassRefresh()
  }

  /** While connected, send the relay a fresh pass every few minutes so the connection's never runs out. */
  startPassRefresh () {
    clearInterval(this.passTimer)
    if (!this.passes) return
    this.passTimer = setInterval(() => this.refreshPass(), this.passRefreshMs)
    this.passTimer.unref?.()
  }

  /** Sends the relay a fresh pass. `newer`: one issued after now (the relay asked: our access changed). */
  async refreshPass ({ newer = false } = {}) {
    try {
      const pass = await (newer ? this.passes.newer() : this.passes.fresh())
      this.emit('pass', this.passes.payload)
      this.send(jsonMessage(MSG_PASS, { pass }))
    } catch (err) {
      if (this.closed) return
      if (err.signedOut) {
        this.emit('fatal', err)
        return this.close()
      }
      this.emit('warn', `couldn't refresh the session pass: ${err.message}`)
    }
  }

  startSync () {
    this.send(syncStep1Message(this.doc))
    if (this.branchKey !== null) {
      // The relay handles messages in order: the join lands before the branch's sync step 1.
      const id = crypto.randomBytes(8).toString('hex')
      this.autoJoin = id
      this.send(jsonMessage(MSG_BRANCH, { id, op: 'join', branch: this.branchKey, ...this.joinExtra }))
      this.joinExtra = {}
      // A copy of a known document waits for the relay to say it is still that document (handle, MSG_BRANCHES).
      if (this.branchEpoch) this.branchHeld = true
      else this.send(syncStep1Message(this.branchDoc, this.branchKey))
    }
    // Set again rather than resent: that moves our clock on, so the relay takes the state
    // even when it still holds the clock from before a drop (it would ignore a repeat).
    const mine = this.awareness.getLocalState()
    if (mine !== null) this.awareness.setLocalState(mine)
    const q = encoding.createEncoder()
    encoding.writeVarUint(q, MSG_QUERY_AWARENESS)
    this.send(encoding.toUint8Array(q))
  }

  handle (buf) {
    const dec = decoding.createDecoder(buf)
    const type = decoding.readVarUint(dec)
    if (type === MSG_SYNC) {
      const docId = decoding.readVarString(dec)
      const doc = docId === ROOM_DOC ? this.doc : docId === this.branchKey && !this.branchHeld ? this.branchDoc : null
      if (!doc) return // a branch this connection has left (or whose document the relay hasn't confirmed yet)
      // Give the owner a chance to capture unsaved local edits so remote
      // changes merge with them instead of overwriting them.
      this.beforeRemote()
      const enc = syncHeader(docId)
      const header = encoding.length(enc)
      const msgType = syncProtocol.readSyncMessage(dec, enc, doc, REMOTE)
      if (encoding.length(enc) > header) this.send(encoding.toUint8Array(enc))
      if (msgType === syncProtocol.messageYjsSyncStep2) {
        if (doc === this.doc) this.roomSynced = true
        else if (!this.branchSynced) { this.branchSynced = true; this.emit('branch-synced') }
        this.noteSynced()
      }
    } else if (type === MSG_BRANCHES) {
      const { branches, reply } = JSON.parse(decoding.readVarString(dec))
      if (reply && this.joining && reply.id === this.joining.id) {
        const j = this.joining
        this.joining = null
        if (reply.ok) {
          // A saved copy of an older document of this branch: a fresh one is synced instead.
          const doc = staleEpoch(j.epoch, reply) ? (j.onStale ? j.onStale(reply) : new Y.Doc()) : j.doc
          this.setBranch(j.key, doc)
          this.send(syncStep1Message(doc, j.key))
        }
      }
      if (reply && reply.id === this.autoJoin && reply.ok && this.branchHeld) {
        this.branchHeld = false
        if (staleEpoch(this.branchEpoch, reply)) {
          const fresh = this.onStaleBranch ? this.onStaleBranch(reply) : new Y.Doc()
          this.setBranch(this.branchKey, fresh)
        }
        this.send(syncStep1Message(this.branchDoc, this.branchKey))
      }
      if (reply && reply.op === 'join' && reply.ok) {
        if (reply.epoch) this.branchEpoch = reply.epoch
        this.emit('branch-joined', reply)
      }
      if (reply && reply.id === this.autoJoin && !reply.ok) this.failBranch(reply.error || 'refused')
      if (Array.isArray(branches)) this.emit('branches', branches)
      this.settle(reply, 'the relay refused that branch change')
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), REMOTE)
    } else if (type === MSG_QUERY_AWARENESS) {
      this.send(awarenessMessage(this.awareness, [...this.awareness.getStates().keys()]))
    } else if (type === MSG_ACCESS) {
      const was = this.access
      this.access = JSON.parse(decoding.readVarString(dec))
      if (was && was.state === 'pending' && this.access.state === 'approved') this.startSync()
      this.emit('access', this.access)
      // The owner just changed what we may do: a fresh pass carries what the API now says.
      if (this.access.refresh && this.passes) this.refreshPass({ newer: true })
    } else if (type === MSG_MEMBERS) {
      const msg = JSON.parse(decoding.readVarString(dec))
      this.emit('members', msg)
      this.settle(msg.reply, 'request refused')
    } else if (type === MSG_CLAIMS) {
      const { claims, reply } = JSON.parse(decoding.readVarString(dec))
      this.emit('claims', claims)
      this.settle(reply, 'claim refused')
    }
  }

  /** Room and branch documents both synced: 'synced' (once per connection). */
  noteSynced () {
    const was = this.synced
    this.synced = this.roomSynced && (this.branchKey === null || this.branchSynced)
    if (this.synced && !was) this.emit('synced')
  }

  /** Syncs `doc` as branch `key` from now on; the previous branch document is let go. */
  setBranch (key, doc) {
    if (this.branchDoc) this.branchDoc.off('update', this._onBranchUpdate)
    this.branchKey = key
    this.branchDoc = doc
    this.branchSynced = false
    doc.on('update', this._onBranchUpdate)
  }

  /**
   * The automatic join (the `branch` constructor option) was refused: there is no branch to
   * sync, so nothing more is sent for it (`_onBranchUpdate` checks `branchKey`), and `synced`
   * can complete without it. `branch-refused` is emitted first, so anyone in `waitForSync` /
   * `waitForBranchSync` rejects instead of resolving on the `synced` this unblocks.
   */
  failBranch (error) {
    if (this.branchDoc) this.branchDoc.off('update', this._onBranchUpdate)
    this.branchHeld = false
    this.branchKey = null
    this.branchDoc = null
    this.branchSynced = false
    this.joining = null
    this.autoJoin = null
    this.emit('branch-refused', error)
    this.noteSynced()
  }

  /**
   * Moves this connection to branch `key`, syncing `doc` as it once the relay agrees: { branch, created, base, epoch }.
   * `epoch`: which document of the branch `doc` holds a saved copy of; when the relay's is another, `onStale(reply)`
   * gives the document synced instead (a new empty one by default), and `doc` is never sent.
   */
  joinBranch (key, doc, { epoch = null, onStale = null, ...extra } = {}) {
    return this.request(MSG_BRANCH, { op: 'join', branch: key, ...extra }, 'branch switches', (id) => { this.joining = { id, key, doc, epoch, onStale } })
  }

  /** Resolves once the relay holds every change this app has on its branch (before a switch clears the folder). */
  confirmBranch () {
    if (this.branchKey === null) return Promise.resolve({ ok: true })
    const sv = Buffer.from(Y.encodeStateVector(this.branchDoc)).toString('base64')
    return this.request(MSG_BRANCH, { op: 'confirm', branch: this.branchKey, sv }, 'branch switches')
  }

  /** Any other branch request (remove). */
  branchRequest (req) { return this.request(MSG_BRANCH, req, 'branch changes') }

  waitForBranchSync () {
    if (this.branchSynced) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const onSynced = () => { cleanup(); resolve() }
      const onFatal = (err) => { cleanup(); reject(err) }
      const onRefused = (err) => { cleanup(); reject(err instanceof Error ? err : new Error(String(err))) }
      const onDown = (s) => { if (s === 'disconnected') { cleanup(); reject(new Error('disconnected from relay')) } }
      const cleanup = () => { this.off('branch-synced', onSynced); this.off('fatal', onFatal); this.off('status', onDown); this.off('branch-refused', onRefused) }
      this.on('branch-synced', onSynced)
      this.on('fatal', onFatal)
      this.on('status', onDown)
      this.on('branch-refused', onRefused)
    })
  }

  settle (reply, fallback) {
    const r = reply && this.requests.get(reply.id)
    if (!r) return
    clearTimeout(r.timer)
    this.requests.delete(reply.id)
    if (reply.ok) r.resolve(reply)
    else r.reject(new Error(reply.error || fallback))
  }

  request (type, req, what, onId = null) {
    if (!this.authed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`not connected to the relay; ${what} need a connection`))
    }
    const id = crypto.randomBytes(8).toString('hex')
    if (onId) onId(id)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error('the relay did not answer')) }, REQUEST_TIMEOUT_MS)
      this.requests.set(id, { resolve, reject, timer })
      this.send(jsonMessage(type, { id, ...req }))
    })
  }

  /** Asks the relay to claim or release; resolves with its reply. Claims need a live connection. */
  claimRequest (req) { return this.request(MSG_CLAIM, req, 'claims') }

  /** Approve / deny / change / remove someone, or set who may admit (relay enforces who may). */
  adminRequest (req) { return this.request(MSG_ADMIN, req, 'changes to who is in the session') }

  send (msg) {
    if (this.authed && this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(msg)
  }

  waitForSync () {
    if (this.synced) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const onSynced = () => { cleanup(); resolve() }
      const onFatal = (err) => { cleanup(); reject(err) }
      const onRefused = (err) => { cleanup(); reject(err instanceof Error ? err : new Error(String(err))) }
      const cleanup = () => { this.off('synced', onSynced); this.off('fatal', onFatal); this.off('branch-refused', onRefused) }
      this.on('synced', onSynced)
      this.on('fatal', onFatal)
      this.on('branch-refused', onRefused)
    })
  }

  close () {
    this.closed = true
    clearInterval(this.passTimer)
    clearTimeout(this.livenessTimer)
    this.doc.off('update', this._onUpdate)
    if (this.branchDoc) this.branchDoc.off('update', this._onBranchUpdate)
    this.awareness.off('update', this._onAwareness)
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'local')
    if (this.ws) {
      const ws = this.ws
      // Flush the presence removal before closing. If the relay doesn't ack the close
      // handshake (it's gone, or this socket is in the middle of being refused), don't
      // leave it half-closed for the 'ws' library's ~30s default: finish it off.
      setTimeout(() => {
        ws.close()
        const t = setTimeout(() => { if (ws.readyState !== ws.CLOSED) ws.terminate() }, 2000)
        ws.once('close', () => clearTimeout(t))
      }, 50)
    }
    this.awareness.destroy()
  }
}
