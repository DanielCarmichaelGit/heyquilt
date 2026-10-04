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
import path from 'node:path'
import { findDaemon, call } from './control.js'
import { renderMessage, renderStatus } from './status.js'
import { formatTasks, columnName, assigneeLabel } from './tasks.js'
import { runSession, decodeInvite, newConn, readConfig, runningElsewhere, personsFolder, agentCopyFolder } from './runner.js'
import { INVALID_INVITE } from './ui/invite.js'
import { toolLabel } from './agents/common.js'
import { sessionPasses } from './pass-source.js'
import { pickAgent } from './agent-join.js'
import { TASK_WORKFLOW, pickupBrief, doneRefusal, verifiedEnough, verifiedLine, MAX_VERIFIED } from './agent-task-workflow.js'
import { formatHistory } from './history.js'
import { renderInbox, describeEvent, INBOX_HOW } from './inbox.js'
import { renderRequests, renderUnanswered, heldRefusal, askedRefusal } from './duties.js'
import { describeSubscription, WEBHOOK_EVENTS } from './webhooks.js'
import { UpdateCheck } from './update-check.js'
import { getSettings } from './settings.js'

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
  'and move a task with quilt_move_task when you start or finish it. ' +
  'quilt_history tells you who changed which file, when, with the diff: read it for the files you are about to touch. ' +
  'When you edit files for a request that is not already on the board, Quilt adds an In progress task from that chat: use it instead of adding a duplicate, and move it to Done when you finish. ' +
  'Before you change files, call quilt_before_edit with their paths: it tells you whether each is yours to edit (claiming free ones for you, so partners are refused instead of overwriting you), ' +
  'and shows what people asked about those files that you have not answered yet. Do not edit a file it refuses: message the holder with quilt_message and carry on with other work. ' +
  'Claims also follow your edits: a file you change that nobody holds is claimed for you until you finish. ' +
  'If an edit of yours was undone because someone else holds the file, your next quilt answer says so: do not retry; message them with quilt_message and carry on with other work. ' +
  'Every quilt answer starts with anything new for you (direct messages, mentions, tasks handed to you): act on it. ' +
  'These rules are enforced: while someone who messaged or mentioned you is waiting for an answer, the tools that move work on (claims, tasks, focus, merges, commits, quilt_set_work) refuse until you answer them with quilt_message; ' +
  'an edit to a file someone asked about is undone until you answer them; an edit to a file someone else holds is undone. ' +
  'When you finish a piece of work, call quilt_set_work with "done": it lets go of the files claimed for you. ' +
  'Claim ahead (quilt_claim) only for a larger change across several files. ' +
  'Always re-read a file right before you edit it. ' +
  'If quilt_status lists merges to settle, read quilt_merges before editing those files. ' +
  'Mentions of you (@yourname) in chat, direct messages to you and tasks handed to you wait in quilt_inbox: read it when you start, and act on each one. ' +
  'To be woken instead of polling, subscribe to the quilt://inbox resource (you are told when something new arrives), or quilt_webhook_subscribe POSTs each one to a URL of yours as it happens. ' +
  'Share what you are doing with quilt_share: when you start on a request (request and your plan) and when you finish (what you did and the files you changed). Partners see it in their feed, it puts your work on the task board, and it tells the host not to commit under you. ' +
  'When Claude Code is started with the quilt channel, they arrive on their own as <channel source="quilt"> events while you work: treat each like a request from that person, answer with quilt_message, and take a task with quilt_move_task. ' +
  TASK_WORKFLOW

