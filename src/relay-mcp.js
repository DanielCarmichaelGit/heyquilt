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
import { cleanGit, branchBoard, branchesMarkdown } from './branches.js'
import crypto from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import * as Y from 'yjs'
import { capText, toolLabel } from './agents/common.js'
import { globMatcher, isSafeRelPath } from './pathrules.js'
import { readTasks, addTask, updateTask, deleteTask, taskMarkdown, formatTasks, columnName, assigneeLabel, assignmentFields } from './tasks.js'
import { readComments, addComment, withComments, formatTaskDetails, MAX_COMMENT } from './task-comments.js'
import { applyTextDiff } from './textdiff.js'
import { parseInvite } from './ui/invite.js'
import { scanInbox, renderInbox } from './inbox.js'
import { UpdateCheck } from './update-check.js'
import { TASK_WORKFLOW, pickupBrief, doneRefusal, verifiedEnough, verifiedLine, qaRefusal, qaNotesEnough, qaNotesLine, pickChecklist, MAX_VERIFIED } from './agent-task-workflow.js'
import { HistoryLog, queryHistory, parseSince, formatHistory, currentTask } from './history.js'
import { changeRefusal, TALK_REFUSED } from './session-access.js'
import { aiName } from './persona.js'
import { chatAbout, renderChatAbout, waitingOn, renderUnanswered, heldRefusal, queuedFor, renderQueueNotice, renderQueued, answered, unaddressed, CHAT_RULES } from './duties.js'
import { describeSubscription, WEBHOOK_EVENTS } from './webhooks.js'
import { registerWorkspaceTools, bytesFetcher, WORKSPACE_GUIDE } from './workspace-tools.js'

const FEED_CAP = 300
const ACTIVITY_CAP = 300
const TAB_STALE_MS = 3 * 60 * 1000
const MAX_WRITE_BYTES = 1024 * 1024
const HOSTED_AUTO_CLAIM_QUIET_MS = 10 * 60 * 1000 // a file a hosted agent stopped writing this long ago is let go of
const MAX_READ_CHARS = 200 * 1024
// Tools that read or change a branch's files, claims or history: a hosted agent's first one pins its branch (Room.pinHostedBranch).
const FILE_TOOLS = new Set(['quilt_history', 'quilt_list_files', 'quilt_read_file', 'quilt_write_file', 'quilt_claim', 'quilt_release', 'quilt_request_file', 'quilt_handoff', 'quilt_withdraw_request'])
const AGENT = 'agent-mcp' // transaction origin

export const INSTRUCTIONS =
  'You are in a live quilt session: other people, each with their own AI, are editing this same project right now, ' +
  'and their changes appear in your files as they happen. ' +
  'When your user asks for something, call quilt_share with their request and a short plan before you start, and call it ' +
  'again with a short summary when you finish, so collaborators can follow along. ' +
  'Before starting a task, call quilt_status to see who is working on what, and quilt_tasks for the shared board ' +
  '(open tasks assigned to you are listed first). Assign work with quilt_assign_task; quilt_task reads one task in full with its comments, and quilt_comment_task leaves a note or handoff on it. ' +
  'quilt_history tells you who changed which file, when, with the diff: read it for the files you are about to touch. ' +
  'Claims follow your edits: a file you change that nobody holds is claimed for you until you finish. ' +
  'Do not edit files someone else has claimed: ask for the file in its file queue with quilt_request_file (a title and up to 300 characters on what you plan), and you are handed it with context when they are done. ' +
  'When someone waits in the queue for a file you hold, finish your change and hand it off with quilt_handoff and your context; you cannot finish or release it before. Claim ahead only for a larger change across several files. Always re-read a file right before editing it. ' +
  TASK_WORKFLOW

