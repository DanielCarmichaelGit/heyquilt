// Comments on a task: work notes, handoffs and the reasoning behind an assignment, kept on
// the ticket instead of in the session chat. Stored apart from the task (map "taskComments",
// task id -> list), so an app from before comments existed can move or edit a task without
// dropping them.
import crypto from 'node:crypto'

export const MAX_COMMENT = 2000
export const MAX_COMMENTS = 50 // per task: the oldest go first
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g // eslint-disable-line no-control-regex

/** A comment's text: newlines kept, control characters and bidi overrides dropped. */
export function cleanComment (text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').replace(INVISIBLE, ' ')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trimEnd()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_COMMENT).trimEnd()
}

/** A stored comment we'll show, or null for anything a modified client pushed that isn't this shape. */
function publicComment (c) {
  if (!c || typeof c !== 'object') return null
  if (typeof c.id !== 'string' || !/^[0-9a-f]{16}$/.test(c.id)) return null
  if (typeof c.by !== 'string' || !c.by || c.by.length > 80) return null
  if (typeof c.text !== 'string' || !c.text || c.text !== cleanComment(c.text)) return null
  if (typeof c.ts !== 'number' || !Number.isFinite(c.ts)) return null
  return { id: c.id, by: c.by, text: c.text, ts: c.ts }
}

/** The comments on task `id`, oldest first. */
export function readComments (map, id) {
  const list = map && map.get(id)
  return Array.isArray(list) ? list.map(publicComment).filter(Boolean) : []
}

/** Every task's comments: { taskId: [comment] }, for tasks that have any. */
export function allComments (map) {
  const out = {}
  if (!map) return out
  map.forEach((_, id) => { const list = readComments(map, id); if (list.length) out[id] = list })
  return out
}

/** `tasks` with `comments` on each (an empty list when it has none). */
export function withComments (tasks, map) {
  const all = allComments(map)
  return tasks.map((t) => ({ ...t, comments: all[t.id] || [] }))
}

/** Adds a comment by `by` to task `taskId` (which must be on the board). Returns the comment. */
export function addComment (doc, map, tasks, { taskId, by, text }, origin) {
  if (!tasks.some((t) => t.id === taskId)) throw new Error('no such task')
  const clean = cleanComment(text)
  if (!clean) throw new Error('say what the comment is')
  const who = String(by ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'someone'
  const comment = { id: crypto.randomBytes(8).toString('hex'), by: who, text: clean, ts: Date.now() }
  const next = [...readComments(map, taskId), comment].slice(-MAX_COMMENTS)
  // Comments of tasks no longer on the board go at the same time.
  const ids = new Set(tasks.map((t) => t.id))
  const gone = [...map.keys()].filter((id) => !ids.has(id))
  doc.transact(() => {
    for (const id of gone) map.delete(id)
    map.set(taskId, next)
  }, origin)
  return comment
}

/** Plain text for an agent: one comment per paragraph. */
export function formatComments (list, ago) {
  if (!list.length) return 'No comments yet.'
  return list.map((c) => `- ${c.by} (${ago(c.ts)}): ${c.text.replace(/\n/g, '\n  ')}`).join('\n')
}

/** One task in full, as plain text for an agent: `task` as the board lists it, with `comments`. */
export function formatTaskDetails (task, now = Date.now()) {
  const ago = (ts) => {
    const s = Math.max(0, Math.round((now - (ts || 0)) / 1000))
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`
  }
  const column = { todo: 'To do', doing: 'In progress', qa: 'QA', done: 'Done' }[task.column] || task.column
  const who = task.assignee ? `${task.assignee}${task.forAi ? `'s AI${task.tool ? ` (${task.tool})` : ''}` : ''}` : 'nobody'
  const comments = Array.isArray(task.comments) ? task.comments : []
  return [
    task.title,
    `id: ${task.id}`,
    `Column: ${column}`,
    `Assigned to: ${who}`,
    `Added by ${task.by}, ${ago(task.ts)}`,
    task.files?.length ? `Files: ${task.files.join(', ')}` : null,
    task.qaNotes ? `QA notes:\n${task.qaNotes}` : null,
    task.verified ? `Verified:\n${task.verified}` : null,
    `Comments (${comments.length}):\n${formatComments(comments, ago)}`
  ].filter((x) => x !== null).join('\n')
}
