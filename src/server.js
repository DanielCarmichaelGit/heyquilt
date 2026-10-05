// Relay server: holds one shared Yjs document per room, relays updates and
// presence between clients, stores files shared in chat, and persists rooms
// to disk. It checks who each client is (see identity.js) and owns the
// room's claims, so only the person who made a claim can release it (with
// sign-in on, the account that made it, so two people who share a display
// name can't release each other's claims). Safe to
// run on the public internet: rooms need their secret, creating rooms can
// require a relay key, and rooms have size quotas.
//
// Access: a room created with a view-only secret has an owner (the first
// person to sign in). By default only the owner lets people in; they can
// open that to editors or anyone in the session. People who may admit
// approve joiners and give them a role:
// editors change files, viewers only watch and chat, and agents can be
// limited to some folders. The relay enforces it by undoing file changes a
// member isn't allowed to make, before anyone else sees them.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import { handleAgentMcp, handleHostedMcp } from './relay-mcp.js'
import { UpdateCheck } from './update-check.js'
import {
  MSG_SYNC, MSG_AWARENESS, MSG_QUERY_AWARENESS, MSG_AUTH, MSG_CLAIM, MSG_CLAIMS, MAX_SHARED_FILE_BYTES,
  MSG_ACCESS, MSG_ADMIN, MSG_MEMBERS, MSG_PASS,
  CLOSE_AUTH_FAILED, CLOSE_NAME_TAKEN, CLOSE_ROOM_FULL, CLOSE_DENIED, CLOSE_ENDED, CLOSE_NEEDS_UPDATE, CLOSE_PASS_EXPIRED,
  encoding, decoding, syncProtocol, awarenessProtocol,
  syncStep1Message, updateMessage, awarenessMessage, bytesMessage, jsonMessage
} from './protocol.js'
import { parsePublicKey, verifyChallenge } from './identity.js'
import { verifyPass, PASS_TTL_MS } from './passes.js'
import { cleanAccess, narrowAccess, relayAccess, fromRelay, sameAccess, mayChange, TALK_REFUSED } from './session-access.js'
import { canAdmit, cleanAdmitBy, DEFAULT_ADMIT_BY, BAD_ADMIT_BY } from './admit-policy.js'
import { patternsOverlap } from './fsutil.js'
import { globMatcher } from './pathrules.js'
import { adoptLegacyEnv } from './legacy.js'
import { makeStore, DiskStore } from './blobstore.js'
import { JOIN_HOST } from './ui/invite.js'
import { PresenceReporter, PRESENCE_FILE } from './presence.js'
import { cleanSessionName, BAD_SESSION_NAME } from './session-name.js'
import { hostedWebhooks } from './relay-webhooks.js'

const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/
const MAX_NAME = 64
// A hosted agent counts as online this long after its last tool call.
const HOSTED_ONLINE_MS = 3 * 60 * 1000
// A room's renames: each one saves the room and queues a presence report, so they're rationed.
const RENAME_MS = 2000
const MAX_PATTERN = 500
// The file queue: requests for a claimed file (a title, and a summary of the plan), and handoffs.
const MAX_REQUEST_TITLE = 120
const MAX_REQUEST_TEXT = 300
const MAX_HANDOFF_TEXT = 2000
const MAX_QUEUE = 20
const MAX_SCOPES = 20
// Removed accounts remembered per room, so an older pass's grant can't bring them back.
const MAX_REMOVED = 200
const ROLES = ['editor', 'viewer']
const MB = 1024 * 1024
const DAY = 24 * 60 * 60 * 1000
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOGO = path.join(ROOT, 'assets', 'logo.svg')
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest()
const sameSecret = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b)

/** Relay settings, from options or environment variables. */
export function relayConfig (opts = {}) {
  const env = adoptLegacyEnv({ ...process.env })
  const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v))
  // The accounts API's public key. With it, every connection needs a pass (see passes.js).
  const passPublicKey = opts.passPublicKey ?? env.QUILT_PASS_PUBLIC_KEY ?? ''
  return {
    passPublicKey,
    // Presence reports for the dashboard (presence.js): only when both are set.
    apiUrl: opts.apiUrl ?? env.QUILT_API_URL ?? '',
    relayApiSecret: opts.relayApiSecret ?? env.RELAY_API_SECRET ?? '',
    // With passes on, the accounts API decides who may start sessions: the relay key isn't used.
    relayKey: passPublicKey ? '' : (opts.relayKey ?? env.QUILT_RELAY_KEY ?? ''),
    // A room's whole history lives in memory while anyone is in it, and takes
    // several times its stored size there: keep this well under the machine's memory.
    maxRoomBytes: num(opts.maxRoomBytes ?? env.QUILT_MAX_ROOM_MB, 32) * (opts.maxRoomBytes !== undefined ? 1 : MB),
    maxRoomFileBytes: num(opts.maxRoomFileBytes ?? env.QUILT_MAX_ROOM_FILES_MB, 2048) * (opts.maxRoomFileBytes !== undefined ? 1 : MB),
    maxConnsPerIp: num(opts.maxConnsPerIp ?? env.QUILT_MAX_CONNS_PER_IP, 50),
    maxNewRoomsPerHour: num(opts.maxNewRoomsPerHour ?? env.QUILT_MAX_NEW_ROOMS_PER_HOUR, 30),
    roomTtlDays: num(opts.roomTtlDays ?? env.QUILT_ROOM_TTL_DAYS, 30),
    idleUnloadMs: num(opts.idleUnloadMs, 60 * 1000),
    // A claim whose holder has done nothing in the session this long is let go (see sweepClaims):
    // handed to the first one waiting in its file queue, or released.
    claimIdleMs: num(opts.claimIdleMs, 20 * 60 * 1000),
    trustProxy: opts.trustProxy ?? /^(1|true|yes)$/i.test(env.QUILT_TRUST_PROXY || ''),
    // Large files: Supabase Storage when both are set, otherwise the relay's own disk.
    storageUrl: opts.storageUrl ?? env.QUILT_STORAGE_URL ?? '',
    storageKey: opts.storageKey ?? env.QUILT_STORAGE_KEY ?? '',
    storageBucket: opts.storageBucket ?? env.QUILT_STORAGE_BUCKET ?? 'session-files',
    maxStoredFileBytes: num(opts.maxStoredFileBytes ?? env.QUILT_MAX_STORED_FILE_MB, 100) * (opts.maxStoredFileBytes !== undefined ? 1 : MB)
  }
}

