// Shared task board for a session: four columns, stored as plain objects in
// the Y.Doc so everyone (and every AI) sees the same list.
import crypto from 'node:crypto'
import { isSafeRelPath } from './pathrules.js'
import { parseSchedule, canonicalCron, cronToText } from './ui/schedule.js'

export const COLUMNS = [
  { id: 'todo', name: 'To do' },
  { id: 'doing', name: 'In progress' },
  { id: 'qa', name: 'QA' },
  { id: 'done', name: 'Done' }
]
export const COLUMN_IDS = new Set(COLUMNS.map((c) => c.id))
export const MAX_TASKS = 200
export const MAX_TITLE = 200
export const MAX_FILES = 20
export const MAX_FILE_PATH = 240
const MAX_ASSIGNEE = 80
const MAX_TOOL = 40
const MAX_CONV = 200
const MAX_VERIFIED = 1000
const MAX_QA_NOTES = MAX_VERIFIED
// An edit from an AI chat only becomes a task when it just happened. Older
// lines are the reader's backfill of an earlier conversation.
export const AUTO_TASK_MS = 2 * 60 * 1000
const CHANGE = /^(Edited|Created|Deleted) (.+)$/

const HEX_ID = /^[0-9a-f]{16}$/i
// Control chars and bidi overrides: a task title is shown to everyone.
const INVISIBLE = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

export function columnName (id) {
  return COLUMNS.find((c) => c.id === id)?.name || ''
}

export function cleanTitle (title) {
  return String(title ?? '').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
}

function cleanName (name) {
  const n = String(name ?? '').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_ASSIGNEE)
  return n || 'someone'
}

/** A person to assign to. Empty means unassigned. "me" is resolved by the caller first. */
export function cleanAssignee (name) {
  return String(name ?? '').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_ASSIGNEE)
}

function cleanTool (tool) {
  return String(tool ?? '').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TOOL)
}

function oneLine (s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
}

/** Project paths a task is about. Throws on anything that is not a safe relative path. */
export function cleanFiles (files) {
  if (files == null) return []
  if (!Array.isArray(files)) throw new Error('files must be a list of paths')
  const out = []
  for (const raw of files) {
    const p = String(raw ?? '').trim().replace(/^\.\//, '').replace(/\\/g, '/')
    if (!p) continue
    if (p.length > MAX_FILE_PATH || !isSafeRelPath(p)) throw new Error(`not a project file: ${p.slice(0, 80)}`)
    if (!out.includes(p)) out.push(p)
    if (out.length > MAX_FILES) throw new Error(`a task can list at most ${MAX_FILES} files`)
  }
  return out
}

/**
 * Who a task is for, from a tool or API call.
 * `assignee` is a person's name, "me", or "" to clear. `to_ai` / `forAi` means that
 * person's AI rather than the person. `files` is omitted from the result when
 * the caller did not send it, so an update can leave the list alone.
 */
export function assignmentFields ({ assignee, forAi, to_ai, tool, files, me, peers } = {}) {
  const sent = assignee !== undefined || forAi !== undefined || to_ai !== undefined
  const raw = assignee == null ? '' : String(assignee).trim()
  const name = raw === 'me' ? cleanAssignee(me) : cleanAssignee(raw)
  if (raw && !name) throw new Error('say who it is for')
  const ai = !!(forAi || to_ai) && !!name
  let toolName = ''
  if (ai) {
    const mine = !!(me && name === cleanAssignee(me))
    const peer = mine ? null : (peers || []).find((p) => p && p.name === name)
    const live = peer?.tool && peer.tool !== 'unknown' ? peer.tool : ''
    // `tool` is the hint for yourself, or an explicit label the caller already resolved.
    toolName = cleanTool(live || tool || '')
  }
  const out = {}
  if (sent) {
    out.assignee = name
    out.forAi = ai
    out.tool = toolName
  }
  if (files !== undefined) out.files = cleanFiles(files)
  return out
}

/** True when `task` is assigned to this reader. `asAi` means the reader is that person's AI. */
export function assignedToReader (task, { name, asAi } = {}) {
  if (!task || !task.assignee || !name || task.assignee !== name) return false
  return asAi ? !!task.forAi : !task.forAi
}

/** "you", "Brandon", "your Cursor", "Brandon's Cursor". Empty when unassigned. */
export function assigneeLabel (task, me) {
  if (!task?.assignee) return ''
  const mine = !!me && task.assignee === me
  if (!task.forAi) return mine ? 'you' : task.assignee
  const tool = task.tool && task.tool !== 'unknown' ? task.tool : 'AI'
  return mine ? `your ${tool}` : `${task.assignee}'s ${tool}`
}

/** A task we'll show. Anything a modified client pushed that isn't this shape is ignored. */
export function publicTask (value) {
  if (!value || typeof value !== 'object') return null
  const title = typeof value.title === 'string' ? value.title : ''
  if (typeof value.id !== 'string' || !HEX_ID.test(value.id)) return null
  if (!title || title.length > MAX_TITLE || title !== cleanTitle(title)) return null
  if (!COLUMN_IDS.has(value.column)) return null
  if (typeof value.by !== 'string' || value.by.length > 80) return null
  if (typeof value.order !== 'number' || !Number.isFinite(value.order)) return null
  if (typeof value.ts !== 'number' || !Number.isFinite(value.ts)) return null
  const who = storedAssignee(value)
  if (!who) return null
  const files = storedFiles(value)
  if (!files) return null
  const conv = storedConv(value.conv)
  if (conv == null) return null
  const verified = storedVerified(value.verified)
  if (verified == null) return null
  const qaNotes = storedQaNotes(value.qaNotes)
  if (qaNotes == null) return null
  const recurring = storedRecurring(value.recurring)
  if (recurring == null) return null
  const cron = canonicalCron(value.cron)
  if (cron == null) return null
  return { id: value.id, title, column: value.column, by: value.by, order: value.order, ts: value.ts, ...who, files, conv, verified, qaNotes, recurring, cron }
}

/** What an agent said it ran and saw before moving the task to Done. Newlines kept, control chars dropped. */
export function cleanVerified (text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
    .map((line) => line.replace(INVISIBLE, ' ').replace(/[ \t]+/g, ' ').trim())
    .join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_VERIFIED).trimEnd()
}

