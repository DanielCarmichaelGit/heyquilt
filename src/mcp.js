// MCP server (stdio) that lets any MCP-capable agent (Claude Code, Cursor,
// Windsurf, Codex, ...) take part in a live session: see what collaborators
// and their AIs are doing, coordinate, and even join or start a session by
// itself. It forwards to the local `quilt join` process for the project, or
// runs the session itself when the agent joins on its own.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { findDaemon, call as rawCall } from './control.js'
import { parentPids } from './hooks.js'
import { renderMessage, renderStatus } from './status.js'
import { branchesMarkdown, upstreamLine, describeBranchSync } from './branches.js'
import { DEFAULT_KEY } from './branchdocs.js'
import { formatTasks, columnName, assigneeLabel, renderNextTask } from './tasks.js'
import { formatTaskDetails, MAX_COMMENT } from './task-comments.js'
import { runSession, decodeInvite, newConn, readConfig, runningElsewhere, personsFolder, agentCopyFolder, forgetWorkspace } from './runner.js'
import { INVALID_INVITE } from './ui/invite.js'
import { toolLabel } from './agents/common.js'
import { sessionPasses } from './pass-source.js'
import { pickAgent, agentWhoami, agentAccess, readAgent, savedAgents } from './agent-join.js'
import { setSessionWorkspace, announceSessionStarted, announceWhenReported, apiUrl, readAccount, resumeAccount } from './account.js'
import { registerWorkspaceTools, bytesFetcher, isInside } from './workspace-tools.js'
import { quiltHome } from './legacy.js'
import { TASK_WORKFLOW, pickupBrief, doneRefusal, verifiedEnough, verifiedLine, qaRefusal, qaNotesEnough, qaNotesLine, MAX_VERIFIED } from './agent-task-workflow.js'
import { formatHistory } from './history.js'
import { describeCommitRequests, REQUEST_COMMIT_DESCRIPTION } from './commit.js'
import { COMMIT_DESCRIPTION, commitSchema } from './github-commit.js'
import { describeCommit, POLICY_WORDS } from './relay-commit.js'
import { renderInbox, describeEvent, INBOX_HOW } from './inbox.js'
import { renderConversation, renderContext, CONVERSATION_DESCRIPTION } from './conversation.js'
import { renderChatAbout, renderUnanswered, heldRefusal, renderQueueNotice, renderQueued, CHAT_RULES } from './duties.js'
import { describeSubscription, WEBHOOK_EVENTS } from './webhooks.js'
import { UpdateCheck } from './update-check.js'
import { getSettings } from './settings.js'
import { mergeAction } from './merges.js'

// A workspace id, as the accounts API makes them (UUID in src/api/http.js).
const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The "quilt-<room>" folder inside `cwd`. Invites only carry plain room names, but a room that
 * would put the folder anywhere else is refused all the same.
 */
export function roomFolder (cwd, room) {
  const root = path.resolve(cwd)
  const dir = path.resolve(root, `quilt-${room}`)
  if (path.dirname(dir) !== root) throw new Error(INVALID_INVITE)
  return dir
}

export { toolLabel }

// How often `quilt mcp` asks the session for new inbox events to push to Claude Code.
export const INBOX_POLL_MS = 2000
// The notification Claude Code turns into a turn when it was started with the quilt channel.
export const CHANNEL_METHOD = 'notifications/claude/channel'
// The inbox as an MCP resource: any client may subscribe to hear when something new arrives.
export const INBOX_URI = 'quilt://inbox'

const NOT_RUNNING = 'There is no live quilt session for this project. If the user gave you an invite link, join with ' +
  'quilt_join_session. To start a new session, use quilt_start_session. A person can also run `quilt join` or `quilt ui`.'

export const MCP_INSTRUCTIONS =
  'quilt lets several people (and their AI agents) edit one project live, each in their own tool. ' +
  'If you are given a quilt invite link, join with quilt_join_session. In a session, files may change underneath ' +
  'you at any time. Call quilt_status before starting a task; use quilt_partner_feed to see what a partner\'s AI is ' +
  'doing; announce your task with quilt_set_focus. The session has a shared task board: read it with quilt_tasks ' +
  '(open tasks assigned to you are listed first), add work with quilt_add_task, assign it with quilt_assign_task, ' +
  'and move a task with quilt_move_task when you start or finish it; quilt_task reads one in full with its comments, and quilt_comment_task leaves a note or handoff on it. ' +
  'quilt_history tells you who changed which file, when, with the diff: read it for the files you are about to touch. ' +
  'If git refuses to pull because untracked files would be overwritten, those files came from the session: quilt_status lists them under Pulling (and whether they match); make way and pull with rm <files> && git pull --autostash, and Quilt keeps them for everyone. ' +
  'If the person you work for lets their AI pick up work by itself (their Quilt settings), finishing (quilt_set_work done, a task to QA or Done) hands you your next task from the board: start it. ' +
  'Before you change files, call quilt_before_edit with their paths: it tells you whether each is yours to edit (claiming free ones for you, so partners are refused instead of overwriting you), ' +
  'and shows what people said about those files in chat, so you know what was asked or planned before you change them. ' +
  'Do not edit a file it refuses: ask for it in its file queue with quilt_request_file (a title like "Working on <what> for <task>" and up to 300 characters on your plan) and carry on with other work; you are woken when it is handed to you, with the holder\'s context. ' +
  'Claims also follow your edits: a file you change that nobody holds is claimed for you until you finish. ' +
  'If an edit of yours was undone because someone else holds the file, your next quilt answer says so: do not retry; ask for it with quilt_request_file and carry on with other work. ' +
  'When someone waits in the file queue for a file you hold, every quilt answer says so: finish the change you are making, then hand it off with quilt_handoff and your context (what you changed, what is left, gotchas). ' +
  'Until you do, you cannot finish (quilt_set_work done, a task to Done) or release that file. A claim whose holder does nothing in the session for 20 minutes goes to the next one waiting, or is released. ' +
  'Every quilt answer starts with anything new for you (direct messages, mentions, tasks handed to you): act on it. ' +
  'These rules are enforced: while someone who messaged or mentioned you is waiting for an answer, the tools that move work on (claims, tasks, focus, merges, commits, quilt_set_work) refuse until you answer them with quilt_message; ' +
  'an edit to a file someone else holds is undone. ' +
  'When you finish a piece of work, call quilt_set_work with "done": it lets go of the files claimed for you. ' +
  'Claim ahead (quilt_claim) only for a larger change across several files. ' +
  'Always re-read a file right before you edit it. ' +
  'If quilt_status lists merges to settle, read quilt_merges before editing those files. ' +
  'If quilt_status starts with While you were away, the session changed since this folder last synced: read quilt_history for those files before editing them. ' +
  'Mentions of you (@yourname) in chat, direct messages to you and tasks handed to you wait in quilt_inbox: read it when you start, and act on each one. ' +
  'Each comes with the conversation before it with its sender; when a message refers to something earlier you do not have, read back with quilt_conversation before you answer, never guess. ' +
  'Commit your finished work yourself with quilt_commit (the files and a message; no git needed, nobody else needs to be online), to a branch of your own with a pull request, or to the session\'s branch when the owner allows; when agents may not commit, ask a person with quilt_request_commit. ' +
  'Chat: ' + CHAT_RULES.replace(/^Send a chat message\. /, '') + ' A message that needs nothing back is settled with quilt_inbox (no_reply: [its id]), not answered. ' +
  'To be woken instead of polling, subscribe to the quilt://inbox resource (you are told when something new arrives), or quilt_webhook_subscribe POSTs each one to a URL of yours as it happens. ' +
  'You are a member of your own in the session, apart from your person and their other AI sessions, named "<their first name> · <label>" after your work (your git branch, or what you first say you are doing); rename yourself with quilt_name_session. Your messages, inbox, claims and duties are your own. People see all of a person\'s AI sessions as one, "<person>\'s AI" ("Daniel\'s AI"): write to another person\'s AI by that name, and what is written to your person\'s AI reaches whichever of their sessions was active last. ' +
  'Share what you are doing with quilt_share: when you start on a request (request and your plan) and when you finish (what you did and the files you changed). Partners see it in their feed, it puts your work on the task board, and it tells the host not to commit under you. ' +
  'When Claude Code is started with the quilt channel, they arrive on their own as <channel source="quilt"> events while you work: treat each like a request from that person, answer with quilt_message, and take a task with quilt_move_task. ' +
  TASK_WORKFLOW