class Room {
  constructor (name, dataDir, cfg, log) {
    this.name = name
    this.cfg = cfg
    this.log = log
    this.doc = new Y.Doc()
    this.awareness = new awarenessProtocol.Awareness(this.doc)
    this.awareness.setLocalState(null)
    this.conns = new Map() // ws -> Set<awareness clientID>
    this.names = new Map() // ws -> verified name
    this.docFile = dataDir && path.join(dataDir, `${name}.ydoc`)
    this.metaFile = dataDir && path.join(dataDir, `${name}.json`)
    this.meta = {}
    this.bytes = 0
    this.full = false
    this.unsavable = false // a disk error stopped a save: the room is read-only (see diskError)
    if (dataDir) {
      // A room whose files can't be read (cut off by a crash, or a disk error) is refused,
      // not treated as new: that would overwrite it, or let the sweep delete it.
      try {
        if (fs.existsSync(this.docFile)) {
          const buf = fs.readFileSync(this.docFile)
          Y.applyUpdate(this.doc, buf)
          this.bytes = buf.length
        }
        if (fs.existsSync(this.metaFile)) this.meta = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'))
      } catch (err) {
        this.awareness.destroy()
        this.doc.destroy()
        throw Object.assign(new Error(`could not read the session's data: ${err.message}`), { unreadable: true })
      }
    }
    this.meta.identities = this.meta.identities || {} // name -> public key
    this.meta.claims = this.meta.claims || {} // pattern -> { by, byId?, pattern, note, ts }; byId is the account, with sign-in on
    // Claim holder (see holderKey) -> when they last did something in the session (changed the
    // document: a file, a message, their AI's feed; or used a hosted tool), for sweepClaims.
    this.meta.seen = this.meta.seen || {}
    this.loadedAt = Date.now()
    // Member id -> { name, kind, role, scopes, since }. The id is the public key, or
    // '<kind>:<sub>' for members approved with a pass (an account, on any computer).
    this.meta.members = this.meta.members || {}
    this.access = new Map() // ws -> { key, id, name, kind, role, scopes, owner } for people in the room
    // ws -> { key, id, name, kind, invitedAs, since } waiting for the owner. A hosted agent (one
    // that only talks to the relay over HTTP, see relay-mcp.js) waits under a { hosted: id } stand-in.
    this.pending = new Map()
    this.hostedSeen = new Map() // member id -> when a hosted agent last called a tool
    this.files = this.doc.getMap('files')
    this.blobs = this.doc.getMap('blobs')
    this.fileKeys = this.doc.getMap('fileKeys')
    this.chat = this.doc.getArray('chat')
    this.feed = this.doc.getArray('agentFeed')
    this.activity = this.doc.getArray('activity') // { by, path, kind, detail, ts }
    this.commitRequests = this.doc.getMap('commitRequests') // id -> { id, by, message, ts, state, ... }
    // Undoes changes from people who may not make them: file changes from viewers and from
    // people outside their folders, and posts from people who may not post (chat, the feed,
    // words of their own in the activity log, commit requests). Only their connections are tracked.
    this.guard = new Y.UndoManager([this.files, this.blobs, this.fileKeys, this.chat, this.feed, this.activity, this.commitRequests], { trackedOrigins: new Set(), captureTimeout: 0 })
    this.undoing = null
    this.recorded = null // the change the guard recorded last, for checkChange
    this.guard.on('stack-item-added', ({ stackItem, type }) => { if (type === 'undo') this.recorded = stackItem })
    // What a tracked change added to the activity log, read before Yjs merges the new entries
    // into older ones (after which a change event can no longer tell them apart).
    this.activityAdded = new WeakMap()
    this.doc.on('afterTransaction', (tr) => {
      const events = tr.changedParentTypes.get(this.activity)
      if (!events || !this.guard.trackedOrigins.has(tr.origin)) return
      this.activityAdded.set(tr, events.flatMap((e) => [...e.changes.added].flatMap((item) => item.content.getContent())))
    })
    this.full = this.bytes > cfg.maxRoomBytes
    this.saveTimer = null
    this.unloadTimer = null
    this.presence = null // a PresenceReporter when the relay reports presence (set by startServer)
    this.lastRenameAt = 0 // when the owner last renamed the session (RENAME_MS)

    this.doc.on('update', (update, origin, doc, tr) => {
      if (origin === this.guard && this.undoing) { this.undoing.push(update); return } // sent merged, below
      if (origin && origin !== this.guard && this.guard.trackedOrigins.has(origin) && !this.checkChange(origin, update, tr)) return
      if (origin && this.conns.has(origin)) this.noteActivity(this.holderKeys(origin))
      const msg = updateMessage(update)
      for (const ws of this.conns.keys()) if (ws !== origin) send(ws, msg)
      this.bytes += update.length
      if (!this.full && this.bytes > cfg.maxRoomBytes) {
        this.full = true
        this.log(`[${name}] over the size limit; further edits are refused`)
      }
      this.scheduleSave()
    })
    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed)
      if (origin && this.conns.has(origin)) {
        const ids = this.conns.get(origin)
        // Updated too: a client back from a drop speaks for the same id over a new connection.
        for (const id of added.concat(updated)) ids.add(id)
        for (const id of removed) ids.delete(id)
      }
      const msg = awarenessMessage(this.awareness, changed)
      for (const ws of this.conns.keys()) send(ws, msg)
    })
  }

  get exists () { return !!this.meta.secretHash }

  /** Rooms made by newer clients have an owner who approves people. Older rooms let everyone edit. */
  get controlled () { return !!this.meta.viewSecretHash }

  /**
   * First client to open a room sets its secrets; later clients must match one.
   * Returns 'editor' or 'viewer' (what the secret invites you as), 'bad-secret'
   * or 'need-key' (creating rooms needs the relay key). `publicKey` is the
   * creator's: in a controlled room, only they can become its owner.
   */
  authorize (secret, key, viewSecret = '', publicKey = '') {
    if (!this.meta.secretHash) {
      if (this.cfg.relayKey && !sameSecret(hash(key || ''), hash(this.cfg.relayKey))) return 'need-key'
      this.meta.secretHash = hash(secret || '').toString('hex')
      if (viewSecret) this.meta.viewSecretHash = hash(viewSecret).toString('hex')
      if (publicKey) this.meta.creator = publicKey
      this.meta.createdAt = Date.now()
      this.touch()
      return 'editor'
    }
    if (sameSecret(hash(secret || ''), Buffer.from(this.meta.secretHash, 'hex'))) return 'editor'
    if (this.controlled && sameSecret(hash(secret || ''), Buffer.from(this.meta.viewSecretHash, 'hex'))) return 'viewer'
    return 'bad-secret'
  }

  /**
   * Where someone stands when they sign in: let in now (with a role), or wait
   * for the owner. `account` is '<kind>:<sub>' from their pass when sign-in is
   * on: then they are their account, on any computer, not their key.
   */
  accessFor (key, name, kind, invitedAs, account = '', pass = null) {
    if (!this.controlled) return { state: 'approved', role: 'editor', scopes: [], owner: false }
    if (!this.meta.owner) {
      // The room's creator becomes its owner when they sign in, and nobody else, however much
      // earlier they get here: until then invitees wait. (Rooms made before creators were
      // recorded, with nobody signed in yet, go to the first person invited to edit.)
      const creator = this.meta.creator
      if (creator ? key === creator : invitedAs === 'editor') { this.meta.owner = key; this.saveMeta() }
    }
    if (account) this.noteKey(account, key)
    if (this.isOwner(key, account)) {
      if (account) {
        // Remember the owner's account, so they're the owner on any computer.
        // Names come from accounts and can change: show the owner by the name they use now.
        if (this.meta.ownerSub !== account || this.meta.ownerName !== name) { this.meta.ownerSub = account; this.meta.ownerName = name; this.saveMeta() }
      }
      return { state: 'approved', role: 'editor', scopes: [], owner: true }
    }
    // A room pass with a grant (from the accounts API) lets them straight in, with its access.
    const granted = this.passGrant(pass)
    if (granted) {
      this.noteGranted(account, name, kind, granted)
      return { state: 'approved', ...relayAccess(granted), owner: false, id: account }
    }
    // Members approved with a pass are kept under their account; older ones under their key.
    const id = account && this.meta.members[account] ? account : key
    const m = this.storedMember(id, pass)
    if (m) {
      if (m.name !== name || m.kind !== kind) { m.name = name; m.kind = kind; this.saveMeta() }
      return { state: 'approved', ...memberAccess(m), owner: false, id }
    }
    return { state: 'pending', invitedAs }
  }

  /**
   * What a pass for this room lets its holder do here (the grant the accounts API signed
   * into it), or null: no pass for this room, no grant, or the owner removed them after it
   * was issued. An owner's narrowing made after it was issued still applies.
   */
  passGrant (pass) {
    if (!pass || pass.room !== this.name) return null
    const access = cleanAccess(pass.access)
    if (!access) return null
    const account = `${pass.kind}:${pass.sub}`
    const issued = typeof pass.iat === 'number' ? pass.iat : pass.exp - PASS_TTL_MS
    const removedAt = (this.meta.removed || {})[account]
    if (removedAt && issued <= removedAt) return null
    const m = this.meta.members[account]
    if (m && m.setAt && issued <= m.setAt) return narrowAccess(access, fromRelay(m))
    return access
  }

  /**
   * True when this pass was issued no later than the owner's last change to its holder,
   * and that change cut what it grants. A pass from the same millisecond as the change
   * (or from a clock a little behind) may already carry it, but the relay can't tell, so
   * the app is asked for a newer one: otherwise more access waits for the next refresh.
   */
  passPredatesChange (pass) {
    if (!pass || pass.room !== this.name) return false
    const access = cleanAccess(pass.access)
    const m = this.meta.members[`${pass.kind}:${pass.sub}`]
    if (!access || !m || !m.setAt) return false
    const issued = typeof pass.iat === 'number' ? pass.iat : pass.exp - PASS_TTL_MS
    return issued <= m.setAt && !sameAccess(access, narrowAccess(access, fromRelay(m)))
  }

  /**
   * The member record that may let this pass in, or null. Someone let in as a type (by a
   * grant, or by the owner approving them as one) has their access in the API: only a pass
   * for this room speaks for it, so without one their stored record lets nobody in, or an
   * access type narrowed or deleted on the API would never reach the relay. Members from
   * before access types keep coming in on their record.
   */
  storedMember (id, pass) {
    const m = this.meta.members[id]
    if (!m) return null
    return m.granted && !(pass && pass.room === this.name) ? null : m
  }

  /** Keeps someone let in by their pass's grant on the member list, with that access. */
  noteGranted (id, name, kind, access) {
    const m = this.meta.members[id]
    if (m && m.name === name && m.kind === kind && sameAccess(fromRelay(m), access)) return
    this.meta.members[id] = { ...(m || {}), name, kind, ...relayAccess(access), since: m?.since || Date.now(), granted: true }
    this.saveMeta()
  }

  /**
   * A fresh pass arrived (see renewPass): its grant applies now. Someone waiting is let in,
   * and someone in the room gets the new access, both without the owner.
   */
  passRenewed (ws) {
    const granted = this.passGrant(ws.pass)
    if (!granted) return
    const id = `${ws.pass.kind}:${ws.pass.sub}`
    if (this.meta.ownerSub === id) return
    const waiting = this.pending.get(ws)
    if (waiting) {
      this.pending.delete(ws)
      this.noteGranted(id, waiting.name, waiting.kind, granted)
      this.log(`[${this.name}] ${waiting.name} was let in by their invite`)
      this.enter(ws, { key: waiting.key, id, name: waiting.name, kind: waiting.kind, ...relayAccess(granted), owner: false })
      return
    }
    const a = this.access.get(ws)
    if (!a || a.owner) return
    const refresh = this.passPredatesChange(ws.pass) ? { refresh: true } : {}
    if (sameAccess(fromRelay(a), granted)) {
      if (refresh.refresh) send(ws, jsonMessage(MSG_ACCESS, { ...this.accessMessage(a), ...refresh }))
      return
    }
    this.noteGranted(id, a.name, a.kind, granted)
    Object.assign(a, relayAccess(granted))
    this.setAccess(ws, a)
    send(ws, jsonMessage(MSG_ACCESS, { ...this.accessMessage(a), ...refresh }))
    this.broadcastMembers()
  }

  /**
   * Remembers which computer keys an account has used here, so removing the
   * account also removes members approved by one of those keys.
   */
  noteKey (account, key) {
    const keys = (this.meta.accountKeys = this.meta.accountKeys || {})
    const seen = keys[account] || []
    if (seen.includes(key)) return
    keys[account] = [...seen, key].slice(-20)
    this.saveMeta()
  }

  /** The owner is their account once it's known, and until then the key that made the room. */
  isOwner (key, account = '') {
    if (account && this.meta.ownerSub) return this.meta.ownerSub === account
    return this.meta.owner === key
  }

  /**
   * With sign-in on: may this pass use the session's files over HTTP? In a session with an
   * owner, only the owner and the people they let in may (by account, or an older member's key).
   * Unlike accessFor, it changes nothing.
   */
  letIn (pass) {
    if (!this.controlled) return true
    const account = `${pass.kind}:${pass.sub}`
    if (this.meta.owner && this.isOwner(pass.key, account)) return true
    if (this.passGrant(pass)) return true
    return !!(this.storedMember(account, pass) || this.storedMember(pass.key, pass))
  }

  /** With sign-in on: the relay access a pass has here over HTTP (null for the owner, or nobody). */
  httpAccess (pass) {
    const account = `${pass.kind}:${pass.sub}`
    if (!this.controlled || (this.meta.owner && this.isOwner(pass.key, account))) return null
    const granted = this.passGrant(pass)
    if (granted) return relayAccess(granted)
    const m = this.storedMember(account, pass) || this.storedMember(pass.key, pass)
    return m ? memberAccess(m) : null
  }

  /** The id the member list shows the owner under. */
  get ownerId () { return this.meta.ownerSub || this.meta.owner }

  /**
   * Where a hosted agent (HTTP only, no key) stands: approved with its role, or waiting for
   * the owner. Waiting puts it on the owner's list like a connection would. It never becomes
   * the owner: a room with no owner yet keeps it waiting.
   */
  hostedRequest (pass, invitedAs) {
    const id = `${pass.kind}:${pass.sub}`
    const a = this.hostedAccess(pass)
    if (a.state === 'approved') return a
    if (!this.controlled) return { state: 'approved', role: 'editor', scopes: [], owner: false, id }
    const waiting = [...this.pending].find(([k, p]) => k.hosted && p.id === id)
    if (waiting) { waiting[1].since = Date.now(); waiting[1].invitedAs = invitedAs; return { state: 'pending', invitedAs } }
    this.pending.set({ hosted: id }, { key: '', id, name: pass.name, kind: pass.kind === 'agent' ? 'agent' : 'human', invitedAs, since: Date.now() })
    this.log(`[${this.name}] ${pass.name} (hosted) is waiting to be let in`)
    this.broadcastMembers()
    return { state: 'pending', invitedAs }
  }

  /**
   * Puts a hosted agent back on the waiting list after a relay restart (the list lives in
   * memory; relay.hosted remembers who was waiting). Skips anyone already let in.
   */
  restoreHosted (id, { name, kind, invitedAs }) {
    if (!this.controlled || !name) return
    if (this.meta.members[id] || id === this.meta.owner || id === this.meta.ownerSub) return
    if ([...this.pending].some(([k, p]) => k.hosted && p.id === id)) return
    this.pending.set({ hosted: id }, { key: '', id, name, kind: kind === 'agent' ? 'agent' : 'human', invitedAs: invitedAs || 'viewer', since: Date.now() })
    this.broadcastMembers()
  }

  /**
   * A hosted agent's current standing: approved (with its access) or pending. A room pass
   * with a grant approves it, and puts it on the member list.
   */
  hostedAccess (pass) {
    const id = `${pass.kind}:${pass.sub}`
    if (!this.controlled) return { state: 'approved', role: 'editor', scopes: [], owner: false, id }
    if (this.meta.owner && this.isOwner(pass.key || '', id)) return { state: 'approved', role: 'editor', scopes: [], owner: true, id }
    const granted = this.passGrant(pass)
    if (granted) {
      this.noteGranted(id, pass.name, pass.kind === 'agent' ? 'agent' : 'human', granted)
      return { state: 'approved', ...relayAccess(granted), owner: false, id }
    }
    const m = this.storedMember(id, pass)
    if (m) {
      if (m.name !== pass.name) { m.name = pass.name; this.saveMeta() }
      return { state: 'approved', ...memberAccess(m), owner: false, id }
    }
    // Let in as a type, but this pass isn't for this room (the accounts API didn't know which
    // room the agent is in, after a restart): a pass for this room will let it in.
    if (this.meta.members[id]?.granted) return { state: 'pending', id, needsRoomPass: true }
    return { state: 'pending', id }
  }

  /** A hosted agent just used a tool: it shows as online for a while, and stops waiting. */
  hostedActive (id) {
    const was = this.hostedSeen.get(id) || 0
    this.hostedSeen.set(id, Date.now())
    this.noteActivity([id])
    for (const [k, p] of this.pending) if (k.hosted && p.id === id) this.pending.delete(k)
    // Newly online (or back after a while): everyone's member list shows it.
    if (Date.now() - was >= HOSTED_ONLINE_MS) this.broadcastMembers()
  }

  /** Hosted agents active in the last few minutes, for status and presence. */
  hostedOnline () {
    const cutoff = Date.now() - HOSTED_ONLINE_MS
    const out = []
    for (const [id, ts] of this.hostedSeen) {
      if (ts < cutoff) { this.hostedSeen.delete(id); continue }
      const m = this.meta.members[id]
      if (m) out.push({ id, name: m.name, kind: m.kind, role: m.role })
    }
    return out
  }

  /** Tells every connection the claims changed (a hosted agent claimed or released). */
  broadcastClaims () {
    this.saveMeta()
    const claims = this.claimList()
    for (const other of this.conns.keys()) send(other, jsonMessage(MSG_CLAIMS, { claims }))
  }

  /** May this connection change this file? */
  mayWrite (a, rel) { return mayChange(a, rel) }

  /**
   * A restricted member (viewer, or agent limited to folders) changed the doc.
   * Returns true to pass it on, or false after scheduling an undo because it
   * touched files they may not change. The undo runs once the guard has
   * recorded the change, whichever order Yjs fires its events in.
   */
  checkChange (ws, update, tr) {
    const a = this.access.get(ws)
    const touched = new Map() // path -> the types (files, blobs) it changed in
    const refused = []
    const posts = [] // chat and the feed, for people who may not post
    // Only the parts of the change that were refused are undone: one update can carry
    // allowed and refused changes together (an edit and a post in one transaction).
    const undo = new Set()
    for (const [type, events] of tr.changedParentTypes) {
      if (type === this.chat || type === this.feed) {
        if (a?.talk === false) { posts.push(type === this.chat ? 'chat' : 'the feed'); undo.add(type) }
        continue
      }
      if (type === this.commitRequests) {
        // Asking for a commit is a message to the host; marking one done (same message) isn't.
        if (a?.talk !== false) continue
        for (const e of events) {
          for (const [id, c] of e.changes.keys) {
            const now = type.get(id)
            if (c.action === 'add' || (c.action === 'update' && now?.message !== c.oldValue?.message)) { posts.push('a commit request'); undo.add(type); break }
          }
        }
        continue
      }
      if (type === this.fileKeys) {
        // Keys to stored files: viewers may not touch them, and others may
        // only add new ones, so nobody can lock people out of stored files.
        for (const e of events) {
          if (e.target !== type) { refused.push('a file key'); undo.add(type); continue }
          for (const [id, c] of e.changes.keys) if (a?.role === 'viewer' || c.action !== 'add') { refused.push(`file key ${id}`); undo.add(type) }
        }
        continue
      }
      if (type !== this.files && type !== this.blobs) continue
      const touch = (rel) => touched.set(rel, [...(touched.get(rel) || []), type])
      for (const e of events) {
        if (e.target === type) for (const k of e.changes.keys.keys()) touch(k)
        else {
          // A change inside a file's text: walk up to the entry in files.
          let t = e.target
          while (t && t._item && t._item.parent !== type) t = t._item.parent
          if (t && t._item && t._item.parentSub) touch(t._item.parentSub)
        }
      }
    }
    for (const [rel, types] of touched) {
      if (this.mayWrite(a, rel)) continue
      refused.push(rel)
      for (const t of types) undo.add(t)
      // The log entry for a change that's undone would describe something that never happened.
      if (tr.changedParentTypes.has(this.activity)) undo.add(this.activity)
    }
    // The activity log is written by apps as files change. Someone who may not post may add
    // only those entries, for files this same change touched, never words of their own.
    if (a?.talk === false && tr.changedParentTypes.has(this.activity) && !undo.has(this.activity)) {
      const plain = (x) => x && typeof x === 'object' && Object.keys(x).every((k) => ACTIVITY_FIELDS.includes(k)) &&
        x.by === a.name && ACTIVITY_KINDS.includes(x.kind) && touched.has(x.path) &&
        (x.detail === undefined || ACTIVITY_DETAIL.test(x.detail)) && typeof x.ts === 'number'
      const added = this.activityAdded.get(tr) || []
      if (!added.every(plain)) { posts.push('the activity log'); undo.add(this.activity) }
    }
    refused.push(...posts)
    // The guard recorded this change just before this 'update' (its stack-item-added): only
    // that one is kept or undone, never another change that arrived in the same moment.
    const item = this.recorded
    this.recorded = null
    if (!refused.length) { this.forget(item); return true }
    this.log(`[${this.name}] undid ${a ? a.name : 'someone'}'s change to ${refused.slice(0, 3).join(', ')}${refused.length > 3 ? '…' : ''} (not allowed)`)
    queueMicrotask(() => {
      // Send the change and its undo as one update: nobody sees the change,
      // and nobody is left missing part of this person's history.
      const others = this.guard.undoStack.filter((x) => x !== item)
      const scope = this.guard.scope
      this.guard.undoStack = item ? [item] : []
      this.guard.scope = scope.filter((t) => undo.has(t))
      this.undoing = []
      try { this.guard.undo() } finally {
        this.guard.scope = scope
        this.guard.undoStack = others
        this.guard.redoStack = []
        const merged = Y.mergeUpdates([update, ...this.undoing])
        this.undoing = null
        const msg = updateMessage(merged)
        for (const other of this.conns.keys()) send(other, msg)
      }
      const why = posts.length === refused.length
        ? TALK_WHY
        : a && a.role === 'viewer' ? 'you can only view this session' : 'that is outside the folders you may change'
      send(ws, jsonMessage(MSG_ACCESS, { ...this.accessMessage(a), refused: refused.slice(0, 20), why }))
    })
    return false
  }

  /** An allowed change: the guard never needs to undo it. */
  forget (item) {
    const i = item ? this.guard.undoStack.indexOf(item) : -1
    if (i >= 0) this.guard.undoStack.splice(i, 1)
  }

  /** Can this connection's app handle the session as it is now? */
  supported (ws) {
    return !this.meta.largeFiles || (ws.features || []).includes('large-files')
  }

  /**
   * The session now keeps large files in storage. Older apps would get
   * entries with no contents, so they're sent away to update.
   */
  startLargeFiles () {
    if (this.meta.largeFiles) return
    this.meta.largeFiles = true
    for (const ws of [...this.conns.keys(), ...this.pending.keys()]) {
      if (!ws.hosted && !this.supported(ws)) ws.close(CLOSE_NEEDS_UPDATE, NEEDS_UPDATE)
    }
  }

  get admitBy () { return cleanAdmitBy(this.meta.admitBy) || DEFAULT_ADMIT_BY }

  /** May this connection's access let people in, under the room's setting? */
  personCanAdmit (a) { return canAdmit(a, this.admitBy) }

  accessMessage (a) {
    return { state: 'approved', role: a.role, scopes: a.scopes || [], scopesExcept: a.scopesExcept || [], talk: a.talk !== false, owner: !!a.owner, controlled: this.controlled, admitBy: this.admitBy, canAdmit: this.personCanAdmit(a) }
  }

  /** Tracks restricted connections so their file changes are checked. */
  setAccess (ws, a) {
    this.access.set(ws, a)
    const restricted = a.role === 'viewer' || (a.scopes && a.scopes.length) || (a.scopesExcept && a.scopesExcept.length) || a.talk === false
    if (restricted) this.guard.trackedOrigins.add(ws)
    else this.guard.trackedOrigins.delete(ws)
  }

  memberList () {
    const online = new Map()
    for (const a of this.access.values()) online.set(a.owner ? this.ownerId : a.id, true)
    for (const h of this.hostedOnline()) online.set(h.id, true)
    const list = []
    if (this.meta.owner) {
      const ownerName = this.meta.ownerName || Object.entries(this.meta.identities).find(([, k]) => k === this.meta.owner)?.[0] || 'owner'
      list.push({ key: this.ownerId, name: ownerName, kind: 'human', role: 'owner', scopes: [], online: online.has(this.ownerId) })
    }
    for (const [key, m] of Object.entries(this.meta.members)) list.push({ key, name: m.name, kind: m.kind, ...memberAccess(m), online: online.has(key) })
    return list
  }

  pendingList () {
    return [...this.pending.values()].map((p) => ({ key: p.id, name: p.name, kind: p.kind, invitedAs: p.invitedAs, since: p.since }))
  }

  /** Sends everyone the member list; people who may let others in also see who's waiting. */
  broadcastMembers (replyTo = null, reply = null) {
    if (!this.controlled) return
    const members = this.memberList()
    const pending = this.pendingList()
    const admitBy = this.admitBy
    for (const [ws, a] of this.access) {
      const msg = { members, sessionName: this.meta.name || '', admitBy, pending: this.personCanAdmit(a) ? pending : [], ...(ws === replyTo && reply ? { reply } : {}) }
      send(ws, jsonMessage(MSG_MEMBERS, msg))
    }
  }

  /** Changes to who's in the room. Letting people in follows admitBy; the rest is owner-only. Returns the reply fields. */
  adminRequest (ws, req) {
    const me = this.access.get(ws)
    if (!me) throw new Error('only the session owner can do that')
    if (req.op === 'admitBy') {
      if (!me.owner) throw new Error('only the session owner can do that')
      const next = cleanAdmitBy(req.admitBy)
      if (!next) throw new Error(BAD_ADMIT_BY)
      if (next !== this.admitBy) {
        this.meta.admitBy = next
        this.saveMeta()
        // Everyone's access follows the new setting (canAdmit / admitBy on the access message).
        for (const [cws, a] of this.access) send(cws, jsonMessage(MSG_ACCESS, this.accessMessage(a)))
      }
      return { ok: true }
    }
    if (req.op === 'approve' || req.op === 'deny') {
      if (!this.personCanAdmit(me)) throw new Error('you cannot let people into this session')
    } else if (!me.owner) {
      throw new Error('only the session owner can do that')
    }
    if (req.op === 'name') {
      // The owner's app names the session after its folder, and the owner can rename it.
      const name = cleanSessionName(req.name)
      if (!name) throw new Error(BAD_SESSION_NAME)
      // Re-sending the same name (the app does this on every launch) should write nothing
      // and report nothing: only an actual rename is news.
      if (name !== this.meta.name) {
        // A new session's first name (its folder's, sent as it starts) isn't a rename: the
        // owner may rename it straight away.
        if (this.meta.name) {
          if (Date.now() - this.lastRenameAt < RENAME_MS) throw new Error('Renaming too fast; try again in a moment')
          this.lastRenameAt = Date.now()
        }
        this.meta.name = name
        this.saveMeta()
        if (this.presence) this.presence.rename({ room: this.name, name })
      }
      return { ok: true }
    }
    if (req.op === 'end') {
      // Reply first; the relay then sends everyone away and deletes the room.
      setTimeout(() => this.onEnd && this.onEnd(), 50)
      return { ok: true }
    }
    const key = String(req.key || '')
    const role = ROLES.includes(req.role) ? req.role : null
    const scopes = Array.isArray(req.scopes)
      ? req.scopes.map((s) => String(s).trim().replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean).slice(0, MAX_SCOPES)
      : null
    if (scopes && scopes.some((s) => s.length > MAX_PATTERN || s.split('/').includes('..'))) throw new Error('bad folder')
    // Apps with access types send the access itself ({ files, folders, foldersExcept, talk }),
    // and the type it came from (typeId), which the relay doesn't need: the API keeps grants.
    const requested = req.access === undefined ? null : cleanAccess(req.access)
    if (req.access !== undefined && !requested) throw new Error('bad access')
    if (key === this.meta.owner || key === this.meta.ownerSub) throw new Error('the owner always has full access')
    // `key` is the id from the member or pending list. One account may be waiting on several computers.
    const waiting = [...this.pending].filter(([, p]) => p.id === key)
    if (req.op === 'approve') {
      if (!waiting.length) throw new Error('nobody with that key is waiting')
      const p = waiting[0][1]
      const access = requested ? relayAccess(requested) : { role: role || p.invitedAs, scopes: scopes || [], scopesExcept: [], talk: true }
      // Let in as a type: their access lives in the API now (see storedMember).
      this.meta.members[key] = { name: p.name, kind: p.kind, ...access, since: Date.now(), ...(req.typeId ? { granted: true } : {}) }
      if (this.meta.removed) delete this.meta.removed[key]
      this.saveMeta()
      this.log(`[${this.name}] ${p.name} approved as ${access.role}`)
      for (const [pws, w] of waiting) {
        this.pending.delete(pws)
        // A hosted agent has no connection to let in: it finds out on its next tool call.
        if (pws.hosted) continue
        this.enter(pws, { key: w.key, id: key, name: w.name, kind: w.kind, ...access, owner: false })
        // Their app fetches a fresh pass now, so the grant the owner's app just wrote applies.
        send(pws, jsonMessage(MSG_ACCESS, { ...this.accessMessage(this.access.get(pws)), refresh: true }))
      }
      return { ok: true }
    }
    if (req.op === 'deny') {
      if (!waiting.length) throw new Error('nobody with that key is waiting')
      for (const [pws, w] of waiting) {
        this.pending.delete(pws)
        // A hosted agent finds out on its next tool call; relay.hosted remembers it, across restarts.
        if (pws.hosted) { if (this.onHostedDenied) this.onHostedDenied(w.id); continue }
        pws.close(CLOSE_DENIED, 'The session owner did not let you in')
      }
      return { ok: true }
    }
    const m = this.meta.members[key]
    if (!m) throw new Error('no such member')
    if (req.op === 'set') {
      const want = requested || { ...fromRelay(m), ...(role ? { files: role === 'viewer' ? 'view' : 'edit' } : {}), ...(scopes ? { folders: scopes } : {}) }
      // Someone let in as a type keeps what both their record (their last pass) and the owner
      // allow: more needs a fresh pass from the API. Older members get what the owner asks.
      const stored = m.granted ? narrowAccess(want, fromRelay(m)) : want
      // Remembered with when, so a pass issued before now can't undo it (see passGrant).
      Object.assign(m, relayAccess(stored), { setAt: Date.now() })
      this.saveMeta()
      for (const [cws, a] of this.access) {
        if (a.id !== key) continue
        // Someone let in by a grant gets what both their pass and the owner allow: the owner's
        // app can narrow access at once, but more waits for a pass from the API that allows it.
        Object.assign(a, relayAccess(this.passGrant(cws.pass) || stored))
        this.setAccess(cws, a)
        send(cws, jsonMessage(MSG_ACCESS, { ...this.accessMessage(a), refresh: true }))
      }
      return { ok: true }
    }
    if (req.op === 'remove') {
      // An account goes with any older entries for keys it has used here, so it can't get back in by key.
      const gone = [key, ...((this.meta.accountKeys || {})[key] || [])]
      // Their claims go with them: nobody left could release them.
      const names = gone.map((id) => this.meta.members[id]?.name).filter(Boolean)
      const theirs = (x) => x.byId ? gone.includes(x.byId) : names.includes(x.by)
      this.dropRequests(theirs)
      this.dropClaims(theirs, (c) => `${c.by} was removed from the session.`)
      for (const id of gone) delete this.meta.members[id]
      // A pass issued before now can't bring them back by its grant (see passGrant). Removals
      // older than a pass lasts can match no valid pass, so they go; the newest are kept.
      const cutoff = Date.now() - PASS_TTL_MS
      const removed = Object.entries({ ...(this.meta.removed || {}), [key]: Date.now() }).filter(([, at]) => at > cutoff).sort((a, b) => a[1] - b[1])
      this.meta.removed = Object.fromEntries(removed.slice(-MAX_REMOVED))
      this.saveMeta()
      for (const [cws, a] of this.access) if (gone.includes(a.id)) cws.close(CLOSE_DENIED, 'The session owner removed you')
      for (const id of gone) this.hostedSeen.delete(id)
      this.broadcastClaims()
      return { ok: true }
    }
    throw new Error('unknown request')
  }

  touch () {
    this.meta.lastActive = Date.now()
    this.saveMeta()
  }

  /** A name belongs to the first key that signs in with it. */
  keyMatches (name, publicKey) {
    const known = this.meta.identities[name]
    return !known || known === publicKey
  }

  bindName (name, publicKey) {
    if (this.meta.identities[name]) return
    this.meta.identities[name] = publicKey
    this.saveMeta()
  }

  /** Presence may only describe the sender, under their verified name. */
  samePerson (a, b) {
    const x = this.access.get(a)
    const y = this.access.get(b)
    return !!(x && y && x.key === y.key && x.name === y.name)
  }

  presenceAllowed (ws, update) {
    const name = this.names.get(ws)
    const dec = decoding.createDecoder(update)
    const n = decoding.readVarUint(dec)
    for (let i = 0; i < n; i++) {
      const id = decoding.readVarUint(dec)
      decoding.readVarUint(dec) // clock
      const state = JSON.parse(decoding.readVarString(dec))
      for (const [other, ids] of this.conns) {
        if (other === ws || !ids.has(id)) continue
        // The same person over a new connection: they're back from a drop the relay hasn't
        // noticed yet (its heartbeat takes up to a minute). The old connection is dead; let
        // it go now, or they'd stay unseen until it does.
        if (this.samePerson(other, ws)) { ids.delete(id); other.terminate(); continue }
        return false
      }
      if (state !== null && state.name !== name) return false
    }
    return true
  }

  /** Who a claim from this connection belongs to: their name, or with sign-in on, their account. */
  claimant (ws) {
    const name = this.names.get(ws)
    if (!ws.pass) return { name }
    const a = this.access.get(ws)
    return { name, id: `${ws.pass.kind}:${ws.pass.sub}`, owner: !!(a && a.owner), talk: !(a && a.talk === false) }
  }

  /**
   * Each claim, with `active` (whoever holds it is in the session now), `activeAt` (when they
   * last did something there) and its file queue: who asked for it next ({ id, path, by,
   * title, description, task, ts }), oldest first.
   */
  claimList () {
    return Object.values(this.meta.claims).map((c) => ({ ...c, queue: c.queue || [], active: this.holderPresent(c), activeAt: this.lastActive(c) })).sort((a, b) => a.ts - b.ts)
  }

  /** Who holds a claim: their account with sign-in on, otherwise their name. */
  holderKey (c) { return c.byId || `name:${c.by}` }

  /** The holder keys a connection speaks for: its account, and its name (claims older than sign-in). */
  holderKeys (ws) {
    const keys = [`name:${this.names.get(ws)}`]
    if (ws.pass) keys.push(`${ws.pass.kind}:${ws.pass.sub}`)
    return keys
  }

  /** Someone did something in the session: their claims' idle time starts again. */
  noteActivity (keys) {
    const now = Date.now()
    let save = false
    for (const k of keys) {
      if (!Object.values(this.meta.claims).some((c) => this.holderKey(c) === k)) continue
      // Saved now and then, so a relay restart doesn't count them idle for longer than they were.
      if (now - (this.meta.seen[k] || 0) > 60 * 1000) save = true
      this.meta.seen[k] = now
    }
    if (save) this.saveMeta()
  }

  /** When a claim's holder last did something in the session (since the relay loaded it, at the earliest). */
  lastActive (c) {
    return Math.max(this.meta.seen[this.holderKey(c)] ?? this.loadedAt, c.ts || 0)
  }

  /** Whether a claim's holder is in the session now: connected, or a hosted agent seen lately. */
  holderPresent (c) {
    if (c.byId) {
      const seen = this.hostedSeen.get(c.byId)
      if (seen && Date.now() - seen < HOSTED_ONLINE_MS) return true
      for (const ws of this.conns.keys()) if (ws.pass && `${ws.pass.kind}:${ws.pass.sub}` === c.byId) return true
      return false
    }
    for (const n of this.names.values()) if (n === c.by) return true
    return this.hostedOnline().some((h) => h.name === c.by)
  }

  /** The claim covering a file: its own, or a folder or glob claim that matches it (the earliest). */
  claimFor (file) {
    if (this.meta.claims[file]) return this.meta.claims[file]
    return Object.values(this.meta.claims).filter((c) => globMatcher(c.pattern)(file)).sort((a, b) => a.ts - b.ts)[0] || null
  }

  /**
   * Lets go of the claims `pick` chooses. A claim someone is waiting for in its file queue goes
   * to the first of them instead of being released (`why` says why, in the message they get).
   * Returns how many went.
   */
  dropClaims (pick, why = null) {
    let n = 0
    for (const c of Object.values(this.meta.claims)) {
      if (!pick(c)) continue
      n++
      if (c.queue && c.queue.length) this.handOff(c, c.queue[0], { context: why ? why(c) : `${c.by} let go of it.`, auto: true })
      else delete this.meta.claims[c.pattern]
    }
    this.forgetSeen()
    return n
  }

  /** Takes the requests `pick` chooses out of every file queue (someone removed, or gone). */
  dropRequests (pick) {
    for (const c of Object.values(this.meta.claims)) {
      if (!c.queue) continue
      c.queue = c.queue.filter((r) => !pick(r))
      if (!c.queue.length) delete c.queue
    }
  }

  forgetSeen () {
    for (const k of Object.keys(this.meta.seen)) if (!Object.values(this.meta.claims).some((c) => this.holderKey(c) === k)) delete this.meta.seen[k]
  }

  /**
   * Gives claim `c` to the one who asked for it in request `r`, with the holder's context,
   * and tells them in a direct message (which wakes their agent). The rest of the queue
   * stays with the claim: the new holder hands it on in turn.
   */
  handOff (c, r, { context = '', auto = false } = {}) {
    const now = Date.now()
    const queue = (c.queue || []).filter((x) => x.id !== r.id)
    const next = { by: r.by, ...(r.byId ? { byId: r.byId } : {}), pattern: c.pattern, note: String(r.title || '').slice(0, 500), ts: now, from: c.by }
    if (queue.length) next.queue = queue
    this.meta.claims[c.pattern] = next
    this.meta.seen[this.holderKey(next)] = now
    const text = auto
      ? `📦 ${c.pattern} is yours now: you asked for it ("${r.title}"). ${context}`.trim()
      : `📦 I'm handing you ${c.pattern} (you asked: "${r.title}"). My context: ${context}`
    // Sent as from the holder; marked as a handoff, it wakes them but asks for no answer (duties.js).
    this.postChat({ by: c.by, to: r.by, text, kind: 'handoff', path: c.pattern })
    this.log(`[${this.name}] ${c.pattern} handed from ${c.by} to ${r.by}${auto ? ' (automatically)' : ''}`)
  }

  /** A chat entry written by the relay itself (file queue requests and handoffs). */
  postChat ({ by, to = null, text, kind, path: file }) {
    const chat = this.doc.getArray('chat')
    const msg = { id: crypto.randomBytes(8).toString('hex'), by, to, text: String(text).slice(0, 4000), ts: Date.now(), kind, path: file }
    this.doc.transact(() => {
      chat.push([msg])
      if (chat.length > 500) chat.delete(0, chat.length - 500)
    })
    return msg
  }

  /**
   * Lets go of claims whose holder has done nothing in the session for claimIdleMs (no edit,
   * no message, no tool call): handed to the first one waiting for it, or released. Returns
   * how many went (and tells everyone, when any did).
   */
  sweepClaims (now = Date.now()) {
    const mins = Math.round(this.cfg.claimIdleMs / 60000)
    const n = this.dropClaims((c) => now - this.lastActive(c) >= this.cfg.claimIdleMs, (c) => `${c.by} had done nothing in the session for ${mins} minutes.`)
    if (n) this.log(`[${this.name}] let go of ${n} claim(s) idle for ${mins} minutes`)
    // Also when a holder came or went: everyone's app shows whose claims are held by someone away.
    const shown = this.claimList().map((c) => `${c.pattern}\0${c.active}`).join('\n')
    if (n || shown !== this.claimsShown) { this.claimsShown = shown; this.broadcastClaims() }
    return n
  }

  /**
   * Handles a claim/release request. `who` is { name } without sign-in, where
   * claims belong to a verified name; with it, { name, id, owner }, where they
   * belong to the account (id). Returns the reply fields.
   */
  claimRequest (who, req) {
    const { name, id } = who
    // Whose claim is this? Older claims in a sign-in room have no account: they belong to their
    // name, as they did when made, and claiming one again adopts it under this account.
    // (The owner may release any of them too.)
    const mine = (c) => id ? (c.byId ? c.byId === id : c.by === name) : c.by === name
    const pattern = String(req.pattern ?? '').trim().replace(/^\.\//, '')
    if (req.op === 'claim') {
      if (!pattern) throw new Error('pattern required')
      if (pattern.length > MAX_PATTERN) throw new Error('pattern too long')
      const existing = this.meta.claims[pattern]
      if (existing && !mine(existing)) throw new Error(`${pattern} is already claimed by ${existing.by}`)
      const paths = [...this.doc.getMap('files').keys(), ...this.doc.getMap('blobs').keys()]
      const other = this.claimList().find((c) => !mine(c) && patternsOverlap(c.pattern, pattern, paths))
      if (other) throw new Error(`${pattern} overlaps ${other.by}'s claim on ${other.pattern}`)
      this.meta.claims[pattern] = { by: name, ...(id ? { byId: id } : {}), pattern, note: who.talk === false ? '' : String(req.note ?? '').slice(0, 500), ts: Date.now(), ...(existing?.queue ? { queue: existing.queue } : {}) }
      return { ok: true }
    }
    if (req.op === 'release') {
      // A holder can't just let go of a file someone is waiting for: they hand it off, with
      // their context (op 'handoff'). Releasing everything lets go of the rest.
      const queued = (c) => c.queue && c.queue.length
      if (pattern === '*' || !pattern) {
        const held = Object.values(this.meta.claims).filter((c) => mine(c) && queued(c)).map((c) => c.pattern)
        return { ok: true, released: this.dropClaims((c) => mine(c) && !queued(c)), ...(held.length ? { held } : {}) }
      }
      const c = this.meta.claims[pattern]
      if (!c) return { ok: true, released: 0 }
      // The owner may release anyone's claim. Someone under the same name may release one
      // held by an account that isn't here (theirs from before a re-invite), but not take it.
      // Either way, the first one waiting for it gets it.
      const stale = c.by === name && !this.holderPresent(c)
      if (!mine(c) && !who.owner && !stale) throw new Error(`${pattern} is claimed by ${c.by}; only they can release it (or the session owner)`)
      if (mine(c) && queued(c)) throw new Error(`${c.queue.map((r) => r.by).join(', ')} ${c.queue.length === 1 ? 'is' : 'are'} waiting for ${pattern} in its file queue: hand it off with your context instead of releasing it`)
      this.dropClaims((x) => x === c, () => mine(c) ? `${c.by} let go of it.` : `${name} (the session owner) released ${c.by}'s claim.`)
      return { ok: true, released: 1 }
    }
    if (req.op === 'request') {
      // Asking for a file someone else holds: a line in that claim's file queue. Its holder is
      // told now, and must hand it off (with context) before letting go.
      const file = String(req.path ?? '').trim().replace(/^\.\//, '')
      if (!file || file.length > MAX_PATTERN) throw new Error('path required')
      if (who.talk === false) throw new Error('you may not post in this session')
      const c = this.claimFor(file)
      if (!c) throw new Error(`${file} is not claimed: claim it and go ahead`)
      if (mine(c)) throw new Error(`${file} is already yours`)
      const title = String(req.title ?? '').trim().slice(0, MAX_REQUEST_TITLE)
      if (!title) throw new Error('title required: what you want to do, in a few words')
      const description = String(req.description ?? '').trim().slice(0, MAX_REQUEST_TEXT)
      const task = req.task ? String(req.task).slice(0, 80) : undefined
      c.queue = c.queue || []
      // One request per person per claim: asking again updates it and keeps its place.
      const prev = c.queue.find((r) => id ? r.byId === id : r.by === name)
      if (!prev && c.queue.length >= MAX_QUEUE) throw new Error(`${c.queue.length} are already waiting for ${c.pattern}`)
      const r = prev || { id: crypto.randomBytes(6).toString('hex'), by: name, ...(id ? { byId: id } : {}), ts: Date.now() }
      Object.assign(r, { path: file, title, description, ...(task ? { task } : {}) })
      if (!prev) c.queue.push(r)
      this.postChat({ by: name, to: c.by, kind: 'queue', path: file, text: `📥 File queue · ${file}: ${title}${description ? ` — ${description}` : ''}. When you're done with it, hand it off to me with your context.` })
      return { ok: true, request: r.id, position: c.queue.indexOf(r) + 1, holder: c.by, pattern: c.pattern }
    }
    if (req.op === 'withdraw') {
      // The one who asked (or the owner) takes a request back.
      for (const c of Object.values(this.meta.claims)) {
        const r = (c.queue || []).find((x) => x.id === req.request)
        if (!r) continue
        if (!(id ? r.byId === id : r.by === name) && !who.owner) throw new Error('that request is not yours')
        c.queue = c.queue.filter((x) => x !== r)
        if (!c.queue.length) delete c.queue
        return { ok: true, withdrawn: 1 }
      }
      return { ok: true, withdrawn: 0 }
    }
    if (req.op === 'handoff') {
      // The holder passes a claim to someone waiting for it (the first, unless `to` names a
      // request id or a person), with what they know: what they changed, what's left, gotchas.
      const c = this.meta.claims[pattern] || (pattern && this.claimFor(pattern))
      if (!c) throw new Error(`${pattern || 'that'} is not claimed`)
      if (!mine(c) && !who.owner) throw new Error(`${c.pattern} is ${c.by}'s to hand off`)
      const queue = c.queue || []
      if (!queue.length) throw new Error(`nobody is waiting for ${c.pattern}: release it instead`)
      const to = req.to ? String(req.to) : ''
      const r = to ? queue.find((x) => x.id === to || x.by === to) : queue[0]
      if (!r) throw new Error(`${to} is not waiting for ${c.pattern}`)
      const context = String(req.context ?? '').trim().slice(0, MAX_HANDOFF_TEXT)
      if (!context && mine(c)) throw new Error('context required: what you changed, what is left and anything they should know')
      this.handOff(c, r, { context: context || `${name} (the session owner) handed it on.`, auto: !mine(c) })
      return { ok: true, to: r.by, pattern: c.pattern, waiting: queue.length - 1 }
    }
    if (req.op === 'clear-inactive') {
      // The owner clears every claim held by someone who isn't in the session now.
      if (!who.owner) throw new Error('only the session owner can clear claims')
      return { ok: true, released: this.dropClaims((c) => !this.holderPresent(c)) }
    }
    throw new Error('unknown claim operation')
  }

  saveMeta () {
    if (this.ended || !this.metaFile) return
    // Written whole, then renamed: a crash mid-write leaves the old file, never a cut-off one.
    try {
      const tmp = this.metaFile + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.meta))
      fs.renameSync(tmp, this.metaFile)
    } catch (err) { this.diskError(err) }
  }

  /**
   * A save failed (the disk is full, or not writable). The relay stays up and the
   * room stays readable, but takes no new changes rather than losing them quietly.
   */
  diskError (err) {
    if (!this.unsavable) this.log(`[${this.name}] could not save the session (${err.message}); it is read-only until the relay's disk is fixed and it is reloaded`)
    this.unsavable = true
    this.full = true
  }

  scheduleSave () {
    if (!this.docFile || this.saveTimer) return
    this.saveTimer = setTimeout(() => this.save(), 1000)
  }

  save () {
    if (this.ended) return
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (!this.docFile || !this.exists) return
    const state = Y.encodeStateAsUpdate(this.doc)
    this.bytes = state.length
    try {
      const tmp = this.docFile + '.tmp'
      fs.writeFileSync(tmp, state)
      fs.renameSync(tmp, this.docFile)
    } catch (err) { this.diskError(err) }
  }

  /**
   * Challenges the client to prove it holds the key for its name, then lets
   * it into the room. Nothing else is accepted until then.
   */
  admit (ws, name, publicKey, key, { kind = 'human', invitedAs = 'editor', account = '' } = {}, onJoin) {
    if (this.ended) return ws.close(CLOSE_ENDED, 'The owner ended this session')
    clearTimeout(this.unloadTimer)
    const nonce = crypto.randomBytes(32)
    let joined = false
    let waiting = false
    ws.on('message', (data) => {
      const buf = new Uint8Array(data)
      // A fresh pass may come at any time, even while waiting for the owner.
      // (MSG_PASS is under 128, so it is the whole first byte.)
      if (ws.pass && buf[0] === MSG_PASS) {
        if (!renewPass(ws, buf)) this.log(`[${this.name}] ignored a pass refresh from ${name} that wasn't theirs`)
        else this.passRenewed(ws)
        return
      }
      if (joined || this.access.has(ws)) {
        joined = true
        try { this.handle(ws, buf) } catch (err) { this.log(`[${this.name}] bad message: ${err.message}`) }
        return
      }
      if (waiting) return // nothing counts until the owner lets them in
      try {
        const dec = decoding.createDecoder(buf)
        if (decoding.readVarUint(dec) !== MSG_AUTH) throw new Error('not signed in')
        if (!verifyChallenge(key, this.name, nonce, decoding.readVarUint8Array(dec))) throw new Error('bad signature')
      } catch (err) {
        this.log(`[${this.name}] refused ${name}: ${err.message}`)
        return ws.close(CLOSE_AUTH_FAILED, 'Could not verify who you are')
      }
      if (this.ended) return ws.close(CLOSE_ENDED, 'The owner ended this session')
      // The session may have started storing files while this app signed in.
      if (!this.supported(ws)) return ws.close(CLOSE_NEEDS_UPDATE, NEEDS_UPDATE)
      // With sign-in on, names come from accounts and can't be taken, so they aren't bound to keys.
      if (!account) {
        // Re-check: someone else may have taken the name while we waited.
        if (!this.keyMatches(name, publicKey)) return ws.close(CLOSE_NAME_TAKEN, nameTaken(name))
        this.bindName(name, publicKey)
      }
      const acc = this.accessFor(publicKey, name, kind, invitedAs, account, ws.pass)
      if (acc.state === 'pending') {
        waiting = true
        this.pending.set(ws, { key: publicKey, id: account || publicKey, name, kind, invitedAs, since: Date.now() })
        this.log(`[${this.name}] ${name} is waiting to be let in`)
        send(ws, jsonMessage(MSG_ACCESS, { state: 'pending', invitedAs, controlled: true }))
        this.broadcastMembers()
        onJoin()
        return
      }
      joined = true
      this.enter(ws, { key: publicKey, id: acc.id || account || publicKey, name, kind, role: acc.role, scopes: acc.scopes, scopesExcept: acc.scopesExcept || [], talk: acc.talk !== false, owner: acc.owner })
      onJoin()
    })
    ws.on('close', () => {
      if (this.pending.delete(ws)) this.broadcastMembers()
      if (this.access.has(ws) || this.conns.has(ws)) this.leave(ws)
    })
    send(ws, bytesMessage(MSG_AUTH, nonce))
  }

  /** Lets a signed-in (and, if needed, approved) person into the room. */
  enter (ws, a) {
    this.setAccess(ws, a)
    // Presence: an account's visit starts once it's let in (never while it waits for the owner).
    if (ws.pass && this.presence && !ws.visit) {
      ws.visit = this.presence.visitStart({ room: this.name, account: `${ws.pass.kind}:${ws.pass.sub}`, name: a.name, owner: !!a.owner })
      // The accounts API learns who owns a session from this report, and only the owner may
      // give people access there: tell it now rather than within the minute.
      if (a.owner) this.presence.tick().catch(() => {})
    }
    // Back with a pass from before the owner's last change: a newer one may allow more.
    const refresh = !a.owner && this.passPredatesChange(ws.pass) ? { refresh: true } : {}
    send(ws, jsonMessage(MSG_ACCESS, { ...this.accessMessage(a), ...refresh }))
    this.join(ws, a.name)
    this.broadcastMembers()
  }

  join (ws, name) {
    this.conns.set(ws, new Set())
    this.names.set(ws, name)
    send(ws, syncStep1Message(this.doc))
    const states = [...this.awareness.getStates().keys()]
    if (states.length) send(ws, awarenessMessage(this.awareness, states))
    send(ws, jsonMessage(MSG_CLAIMS, { claims: this.claimList() }))
    this.touch()
  }

  leave (ws) {
    if (ws.visit) { if (this.presence) this.presence.visitEnd(ws.visit); ws.visit = null }
    const ids = this.conns.get(ws)
    this.conns.delete(ws)
    this.names.delete(ws)
    if (this.access.delete(ws)) {
      this.guard.trackedOrigins.delete(ws)
      this.broadcastMembers()
    }
    if (ids && ids.size) {
      awarenessProtocol.removeAwarenessStates(this.awareness, [...ids], null)
      // Forget their clocks too: back after a drop, a client sends the same state at the
      // same clock, which would be ignored until its next renewal.
      for (const id of ids) this.awareness.meta.delete(id)
    }
    if (this.conns.size === 0) {
      this.save()
      this.touch()
      this.onEmpty && this.onEmpty()
    }
  }

  handle (ws, buf) {
    const dec = decoding.createDecoder(buf)
    const type = decoding.readVarUint(dec)
    if (type === MSG_SYNC) {
      if (this.full) {
        // Over quota: still answer "what do you have?" so people can read, but refuse new data.
        const sub = decoding.readVarUint(decoding.createDecoder(buf.subarray(1)))
        if (sub !== syncProtocol.messageYjsSyncStep1) {
          ws.close(CLOSE_ROOM_FULL, 'room is over the size limit')
          return
        }
      }
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_SYNC)
      syncProtocol.readSyncMessage(dec, enc, this.doc, ws)
      if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc))
    } else if (type === MSG_AWARENESS) {
      const update = decoding.readVarUint8Array(dec)
      if (!this.presenceAllowed(ws, update)) return this.log(`[${this.name}] dropped presence from ${this.names.get(ws)} under another name`)
      awarenessProtocol.applyAwarenessUpdate(this.awareness, update, ws)
    } else if (type === MSG_QUERY_AWARENESS) {
      send(ws, awarenessMessage(this.awareness, [...this.awareness.getStates().keys()]))
    } else if (type === MSG_CLAIM) {
      let req = {}
      let reply
      try {
        req = JSON.parse(decoding.readVarString(dec))
        reply = { id: req.id, ...this.claimRequest(this.claimant(ws), req) }
        this.noteActivity(this.holderKeys(ws))
      } catch (err) {
        return send(ws, jsonMessage(MSG_CLAIMS, { claims: this.claimList(), reply: { id: req.id, ok: false, error: err.message } }))
      }
      this.saveMeta()
      const claims = this.claimList()
      for (const other of this.conns.keys()) {
        send(other, jsonMessage(MSG_CLAIMS, other === ws ? { claims, reply } : { claims }))
      }
    } else if (type === MSG_ADMIN) {
      let req = {}
      let reply
      try {
        req = JSON.parse(decoding.readVarString(dec))
        reply = { id: req.id, ...this.adminRequest(ws, req) }
      } catch (err) {
        reply = { id: req.id, ok: false, error: err.message }
      }
      if (reply.ok) this.broadcastMembers(ws, reply)
      else {
        const a = this.access.get(ws)
        send(ws, jsonMessage(MSG_MEMBERS, { members: this.memberList(), sessionName: this.meta.name || '', admitBy: this.admitBy, pending: this.personCanAdmit(a) ? this.pendingList() : [], reply }))
      }
    }
  }

  destroy () {
    clearTimeout(this.unloadTimer)
    this.save()
    this.guard.destroy()
    this.awareness.destroy()
    this.doc.destroy()
  }

  /** Stored-file ids the document still points at. */
  storedIds () {
    const ids = new Set()
    for (const b of this.blobs.values()) if (b && b.stored && b.stored.id) ids.add(b.stored.id)
    return ids
  }
}