export async function runMcp () {
  const server = new McpServer(
    { name: 'quilt', version: '0.1.0' },
    // The channel capability lets Claude Code (started with the quilt channel) take inbox events as turns.
    { instructions: MCP_INSTRUCTIONS, capabilities: { resources: { subscribe: true }, experimental: { 'claude/channel': {} } } }
  )

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
  const withDaemon = async (fn, { inbox = true, gate = null } = {}) => {
    const d = findDaemon(joined ? joined.dir : undefined)
    if (!d) return { content: [{ type: 'text', text: NOT_RUNNING + stale() }], isError: true }
    const before = async () => (await notices(d)) + (inbox ? await arrivals(d) : '')
    try {
      const refused = gate ? await gate(d) : ''
      if (refused) return { content: [{ type: 'text', text: (await before()) + refused + stale() }], isError: true }
      const body = await fn(d)
      return { content: [{ type: 'text', text: (await before()) + body + stale() }] }
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
    description: 'List the shared task board (To do, In progress, Done), with an id on each task. Open tasks assigned to you are listed first. Call this before starting work.',
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
      '"done" when you finish: requires `verified`, what you ran and what you saw; without it the move is refused.',
    inputSchema: {
      id: z.string().describe('Task id from quilt_tasks'),
      column: z.enum(['todo', 'doing', 'done']).describe('todo, doing, or done'),
      verified: z.string().max(MAX_VERIFIED).optional().describe('For "done": what you ran and what you saw, concretely (commands, results, what you exercised in the app).')
    }
  }, ({ id, column, verified }) => withDaemon(async (d) => {
    const brief = await call(d, 'POST', '/tasks/brief', { id })
    if (column === 'done' && !verifiedEnough(verified)) return doneRefusal({ task: brief.task, checklist: brief.checklist })
    const { task } = await call(d, 'POST', '/tasks/update', { id, column, ...(column === 'done' ? { verified } : {}) })
    if (column === 'doing') return pickupBrief({ ...brief, task })
    if (column === 'done') return `Moved "${task.title}" to Done. Verified: ${verifiedLine(task)}`
    return `Moved "${task.title}" to ${columnName(task.column)}.`
  }, { gate: gateFor('quilt_move_task') }))

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
    const r = await call(d, 'POST', '/release', { pattern })
    return `Released ${r.released} claim(s).`
  }))

  const mergeLine = (m, me) => {
    const who = m.by === me ? 'you' : m.by
    const other = m.others[0] ? (m.others[0] === me ? 'you' : m.others[0]) : 'the session'
    const what = m.kind === 'ai' ? `merged by AI, waiting for a look`
      : m.kind === 'claimed' ? `${who} changed it offline but ${m.claimedBy} has it claimed`
      : m.oursDeleted ? `${who} deleted it offline and ${other} changed it in the session`
      : m.theirsHash === null ? `${who} changed it offline but it was deleted in the session`
      : `${who} changed it offline and ${other} changed it in the session`
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
    description: 'Send a chat message to collaborators, e.g. to ask a question, hand off work, or warn about a breaking change. Set "to" to message one person directly.',
    inputSchema: {
      text: z.string(),
      to: z.string().optional().describe('Name of one collaborator for a direct message; omit to message everyone')
    }
  }, ({ text, to }) => withDaemon(async (d) => {
    const r = await call(d, 'POST', '/say', { text, to })
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
    inputSchema: { all: z.boolean().optional().describe('Include what you already looked at (the last 100 events)') }
  }, ({ all }) => withDaemon(async (d) => {
    const c = at(toolCursor, d)
    const r = await call(d, 'POST', '/inbox', { after: all ? 0 : c.seq })
    c.seq = r.seq
    const s = await track(d)
    s.seq = Math.max(s.seq, r.seq) // shown here, so not again in front of the next answer
    return renderInbox(r.events) || (all ? 'Nothing has been waiting for you.' : 'Nothing new for you.')
  }, { inbox: false }))

  server.registerTool('quilt_webhook_subscribe', {
    description: 'Be told as it happens, by an HTTP POST to a URL of yours, when you are mentioned in chat (@yourname), sent a direct message or handed a task: ' +
      'no need to poll quilt_inbox. One subscription per session folder; calling again replaces it. Each POST is JSON, signed with the secret ' +
      '(x-quilt-signature: sha256=HMAC-SHA256(secret, "<x-quilt-timestamp>.<body>")); answer 2xx. Give a secret of your own or get one back (shown once).',
    inputSchema: {
      url: z.string().min(1).max(2000).describe('The URL to POST to: https, or http on this computer (a webhook trigger of your routine, for example)'),
      secret: z.string().max(200).optional().describe('16 to 200 characters for signing; omit to have Quilt make one'),
      events: z.array(z.enum(WEBHOOK_EVENTS)).max(WEBHOOK_EVENTS.length).optional().describe(`Which events to send (default: all): ${WEBHOOK_EVENTS.join(', ')}`)
    }
  }, ({ url, secret, events }) => withDaemon(async (d) => {
    const { webhook } = await call(d, 'POST', '/webhook', { url, secret, events })
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
    const r = await call(d, 'POST', '/inbox', { after: c.seq })
    c.seq = r.seq
    if (c.fresh || !r.events.length) return
    for (const uri of subscribed) await server.server.sendResourceUpdated({ uri })
    if (!channel) return
    for (const e of r.events) {
      await server.server.notification({
        method: CHANNEL_METHOD,
        params: { content: `${describeEvent(e)}\n${INBOX_HOW}`, meta: { kind: e.kind, from: String(e.by || ''), id: String(e.id || '') } }
      })
    }
  }
  server.registerResource('inbox', INBOX_URI, {
    title: 'Quilt inbox',
    description: 'Mentions of you, direct messages to you and tasks handed to you (the last 100). Subscribe to be told when something new arrives.',
    mimeType: 'text/markdown'
  }, async (uri) => {
    const d = findDaemon(joined ? joined.dir : undefined)
    const r = d ? await call(d, 'POST', '/inbox', { after: 0 }).catch(() => ({ events: [] })) : { events: [] }
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: d ? (renderInbox(r.events) || 'Nothing has been waiting for you.') : NOT_RUNNING }] }
  })
  server.server.setRequestHandler(SubscribeRequestSchema, (req) => {
    if (req.params.uri === INBOX_URI) {
      subscribed.add(INBOX_URI)
      // Take stock now, so only what arrives from here on is announced.
      const d = findDaemon(joined ? joined.dir : undefined)
      if (d) call(d, 'POST', '/inbox', { after: 0 }).then((r) => { const c = at(pushCursor, d); if (c.fresh || c.seq < r.seq) { c.seq = r.seq; c.fresh = false } }).catch(() => {})
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

  const startAs = async ({ conn, folder, agent, inviteServer, starting = false }) => {
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
    const auth = sessionPasses({ agent: pickAgent({ agent }) })
    let aside = null
    if (!dir || personsFolder(dir)) {
      if (starting) throw new Error(`${dir} already belongs to a session a person started on this computer. Ask them for its invite link and join that, or start from another folder.`)
      aside = dir || cwd
      dir = agentCopyFolder(conn.room, auth.name)
    }
    const tool = clientTool()
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
      onFatal: async (err) => { logs.push(`stopped: ${err.message}`); await leave() }
    })
    joined = { run, dir, invite: run.invite }
    return { dir, invite: run.invite, aside }
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
      agent: z.string().optional().describe('Which Quilt agent to join as (saved with `quilt agent join`). Optional when this computer has only one.')
    }
  }, async ({ folder, agent }) => {
    try {
      const r = await startAs({ conn: newConn(), folder: folder || '.', agent, starting: true })
      return { content: [{ type: 'text', text: await describeSession(r.dir, `Started a session for ${r.dir}. Share the invite link below with collaborators.`) }] }
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
    if (c.open.length) lines.push('Open commit requests:', ...c.open.map((r) => `- ${r.by}: ${r.message}`))
    else lines.push('No open commit requests.')
    lines.push(c.host
      ? 'You host git for this session: when it is ready, commit with quilt_commit (or git yourself).'
      : 'Git lives with the session host. Ask for a commit with quilt_request_commit; the host commits when everyone is idle.')
    return lines.join('\n')
  }

  server.registerTool('quilt_set_work', {
    description: 'Tell everyone whether you (this agent) are working or done, so the host knows when it is safe to commit. Set "working" when you start a task and "done" when you finish: ' +
      '"done" lets go of the files claimed for you while you edited. Like every tool that moves work on, it is refused while someone is waiting for an answer from you.',
    inputSchema: {
      state: z.enum(['working', 'done']),
      note: z.string().optional().describe('What you are working on, in a few words')
    }
  }, ({ state, note }) => withDaemon(async (d) => {
    if (state === 'working') {
      await call(d, 'POST', '/work', { state, note })
      return 'Marked as working. Set "done" when you finish so the host can commit.'
    }
    const { released } = await call(d, 'POST', '/finish', {})
    await call(d, 'POST', '/work', { state, note })
    return `Marked as done.${released ? ` Let go of ${released} file${released === 1 ? '' : 's'} claimed for you while you edited.` : ''}`
  }, { gate: gateFor('quilt_set_work') }))

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

  server.registerTool('quilt_before_edit', {
    description: 'Call before you change files (with your own edit tools), with the paths you are about to change. For each file: whether it is yours to edit ' +
      '(a file nobody holds is claimed for you until you finish; one someone else holds is refused: do not edit it, message them instead), and what people asked ' +
      'about those files that you have not answered. Works in every tool; it is how Quilt keeps agents from overwriting each other.',
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
    const r = rels.length ? await call(d, 'POST', '/before-edit', { paths: rels }) : { files: [], requests: [] }
    const lines = []
    for (const f of r.files) {
      if (!f.shared) lines.push(`- ${f.path}: not shared by Quilt (ignored or private): edit it as you like.`)
      else if (f.ok) lines.push(`- ${f.path}: ✅ yours to edit${f.claimed ? ' (claimed for you until you finish)' : ''}.`)
      else if (f.asked) lines.push(`- ⏸ ${askedRefusal(f.path, f.asked)}`)
      else lines.push(`- ${f.path}: ⛔ ${heldRefusal(f.path, f.claim, f.error)}`)
    }
    for (const p of outside) lines.push(`- ${p}: not inside the project folder (${d.dir}).`)
    const asked = renderRequests(r.requests.filter((q) => !r.files.some((f) => f.asked && f.path === q.path)))
    return lines.join('\n') + (asked ? `\n\n${asked}` : '') + '\n\nRe-read each file right before you edit it.'
  }))

  server.registerTool('quilt_request_commit', {
    description: 'Ask the session host to commit the shared changes, e.g. because you need a commit to test or deploy. The host commits once every AI in the session is idle.',
    inputSchema: { message: z.string().describe('What the commit should say / why you need it') }
  }, ({ message }) => withDaemon(async (d) => {
    await call(d, 'POST', '/commit-request', { message })
    return `Asked for a commit.\n${describeCommits(await call(d, 'GET', '/commits'))}`
  }, { gate: gateFor('quilt_request_commit') }))

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

  server.registerTool('quilt_commit', {
    description: 'Host only: commit every change in the shared folder with git and close the open commit requests. Without a message, the open requests\' messages are used. Check quilt_commit_status first.',
    inputSchema: { message: z.string().optional().describe('Commit message') }
  }, ({ message }) => withDaemon(async (d) => {
    const r = await call(d, 'POST', '/commit', { message })
    return `Committed ${r.files} file${r.files === 1 ? '' : 's'} as ${r.hash}: ${r.subject}`
  }, { gate: gateFor('quilt_commit') }))

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
      if (f.claim) notes.push(`claimed by ${f.claim.by === me ? 'you' : f.claim.by}${f.claim.note ? `: ${f.claim.note}` : ''}`)
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
    if (d && client && client.name) call(d, 'POST', '/agent', { client: client.name }).catch(() => {})
  }

  await server.connect(new StdioServerTransport())
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
