// The chronology of a session: every change to a shared file, with who made it,
// when, what changed (a capped unified diff) and the task it was for. Kept in
// the shared doc (`history`) so everyone, including hosted agents, reads the
// same record; queried with quilt_history / `quilt history`.
import crypto from 'node:crypto'
import { globMatcher } from './pathrules.js'

export const HISTORY_CAP = 2000 // entries
export const MAX_HISTORY_CHARS = 1_500_000 // total diff text kept
export const MAX_DIFF_CHARS = 6000 // per entry
export const BURST_MS = 20000 // saves closer than this, same person and file, fold into one entry
const CONTEXT = 2
const MAX_DP_CELLS = 2_000_000 // beyond this the middle of a diff is shown coarsely

/**
 * A unified-style line diff ('' when equal). Common leading and trailing lines
 * are skipped, the middle gets an LCS alignment when it is small enough and a
 * coarse "all removed, all added" block otherwise. Capped at MAX_DIFF_CHARS.
 */
export function lineDiff (before, after, { context = CONTEXT, max = MAX_DIFF_CHARS } = {}) {
  before = String(before ?? ''); after = String(after ?? '')
  if (before === after) return ''
  const a = splitLines(before)
  const b = splitLines(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const ma = a.slice(head, a.length - tail)
  const mb = b.slice(head, b.length - tail)
  const ops = align(ma, mb) // [kind, text] with kind in '=', '-', '+'
  const full = [...a.slice(0, head).map((l) => ['=', l]), ...ops, ...a.slice(a.length - tail).map((l) => ['=', l])]
  return cap(hunks(full, context), max)
}

function splitLines (s) {
  if (!s) return []
  const lines = s.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function align (a, b) {
  if (!a.length) return b.map((l) => ['+', l])
  if (!b.length) return a.map((l) => ['-', l])
  if (a.length * b.length > MAX_DP_CELLS) return [...a.map((l) => ['-', l]), ...b.map((l) => ['+', l])]
  const n = a.length; const m = b.length
  const dp = new Uint32Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = a[i] === b[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1])
    }
  }
  const out = []
  let i = 0; let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(['=', a[i]]); i++; j++ } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) out.push(['-', a[i++]])
    else out.push(['+', b[j++]])
  }
  while (i < n) out.push(['-', a[i++]])
  while (j < m) out.push(['+', b[j++]])
  return out
}

/** Groups ops into hunks with `context` equal lines around each change. */
function hunks (ops, context) {
  const out = []
  let i = 0
  let oldLine = 1; let newLine = 1
  while (i < ops.length) {
    if (ops[i][0] === '=') { oldLine++; newLine++; i++; continue }
    // A change starts here. Walk forward until a stretch of > 2*context equal lines or the end.
    let start = i; let end = i
    let equalRun = 0
    for (let k = i; k < ops.length; k++) {
      if (ops[k][0] === '=') { equalRun++; if (equalRun > 2 * context) break } else { equalRun = 0; end = k }
    }
    const from = Math.max(0, start - context)
    const to = Math.min(ops.length, end + 1 + context)
    // Lines before `from` since the last hunk are all equal: advance the counters.
    const lead = start - from
    const oldStart = oldLine - lead
    const newStart = newLine - lead
    let oldCount = 0; let newCount = 0
    const body = []
    for (let k = from; k < to; k++) {
      const [kind, text] = ops[k]
      if (kind !== '+') oldCount++
      if (kind !== '-') newCount++
      body.push((kind === '=' ? ' ' : kind) + text)
    }
    out.push(`@@ -${oldCount ? oldStart : 0},${oldCount} +${newCount ? newStart : 0},${newCount} @@`, ...body)
    for (let k = i; k < to; k++) {
      if (ops[k][0] !== '+') oldLine++
      if (ops[k][0] !== '-') newLine++
    }
    i = to
  }
  return out.join('\n')
}

function cap (text, max) {
  if (text.length <= max) return text
  const cut = text.lastIndexOf('\n', max)
  return `${text.slice(0, cut > 0 ? cut : max)}\n… (diff truncated)`
}

