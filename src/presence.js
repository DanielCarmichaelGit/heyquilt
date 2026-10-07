// Presence reports: the relay tells the accounts API who is in which session, and
// when, so people's dashboards can show their sessions and who they worked with.
// Only for connections with a pass (an account), and only when the relay has both
// QUILT_API_URL and RELAY_API_SECRET. Events wait in a queue that is kept on disk
// (`<dataDir>/presence-queue.jsonl`), so a restart or a down API loses nothing, and
// are sent every minute, at most 500 per request, in order.
//
// For the audit trail, a visit says how the member came in (`via`: the app or a hosted
// agent, and its `tool`), why it ended (`reason`, see END_REASONS), and what it did
// meanwhile (`act` events: an action and its target, a path or a task id; never file
// contents or chat text). The same action on the same target is reported at most once
// a minute per visit.
import fs from 'node:fs'
import crypto from 'node:crypto'

export const PRESENCE_FILE = 'presence-queue.jsonl'
export const PRESENCE_FLUSH_MS = 60 * 1000
export const PRESENCE_BATCH = 500
export const PRESENCE_MAX_QUEUE = 100_000
export const PRESENCE_MAX_BACKOFF_MS = 10 * 60 * 1000
// A full rewrite of the queue file is O(queue size): worth doing right after load() or
// close(), but not on every drop or send while the relay is under load.
export const PRESENCE_REWRITE_MS = 60 * 1000
const SYNC_MS = 1000
export const ACT_COALESCE_MS = 60 * 1000
/** Why a visit ended. The accounts API turns an agent's `pass_expired` or `idle` into `revoked` when its keys were revoked first. */
export const END_REASONS = ['left', 'disconnected', 'removed', 'pass_expired', 'session_ended', 'relay_restart', 'idle', 'replaced', 'needs_update']
export const ACTIONS = ['created', 'edited', 'deleted', 'claimed', 'released', 'requested', 'handed_off', 'withdrew', 'messaged', 'task', 'tool']
const MAX_TARGET = 300
const SEND_TIMEOUT_MS = 15 * 1000
const CLOSE_TIMEOUT_MS = 5 * 1000

export class PresenceReporter {
  /**
   * @param {object} o
   * @param {string} o.apiUrl   the accounts API, e.g. https://api.heyquilt.com
   * @param {string} o.secret   RELAY_API_SECRET. Never logged.
   * @param {string|null} [o.file]  the queue file; null keeps the queue in memory only
   */
  constructor ({ apiUrl, secret, file = null, log = () => {}, now = Date.now, fetch = globalThis.fetch, flushMs = PRESENCE_FLUSH_MS, batch = PRESENCE_BATCH, maxQueue = PRESENCE_MAX_QUEUE, maxBackoffMs = PRESENCE_MAX_BACKOFF_MS, syncMs = SYNC_MS, timeoutMs = SEND_TIMEOUT_MS, rewriteMs = PRESENCE_REWRITE_MS, closeTimeoutMs = CLOSE_TIMEOUT_MS }) {
    this.url = `${String(apiUrl).replace(/\/+$/, '')}/v1/relay/presence`
    this.secret = secret
    this.file = file
    this.log = log
    this.now = now
    this.fetch = fetch
    this.flushMs = flushMs
    this.batch = batch
    this.maxQueue = maxQueue
    this.maxBackoffMs = maxBackoffMs
    this.syncMs = syncMs
    this.timeoutMs = timeoutMs
    this.rewriteMs = rewriteMs
    this.closeTimeoutMs = closeTimeoutMs
    this.queue = [] // { seq, ev, startSeq? }, oldest first; an `end` notes its `start`'s seq (0: sent by an earlier run)
    this.seq = 0
    this.sentSeq = 0 // the highest seq the accounts API has taken
    this.inFlight = 0 // the highest seq in the request being sent; 0 when nothing is
    this.open = new Map() // start event id -> { start, room, account }: visits not ended yet
    this.startSeqs = new Map() // start event id -> its seq, for visits not ended yet
    this.unwritten = [] // queue lines not yet appended to the file
    this.rewrite = false // the file no longer matches the queue: write it whole next time
    this.lastRewriteAt = -Infinity // so the first rewrite (from load(), or the first drop) is never throttled
    this.urgent = false // a rewrite a successful send is waiting on: never throttled
    this.full = false // logged once per overflow episode; cleared once the queue drains below the cap
    this.saveFailing = false // logged once per failure episode; cleared by the next save that works
    this.failures = 0
    this.retryAt = 0
    this.sending = null
    this.closed = false
    this.timers = []
    this.acted = new Map() // start event id -> Map(action|target -> when last reported), for visits not ended yet
  }