const TALK_WHY = "you can't post in this session"
// What an app's activity entries look like (session.js recordActivity, relay-mcp.js quilt_write).
const ACTIVITY_FIELDS = ['by', 'path', 'kind', 'detail', 'ts']
const ACTIVITY_KINDS = ['created', 'edited', 'deleted']
const ACTIVITY_DETAIL = /^(\+\d+ -\d+|\d+ bytes)?$/
const nameTaken = (name) => `The name "${name}" belongs to someone else in this room; pick another name`

/** A saved member's access, in the relay's shape (members saved before access types may talk and have no exceptions). */
const memberAccess = (m) => ({ role: m.role, scopes: m.scopes || [], scopesExcept: m.scopesExcept || [], talk: m.talk !== false })

/** Closes the connection when its pass runs out, unless a newer one arrives first. */
function trackPass (ws, pass) {
  ws.pass = pass
  clearTimeout(ws.passTimer)
  const left = Math.min(Math.max(pass.exp - Date.now(), 0), 2 ** 31 - 1)
  ws.passTimer = setTimeout(() => ws.close(CLOSE_PASS_EXPIRED, PASS_EXPIRED), left)
}

/** A MSG_PASS: a valid pass for the same account (or agent) and key extends the connection. */
function renewPass (ws, buf) {
  let next = null
  try {
    const dec = decoding.createDecoder(buf)
    decoding.readVarUint(dec)
    next = verifyPass(String(JSON.parse(decoding.readVarString(dec)).pass || ''), ws.passKey)
  } catch {}
  if (!next || next.sub !== ws.pass.sub || next.kind !== ws.pass.kind || next.key !== ws.pass.key || next.room !== ws.pass.room) return false
  trackPass(ws, next)
  return true
}

