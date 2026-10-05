// MCP servers hosted by the relay, working directly on a room's shared document.
//
// Hosted agents (handleHostedMcp): an AI with no computer of its own, or one that
// can't install Quilt, connects to https://<relay>/mcp with a pass from the accounts
// API (the API's /mcp hands it over with the agent's access key). It joins a session
// from an invite link, waits for the owner like anyone else, and then reads and
// writes the shared files, shares what it's doing, messages and claims files. Its
// file changes are CRDT edits, so they merge with everyone else's.
//
// The older link-based server (handleAgentMcp) is kept for relays without sign-in.
import crypto from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import * as Y from 'yjs'
import { capText, toolLabel } from './agents/common.js'
import { globMatcher, isSafeRelPath } from './pathrules.js'
import { readTasks, addTask, updateTask, deleteTask, taskMarkdown, formatTasks, columnName, assigneeLabel, assignmentFields } from './tasks.js'
import { applyTextDiff } from './textdiff.js'
import { parseInvite } from './ui/invite.js'
import { scanInbox, renderInbox } from './inbox.js'
import { UpdateCheck } from './update-check.js'
import { TASK_WORKFLOW, pickupBrief, doneRefusal, verifiedEnough, verifiedLine, pickChecklist, MAX_VERIFIED } from './agent-task-workflow.js'
import { HistoryLog, queryHistory, parseSince, formatHistory, currentTask } from './history.js'
import { changeRefusal, TALK_REFUSED } from './session-access.js'
import { chatAbout, renderChatAbout, waitingOn, renderUnanswered } from './duties.js'
import { describeSubscription, WEBHOOK_EVENTS } from './webhooks.js'

const FEED_CAP = 300
const ACTIVITY_CAP = 300
const TAB_STALE_MS = 3 * 60 * 1000
const MAX_WRITE_BYTES = 1024 * 1024
const HOSTED_AUTO_CLAIM_QUIET_MS = 10 * 60 * 1000 // a file a hosted agent stopped writing this long ago is let go of
const MAX_READ_CHARS = 200 * 1024
const AGENT = 'agent-mcp' // transaction origin

export const INSTRUCTIONS =
  'You are in a live quilt session: other people, each with their own AI, are editing this same project right now, ' +
  'and their changes appear in your files as they happen. ' +
  'When your user asks for something, call quilt_share with their request and a short plan before you start, and call it ' +
  'again with a short summary when you finish, so collaborators can follow along. ' +
  'Before starting a task, call quilt_status to see who is working on what, and quilt_tasks for the shared board ' +
  '(open tasks assigned to you are listed first). Assign work with quilt_assign_task. ' +
  'quilt_history tells you who changed which file, when, with the diff: read it for the files you are about to touch. ' +
  'Claims follow your edits: a file you change that nobody holds is claimed for you until you finish. ' +
  'Do not edit files someone else has claimed; message them with quilt_message instead. Claim ahead only for a larger change across several files. Always re-read a file right before editing it. ' +
  TASK_WORKFLOW

export const HOSTED_INSTRUCTIONS =
  'You are an AI agent in Quilt, where people and agents build one project together in real time. ' +
  'Join a session with quilt_join_session and the invite link you were given; the session owner may have to let you in first ' +
  '(quilt_session_info tells you). Then: quilt_status to see who is doing what, quilt_list_files and quilt_read_file to look ' +
  'around, quilt_write_file to change a file (always read it right before; the file is claimed for you while you work on it, release it with quilt_release when done), quilt_claim ahead of a larger change across several files, quilt_share to ' +
  'tell everyone what you are doing, and quilt_message to talk. The shared task board is quilt_tasks, quilt_add_task, quilt_assign_task and quilt_move_task. ' +
  'quilt_history tells you who changed which file, when, with the diff: read it for the files you are about to touch. ' +
  'Do not edit files someone else has claimed: a refused write tells you who holds the file; message them with quilt_message and carry on with other work. ' +
  'Read what people said about a file before you change it: quilt_read_messages, and each write tells you what was said about that file. ' +
  'This rule is enforced: while someone who messaged or mentioned you waits for an answer, writes, claims and task changes are refused until you answer with quilt_message. ' +
  'Everyone sees your changes on their own disk within moments. ' +
  'Mentions of you (@yourname), direct messages and tasks handed to you wait in quilt_inbox. To be woken instead of polling, ' +
  'call quilt_webhook_subscribe with a URL of yours: Quilt POSTs each one there as it happens. ' +
  TASK_WORKFLOW

const NOT_LINKED = 'Your user is not in a quilt session in their browser right now. Ask them to open quilt in their ' +
  'browser and share a folder or join one from an invite link, then try again. (This link is theirs and works for every session.)'
const NOT_JOINED = 'You are not in a session. Call quilt_join_session with an invite link (https://join.heyquilt.com/<room>#<secret>).'
const WAITING = 'The session owner has not let you in yet. They see you on their list; call quilt_session_info to check again.'
const DENIED = 'The session owner did not let you in. Ask them for a new invite and call quilt_join_session again.'
const REMOVED = 'You are no longer in that session. Ask for a new invite and call quilt_join_session again.'
// Let in by a grant, but the pass named no room: the accounts API retries with one for the
// room in x-quilt-room. A client that reaches the relay some other way just calls again.
const NEEDS_ROOM_PASS = 'Reconnecting you to the session. Call the same tool again.'

const id = () => crypto.randomBytes(8).toString('hex')

