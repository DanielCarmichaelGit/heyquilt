// `quilt hook`: the AI tools' own delivery of Quilt's rules. The rules themselves are
// the same for every agent (duties.js, Session.prepareEdit): every MCP agent gets
// them through quilt_before_edit, its quilt answers and quilt_set_work, and the
// file watcher undoes edits to files someone else holds whatever made them. The
// hooks make them automatic in every tool that runs hooks: Claude Code and Cursor
// (which reads the project's Claude Code hooks) from .claude/settings.local.json,
// Gemini CLI from its user settings (integrations.js). Each speaks its own dialect
// (DIALECTS below); what happens is the same. Before every edit, the file is
// claimed for this person (or the edit is refused when someone else holds it, with
// a nudge to ask them for help) and what was said about it in chat is shown; claims the hooks
// made are released when Claude finishes, once it has answered who wrote to it.
// Direct messages, mentions and tasks handed over are shown as Claude works, and when
// this person lets their AI pick up work by itself, it is handed its next task as it finishes.
//
// Reads the hook event as JSON on stdin and answers on stdout, as Claude Code
// expects. Without a running session it does nothing, so the hooks are harmless
// in a folder that isn't in a Quilt session.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { findDaemon } from './control.js'
import { migrateDir } from './legacy.js'
import { describeEvent } from './inbox.js'
import { renderQueued, renderChatAbout, heldRefusal } from './duties.js'
import { renderNextTask } from './tasks.js'
import { quiltShellCommand } from './integrations.js'

// Tools that change files: Claude Code's, Cursor's (it reads Claude Code's hook settings and
// matches its own tool names against them) and Gemini CLI's.
const CLAUDE_EDITS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const CURSOR_EDITS = ['StrReplace', 'MultiStrReplace', 'ApplyPatch', 'Delete', 'EditNotebook']
const GEMINI_EDITS = ['write_file', 'replace']
const EDIT_TOOLS = new Set([...CLAUDE_EDITS, ...CURSOR_EDITS, ...GEMINI_EDITS, 'apply_patch'])
const TIMEOUT_MS = 5000

/** Settings for .claude/settings.local.json: every hook runs this Quilt's `hook`, by absolute path (no PATH needed). */
export const HOOK_COMMAND = 'quilt hook' // what older versions wrote
export const hookCommand = (dialect = '') => quiltShellCommand(dialect ? ['hook', dialect] : ['hook'])
/** Is this hook entry one of Quilt's (any version, any tool)? */
export const isQuiltHook = (h) => !!h && typeof h.command === 'string' && (h.command.startsWith(HOOK_COMMAND) || /quilt\.js"? hook( \w+)?$/.test(h.command))
export function hookSettings (command = hookCommand()) {
  const run = { type: 'command', command, timeout: 10 }
  const edits = [...CLAUDE_EDITS, ...CURSOR_EDITS].join('|')
  return {
    SessionStart: [{ hooks: [run] }],
    PreToolUse: [{ matcher: edits, hooks: [run] }],
    PostToolUse: [{ matcher: edits, hooks: [run] }],
    Stop: [{ hooks: [run] }],
    SessionEnd: [{ hooks: [run] }]
  }
}

/** Gemini CLI's hooks (its user settings.json): the same events under its names, timeouts in milliseconds. */
export function geminiHookSettings (command = hookCommand('gemini')) {
  const run = { type: 'command', command, timeout: 10000 }
  return {
    SessionStart: [{ hooks: [run] }],
    BeforeTool: [{ matcher: GEMINI_EDITS.join('|'), hooks: [run] }],
    AfterTool: [{ matcher: GEMINI_EDITS.join('|'), hooks: [run] }],
    AfterAgent: [{ hooks: [run] }],
    SessionEnd: [{ hooks: [run] }]
  }
}

// ------------------------------------------------------------ dialects --
// Each tool names its events and wants its answers in its own shape. Events are mapped to one of
// start | preEdit | postEdit | stop | end, and answers are made by the dialect's say* functions.

const claudeLike = (eventName) => ({
  context: (ctx) => ({ hookSpecificOutput: { hookEventName: eventName, additionalContext: ctx } }),
  block: (reason) => ({ decision: 'block', reason })
})

export const DIALECTS = {
  claude: {
    events: { SessionStart: 'start', PreToolUse: 'preEdit', PostToolUse: 'postEdit', Stop: 'stop', SessionEnd: 'end' },
    context: (name, ctx) => claudeLike(name).context(ctx),
    deny: (name, reason) => ({ hookSpecificOutput: { hookEventName: name, permissionDecision: 'deny', permissionDecisionReason: reason } }),
    block: (name, reason) => claudeLike(name).block(reason),
    none: () => null
  },
  // Cursor runs the project's Claude Code hooks, and its own, with its own event names and answers.
  cursor: {
    events: { sessionStart: 'start', preToolUse: 'preEdit', postToolUse: 'postEdit', stop: 'stop', sessionEnd: 'end' },
    context: (name, ctx) => ({ additional_context: ctx }),
    deny: (name, reason) => ({ permission: 'deny', user_message: reason, agent_message: reason }),
    block: (name, reason) => ({ followup_message: reason }),
    // Cursor takes no answer for an allowed step as an invalid one, so it always gets an object.
    none: () => ({})
  },
  gemini: {
    events: { SessionStart: 'start', BeforeTool: 'preEdit', AfterTool: 'postEdit', AfterAgent: 'stop', SessionEnd: 'end' },
    context: (name, ctx) => claudeLike(name).context(ctx),
    deny: (name, reason) => ({ decision: 'deny', reason }),
    block: (name, reason) => ({ decision: 'block', reason }),
    none: () => null
  }
}

/** Which tool sent this event: the one named on the command line, else what the event looks like. */
export function dialectOf (event, named = '') {
  if (DIALECTS[named]) return named
  if (event && (event.cursor_version || DIALECTS.cursor.events[event.hook_event_name])) return 'cursor'
  if (event && ['BeforeTool', 'AfterTool', 'AfterAgent'].includes(event.hook_event_name)) return 'gemini'
  return 'claude'
}

/** The project files an edit tool is about to change: its path fields, or the files a patch names. */
export function editedFiles (input) {
  if (!input) return []
  if (typeof input === 'string') return patchFiles(input)
  const out = []
  for (const k of ['file_path', 'path', 'target_file', 'notebook_path', 'filePath', 'absolute_path']) {
    if (typeof input[k] === 'string' && input[k]) out.push(input[k])
  }
  for (const v of Object.values(input)) if (typeof v === 'string') out.push(...patchFiles(v))
  return [...new Set(out)]
}
const patchFiles = (text) => [...String(text).matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+?)\s*$/gm)].map((m) => m[1])