  /**
   * Reads the queue file a previous run left, and ends at "now" every visit it had
   * started and not ended (the relay crashed, or was redeployed). Returns how many.
   */
  load () {
    if (!this.file) return 0
    let text = ''
    try { text = fs.readFileSync(this.file, 'utf8') } catch (err) { if (err.code !== 'ENOENT') this.log(`presence: could not read ${this.file}: ${err.message}`); return 0 }
    let bad = 0
    const seqs = new Map() // start event id -> seq, for the starts in the file
    const lastName = new Map() // room -> seq of its newest name in the file
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let row
      try { row = JSON.parse(line) } catch { bad++; continue } // a line cut off by a crash
      // JSON.parse accepts bare null/numbers/strings too: never trust the shape before checking it.
      if (!row || typeof row !== 'object') { bad++; continue }
      if (Array.isArray(row.open)) {
        for (const v of row.open) if (v && v.start) this.open.set(v.start, v)
        continue
      }
      if (!row.id || !row.type) { bad++; continue }
      const seq = ++this.seq
      if (row.type === 'start') {
        this.open.set(row.id, { start: row.id, room: row.room, account: row.account })
        seqs.set(row.id, seq)
      }
      if (row.type === 'end') this.open.delete(row.start)
      if (row.type === 'name') lastName.set(row.room, seq)
      // A start this file doesn't hold was sent by an earlier run: 0 marks that.
      this.queue.push(row.type === 'end' ? { seq, ev: row, startSeq: seqs.get(row.start) || 0 } : { seq, ev: row })
    }
    // A room's older names (from saves between the queue's rewrites) would only be overwritten.
    this.queue = this.queue.filter((x) => x.ev.type !== 'name' || lastName.get(x.ev.room) === x.seq)
    for (const id of this.open.keys()) if (seqs.has(id)) this.startSeqs.set(id, seqs.get(id))
    if (bad) this.log(`presence: skipped ${bad} unreadable line(s) in ${this.file}`)
    const ended = this.open.size
    this.endAll('relay_restart')
    this.rewrite = true
    this.persist(true) // startup: write the cleaned-up state now, not whenever the throttle allows
    return ended
  }

  /** Sends every minute (sooner retries wait for their backoff) and saves the queue every second. */
  start () {
    const tick = setInterval(() => { this.tick().catch(() => {}) }, this.flushMs)
    const sync = setInterval(() => this.persist(), this.syncMs)
    tick.unref()
    sync.unref()
    this.timers.push(tick, sync)
  }

  get size () { return this.queue.length }

  /** Someone with a pass was let into a room. Returns the visit, for visitEnd. */
  visitStart ({ room, account, name, owner = false, via = '', tool = '' }) {
    if (this.closed) return null
    const ev = { id: crypto.randomUUID(), type: 'start', room, account, name, ...(owner ? { owner: true } : {}), ...(via ? { via } : {}), ...(tool ? { tool: String(tool).slice(0, 40) } : {}), at: this.now() }
    const visit = { start: ev.id, room, account }
    this.open.set(ev.id, visit)
    this.startSeqs.set(ev.id, this.enqueue(ev))
    return visit
  }

  /** That connection left (closed, removed, ended, or its pass lapsed), for `reason`; `at` defaults to now. Once per visit. */
  visitEnd (visit, reason = 'left', at) {
    if (this.closed || !visit || !this.open.delete(visit.start)) return
    this.enqueueEnd(visit, reason, at)
  }

  /**
   * Someone in a visit did something: `action` (one of ACTIONS) on `target` (a path, a
   * task id or a tool name). Repeats of the same action on the same target within a
   * minute are not reported again.
   */
  act (visit, action, target = '') {
    if (this.closed || !visit || !this.open.has(visit.start) || !ACTIONS.includes(action)) return
    const t = String(target || '').slice(0, MAX_TARGET)
    const at = this.now()
    let seen = this.acted.get(visit.start)
    if (!seen) this.acted.set(visit.start, (seen = new Map()))
    const k = `${action}|${t}`
    if (at - (seen.get(k) ?? -Infinity) < ACT_COALESCE_MS) return
    seen.set(k, at)
    if (seen.size > 1000) for (const [key, when] of seen) if (at - when >= ACT_COALESCE_MS) seen.delete(key)
    this.enqueue({ id: crypto.randomUUID(), type: 'act', start: visit.start, room: visit.room, account: visit.account, action, ...(t ? { target: t } : {}), at })
  }

  /**
   * The owner named the session. Only the newest name matters, so a room keeps at most
   * one waiting: a rename replaces the one queued before it (unless that one is already
   * on its way to the API), and renames can never pile up in the queue.
   */
  rename ({ room, name }) {
    if (this.closed) return
    const i = this.queue.findIndex((x) => x.ev.type === 'name' && x.ev.room === room && x.seq > this.inFlight)
    if (i >= 0) {
      this.queue.splice(i, 1)
      this.rewrite = true // the replaced line is still in the file
    }
    this.enqueue({ id: crypto.randomUUID(), type: 'name', room, name, at: this.now() })
  }

  /** Ends every open visit now: on shutdown, and for visits a previous run left open. */
  endAll (reason = 'relay_restart') {
    for (const visit of [...this.open.values()]) {
      this.open.delete(visit.start)
      this.enqueueEnd(visit, reason)
    }
  }

  enqueueEnd (visit, reason, at) {
    const startSeq = this.startSeqs.get(visit.start) || 0
    this.startSeqs.delete(visit.start)
    this.acted.delete(visit.start)
    const when = Number.isFinite(at) ? Math.min(at, this.now()) : this.now()
    this.enqueue({ id: crypto.randomUUID(), type: 'end', start: visit.start, room: visit.room, account: visit.account, ...(END_REASONS.includes(reason) ? { reason } : {}), at: when }, startSeq)
  }

  /** Returns the event's seq. */
  enqueue (ev, startSeq) {
    const seq = ++this.seq
    this.queue.push(startSeq === undefined ? { seq, ev } : { seq, ev, startSeq })
    this.unwritten.push(ev)
    if (this.queue.length > this.maxQueue) this.dropOldest()
    return seq
  }

  /**
   * Drops the oldest tenth of the cap in one go, not one event at a time: at one per
   * event, a relay that's constantly over the cap would rewrite the whole queue file
   * and log a line on every single enqueue. Prefers dropping the oldest `start`
   * together with its matching `end` (if that `end` is already queued too): the pair
   * is a visit that's over and done with, the least useful thing to still be holding.
   * A `name` is never dropped: renames are rare, and since the `name` op is now
   * idempotent (a repeat is never re-queued), a dropped one is gone for good. If every
   * `start` has already been paired off or dropped and more still needs to go, the
   * oldest unmatched `end`s go next (an `end` whose `start` was dropped is harmless: the
   * accounts API ignores it). Never dropped: anything in the request being sent (it
   * reaches the API anyway), and an `end` whose `start` was sent or is being sent (the
   * visit would stay open on the dashboard forever). One `filter` pass over the queue,
   * never a per-element shift: a drop must stay cheap even at ~100,000 events.
   */
  dropOldest () {
    const sent = Math.max(this.sentSeq, this.inFlight)
    const drop = Math.max(this.queue.length - this.maxQueue, Math.ceil(this.maxQueue / 10))
    const endIndexByStart = new Map() // start event id -> index of its `end`, if queued
    this.queue.forEach((x, i) => { if (x.ev.type === 'end') endIndexByStart.set(x.ev.start, i) })
    const remove = new Set()
    let dropped = 0
    // What visits did is the most plentiful and the least load-bearing: the oldest of it goes first.
    for (let i = 0; i < this.queue.length && dropped < drop; i++) {
      const x = this.queue[i]
      if (x.ev.type === 'act' && x.seq > this.inFlight) { remove.add(i); dropped++ }
    }
    for (let i = 0; i < this.queue.length && dropped < drop; i++) {
      const x = this.queue[i]
      if (x.ev.type !== 'start' || x.seq <= this.inFlight || remove.has(i)) continue
      remove.add(i); dropped++
      const endIndex = endIndexByStart.get(x.ev.id)
      if (endIndex !== undefined && !remove.has(endIndex)) { remove.add(endIndex); dropped++ }
    }
    // Nothing left to pair off a `start` with: the oldest leftover `end`s are next.
    for (let i = 0; i < this.queue.length && dropped < drop; i++) {
      const x = this.queue[i]
      if (x.ev.type === 'end' && x.seq > this.inFlight && x.startSeq > sent && !remove.has(i)) { remove.add(i); dropped++ }
    }
    if (remove.size) this.queue = this.queue.filter((_, i) => !remove.has(i))
    this.rewrite = true
    if (!this.full) {
      this.full = true
      this.log(`presence: the queue is full (${this.maxQueue} events); dropped ${dropped} oldest event(s)`)
    }
  }

  /** Once the queue has drained back under the cap, the next overflow logs again. */
  checkDrained () {
    if (this.full && this.queue.length < this.maxQueue) this.full = false
  }

  /**
   * Saves what's new in the queue: appended and fsynced, or the whole file when it has
   * to be (dropped or sent events leave the file out of sync with the queue, since
   * appending can only add lines, never remove them). A whole-file rewrite is O(queue
   * size): a drop's rewrite can wait up to `rewriteMs` (events keep being appended
   * meanwhile, so nothing is lost), but one a successful send asked for (`urgent`) never
   * waits, or a restart could re-read and re-send events the accounts API already has.
   */
  persist (force = false) {
    if (!this.file) return
    const rewriteNow = this.rewrite && (force || this.urgent || this.now() - this.lastRewriteAt >= this.rewriteMs)
    if (!rewriteNow && !this.unwritten.length) return
    try {
      if (rewriteNow) {
        // Written whole, then renamed: a crash mid-write leaves the old file, never half of one.
        const tmp = `${this.file}.tmp`
        const lines = [JSON.stringify({ open: [...this.open.values()] }), ...this.queue.map((x) => JSON.stringify(x.ev))]
        const fd = fs.openSync(tmp, 'w')
        try { fs.writeSync(fd, lines.join('\n') + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
        fs.renameSync(tmp, this.file)
        this.rewrite = false
        this.urgent = false
        this.lastRewriteAt = this.now()
        this.unwritten = [] // the rewrite above already includes every queued event
      } else if (this.unwritten.length) {
        const fd = fs.openSync(this.file, 'a')
        try { fs.writeSync(fd, this.unwritten.map((ev) => JSON.stringify(ev)).join('\n') + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
        this.unwritten = []
      }
      this.saveFailing = false
    } catch (err) {
      // An append that failed may have left part of a line: the next save that works
      // writes the whole file, which has every queued event, so nothing waits to be appended.
      this.rewrite = true
      this.unwritten = []
      if (!this.saveFailing) this.log(`presence: could not save the queue: ${err.message}`)
      this.saveFailing = true
    }
  }

  /** Sends now unless a failure's backoff hasn't run out. */
  async tick () {
    if (this.now() < this.retryAt) return false
    return this.flush()
  }

  /**
   * Sends everything queued, oldest first, in requests of at most 500. Resolves true
   * when the queue is empty, false after a failure (the events stay for the retry).
   */
  flush () {
    if (!this.sending) this.sending = this.send().finally(() => { this.sending = null })
    return this.sending
  }

  async send () {
    let sent = false
    try {
      while (this.queue.length) {
        const chunk = this.queue.slice(0, this.batch)
        this.inFlight = chunk[chunk.length - 1].seq
        const res = await this.fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` },
          body: JSON.stringify({ events: chunk.map((x) => x.ev) }),
          signal: AbortSignal.timeout(this.timeoutMs)
        })
        if (!res.ok) throw new Error(`the accounts API answered ${res.status}`)
        // By sequence number: the queue may have dropped its oldest while this was in flight.
        const last = this.inFlight
        this.sentSeq = last
        this.inFlight = 0
        const i = this.queue.findIndex((x) => x.seq > last)
        this.queue = i < 0 ? [] : this.queue.slice(i)
        this.checkDrained()
        sent = true
      }
      this.failures = 0
      this.retryAt = 0
      return true
    } catch (err) {
      this.failures++
      const wait = Math.min(this.flushMs * 2 ** (this.failures - 1), this.maxBackoffMs)
      this.retryAt = this.now() + wait
      this.log(`presence: could not report to the accounts API (${err.cause?.code || err.message}); trying again in ${Math.round(wait / 1000)} s`)
      return false
    } finally {
      this.inFlight = 0
      if (sent) { this.rewrite = true; this.urgent = true; this.persist() }
    }
  }

  /** On shutdown: ends every open visit, stops the timers, saves the queue, and tries one last send (bounded by closeTimeoutMs). */
  async close () {
    if (this.closed) return
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.endAll('relay_restart')
    this.persist(true)
    this.closed = true
    let timer
    await Promise.race([this.flush(), new Promise((resolve) => { timer = setTimeout(resolve, this.closeTimeoutMs) })])
    clearTimeout(timer)
    this.persist(true)
  }
}
