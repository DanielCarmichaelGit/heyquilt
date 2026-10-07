// The workspace library as MCP tools for agents: list workspaces and their files, read and
// write files, move and delete them, and the agent's webhook for workspace events. Shared by
// the local MCP (`quilt mcp`, which can also read and save files on this computer) and the
// hosted MCP on the relay. Each host passes how to reach the API:
//   call(method, path, body) -> parsed JSON, or throws an Error with .status and the API's message
//   fetchBytes(url, maxBytes) -> Buffer, refusing a body over maxBytes (bytesFetcher makes one)
//   put(url, bytes, headers) -> HTTP status
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { cleanFilePath, isTextual } from './api/file-paths.js'

/** One paragraph for the MCP instructions, added only where these tools are offered. */
export const WORKSPACE_GUIDE =
  'Files that are not code (images, video, documents, data) live in the workspace library: read them with ' +
  'quilt_workspace_read_file and put what you make there with quilt_workspace_write_file and a short note, not in chat. ' +
  'Subscribe with quilt_workspace_webhook to be told when a session starts in your workspace; join it with the link the event carries, ' +
  'and wait: the session\'s owner lets you in.'

// The API's own limit on one file; fromPath may send up to this.
const MAX_FROM_PATH = 500 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** Whether `target` is strictly inside `root` (both absolute). A name like "..notes" is inside. */
export function isInside (root, target) {
  const rel = path.relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
}

/**
 * A fetchBytes for registerWorkspaceTools: GETs `url` and answers its bytes, giving up (and
 * dropping the connection) as soon as the body is larger than `maxBytes`, so a link never
 * makes the host hold more than the tool asked for.
 */