/**
 * Handles one hook event. Returns { output?, exitCode } where `output` is the
 * JSON object to print. `daemon` and `call` can be injected for tests.
 */
export async function handleHook (event, { findDaemon: find = findDaemon, call = callWithTimeout, dialect: named = '', pids = null } = {}) {
  const say = DIALECTS[dialectOf(event, named)]
  const name = event.hook_event_name
  const answer = (r) => (r.output || r.exitCode) ? r : { exitCode: 0, ...(say.none() ? { output: say.none() } : {}) }
  const cwd = event.cwd || (Array.isArray(event.workspace_roots) && event.workspace_roots[0]) || process.cwd()
  const d = find(cwd)
  if (!d) return answer({ exitCode: 0 })
  // Which AI session this is: the one whose tool process (the parent of its `quilt mcp`) is
  // among this hook's parents. Its claims, inbox and duties are its own (persona.js).
  const mine = pids || parentPids()
  const api = (method, route, body) => method === 'GET'
    ? call(d, method, `${route}${route.includes('?') ? '&' : '?'}pids=${mine.join(',')}`)
    : call(d, method, route, { ...(body || {}), pids: mine })
  const state = hookState(d.dir, event.session_id || event.conversation_id)
  const ev = { ...event, cwd }
  switch (say.events[name]) {
    case 'start': return answer(await sessionStart(api, state, say, name))
    case 'preEdit': return answer(await preEdit(ev, d, api, state, say, name))
    case 'postEdit': return answer(await postEdit(api, state, say, name))
    case 'stop': return answer(await stop(ev, api, state, say, name))
    case 'end': return answer(await sessionEnd(api, state))
    default: return answer({ exitCode: 0 })
  }
}

async function sessionStart (api, state, say, name) {
  const st = await api('GET', '/status')
  // Only what arrives from now on is for this Claude; what came before is for quilt_inbox.
  const { seq } = await api('POST', '/inbox', { after: 0 }).catch(() => ({ seq: 0 }))
  state.update((s) => { s.after = seq || 0 })
  const who = st.peers.length ? st.peers.map((p) => p.name + (p.kind === 'agent' ? ' (AI agent)' : '')).join(', ') : 'nobody else yet'
  const parts = [
    `This folder is in a live Quilt session (room ${st.room}) with ${who}. Files can change underneath you at any time; re-read a file right before editing it.`,
    'Quilt claims each file for you the moment you edit it, and releases those claims when you finish. ' +
    'If a file is claimed by someone else, your edit is refused: do not retry or work around it. ' +
    'Ask for it in its file queue with quilt_request_file (a title like "Working on <what> for <task>" and up to 300 characters on your plan), then carry on with other work: you are told when it is handed to you, with their context. ' +
    'When someone asks for a file you hold, finish your change, then hand it off with quilt_handoff and your context; you cannot finish before you do.',
    'Messages from collaborators, mentions of you and tasks handed to you are shown to you as you work; answer with quilt_message and take a task with quilt_move_task.',
    'You are a member of your own in the session, apart from your person and their other AI sessions, named after your work (your git branch, or the first thing you say you are doing); rename yourself with quilt_name_session.'
  ]
  const duties = await api('GET', '/duties').catch(() => ({}))
  if (duties.pickup && duties.pickup !== 'off') parts.push(`This person lets you pick up work from the task board by yourself (${duties.pickup === 'any' ? 'tasks assigned to you, then unassigned ones' : 'tasks assigned to you'}): when you finish, you are handed the next one.`)
  const merges = mergesContext(st.merges)
  if (merges) parts.push(merges)
  return { exitCode: 0, output: say.context(name, parts.join('\n')) }
}