function send (ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(msg, (err) => { if (err) ws.terminate() })
}

export function startServer ({ port = 4321, host = '0.0.0.0', dataDir = null, log = console.log, presenceOptions = {}, ...opts } = {}) {
  const cfg = relayConfig(opts)
  const passKey = cfg.passPublicKey ? parsePublicKey(cfg.passPublicKey) : null
  if (cfg.passPublicKey && !passKey) throw new Error('QUILT_PASS_PUBLIC_KEY is not an Ed25519 public key (spki, base64url)')
  /** With sign-in on: the request's valid pass, or null. With it off: an empty pass. */
  const httpPass = (req, room = '') => {
    if (!passKey) return {}
    const p = verifyPass(String(req.headers['x-quilt-pass'] || ''), passKey)
    // A room pass is good in its own room only.
    return p && (!p.room || !room || p.room === room) ? p : null
  }
  // Who a new session counts against: their account with sign-in on, otherwise their address.
  const starterOf = (pass, req) => pass && pass.sub ? `${pass.kind}:${pass.sub}` : clientIp(req)
  // Without sign-in the limit is per address, and the message says so (as before).
  const TOO_MANY = passKey ? 'too many new sessions; try again later' : 'too many new sessions from this address; try again later'
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true })
  // Who is in which session, for the dashboard (presence.js). Off unless both settings are set,
  // and then only for connections with a pass. Visits a crash left open are ended now.
  const presence = cfg.apiUrl && cfg.relayApiSecret
    ? new PresenceReporter({ apiUrl: cfg.apiUrl, secret: cfg.relayApiSecret, file: dataDir ? path.join(dataDir, PRESENCE_FILE) : null, log, ...presenceOptions })
    : null
  if (presence) {
    const ended = presence.load()
    if (ended) log(`presence: ended ${ended} visit(s) left open by the last run`)
    presence.start()
  }
  const rooms = new Map() // loaded rooms only
  const ipConns = new Map()
  // New sessions are rate-limited per account when sign-in is on, otherwise per address.
  const newRooms = new Map() // starter -> creation timestamps in the last hour
  const canCreate = (starter) => {
    if (!cfg.maxNewRoomsPerHour) return true
    const cutoff = Date.now() - 60 * 60 * 1000
    const recent = (newRooms.get(starter) || []).filter((t) => t > cutoff)
    if (recent.length) newRooms.set(starter, recent); else newRooms.delete(starter)
    return recent.length < cfg.maxNewRoomsPerHour
  }
  const noteCreated = (starter) => newRooms.set(starter, [...(newRooms.get(starter) || []), Date.now()])

  const tooBig = new Set() // stored rooms already reported as too big to load
  /** A stored room far over the limit would run the relay out of memory while loading. */
  const tooBigToLoad = (name) => {
    if (!dataDir || rooms.has(name)) return false
    let size = 0
    try { size = fs.statSync(path.join(dataDir, `${name}.ydoc`)).size } catch { return false }
    if (size <= cfg.maxRoomBytes * 2) return false
    if (!tooBig.has(name)) { tooBig.add(name); log(`[${name}] too big to load (${Math.round(size / MB)} MB stored, limit ${Math.round(cfg.maxRoomBytes / MB)} MB); refusing it`) }
    return true
  }

  const unreadable = new Set() // stored rooms whose files could not be read, until they can
  /** Why getRoom gave null: the HTTP status and message to refuse with. */
  const refused = (name) => unreadable.has(name) ? [503, UNREADABLE] : [413, TOO_BIG]

  /** The room, loading it if needed; null if it's too big to load, or its files can't be read. */
  let webhooks = null // hosted agents' webhook subscriptions (set below, once `hosted` exists)
  let adoptHosted = null // puts back hosted agents waiting on a room (set below, once `hosted` exists)
  const getRoom = (name) => {
    let room = rooms.get(name)
    if (!room) {
      if (tooBigToLoad(name)) return null
      try {
        room = new Room(name, dataDir, cfg, log)
      } catch (err) {
        if (!err.unreadable) throw err
        // Logged once, not on every retry; tried again each time, in case the operator repaired it.
        if (!unreadable.has(name)) { unreadable.add(name); log(`[${name}] ${err.message}; refusing it, and leaving its files alone`) }
        return null
      }
      unreadable.delete(name)
      rooms.set(name, room)
      if (webhooks) webhooks.watch(room) // hosted agents' webhooks fire on its chat and board
      if (adoptHosted) adoptHosted(room)
      room.presence = presence
      // Idle rooms are saved and dropped from memory (only when they're on disk).
      room.onEmpty = () => {
        if (!dataDir || rooms.get(name) !== room) return
        clearTimeout(room.unloadTimer)
        room.unloadTimer = setTimeout(() => {
          if (room.conns.size || rooms.get(name) !== room) return
          collectStored(room)
          room.destroy()
          rooms.delete(name)
        }, cfg.idleUnloadMs)
      }
      room.onEnd = () => {
        if (room.ended) return
        room.ended = true
        for (const ws of [...room.conns.keys(), ...room.pending.keys()]) if (!ws.hosted) ws.close(CLOSE_ENDED, 'The owner ended this session')
        clearTimeout(room.unloadTimer)
        room.guard.destroy(); room.awareness.destroy(); room.doc.destroy()
        if (rooms.get(name) === room) rooms.delete(name)
        removeRoomData(name)
        // A tombstone keeps the room refused for good, instead of letting a new one start under the same name.
        if (dataDir) {
          const now = Date.now()
          try {
            fs.writeFileSync(path.join(dataDir, `${name}.json`), JSON.stringify({ ended: true, endedAt: now, lastActive: now }))
          } catch (err) { log(`[${name}] could not write its tombstone: ${err.message}`) }
        }
        log(`[${name}] ended by its owner`)
      }
    }
    return room
  }
  // A room that was probed but never created (bad secret / no key) shouldn't linger.
  const dropIfUnused = (room) => {
    if (!room.exists && !room.conns.size) { room.destroy(); rooms.delete(room.name) }
  }

  const clientIp = (req) => {
    if (cfg.trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      if (fwd) return fwd
    }
    return req.socket.remoteAddress || 'unknown'
  }

  // AI links: a browser's token -> the session and name that browser is in now,
  // so the person's AI can use /mcp/<token> (see relay-mcp.js). Tokens are stored hashed.
  const linksFile = dataDir && path.join(dataDir, 'agent-links.json')
  const links = new Map()
  try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(linksFile, 'utf8')))) links.set(k, v) } catch {}
  let linksTimer = null
  const saveLinks = () => {
    if (!linksFile || linksTimer) return
    linksTimer = setTimeout(() => {
      linksTimer = null
      const cutoff = Date.now() - 30 * DAY
      for (const [k, v] of links) if ((v.tabSeenAt || 0) < cutoff) links.delete(k)
      try { fs.writeFileSync(linksFile, JSON.stringify(Object.fromEntries(links))) } catch {}
    }, 2000)
    linksTimer.unref()
  }
  const tokenKey = (t) => hash(t).toString('hex')
  const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/

  // Hosted agents: which session each one (by pass id) is in, so every tool call over
  // /mcp knows its room. Kept on disk so a relay restart doesn't drop them out.
  // The newest Quilt this relay knows of (its own build, or GitHub's latest), so agents are told to update.
  const updates = new UpdateCheck().start()
  const hostedFile = dataDir && path.join(dataDir, 'hosted-agents.json')
  const hosted = new Map()
  try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(hostedFile, 'utf8')))) hosted.set(k, v) } catch {}
  let hostedTimer = null
  const writeHosted = () => {
    hostedTimer = null
    const cutoff = Date.now() - 30 * DAY
    for (const [k, v] of hosted) if ((v.seenAt || 0) < cutoff) hosted.delete(k)
    try { fs.writeFileSync(hostedFile, JSON.stringify(Object.fromEntries(hosted))) } catch {}
  }
  const saveHosted = () => {
    if (!hostedFile || hostedTimer) return
    hostedTimer = setTimeout(writeHosted, 2000)
    hostedTimer.unref()
  }
  webhooks = hostedWebhooks({ hosted, saveHosted, log, fetch: opts.webhookFetch, delays: opts.webhookDelays })
  for (const room of rooms.values()) webhooks.watch(room)
  // Hosted agents waiting to be let in are back on the owner's list when their room loads,
  // without having to call a tool first; one the owner turns away is told on its next call.
  adoptHosted = (room) => {
    for (const [id, h] of hosted) if (h.room === room.name && h.pending && !h.denied) room.restoreHosted(id, h)
    room.onHostedDenied = (id) => {
      const h = hosted.get(id)
      if (h && h.room === room.name && h.pending) { h.denied = true; saveHosted() }
    }
  }
  for (const room of rooms.values()) adoptHosted(room)

  // Files shared in chat are stored on the relay, not in the synced project.
  const filesDir = path.join(dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-relay-')), 'files')
  // Large files, already encrypted by the apps. See blobstore.js.
  const store = makeStore(cfg, path.join(path.dirname(filesDir), 'blobs'))
  const storedBytes = (room) => Object.values(room.meta.blobs || {}).reduce((n, b) => n + (b.size || 0), 0)
  /** Deletes everything a room left on the relay and in storage. */
  const removeRoomData = (name) => {
    try {
      if (dataDir) {
        fs.rmSync(path.join(dataDir, `${name}.ydoc`), { force: true })
        fs.rmSync(path.join(dataDir, `${name}.json`), { force: true })
      }
      fs.rmSync(path.join(filesDir, name), { recursive: true, force: true })
    } catch (err) { log(`[${name}] could not delete its files: ${err.message}`) }
    store.removeRoom(name).catch((err) => log(`[${name}] could not delete stored files: ${err.message}`))
  }
  /** Deletes stored files nothing points at any more (a day's grace for uploads in flight, or apps still offline). */
  const collectStored = (room) => {
    const blobs = room.meta.blobs || {}
    const used = room.storedIds()
    const cutoff = Date.now() - DAY
    const unused = Object.keys(blobs).filter((id) => !used.has(id) && (blobs[id].ts || 0) < cutoff)
    if (!unused.length) return
    for (const id of unused) delete blobs[id]
    room.saveMeta()
    store.remove(room.name, unused).catch((err) => log(`[${room.name}] could not delete stored files: ${err.message}`))
  }
  /** Refuses an ended room's tombstone without loading it into memory. */
  const roomEnded = (name) => {
    if (!dataDir) return false
    try { return !!JSON.parse(fs.readFileSync(path.join(dataDir, `${name}.json`), 'utf8')).ended } catch { return false }
  }

  // Public: the app's relay check reads this. It says nothing about who's using the relay.
  const health = () => ({ ok: true, version: 1, requiresKey: !!cfg.relayKey })

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const text = (code, msg) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }); res.end(msg) }
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(health()))
    }
    if (url.pathname === '/logo.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' })
      return res.end(fs.readFileSync(LOGO))
    }
    const j = url.pathname.match(/^\/join\/([A-Za-z0-9_-]{1,64})\/?$/)
    if (j) {
      // Invites live on the website now. Browsers keep the #secret across the redirect.
      res.writeHead(302, { location: `https://${JOIN_HOST}/${j[1]}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
      return res.end()
    }
    if (url.pathname === '/agent/link' && req.method === 'POST') {
      const pass = httpPass(req)
      if (!pass) return text(401, SIGN_IN)
      return readJson(req, 4096, (err, body) => {
        if (err) return text(400, err.message)
        const { token, room: roomName, secret, name, tool } = body || {}
        if (!TOKEN_RE.test(String(token)) || !ROOM_RE.test(String(roomName)) || typeof name !== 'string' || !name.trim()) return text(400, 'bad link')
        if (pass.room && pass.room !== roomName) return text(401, SIGN_IN)
        if (roomEnded(roomName)) return text(410, ENDED_MESSAGE)
        const room = getRoom(roomName)
        if (!room) return text(...refused(roomName))
        if (!room.exists || room.authorize(String(secret || ''), '') !== 'editor') { dropIfUnused(room); return text(403, 'wrong room secret') }
        if (!room.conns.size) room.onEmpty && room.onEmpty()
        const k = tokenKey(token)
        const prev = links.get(k) || {}
        links.set(k, { room: roomName, name: (pass.name || name).trim().slice(0, 60), tool: String(tool || '').slice(0, 40), tabSeenAt: Date.now(), aiSeenAt: prev.aiSeenAt || 0 })
        saveLinks()
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, aiSeenAt: prev.aiSeenAt || 0 }))
      })
    }
    if (url.pathname === '/mcp') {
      // Hosted agents (and anyone with a pass): session tools over HTTP, no app needed.
      if (!passKey) return text(404, 'this relay has sign-in off; hosted agents need it on')
      const pass = httpPass(req)
      if (!pass) return text(401, SIGN_IN)
      return handleHostedMcp({ req, res, pass, relay: { getRoom, roomEnded, refused, hosted, saveHosted, webhooks, log, endedMessage: ENDED_MESSAGE, updates } })
        .catch((err) => { log(`mcp error: ${err.message}`); if (!res.headersSent) text(500, 'mcp error') })
    }
    const mm = url.pathname.match(/^\/mcp\/([A-Za-z0-9_-]{20,64})$/)
    if (mm) {
      // An AI link carries no pass, so with sign-in on it would get into a session without one.
      // Agents join as their own members now; links saved before that stop working here.
      if (passKey) return text(401, SIGN_IN)
      const k = tokenKey(mm[1])
      const link = links.get(k) || null
      let room = null
      if (link) {
        room = getRoom(link.room)
        if (!room) return text(...refused(link.room))
        if (!room.exists) { dropIfUnused(room); room = null } else {
          link.aiSeenAt = Date.now()
          saveLinks()
        }
      }
      handleAgentMcp({ req, res, room, link: room ? link : null, toolHint: url.searchParams.get('tool') || '', updates })
        .catch((err) => { log(`mcp error: ${err.message}`); if (!res.headersSent) text(500, 'mcp error') })
        .finally(() => { if (room && !room.conns.size && room.onEmpty) room.onEmpty() })
      return
    }
    const bm = url.pathname.match(/^\/blobs\/([A-Za-z0-9_-]{1,64})\/([a-f0-9]{32})\/(upload|download|data)$/)
    if (bm) {
      const [, name, id, action] = bm
      if (roomEnded(name)) return text(410, ENDED_MESSAGE)
      if (action === 'data') {
        // The disk store's signed links: no secret needed, the signature is the permission.
        if (!(store instanceof DiskStore)) return text(404, 'not found')
        const method = req.method === 'PUT' ? 'PUT' : 'GET'
        const n = url.searchParams.get('n')
        if (url.searchParams.get('m') !== method || !store.verify(name, id, method, url.searchParams.get('exp'), url.searchParams.get('sig'), method === 'PUT' ? Number(n) : undefined)) return text(403, 'this link has expired')
        const file = store.file(name, id)
        if (method === 'GET') return streamFile(res, file, text)
        return receiveBlob(req, file, Number(n), (err) => err ? text(err.code || 500, err.message) : text(201, 'stored'))
      }
      if (req.method !== 'POST') return text(405, 'method not allowed')
      const pass = httpPass(req, name)
      if (!pass) return text(401, SIGN_IN)
      const starter = starterOf(pass, req)
      const room = getRoom(name)
      if (!room) return text(...refused(name))
      const creating = !room.exists
      if (creating && !canCreate(starter)) { dropIfUnused(room); return text(429, TOO_MANY) }
      const auth = room.authorize(req.headers['x-quilt-secret'] || '', req.headers['x-quilt-key'] || '')
      if (auth === 'need-key' || auth === 'bad-secret') {
        dropIfUnused(room)
        return text(auth === 'need-key' ? 403 : 401, auth === 'need-key' ? 'this relay needs a key to create rooms' : 'wrong room secret')
      }
      if (creating) noteCreated(starter)
      const done = () => { if (!room.conns.size && room.onEmpty) room.onEmpty() }
      if (passKey && !room.letIn(pass)) { done(); return text(403, NOT_LET_IN) }
      return readJson(req, 1024, async (err, body) => {
        try {
          if (err) return text(400, err.message)
          room.meta.blobs = room.meta.blobs || {}
          if (action === 'download') {
            if (!room.meta.blobs[id]) return text(404, 'no such file')
            return json(200, await store.downloadTarget(name, id))
          }
          // The room secret and, with sign-in on, the person's own access: a view-only grant
          // with the edit link may not use up the room's storage.
          if (auth !== 'editor' || (passKey && room.httpAccess(pass)?.role === 'viewer')) return text(403, 'you can only view this session')
          const size = Number(body && body.size)
          if (!(size >= 0)) return text(400, 'size required')
          if (size > cfg.maxStoredFileBytes) return text(413, `files over ${Math.round(cfg.maxStoredFileBytes / MB)} MB can't be shared`)
          const others = storedBytes(room) - (room.meta.blobs[id]?.size || 0)
          if (others + size + dirSize(path.join(filesDir, name)) > cfg.maxRoomFileBytes) return text(413, 'this room has used its file storage quota')
          room.meta.blobs[id] = { size, ts: Date.now() }
          room.startLargeFiles()
          room.saveMeta()
          json(200, await store.uploadTarget(name, id, size))
        } catch (e) {
          log(`[${name}] storage error: ${e.message}`)
          if (!res.headersSent) text(502, 'file storage is unavailable right now')
        } finally { done() }
      })
    }
    const m = url.pathname.match(/^\/files\/([A-Za-z0-9_-]{1,64})(?:\/([a-f0-9]{32}))?$/)
    if (!m) return text(404, 'not found')

    const [, name, id] = m
    if (roomEnded(name)) return text(410, ENDED_MESSAGE)
    const pass = httpPass(req, name)
    if (!pass) return text(401, SIGN_IN)
    const starter = starterOf(pass, req)
    const room = getRoom(name)
    if (!room) return text(...refused(name))
    const creating = !room.exists
    if (creating && !canCreate(starter)) { dropIfUnused(room); return text(429, TOO_MANY) }
    const auth = room.authorize(req.headers['x-quilt-secret'] || req.headers['x-cowove-secret'] || '', req.headers['x-quilt-key'] || req.headers['x-cowove-key'] || '')
    if (creating && auth !== 'need-key' && auth !== 'bad-secret') noteCreated(starter)
    if (auth === 'need-key' || auth === 'bad-secret') {
      dropIfUnused(room)
      return text(auth === 'need-key' ? 403 : 401, auth === 'need-key' ? 'this relay needs a key to create rooms' : 'wrong room secret')
    }
    if (passKey && !room.letIn(pass)) {
      if (!room.conns.size && room.onEmpty) room.onEmpty()
      return text(403, NOT_LET_IN)
    }
    const dir = path.join(filesDir, name)
    if (req.method === 'POST' && !id) {
      // A chat file is a post: someone who may not post may not send one.
      if (passKey && room.httpAccess(pass)?.talk === false) {
        if (!room.conns.size && room.onEmpty) room.onEmpty()
        return text(403, TALK_REFUSED)
      }
      // Chat files and stored large files share one quota.
      const used = dirSize(dir) + storedBytes(room)
      const incoming = Number(req.headers['content-length'] || 0)
      if (used + incoming > cfg.maxRoomFileBytes) return text(413, 'this room has used its file storage quota')
      return receiveFile(req, dir, cfg.maxRoomFileBytes - used, (err, newId) => err ? text(err.code || 500, err.message) : text(201, newId))
    }
    if (req.method === 'GET' && id) return streamFile(res, path.join(dir, id), text)
    text(405, 'method not allowed')
  })
  // One message can't be bigger than a whole room may be.
  const wss = new WebSocketServer({ noServer: true, maxPayload: Math.max(MB, Math.min(64 * MB, cfg.maxRoomBytes)) })

  httpServer.on('upgrade', (req, socket, head) => {
    let url, name
    try {
      url = new URL(req.url, 'http://x')
      name = decodeURIComponent(url.pathname.slice(1))
    } catch {
      return reject(socket, 400, 'Bad room name')
    }
    // Secrets come in headers, which proxies don't log; the query string is only still read
    // for clients from before 0.3.2, and goes away in the release after. Never log req.url.
    const header = (n) => (req.headers[n] === undefined ? '' : String(req.headers[n]))
    const secret = header('x-quilt-secret') || url.searchParams.get('secret') || ''
    const publicKey = url.searchParams.get('key') || ''
    const relayKey = header('x-quilt-key') || header('x-cowove-key') || url.searchParams.get('relayKey') || ''
    const viewSecret = header('x-quilt-view-secret') || url.searchParams.get('viewSecret') || ''
    if (!ROOM_RE.test(name)) return reject(socket, 400, 'Bad room name')
    // With sign-in on, nobody gets further without a pass, and who they are comes from it.
    const pass = passKey ? verifyPass(header('x-quilt-pass') || url.searchParams.get('pass') || '', passKey) : null
    if (passKey && (!pass || pass.key !== publicKey || (pass.room && pass.room !== name))) return reject(socket, 401, SIGN_IN)
    const person = pass ? pass.name : (url.searchParams.get('name') || '').trim()
    const kind = pass ? (pass.kind === 'agent' ? 'agent' : 'human') : (url.searchParams.get('kind') === 'agent' ? 'agent' : 'human')
    // People and agents come from different id spaces, so the kind is part of who they are.
    const account = pass ? `${pass.kind}:${pass.sub}` : ''
    // Checked before the room is touched: a room's creator is recorded by this key (see authorize).
    if (!publicKey) return reject(socket, 400, 'This relay needs a newer quilt; please update')
    const key = parsePublicKey(publicKey)
    if (!person || person.length > MAX_NAME || !key) return reject(socket, 400, 'Bad name or identity key')
    if (roomEnded(name)) return reject(socket, 410, ENDED_MESSAGE)
    const ip = clientIp(req)
    const starter = pass ? account : ip
    if ((ipConns.get(ip) || 0) >= cfg.maxConnsPerIp) return reject(socket, 429, 'Too many connections')
    const room = getRoom(name)
    if (!room) return reject(socket, ...refused(name))
    const features = String(url.searchParams.get('features') || '').split(',')
    const creating = !room.exists
    if (creating && !canCreate(starter)) { dropIfUnused(room); return reject(socket, 429, 'Too many new sessions') }
    const auth = room.authorize(secret, relayKey, viewSecret, publicKey)
    if (creating && auth !== 'need-key' && auth !== 'bad-secret') noteCreated(starter)
    if (auth === 'need-key' || auth === 'bad-secret') {
      dropIfUnused(room)
      return reject(socket, auth === 'need-key' ? 403 : 401, auth === 'need-key' ? 'Relay key required to create rooms' : 'Wrong room secret')
    }
    // Checked after the secret, so only members learn what the session needs.
    if (room.meta.largeFiles && !features.includes('large-files')) {
      if (!room.conns.size && room.onEmpty) room.onEmpty() // don't keep it in memory for nobody
      return reject(socket, 400, NEEDS_UPDATE)
    }
    if (!pass && !room.keyMatches(person, publicKey)) return reject(socket, 403, nameTaken(person))
    wss.handleUpgrade(req, socket, head, (ws) => {
      // A frame over maxPayload or a reset mid-frame is this socket's problem, not
      // the relay's: ws closes the socket itself once the error has a listener.
      ws.on('error', (err) => log(`[${name}] dropping ${person}: ${err.message}`))
      ws.features = features
      if (pass) { ws.passKey = passKey; trackPass(ws, pass) }
      ipConns.set(ip, (ipConns.get(ip) || 0) + 1)
      ws.isAlive = true
      ws.on('pong', () => { ws.isAlive = true })
      ws.on('close', () => {
        clearTimeout(ws.passTimer)
        const n = (ipConns.get(ip) || 1) - 1
        if (n) ipConns.set(ip, n)
        else ipConns.delete(ip)
      })
      room.admit(ws, person, publicKey, key, { kind, invitedAs: auth, account }, () => {
        log(`[${name}] ${person} connected (${room.conns.size} online)`)
        ws.on('close', () => log(`[${name}] ${person} left (${room.conns.size} online)`))
        if (room.full) log(`[${name}] ${person} joined while over quota (read-only)`)
      })
    })
  })

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue }
      ws.isAlive = false
      ws.ping()
    }
    for (const room of rooms.values()) if (!room.ended) room.sweepClaims()
  }, 30000)

  // Delete rooms nobody has opened for a while (hosted relays shouldn't grow forever).
  const sweep = () => {
    if (!dataDir || !cfg.roomTtlDays) return
    const cutoff = Date.now() - cfg.roomTtlDays * DAY
    let removed = 0
    for (const f of fs.readdirSync(dataDir)) {
      if (!f.endsWith('.json') || f === 'agent-links.json') continue
      const name = f.slice(0, -5)
      if (!ROOM_RE.test(name)) continue
      if (rooms.has(name)) continue
      let meta
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'))
      } catch (err) {
        // Never delete what can't be read: it may be a session cut off mid-write, for the operator to repair.
        log(`[${name}] could not read its metadata (${err.message}); leaving it alone`)
        continue
      }
      if ((meta.lastActive || meta.createdAt || 0) > cutoff) continue
      removeRoomData(name)
      removed++
    }
    if (removed) log(`removed ${removed} room(s) idle for more than ${cfg.roomTtlDays} days`)
  }
  sweep()
  const sweeper = setInterval(sweep, 6 * 60 * 60 * 1000)
  sweeper.unref()

  return new Promise((resolve, reject) => {
    httpServer.once('error', (err) => { clearInterval(heartbeat); clearInterval(sweeper); reject(err) })
    httpServer.listen(port, host, () => {
      const actualPort = httpServer.address().port
      resolve({
        port: actualPort,
        config: cfg,
        rooms, // exposed for tests
        store, // exposed for tests
        presence, // exposed for tests
        sweep,
        close: async () => {
          clearInterval(heartbeat)
          clearInterval(sweeper)
          updates.stop()
          // A join or a denial in the last moments before a deploy is kept.
          if (hostedTimer) { clearTimeout(hostedTimer); writeHosted() }
          // Rooms are saved first, synchronously: Fly's kill timeout is about as long as
          // presence gets to reach the accounts API, so a hung or slow API must never be
          // able to delay saving a room's data.
          for (const ws of wss.clients) ws.terminate()
          for (const room of rooms.values()) room.destroy()
          rooms.clear()
          wss.close()
          // Every open visit ends now (even ones no `leave` got to yet), and the queue
          // gets one last, bounded try at the accounts API.
          if (presence) await presence.close()
          // An upload or download still in flight would otherwise hold close() open forever.
          const closed = new Promise((resolve) => httpServer.close(() => resolve()))
          httpServer.closeAllConnections()
          await closed
        }
      })
    })
  })
}