export function bytesFetcher (fetchImpl = globalThis.fetch, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return async (url, maxBytes = Infinity) => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('the download took too long')), timeoutMs)
    timer.unref?.()
    const tooBig = () => new Error(`the download is larger than expected (over ${formatBytes(maxBytes)})`)
    try {
      const res = await fetchImpl(url, { signal: ac.signal })
      if (!res.ok) { ac.abort(); throw new Error(`the download failed (${res.status})`) }
      if (Number(res.headers.get('content-length')) > maxBytes) { ac.abort(); throw tooBig() }
      if (!res.body) return Buffer.alloc(0)
      const chunks = []
      let n = 0
      for await (const chunk of res.body) {
        n += chunk.length
        if (n > maxBytes) { ac.abort(); throw tooBig() }
        chunks.push(chunk)
      }
      return Buffer.concat(chunks.map((c) => Buffer.from(c)))
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Whether `p` matches `glob`: `*` is any run of characters inside one folder, `**` crosses folders. */
export function globMatch (glob, p) {
  let re = ''
  const g = String(glob)
  for (let i = 0; i < g.length; i++) {
    if (g.startsWith('**/', i)) { re += '(?:.*/)?'; i += 2 } else if (g.startsWith('**', i)) { re += '.*'; i += 1 } else if (g[i] === '*') re += '[^/]*'
    else re += g[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`).test(p)
}

export function formatBytes (n) {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024; let u = 0
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++ }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`
}

function ago (ms, now = Date.now()) {
  if (!ms) return ''
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const ws$ = (id) => `/v1/workspaces/${encodeURIComponent(id)}`
const file$ = (wsId, fileId) => `${ws$(wsId)}/files/${encodeURIComponent(fileId)}`

/**
 * Registers the library tools on an MCP server. `saveDir` (local only) is where binary or
 * large reads are saved; `readLocal(path) -> Buffer` (local only) lets writes take a file
 * from this computer (fromPath). `maxInline` caps text read back in an answer and text or
 * base64 sent in a call. `guide` (local MCP) puts WORKSPACE_GUIDE in quilt_workspaces' description
 * and answer, since the local MCP adds these tools after its instructions are sent.
 */
export function registerWorkspaceTools (server, { call, fetchBytes, put, saveDir = null, maxInline = 2 * 1024 * 1024, readLocal = null, guide = false }) {
  const answer = (text) => ({ content: [{ type: 'text', text }] })
  const tool = (fn) => async (args = {}) => {
    try {
      return answer(await fn(args))
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
    }
  }

  /** The workspace the agent means, by id or by name (any case): { id, name, ... }. */
  async function workspaceOf (ref) {
    const want = String(ref ?? '').trim()
    if (!want) throw new Error('Say which workspace (its name or id). quilt_workspaces lists yours.')
    const { workspaces } = await call('GET', '/v1/me/workspaces')
    const byId = workspaces.find((w) => w.id === want)
    if (byId) return byId
    const named = workspaces.filter((w) => w.name.toLowerCase() === want.toLowerCase())
    if (named.length === 1) return named[0]
    if (named.length > 1) throw new Error(`Several workspaces are called ${want}: ${named.map((w) => w.id).join(', ')}. Use the id.`)
    // An id it isn't listed under: the API has the last word (and says not found).
    if (UUID.test(want)) return { id: want, name: want }
    throw new Error(`No workspace called ${want}. quilt_workspaces lists the ones you can reach.`)
  }

  /** The library row at `p` (a file or a folder). */
  async function entryAt (ws, p) {
    const want = cleanFilePath(p)
    const { files } = await call('GET', `${ws$(ws.id)}/files`)
    const f = files.find((x) => x.path === want)
    if (!f) throw new Error(`No file at ${want} in ${ws.name}. quilt_workspace_files lists what is there.`)
    return f
  }

  /** account -> name, for who uploaded what. Best effort: an empty map if the API says no. */
  async function namesIn (ws) {
    const names = new Map()
    try {
      const d = await call('GET', ws$(ws.id))
      for (const m of d.members || []) if (m.name) names.set(m.account, m.name)
      for (const a of d.agents || []) if (a.name) names.set(a.account, a.name)
      if (d.owner?.account && d.owner.name) names.set(d.owner.account, d.owner.name)
    } catch {}
    return names
  }

  /** Where a read is saved on this computer: inside saveDir/<workspace id>, never outside it. */
  function savePath (ws, p) {
    const root = path.resolve(saveDir, ws.id)
    const file = path.resolve(root, p)
    if (!isInside(root, file)) throw new Error('that path cannot be saved here')
    return file
  }

  // With `guide`, the guide comes with quilt_workspaces (its description and the top of its
  // answer), for a host whose instructions went out before these tools were added.
  const lead = guide ? `${WORKSPACE_GUIDE}\n\n` : ''
  server.registerTool('quilt_workspaces', {
    description: 'List the Quilt workspaces you can reach: name, id, your access (edit or view), open sessions, files and storage used. Workspace tools take a workspace by name or id.' + (guide ? ` ${WORKSPACE_GUIDE}` : ''),
    inputSchema: {}
  }, tool(async () => lead + await listWorkspaces()))

  async function listWorkspaces () {
    const { workspaces } = await call('GET', '/v1/me/workspaces')
    if (!workspaces.length) return 'You are not in any workspace yet. A person adds you to one in the Quilt app or on heyquilt.com.'
    const usage = await Promise.all(workspaces.map((w) => call('GET', ws$(w.id)).then((d) => d.usage || null, () => null)))
    return workspaces.map((w, i) => {
      const c = w.counts || {}
      const u = usage[i]
      const parts = [`${w.access} access`, `${plural(c.open ?? 0, 'open session')}`, plural(c.files ?? u?.fileCount ?? 0, 'file')]
      if (u) parts.push(`${formatBytes(u.usedBytes)} of ${formatBytes(u.quotaBytes)} used`)
      if (w.archivedAt) parts.push('archived')
      return `- ${w.name} (id ${w.id}): ${parts.join(', ')}`
    }).join('\n')
  }

  server.registerTool('quilt_workspace_files', {
    description: 'List the files in a workspace library: path, kind, size, version, who uploaded it and when, and its note. Narrow with folder (just that folder) or glob (like "**/*.png"; * stays in a folder, ** crosses folders).',
    inputSchema: {
      workspace: z.string().describe('The workspace name or id'),
      folder: z.string().optional().describe('Only this folder, like "cuts" ("" for the top level)'),
      glob: z.string().optional().describe('Only paths matching this, like "cuts/*.mp4" or "**/*.md"')
    }
  }, tool(async ({ workspace, folder, glob }) => {
    const ws = await workspaceOf(workspace)
    const q = folder !== undefined ? `?folder=${encodeURIComponent(folder)}` : ''
    const [{ files }, names] = await Promise.all([call('GET', `${ws$(ws.id)}/files${q}`), namesIn(ws)])
    const shown = glob ? files.filter((f) => globMatch(glob, f.path)) : files
    if (!shown.length) return files.length ? `Nothing in ${ws.name} matches ${glob}.` : `No files in ${ws.name}${folder ? ` under ${folder}` : ''} yet.`
    const now = Date.now()
    return shown.map((f) => {
      if (f.kind === 'folder') return `${f.path}/  folder`
      const by = names.get(f.uploadedBy) || f.uploadedBy || ''
      const bits = [formatBytes(f.size || 0), `v${f.version}`, by && `by ${by}`, ago(f.uploadedAt, now)].filter(Boolean)
      return `${f.path}  ${bits.join(', ')}${f.note ? `  "${f.note}"` : ''}`
    }).join('\n')
  }))

  server.registerTool('quilt_workspace_read_file', {
    description: `Read a file from a workspace library. Text up to ${formatBytes(maxInline)} comes back in the answer; anything else comes back as a download link${saveDir ? ' and is saved on this computer (the answer says where, as savedTo)' : ''}. Give version for an earlier version.`,
    inputSchema: {
      workspace: z.string().describe('The workspace name or id'),
      path: z.string().describe('The file\'s path in the library, like "cuts/teaser.mp4"'),
      version: z.number().int().positive().optional().describe('An earlier version number (default: the current one)')
    }
  }, tool(async ({ workspace, path: p, version }) => {
    const ws = await workspaceOf(workspace)
    const f = await entryAt(ws, p)
    if (f.kind !== 'file') throw new Error(`${f.path} is a folder. quilt_workspace_files with folder lists what is in it.`)
    const dl = await call('GET', `${file$(ws.id, f.id)}/download${version ? `?version=${version}` : ''}`)
    const v = version || f.version
    if (isTextual(dl.mime) && dl.size <= maxInline) {
      const bytes = await fetchBytes(dl.url, maxInline)
      return `${f.path} (version ${v}, ${formatBytes(bytes.length)}):\n\n${bytes.toString('utf8')}`
    }
    const lines = [`${f.path} (version ${v}) is ${dl.mime || 'a file'}, ${formatBytes(dl.size)}.`, `Download link (expires ${new Date(dl.expiresAt).toISOString()}): ${dl.url}`]
    if (saveDir) {
      try {
        const file = savePath(ws, f.path)
        const bytes = await fetchBytes(dl.url, Number.isFinite(dl.size) ? dl.size : MAX_FROM_PATH)
        await fs.promises.mkdir(path.dirname(file), { recursive: true })
        await fs.promises.writeFile(file, bytes)
        lines.push(`savedTo: ${file}`)
      } catch (err) {
        lines.push(`Could not save a copy on this computer: ${err.message}`)
      }
    }
    return lines.join('\n')
  }))

  const sources = readLocal ? 'text, base64 or fromPath' : 'text or base64'
  const writeSchema = {
    workspace: z.string().describe('The workspace name or id'),
    path: z.string().describe('Where it goes in the library, like "drafts/brief.md". Missing folders are made; an existing file gets a new version.'),
    text: z.string().optional().describe(`The file's contents as text (up to ${formatBytes(maxInline)})`),
    base64: z.string().optional().describe(`The file's bytes as base64 (up to ${formatBytes(maxInline)})`),
    ...(readLocal ? { fromPath: z.string().optional().describe(`A file in this project folder (or the temp folder) to upload, up to ${formatBytes(MAX_FROM_PATH)}`) } : {}),
    note: z.string().optional().describe('A short note on what this is or what changed (under 300 characters)')
  }
  server.registerTool('quilt_workspace_write_file', {
    description: `Put a file in a workspace library, from exactly one of ${sources}. Writing to an existing path adds a new version. Add a short note saying what it is. Needs edit access.`,
    inputSchema: writeSchema
  }, tool(async ({ workspace, path: p, text, base64, fromPath, note }) => {
    const given = [text, base64, fromPath].filter((v) => v !== undefined && v !== null)
    if (given.length !== 1) throw new Error(`Give exactly one of ${sources}.`)
    if (fromPath !== undefined && !readLocal) throw new Error('fromPath works only with the Quilt MCP on your own computer. Send text or base64.')
    const tooBig = (n) => new Error(`That is too large to send in a call (${formatBytes(n)}; at most ${formatBytes(maxInline)}).${readLocal ? ' Save it to a file and use fromPath.' : ' A person can upload it in the Quilt app.'}`)
    let bytes
    if (text !== undefined) {
      bytes = Buffer.from(String(text), 'utf8')
      if (bytes.length > maxInline) throw tooBig(bytes.length)
    } else if (base64 !== undefined) {
      // Whitespace (line breaks) first, then the size before decoding, so a huge string is
      // refused without a huge buffer; the pattern has no nested repeats, so it is linear.
      const b = String(base64).replace(/\s+/g, '')
      if (Math.floor(b.length * 3 / 4) > maxInline + 3) throw tooBig(Math.floor(b.length * 3 / 4))
      if (!BASE64.test(b)) throw new Error('base64 has characters base64 cannot have.')
      bytes = Buffer.from(b, 'base64')
      if (bytes.length > maxInline) throw tooBig(bytes.length)
    } else {
      bytes = await readLocal(String(fromPath))
      if (bytes.length > MAX_FROM_PATH) throw new Error(`That file is too large (${formatBytes(bytes.length)}; at most ${formatBytes(MAX_FROM_PATH)}).`)
    }
    if (!bytes.length) throw new Error('That file is empty; the library keeps files with something in them.')
    const ws = await workspaceOf(workspace)
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
    const started = await call('POST', `${ws$(ws.id)}/files`, { path: p, size: bytes.length, sha256, note: note || '' })
    const { file, upload } = started
    const status = await put(upload.url, bytes, { 'content-type': file.mime || 'application/octet-stream', ...(upload.headers || {}) })
    if (status < 200 || status >= 300) throw new Error(`The upload did not go through (storage answered ${status}). Try again.`)
    const done = await call('POST', `${file$(ws.id, file.id)}/done`, {})
    return `Saved ${done.file.path} in ${ws.name} (version ${done.file.version}, ${formatBytes(done.file.size)}).`
  }))

  server.registerTool('quilt_workspace_move_file', {
    description: 'Rename or move a file or folder in a workspace library (a folder takes everything in it). Needs edit access.',
    inputSchema: {
      workspace: z.string().describe('The workspace name or id'),
      path: z.string().describe('Its path now'),
      to: z.string().describe('Its new path, like "final/teaser.mp4"')
    }
  }, tool(async ({ workspace, path: p, to }) => {
    const ws = await workspaceOf(workspace)
    const f = await entryAt(ws, p)
    const { file } = await call('PATCH', file$(ws.id, f.id), { path: to })
    return `Moved ${f.path} to ${file.path} in ${ws.name}.`
  }))

  server.registerTool('quilt_workspace_delete_file', {
    description: 'Delete a file or folder (with everything in it) from a workspace library. Needs edit access.',
    inputSchema: {
      workspace: z.string().describe('The workspace name or id'),
      path: z.string().describe('The path to delete')
    }
  }, tool(async ({ workspace, path: p }) => {
    const ws = await workspaceOf(workspace)
    const f = await entryAt(ws, p)
    await call('DELETE', file$(ws.id, f.id))
    return `Deleted ${f.path}${f.kind === 'folder' ? ' and everything in it' : ''} from ${ws.name}.`
  }))

  server.registerTool('quilt_workspace_webhook', {
    description: 'Have Quilt POST workspace events to a URL of yours: session.started when a session starts in a workspace that invites you to its sessions, with its join link. Answers the signing secret once. Setting it again replaces the URL and the secret.',
    inputSchema: {
      url: z.string().describe('An https URL that takes POSTs')
    }
  }, tool(async ({ url }) => {
    const r = await call('PUT', '/v1/agents/me/webhook', { url })
    return [
      `Workspace events (${(r.events || []).join(', ')}) now go to ${r.url}.`,
      `Secret (shown once; check x-quilt-signature with it): ${r.secret}`,
      'Each POST is JSON ({ event, id, ts, workspace, room, name, link, by, via }) with x-quilt-event, x-quilt-delivery, x-quilt-timestamp and ' +
        'x-quilt-signature: sha256=HMAC-SHA256(secret, "<timestamp>.<body>"). On session.started, join with quilt_join_session and the link; you wait until the session\'s owner lets you in.'
    ].join('\n')
  }))

  server.registerTool('quilt_workspace_webhook_off', {
    description: 'Stop sending workspace events to your webhook.',
    inputSchema: {}
  }, tool(async () => {
    await call('DELETE', '/v1/agents/me/webhook')
    return 'Workspace events are no longer sent to a webhook.'
  }))
}