export async function runMcp () {
  const server = new McpServer(
    { name: 'quilt', version: '0.1.0' },
    // The channel capability lets Claude Code (started with the quilt channel) take inbox events as turns.
    { instructions: MCP_INSTRUCTIONS, capabilities: { resources: { subscribe: true }, experimental: { 'claude/channel': {} } } }
  )

  // This AI session, as the app tells it apart from other AI sessions working through it (Claude
  // Code in one window, Cursor or Codex in another): it is a member of its own there, under a
  // name of its own (persona.js), with its own messages, inbox, claims and duties.
  const via = crypto.randomBytes(8).toString('hex')
  const hello = { key: null, name: '', named: null, told: false }
  // Every call to the app says which AI session it is from (in the query for a GET), and the first
  // call to an app (or to one that restarted) says hello, so it has a name.
  const call = async (d, method, route, body) => {
    const key = `${d.dir}:${d.pid}`
    if (hello.key !== key) {
      hello.key = key
      try {
        const r = await rawCall(d, 'POST', '/persona', { via, tool: clientTool(), cwd: process.cwd(), ppid: process.ppid, mcpPids: parentPids(process.ppid, 2) })
        Object.assign(hello, { name: r.name, named: r.named, told: hello.told || !!r.own })
      } catch { hello.key = null } // an older app: everything still works, as this member
    }
    if (method === 'GET') return rawCall(d, method, `${route}${route.includes('?') ? '&' : '?'}via=${via}`)
    return rawCall(d, method, route, { ...(body || {}), via })
  }
  // Said once, in front of an answer: who this session is in the session, and how to rename it.
  const introduce = () => {
    if (!hello.name || hello.told) return ''
    hello.told = true
    return `You are **${hello.name}** in this Quilt session: your messages, claims and inbox are your own, and partners write to you by that name. ` +
      (hello.named ? '' : 'Give yourself a name after your work with quilt_name_session (a few words, like "file queue"); until you do, the first thing you say you are doing names you.') + '\n\n'
  }

  // A session this MCP server runs itself, when the agent joined or started one.
  let joined = null // { run, dir, invite }
  let logs = []
  const clientTool = () => toolLabel(server.server.getClientVersion()?.name)

  // This install is the agent's image. When a newer Quilt is out, every answer says so.
  const updates = new UpdateCheck().start()
  const stale = () => { const n = updates.notice(); return n ? `\n\n⚠️ ${n}` : '' }

  // Quilt undoes edits to files a partner holds; the agent that made them hears about it with its next answer.
  const notices = async (d) => {
    try {
      const { notices } = await call(d, 'POST', '/notices', {})
      return notices.length ? `⚠️ Quilt:\n${notices.map((n) => `- ${n}`).join('\n')}\n\n` : ''
    } catch { return '' }
  }
  // What arrived for this agent (direct messages, mentions, tasks handed over) is put in front of
  // its next answer, whatever tool it runs in. What came before this server found the session
  // is left to quilt_inbox.
  const shown = { key: null, seq: 0 }
  const track = async (d) => {
    const key = `${d.dir}:${d.pid}`
    if (shown.key === key) return shown
    const { seq } = await call(d, 'POST', '/inbox', { after: 0 })
    Object.assign(shown, { key, seq: seq || 0 })
    return shown
  }
  const arrivals = async (d) => {
    try {
      const s = await track(d)
      const r = await call(d, 'POST', '/inbox', { after: s.seq })
      s.seq = r.seq
      const text = renderInbox(r.events)
      return text ? `📬 ${text}\n\n` : ''
    } catch { return '' }
  }
  // Tools that move work forward wait until nobody is waiting for an answer from this agent:
  // the rule is the daemon's (Session.duties), so it holds for every tool and every client.
  const gateFor = (tool) => async (d) => {
    const { waiting } = await call(d, 'GET', '/duties')
    return renderUnanswered(waiting, `call ${tool} again`)
  }
  // Files this agent holds that someone waits for in the file queue: said with every answer until it hands them off.
  const queuedNow = async (d) => { try { return (await call(d, 'GET', '/duties')).queued || [] } catch { return [] } }
  const queueGate = (then) => async (d) => renderQueued(await queuedNow(d), then)
  // When this person lets their AI pick up work by itself: the next task, said as it finishes one.
  const nextUp = async (d) => { try { const n = renderNextTask((await call(d, 'GET', '/duties')).next); return n ? `\n\n➡️ ${n}` : '' } catch { return '' } }
  const gates = (...list) => async (d) => { for (const g of list) { const r = g && await g(d); if (r) return r } return '' }
  const withDaemon = async (fn, { inbox = true, gate = null } = {}) => {
    const d = findDaemon(joined ? joined.dir : undefined)
    if (!d) return { content: [{ type: 'text', text: NOT_RUNNING + stale() }], isError: true }
    const before = async () => introduce() + (await notices(d)) + (inbox ? await arrivals(d) : '')
    const waiting = async () => { const n = renderQueueNotice(await queuedNow(d)); return n ? `\n\n📥 ${n}` : '' }
    try {
      const refused = gate ? await gate(d) : ''
      if (refused) return { content: [{ type: 'text', text: (await before()) + refused + stale() }], isError: true }
      const body = await fn(d)
      return { content: [{ type: 'text', text: (await before()) + body + (await waiting()) + stale() }] }
    } catch (err) {
      return { content: [{ type: 'text', text: (await before()) + `Error: ${err.message}` }], isError: true }
    }
  }

  const taskReader = (st) => ({ name: st.me.name, tool: st.me.tool, asAi: st.me.kind !== 'agent' })
  const describeAssignment = (task, me) => {
    const label = assigneeLabel(task, me)
    const files = task.files?.length ? `\nFiles: ${task.files.join(', ')}` : ''
    return `${label ? `Assigned to ${label}.` : 'Unassigned.'}${files}`
  }

  server.registerTool('quilt_status', {
    description: 'See who else is in the live session, what they are working on, which files they recently edited or claimed, recent messages, and which open tasks are assigned to you. Call this before starting work.',
    inputSchema: {}
  }, () => withDaemon(async (d) => {
    const st = await call(d, 'GET', '/status')
    return renderStatus(st, { asAi: taskReader(st).asAi, mentionYours: true })
  }))

  server.registerTool('quilt_tasks', {
    description: 'List the shared task board (To do, In progress, QA, Done), with an id on each task. Open tasks assigned to you are listed first. Call this before starting work.',
    inputSchema: {}
  }, () => withDaemon(async (d) => {
    const st = await call(d, 'GET', '/status')
    return formatTasks(st.tasks, taskReader(st))
  }))

  server.registerTool('quilt_add_task', {
    description: 'Add a task to the shared board, in To do. One short line. Optionally assign it to a person or their AI, and name the files it is about.',
    inputSchema: {
      title: z.string().describe('What needs doing, in a few words'),
      assignee: z.string().optional().describe('Who should do it: a person\'s name, or "me". Omit to leave it unassigned.'),
      to_ai: z.boolean().optional().describe('Assign it to that person\'s AI instead of the person. You are this person\'s AI unless you joined as your own agent: set assignee to "me" and to_ai to true to take the task yourself.'),
      files: z.array(z.string()).max(20).optional().describe('Project files this task is about, relative paths such as src/app.js')
    }
  }, ({ title, assignee, to_ai, files }) => withDaemon(async (d) => {
    const body = { title }
    if (assignee != null) body.assignee = assignee
    else if (to_ai) body.assignee = 'me'
    if (to_ai) body.to_ai = true
    if (files !== undefined) body.files = files
    const { task } = await call(d, 'POST', '/tasks', body)
    const me = (await call(d, 'GET', '/info')).name
    return `Added to To do: ${task.title}\n${task.id}\n${describeAssignment(task, me)}`
  }, { gate: gateFor('quilt_add_task') }))

  server.registerTool('quilt_move_task', {
    description: 'Move a task on the shared board. "doing" when you start it: you get a briefing (its files, recent changes to them, claims, the project\'s checks). ' +
      '"qa" when you finish implementing and testing: requires `qaNotes` (what changed and how you self-validated); without it the move is refused. ' +
      '"done" after QA: requires `verified`, what you ran and what you saw; without it the move is refused.',
    inputSchema: {
      id: z.string().describe('Task id from quilt_tasks'),
      column: z.enum(['todo', 'doing', 'qa', 'done']).describe('todo, doing, qa, or done'),
      qaNotes: z.string().max(MAX_VERIFIED).optional().describe('For "qa": describe the changes you made and how you self-validated them.'),
      verified: z.string().max(MAX_VERIFIED).optional().describe('For "done": what you ran and what you saw, concretely (commands, results, what you exercised in the app).')
    }
  }, ({ id, column, qaNotes, verified }) => withDaemon(async (d) => {
    const brief = await call(d, 'POST', '/tasks/brief', { id })
    if (column === 'qa' && !qaNotesEnough(qaNotes)) return qaRefusal({ task: brief.task, checklist: brief.checklist })
    if (column === 'done' && !verifiedEnough(verified)) return doneRefusal({ task: brief.task, checklist: brief.checklist })
    const patch = { id, column }
    if (column === 'qa') patch.qaNotes = qaNotes
    if (column === 'done') patch.verified = verified
    const { task } = await call(d, 'POST', '/tasks/update', patch)
    if (column === 'doing') return pickupBrief({ ...brief, task: { ...task, comments: brief.task.comments } })
    if (column === 'qa') return `Moved "${task.title}" to QA. Notes: ${qaNotesLine(task)}` + await nextUp(d)
    if (column === 'done') return `Moved "${task.title}" to Done. Verified: ${verifiedLine(task)}` + await nextUp(d)
    return `Moved "${task.title}" to ${columnName(task.column)}.`
  }, { gate: gates(gateFor('quilt_move_task'), column === 'done' && queueGate('move the task again')) }))

  server.registerTool('quilt_assign_task', {
    description: 'Assign a shared task to a person or to their AI, and optionally set the files it is about. assignee "" clears it. Set assignee to "me" and to_ai to true to take it yourself when you are that person\'s AI.',
    inputSchema: {
      id: z.string().describe('Task id from quilt_tasks'),
      assignee: z.string().describe('A person\'s name, "me", or "" to unassign'),
      to_ai: z.boolean().optional().describe('True: that person\'s AI. Omit or false: the person.'),
      files: z.array(z.string()).max(20).optional().describe('Replace the file list. Omit to leave the files unchanged.')
    }
  }, ({ id, assignee, to_ai, files }) => withDaemon(async (d) => {
    const body = { id, assignee, forAi: !!to_ai }
    if (files !== undefined) body.files = files
    const { task } = await call(d, 'POST', '/tasks/update', body)
    const me = (await call(d, 'GET', '/info')).name
    return describeAssignment(task, me)
  }, { gate: gateFor('quilt_assign_task') }))

  server.registerTool('quilt_task', {
    description: 'One task in full: its column, assignee, files, QA and Done notes, and its comments (work notes and handoffs people left on it).',
    inputSchema: { id: z.string().describe('Task id from quilt_tasks') }
  }, ({ id }) => withDaemon(async (d) => {
    const { tasks } = await call(d, 'GET', '/tasks')
    const task = tasks.find((t) => t.id === id)
    if (!task) return 'No such task: read the board with quilt_tasks.'
    return formatTaskDetails(task)
  }))

  server.registerTool('quilt_comment_task', {
    description: 'Add a comment to a task: a work note, a handoff, or why it went to whom. Put reasoning about a task here instead of in the chat.',
    inputSchema: {
      id: z.string().describe('Task id from quilt_tasks'),
      text: z.string().max(MAX_COMMENT).describe('The comment')
    }
  }, ({ id, text }) => withDaemon(async (d) => {
    const { task } = await call(d, 'POST', '/tasks/comment', { id, text })
    return `Comment added to "${task.title}" (${task.comments.length} on it now).`
  }, { gate: gateFor('quilt_comment_task') }))

  server.registerTool('quilt_delete_task', {
    description: 'Remove a task from the shared board.',
    inputSchema: { id: z.string().describe('Task id from quilt_tasks') }
  }, ({ id }) => withDaemon(async (d) => {
    await call(d, 'POST', '/tasks/delete', { id })
    return 'Removed.'
  }, { gate: gateFor('quilt_delete_task') }))

  server.registerTool('quilt_set_focus', {
    description: 'Tell collaborators what you are working on right now (e.g. "adding dark mode to the settings page"). Shown to them live.',
    inputSchema: { focus: z.string().describe('Short description of the current task') }
  }, ({ focus }) => withDaemon(async (d) => {
    await call(d, 'POST', '/focus', { text: focus })
    return `Focus set: ${focus}`
  }, { gate: gateFor('quilt_set_focus') }))

  server.registerTool('quilt_name_session', {
    description: 'Name yourself in the Quilt session after what you work on. You are a member of your own there, apart from your person and their other AI sessions: ' +
      'partners see you as "<their first name> · <your name>", write to you by it, and see which files you hold. A few words, like "file queue" or "billing bug". Messages to your old name still reach you.',
    inputSchema: { name: z.string().min(1).max(40).describe('A few words about what you work on') }
  }, ({ name }) => withDaemon(async (d) => {
    const r = await call(d, 'POST', '/persona/name', { name })
    Object.assign(hello, { name: r.name, named: 'self', told: true })
    return `You are now ${r.name} in this session.`
  }))

  server.registerTool('quilt_claim', {
    description: 'Claim files so only you can change them while you work: quilt undoes anyone else\'s edits there. Accepts a file path, a folder (it need not exist yet), or a glob like "src/auth/**". Fails if it overlaps someone else\'s claim.',
    inputSchema: {
      pattern: z.string().describe('File path, folder, or glob'),
      reason: z.string().optional().describe('What you are doing there')
    }
  }, ({ pattern, reason }) => withDaemon(async (d) => {
    await call(d, 'POST', '/claim', { pattern, note: reason || '' })
    return `Claimed ${pattern}. Only you can change it until you release it.`
  }, { gate: gateFor('quilt_claim') }))

  server.registerTool('quilt_release', {
    description: 'Release a claim you made (or "*" for all of yours) once you are done.',
    inputSchema: { pattern: z.string().describe('The claimed pattern, or "*"') }
  }, ({ pattern }) => withDaemon(async (d) => {
    const queued = await queuedNow(d)
    if (pattern && pattern !== '*' && queued.some((q) => q.pattern === pattern.trim())) throw new Error(renderQueued(queued.filter((q) => q.pattern === pattern.trim()), 'release it'))
    const r = await call(d, 'POST', '/release', { pattern })
    return `Released ${r.released} claim(s).${r.held ? ` Kept ${r.held.join(', ')}: someone is waiting for ${r.held.length === 1 ? 'it' : 'them'}; hand off with quilt_handoff.` : ''}`
  }))

  server.registerTool('quilt_request_file', {
    description: 'Ask for a file someone else holds (claimed), instead of editing it: your request joins its file queue, its holder is told, and when they finish they hand it to you with their context. ' +
      'You are woken (a direct message: quilt_inbox, the quilt://inbox resource, your webhook) when it is yours. Asking again for the same file updates your request.',
    inputSchema: {
      path: z.string().min(1).max(500).describe('The file you need, relative to the project folder'),
      title: z.string().min(1).max(120).describe('What you will do, e.g. "Working on retry logic for task t-12"'),
      description: z.string().max(300).optional().describe('Your plan in summary: what you want to change and why (300 characters at most)'),
      task: z.string().max(80).optional().describe('The task id this is for, if any')
    }
  }, ({ path: p, title, description, task }) => withDaemon(async (d) => {
    const rel = path.relative(d.dir, path.resolve(d.dir, p)).split(path.sep).join('/')
    const r = await call(d, 'POST', '/request-file', { path: rel, title, description: description || '', task })
    return `Asked for ${rel}: you are number ${r.position} in the queue for ${r.pattern} (held by ${r.holder}). ${r.holder} is told; you will be handed it with their context. Carry on with other work.`
  }))

  server.registerTool('quilt_handoff', {
    description: 'Hand a file you hold to someone waiting for it in its file queue (the first, unless you name them), with your context: what you changed, what is left, anything they should know. ' +
      'The claim becomes theirs and they get your context in a direct message. Required before you finish or release a file someone is waiting for.',
    inputSchema: {
      path: z.string().min(1).max(500).describe('The file (or the claimed pattern) to hand off'),
      context: z.string().min(1).max(2000).describe('What you changed, what is left, gotchas'),
      to: z.string().max(80).optional().describe('Who to hand it to (a name or request id); omit for the first in the queue')
    }
  }, ({ path: p, context, to }) => withDaemon(async (d) => {
    const rel = path.relative(d.dir, path.resolve(d.dir, p)).split(path.sep).join('/')
    const r = await call(d, 'POST', '/handoff', { path: rel, context, to: to || '' })
    return `Handed ${r.pattern} to ${r.to} with your context.${r.waiting ? ` ${r.waiting} more waiting: ${r.to} hands it on next.` : ''}`
  }))

  server.registerTool('quilt_withdraw_request', {
    description: 'Take back your request for a file (from quilt_request_file) when you no longer need it.',
    inputSchema: { path: z.string().min(1).max(500).describe('The file you asked for') }
  }, ({ path: p }) => withDaemon(async (d) => {
    const rel = path.relative(d.dir, path.resolve(d.dir, p)).split(path.sep).join('/')
    const { claims } = await call(d, 'GET', '/tree')
    const me = (await call(d, 'GET', '/info')).name
    const mine = claims.flatMap((c) => c.queue || []).filter((r) => r.by === me && r.path === rel)
    let n = 0
    for (const r of mine) n += (await call(d, 'POST', '/withdraw-request', { request: r.id })).withdrawn
    return n ? `Withdrew your request for ${rel}.` : `You had not asked for ${rel}.`
  }))

  const did = (m, deleted = false) => mergeAction(m, deleted)
  const mergeLine = (m, me) => {
    const who = m.by === me ? 'you' : m.by
    const other = m.others[0] ? (m.others[0] === me ? 'you' : m.others[0]) : 'the session'
    const what = m.kind === 'ai' ? `merged by AI, waiting for a look`
      : m.kind === 'claimed' ? `${who} ${did(m)} but ${m.claimedBy} has it claimed`
      : m.oursDeleted ? `${who} ${did(m, true)} and ${other} changed it in the session`
      : m.theirsHash === null ? `${who} ${did(m)} but it was deleted in the session`
      : `${who} ${did(m)} and ${other} changed it in the session`
    return `- \`${m.path}\` (id ${m.id}, ${m.state}): ${what}${m.reason ? ` — ${m.reason}` : ''}`
  }

  server.registerTool('quilt_merges', {
    description: 'Files whose offline edits and in-session edits could not be combined automatically. Each has an id. The file currently holds the session\'s version; the other version is under .quilt/merges/<id>/ours (with base and theirs beside it). To settle one yourself: write the merged file, then call quilt_resolve_merge with how "agent".',
    inputSchema: {}
  }, () => withDaemon(async (d) => {
    const { merges } = await call(d, 'GET', '/merges')
    const me = (await call(d, 'GET', '/info')).name
    const open = merges.filter((m) => m.state !== 'done')
    if (!open.length) return 'Nothing to merge.'
    return `Merges to settle:\n${open.map((m) => mergeLine(m, me)).join('\n')}`
  }))

  server.registerTool('quilt_resolve_merge', {
    description: 'Settle a merge from quilt_merges. how: "agent" after you wrote the merged file yourself; "mine" to keep the offline version; "theirs" to keep the session version; "review" to accept an AI merge as it is.',
    inputSchema: {
      id: z.string().describe('The merge id'),
      how: z.enum(['agent', 'mine', 'theirs', 'review']).describe('How it was settled')
    }
  }, ({ id, how }) => withDaemon(async (d) => {
    const r = await call(d, 'POST', '/merges/resolve', { id, how })
    return `Settled the merge of ${r.path} (${how}).`
  }, { gate: gateFor('quilt_resolve_merge') }))

  server.registerTool('quilt_message', {
    description: CHAT_RULES + ' Set "to" to message one person directly.',
    inputSchema: {
      text: z.string(),
      to: z.string().optional().describe('Name of one collaborator for a direct message'),
      everyone: z.boolean().optional().describe('Only for a real announcement to the whole session: lets a message that @mentions nobody go out'),
      also: z.boolean().optional().describe('Only when another of your AI sessions already wrote to them and yours is about something different they need')
    }
  }, ({ text, to, everyone, also }) => withDaemon(async (d) => {
    const r = await call(d, 'POST', '/say', { text, to, via, everyone: !!everyone, also: !!also })
    return to && !r.recipientOnline ? `Sent. (${to} is offline and will see it when they reconnect.)` : 'Sent.'
  }))

  // Inbox cursors: one for the tool, one for the channel push, so an event pushed to Claude
  // Code still shows in quilt_inbox, and one that Claude Code ignored (no channel) is not lost.
  const cursor = () => ({ key: null, seq: 0 })
  const toolCursor = cursor()
  const pushCursor = cursor()
  const at = (c, d) => {
    const key = `${d.dir}:${d.pid}`
    if (c.key !== key) { c.key = key; c.seq = 0; c.fresh = true } else c.fresh = false
    return c
  }

  server.registerTool('quilt_check_update', {
    description: 'Whether the Quilt you run (your image) is current. Give the version you run; without one, this Quilt install is checked. An out-of-date image is told to update the app.',
    inputSchema: { image: z.string().max(40).optional().describe('The Quilt version you run, such as 0.3.4') }
  }, ({ image }) => ({ content: [{ type: 'text', text: updates.describe(image) }] }))

  server.registerTool('quilt_inbox', {
    description: 'What is waiting for you: mentions of you in chat (@yourname), direct messages to you, and tasks handed to you since you last looked. Act on each one: answer with quilt_message, take a task with quilt_move_task.',
    inputSchema: {
      all: z.boolean().optional().describe('Include what you already looked at (the last 100 events)'),
      no_reply: z.array(z.string().max(40)).max(50).optional().describe('Ids of messages that need nothing back from you (thanks, a greeting, an FYI, a status report): settled without a reply, for all your sessions')
    }
  }, ({ all, no_reply }) => withDaemon(async (d) => {
    const c = at(toolCursor, d)
    const settled = no_reply && no_reply.length ? (await call(d, 'POST', '/inbox/settle', { ids: no_reply })).settled : []
    const r = await call(d, 'POST', '/inbox', { after: all ? 0 : c.seq, all: !!all })
    c.seq = r.seq
    const s = await track(d)
    if (no_reply && no_reply.length) {
      const note = `Settled as needing no reply: ${settled.length ? settled.join(', ') : 'none (unknown ids)'}.`
      return [note, renderInbox(r.events, { me: r.me })].filter(Boolean).join('\n\n')
    }
    s.seq = Math.max(s.seq, r.seq) // shown here, so not again in front of the next answer
    return renderInbox(r.events, { me: r.me }) || (all ? 'Nothing has been waiting for you.' : 'Nothing new for you.')
  }, { inbox: false }))

  server.registerTool('quilt_webhook_subscribe', {
    description: 'Be told as it happens, by an HTTP POST to a URL of yours, when you are mentioned in chat (@yourname), sent a direct message or handed a task: ' +
      'no need to poll quilt_inbox. One subscription per session folder; calling again replaces it. Each POST is JSON, signed with the secret ' +
      '(x-quilt-signature: sha256=HMAC-SHA256(secret, "<x-quilt-timestamp>.<body>")); answer 2xx. Give a secret of your own or get one back (shown once).',
    inputSchema: {
      url: z.string().min(1).max(2000).describe('The URL to POST to: https, or http on this computer (a webhook trigger of your routine, for example)'),
      secret: z.string().max(200).optional().describe('16 to 200 characters for signing; omit to have Quilt make one'),
      events: z.array(z.enum(WEBHOOK_EVENTS)).max(WEBHOOK_EVENTS.length).optional().describe(`Which events to send (default: all): ${WEBHOOK_EVENTS.join(', ')}`),
      bearer: z.string().max(500).optional().describe('A key your receiver wants on every POST, sent as "Authorization: Bearer <key>" (a Grok Bot routine\'s sender key, for example)')
    }
  }, ({ url, secret, events, bearer }) => withDaemon(async (d) => {
    const { webhook } = await call(d, 'POST', '/webhook', { url, secret, events, bearer })
    return describeSubscription(webhook, { showSecret: webhook.made })
  }))

  server.registerTool('quilt_webhook_unsubscribe', {
    description: 'Stop the webhook: Quilt no longer POSTs mentions, direct messages and tasks to you. quilt_inbox still has them.',
    inputSchema: {}
  }, () => withDaemon(async (d) => {
    const { had } = await call(d, 'POST', '/webhook/clear', {})
    return had ? 'Webhook removed. Mentions, direct messages and tasks still wait in quilt_inbox.' : 'You had no webhook.'
  }))

  // Claude Code started with the quilt channel gets each new inbox event as a turn. Other
  // tools are not sent anything (they read quilt_inbox). What was already waiting when this
  // server first finds the session is left to quilt_inbox, so a fresh Claude is not flooded.
  // Any client that subscribes to the inbox resource (plain MCP) is told the moment something
  // arrives, and reads it; Claude Code started with the quilt channel gets each event as a turn
  // instead. What was already waiting when this server first finds the session is left to quilt_inbox.
  const subscribed = new Set()
  const pushInbox = async () => {
    const channel = clientTool() === 'Claude Code'
    if (!channel && !subscribed.size) return
    const d = findDaemon(joined ? joined.dir : undefined)
    if (!d) return
    const c = at(pushCursor, d)
    const r = await call(d, 'POST', '/inbox', { after: c.seq, poll: true })
    c.seq = r.seq
    if (c.fresh || !r.events.length) return
    for (const uri of subscribed) await server.server.sendResourceUpdated({ uri })
    if (!channel) return
    for (const e of r.events) {
      await server.server.notification({
        method: CHANNEL_METHOD,
        params: { content: [describeEvent(e), renderContext(e, { me: r.me }), INBOX_HOW].filter(Boolean).join('\n'), meta: { kind: e.kind, from: String(e.by || ''), id: String(e.id || '') } }
      })
    }
  }
  server.registerResource('inbox', INBOX_URI, {
    title: 'Quilt inbox',
    description: 'Mentions of you, direct messages to you and tasks handed to you (the last 100). Subscribe to be told when something new arrives.',
    mimeType: 'text/markdown'
  }, async (uri) => {
    const d = findDaemon(joined ? joined.dir : undefined)
    const r = d ? await call(d, 'POST', '/inbox', { after: 0, poll: true }).catch(() => ({ events: [] })) : { events: [] }
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: d ? (renderInbox(r.events, { me: r.me }) || 'Nothing has been waiting for you.') : NOT_RUNNING }] }
  })
  server.server.setRequestHandler(SubscribeRequestSchema, (req) => {
    if (req.params.uri === INBOX_URI) {
      subscribed.add(INBOX_URI)
      // Take stock now, so only what arrives from here on is announced.
      const d = findDaemon(joined ? joined.dir : undefined)
      if (d) call(d, 'POST', '/inbox', { after: 0, poll: true }).then((r) => { const c = at(pushCursor, d); if (c.fresh || c.seq < r.seq) { c.seq = r.seq; c.fresh = false } }).catch(() => {})
    }
    return {}
  })
  server.server.setRequestHandler(UnsubscribeRequestSchema, (req) => { subscribed.delete(req.params.uri); return {} })
  const pushTimer = setInterval(() => pushInbox().catch(() => {}), INBOX_POLL_MS)
  pushTimer.unref()

  server.registerTool('quilt_read_messages', {
    description: 'Read chat messages from collaborators, including direct messages and shared files (with the local path each file was saved to). By default returns only unread messages.',
    inputSchema: {
      all: z.boolean().optional().describe('Return recent messages, not just unread ones'),
      limit: z.number().int().min(1).max(200).optional()
    }
  }, ({ all, limit }) => withDaemon(async (d) => {
    const { messages } = await call(d, 'POST', '/messages', { unreadOnly: !all, limit: limit || 30 })
    if (!messages.length) return all ? 'No messages yet.' : 'No unread messages.'
    const me = (await call(d, 'GET', '/status')).me.name
    return messages.map((m) => `- ${renderMessage(m, me)}`).join('\n')
  }))

  server.registerTool('quilt_conversation', {
    description: CONVERSATION_DESCRIPTION,
    inputSchema: {
      with: z.string().max(200).optional().describe('Only the conversation with this person or agent: direct messages either way, and messages that @mention one of you'),
      q: z.string().max(200).optional().describe('Only messages containing this text (any case)'),
      before: z.string().max(40).optional().describe('Only messages before this message id (to read further back)'),
      limit: z.number().int().min(1).max(200).optional().describe('How many of the newest matching messages (default 30)')
    }
  }, (args) => withDaemon(async (d) => {
    const r = await call(d, 'POST', '/conversation', { with: args.with, q: args.q, before: args.before, limit: args.limit })
    return renderConversation(r, { me: r.me, with: args.with, q: args.q })
  }))

  server.registerTool('quilt_send_file', {
    description: 'Send a file from this project to collaborators through chat, without adding it to the shared project (useful for screenshots, logs, exports, or drafts). The file must be inside the project folder.',
    inputSchema: {
      path: z.string().describe('Path relative to the project root'),
      to: z.string().optional().describe('Send only to this collaborator'),
      message: z.string().optional().describe('Optional note to go with the file')
    }
  }, ({ path: p, to, message }) => withDaemon(async (d) => {
    const abs = insideProject(d.dir, p, { reading: true })
    const r = await call(d, 'POST', '/send', { path: abs, to, text: message || '' })
    return `Sent ${r.file.name}${to ? ` to ${to}` : ''}.`
  }, { gate: gateFor('quilt_send_file') }))

  server.registerTool('quilt_get_file', {
    description: 'Download a file someone shared in chat. Received files are normally saved automatically (see quilt_read_messages); use this to fetch one again or save it into the project.',
    inputSchema: {
      id: z.string().describe('The message id shown next to the file'),
      dest: z.string().optional().describe('Destination path or folder inside the project (default: .quilt/inbox/)')
    }
  }, ({ id, dest }) => withDaemon(async (d) => {
    const r = await call(d, 'POST', '/get', { id, dest: dest ? insideProject(d.dir, dest) : undefined })
    return `Saved to ${path.relative(d.dir, r.path)}`
  }))

  // ------------------------------------------------ joining as an agent --

  const startAs = async ({ conn, folder, agent, inviteServer, starting = false, workspace = '' }) => {
    if (joined) throw new Error(`Already in session ${path.basename(joined.dir)} (${joined.dir}). Call quilt_leave_session first.`)
    const cwd = process.env.QUILT_DIR || process.cwd()
    let dir = folder ? path.resolve(cwd, folder) : null
    if (!dir) {
      // Join into the current folder only if it's empty or already this room's folder. A
      // person's folder for another room gets no copy inside it (their session would sync it).
      const saved = readConfig(cwd)
      const empty = !fs.existsSync(cwd) || fs.readdirSync(cwd).filter((n) => n !== '.quilt' && n !== '.DS_Store').length === 0
      dir = empty || (saved && saved.room === conn.room) ? cwd : saved ? null : roomFolder(cwd, conn.room)
    }
    // A person is already syncing this folder: work through their session.
    if (dir && runningElsewhere(dir)) {
      const saved = readConfig(dir)
      if (saved && saved.room === conn.room) {
        joined = { dir, attached: true }
        return { dir, attached: true }
      }
      throw new Error(`${dir} is already synced by another quilt session. Choose another folder.`)
    }
    // A person's folder that isn't being synced right now (they left, or closed the app) is
    // still theirs: taking it over would lock them out of their own session until the agent
    // leaves. The agent is its own member, in its own copy of the room.
    // Each agent joins as itself: its name, key and passes come from its saved keys.
    const agentKey = pickAgent({ agent })
    const auth = sessionPasses({ agent: agentKey })
    let aside = null
    if (!dir || personsFolder(dir)) {
      if (starting) throw new Error(`${dir} already belongs to a session a person started on this computer. Ask them for its invite link and join that, or start from another folder.`)
      aside = dir || cwd
      dir = agentCopyFolder(conn.room, auth.name)
    }
    // Prefer the agent's registered provider when it names the model maker (xAI), or
    // when the MCP client did not identify a tool. Host IDEs (Cursor) otherwise stay.
    let tool = clientTool()
    try {
      const me = await agentWhoami({ name: auth.name })
      const provider = me?.agent?.provider
      if (provider) {
        const labeled = toolLabel(provider)
        if (labeled === 'xAI') tool = 'xAI'
        else if ((!tool || tool === 'AI agent') && labeled) tool = labeled
      }
    } catch {}
    logs = []
    const run = await runSession({
      dir,
      conn,
      name: auth.name,
      tool,
      kind: 'agent',
      passes: auth.passes,
      identity: auth.identity,
      joined: !inviteServer && !conn.viewSecret,
      inviteServer,
      // This agent's own chat lives where it was started, which may be above the synced folder.
      readerOptions: { chatDir: process.cwd() },
      onLog: (line) => { logs.push(line); if (logs.length > 50) logs.shift() },
      onFatal: async (err) => { logs.push(`stopped: ${err.message}`); await leave() },
      workspace
    })
    joined = { run, dir, invite: run.invite }
    // Puts the new room in its workspace with the agent's own key. A failure (offline, the
    // workspace was removed, the API doesn't have workspaces on) is logged and reported, never
    // fatal: the session has already started and works without it, outside any workspace.
    let workspaceError = ''
    if (workspace) {
      try {
        const saved = await agentAccess({ name: agentKey })
        await setSessionWorkspace({ token: saved.accessKey, id: workspace, room: conn.room, api: saved.api })
        // Then hand its link to the agents that join it by themselves, in the background:
        // starting never waits for this, and a failure is only logged.
        announceWhenReported(agentAnnouncer({ name: agentKey, workspace, room: conn.room, link: run.invite }), {
          alive: () => joined?.run === run,
          log: (line) => run.session.log(line)
        }).catch(() => {})
      } catch (err) {
        workspaceError = `Could not add it to workspace ${workspace}: ${err.message}`
        run.session.log(`could not add this session to workspace ${workspace}: ${err.message}`)
        forgetWorkspace(dir)
      }
    }
    return { dir, invite: run.invite, aside, workspace: workspaceError ? '' : workspace, workspaceError }
  }

  const leave = async () => {
    if (!joined) return false
    const j = joined
    joined = null
    if (j.run) await j.run.stop()
    return true
  }

  const describeSession = async (dir, extra = '') => {
    const d = findDaemon(dir)
    const st = d ? await call(d, 'GET', '/status') : null
    const info = d ? await call(d, 'GET', '/info') : null
    const lines = [extra]
    if (info) lines.push(`Project folder: ${info.dir}`, `You appear as: ${info.name}${info.kind === 'agent' ? ' (AI agent)' : ''}`)
    // Only the id is known locally in phase 1 (its name comes from the accounts API later).
    const cfg = readConfig(dir)
    if (cfg && cfg.workspace) lines.push(`Workspace: ${cfg.workspace}`)
    if (st) lines.push(`Shared files: ${st.fileCount}`, `People online: ${st.peers.map((p) => p.name).join(', ') || 'nobody else yet'}`)
    const acc = info && info.access
    if (acc && acc.state === 'pending') lines.push('⏳ Waiting for the session owner to let you in. Nothing syncs until they approve you; check again with quilt_session_info.')
    else if (acc && acc.controlled) lines.push(`Your access: ${acc.owner ? 'owner' : acc.role === 'viewer' ? 'view only (your file changes are undone)' : acc.scopes && acc.scopes.length ? `may change files only in ${acc.scopes.join(', ')}` : 'may change any file'}`)
    if (info && info.invite) lines.push(`Invite link to edit (for others to join): ${info.invite}`)
    if (info && info.viewInvite) lines.push(`Invite link to view only: ${info.viewInvite}`)
    if (joined && joined.run) lines.push('The session runs inside this MCP server and ends when it stops, or with quilt_leave_session.')
    return lines.filter(Boolean).join('\n')
  }

  server.registerTool('quilt_join_session', {
    description: 'Join a live quilt session from an invite link, as an AI agent. The shared project is synced into a folder (the current folder if it is empty or already this session\'s, otherwise a new "quilt-<room>" subfolder) and kept in sync live. Other people see you in the session.',
    inputSchema: {
      invite: z.string().describe('The invite link, like https://join.heyquilt.com/<room>#<secret> (or the full "quilt join <link>" command)'),
      folder: z.string().optional().describe('Where to put the project, relative to the current folder'),
      agent: z.string().optional().describe('Which Quilt agent to join as (saved with `quilt agent join`). Optional when this computer has only one.')
    }
  }, async ({ invite, folder, agent }) => {
    try {
      const conn = decodeInvite(invite)
      const r = await startAs({ conn, folder, agent })
      const text = await describeSession(r.dir, r.attached
        ? `This folder is already in the session (someone runs quilt here), so you're working through their session.`
        : `Joined room ${conn.room}. Files are synced into ${r.dir}; edit them there.${r.aside ? ` (${r.aside} is a person's own copy of this session on this computer and stays theirs: don't sync or edit it from here.)` : ''}`)
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `Could not join: ${err.message}` }], isError: true }
    }
  })

  server.registerTool('quilt_start_session', {
    description: 'Start a new live quilt session for a folder, as an AI agent, and get an invite link for others.',
    inputSchema: {
      folder: z.string().optional().describe('Folder to share, relative to the current folder (default: current folder)'),
      agent: z.string().optional().describe('Which Quilt agent to join as (saved with `quilt agent join`). Optional when this computer has only one.'),
      workspace: z.string().optional().describe('The id of the workspace this session belongs to, if the person gave you one.')
    }
  }, async ({ folder, agent, workspace }) => {
    if (workspace && !WORKSPACE_ID.test(workspace)) {
      return { content: [{ type: 'text', text: `Could not start: "${workspace}" is not a workspace id. A workspace id looks like 6f1d2c3b-4a5e-4f60-8a9b-0c1d2e3f4a5b; ask the person for it, or leave workspace out.` }], isError: true }
    }
    try {
      const r = await startAs({ conn: newConn(), folder: folder || '.', agent, starting: true, workspace: workspace || '' })
      const started = `Started a session for ${r.dir}. Share the invite link below with collaborators.`
      return { content: [{ type: 'text', text: await describeSession(r.dir, r.workspaceError ? `${started}\n${r.workspaceError}. It is outside any workspace.` : started) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `Could not start: ${err.message}` }], isError: true }
    }
  })

  server.registerTool('quilt_leave_session', {
    description: 'Leave the session this agent joined or started. Files stay on disk.',
    inputSchema: {}
  }, async () => {
    const left = await leave()
    return { content: [{ type: 'text', text: left ? 'Left the session. The files stay where they are.' : 'You have not joined a session from here.' }] }
  })

  // ------------------------------------------------------ commit timing --

  const describeCommits = (c) => {
    const lines = []
    lines.push(c.ready ? '✅ Everyone else\'s AI is idle: a good moment to commit.' : `⏳ Still working: ${c.busy.map((b) => b.why).join('; ')}`)
    lines.push(describeCommitRequests(c, { canCommit: !!c.canCommit }))
    if (c.open.length) lines.push('A request committed outside Quilt (with git by hand) is closed with quilt_commit_request_done.')
    return lines.join('\n')
  }

  server.registerTool('quilt_set_work', {
    description: 'Tell everyone whether you (this agent) are working or done, so people know when it is safe to commit. Set "working" when you start a task and "done" when you finish: ' +
      '"done" lets go of the files claimed for you while you edited. Like every tool that moves work on, it is refused while someone is waiting for an answer from you.',
    inputSchema: {
      state: z.enum(['working', 'done']),
      note: z.string().optional().describe('What you are working on, in a few words')
    }
  }, ({ state, note }) => withDaemon(async (d) => {
    if (state === 'working') {
      await call(d, 'POST', '/work', { state, note })
      return 'Marked as working. Set "done" when you finish so others know it is safe to commit.'
    }
    const { released } = await call(d, 'POST', '/finish', {})
    await call(d, 'POST', '/work', { state, note })
    return `Marked as done.${released ? ` Let go of ${released} file${released === 1 ? '' : 's'} claimed for you while you edited.` : ''}` + await nextUp(d)
  }, { gate: gates(gateFor('quilt_set_work'), state === 'done' && queueGate('set done again')) }))

  server.registerTool('quilt_share', {
    description: 'Share what you are doing with your collaborators; it appears live in their Quilt feed and on the task board, in any tool. Call it when you start on a request ' +
      '(`request`: what your user asked, in a sentence; `summary`: your plan) and again when you finish (`summary`: what you did; `files`: files you changed). ' +
      'Starting marks you as working, so the host doesn\'t commit under you. Keep it short and never include secrets, keys or file contents.',
    inputSchema: {
      request: z.string().max(2000).optional().describe('What your user asked for, in a sentence (only when starting a new request)'),
      summary: z.string().max(4000).describe('Your plan, progress or result, in one to three sentences'),
      files: z.array(z.string().max(300)).max(30).optional().describe('Project files you changed, relative paths')
    }
  }, ({ request, summary, files }) => withDaemon(async (d) => {
    const r = await call(d, 'POST', '/share-work', { tool: clientTool(), request, summary, files })
    if (r.automatic) return 'Quilt already shares your chat with the session as you work, so nothing more to do.'
    return r.shared ? 'Shared with the session.' : 'Nothing to share: give a summary.'
  }))

  server.registerTool('quilt_chat_link', {
    description: 'Session owner only: make a link for an AI that only has a chat window (ChatGPT, claude.ai, Grok and the like). ' +
      'Your user pastes it into that chat; the AI then reads and sends messages, reads and adds tasks, reads files, and adds pictures, documents and notes ' +
      'by opening links, with nothing to install. It joins as its own member (removing it ends the link). ' +
      'It works for ten minutes unless extended with quilt_extend_chat_link; once it runs out, a new link is needed.',
    inputSchema: {
      name: z.string().max(40).optional().describe('How it appears in the session, e.g. "ChatGPT"'),
      minutes: z.number().int().min(1).max(43200).optional().describe('How long the link works (default 10 minutes, at most 30 days)')
    }
  }, ({ name, minutes }) => withDaemon(async (d) => {
    const r = await call(d, 'POST', '/chat-link', { name, minutes })
    return `Chat link for ${r.name} (works until ${new Date(r.expiresAt).toISOString().slice(0, 16).replace('T', ' ')} UTC):\n${r.url}\n\n` +
      'Give it to your user to paste into the chat AI, with a line like "Open this link and follow it to join our Quilt session." Anyone with the link can act as that member, so share it only there.'
  }))

  server.registerTool('quilt_extend_chat_link', {
    description: 'Session owner only: set how long a chat link still works, from now (shorter or longer). Only a link that still works can be extended; one that ran out needs a new link (quilt_chat_link).',
    inputSchema: {
      who: z.string().max(80).describe('The chat AI\'s name in the session, e.g. "ChatGPT"'),
      minutes: z.number().int().min(1).max(43200).describe('Minutes from now, e.g. 60 for an hour')
    }
  }, ({ who, minutes }) => withDaemon(async (d) => {
    const r = await call(d, 'POST', '/chat-link/extend', { who, minutes })
    return `${r.name}'s chat link now works until ${new Date(r.expiresAt).toISOString().slice(0, 16).replace('T', ' ')} UTC.`
  }))

  server.registerTool('quilt_before_edit', {
    description: 'Call before you change files (with your own edit tools), with the paths you are about to change. For each file: whether it is yours to edit ' +
      '(a file nobody holds is claimed for you until you finish; one someone else holds is refused: do not edit it, message them instead), and what people said ' +
      'about those files in chat lately (what they asked for, warned about or planned). Works in every tool; it is how Quilt keeps agents from overwriting each other.',
    inputSchema: {
      paths: z.array(z.string().min(1).max(500)).min(1).max(50).describe('Files you are about to change: relative to the project folder, or absolute inside it')
    }
  }, ({ paths }) => withDaemon(async (d) => {
    const outside = []
    const rels = []
    for (const p of paths) {
      const rel = path.relative(d.dir, path.resolve(d.dir, p)).split(path.sep).join('/')
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) outside.push(p)
      else rels.push(rel)
    }
    const r = rels.length ? await call(d, 'POST', '/before-edit', { paths: rels }) : { files: [], chat: [] }
    const lines = []
    for (const f of r.files) {
      if (!f.shared) lines.push(`- ${f.path}: not shared by Quilt (ignored or private): edit it as you like.`)
      else if (f.ok) lines.push(`- ${f.path}: ✅ yours to edit${f.claimed ? ' (claimed for you until you finish)' : ''}.`)
      else lines.push(`- ${f.path}: ⛔ ${heldRefusal(f.path, f.claim, f.error)}`)
    }
    for (const p of outside) lines.push(`- ${p}: not inside the project folder (${d.dir}).`)
    const said = renderChatAbout(r.chat)
    return lines.join('\n') + (said ? `\n\n${said}` : '') + '\n\nRe-read each file right before you edit it.'
  }))

  server.registerTool('quilt_request_commit', {
    description: REQUEST_COMMIT_DESCRIPTION,
    inputSchema: {
      message: z.string().max(500).optional().describe('The commit message: what the change does (a task\'s title by default)'),
      files: z.array(z.string().max(1024)).max(500).optional().describe('The files you changed, relative to the project\'s top folder (deleted ones too)'),
      task: z.string().max(40).optional().describe('The task this work was for: its title is the message and its changes the files, unless you give them')
    }
  }, ({ message, files, task }) => withDaemon(async (d) => {
    const r = await call(d, 'POST', '/commit-request', { message, files, task })
    return `Asked for a commit [${r.id}] of ${r.files.length} file${r.files.length === 1 ? '' : 's'}: ${r.files.slice(0, 12).join(', ')}${r.files.length > 12 ? ', …' : ''}.\n${r.committer}`
  }, { gate: gateFor('quilt_request_commit') }))

  server.registerTool('quilt_commit', {
    description: COMMIT_DESCRIPTION,
    inputSchema: commitSchema(z)
  }, (args) => withDaemon(async (d) => {
    const r = await call(d, 'POST', '/commit', { files: args.files, message: args.message, branch: args.branch, pullRequest: args.pull_request, withOthers: args.with_others, task: args.task })
    return describeCommit(r, { policy: r.agentCommits })
  }, { gate: gateFor('quilt_commit') }))

  server.registerTool('quilt_agent_commits', {
    description: 'Session owner only: what agents may do with quilt_commit. "off": nothing (they ask a person with quilt_request_commit); "branches" (the default): branches of their own, quilt/<agent>/…, with pull requests for people to merge; "any": any branch, the session\'s own included. People are not limited by it.',
    inputSchema: { mode: z.enum(['off', 'branches', 'any']) }
  }, ({ mode }) => withDaemon(async (d) => {
    const r = await call(d, 'POST', '/agent-commits', { mode })
    return `Now ${POLICY_WORDS[r.agentCommits]}.`
  }))

  server.registerTool('quilt_branches', {
    description: 'The session\'s git branches: which branch each member\'s folder is on, which AI sessions and worktrees work on which branch, how each stands against its upstream (behind, ahead, diverged), and who committed last. Read it before you branch, merge or push.',
    inputSchema: {}
  }, () => withDaemon(async (d) => {
    const { branches, git } = await call(d, 'GET', '/branches')
    const here = git && git.branch ? `This folder is on \`${git.branch}\`${git.upstream ? ` (${upstreamLine(git.upstream)})` : ''}.\n\n` : ''
    return here + branchesMarkdown(branches || [], { limit: 40 })
  }))

  server.registerTool('quilt_sync_branch', {
    description: 'Bring commits made outside the session into it now: fetches this folder\'s upstream (say origin/main after a PR merged, or a push from a worktree) and moves the branch forward, with the session\'s uncommitted work merged in. Quilt also does this by itself about once a minute; call it right after you push or merge elsewhere. It says when the fetch fails (git has no credentials here, say). A folder that is not a git clone, or can\'t fetch, asks the relay to bring the commits in from GitHub instead. It never merges git history: a branch that has diverged, or files that clash with the session\'s work, become one task on the board for one AI to resolve (the others are told to leave those files to them).',
    inputSchema: {}
  }, () => withDaemon(async (d) => describeBranchSync(await call(d, 'POST', '/branches/sync'))))

  server.registerTool('quilt_github_token', {
    description: 'Session owner only: set (or clear, with an empty token) the GitHub token the relay uses to bring commits in from a private repository while no folder can, to load branches from it for hosted agents, and, when it can write, to commit members\' work (quilt_commit). A fine-grained token for the repository with "Contents: Read" brings commits in; "Contents: Read and write" and "Pull requests: Read and write" let agents commit and open pull requests, within what quilt_agent_commits allows. It goes to the relay and stays there: never shown again.',
    inputSchema: { token: z.string().max(300).describe('The token (github_pat_… or ghp_…), or "" to remove it') }
  }, ({ token }) => withDaemon(async (d) => {
    const r = await call(d, 'POST', '/github-token', { token })
    return r.githubToken ? 'Saved the GitHub token on the relay. It looks at the session\'s branches again now.' : 'Removed the GitHub token.'
  }))

  server.registerTool('quilt_commit_status', {
    description: 'Is it a good moment to commit? Lists open commit requests and whose AI is still working (not counting yours).',
    inputSchema: {}
  }, () => withDaemon(async (d) => describeCommits(await call(d, 'GET', '/commits'))))

  server.registerTool('quilt_wait_until_idle', {
    description: 'Wait until every other AI in the session is idle (or the timeout passes), then report. Use it before committing, or when you need everyone else to finish first.',
    inputSchema: { timeout_seconds: z.number().int().min(5).max(1800).optional().describe('How long to wait at most (default 300)') }
  }, ({ timeout_seconds: timeout = 300 }) => withDaemon(async (d) => {
    const until = Date.now() + timeout * 1000
    let c = await call(d, 'GET', '/commits')
    while (!c.ready && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 3000))
      c = await call(d, 'GET', '/commits')
    }
    return `${c.ready ? '' : `Stopped waiting after ${timeout}s.\n`}${describeCommits(c)}`
  }, { gate: gateFor('quilt_wait_until_idle') }))

  server.registerTool('quilt_commit_request_done', {
    description: 'Close commit requests whose work was committed with git by hand (or isn\'t needed any more). Without an id, every open request is closed. To have Quilt commit one, use quilt_commit in a folder with git.',
    inputSchema: { id: z.string().optional().describe('One request id; omit for all open ones') }
  }, ({ id }) => withDaemon(async (d) => {
    const { done } = await call(d, 'POST', '/commit-request/done', { id })
    return done ? `Marked ${done} commit request${done === 1 ? '' : 's'} done.` : 'No open commit requests.'
  }, { gate: gateFor('quilt_commit_request_done') }))

  server.registerTool('quilt_session_info', {
    description: 'Where the shared project lives on disk, how you appear to others, who is online, and the invite link.',
    inputSchema: {}
  }, () => withDaemon(async (d) => describeSession(d.dir)))

  // ------------------------------------------------- the workspace, for agents --

  server.registerTool('quilt_history', {
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
  }, ({ path: p, by, since, task, with_diff, limit }) => withDaemon(async (d) => {
    const { entries } = await call(d, 'POST', '/history', { path: p, by, since, task, limit: limit || 30 })
    return formatHistory(entries, { withDiff: !!with_diff })
  }))

  server.registerTool('quilt_partner_feed', {
    description: 'Read what a collaborator\'s AI is doing: their prompts, the AI\'s replies, and one-line actions like "Edited src/app.ts". Without "who", lists collaborators and their AI status. Use it to avoid duplicating or conflicting with their work.',
    inputSchema: {
      who: z.string().optional().describe('Collaborator name'),
      limit: z.number().int().min(1).max(300).optional().describe('How many recent entries (default 40)')
    }
  }, ({ who, limit }) => withDaemon(async (d) => {
    const st = await call(d, 'GET', '/status')
    if (!who) {
      if (!st.peers.length) return 'Nobody else is in the session right now.'
      return st.peers.map((p) => {
        const a = p.agent || {}
        const reported = p.work && p.work.state === 'working' ? `working${p.work.note ? `: ${p.work.note}` : ''}` : null
        const ai = a.sharing === false ? 'sharing paused' : a.status === 'working' && a.tool ? `${a.tool} working` : reported || (a.status === 'unavailable' ? 'feed unavailable' : a.tool ? `${a.tool} ${a.status}` : 'no AI activity yet')
        return `- ${p.name}${p.kind === 'agent' ? ' (AI agent)' : ''}: ${ai}${p.focus ? `; focus: ${p.focus}` : ''}`
      }).join('\n') + '\n\nCall again with "who" to read one feed.'
    }
    const { entries } = await call(d, 'POST', '/feed', { who, limit: limit || 40 })
    if (!entries.length) return `No AI activity from ${who} yet.`
    const cut = (t) => (t.length > 1500 ? t.slice(0, 1500) + '…' : t)
    let conv = null
    const out = []
    for (const e of entries) {
      if (e.conv && conv && e.conv !== conv) out.push('--- new conversation ---')
      if (e.conv) conv = e.conv
      if (e.kind === 'prompt') out.push(`${who} asked: ${cut(e.text)}`)
      else if (e.kind === 'reply') out.push(`${e.tool || 'AI'} replied: ${cut(e.text)}`)
      else if (e.kind === 'action') out.push(`  · ${e.text}`)
      else out.push(`(${who} ${e.kind} sharing)`)
    }
    const p = st.peers.find((x) => x.name === who)
    if (p && p.agent && p.agent.status === 'working' && p.agent.sharing !== false) out.push(`(${who}'s AI is working right now)`)
    return out.join('\n')
  }))

  server.registerTool('quilt_list_files', {
    description: 'List the shared project\'s files with who edited each one recently and any claims, so you can see where others are working.',
    inputSchema: { prefix: z.string().optional().describe('Only paths under this folder, e.g. "src/auth"') }
  }, ({ prefix }) => withDaemon(async (d) => {
    const { files, claims } = await call(d, 'GET', '/tree')
    const me = (await call(d, 'GET', '/info')).name
    const pre = prefix ? prefix.replace(/^\.\//, '').replace(/\/+$/, '') : ''
    const shown = files.filter((f) => !pre || f.path === pre || f.path.startsWith(pre + '/'))
    const now = Date.now()
    const lines = shown.slice(0, 400).map((f) => {
      const notes = []
      if (f.edited && now - f.edited.ts < 10 * 60 * 1000) notes.push(`edited by ${f.edited.by === me ? 'you' : f.edited.by} ${Math.round((now - f.edited.ts) / 1000)}s ago`)
      if (f.claim) notes.push(`claimed by ${f.claim.by === me ? 'you' : f.claim.by}${f.claim.note ? `: ${f.claim.note}` : ''}${f.claim.queue && f.claim.queue.length ? `, ${f.claim.queue.length} waiting` : ''}`)
      if (f.binary) notes.push('binary')
      return `${f.path}${notes.length ? `  [${notes.join('; ')}]` : ''}`
    })
    if (shown.length > 400) lines.push(`… and ${shown.length - 400} more (use prefix to narrow)`)
    const claimLines = claims.length ? '\n\nClaims: ' + claims.map((c) => `${c.pattern} (${c.by === me ? 'you' : c.by}${c.note ? `: ${c.note}` : ''})`).join(', ') : ''
    return (lines.join('\n') || 'No shared files.') + claimLines
  }))

  server.server.onclose = () => { clearInterval(pushTimer); updates.stop(); leave().catch(() => {}) }
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { leave().finally(() => process.exit(0)) })

  server.server.oninitialized = () => {
    const client = server.server.getClientVersion()
    const d = findDaemon()
    if (d && client && client.name) call(d, 'POST', '/agent', { client: client.name }).catch(() => {}) // says hello too
  }

  await server.connect(new StdioServerTransport())
  // The workspace library tools arrive a moment later (the client is told the tool list
  // changed), so startup never waits on the API.
  // fromPath reads only from the project: the session's folder, or where the agent runs.
  const projectDirs = () => [joined?.dir, findDaemon(joined ? joined.dir : undefined)?.dir, process.env.QUILT_DIR || process.cwd()].filter(Boolean)
  addWorkspaceTools(server, { projectDirs }).catch(() => {})
}