export const HOSTED_INSTRUCTIONS =
  'You are an AI agent in Quilt, where people and agents build one project together in real time. ' +
  'Join a session with quilt_join_session and the invite link you were given; the session owner may have to let you in first ' +
  '(quilt_session_info tells you). Then: quilt_status to see who is doing what, quilt_list_files and quilt_read_file to look ' +
  'around, quilt_write_file to change a file (always read it right before; the file is claimed for you while you work on it, release it with quilt_release when done), quilt_claim ahead of a larger change across several files, quilt_share to ' +
  'tell everyone what you are doing, and quilt_message to talk. The shared task board is quilt_tasks, quilt_add_task, quilt_assign_task and quilt_move_task; quilt_task reads one in full with its comments, and quilt_comment_task leaves a work note or handoff on it. ' +
  'quilt_history tells you who changed which file, when, with the diff: read it for the files you are about to touch. ' +
  'Do not edit files someone else has claimed: a refused write tells you who holds the file; ask for it in its file queue with quilt_request_file (a title, and up to 300 characters on what you plan) and carry on with other work: you are woken when it is handed to you. ' +
  'When someone waits in the queue for a file you hold, every answer says so: finish your change, then hand it off with quilt_handoff and your context (what you changed, what is left). You cannot finish a task or release the file before. A claim whose holder does nothing for 20 minutes goes to the next in its queue. ' +
  'Read what people said about a file before you change it: quilt_read_messages, and each write tells you what was said about that file. ' +
  'This rule is enforced: while someone who messaged or mentioned you waits for an answer, writes, claims and task changes are refused until you answer with quilt_message. ' +
  'Everyone sees your changes on their own disk within moments. ' +
  'Chat: ' + CHAT_RULES.replace(/^Send a chat message\. /, '') + ' A message that needs nothing back is settled with quilt_inbox (no_reply: [its id]), not answered. ' +
  'Mentions of you (@yourname), direct messages and tasks handed to you wait in quilt_inbox. To be woken instead of polling, ' +
  'call quilt_webhook_subscribe with a URL of yours: Quilt POSTs each one there as it happens. ' +
  'You are connected over HTTP, so you show as online for 30 minutes after each tool call: while idle, call quilt_inbox at least every 30 minutes so people can see you are still there. ' +
  'HTTP is only for an agent with no computer. If you can run shell commands anywhere (a computer, a cloud machine, a sandbox), you must use the Quilt CLI there instead (`quilt agent join`, then `quilt join <invite> --agent <your name>`): files sync to disk and you show as live. ' +
  'A session has a branch for each git branch its members work on, each with its own files: quilt_status lists them and who is on each, and your first call on files puts you on the busiest one, where you stay until you pick another with quilt_switch_branch (create: true starts a new one from the files you have). ' +
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
  return { state: scanInbox({ messages: chatFor(doc, me), tasks: readTasks(doc.getMap('tasks')), reader: { name: me, asAi: false, agent: true } }).state }
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
  // Someone waiting in the file queue for a file this agent holds is told to it with every answer, until it hands the file off.
  const queueNote = (room, r) => {
    const n = renderQueueNotice(queuedFor(claimsOf(room), me))
    if (!n || !r || !Array.isArray(r.content)) return r
    return { ...r, content: [...r.content, { type: 'text', text: `📥 ${n}` }] }
  }
  // Files, claims and history are a branch's: the agent's own (hosted agents can choose one), or the session's active branch.
  const branchOf = (room) => ctx.branch ? ctx.branch(room) : room.activeBranch ? room.activeBranch() : null
  // The branch document the agent works on (its store entry), or null for a room without branch documents.
  // The session's default branch may always start; any other new branch only for someone who may change files.
  const branchEntry = (room) => {
    if (!room.branchDoc) return null
    const key = branchOf(room)
    const editor = room.resolveKey(key) === room.defaultKey || ctx.access(room)?.role !== 'viewer'
    return room.branchDoc(key, { by: me, editor })
  }
  const tool = (name, def, fn) => server.registerTool(name, def, async (args) => stale(await ctx.withSession((room) => {
    // A hosted agent with no branch of its own is pinned to the active branch by its first call
    // on files, so a read and the write after it never land on two different branches.
    if (ctx.pin && FILE_TOOLS.has(name)) ctx.pin(room)
    // The audit trail: which tool, on what (a path, a pattern or a task id; never contents).
    const caller = ctx.who(room)
    if (caller && caller.id && room.audit) {
      const a = args || {}
      const on = [a.path, a.pattern, a.id, a.under].find((x) => typeof x === 'string' && x)
      room.audit(caller.id, 'tool', on ? `${name} ${on}` : name)
    }
    const doc = room.doc
    const branch = branchEntry(room)
    const fdoc = branch ? branch.doc : doc
    const parts = { room, doc, fdoc, branch, feed: doc.getArray('agentFeed'), chat: doc.getArray('chat'), activity: doc.getArray('activity'), files: fdoc.getMap('files'), blobs: fdoc.getMap('blobs') }
    // Changes the tool makes to the session (files, chat, the board) go in this agent's audit trail.
    const prev = room.auditAs
    room.auditAs = caller && caller.id
    try { return queueNote(room, fn(args || {}, parts)) } finally { room.auditAs = prev }
  })))
  if (ctx.updates) {
    server.registerTool('quilt_check_update', {
      description: 'Whether the Quilt you run (your image) is current. Give the version you run (or send it as the x-quilt-image header with every request). An out-of-date image is told to update the app.',
      inputSchema: { image: z.string().max(40).optional().describe('The Quilt version you run, such as 0.3.4') }
    }, ({ image }) => text(ctx.updates.describe(image || (ctx.image ? ctx.image() : undefined))))
  }
  const me = ctx.me
  const writable = (room) => room.full ? 'This session is over its size limit, so nothing new can be saved.' : null
  // A branch over its own size limit takes no new files; the rest of the session carries on.
  const branchWritable = (room, branch) => branch && room.branchFull && room.branchFull(branch.key) ? `${branch.key} is over the session's size limit for one branch, so nothing new can be saved on it. Other branches still take changes. Start a fresh copy with \`git checkout -b <new name>\`: your changes since are kept in your folder.` : null
  // Which branch a file answer is about, when the session has more than one.
  const onBranchNote = (room, branch) => branch && room.meta && Object.keys(room.meta.branches || {}).length > 1 ? ` on ${branch.key}` : ''
  const visible = (m) => m && m.id && (!m.to || m.to === me || m.by === me)
  const fmtMsg = (m) => `- ${m.by}${m.to ? ` → ${m.to} (direct)` : ''} (${ago(m.ts)}): ${m.text}${m.file ? ` [file: ${m.file.name}]` : ''}`
  const peers = (room) => {
    const out = []
    for (const s of room.awareness.getStates().values()) if (s && s.name && s.name !== me) out.push(s)
    // AI sessions working through someone's app (persona.js) are members of their own.
    for (const s of room.awareness.getStates().values()) {
      for (const x of (s && Array.isArray(s.personas) ? s.personas : [])) {
        if (x && typeof x.name === 'string' && x.name && x.name !== me && !out.some((p) => p.name === x.name)) out.push({ name: x.name.slice(0, 80), kind: 'agent', tool: typeof x.tool === 'string' ? x.tool.slice(0, 40) : '', focus: typeof x.focus === 'string' ? x.focus.slice(0, 200) : '', persona: true, of: s.name })
      }
    }
    for (const h of room.hostedOnline ? room.hostedOnline() : []) if (h.name !== me && !out.some((p) => p.name === h.name)) out.push({ name: h.name, kind: h.kind, tool: 'hosted', hosted: true })
    return out
  }
  // Each member's folder tells the room its git (branch, upstream, the repository's branches): one list.
  const branchesOf = (room) => {
    const members = []
    for (const st of room.awareness.getStates().values()) if (st && st.name && st.git) members.push({ name: st.name, git: cleanGit(st.git) })
    for (const p of peers(room)) if (p.persona) members.push({ name: p.name, git: null, persona: true })
    return branchBoard(members, room.branchList ? room.branchList() : [])
  }
  const claimsOf = (room) => room.claimList ? room.claimList(branchOf(room)) : []
  // Claims are per branch: who the agent is, on the branch it works on.
  const who = (room) => ({ ...ctx.who(room), branch: branchOf(room) })
  // The rules every agent is held to (duties.js), enforced here because hosted agents work through these tools.
  const seen = (doc) => doc.getArray('chat').toArray().filter(visible)
  // Messages this agent settled as needing no reply (quilt_inbox no_reply), kept with its inbox.
  const settledSet = () => {
    const box = ctx.inbox ? ctx.inbox() : {}
    if (!Array.isArray(box.settled)) box.settled = []
    return new Set(box.settled)
  }
  const waitRefusal = (doc, name) => renderUnanswered(waitingOn(seen(doc), me, { agent: true, settled: settledSet() }), `call ${name} again`)
  // Everyone this agent could address: who is here and who has been in the chat.
  const memberNames = (room, doc) => {
    const names = new Set(peers(room).map((p) => p.name))
    for (const p of peers(room)) if (p.persona && p.of) names.add(aiName(p.of)) // "Daniel's AI"
    for (const m of seen(doc)) { if (m.by) names.add(m.by); if (m.to) names.add(m.to) }
    names.delete(me)
    return [...names].filter((n) => typeof n === 'string' && n)
  }
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
  const roomKey = (room) => `${room.id || room.name || ''}\0${branchOf(room)}` // claims held per branch
  const autoClaim = (room, rel) => {
    const key = `${roomKey(room)}\0${rel}`
    const branch = branchOf(room) // released on this branch, even if the agent has moved on since
    clearTimeout(autoHeld.get(key))
    if (!autoHeld.has(key)) {
      try { room.claimRequest({ ...who(room), talk: ctx.access(room)?.talk !== false }, { op: 'claim', pattern: rel, note: 'editing' }) } catch { return false }
      room.broadcastClaims()
    }
    const timer = setTimeout(() => {
      autoHeld.delete(key)
      if (!(room.claimList ? room.claimList(branch) : []).some((c) => c.pattern === rel && c.by === me)) return
      try { room.claimRequest({ ...ctx.who(room), branch }, { op: 'release', pattern: rel }); room.broadcastClaims() } catch {}
    }, HOSTED_AUTO_CLAIM_QUIET_MS)
    if (timer.unref) timer.unref()
    autoHeld.set(key, timer)
    return true
  }
  // One chronology writer per branch document, shared by every hosted agent's connection.
  const historyOf = (room) => {
    const b = branchEntry(room) || room
    const doc = b.doc
    if (!b.historyLog) b.historyLog = new HistoryLog(doc, doc.getArray('history'), { origin: AGENT })
    return b.historyLog
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
      lines.push(`- ${p.name} (${p.tool || 'unknown tool'}${p.persona ? `, an AI session of ${p.of}` : p.kind === 'agent' ? ', agent' : ''})${ai ? ` · ${ai}` : ''}${p.focus ? ` · focus: ${p.focus}` : ''}${editing.length ? ` · editing ${editing.join(', ')}` : ''}`)
    }
    const cl = claimsOf(room)
    lines.push('', '## Claimed files', ...(cl.length ? cl.map((c) => `- ${c.pattern} by ${c.by}${c.note ? ` (${c.note})` : ''}${c.queue.length ? ` · waiting: ${c.queue.map((r) => `${r.by} ("${r.title}")`).join(', ')}` : ''}`) : ['- None.']))
    const acts = activity.toArray().filter(Boolean).slice(-12).reverse()
    lines.push('', '## Recent file changes', ...(acts.length ? acts.map((x) => x.kind === 'pulled' ? `- ${x.by} pulled ${x.detail || 'commits'} (${ago(x.ts)})` : x.kind === 'switched' ? `- ${x.by} switched to ${x.branch} (${ago(x.ts)})` : `- ${x.by} ${x.kind} ${x.path} (${ago(x.ts)})`) : ['- None yet.']))
    const msgs = chat.toArray().filter(visible).slice(-8)
    lines.push('', '## Recent messages', ...(msgs.length ? msgs.map(fmtMsg) : ['- None.']))
    lines.push('', '## Tasks', taskMarkdown(readTasks(doc.getMap('tasks')), me, { tool: ctx.tool(), asAi: false, mentionYours: true }))
    const br = branchesOf(room)
    if (br.length) {
      lines.push('', '## Branches', branchesMarkdown(br, { limit: 6, mine: branchOf(room) }))
      if (ctx.branch) lines.push('Work on another branch with quilt_switch_branch.')
    }
    if (ctx.webhook) { const w = ctx.webhook.get(); lines.push('', w ? `Webhook: Quilt POSTs to ${w.url} on ${w.events.join(', ')}.` : 'No webhook: subscribe with quilt_webhook_subscribe to be told of mentions, direct messages and tasks as they happen.') }
    return text(lines.join('\n') + ctx.warn(room))
  })

  tool('quilt_branches', {
    description: 'The session\'s git branches: which branch each member\'s folder is on, which AI sessions and worktrees work on which branch, how each stands against its upstream (behind, ahead, diverged), and who committed last.',
    inputSchema: {}
  }, (_, { room }) => {
    const br = branchesOf(room)
    return text(`${branchesMarkdown(br, { limit: 40 })}\n\nCommits pushed or merged elsewhere come into the session by themselves: the folder of a member on that branch fetches about once a minute and brings them in.`)
  })

  const taskMap = (doc) => doc.getMap('tasks')

  const reader = () => ({ name: me, tool: ctx.tool(), asAi: false, agent: true })
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
    description: 'List the shared task board (To do, In progress, QA, Done), with an id on each task. Open tasks assigned to you are listed first.',
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
      '"qa" when you finish implementing and testing: requires `qaNotes` (what changed and how you self-validated); without it the move is refused. ' +
      '"done" after QA: requires `verified`, what you ran and what you saw; without it the move is refused.',
    inputSchema: {
      id: z.string().describe('Task id from quilt_tasks'),
      column: z.enum(['todo', 'doing', 'qa', 'done']).describe('todo, doing, qa, or done'),
      qaNotes: z.string().max(MAX_VERIFIED).optional().describe('For "qa": describe the changes you made and how you self-validated them.'),
      verified: z.string().max(MAX_VERIFIED).optional().describe('For "done": what you ran and what you saw, concretely (commands, results, what you exercised in the app).')
    }
  }, ({ id, column, qaNotes, verified }, { room, doc, files }) => {
    { const w = waitRefusal(doc, 'quilt_move_task'); if (w) return fail(w) }
    const err = writable(room)
    if (err) return fail(err)
    try {
      const cur = readTasks(taskMap(doc)).find((t) => t.id === id)
      if (!cur) return fail('no such task')
      if (column === 'qa' && !qaNotesEnough(qaNotes)) return fail(qaRefusal({ task: cur, checklist: checklistOf(files) }))
      if (column === 'done' && !verifiedEnough(verified)) return fail(doneRefusal({ task: cur, checklist: checklistOf(files) }))
      { const q = (column === 'done' || column === 'qa') && renderQueued(queuedFor(claimsOf(room), me), 'move the task again'); if (q) return fail(q) }
      const patch = { id, column }
      if (column === 'qa') patch.qaNotes = qaNotes
      if (column === 'done') patch.verified = verified
      const task = updateTask(doc, taskMap(doc), patch, AGENT)
      if (column === 'doing') {
        const tf = task.files || []
        const all = historyOf(room).entries()
        const history = (tf.length ? all.filter((e) => tf.includes(e.path)) : all).slice(-8)
        const claims = claimsOf(room).filter((c) => !tf.length || tf.some((f) => globMatcher(c.pattern)(f)))
        return text(pickupBrief({ task: { ...task, comments: readComments(doc.getMap('taskComments'), task.id) }, history, claims, checklist: checklistOf(files), me }))
      }
      if (column === 'qa') return text(`Moved "${task.title}" to QA. Notes: ${qaNotesLine(task)}`)
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

  tool('quilt_task', {
    description: 'One task in full: its column, assignee, files, QA and Done notes, and its comments (work notes and handoffs people left on it).',
    inputSchema: { id: z.string().describe('Task id from quilt_tasks') }
  }, ({ id }, { doc }) => {
    const task = withComments(readTasks(taskMap(doc)), doc.getMap('taskComments')).find((t) => t.id === id)
    return task ? text(formatTaskDetails(task)) : fail('No such task: read the board with quilt_tasks.')
  })

  tool('quilt_comment_task', {
    description: 'Add a comment to a task: a work note, a handoff, or why it went to whom. Put reasoning about a task here instead of in the chat.',
    inputSchema: {
      id: z.string().describe('Task id from quilt_tasks'),
      text: z.string().max(MAX_COMMENT).describe('The comment')
    }
  }, ({ id, text: words }, { room, doc }) => {
    { const w = waitRefusal(doc, 'quilt_comment_task'); if (w) return fail(w) }
    if (ctx.access(room)?.talk === false) return fail(TALK_REFUSED)
    const err = writable(room)
    if (err) return fail(err)
    try {
      const tasks = readTasks(taskMap(doc))
      addComment(doc, doc.getMap('taskComments'), tasks, { taskId: id, by: me, text: words }, AGENT)
      const task = tasks.find((t) => t.id === id)
      return text(`Comment added to "${task.title}" (${readComments(doc.getMap('taskComments'), id).length} on it now).`)
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
    inputSchema: {
      no_reply: z.array(z.string().max(40)).max(50).optional().describe('Ids of messages that need nothing back from you (thanks, a greeting, an FYI, a status report): settled without a reply')
    }
  }, ({ no_reply }, { doc, chat }) => {
    const box = ctx.inbox ? ctx.inbox() : { state: null }
    const msgs = chat.toArray().filter(visible)
    let note = ''
    if (no_reply && no_reply.length) {
      const known = new Set(msgs.map((m) => m.id))
      const ok = no_reply.map(String).filter((x) => known.has(x))
      box.settled = [...new Set([...(Array.isArray(box.settled) ? box.settled : []), ...ok])].slice(-500)
      note = `Settled as needing no reply: ${ok.length ? ok.join(', ') : 'none (unknown ids)'}.`
    }
    const r = scanInbox({ messages: msgs, tasks: readTasks(taskMap(doc)), reader: reader() }, box.state)
    box.state = r.state
    if (ctx.saveInbox) ctx.saveInbox()
    const settled = new Set(box.settled || [])
    const open = r.events.filter((e) => (e.kind !== 'dm' && e.kind !== 'mention') || e.queue || (!settled.has(e.id) && !answered(msgs, me, e.by, e.ts)))
    return text([note, renderInbox(open)].filter(Boolean).join('\n\n') || 'Nothing new for you.')
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
    description: CHAT_RULES + ' Set `to` to message one person directly.',
    inputSchema: {
      text: z.string().min(1).max(4000),
      to: z.string().optional().describe('Name of one person, for a direct message'),
      everyone: z.boolean().optional().describe('Only for a real announcement to the whole session: lets a message that @mentions nobody go out')
    }
  }, ({ text: t, to, everyone }, { room, doc, chat }) => {
    const err = writable(room)
    if (err) return fail(err)
    if (ctx.access(room)?.talk === false) return fail(TALK_REFUSED)
    const why = unaddressed(t, { to, everyone: !!everyone, names: memberNames(room, doc) })
    if (why) return fail(why)
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
      return `- ${p}${c ? ` (claimed by ${c.by}${c.queue.length ? `, ${c.queue.length} waiting` : ''})` : ''}`
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
  }, ({ path: p, content }, { room, doc, fdoc, branch, files, blobs, activity }) => {
    { const w = waitRefusal(doc, 'quilt_write_file'); if (w) return fail(w) }
    const err = writable(room) || branchWritable(room, branch)
    if (err) return fail(err)
    const rel = cleanPath(p)
    if (!isSafeRelPath(rel)) return fail('That is not a path inside the project.')
    const a = ctx.access(room)
    if (a && a.role === 'viewer') return fail('You can only view this session; file changes are refused.')
    const refusal = a && changeRefusal(a, rel)
    if (refusal) return fail(`${refusal[0].toUpperCase()}${refusal.slice(1)}.`)
    const claim = claimsOf(room).find((c) => c.by !== me && globMatcher(c.pattern)(rel))
    if (claim) return fail(heldRefusal(rel, claim))
    if (blobs.get(rel)?.stored) return fail(`${rel} is a large file kept in storage; it can't be changed here.`)
    const held = claimsOf(room).some((c) => c.by === me && globMatcher(c.pattern)(rel))
    const claimedNow = !held && autoClaim(room, rel)
    if (held && autoHeld.has(`${roomKey(room)}\0${rel}`)) autoClaim(room, rel) // still writing it: keep holding
    if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) return fail('That file is too big to write here (1 MB at most).')
    let detail = ''
    let existed = false
    fdoc.transact(() => doc.transact(() => {
      existed = files.has(rel) || blobs.has(rel)
      blobs.delete(rel)
      let ytext = files.get(rel)
      if (!ytext) { ytext = new Y.Text(); files.set(rel, ytext) }
      const before = ytext.toString()
      detail = applyTextDiff(ytext, content)
      const kind = existed ? 'edited' : 'created'
      activity.push([{ by: me, path: rel, kind, detail, ...(branch ? { branch: branch.key } : {}), ts: Date.now() }])
      if (activity.length > ACTIVITY_CAP) activity.delete(0, activity.length - ACTIVITY_CAP)
      historyOf(room).record({ by: me, path: rel, kind, before, after: content, task: currentTask(readTasks(taskMap(doc)), me) })
    }, AGENT), AGENT)
    // What people said about this file in chat, so the agent works with it in mind (each message once).
    const box = toldAbout()
    const said = chatAbout([rel], { messages: seen(doc), me }).filter((m) => m.id && !box.told.includes(m.id))
    if (said.length) {
      box.told = [...box.told, ...said.map((m) => m.id)].slice(-200)
      if (ctx.saveInbox) ctx.saveInbox()
    }
    const context = renderChatAbout(said)
    return text(`${existed ? 'Updated' : 'Created'} ${rel}${onBranchNote(room, branch)}${detail ? ` (${detail} lines)` : ' (no change)'}. Everyone in the session has it now.${claimedNow ? ` ${rel} is claimed for you while you work on it; quilt_release it when you are done.` : ''}${context ? `\n\n${context}` : ''}`)
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
      const r = room.claimRequest({ ...who(room), talk: ctx.access(room)?.talk !== false }, { op: 'claim', pattern: pattern.trim(), note: note || '' })
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
    // A file someone waits for is handed off, not released.
    const waited = mine.filter((c) => c.queue.length)
    if (pattern && waited.length) return fail(renderQueued(queuedFor(waited, me), 'release the rest'))
    const released = []
    for (const c of mine.filter((x) => !x.queue.length)) {
      try { room.claimRequest(who(room), { op: 'release', pattern: c.pattern }); released.push(c.pattern) } catch {}
      const key = `${roomKey(room)}\0${c.pattern}`
      clearTimeout(autoHeld.get(key)); autoHeld.delete(key)
    }
    if (released.length) room.broadcastClaims()
    return text((released.length ? `Released ${released.join(', ')}.` : 'Nothing to release.') + (waited.length ? ` Kept ${waited.map((c) => c.pattern).join(', ')}: someone is waiting for ${waited.length === 1 ? 'it' : 'them'}; hand off with quilt_handoff.` : ''))
  })

  tool('quilt_request_file', {
    description: 'Ask for a file someone else holds (claimed), instead of editing it: your request joins its file queue, its holder is told, and when they finish they hand it to you with their context. ' +
      'You are woken (a direct message, in quilt_inbox and your webhook) when it is yours. Asking again for the same file updates your request.',
    inputSchema: {
      path: z.string().min(1).max(500).describe('The file you need, relative path'),
      title: z.string().min(1).max(120).describe('What you will do, e.g. "Working on retry logic for task t-12"'),
      description: z.string().max(300).optional().describe('Your plan in summary: what you want to change and why (300 characters at most)'),
      task: z.string().max(80).optional().describe('The task id this is for, if any')
    }
  }, ({ path: p, title, description, task }, { room }) => {
    const err = writable(room)
    if (err) return fail(err)
    try {
      const r = room.claimRequest({ ...who(room), talk: ctx.access(room)?.talk !== false }, { op: 'request', path: cleanPath(p), title, description: description || '', task })
      room.broadcastClaims()
      return text(`Asked for ${cleanPath(p)}: you are number ${r.position} in the queue for ${r.pattern} (held by ${r.holder}). ${r.holder} is told; you will be handed it with their context. Carry on with other work.`)
    } catch (e) { return fail(e.message) }
  })

  tool('quilt_handoff', {
    description: 'Hand a file you hold to someone waiting for it in its file queue (the first, unless you name them), with your context: what you changed, what is left, anything they should know. ' +
      'The claim becomes theirs and they get your context in a direct message. Required before you finish or release a file someone is waiting for.',
    inputSchema: {
      path: z.string().min(1).max(500).describe('The file (or the claimed pattern) to hand off'),
      context: z.string().min(1).max(2000).describe('What you changed, what is left, gotchas'),
      to: z.string().max(80).optional().describe('Who to hand it to (a name or request id); omit for the first in the queue')
    }
  }, ({ path: p, context, to }, { room }) => {
    try {
      const r = room.claimRequest(who(room), { op: 'handoff', pattern: cleanPath(p), context, to: to || '' })
      const key = `${roomKey(room)}\0${r.pattern}`
      clearTimeout(autoHeld.get(key)); autoHeld.delete(key)
      room.broadcastClaims()
      return text(`Handed ${r.pattern} to ${r.to} with your context.${r.waiting ? ` ${r.waiting} more waiting: ${r.to} hands it on next.` : ''}`)
    } catch (e) { return fail(e.message) }
  })

  tool('quilt_withdraw_request', {
    description: 'Take back your request for a file (from quilt_request_file) when you no longer need it.',
    inputSchema: { path: z.string().min(1).max(500).describe('The file you asked for') }
  }, ({ path: p }, { room }) => {
    const rel = cleanPath(p)
    const mine = claimsOf(room).flatMap((c) => c.queue).filter((r) => r.by === me && r.path === rel)
    let n = 0
    for (const r of mine) n += room.claimRequest(who(room), { op: 'withdraw', request: r.id }).withdrawn || 0
    if (n) room.broadcastClaims()
    return text(n ? `Withdrew your request for ${rel}.` : `You had not asked for ${rel}.`)
  })
}

// The workspace library for hosted agents (see workspace-tools.js), offered only while the
// accounts API says workspaces are on.
export const FEATURES_EVERY_MS = 10 * 60 * 1000
const FEATURES_TIMEOUT_MS = 5000
// One API call, and one upload or download (at most 2 MB from here), from the relay: under
// the API's own 30 s wait for the relay, so a slow call is reported by the tool, not cut off.
const WORKSPACE_CALL_TIMEOUT_MS = 20 * 1000
const WORKSPACE_TRANSFER_TIMEOUT_MS = 20 * 1000

/**
 * Asks `<apiUrl>/v1/features` now and every `everyMs` whether workspaces are on. on() is
 * false until the API first says true. A failed probe (unreachable, slow, a server error, an
 * odd answer) keeps the last answer, so off when there was none; an API without the route
 * (404) has no workspaces. Never throws; its timer never holds the process open; stop()
 * ends it and any probe in flight. `ready` is the first probe's answer.
 */
export function watchFeatures ({ apiUrl, fetch: fetchImpl = globalThis.fetch, everyMs = FEATURES_EVERY_MS, retryMs = 30_000, timeoutMs = FEATURES_TIMEOUT_MS, log = () => {} }) {
  const url = `${String(apiUrl).replace(/\/+$/, '')}/v1/features`
  let known = false
  let inflight = null
  let current = null // the AbortController of the probe in flight
  let stopped = false
  let answered = false // until the API has answered once, ask again sooner
  const set = (on) => {
    answered = true
    if (on !== known) log(`hosted agents: workspace tools ${on ? 'on' : 'off'}`)
    known = on
  }
  async function ask () {
    const ac = new AbortController()
    current = ac
    const timer = setTimeout(() => ac.abort(new Error('the features check took too long')), timeoutMs)
    timer.unref?.()
    try {
      const res = await fetchImpl(url, { signal: ac.signal })
      if (res.status === 404) { set(false); return }
      if (!res.ok) return
      const body = await res.json()
      if (body && typeof body === 'object') set(body.workspaces === true)
    } catch {
      // Unreachable, slow or garbled: keep what we knew.
    } finally {
      clearTimeout(timer)
      ac.abort()
      current = null
    }
  }
  function probe () {
    if (stopped) return Promise.resolve(known)
    if (!inflight) inflight = ask().catch(() => {}).finally(() => { inflight = null })
    return inflight.then(() => known)
  }
  const ready = probe()
  const timer = setInterval(() => { probe() }, everyMs)
  timer.unref?.()
  // The API may still be starting (both deployed together): until it answers, try every retryMs.
  const early = setInterval(() => { if (answered) clearInterval(early); else probe() }, retryMs)
  early.unref?.()
  return {
    ready,
    on: () => !stopped && known,
    probe,
    stop () {
      stopped = true
      clearInterval(timer)
      clearInterval(early)
      current?.abort(new Error('stopped'))
    }
  }
}

/**
 * How a hosted agent's library tools reach the accounts API: as the agent, with the pass
 * the relay was handed (`Authorization: QuiltPass`, which only the workspace routes take).
 * Errors carry the API's message and status. The pass never goes into an error or a log.
 */
export function hostedWorkspaceAccess ({ apiUrl, pass, fetch: fetchImpl = globalThis.fetch }) {
  const api = String(apiUrl).replace(/\/+$/, '')
  const call = async (method, route, body) => {
    let res
    try {
      res = await fetchImpl(api + route, {
        method,
        headers: { authorization: `QuiltPass ${pass}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(WORKSPACE_CALL_TIMEOUT_MS)
      })
    } catch (err) {
      throw new Error(`Couldn't reach Quilt (${err?.cause?.code || err?.name || 'no answer'}).`)
    }
    const data = await res.json().catch(() => null)
    if (!res.ok) throw Object.assign(new Error(data?.error || `Quilt answered ${res.status}.`), { status: res.status })
    if (!data || typeof data !== 'object') throw new Error('Quilt sent back something unexpected.')
    return data
  }
  const put = async (url, bytes, headers) => {
    try {
      const res = await fetchImpl(url, { method: 'PUT', headers, body: bytes, signal: AbortSignal.timeout(WORKSPACE_TRANSFER_TIMEOUT_MS) })
      await res.body?.cancel().catch(() => {}) // the status is all we need; let the socket go
      return res.status
    } catch (err) {
      throw new Error(`The upload did not go through (${err?.cause?.code || err?.name || 'no answer'}).`)
    }
  }
  return { call, fetchBytes: bytesFetcher(fetchImpl, { timeoutMs: WORKSPACE_TRANSFER_TIMEOUT_MS }), put, saveDir: null, readLocal: null }
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
 * saveHosted, log, endedMessage }. `workspaces`, given only while the API has them on and
 * the holder is an agent, is { apiUrl, pass (as sent), fetch }: the library tools are added.
 */
export async function handleHostedMcp ({ req, res, pass, relay, workspaces = null }) {
  const image = String(req.headers['x-quilt-image'] || '').trim()
  // The library's guide is part of the instructions only when its tools are offered.
  const mcp = new McpServer({ name: 'quilt', version: '0.2.0' }, { instructions: workspaces ? `${HOSTED_INSTRUCTIONS}\n\n${WORKSPACE_GUIDE}` : HOSTED_INSTRUCTIONS })
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
    if (relay.roomEnded(h.room)) { visitEnd('session_ended'); relay.hosted.delete(account); relay.saveHosted(); return { error: `${relay.endedMessage}. ${NOT_JOINED}` } }
    const room = relay.getRoom(h.room)
    if (!room) return { error: relay.refused(h.room)[1] }
    touched.add(room)
    if (!room.exists) { visitEnd('session_ended'); relay.hosted.delete(account); relay.saveHosted(); return { error: REMOVED } }
    if (h.denied) { relay.hosted.delete(account); relay.saveHosted(); tellRoom(); return { error: DENIED } }
    const access = room.hostedAccess(pass)
    if (access.needsRoomPass) {
      if (!res.headersSent) res.setHeader('x-quilt-retry', 'room-pass')
      return { error: NEEDS_ROOM_PASS, room, access }
    }
    if (access.state !== 'approved') {
      // Still waiting, but the relay restarted and forgot: back on the owner's list.
      if (h.pending && ![...room.pending].some(([k, p]) => k.hosted && p.id === account)) room.hostedRequest(pass, h.invitedAs || 'viewer')
      if (!h.pending) visitEnd('removed')
      return { error: h.pending ? WAITING : REMOVED, room, access }
    }
    h.seenAt = Date.now()
    relay.saveHosted()
    room.hostedActive(account)
    visitStart(room, access)
    return { room, access }
  }
  // The audit trail (server.js keeps the visit with the agent's entry in relay.hosted).
  const visitStart = (room, access) => { if (relay.visitStart) relay.visitStart(account, room, { name: me, tool: toolLabel(mcp.server.getClientVersion()?.name) || 'hosted', owner: !!(access && access.owner) }) }
  const visitEnd = (reason) => { if (relay.visitEnd) relay.visitEnd(account, reason) }
  const ctx = {
    me,
    who: () => ({ name: me, id: account }),
    access: (room) => room.hostedAccess(pass),
    branch: (room) => room.hostedBranch(account),
    pin: (room) => room.pinHostedBranch(account),
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
    // Joining again in the same session carries its visit on; joining another ends it.
    const before = relay.hosted.get(account)
    const visit = before && before.room === inv.room ? before.visit : undefined
    if (before && before.room !== inv.room) visitEnd('left')
    relay.hosted.set(account, { room: inv.room, since: Date.now(), seenAt: Date.now(), pending: a.state === 'pending', ...(a.state === 'pending' ? { invitedAs: auth, name: me, kind: pass.kind } : {}), inbox: takeStock(room.doc, me), ...(webhook ? { webhook } : {}), ...(visit ? { visit } : {}) })
    relay.saveHosted()
    tellRoom()
    if (a.state === 'pending') return text(`Asked to join room ${inv.room} as ${auth === 'viewer' ? 'a viewer' : 'an editor'}. ${WAITING}`)
    room.hostedActive(account)
    visitStart(room, a)
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
    visitEnd('left')
    relay.hosted.delete(account)
    relay.saveHosted()
    tellRoom()
    const room = relay.getRoom(h.room)
    if (room) {
      touched.add(room)
      room.hostedSeen.delete(account)
      room.forgetHostedBranch(account)
      for (const [k, p] of room.pending) if (k.hosted && p.id === account) room.pending.delete(k)
      // Leaving lets go of its claims: nobody else could.
      room.dropRequests((r) => r.byId === account)
      room.dropClaims((c) => c.byId === account, (c) => `${c.by} left the session.`)
      room.broadcastClaims()
      room.broadcastMembers()
    }
    return text(`Left room ${h.room}.`)
  })

  mcp.registerTool('quilt_switch_branch', {
    description: 'Work on another branch of the session: your file tools, claims and history then read and write that branch. quilt_status lists the branches and who is on each. create: true starts a new branch from a copy of the files on the one you are on.',
    inputSchema: {
      branch: z.string().min(1).max(200).describe('The branch, e.g. feature/login'),
      create: z.boolean().optional().describe('Start it: a new branch from the files on your current one')
    }
  }, ({ branch, create }) => ctx.withSession((room) => {
    try {
      const editor = ctx.access(room)?.role !== 'viewer'
      const r = room.setHostedBranch(account, String(branch).trim(), { create: !!create, by: me, editor })
      return text(r.created
        ? `Started ${r.branch} from ${r.from}, with a copy of its files. Your file tools, claims and history use ${r.branch} now. It isn't in git yet: people work on it with \`git checkout -b ${r.branch}\` (or \`git checkout ${r.branch}\` once it is pushed), and their folder follows.`
        : `You are on ${r.branch} now: your file tools, claims and history use it.`)
    } catch (e) { return fail(e.message) }
  }))

  sessionTools(mcp, ctx)
  // The library works whether or not the agent is in a session (it never touches relay.hosted).
  if (workspaces) registerWorkspaceTools(mcp, hostedWorkspaceAccess(workspaces))
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