// Missing means no evidence was given. A value that is present must already be cleaned.
function storedVerified (v) {
  if (v == null || v === '') return ''
  if (typeof v !== 'string' || v.length > MAX_VERIFIED) return null
  if (v !== cleanVerified(v)) return null
  return v
}

/** What an agent wrote about its changes and self-validation when moving the task to QA. */
export function cleanQaNotes (text) {
  // Trim after cutting: a cut that lands on a space would otherwise store a value that
  // doesn't survive cleaning again, and storedQaNotes would then hide the whole task.
  return cleanVerified(text).slice(0, MAX_QA_NOTES).trimEnd()
}

function storedQaNotes (v) {
  if (v == null || v === '') return ''
  if (typeof v !== 'string' || v.length > MAX_QA_NOTES) return null
  if (v !== cleanQaNotes(v)) return null
  return v
}

function storedRecurring (v) {
  if (v == null) return false
  if (typeof v !== 'boolean') return null
  return v
}

// Older tasks have no assignee. A value that sets one must already be cleaned,
// the same rule as the title, so a peer cannot push a name we would display differently.
function storedAssignee (value) {
  const has = value.assignee != null && value.assignee !== ''
  if (!has) {
    if (value.forAi === true || (value.tool != null && value.tool !== '')) return null
    return { assignee: '', forAi: false, tool: '' }
  }
  if (typeof value.assignee !== 'string' || value.assignee.length > MAX_ASSIGNEE) return null
  if (value.assignee !== cleanAssignee(value.assignee)) return null
  if (value.forAi != null && typeof value.forAi !== 'boolean') return null
  const forAi = value.forAi === true
  if (!forAi) {
    if (value.tool != null && value.tool !== '') return null
    return { assignee: value.assignee, forAi: false, tool: '' }
  }
  if (value.tool == null || value.tool === '') return { assignee: value.assignee, forAi: true, tool: '' }
  if (typeof value.tool !== 'string' || value.tool.length > MAX_TOOL || value.tool !== cleanTool(value.tool)) return null
  return { assignee: value.assignee, forAi: true, tool: value.tool }
}