/** The chat `me` can see: public messages, and direct ones to or from them. */
const chatFor = (doc, me) => doc.getArray('chat').toArray().filter((m) => m && m.id && (!m.to || m.to === me || m.by === me))

/** Takes stock of a room for `me`'s inbox: what is already there wakes nobody. */
function takeStock (doc, me) {
  return { state: scanInbox({ messages: chatFor(doc, me), tasks: readTasks(doc.getMap('tasks')), reader: { name: me, asAi: false } }).state }
}

// The link-based server is made anew for every request; a link's inbox lives here between them.
const linkInboxes = new WeakMap()
const text = (t) => ({ content: [{ type: 'text', text: t }] })
const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true })

function ago (ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

const cleanPath = (p) => String(p || '').trim().replace(/^\.\//, '').replace(/^\/+/, '')

/**
 * The tools every relay-hosted MCP offers, on whatever room `ctx.room()` gives now.
 * ctx: { room(), me, who(), access(), tool(), warn() }: `who` is what claims belong to
 * ({ name } or { name, id }), `access` the caller's role and folders, `warn` extra text
 * for status, `withSession(fn)` runs a tool with the current room or explains why not.
 */
function sessionTools (server, ctx) {
  // The agent's image (its Quilt version) came with the request; an old one is told to update in every answer.
  const stale = (r) => {
    const n = ctx.updates && ctx.image ? ctx.updates.notice(ctx.image()) : ''
    if (!n || !r || !Array.isArray(r.content)) return r
    return { ...r, content: [...r.content, { type: 'text', text: `⚠️ ${n}` }] }
  }
  const tool = (name, def, fn) => server.registerTool(name, def, async (args) => stale(await ctx.withSession((room) => {
    const doc = room.doc
    const parts = { room, doc, feed: doc.getArray('agentFeed'), chat: doc.getArray('chat'), activity: doc.getArray('activity'), files: doc.getMap('files'), blobs: doc.getMap('blobs') }
    return fn(args || {}, parts)
  })))
  if (ctx.updates) {
    server.registerTool('quilt_check_update', {
      description: 'Whether the Quilt you run (your image) is current. Give the version you run (or send it as the x-quilt-image header with every request). An out-of-date image is told to update the app.',
      inputSchema: { image: z.string().max(40).optional().describe('The Quilt version you run, such as 0.3.4') }
    }, ({ image }) => text(ctx.updates.describe(image || (ctx.image ? ctx.image() : undefined))))
  }
  const me = ctx.me
  const writable = (room) => room.full ? 'This session is over its size limit, so nothing new can be saved.' : null
  const visible = (m) => m && m.id && (!m.to || m.to === me || m.by === me)
  const fmtMsg = (m) => `- ${m.by}${m.to ? ` → ${m.to} (direct)` : ''} (${ago(m.ts)}): ${m.text}${m.file ? ` [file: ${m.file.name}]` : ''}`
  const peers = (room) => {
    const out = []
    for (const s of room.awareness.getStates().values()) if (s && s.name && s.name !== me) out.push(s)
    for (const h of room.hostedOnline ? room.hostedOnline() : []) if (h.name !== me && !out.some((p) => p.name === h.name)) out.push({ name: h.name, kind: h.kind, tool: 'hosted', hosted: true })
    return out
  }
  const claimsOf = (room) => room.claimList ? room.claimList() : []
  // The rules every agent is held to (duties.js), enforced here because hosted agents work through these tools.
  const seen = (doc) => doc.getArray('chat').toArray().filter(visible)
  const waitRefusal = (doc, name) => renderUnanswered(waitingOn(seen(doc), me), `call ${name} again`)
  // Chat about a file this agent was already shown, by message id: kept with its inbox, since each
  // request to the hosted MCP gets fresh tools.
  const toldAbout = () => {
    const box = ctx.inbox ? ctx.inbox() : {}
    if (!Array.isArray(box.told)) box.told = []
    return box
  }
  // Claims follow this agent's writes: a file it changes that nobody holds is claimed for it, and let
  // go when it hasn't written the file for a while (it has no end of turn Quilt can see).
  const autoHeld = new Map() // `${roomId}\0${rel}` -> timer
  const roomKey = (room) => room.id || room.name || ''
  const autoClaim = (room, rel) => {
    const key = `${roomKey(room)}\0${rel}`
    clearTimeout(autoHeld.get(key))
    if (!autoHeld.has(key)) {
      try { room.claimRequest({ ...ctx.who(room), talk: ctx.access(room)?.talk !== false }, { op: 'claim', pattern: rel, note: 'editing' }) } catch { return false }
      room.broadcastClaims()
    }
    const timer = setTimeout(() => {
      autoHeld.delete(key)
      if (!claimsOf(room).some((c) => c.pattern === rel && c.by === me)) return
      try { room.claimRequest(ctx.who(room), { op: 'release', pattern: rel }); room.broadcastClaims() } catch {}
    }, HOSTED_AUTO_CLAIM_QUIET_MS)
    if (timer.unref) timer.unref()
    autoHeld.set(key, timer)
    return true
  }
  // One chronology writer per room, shared by every hosted agent's connection.
  const historyOf = (room) => {
    if (!room.historyLog) room.historyLog = new HistoryLog(room.doc, room.doc.getArray('history'), { origin: AGENT })
    return room.historyLog
  }

  tool('quilt_history', {
    description: 'The chronology of the project: who changed which file, when, what changed (diff) and for which task. ' +
      'Filter by path or glob, person, task or time. Use it to understand recent changes before building on them, or to find what broke something.',
    inputSchema: {
      path: z.string().max(500).optional().describe('A file, a folder ending in "/", or a glob like src/ui/**'),
      by: z.string().max(80).optional().describe('Only changes by this person or agent'),
      since: z.string().max(40).optional().describe('"2h", "3d", "today", "yesterday" or a date'),
      task: z.string().max(40).optional().describe('Only changes made for this task id'),
      with_diff: z.boolean().optional().describe('Include each change\'s diff (capped per change)'),
      limit: z.number().int().min(1).max(200).optional().describe('How many of the newest matching changes (default 30)')
    }
  }, ({ path: p, by, since, task, with_diff, limit }, { room }) => {
    const from = parseSince(since)
    if (from === undefined) return fail('since: use a duration like 2h or 3d, "today", "yesterday", or a date.')
    const list = queryHistory(historyOf(room).entries(), { path: p ? cleanPath(p) : '', by, since: from ?? undefined, task, limit: limit || 30 })
    return text(formatHistory(list, { withDiff: !!with_diff }))
  })

  tool('quilt_status', {
    description: 'See who else is in the live session, what they and their AIs are doing, recent file changes, claimed files and recent messages. Call this before starting a task.',
    inputSchema: {}
  }, (_, { room, doc, chat, activity }) => {
    const a = ctx.access(room)
    const lines = [`You are ${me} in a live quilt session (room ${room.name}).`]
    if (a && a.role === 'viewer') lines.push('You may only view this session: reading, chat and claims work, file changes are refused.')
    else if (a && a.scopes && a.scopes.length) lines.push(`You may change files only in: ${a.scopes.join(', ')}.`)
    if (a && a.scopesExcept && a.scopesExcept.length && a.role !== 'viewer') lines.push(`You may not change files in: ${a.scopesExcept.join(', ')}.`)
    if (a && a.talk === false) lines.push("You may not post in this session: quilt_message and quilt_share are refused.")
    lines.push('', '## People online')
    const ps = peers(room)
    if (!ps.length) lines.push('- Nobody else right now.')
    for (const p of ps) {
      const ag = p.agent || {}
      const ai = ag.sharing === false ? 'AI sharing paused' : ag.status === 'working' ? `${ag.tool || 'AI'} working` : ag.tool ? `${ag.tool} idle` : ''
      const editing = Object.keys(p.editing || {}).slice(0, 5)
      lines.push(`- ${p.name} (${p.tool || 'unknown tool'}${p.kind === 'agent' ? ', agent' : ''})${ai ? ` · ${ai}` : ''}${p.focus ? ` · focus: ${p.focus}` : ''}${editing.length ? ` · editing ${editing.join(', ')}` : ''}`)
    }
    const cl = claimsOf(room)
    lines.push('', '## Claimed files', ...(cl.length ? cl.map((c) => `- ${c.pattern} by ${c.by}${c.note ? ` (${c.note})` : ''}`) : ['- None.']))
    const acts = activity.toArray().filter(Boolean).slice(-12).reverse()
    lines.push('', '## Recent file changes', ...(acts.length ? acts.map((x) => `- ${x.by} ${x.kind} ${x.path} (${ago(x.ts)})`) : ['- None yet.']))
    const msgs = chat.toArray().filter(visible).slice(-8)
    lines.push('', '## Recent messages', ...(msgs.length ? msgs.map(fmtMsg) : ['- None.']))
    lines.push('', '## Tasks', taskMarkdown(readTasks(doc.getMap('tasks')), me, { tool: ctx.tool(), asAi: false, mentionYours: true }))
    if (ctx.webhook) { const w = ctx.webhook.get(); lines.push('', w ? `Webhook: Quilt POSTs to ${w.url} on ${w.events.join(', ')}.` : 'No webhook: subscribe with quilt_webhook_subscribe to be told of mentions, direct messages and tasks as they happen.') }
    return text(lines.join('\n') + ctx.warn(room))
  })

  const taskMap = (doc) => doc.getMap('tasks')

  const reader = () => ({ name: me, tool: ctx.tool(), asAi: false })
  const taskFields = ({ assignee, to_ai, files }, room) => {
    const spec = { me, peers: peers(room) }
    if (assignee != null) spec.assignee = assignee
    else if (to_ai) spec.assignee = 'me'
    if (to_ai) spec.to_ai = true
    if (files !== undefined) spec.files = files
    const name = spec.assignee === 'me' ? me : spec.assignee
    if (to_ai && (name == null || name === me)) spec.tool = ctx.tool()
    return assignmentFields(spec)
  }
  const assignedLine = (task) => {
    const label = assigneeLabel(task, me)
    const files = task.files?.length ? `\nFiles: ${task.files.join(', ')}` : ''
    return `${label ? `Assigned to ${label}.` : 'Unassigned.'}${files}`
  }

  tool('quilt_tasks', {
    description: 'List the shared task board (To do, In progress, Done), with an id on each task. Open tasks assigned to you are listed first.',
    inputSchema: {}
  }, (_, { doc }) => text(formatTasks(readTasks(taskMap(doc)), reader())))

  tool('quilt_add_task', {
    description: 'Add a task to the shared board, in To do. One short line. Optionally assign it to a person or their AI, and name the files it is about. It is added as you.',
    inputSchema: {
      title: z.string().describe('What needs doing, in a few words'),
      assignee: z.string().optional().describe('Who should do it: a person\'s name, or "me". Omit to leave it unassigned.'),
      to_ai: z.boolean().optional().describe('Assign it to that person\'s AI instead of the person. You are an agent in this session: leave to_ai unset to assign a task to yourself.'),
      files: z.array(z.string()).max(20).optional().describe('Project files this task is about, relative paths such as src/app.js')
    }
  }, ({ title, assignee, to_ai, files }, { room, doc }) => {
    { const w = waitRefusal(doc, 'quilt_add_task'); if (w) return fail(w) }
    const err = writable(room)
    if (err) return fail(err)
    try {
      const task = addTask(doc, taskMap(doc), { title, by: me, ...taskFields({ assignee, to_ai, files }, room) }, AGENT)
      return text(`Added to To do: ${task.title}\n${task.id}\n${assignedLine(task)}`)
    } catch (e) { return fail(e.message) }
  })

  const checklistOf = (files) => pickChecklist(files.get('AGENTS.md')?.toString(), files.get('CLAUDE.md')?.toString())
  tool('quilt_move_task', {
    description: 'Move a task on the shared board. "doing" when you start it: you get a briefing (its files, recent changes to them, claims, the project\'s checks). ' +
      '"done" when you finish: requires `verified`, what you ran and what you saw; without it the move is refused.',
    inputSchema: {
      id: z.string().describe('Task id from quilt_tasks'),
      column: z.enum(['todo', 'doing', 'done']).describe('todo, doing, or done'),
      verified: z.string().max(MAX_VERIFIED).optional().describe('For "done": what you ran and what you saw, concretely (commands, results, what you exercised in the app).')
    }
  }, ({ id, column, verified }, { room, doc, files }) => {
    { const w = waitRefusal(doc, 'quilt_move_task'); if (w) return fail(w) }
    const err = writable(room)
    if (err) return fail(err)
    try {
      const cur = readTasks(taskMap(doc)).find((t) => t.id === id)
      if (!cur) return fail('no such task')
      if (column === 'done' && !verifiedEnough(verified)) return fail(doneRefusal({ task: cur, checklist: checklistOf(files) }))
      const task = updateTask(doc, taskMap(doc), { id, column, ...(column === 'done' ? { verified } : {}) }, AGENT)
      if (column === 'doing') {
        const tf = task.files || []
        const all = historyOf(room).entries()
        const history = (tf.length ? all.filter((e) => tf.includes(e.path)) : all).slice(-8)
        const claims = claimsOf(room).filter((c) => !tf.length || tf.some((f) => globMatcher(c.pattern)(f)))
        return text(pickupBrief({ task, history, claims, checklist: checklistOf(files), me }))
      }
      if (column === 'done') return text(`Moved "${task.title}" to Done. Verified: ${verifiedLine(task)}`)
      return text(`Moved "${task.title}" to ${columnName(task.column)}.`)
    } catch (e) { return fail(e.message) }
  })

  tool('quilt_assign_task', {
    description: 'Assign a shared task to a person or to their AI, and optionally set the files it is about. assignee "" clears it. You are an agent here: assignee "me" without to_ai assigns it to you.',
    inputSchema: {
      id: z.string().describe('Task id from quilt_tasks'),
      assignee: z.string().describe('A person\'s name, "me", or "" to unassign'),
      to_ai: z.boolean().optional().describe('True: that person\'s AI. Omit or false: the person.'),
      files: z.array(z.string()).max(20).optional().describe('Replace the file list. Omit to leave the files unchanged.')
    }
  }, ({ id, assignee, to_ai, files }, { room, doc }) => {
    { const w = waitRefusal(doc, 'quilt_assign_task'); if (w) return fail(w) }
    const err = writable(room)
    if (err) return fail(err)
    try {
      const task = updateTask(doc, taskMap(doc), { id, ...taskFields({ assignee, to_ai, files }, room) }, AGENT)
      return text(assignedLine(task))
    } catch (e) { return fail(e.message) }
  })

  tool('quilt_delete_task', {
    description: 'Remove a task from the shared board.',
    inputSchema: { id: z.string().describe('Task id from quilt_tasks') }
  }, ({ id }, { room, doc }) => {
    { const w = waitRefusal(doc, 'quilt_delete_task'); if (w) return fail(w) }
    const err = writable(room)
    if (err) return fail(err)
    try {
      deleteTask(doc, taskMap(doc), id, AGENT)
      return text('Removed.')
    } catch (e) { return fail(e.message) }
  })

  tool('quilt_share', {
    description: 'Share what you are doing with your collaborators; it appears live in their quilt feed. Call it when you start on a request ' +
      '(`request`: what your user asked, in a sentence; `summary`: your plan) and again when you finish (`summary`: what you did; ' +
      '`files`: files you changed). Keep it short and never include secrets, keys or file contents.',
    inputSchema: {
      request: z.string().max(2000).optional().describe('What your user asked for, in a sentence (only when starting a new request)'),
      summary: z.string().max(4000).describe('Your plan, progress or result, in one to three sentences'),
      files: z.array(z.string().max(300)).max(30).optional().describe('Project files you changed, relative paths')
    }
  }, ({ request, summary, files: changed }, { room, doc, feed }) => {
    const err = writable(room)
    if (err) return fail(err)
    if (ctx.access(room)?.talk === false) return fail(TALK_REFUSED)
    const t = ctx.tool()
    const now = Date.now()
    const entries = []
    const base = { by: me, tool: t, conv: `mcp-${t}` }
    if (request && request.trim()) entries.push({ ...base, id: id(), kind: 'prompt', text: capText(request.trim()), ts: now })
    if (summary && summary.trim()) entries.push({ ...base, id: id(), kind: 'reply', text: capText(summary.trim()), ts: now })
    for (const f of changed || []) {
      const p = cleanPath(f)
      if (isSafeRelPath(p)) entries.push({ ...base, id: id(), kind: 'action', text: `Edited ${p}`, ts: now })
    }
    if (!entries.length) return fail('Nothing to share: give a summary.')
    doc.transact(() => {
      feed.push(entries)
      // Keep the newest FEED_CAP entries per person, like the CLI does.
      const mine = []
      feed.forEach((e, i) => { if (e && e.by === me) mine.push(i) })
      for (let k = mine.length - FEED_CAP - 1; k >= 0; k--) feed.delete(mine[k], 1)
    }, AGENT)
    return text(`Shared with the session.${ctx.warn(room)}`)
  })

  tool('quilt_partner_feed', {
    description: 'Read what a collaborator\'s AI has been doing: their prompts, the AI\'s replies and actions. Without `who`, lists whose feeds exist.',
    inputSchema: {
      who: z.string().optional().describe('Collaborator name'),
      limit: z.number().int().min(1).max(200).optional()
    }
  }, ({ who, limit }, { feed }) => {
    const all = feed.toArray().filter((e) => e && e.by !== me)
    if (!who) {
      const names = [...new Set(all.map((e) => e.by))]
      return text(names.length ? `Feeds: ${names.join(', ')}. Call again with "who".` : 'No one has shared AI activity yet.')
    }
    const theirs = all.filter((e) => e.by === who).slice(-(limit || 40))
    if (!theirs.length) return text(`No AI activity from ${who} yet.`)
    return text(theirs.map((e) => {
      if (e.kind === 'prompt') return `[${ago(e.ts)}] ${who} asked: ${e.text}`
      if (e.kind === 'reply') return `[${ago(e.ts)}] ${e.tool || 'AI'}: ${e.text}`
      if (e.kind === 'action') return `[${ago(e.ts)}] · ${e.text}`
      return `[${ago(e.ts)}] (${e.kind})`
    }).join('\n'))
  })

  tool('quilt_inbox', {
    description: 'What is waiting for you: mentions of you in chat (@yourname), direct messages to you, and tasks handed to you since you last looked. Act on each one: answer with quilt_message, take a task with quilt_move_task.',
    inputSchema: {}
  }, (_, { doc, chat }) => {
    const box = ctx.inbox ? ctx.inbox() : { state: null }
    const r = scanInbox({ messages: chat.toArray().filter(visible), tasks: readTasks(taskMap(doc)), reader: reader() }, box.state)
    box.state = r.state
    if (ctx.saveInbox) ctx.saveInbox()
    return text(renderInbox(r.events) || 'Nothing new for you.')
  })

  if (ctx.webhook) {
    tool('quilt_webhook_subscribe', {
      description: 'Be told as it happens, by an HTTP POST to a URL of yours, when you are mentioned in chat (@yourname), sent a direct message or handed a task: ' +
        'no need to poll quilt_inbox. One subscription per agent; calling again replaces it. Each POST is JSON, signed with the secret ' +
        '(x-quilt-signature: sha256=HMAC-SHA256(secret, "<x-quilt-timestamp>.<body>")); answer 2xx. Give a secret of your own or get one back (shown once).',
      inputSchema: {
        url: z.string().min(1).max(2000).describe('The https URL to POST to (a webhook trigger of your routine, for example)'),
        secret: z.string().max(200).optional().describe('16 to 200 characters for signing; omit to have Quilt make one'),
        events: z.array(z.enum(WEBHOOK_EVENTS)).max(WEBHOOK_EVENTS.length).optional().describe(`Which events to send (default: all): ${WEBHOOK_EVENTS.join(', ')}`),
        bearer: z.string().max(500).optional().describe('A key your receiver wants on every POST, sent as "Authorization: Bearer <key>" (a Grok Bot routine\'s sender key, for example)')
      }
    }, ({ url, secret, events, bearer }, { room }) => {
      try {
        const sub = ctx.webhook.subscribe(room, { url, secret, events, bearer })
        return text(describeSubscription(sub, { showSecret: sub.made }))
      } catch (e) { return fail(e.message) }
    })

    tool('quilt_webhook_unsubscribe', {
      description: 'Stop the webhook: Quilt no longer POSTs mentions, direct messages and tasks to you. quilt_inbox still has them.',
      inputSchema: {}
    }, () => text(ctx.webhook.unsubscribe() ? 'Webhook removed. Mentions, direct messages and tasks still wait in quilt_inbox.' : 'You had no webhook.'))
  }

  tool('quilt_message', {
    description: 'Send a chat message to everyone in the session, or to one person with `to`.',
    inputSchema: {
      text: z.string().min(1).max(4000),
      to: z.string().optional().describe('Name of one person, for a direct message')
    }
  }, ({ text: t, to }, { room, doc, chat }) => {
    const err = writable(room)
    if (err) return fail(err)
    if (ctx.access(room)?.talk === false) return fail(TALK_REFUSED)
    const msg = { id: id(), by: me, to: to || null, text: t, ts: Date.now() }
    doc.transact(() => {
      chat.push([msg])
      if (chat.length > 500) chat.delete(0, chat.length - 500)
    }, AGENT)
    return text(to ? `Sent to ${to}.` : 'Sent to everyone.')
  })

  tool('quilt_read_messages', {
    description: 'Read recent chat messages in the session (including direct messages to you).',
    inputSchema: { limit: z.number().int().min(1).max(100).optional() }
  }, ({ limit }, { chat }) => {
    const msgs = chat.toArray().filter(visible).slice(-(limit || 20))
    return text(msgs.length ? msgs.map(fmtMsg).join('\n') : 'No messages yet.')
  })

  tool('quilt_list_files', {
    description: 'List the shared project files with who is working on them (claims).',
    inputSchema: { under: z.string().optional().describe('Only files under this folder') }
  }, ({ under }, { room, files, blobs }) => {
    const pre = under ? cleanPath(under).replace(/\/+$/, '') + '/' : ''
    const cl = claimsOf(room).map((c) => ({ ...c, m: globMatcher(c.pattern) }))
    const paths = [...new Set([...files.keys(), ...blobs.keys()])].filter((p) => isSafeRelPath(p) && (!pre || p.startsWith(pre))).sort()
    const shown = paths.slice(0, 500).map((p) => {
      const c = cl.find((x) => x.m(p))
      return `- ${p}${c ? ` (claimed by ${c.by})` : ''}`
    })
    return text(paths.length ? shown.join('\n') + (paths.length > 500 ? `\n… and ${paths.length - 500} more` : '') : 'No files.')
  })

  tool('quilt_read_file', {
    description: 'Read a shared project file as text, as it is right now.',
    inputSchema: { path: z.string().min(1).max(500).describe('Relative path, e.g. src/app.ts') }
  }, ({ path: p }, { files, blobs }) => {
    const rel = cleanPath(p)
    if (!isSafeRelPath(rel)) return fail('That is not a path inside the project.')
    const t = files.get(rel)
    if (t) {
      const s = t.toString()
      return text(s.length > MAX_READ_CHARS ? s.slice(0, MAX_READ_CHARS) + `\n… (${s.length - MAX_READ_CHARS} more characters not shown)` : s)
    }
    const b = blobs.get(rel)
    if (b && b.stored) return fail(`${rel} is a large file kept in storage (${b.size} bytes); it can't be read here.`)
    if (b) return fail(`${rel} is a binary file (${Buffer.from(b.data || '', 'base64').length} bytes); it can't be read as text.`)
    return fail(`There is no file called ${rel} in the session.`)
  })

  tool('quilt_write_file', {
    description: 'Write a text file in the shared project (new or existing): everyone gets it on their disk within moments. ' +
      'Give the whole file; it is merged as an edit, so changes others make elsewhere in the file survive. Read the file right before.',
    inputSchema: {
      path: z.string().min(1).max(500).describe('Relative path, e.g. src/app.ts'),
      content: z.string().max(MAX_WRITE_BYTES).describe('The whole new contents of the file')
    }
  }, ({ path: p, content }, { room, doc, files, blobs, activity }) => {
    { const w = waitRefusal(doc, 'quilt_write_file'); if (w) return fail(w) }
    const err = writable(room)
    if (err) return fail(err)
    const rel = cleanPath(p)
    if (!isSafeRelPath(rel)) return fail('That is not a path inside the project.')
    const a = ctx.access(room)
    if (a && a.role === 'viewer') return fail('You can only view this session; file changes are refused.')
    const refusal = a && changeRefusal(a, rel)
    if (refusal) return fail(`${refusal[0].toUpperCase()}${refusal.slice(1)}.`)
    const claim = claimsOf(room).find((c) => c.by !== me && globMatcher(c.pattern)(rel))
    if (claim) return fail(`${rel} is claimed by ${claim.by}${claim.note ? ` (${claim.note})` : ''}. Do not retry: send ${claim.by} a direct message with quilt_message saying what you wanted to change and why, then carry on with other work.`)
    if (blobs.get(rel)?.stored) return fail(`${rel} is a large file kept in storage; it can't be changed here.`)
    const held = claimsOf(room).some((c) => c.by === me && globMatcher(c.pattern)(rel))
    const claimedNow = !held && autoClaim(room, rel)
    if (held && autoHeld.has(`${roomKey(room)}\0${rel}`)) autoClaim(room, rel) // still writing it: keep holding
    if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) return fail('That file is too big to write here (1 MB at most).')
    let detail = ''
    let existed = false
    doc.transact(() => {
      existed = files.has(rel) || blobs.has(rel)
      blobs.delete(rel)
      let ytext = files.get(rel)
      if (!ytext) { ytext = new Y.Text(); files.set(rel, ytext) }
      const before = ytext.toString()
      detail = applyTextDiff(ytext, content)
      const kind = existed ? 'edited' : 'created'
      activity.push([{ by: me, path: rel, kind, detail, ts: Date.now() }])
      if (activity.length > ACTIVITY_CAP) activity.delete(0, activity.length - ACTIVITY_CAP)
      historyOf(room).record({ by: me, path: rel, kind, before, after: content, task: currentTask(readTasks(taskMap(doc)), me) })
    }, AGENT)
    // What people said about this file in chat, so the agent works with it in mind (each message once).
    const box = toldAbout()
    const said = chatAbout([rel], { messages: seen(doc), me }).filter((m) => m.id && !box.told.includes(m.id))
    if (said.length) {
      box.told = [...box.told, ...said.map((m) => m.id)].slice(-200)
      if (ctx.saveInbox) ctx.saveInbox()
    }
    const context = renderChatAbout(said)
    return text(`${existed ? 'Updated' : 'Created'} ${rel}${detail ? ` (${detail} lines)` : ' (no change)'}. Everyone in the session has it now.${claimedNow ? ` ${rel} is claimed for you while you work on it; quilt_release it when you are done.` : ''}${context ? `\n\n${context}` : ''}`)
  })

  tool('quilt_claim', {
    description: 'Claim files or folders (a path or glob like src/auth/**) before a larger change, so others know not to edit them.',
    inputSchema: {
      pattern: z.string().min(1).max(300),
      note: z.string().max(500).optional().describe('What you are doing')
    }
  }, ({ pattern, note }, { room, doc }) => {
    { const w = waitRefusal(doc, 'quilt_claim'); if (w) return fail(w) }
    const err = writable(room)
    if (err) return fail(err)
    try {
      // Someone who may not post keeps their claim but not its note, which everyone reads.
      const r = room.claimRequest({ ...ctx.who(room), talk: ctx.access(room)?.talk !== false }, { op: 'claim', pattern: pattern.trim(), note: note || '' })
      if (r.ok === false) return fail(r.error || 'Could not claim that.')
      const key = `${roomKey(room)}\0${pattern.trim()}`
      clearTimeout(autoHeld.get(key)); autoHeld.delete(key) // claimed on purpose now: kept until released
    } catch (e) { return fail(e.message) }
    room.broadcastClaims()
    return text(`Claimed ${pattern.trim()}. Release it with quilt_release when done.`)
  })

  tool('quilt_release', {
    description: 'Release a claim (or all of your claims when no pattern is given).',
    inputSchema: { pattern: z.string().optional() }
  }, ({ pattern }, { room }) => {
    const mine = claimsOf(room).filter((c) => c.by === me && (!pattern || c.pattern === pattern.trim()))
    const released = []
    for (const c of mine) {
      try { room.claimRequest(ctx.who(room), { op: 'release', pattern: c.pattern }); released.push(c.pattern) } catch {}
      const key = `${roomKey(room)}\0${c.pattern}`
      clearTimeout(autoHeld.get(key)); autoHeld.delete(key)
    }
    if (released.length) room.broadcastClaims()
    return text(released.length ? `Released ${released.join(', ')}.` : 'Nothing to release.')
  })
}

async function serve (mcp, req, res) {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}) })
  await mcp.connect(transport)
  await transport.handleRequest(req, res)
}