function dirSize (dir) {
  let total = 0
  try { for (const f of fs.readdirSync(dir)) total += fs.statSync(path.join(dir, f)).size } catch {}
  return total
}

function readJson (req, limit, done) {
  let size = 0
  const chunks = []
  req.on('data', (c) => {
    size += c.length
    if (size > limit) { req.destroy(); done(new Error('too large')) } else chunks.push(c)
  })
  req.on('end', () => {
    if (size > limit) return
    try { done(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { done(new Error('bad json')) }
  })
}

function receiveFile (req, dir, room, done) {
  const id = crypto.randomBytes(16).toString('hex')
  const file = path.join(dir, id)
  let out
  try {
    fs.mkdirSync(dir, { recursive: true })
    out = fs.createWriteStream(file)
  } catch { req.resume(); return done(Object.assign(new Error('could not save the file'), { code: 500 })) }
  const limit = Math.min(MAX_SHARED_FILE_BYTES, room)
  let size = 0
  let failed = false
  const fail = (code, message) => {
    if (failed) return
    failed = true
    out.destroy()
    fs.rm(file, { force: true }, () => {})
    done(Object.assign(new Error(message), { code }))
  }
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > limit) { fail(413, limit < MAX_SHARED_FILE_BYTES ? 'this room has used its file storage quota' : 'file too large'); req.destroy() }
  })
  req.on('error', () => fail(400, 'upload interrupted'))
  req.pipe(out)
  out.on('finish', () => { if (!failed) done(null, id) })
  out.on('error', (err) => fail(500, err.message))
}