function cleanConv (conv) {
  const c = String(conv ?? '').replace(INVISIBLE, '').trim()
  if (!c || c.length > MAX_CONV) return ''
  return c
}

// Missing means this task is not tied to an AI chat. A value that is present
// must already be cleaned, the same rule as the title.
function storedConv (conv) {
  if (conv == null || conv === '') return ''
  if (typeof conv !== 'string' || conv.length > MAX_CONV) return null
  if (conv !== cleanConv(conv)) return null
  return conv
}

function storedFiles (value) {
  if (value.files == null) return []
  if (!Array.isArray(value.files) || value.files.length > MAX_FILES) return null
  const files = []
  for (const f of value.files) {
    if (typeof f !== 'string' || f.length > MAX_FILE_PATH || !isSafeRelPath(f)) return null
    if (!files.includes(f)) files.push(f)
  }
  return files
}

function byOrder (a, b) {
  return a.order - b.order || a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

function split (map) {
  const valid = []
  const junk = []
  map.forEach((value, key) => {
    const task = publicTask(value)
    if (task && task.id === key) valid.push(task)
    else junk.push(key)
  })
  valid.sort(byOrder)
  return { valid, junk }
}

export function readTasks (map) {
  return split(map).valid
}

function listed (tasks) {
  if (tasks && typeof tasks.forEach === 'function' && !Array.isArray(tasks)) return readTasks(tasks)
  return (Array.isArray(tasks) ? tasks : []).map(publicTask).filter(Boolean).sort(byOrder)
}

function nextOrder (tasks, column) {
  const col = tasks.filter((t) => t.column === column)
  if (!col.length) return 1
  return Math.max(...col.map((t) => t.order)) + 1
}

/** Where a card lands in `column`. `beforeId` inserts ahead of that card; otherwise it goes last. */
function orderBefore (tasks, column, beforeId) {
  const col = tasks.filter((t) => t.column === column).sort(byOrder)
  const last = col.length ? col[col.length - 1].order + 1 : 1
  if (!beforeId) return last
  const i = col.findIndex((t) => t.id === beforeId)
  if (i < 0) return last
  if (i === 0) return col[0].order - 1
  return (col[i - 1].order + col[i].order) / 2
}

/**
 * Adds a task to To do. When the board is full, the oldest Done task is
 * dropped to make room. Throws if there is nothing finished to drop.
 */
export function addTask (doc, map, { title, by, assignee = '', forAi = false, tool = '', files = [], column = 'todo', conv = '' }, origin) {
  const clean = cleanTitle(title)
  if (!clean) throw new Error('say what the task is')
  if (!COLUMN_IDS.has(column)) throw new Error('pick To do, In progress, QA, or Done')
  const who = assignmentFields({ assignee, forAi, tool, files })
  const { valid, junk } = split(map)
  const dropping = []
  if (valid.length >= MAX_TASKS) {
    const done = valid.filter((t) => t.column === 'done').sort((a, b) => a.ts - b.ts || byOrder(a, b))
    const need = valid.length - MAX_TASKS + 1
    if (done.length < need) throw new Error('the board is full. Remove a task first.')
    dropping.push(...done.slice(0, need).map((t) => t.id))
  }
  const task = {
    id: crypto.randomBytes(8).toString('hex'),
    title: clean,
    column,
    by: cleanName(by),
    assignee: who.assignee || '',
    forAi: !!who.forAi,
    tool: who.tool || '',
    files: who.files || [],
    conv: cleanConv(conv),
    verified: '',
    qaNotes: '',
    recurring: false,
    cron: '',
    order: nextOrder(valid, column),
    ts: Date.now()
  }
  doc.transact(() => {
    for (const key of junk) map.delete(key)
    for (const id of dropping) map.delete(id)
    map.set(task.id, task)
  }, origin)
  return task
}

/**
 * Changes a task's title, column, place, assignee, files, verified evidence, QA notes, or repeat schedule.
 * `before` is a task id to insert ahead of. Leaving Done clears `verified`; leaving QA clears `qaNotes`.
 * `cron` is 5-field cron or a phrase such as "daily at 9". A schedule turns `recurring` on.
 */
export function updateTask (doc, map, { id, title, column, before, assignee, forAi, tool, files, verified, qaNotes, recurring, cron } = {}, origin) {
  const { valid } = split(map)
  const cur = valid.find((t) => t.id === id)
  if (!cur) throw new Error('no such task')
  const next = { ...cur }
  let changed = false
  if (title !== undefined) {
    const clean = cleanTitle(title)
    if (!clean) throw new Error('say what the task is')
    if (clean !== cur.title) { next.title = clean; changed = true }
  }
  if (column !== undefined && !COLUMN_IDS.has(column)) throw new Error('pick To do, In progress, QA, or Done')
  const moving = column !== undefined && column !== cur.column
  const beforeId = typeof before === 'string' && before && before !== id ? before : null
  if (moving || beforeId) {
    const dest = column || cur.column
    next.column = dest
    next.order = orderBefore(valid.filter((t) => t.id !== id), dest, beforeId)
    changed = true
  }
  if (assignee !== undefined || forAi !== undefined) {
    const who = assignmentFields({
      assignee: assignee !== undefined ? assignee : cur.assignee,
      forAi: forAi !== undefined ? forAi : cur.forAi,
      tool: tool !== undefined ? tool : cur.tool
    })
    if (who.assignee !== cur.assignee || who.forAi !== cur.forAi || who.tool !== cur.tool) {
      next.assignee = who.assignee
      next.forAi = who.forAi
      next.tool = who.tool
      changed = true
    }
  }
  if (files !== undefined) {
    const list = cleanFiles(files)
    if (list.length !== cur.files.length || list.some((f, i) => f !== cur.files[i])) {
      next.files = list
      changed = true
    }
  }
  if (verified !== undefined) {
    const v = cleanVerified(verified)
    if (v !== cur.verified) { next.verified = v; changed = true }
  } else if (moving && cur.column === 'done' && cur.verified) {
    next.verified = ''
    changed = true
  }
  if (qaNotes !== undefined) {
    const q = cleanQaNotes(qaNotes)
    if (q !== (cur.qaNotes || '')) { next.qaNotes = q; changed = true }
  } else if (moving && cur.column === 'qa' && cur.qaNotes) {
    next.qaNotes = ''
    changed = true
  }
  if (recurring !== undefined) {
    if (typeof recurring !== 'boolean') throw new Error('recurring must be true or false')
    if (recurring !== !!cur.recurring) { next.recurring = recurring; changed = true }
  }
  if (cron !== undefined) {
    const c = parseSchedule(cron)
    if (c !== (cur.cron || '')) { next.cron = c; changed = true }
    if (c && !next.recurring) { next.recurring = true; changed = true }
  }
  if (!changed) return cur
  doc.transact(() => map.set(id, next), origin)
  return next
}

export function deleteTask (doc, map, id, origin) {
  const { valid } = split(map)
  if (!valid.some((t) => t.id === id)) throw new Error('no such task')
  doc.transact(() => map.delete(id), origin)
}

function taskLine (t, me) {
  const who = assigneeLabel(t, me)
  const files = (t.files || []).map((f) => `\`${f}\``).join(', ')
  const tail = [who ? ` → ${who}` : '', files ? ` · ${files}` : ''].join('')
  const repeat = t.recurring ? `\n  - repeats: ${t.cron ? cronToText(t.cron) : 'again, no schedule yet'}` : ''
  const verified = t.column === 'done' && t.verified ? `\n  - verified: ${shortVerified(t.verified)}` : ''
  const qa = t.column === 'qa' && t.qaNotes ? `\n  - qa: ${shortVerified(t.qaNotes)}` : ''
  return `- ${oneLine(t.title)} _(${t.by === me ? 'you' : oneLine(t.by) || 'someone'})_${tail}${repeat}${verified}${qa}`
}

function shortVerified (v) {
  const one = oneLine(v)
  return one.length > 160 ? `${one.slice(0, 157)}…` : one
}

function openTasks (list) {
  return list.filter((t) => t.column === 'todo' || t.column === 'doing')
}

/**
 * Markdown for people (STATUS.md, quilt_status). `me` is shown as "you".
 * `asAi` means the reader is that person's AI, so tasks assigned to the AI are theirs.
 * `mentionYours` adds "none are yours" when the reader has no open tasks.
 */
export function taskMarkdown (tasks, me, { tool = '', asAi = false, mentionYours = false } = {}) {
  const list = listed(tasks)
  if (!list.length) return mentionYours ? '_No tasks yet._\n\n_No open tasks are assigned to you._' : '_No tasks yet._'
  const reader = { name: me, asAi }
  const open = openTasks(list)
  const mine = open.filter((t) => assignedToReader(t, reader))
  const other = open.filter((t) => t.assignee === me && !assignedToReader(t, reader))
  const head = []
  if (mine.length) {
    const via = asAi ? ` — your ${assigneeTool(tool)}` : ''
    head.push(`**Yours**${via}`)
    head.push(mine.map((t) => `- ${oneLine(t.title)} (${columnName(t.column)})${fileTail(t)}`).join('\n'))
  } else if (mentionYours) head.push('_No open tasks are assigned to you._')
  if (other.length) {
    const label = asAi ? me : `your ${assigneeTool(other[0].tool || tool)}`
    head.push('', `**Open, assigned to ${label}**`)
    head.push(other.map((t) => `- ${oneLine(t.title)} (${columnName(t.column)})${fileTail(t)}`).join('\n'))
  }
  const cols = COLUMNS.map((col) => {
    const items = list.filter((t) => t.column === col.id)
    const body = items.length ? items.map((t) => taskLine(t, me)).join('\n') : '_Nothing._'
    return `**${col.name}**\n${body}`
  }).join('\n\n')
  return head.length ? `${head.join('\n')}\n\n${cols}` : cols
}

/** A project path from an AI action line ("Edited src/app.js"). Empty when it is not a file change. */
export function actionPath (text) {
  const m = CHANGE.exec(String(text || '').trim())
  if (!m) return ''
  const p = m[2].trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!p || p === 'a file') return ''
  return p
}