/**
 * One try at handing a session's link to the agents that join it by themselves, as the agent
 * `name` that started it. Its access key is read afresh on every try (agentAccess refreshes
 * it when it has nearly run out), so a retry minutes later never sends an expired one.
 */
export function agentAnnouncer ({ name, workspace, room, link, access = agentAccess, announce = announceSessionStarted }) {
  return async () => {
    const saved = await access({ name })
    return announce({ token: saved.accessKey, id: workspace, room, link, api: saved.api })
  }
}

// How long the startup check of the API's features may take before the tools are left out.
export const FEATURES_TIMEOUT_MS = 2000
// Up to the library's largest file, to or from storage.
const TRANSFER_TIMEOUT_MS = 10 * 60 * 1000
const MAX_LOCAL_FILE = 500 * 1024 * 1024

/**
 * Who the library tools act as, decided afresh on every call (the MCP may join a session as an
 * agent later): the agent whose folder this is (the first of `dirs` holding a session, joined
 * as one of this computer's saved agents); in a person's folder, the person signed in on this
 * computer (their AI works as them); else this computer's only agent; else the signed-in
 * person. null when there is nobody to act as.
 */
export function workspaceActor ({ dirs = [process.cwd()] } = {}) {
  const agents = savedAgents()
  let personsFolder = false
  for (const d of dirs) {
    const c = readConfig(d)
    if (!c) continue
    if (c.kind === 'agent' && c.name && agents.includes(c.name)) return { agent: c.name }
    personsFolder = c.kind !== 'agent'
    break
  }
  const signedIn = !!readAccount()
  if (personsFolder && signedIn) return { person: true }
  if (agents.length === 1) return { agent: agents[0] }
  return signedIn ? { person: true } : null
}