/** One short paragraph naming the files still open for merging, or null when there are none. */
function mergesContext (merges) {
  const open = (merges || []).filter((m) => m.state !== 'done')
  if (!open.length) return null
  const describe = (m) => {
    const action = m.oursDeleted ? 'deleted it offline' : 'changed it offline'
    const other = (m.others && m.others[0]) || m.claimedBy
    return `\`${m.path}\` (${m.by} ${action}${other ? `, ${other} in the session` : ''})`
  }
  const shown = open.slice(0, 5).map(describe).join(', ')
  const more = open.length > 5 ? `, and ${open.length - 5} more` : ''
  return `${open.length} file(s) need merging: ${shown}${more}. Run quilt_merges before editing those files; settle one with quilt_resolve_merge.`
}

async function preEdit (event, d, api, state, say, name) {
  if (!EDIT_TOOLS.has(event.tool_name)) return { exitCode: 0 }
  const rels = editedFiles(event.tool_input)
    .map((file) => path.relative(d.dir, path.resolve(event.cwd || d.dir, String(file))).split(path.sep).join('/'))
    .filter((rel) => rel && !rel.startsWith('..') && !path.isAbsolute(rel)) // not in the project
  if (!rels.length) return { exitCode: 0 }
  // The same check quilt_before_edit makes for every other agent.
  const r = await api('POST', '/before-edit', { paths: rels })
  const files = (r.files || []).filter((f) => f && f.shared) // Quilt doesn't sync the rest, so nobody can clash on them
  const refused = files.find((f) => !f.ok)
  if (refused) return { exitCode: 0, output: say.deny(name, heldRefusal(refused.path, refused.claim, refused.error)) }
  if (!files.length) return { exitCode: 0 }
  const seen = new Set(state.read().seen)
  // What people said about these files in chat, shown once per message per AI session.
  const said = (r.chat || []).filter((q) => q.id && !seen.has(`ask:${q.id}`))
  state.update((s) => {
    for (const f of files) if (f.claimed && !s.claims.includes(f.path)) s.claims.push(f.path)
    for (const q of said) s.seen.push(`ask:${q.id}`)
  })
  if (!said.length) return { exitCode: 0 }
  return { exitCode: 0, output: say.context(name, renderChatAbout(said)) }
}

async function postEdit (api, state, say, name) {
  const events = await unseenEvents(api, state)
  if (!events.length) return { exitCode: 0 }
  state.update((s) => { for (const e of events) s.seen.push(e.id) })
  return { exitCode: 0, output: say.context(name, renderAsks(events)) }
}

async function stop (event, api, state, say, name) {
  // Claude Code and Gemini say when this stop follows one we held back; a hold is once per item anyway.
  if (!event.stop_hook_active) {
    // What Claude hasn't been shown, and anyone it still owes an answer (the rule quilt_set_work applies to every agent).
    const events = await unseenEvents(api, state)
    // Each unanswered one holds Claude back once, so a message meant for the person doesn't stop every turn.
    const asked = new Set(state.read().seen)
    const owed = (await owedAnswers(api).catch(() => [])).filter((e) => !asked.has(`owed:${e.id}`))
    for (const e of owed) if (!events.some((x) => x.id === e.id)) events.push(e)
    if (events.length) {
      state.update((s) => { for (const e of events) s.seen.push(e.id); for (const e of owed) s.seen.push(`owed:${e.id}`) })
      return { exitCode: 0, output: say.block(name, `${renderAsks(events)}\nBefore you finish, reply with quilt_message to what asks something of you (settle what needs nothing back with quilt_inbox no_reply), and take or decline a task you were handed (and release files you no longer need with quilt_release), then finish.`) }
    }
    // Files someone waits for in the file queue: the AI hands them off with its context before it stops (once per request).
    const duties = await api('GET', '/duties').catch(() => ({}))
    const queued = duties.queued || []
    const fresh = queued.flatMap((q) => q.queue).filter((r) => !asked.has(`queue:${r.id}`))
    if (fresh.length) {
      state.update((s) => { for (const r of fresh) s.seen.push(`queue:${r.id}`) })
      return { exitCode: 0, output: say.block(name, renderQueued(queued, 'finish')) }
    }
    // This person lets their AI pick up work by itself: its next task, once per task.
    if (duties.next && !asked.has(`next:${duties.next.id}`)) {
      await releaseAll(api, state) // the files of the work just finished are free again
      state.update((s) => { s.seen.push(`next:${duties.next.id}`) })
      return { exitCode: 0, output: say.block(name, renderNextTask(duties.next)) }
    }
  }
  await releaseAll(api, state)
  await api('POST', '/finish', {}).catch(() => {})
  return { exitCode: 0 }
}

