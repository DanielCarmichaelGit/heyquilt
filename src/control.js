// Local control API (127.0.0.1 only) so the CLI and the MCP server can talk to
// a running session. Discovery info is written to .quilt/daemon.json.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { renderStatus } from './status.js'
import { migrateDir } from './legacy.js'

export async function startControl (session, extras = {}) {
  const token = crypto.randomBytes(16).toString('hex')
  const routes = {
    'GET /status': (b) => {
      // To one of the AI sessions working through this app, "you" is that session (persona.js).
      const st = session.status()
      const p = session.persona(b.via)
      if (p) st.me = { ...st.me, name: p.name, tool: p.tool || st.me.tool, kind: 'agent', persona: true, of: session.name, focus: p.focus || '' }
      return { ...st, markdown: renderStatus(st) }
    },
    // An AI session (one `quilt mcp`) says hello: { via, tool, cwd, ppid } -> { name, named }.
    'POST /persona': (b) => session.registerPersona({ via: b.via, tool: b.tool, cwd: b.cwd, ppid: b.ppid, pids: b.mcpPids }),
    // It names itself after its work: { via, name } -> { name }.
    'POST /persona/name': (b) => session.renamePersona(b.via, b.name, 'self'),
    // The CLI and the MCP server: what an AI sends, held to the chat rules (duties.js). A person typing in `quilt join` sends with everyone.
    'POST /say': (b) => session.say(b.text, { to: b.to, agent: true, via: b.via ? String(b.via) : null, everyone: !!b.everyone, also: !!b.also }),
    'POST /inbox/settle': (b) => session.settle(b.ids),
    'POST /send': (b) => session.sendFile(b.path, { to: b.to, text: b.text }),
    'POST /messages': (b) => ({ messages: session.messages({ limit: b.limit || 50, unreadOnly: !!b.unreadOnly, markRead: b.markRead !== false, withName: b.with || null }) }),
    'POST /get': async (b) => ({ path: await session.fetchFile(b.id, b.dest) }),
    'POST /focus': (b) => {
      // An AI session's focus is its own (and names it, if it has no name yet); a person's is theirs.
      if (session.persona(b.via)) session.personaSays(b.via, b.text)
      else session.setFocus(b.text)
      return { ok: true }
    },
    'POST /claim': (b) => session.claim(b.pattern, b.note, b.via),
    // What this person's AI should hear (an edit of its that Quilt undone); handed over once.
    'POST /notices': () => ({ notices: session.takeNotices() }),
    'POST /release': async (b) => ({ released: await session.release(b.pattern, b.via) }),
    // The file queue: ask for a file someone holds, hand one we hold to someone waiting, take a request back.
    'POST /request-file': (b) => session.requestFile(b.path, { title: b.title, description: b.description, task: b.task, via: b.via }),
    'POST /handoff': (b) => session.handoff(b.path, { to: b.to, context: b.context, via: b.via }),
    'POST /withdraw-request': async (b) => ({ withdrawn: await session.withdrawRequest(b.request, b.via) }),
    // Who owns one path (the hooks ask before every edit). `shared` is false for paths Quilt doesn't sync.
    'POST /claim-for': (b) => {
      const rel = String(b.path || '').replace(/\\/g, '/').replace(/^\.\//, '')
      const shared = session.syncable(rel)
      const c = shared ? session.claimFor(rel) : null
      const me = session.actorName(b.via)
      return { path: rel, shared, claim: c ? { by: c.by, pattern: c.pattern, note: c.note, queue: c.queue || [] } : null, mine: !!c && c.by === me, me, focus: session.focus || '' }
    },
    // Before an agent changes files (any tool): is each one ours to edit (free ones are claimed for
    // us), and what did people ask about them? See Session.prepareEdit and duties.js.
    'POST /before-edit': (b) => session.prepareEdit(Array.isArray(b.paths) ? b.paths.slice(0, 100) : [], b.via),
    // An agent finished a piece of work: let go of the claims that followed its edits.
    'POST /finish': (b) => session.finishEditing(b.via),
    // Who is waiting for an answer from this member (or AI session): the MCP and the hooks refuse to move work on until there's none.
    'GET /duties': (b) => session.duties(b.via),
    // What an MCP agent shares about its work (quilt_share): the feed, tasks and "working", for any tool.
    'POST /share-work': (b) => {
      session.personaSays(b.via, b.request)
      return session.shareAgentWork({ tool: b.tool, request: b.request, summary: b.summary, files: Array.isArray(b.files) ? b.files : [] })
    },
    // Owner only: a link a chat-only AI works through (chat-links.js). { name, hours } -> { url, name, expiresAt }
    'POST /chat-link': (b) => session.createChatLink({ name: b.name, minutes: b.minutes }),
    // Owner only: how long a chat link still works. { who: name or key, minutes } -> { name, expiresAt }
    'POST /chat-link/extend': (b) => session.extendChatLink(String(b.who || ''), b.minutes),
    'POST /agent': (b) => { session.addAgent(b.client); return { ok: true } },
    'POST /feed': (b) => ({ entries: session.agentFeedFor(b.who, { limit: Math.min(Number(b.limit) || 40, 300) }) }),
    // The chronology: { path, by, since, task, limit } (see Session.historyQuery).
    'POST /history': (b) => ({ entries: session.historyQuery(b) }),
    'GET /tree': () => session.tree(),
    'POST /sharing': (b) => ({ on: session.setAgentSharing(b.on !== false) }),
    'GET /commits': () => session.commitStatus({ includeMe: false }),
    'GET /branches': () => ({ branches: session.status().branches, git: session.status().git }),
    'POST /branches/sync': () => session.syncBranchNow(),
    'POST /commit-request': (b) => session.requestCommit(b.message),
    'POST /commit-request/done': (b) => ({ done: session.resolveCommitRequests({ ids: b.id ? [String(b.id)] : null }) }),
    'POST /work': (b) => {
      if (b.state === 'working') session.personaSays(b.via, b.note)
      return { work: session.setWork(b.state, b.note) }
    },
    'GET /tasks': () => ({ tasks: session.taskList() }),
    // Mentions, direct messages and tasks handed to this member since sequence number `after` (agents wake on these).
    'POST /inbox': (b) => session.inbox({ after: b.after, all: !!b.all, via: b.via }),
    // The agent's webhook: inbox events POSTed to a URL of its own (see webhooks.js).
    'GET /webhook': () => ({ webhook: session.webhookInfo() }),
    'POST /webhook': (b) => ({ webhook: session.setWebhook({ url: b.url, secret: b.secret, events: b.events, bearer: b.bearer }) }),
    'POST /webhook/clear': () => ({ had: session.clearWebhook() }),
    'POST /tasks': (b) => ({ task: session.addTask(b), tasks: session.taskList() }),
    'POST /tasks/update': (b) => {
      const task = session.updateTask(b)
      if (b.column === 'doing' && task) session.personaSays(b.via, task.title) // taking a task can name an AI session
      return { task, tasks: session.taskList() }
    },
    // What an agent gets when it picks a task up: history for its files, claims, the project's checks.
    'POST /tasks/brief': (b) => session.taskBrief(b.id),
    'POST /tasks/comment': (b) => session.commentTask(b),
    'POST /tasks/delete': (b) => { session.deleteTask(b.id); return { tasks: session.taskList() } },
    'GET /merges': () => {
      const merges = session.mergeList()
      // Agents are told the other version is under .quilt/merges/<id>/, so put
      // it there on this machine too (base and ours are written once). A local
      // record's versions are only on the opener's machine; skip any that fail.
      for (const m of merges) {
        if (m.state !== 'open' || m.local) continue
        try { session.prepareMergeSend(m.id) } catch {}
      }
      return { merges }
    },
    'POST /merges/resolve': (b) => session.resolveMerge(String(b.id || ''), { how: b.how }),
    'POST /merges/send': (b) => session.prepareMergeSend(String(b.id || '')),
    'GET /info': (b) => ({ room: session.room, dir: session.root, name: session.actorName(b.via), person: session.name, kind: session.kind, invite: extras.invite || null, viewInvite: extras.viewInvite || null, access: session.access, pid: process.pid })
  }
  const server = http.createServer(async (req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'unauthorized' })
    if (req.method === 'GET' && req.url === '/events') return streamEvents(session, req, res)
    const route = routes[`${req.method} ${req.url.split('?')[0]}`]
    if (!route) return reply(404, { error: 'not found' })
    let raw = ''
    for await (const chunk of req) raw += chunk
    try {
      const b = raw ? JSON.parse(raw) : {}
      // Which AI session is asking (persona.js): `via` from its MCP server, or `pids` from a hook
      // (the session whose tool process is among the hook's parents). GETs carry it in the query.
      const q = new URL(req.url, 'http://x').searchParams
      if (!b.via && q.get('via')) b.via = q.get('via')
      if (!b.pids && q.get('pids')) b.pids = q.get('pids').split(',')
      if (!b.via && b.pids) b.via = session.personaFor(b.pids)
      if (b.via) session.touchPersona(b.via)
      reply(200, await route(b))
    } catch (err) {
      reply(400, { error: err.message })
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const file = path.join(session.stateDir, 'daemon.json')
  fs.writeFileSync(file, JSON.stringify({ port: server.address().port, token, pid: process.pid }), { mode: 0o600 })
  return {
    close: () => {
      try { fs.rmSync(file) } catch {}
      return new Promise((r) => server.close(r))
    }
  }
}

// Server-sent events: pushes each new message as it arrives (used by `quilt chat`).
function streamEvents (session, req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  res.write(': connected\n\n')
  const onMessage = (msg) => {
    res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`)
    if (msg.by !== session.name) session.markRead([msg.id])
  }
  const onLog = (line) => res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`)
  const ping = setInterval(() => res.write(': ping\n\n'), 15000)
  session.on('message', onMessage)
  session.on('log', onLog)
  req.on('close', () => {
    clearInterval(ping)
    session.off('message', onMessage)
    session.off('log', onLog)
  })
}

/** Finds the nearest folder (from `start` upward) with a running session. */
export function findDaemon (start = process.env.QUILT_DIR || process.cwd()) {
  let dir = path.resolve(start)
  while (true) {
    const file = path.join(migrateDir(dir), 'daemon.json')
    if (fs.existsSync(file)) {
      const info = JSON.parse(fs.readFileSync(file, 'utf8'))
      try { process.kill(info.pid, 0) } catch { return null } // stale
      return { ...info, dir }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export async function call (daemon, method, route, body) {
  const res = await fetch(`http://127.0.0.1:${daemon.port}${route}`, {
    method,
    headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
  return json
}