const NOBODY = 'Sign in to Quilt on this computer (the Quilt app, or quilt login), or join as an agent, to use the workspace library.'

/**
 * How the library reaches the API from this computer, for the local MCP and the CLI: as
 * workspaceActor decides on each call. { actor, api(), call, fetchBytes, put, readLocal,
 * saveDir } for registerWorkspaceTools; api() throws when there is nobody to act as.
 */
export function localWorkspaceAccess ({ fetch: fetchImpl = globalThis.fetch, projectDirs = () => [process.cwd()] } = {}) {
  const actor = () => workspaceActor({ dirs: projectDirs() })
  const api = () => {
    const a = actor()
    if (!a) throw new Error(NOBODY)
    return String((a.agent && readAgent({ name: a.agent }).api) || apiUrl()).replace(/\/+$/, '')
  }
  const send = async (base, token, method, route, body) => {
    try {
      return await fetchImpl(String(base).replace(/\/+$/, '') + route, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000)
      })
    } catch (err) {
      throw new Error(`Couldn't reach Quilt (${err.cause?.code || err.message}).`)
    }
  }
  const call = async (method, route, body) => {
    const a = actor()
    if (!a) throw new Error(NOBODY)
    let res
    if (a.agent) {
      // A fresh access key every call: it is refreshed (and saved) when it has nearly run out.
      const saved = await agentAccess({ name: a.agent, fetch: fetchImpl })
      res = await send(saved.api || apiUrl(), saved.accessKey, method, route, body)
    } else {
      const account = readAccount()
      if (!account) throw new Error(NOBODY)
      res = await send(apiUrl(), account.token, method, route, body)
      // The sign-in ran out, not the link to this computer: sign back in with its key, once.
      if (res.status === 401) {
        const back = await resumeAccount({ fetch: fetchImpl }).catch(() => null)
        if (back) res = await send(apiUrl(), back.token, method, route, body)
      }
    }
    const data = await res.json().catch(() => null)
    if (!res.ok) throw Object.assign(new Error(data?.error || `Quilt answered ${res.status}.`), { status: res.status })
    if (!data || typeof data !== 'object') throw new Error('Quilt sent back something unexpected.')
    return data
  }
  const fetchBytes = bytesFetcher(fetchImpl, { timeoutMs: TRANSFER_TIMEOUT_MS })
  const put = async (url, bytes, headers) => (await fetchImpl(url, { method: 'PUT', headers, body: bytes, signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) })).status
  return { actor, api, call, fetchBytes, put, saveDir: path.join(quiltHome(), 'workspaces'), readLocal: (p) => readLocalFile(p, projectDirs()) }
}