function rememberPrompt (prompts, conv, text) {
  if (!prompts || typeof prompts.delete !== 'function') return
  const line = String(text).split(/\r?\n/).map((s) => s.trim()).find(Boolean) || ''
  if (!line) return
  prompts.delete(conv)
  prompts.set(conv, line.slice(0, MAX_TITLE))
  while (prompts.size > 40) prompts.delete(prompts.keys().next().value)
}

// A stand-in until the AI's short title arrives (or for good, without one): the
// prompt's first sentence, cut at a word.
const AUTO_TITLE_MAX = 60

function autoTitle (prompt, files) {
  const line = cleanTitle(String(prompt || '').split(/\r?\n/)[0])
  if (line) {
    const sentence = line.match(/^.{12,}?[.!?](?=\s|$)/)?.[0] || line
    if (sentence.length <= AUTO_TITLE_MAX) return sentence
    const cut = sentence.slice(0, AUTO_TITLE_MAX - 1)
    const space = cut.lastIndexOf(' ')
    return `${(space > AUTO_TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '')}…`
  }
  if (!files.length) return ''
  const more = files.length - 1
  return cleanTitle(more ? `Edit ${files[0]} and ${more} more` : `Edit ${files[0]}`)
}

/**
 * What to do with one batch of AI chat entries. A prompt is remembered. A file
 * edit from the last couple of minutes opens an In progress task for that
 * chat, or adds the file to the task that chat already has. Questions, reads,
 * and older backfill do not create anything. `prompts` is updated in place.
 * `me` is the person whose chat this is, so a task is only extended when they
 * created it.
 */