/**
 * Hosted agents: one MCP request (stateless) for the holder of `pass`, who is in whichever
 * session `relay.hosted` remembers for them. `relay` is { getRoom, roomEnded, refused, hosted,
 * saveHosted, log, endedMessage }.
 */
export async function handleHostedMcp ({ req, res, pass, relay }) {
  const image = String(req.headers['x-quilt-image'] || '').trim()
  const mcp = new McpServer({ name: 'quilt', version: '0.2.0' }, { instructions: HOSTED_INSTRUCTIONS })
  const me = pass.name
  const account = `${pass.kind}:${pass.sub}`
  const touched = new Set()
  const done = () => { for (const room of touched) if (room && !room.conns.size && room.onEmpty) room.onEmpty() }
  res.on('close', done)
  // Which session the agent is in, for the accounts API: its next pass is for that room,
  // and so carries the agent's grant there. Absent: in no session.
  const tellRoom = () => {
    if (res.headersSent) return
    const h = relay.hosted.get(account)
    if (h) res.setHeader('x-quilt-room', h.room)
    else res.removeHeader('x-quilt-room')
  }
  tellRoom()

  /** The room this agent is in, with its standing there, or why it has none: { room, access } | { error }. */
  const current = () => {
    const h = relay.hosted.get(account)
    if (!h) return { error: NOT_JOINED }
    if (relay.roomEnded(h.room)) { relay.hosted.delete(account); relay.saveHosted(); return { error: `${relay.endedMessage}. ${NOT_JOINED}` } }
    const room = relay.getRoom(h.room)
    if (!room) return { error: relay.refused(h.room)[1] }
    touched.add(room)
    if (!room.exists) { relay.hosted.delete(account); relay.saveHosted(); return { error: REMOVED } }
    if (h.denied) { relay.hosted.delete(account); relay.saveHosted(); tellRoom(); return { error: DENIED } }
    const access = room.hostedAccess(pass)
    if (access.needsRoomPass) {
      if (!res.headersSent) res.setHeader('x-quilt-retry', 'room-pass')
      return { error: NEEDS_ROOM_PASS, room, access }
    }
    if (access.state !== 'approved') {
      // Still waiting, but the relay restarted and forgot: back on the owner's list.
      if (h.pending && ![...room.pending].some(([k, p]) => k.hosted && p.id === account)) room.hostedRequest(pass, h.invitedAs || 'viewer')
      return { error: h.pending ? WAITING : REMOVED, room, access }
    }
    h.seenAt = Date.now()
    relay.saveHosted()
    room.hostedActive(account)
    return { room, access }
  }
  const ctx = {
    me,
    who: () => ({ name: me, id: account }),
    access: (room) => room.hostedAccess(pass),
    tool: () => toolLabel(mcp.server.getClientVersion()?.name) || 'hosted',
    warn: () => '',
    inbox: () => {
      const h = relay.hosted.get(account)
      if (!h.inbox) h.inbox = { state: null }
      return h.inbox
    },
    saveInbox: () => relay.saveHosted(),
    webhook: relay.webhooks ? {
      get: () => relay.hosted.get(account)?.webhook || null,
      subscribe: (room, given) => relay.webhooks.subscribe(account, { name: me, room }, given),
      unsubscribe: () => relay.webhooks.unsubscribe(account)
    } : null,
    updates: relay.updates || null,
    image: () => image,
    withSession: (fn) => {
      const c = current()
      return c.error ? fail(c.error) : fn(c.room)
    }
  }

  mcp.registerTool('quilt_join_session', {
    description: 'Join a live quilt session from an invite link (https://join.heyquilt.com/<room>#<secret>). The session owner may have to let you in; call quilt_session_info to see when they have.',
    inputSchema: { invite: z.string().min(1).max(600).describe('The invite link, or the full "quilt join <link>" command') }
  }, ({ invite }) => {
    let inv
    try { inv = parseInvite(invite, { allowRelay: () => true }) } catch (err) { return fail(err.message) }
    if (relay.roomEnded(inv.room)) return fail(`${relay.endedMessage}. Ask for a new invite.`)
    const room = relay.getRoom(inv.room)
    if (!room) return fail(relay.refused(inv.room)[1])
    touched.add(room)
    if (!room.exists) return fail("That session isn't running on the relay (yet). Ask the person who invited you to start it, then try again.")
    const auth = room.authorize(inv.secret, '')
    if (auth !== 'editor' && auth !== 'viewer') return fail('Wrong room secret: copy the whole invite link, including the part after #.')
    const a = room.hostedRequest(pass, auth)
    // A webhook outlives the session it was set in: it carries over to the next one, with a fresh take of its room.
    const webhook = relay.webhooks ? relay.webhooks.rejoin(relay.hosted.get(account)?.webhook, { name: me, room }) : undefined
    relay.hosted.set(account, { room: inv.room, since: Date.now(), seenAt: Date.now(), pending: a.state === 'pending', ...(a.state === 'pending' ? { invitedAs: auth, name: me, kind: pass.kind } : {}), inbox: takeStock(room.doc, me), ...(webhook ? { webhook } : {}) })
    relay.saveHosted()
    tellRoom()
    if (a.state === 'pending') return text(`Asked to join room ${inv.room} as ${auth === 'viewer' ? 'a viewer' : 'an editor'}. ${WAITING}`)
    room.hostedActive(account)
    return text(`Joined room ${inv.room} as ${me} (${a.owner ? 'owner' : a.role}${a.scopes && a.scopes.length ? `, folders ${a.scopes.join(', ')}` : ''}). Call quilt_status to see who is here.`)
  })

  mcp.registerTool('quilt_session_info', {
    description: 'Which session you are in and your access there: waiting for the owner, or let in as an editor or viewer.',
    inputSchema: {}
  }, () => {
    const h = relay.hosted.get(account)
    if (!h) return text(NOT_JOINED)
    const c = current()
    if (c.error && !c.room) return fail(c.error)
    if (c.error) return text(`Room ${h.room}: ${c.error}`)
    const a = c.access
    return text(`Room ${h.room}: you are ${me}, ${a.owner ? 'the owner' : a.role === 'viewer' ? 'a viewer (no file changes)' : 'an editor'}${a.scopes && a.scopes.length ? `, limited to ${a.scopes.join(', ')}` : ''}${a.scopesExcept && a.scopesExcept.length ? `, not in ${a.scopesExcept.join(', ')}` : ''}${a.talk === false ? ', and you may not post' : ''}.`)
  })

  mcp.registerTool('quilt_leave_session', {
    description: 'Leave the session you are in.',
    inputSchema: {}
  }, () => {
    const h = relay.hosted.get(account)
    if (!h) return text('You are not in a session.')
    relay.hosted.delete(account)
    relay.saveHosted()
    tellRoom()
    const room = relay.getRoom(h.room)
    if (room) {
      touched.add(room)
      room.hostedSeen.delete(account)
      for (const [k, p] of room.pending) if (k.hosted && p.id === account) room.pending.delete(k)
      room.broadcastMembers()
    }
    return text(`Left room ${h.room}.`)
  })

  sessionTools(mcp, ctx)
  await serve(mcp, req, res)
}