/**
 * Sends a stored file. The file can vanish at any moment (the room ended, or
 * the sweep ran), so every step copes with that instead of throwing.
 */
function streamFile (res, file, text) {
  const rs = fs.createReadStream(file)
  rs.on('error', (err) => {
    if (!res.headersSent) text(err.code === 'ENOENT' || err.code === 'EISDIR' ? 404 : 500, 'no such file')
    else res.destroy()
  })
  rs.on('open', (fd) => {
    let size
    try { size = fs.fstatSync(fd).size } catch { rs.destroy(); return text(404, 'no such file') }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size })
    rs.pipe(res)
  })
}

/**
 * Streams a request body to `file`, refusing anything over `limit` bytes.
 * Stored files are written once: their ids come from their content, so one
 * that's already there is refused with 409 and left as it is.
 */
function receiveBlob (req, file, limit, done) {
  let size = 0
  let failed = false
  let drained = 0
  let out = null
  let tmp = null
  const fail = (code, message) => {
    if (failed) return
    failed = true
    if (out) { req.unpipe(out); out.destroy() }
    if (tmp) fs.rm(tmp, { force: true }, () => {})
    // Read what's left so the reply gets through, but not forever.
    req.resume()
    done(Object.assign(new Error(message), { code }))
  }
  req.on('data', (chunk) => {
    if (failed) { drained += chunk.length; if (drained > MB) req.destroy(); return }
    size += chunk.length
    if (size > limit) fail(413, 'file too large')
  })
  req.on('error', () => fail(400, 'upload interrupted'))
  if (fs.existsSync(file)) return fail(409, 'already stored')
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`
    out = fs.createWriteStream(tmp)
  } catch { return fail(500, 'could not save the file') }
  out.on('error', () => fail(500, 'could not save the file'))
  out.on('finish', () => {
    if (failed) return
    // link, unlike rename, never replaces a file that's already there. It
    // also fails if the room's folder is gone by now (it ended, or was swept).
    try {
      fs.linkSync(tmp, file)
    } catch (err) {
      return err.code === 'EEXIST' ? fail(409, 'already stored') : fail(500, 'could not save the file')
    }
    fs.rm(tmp, { force: true }, () => {})
    done(null)
  })
  req.pipe(out)
}

const TOO_BIG = 'Session over the size limit'
const UNREADABLE = "This session's data can't be read on the relay right now"
const ENDED_MESSAGE = 'The owner ended this session'
const NEEDS_UPDATE = 'This session needs a newer version of Quilt. Update Quilt, then join again.'
const SIGN_IN = 'Update Quilt and sign in to continue'
const NOT_LET_IN = "The session owner hasn't let you in yet."
const PASS_EXPIRED = 'Your sign-in expired. Reconnecting.'

function reject (socket, code, message) {
  socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}
