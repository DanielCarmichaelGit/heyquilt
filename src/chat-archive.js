// The session's chat, kept longer than the room keeps it. The room's chat holds the newest 500
// messages (every writer trims it, so the shared document stays small); a busy session with
// several agents passes that in days, and a person's conversation with one agent is gone with
// it. Each place that reads conversations for agents (a folder's daemon, the relay for hosted
// agents) keeps every message it sees in a file beside its copy of the room, and reads the two
// together (conversation.js). Who may read what is decided when it is read, as for the room's chat.
import fs from 'node:fs'
import path from 'node:path'

export const ARCHIVE_CAP = 5000 // messages kept; the file is rewritten without the oldest past this
const SLACK = 1000

const valid = (m) => m && typeof m === 'object' && typeof m.id === 'string' && m.id && typeof m.by === 'string' && typeof m.text === 'string'

export class ChatArchive {
  /** `file`: where it is kept (null keeps it in memory only, for tests and rooms without a disk). */
  constructor (file, { cap = ARCHIVE_CAP, log = () => {} } = {}) {
    this.file = file
    this.cap = cap
    this.log = log
    this.list = []
    this.ids = new Set()
    this.lines = 0
    if (file) {
      try {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (!line) continue
          let m
          try { m = JSON.parse(line) } catch { continue } // a line cut off by a crash
          this.lines++
          if (valid(m) && !this.ids.has(m.id)) { this.ids.add(m.id); this.list.push(m) }
        }
      } catch {}
      this.list.sort((a, b) => (a.ts || 0) - (b.ts || 0))
      // The file keeps up to SLACK more than the cap between rewrites.
      for (const m of this.list.splice(0, Math.max(0, this.list.length - this.cap))) this.ids.delete(m.id)
    }
  }

  /** Keeps messages not kept yet (from the room's chat, oldest first). */
  add (messages) {
    const fresh = []
    for (const m of messages || []) {
      if (!valid(m) || this.ids.has(m.id)) continue
      const keep = { id: m.id, by: m.by, ...(m.to ? { to: m.to } : {}), ...(m.of ? { of: m.of } : {}), ...(m.kind ? { kind: m.kind } : {}), text: m.text, ts: Number(m.ts) || 0 }
      this.ids.add(m.id)
      this.list.push(keep)
      fresh.push(keep)
    }
    if (!fresh.length) return 0
    for (let i = Math.max(1, this.list.length - fresh.length); i < this.list.length; i++) {
      if (this.list[i].ts < this.list[i - 1].ts) { this.list.sort((a, b) => (a.ts || 0) - (b.ts || 0)); break }
    }
    if (this.list.length > this.cap) {
      for (const m of this.list.splice(0, this.list.length - this.cap)) this.ids.delete(m.id)
    }
    if (!this.file) return fresh.length
    try {
      if (this.lines + fresh.length > this.cap + SLACK) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        const tmp = this.file + '.tmp'
        fs.writeFileSync(tmp, this.list.map((m) => JSON.stringify(m)).join('\n') + '\n', { mode: 0o600 })
        fs.renameSync(tmp, this.file)
        this.lines = this.list.length
      } else {
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        fs.appendFileSync(this.file, fresh.map((m) => JSON.stringify(m)).join('\n') + '\n', { mode: 0o600 })
        this.lines += fresh.length
      }
    } catch (err) { this.log(`could not keep chat history: ${err.message}`) }
    return fresh.length
  }

  /**
   * Everything kept, with the room's current chat (`live`, which wins for a message in both),
   * oldest first.
   */
  with (live = []) {
    const liveIds = new Set()
    for (const m of live) if (valid(m)) liveIds.add(m.id)
    const older = this.list.filter((m) => !liveIds.has(m.id))
    const out = older.concat(live.filter(valid))
    return older.length && live.length && older[older.length - 1].ts > (live[0].ts || 0) ? out.sort((a, b) => (a.ts || 0) - (b.ts || 0)) : out
  }
}
