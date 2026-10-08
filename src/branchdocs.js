// The relay's branch documents: one Yjs document per branch a room's members
// work on, holding that branch's files (files, blobs, fileKeys) and what goes
// with them (merge records, the chronology, per-person tallies). The room's own
// document keeps everything room-wide. A branch document is loaded when someone
// joins it (or a hosted agent uses it), saved a second after each change, and
// unloaded once nobody has been on it for a while.
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'

// A folder without git syncs this key: the room's default branch (see Room.resolveKey).
export const DEFAULT_KEY = '∅'
export const MAX_BRANCH_KEY = 200
// Branch documents a room may have at once (an empty one still costs a meta entry, a
// broadcast to everyone on every create, and a loaded Y.Doc): refused in plain English past this.
export const MAX_BRANCHES = 50
export const BRANCH_IDLE_MS = 10 * 60 * 1000
// A branch nobody has been on this long leaves the session (never the default branch).
export const BRANCH_TTL_MS = 30 * 24 * 60 * 60 * 1000
// What a room's document keeps for everyone, whatever branch they're on. The rest is a branch's.
export const ROOM_TYPES = [['chat', 'array'], ['agentFeed', 'array'], ['activity', 'array'], ['commitRequests', 'map'], ['tasks', 'map']]

// eslint-disable-next-line no-control-regex
const NOT_IN_REFS = /[\u0000- \u007f~^:?*[\\]/

/**
 * Whether `key` may name a branch document: a git branch name (the rules of
 * `git check-ref-format --branch`, checked here since the relay has no git),
 * a detached commit (@ and 12 hex digits), or ∅.
 */
export function validBranchKey (key) {
  if (typeof key !== 'string' || !key || key.length > MAX_BRANCH_KEY) return false
  if (key === DEFAULT_KEY || /^@[0-9a-f]{12}$/.test(key)) return true
  if (key === 'HEAD' || key === '@' || key.startsWith('-') || NOT_IN_REFS.test(key)) return false
  if (key.includes('..') || key.includes('@{') || key.includes('//')) return false
  if (key.startsWith('/') || key.endsWith('/') || key.endsWith('.')) return false
  return key.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'))
}

/** A branch document's file name: the key in base64url (branch names have slashes, and ∅). */
export const branchFileName = (key) => `${Buffer.from(key, 'utf8').toString('base64url')}.ydoc`

/** Whether a document whose state vector is `have` holds everything one at `want` holds. */
export function covers (have, want) {
  const h = Y.decodeStateVector(have)
  for (const [client, clock] of Y.decodeStateVector(want)) if ((h.get(client) || 0) < clock) return false
  return true
}

/**
 * A room saved before branch documents kept everything in one document. Its
 * room-wide parts are copied into a new room document (returned) and emptied
 * in the old one, which stays as it is otherwise: it becomes the default
 * branch's document, so every app's saved copy of it still matches.
 */
export function splitLegacyDoc (legacy) {
  const room = new Y.Doc()
  room.transact(() => {
    for (const [name, kind] of ROOM_TYPES) {
      if (kind === 'array') room.getArray(name).push(legacy.getArray(name).toJSON())
      else for (const [k, v] of Object.entries(legacy.getMap(name).toJSON())) room.getMap(name).set(k, v)
    }
  })
  legacy.transact(() => {
    for (const [name, kind] of ROOM_TYPES) {
      if (kind === 'array') { const a = legacy.getArray(name); if (a.length) a.delete(0, a.length) } else {
        const m = legacy.getMap(name)
        for (const k of [...m.keys()]) m.delete(k)
      }
    }
  })
  return room
}

export class BranchStore {
  /**
   * @param {object} o
   * @param {string|null} o.dir  where this room's branch documents are saved (null: memory only)
   * @param {number} [o.idleMs]  a document nobody is on is unloaded this long after its last use
   * @param {(entry: object) => void} o.onLoad  wires a document just loaded (listeners, the guard)
   * @param {(entry: object) => void} [o.onSave]  after each save
   * @param {(err: Error) => void} [o.onDiskError]  a save failed
   */
  constructor ({ dir, idleMs = BRANCH_IDLE_MS, onLoad, onSave = () => {}, onDiskError = () => {} }) {
    this.dir = dir || null
    this.idleMs = idleMs
    this.onLoad = onLoad
    this.onSave = onSave
    this.onDiskError = onDiskError
    this.loaded = new Map() // key -> { key, doc, files, blobs, fileKeys, conns, bytes, saveTimer, unloadTimer }
    this.sizes = new Map() // key -> bytes on disk, for the room's size limit
  }

  file (key) { return this.dir ? path.join(this.dir, branchFileName(key)) : null }

  /** Whether branch `key` has a saved document. */
  stored (key) { return !!this.dir && fs.existsSync(this.file(key)) }

  /** The loaded entry for `key`, or null (never loads). */
  get (key) { return this.loaded.get(key) || null }

  /** Bytes branch `key` takes: its loaded size, or its file's. */
  size (key) {
    const e = this.loaded.get(key)
    if (e) return e.bytes
    if (!this.sizes.has(key)) {
      let n = 0
      try { n = fs.statSync(this.file(key)).size } catch {}
      this.sizes.set(key, n)
    }
    return this.sizes.get(key)
  }

  /** Branch `key`'s entry, its document loaded from disk (or new and empty). Throws { unreadable } when its file can't be read. */
  load (key) {
    let e = this.loaded.get(key)
    if (e) { this.touch(e); return e }
    const doc = new Y.Doc()
    let bytes = 0
    if (this.stored(key)) {
      try {
        const buf = fs.readFileSync(this.file(key))
        Y.applyUpdate(doc, buf)
        bytes = buf.length
      } catch (err) {
        doc.destroy()
        throw Object.assign(new Error(`could not read branch ${key}: ${err.message}`), { unreadable: true })
      }
    }
    e = { key, doc, files: doc.getMap('files'), blobs: doc.getMap('blobs'), fileKeys: doc.getMap('fileKeys'), conns: new Set(), bytes, saveTimer: null, unloadTimer: null }
    this.loaded.set(key, e)
    this.onLoad(e)
    this.touch(e)
    return e
  }

  subscribe (ws, key) {
    const e = this.load(key)
    e.conns.add(ws)
    this.touch(e)
    return e
  }

  unsubscribe (ws, key) {
    const e = this.loaded.get(key)
    if (!e) return
    e.conns.delete(ws)
    this.touch(e)
  }

  /** Used just now: a document nobody is on is unloaded idleMs from now (only one that can be saved). */
  touch (e) {
    clearTimeout(e.unloadTimer)
    e.unloadTimer = null
    if (e.conns.size || !this.dir) return
    e.unloadTimer = setTimeout(() => this.unload(e.key), this.idleMs)
    e.unloadTimer.unref?.()
  }

  unload (key) {
    const e = this.loaded.get(key)
    if (!e || e.conns.size) return
    if (this.save(e)) this.drop(e)
  }

  drop (e) {
    clearTimeout(e.saveTimer)
    clearTimeout(e.unloadTimer)
    if (e.guard) e.guard.destroy()
    e.doc.destroy()
    this.loaded.delete(e.key)
  }

  scheduleSave (e) {
    if (!this.dir || e.saveTimer) return
    e.saveTimer = setTimeout(() => this.save(e), 1000)
  }

  /** Saves a loaded document now; false when the disk refused (it then stays loaded). */
  save (e) {
    clearTimeout(e.saveTimer)
    e.saveTimer = null
    if (!this.dir) return true
    const state = Y.encodeStateAsUpdate(e.doc)
    if (!this.write(e.key, state)) return false
    e.bytes = state.length
    this.onSave(e)
    return true
  }

  /** Writes a branch document's state whole, then renames it: a crash leaves the old file, never a cut-off one. */
  write (key, state) {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const f = this.file(key)
      fs.writeFileSync(f + '.tmp', state)
      fs.renameSync(f + '.tmp', f)
      this.sizes.set(key, state.length)
      return true
    } catch (err) {
      this.onDiskError(err)
      return false
    }
  }

  /** Branch `from` is called `to` from now on (∅ taken by the session's first real branch). */
  rename (from, to) {
    const e = this.loaded.get(from)
    if (e) { this.loaded.delete(from); e.key = to; this.loaded.set(to, e) }
    if (this.stored(from)) {
      try { fs.renameSync(this.file(from), this.file(to)) } catch (err) { this.onDiskError(err) }
    }
    if (this.sizes.has(from)) { this.sizes.set(to, this.sizes.get(from)); this.sizes.delete(from) }
  }

  /** Deletes branch `key`'s document, loaded or not. */
  remove (key) {
    const e = this.loaded.get(key)
    if (e) this.drop(e)
    if (this.dir) fs.rmSync(this.file(key), { force: true })
    this.sizes.delete(key)
  }

  /** Saves and drops every loaded document (the room is leaving memory). */
  destroy () { for (const e of [...this.loaded.values()]) { this.save(e); this.drop(e) } }

  /** Drops every loaded document without saving (the room was ended and its data deleted). */
  discard () { for (const e of [...this.loaded.values()]) this.drop(e) }
}