/** Whether the API at `api` says workspaces are on (false when it is slow, unreachable or odd). */
export async function workspacesOn (api, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(`${api}/v1/features`, { signal: AbortSignal.timeout(FEATURES_TIMEOUT_MS) })
    return res.ok && (await res.json())?.workspaces === true
  } catch { return false }
}

/**
 * Adds the workspace library tools when there is someone to act as (workspaceActor: this
 * folder's agent, or the person signed in on this computer) and their API says workspaces are
 * on. Anything else (nobody, the flag off, the API slow, unreachable or odd) adds nothing and
 * never throws. Returns whether the tools were added.
 */
export async function addWorkspaceTools (server, { fetch: fetchImpl = globalThis.fetch, projectDirs = () => [process.cwd()] } = {}) {
  const access = localWorkspaceAccess({ fetch: fetchImpl, projectDirs })
  let api
  try { api = access.api() } catch { return false }
  if (!await workspacesOn(api, fetchImpl)) return false
  try {
    registerWorkspaceTools(server, { ...access, guide: true })
  } catch { return false }
  return true
}

const realOr = async (p) => { try { return await fs.promises.realpath(p) } catch { return path.resolve(p) } }

/**
 * A file for quilt_workspace_write_file's fromPath: only from the project (`dirs`, the first
 * resolving a relative path) or the temp folder, as quilt_send_file only sends project files,
 * so a prompt-injected agent can't put ~/.ssh in a library other people read. Never the
 * agent's own keys or anything else in ~/.quilt, nor an .env file. Symlinks are followed
 * before the checks.
 */