function counts (diff) {
  let added = 0; let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

/**
 * Writes entries into the shared `history` array. One instance per process;
 * it remembers the text a burst started from so later saves in the same burst
 * replace the entry with a diff spanning the whole burst.
 */
export class HistoryLog {
  constructor (doc, array, { origin = 'history', burstMs = BURST_MS } = {}) {
    this.doc = doc
    this.array = array
    this.origin = origin
    this.burstMs = burstMs
    this.bursts = new Map() // "by\0path" -> { id, before, ts }
  }

  entries () { return this.array.toArray().filter((e) => e && typeof e === 'object' && e.path) }

  /**
   * @param {object} c
   * @param {string} c.by  who changed it
   * @param {string} c.path
   * @param {'created'|'edited'|'deleted'} c.kind
   * @param {string} [c.before] text before (text files)
   * @param {string} [c.after]  text after
   * @param {string} [c.detail] "N bytes" for binaries; derived from the diff otherwise
   * @param {{id:string,title:string}|null} [c.task] the task this change was for
   * @param {boolean} [c.pulled] a git pull brought this change (it is not the person's own edit)
   * @param {number} [c.ts]
   */
  record ({ by, path, kind, before, after, detail, task, pulled = false, ts = Date.now() }) {
    const key = `${by}\0${path}`
    const burst = this.bursts.get(key)
    const text = typeof before === 'string' || typeof after === 'string'
    const foldable = kind === 'edited' && burst && ts - burst.ts < this.burstMs && text && !pulled && !burst.pulled
    const base = foldable ? burst.before : (before ?? '')
    const diff = text ? lineDiff(base, after ?? '') : ''
    const c = text ? counts(diff) : { added: 0, removed: 0 }
    const entry = {
      id: foldable ? burst.id : crypto.randomBytes(6).toString('hex'),
      by: String(by || ''),
      path: String(path || ''),
      kind: foldable && burst.kind === 'created' ? 'created' : kind, // a file created and then saved again is still "created"
      ts,
      from: foldable ? burst.from : ts,
      added: c.added,
      removed: c.removed,
      detail: text ? `+${c.added} -${c.removed}` : String(detail || ''),
      task: task && task.id ? { id: String(task.id), title: String(task.title || '') } : null,
      ...(pulled ? { pulled: true } : {}),
      diff
    }
    this.doc.transact(() => {
      if (foldable) {
        const i = this.indexOf(entry.id)
        if (i >= 0) this.array.delete(i, 1)
        this.array.insert(i >= 0 ? i : this.array.length, [entry])
      } else {
        this.array.push([entry])
      }
      this.trim()
    }, this.origin)
    if (kind === 'deleted') this.bursts.delete(key)
    else this.bursts.set(key, { id: entry.id, kind: entry.kind, before: base, from: entry.from, ts, pulled })
    return entry
  }

  indexOf (id) {
    for (let i = this.array.length - 1; i >= 0; i--) {
      const e = this.array.get(i)
      if (e && e.id === id) return i
    }
    return -1
  }

  trim () {
    if (this.array.length > HISTORY_CAP) this.array.delete(0, this.array.length - HISTORY_CAP)
    let total = 0
    const all = this.array.toArray()
    for (const e of all) total += (e && e.diff ? e.diff.length : 0) + 120
    let drop = 0
    while (total > MAX_HISTORY_CHARS && drop < all.length - 1) {
      const e = all[drop++]
      total -= (e && e.diff ? e.diff.length : 0) + 120
    }
    if (drop) this.array.delete(0, drop)
  }
}

/**
 * "2h", "45m", "3d", "1w", "today", "yesterday" or a date. Returns a timestamp,
 * null for empty input, undefined when it can't be read.
 */
export function parseSince (s, now = Date.now()) {
  const str = String(s ?? '').trim().toLowerCase()
  if (!str) return null
  const m = /^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|hour|d|day|w|week)s?$/.exec(str)
  if (m) {
    const unit = { s: 1e3, sec: 1e3, m: 60e3, min: 60e3, h: 3600e3, hr: 3600e3, hour: 3600e3, d: 86400e3, day: 86400e3, w: 7 * 86400e3, week: 7 * 86400e3 }[m[2]]
    return now - Math.round(+m[1] * unit)
  }
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  if (str === 'today') return midnight
  if (str === 'yesterday') return midnight - 86400e3
  const t = Date.parse(s)
  return Number.isNaN(t) ? undefined : t
}