export function planAutoTask ({ entries, tasks, prompts, now = Date.now(), me = '', sharing = true, windowMs = AUTO_TASK_MS } = {}) {
  const ops = []
  if (!entries?.length) return ops
  const fresh = new Map()
  for (const e of entries) {
    if (!e) continue
    const conv = cleanConv(e.conv)
    if (!conv) continue
    if (e.kind === 'prompt' && e.text) rememberPrompt(prompts, conv, e.text)
    if (!sharing || e.kind !== 'action') continue
    const ts = Number(e.ts)
    if (!Number.isFinite(ts) || now - ts > windowMs) continue
    let bucket = fresh.get(conv)
    if (!bucket) { bucket = { tool: '', files: [] }; fresh.set(conv, bucket) }
    if (e.tool) bucket.tool = cleanTool(e.tool)
    const p = actionPath(e.text)
    if (p && !bucket.files.includes(p)) bucket.files.push(p)
  }
  const open = (Array.isArray(tasks) ? tasks : []).filter((t) => t && (t.column === 'todo' || t.column === 'doing'))
  for (const [conv, bucket] of fresh) {
    const files = []
    for (const f of bucket.files) {
      try {
        const one = cleanFiles([f])
        if (one[0] && !files.includes(one[0])) files.push(one[0])
      } catch { /* not a project path */ }
      if (files.length >= MAX_FILES) break
    }
    const existing = open.find((t) => t.conv === conv && t.by === me)
    if (existing) {
      const merged = [...(existing.files || [])]
      let grew = false
      for (const f of files) {
        if (merged.includes(f) || merged.length >= MAX_FILES) continue
        merged.push(f)
        grew = true
      }
      if (grew) ops.push({ update: { id: existing.id, files: merged } })
      continue
    }
    if (!files.length) continue
    if (files.every((f) => open.some((t) => (t.files || []).includes(f)))) continue
    const title = autoTitle(prompts?.get(conv), files)
    if (!title || open.some((t) => t.title === title)) continue
    ops.push({ create: { title, files, conv, tool: bucket.tool, column: 'doing', request: prompts?.get(conv) || '' } })
    open.push({ title, files, conv, column: 'doing', by: me })
  }
  return ops
}