export async function readLocalFile (p, dirs = [process.cwd()]) {
  const abs = await fs.promises.realpath(path.resolve(dirs[0] || process.cwd(), String(p)))
  const roots = await Promise.all([...dirs, os.tmpdir()].map(realOr))
  if (!roots.some((root) => isInside(root, abs))) throw new Error(`${p} is outside this project. Copy it into the project folder first, then send it from there.`)
  const home = await realOr(quiltHome())
  if (abs === home || isInside(home, abs)) throw new Error('Quilt\'s own files (keys and settings) are not sent to a library.')
  const base = path.basename(abs)
  if (/^\.env(\..*)?$/.test(base) && base !== '.env.example') throw new Error('refusing to send environment/secret files')
  const st = await fs.promises.stat(abs)
  if (!st.isFile()) throw new Error(`${p} is not a file`)
  if (st.size > MAX_LOCAL_FILE) throw new Error('That file is too large (at most 500 MB).')
  return fs.promises.readFile(abs)
}

// Agents may only send or save files inside the project folder, and may not
// send secrets, so a prompt-injected agent can't leak ~/.ssh or .env.
function insideProject (root, p, { reading = false } = {}) {
  const abs = path.resolve(root, p)
  const check = (base, target) => {
    const rel = path.relative(base, target)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('path must be inside the project folder')
  }
  check(root, abs)
  if (reading) {
    check(fs.realpathSync(root), fs.realpathSync(abs)) // no symlinks pointing outside
    const base = path.basename(abs)
    if (/^\.env(\..*)?$/.test(base) && base !== '.env.example') throw new Error('refusing to send environment/secret files')
  }
  return abs
}