/**
 * Filters history entries. `path` is an exact path, a folder prefix ending in
 * "/", or a glob. `by` is a name (case-insensitive). `since` is a timestamp.
 * Returns oldest first; `limit` keeps the newest.
 */
export function queryHistory (entries, { path, by, since, task, limit = 50 } = {}) {
  let list = entries.filter((e) => e && e.path)
  if (path) {
    const p = String(path).replace(/\\/g, '/').replace(/^\.\//, '')
    const match = /[*?[{]/.test(p) ? globMatcher(p) : p.endsWith('/') ? (x) => x.startsWith(p) : (x) => x === p
    list = list.filter((e) => match(e.path))
  }
  if (by) { const who = String(by).trim().toLowerCase(); list = list.filter((e) => String(e.by).toLowerCase() === who) }
  if (task) list = list.filter((e) => e.task && e.task.id === task)
  if (typeof since === 'number') list = list.filter((e) => e.ts >= since)
  list.sort((a, b) => a.ts - b.ts)
  if (limit && list.length > limit) list = list.slice(-limit)
  return list
}

function ago (ts, now) {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 172800) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** One line per change, oldest first; with `withDiff`, each diff follows its line. */
export function formatHistory (list, { withDiff = false, now = Date.now() } = {}) {
  if (!list.length) return 'No changes match.'
  const out = []
  for (const e of list) {
    const span = e.from && e.ts - e.from > 60000 ? ` over ${Math.round((e.ts - e.from) / 60000)}m` : ''
    const what = e.detail ? ` (${e.detail})` : ''
    const task = e.task ? ` for "${e.task.title}" [${e.task.id}]` : ''
    out.push(`[${ago(e.ts, now)}] ${e.by} ${e.kind} ${e.path}${what}${e.pulled ? ' by pulling from git' : ''}${span}${task}`)
    if (withDiff && e.diff) out.push(e.diff, '')
  }
  return out.join('\n').replace(/\n+$/, '')
}

/**
 * Who made the changes between `before` (a file as git has it) and `after` (as it is now): each
 * line that differs is put down to the newest history entry (`entries`: that file's, oldest
 * first) that added or removed it. Pulls from git are nobody's, and lines too common to tell
 * apart (blank, a lone brace) are not counted. Names in the order their lines come. Unlike "who
 * edited it since", someone whose edit was later undone, or who only opened the session with the
 * file, is not named.
 */
export function blameChange ({ before = '', after = '', entries = [] }) {
  const diff = lineDiff(before, after, { context: 0, max: 400_000 })
  if (!diff) return []
  const changed = diff.split('\n').filter((l) => (l[0] === '+' || l[0] === '-') && !/^(\+\+\+|---) /.test(l) && l.slice(1).replace(/[\s{}()[\];,]/g, '').length >= 2)
  const newest = [...entries].reverse().filter((e) => e && !e.pulled && e.by && typeof e.diff === 'string').map((e) => ({ by: e.by, lines: new Set(e.diff.split('\n')) }))
  const out = []
  for (const line of changed) {
    const e = newest.find((x) => x.lines.has(line))
    if (e && !out.includes(e.by)) out.push(e.by)
  }
  return out
}

/**
 * The In-progress task assigned to `name` (the person or their AI): the first on
 * the board, with the AI's tasks first when `preferAi` says the AI is the one working.
 */
export function currentTask (tasks, name, { preferAi = false } = {}) {
  const doing = (tasks || []).filter((t) => t && t.column === 'doing' && t.assignee === name)
  if (!doing.length) return null
  doing.sort((a, b) => (Number(!!b.forAi === preferAi) - Number(!!a.forAi === preferAi)) || ((a.order ?? 0) - (b.order ?? 0)))
  return { id: doing[0].id, title: doing[0].title }
}