/**
 * Handles one MCP request (stateless: a fresh server per request) for the older
 * link-based flow: a browser's token tied to a room by /agent/link.
 * @param {object} o
 * @param {object} o.room   the relay Room (doc, awareness, full)
 * @param {object} o.link   { name, tool, tabSeenAt }
 * @param {string} [o.toolHint] tool name from the URL (?tool=Cursor)
 */
export async function handleAgentMcp ({ req, res, room, link, toolHint, updates = null }) {
  const mcp = new McpServer({ name: 'quilt', version: '0.1.0' }, { instructions: INSTRUCTIONS })
  const me = link ? link.name : ''
  const image = String(req.headers['x-quilt-image'] || '').trim()
  const ctx = {
    me,
    updates,
    image: () => image,
    who: () => ({ name: me }),
    access: () => null,
    tool: () => toolHint || toolLabel(mcp.server.getClientVersion()?.name),
    warn: () => Date.now() - (link.tabSeenAt || 0) > TAB_STALE_MS
      ? `\n\n⚠️ ${me}'s quilt browser tab doesn't seem to be open, so file changes aren't syncing. Ask your user to reopen quilt in their browser.`
      : '',
    withSession: (fn) => (room && link) ? fn(room) : fail(NOT_LINKED),
    inbox: () => {
      let box = link ? linkInboxes.get(link) : null
      if (!box) {
        box = room && link ? takeStock(room.doc, me) : { state: null }
        if (link) linkInboxes.set(link, box)
      }
      return box
    }
  }
  sessionTools(mcp, ctx)
  await serve(mcp, req, res)
}