/** Who is still waiting for an answer from this person or their AI (the rule every MCP agent is held to). */
async function owedAnswers (api) {
  return (await api('GET', '/duties')).waiting || []
}

async function sessionEnd (api, state) {
  await releaseAll(api, state)
  state.remove()
  return { exitCode: 0 }
}

/**
 * Inbox events (direct messages, mentions, tasks handed over) since this Claude session
 * started that it hasn't been shown yet. The person's own unread state is untouched.
 */
async function unseenEvents (api, state) {
  const s = state.read()
  const { events } = await api('POST', '/inbox', { after: s.after || 0 })
  const seen = new Set(s.seen)
  return events.filter((e) => e && e.id && !seen.has(e.id))
}

function renderAsks (events) {
  const lines = events.map((e) => `- ${describeEvent(e)}`)
  return `Quilt: collaborators wrote to you, or handed you work, while you were working:\n${lines.join('\n')}\n` +
    'Someone asking for a file you hold in its file queue gets it from you with quilt_handoff and your context once your change is done; answer other messages that ask something of you with quilt_message (to: their name); one that needs nothing back (thanks, a greeting, an FYI) gets no reply, settle it with quilt_inbox (no_reply: [its id]). ' +
    'Take a task you were handed with quilt_move_task when you are free, or say in chat why not.'
}

/** Releases every claim the hooks made for this Claude session. */
async function releaseAll (api, state) {
  const s = state.read()
  for (const pattern of s.claims) await api('POST', '/release', { pattern }).catch(() => {})
  state.update((x) => { x.claims = [] })
}

/** This process's parents, nearest first (a few levels), for finding its AI session. */
export function parentPids (start = process.ppid, depth = 6) {
  const out = []
  let pid = start
  for (let i = 0; i < depth && pid > 1; i++) {
    out.push(pid)
    if (process.platform === 'win32') break
    try { pid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 }).toString().trim()) } catch { break }
  }
  return out
}

/** Per-Claude-session state in .quilt/hooks/<session>.json: the claims it made and the messages it has seen. */
export function hookState (projectDir, sessionId) {
  const dir = path.join(migrateDir(projectDir), 'hooks')
  const file = path.join(dir, `${String(sessionId || 'default').replace(/[^\w.-]/g, '_')}.json`)
  const read = () => {
    try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return { claims: s.claims || [], seen: s.seen || [], after: s.after || 0 } } catch { return { claims: [], seen: [], after: 0 } }
  }
  return {
    file,
    read,
    update (fn) {
      const s = read()
      fn(s)
      if (s.seen.length > 500) s.seen = s.seen.slice(-500)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(s))
    },
    remove () { try { fs.rmSync(file) } catch {} }
  }
}

/**
 * Releases claims left behind by hooks of Claude sessions that ended without
 * telling us (a crash, a closed laptop). Run when a session starts for the folder.
 */
export async function releaseLeftoverHookClaims (session) {
  const dir = path.join(session.stateDir, 'hooks')
  let names = []
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')) } catch { return 0 }
  let released = 0
  for (const n of names) {
    const st = hookState(session.root, n.slice(0, -5))
    for (const pattern of st.read().claims) {
      try { released += await session.release(pattern) } catch {}
    }
    st.remove()
  }
  return released
}

async function callWithTimeout (daemon, method, route, body) {
  const res = await fetch(`http://127.0.0.1:${daemon.port}${route}`, {
    method,
    headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
  return json
}

/** The CLI entry: stdin JSON in, JSON (if any) out. Never fails loudly: a broken hook must not block someone's editor. */
export async function runHook ({ stdin = process.stdin, stdout = process.stdout, dialect = process.argv[3] || '' } = {}) {
  let raw = ''
  for await (const chunk of stdin) raw += chunk
  let event
  try { event = JSON.parse(raw) } catch { return 0 }
  try {
    const r = await handleHook(event, { dialect })
    if (r.output) stdout.write(JSON.stringify(r.output) + '\n')
    return r.exitCode
  } catch (err) {
    process.stderr.write(`quilt hook: ${err.message}\n`)
    return 0
  }
}