function assigneeTool (tool) {
  const t = oneLine(tool)
  return t && t !== 'unknown' ? t : 'AI'
}

function fileTail (t) {
  if (!t.files?.length) return ''
  return ` · ${t.files.map((f) => `\`${f}\``).join(', ')}`
}

function agentLine (t) {
  const who = assigneeLabel(t, '')
  const files = (t.files || []).join(', ')
  const tail = [who ? `  → ${who}` : '', files ? `  [${files}]` : ''].join('')
  const repeat = t.recurring ? `\n    repeats: ${t.cron ? cronToText(t.cron) : 'again, no schedule yet'}` : ''
  const verified = t.column === 'done' && t.verified ? `\n    verified: ${shortVerified(t.verified)}` : ''
  const qa = t.column === 'qa' && t.qaNotes ? `\n    qa: ${shortVerified(t.qaNotes)}` : ''
  return `- ${t.id}  ${oneLine(t.title)}  (${oneLine(t.by) || 'someone'})${tail}${repeat}${verified}${qa}`
}

/**
 * Plain text for an agent, with ids so it can move a task.
 * `reader` is { name, tool, asAi }. Open tasks assigned to that reader are listed first.
 */
export function formatTasks (tasks, reader) {
  const list = listed(tasks)
  const board = () => {
    if (!list.length) return 'No tasks yet. The board has four columns: To do, In progress, QA, and Done.'
    return COLUMNS.map((col) => {
      const items = list.filter((t) => t.column === col.id)
      const lines = items.length ? items.map(agentLine) : ['- Nothing.']
      return `${col.name}\n${lines.join('\n')}`
    }).join('\n\n')
  }
  if (!reader?.name) return board()
  const open = openTasks(list)
  const mine = open.filter((t) => assignedToReader(t, reader))
  const other = open.filter((t) => t.assignee === reader.name && !assignedToReader(t, reader))
  const lines = []
  if (!mine.length) lines.push('No open tasks are assigned to you.')
  else {
    const via = reader.asAi ? ` (your ${assigneeTool(reader.tool)})` : ''
    lines.push(`Yours — open tasks assigned to you${via}:`)
    for (const t of mine) lines.push(`- ${t.id}  ${oneLine(t.title)}  (${columnName(t.column)})${t.files?.length ? `  [${t.files.join(', ')}]` : ''}`)
  }
  if (other.length) {
    const label = reader.asAi ? reader.name : `your ${assigneeTool(other[0].tool || reader.tool)}`
    lines.push('', `Open, but assigned to ${label}, not to you:`)
    for (const t of other) lines.push(`- ${t.id}  ${oneLine(t.title)}  (${columnName(t.column)})`)
  }
  return `${lines.join('\n')}\n\n${board()}`
}
