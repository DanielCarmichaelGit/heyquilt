// Chat links: Quilt for AIs that only have a chat window (ChatGPT, claude.ai, Grok…) or
// that work over plain HTTP.
//
// Those AIs can't install anything or add a tool to themselves, but they can open web
// pages. So the session owner makes a chat link, pastes it into the chat, and the AI
// works by opening links: every answer is a short text page that lists the links it
// can open next. Actions put their input in the link (…/say?text=…). Every page is also
// JSON, with stable ids and explicit ok/error, given ?format=json or Accept: application/json.
//
// What a chat link may do is deliberately small: read and send messages, read the board,
// add, assign, move, rename and comment on tasks, read the member list, list files and read
// text files, and add non-code files (pictures, PDFs, office documents, notes) as new files,
// never over an existing one. The "actions" page lists all of it with what this link may do.
// The board and messages come with a cursor: "changes?since=<cursor>" returns only what
// changed after it. The link is a member of the session (`chat:<id>`): it shows on the member
// list, the owner's controls (talk, folders, view only, remove) apply to it, and removing it
// kills the link. It is short-lived: ten minutes unless the owner extends it (up to 30 days)
// while it still works. Once it runs out, it's gone: a new link is needed.
//
// The link is the key, so it is long, random, stored only as a hash, and kept out of
// search engines and referrers.
import crypto from 'node:crypto'
import dns from 'node:dns'
import https from 'node:https'
import net from 'node:net'
import * as Y from 'yjs'
import { globMatcher, isSafeRelPath } from './pathrules.js'
import { readTasks, addTask, updateTask, formatTasks, columnName, COLUMNS, COLUMN_IDS, assignmentFields } from './tasks.js'
import { readComments, addComment, withComments, formatTaskDetails, MAX_COMMENT } from './task-comments.js'
import { qaNotesEnough, qaRefusal, verifiedEnough, doneRefusal, pickChecklist } from './agent-task-workflow.js'
import { HistoryLog } from './history.js'
import { changeRefusal } from './session-access.js'
import { waitingOn, renderUnanswered, unaddressed } from './duties.js'

export const CHAT_LINK_DEFAULT_MINUTES = 10
export const CHAT_LINK_MAX_MINUTES = 30 * 24 * 60
const MINUTE = 60 * 1000
export const CHAT_ADD_MAX_BYTES = 5 * 1024 * 1024
const MAX_LINKS = 20 // per session
const MAX_TEXT = 4000 // a message, a task title is shorter (tasks.js)
const MAX_NOTE = 20000
const MAX_READ = 100 * 1024
const RATE = { perMinute: 60 }
const ORIGIN = 'chat-link' // transaction origin
const CHAT_CAP = 500
const ACTIVITY_CAP = 300

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex')
const memberId = (id) => `chat:${id}`

// ------------------------------------------------------------ the links --

/** Makes a chat link in `room` (the owner asked). Returns { id, token, name, expiresAt }. */
/** Minutes asked for, kept between one and CHAT_LINK_MAX_MINUTES (CHAT_LINK_DEFAULT_MINUTES when not given). */
const minutesOf = (minutes) => Math.min(Math.max(Math.round(Number(minutes)) || CHAT_LINK_DEFAULT_MINUTES, 1), CHAT_LINK_MAX_MINUTES)

export function makeChatLink (room, { name, minutes, by } = {}, now = Date.now()) {
  const links = room.meta.chatLinks = pruneChatLinks(room, now)
  if (Object.keys(links).length >= MAX_LINKS) throw new Error(`a session can have ${MAX_LINKS} chat links at most; remove one first`)
  const id = crypto.randomBytes(6).toString('hex')
  const token = crypto.randomBytes(24).toString('base64url')
  const wanted = String(name || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 40) || 'Chat AI'
  // Not the name of anyone already in the session.
  const taken = new Set([...Object.values(room.meta.members || {}).map((m) => m && m.name), ...Object.keys(room.meta.identities || {})])
  let label = wanted
  for (let n = 2; taken.has(label); n++) label = `${wanted} ${n}`
  const expiresAt = now + minutesOf(minutes) * MINUTE
  links[hashToken(token)] = { id, name: label, by: String(by || ''), createdAt: now, expiresAt }
  room.meta.members[memberId(id)] = { name: label, kind: 'agent', role: 'editor', scopes: [], scopesExcept: [], talk: true, since: now, chat: true, expiresAt }
  room.saveMeta()
  return { id, token, name: label, expiresAt }
}

/**
 * The owner sets how long a chat link still works: `minutes` from now (shorter or longer).
 * Only a link that still works: one that ran out is gone, and a new one is needed.
 */
export function extendChatLink (room, key, minutes, now = Date.now()) {
  const links = pruneChatLinks(room, now)
  const m = room.meta.members[key]
  const entry = m && m.chat && Object.values(links).find((l) => memberId(l.id) === key)
  if (!entry) throw new Error('that chat link has run out or was removed; make a new one')
  entry.expiresAt = m.expiresAt = now + minutesOf(minutes) * MINUTE
  room.saveMeta()
  return { name: m.name, expiresAt: entry.expiresAt }
}

/** Drops links that expired or whose member the owner removed, with their members. Returns the remaining map. */
export function pruneChatLinks (room, now = Date.now()) {
  const links = room.meta.chatLinks || {}
  let changed = false
  for (const [k, l] of Object.entries(links)) {
    const gone = !l || l.expiresAt <= now || !room.meta.members[memberId(l.id)]
    if (!gone) continue
    delete links[k]
    if (l && room.meta.members[memberId(l.id)]?.chat) delete room.meta.members[memberId(l.id)]
    changed = true
  }
  if (changed) room.saveMeta()
  return links
}

/** The live link for `token` in `room`, with its member, or null. */
export function findChatLink (room, token, now = Date.now()) {
  if (!room || !room.meta.chatLinks) return null
  const l = pruneChatLinks(room, now)[hashToken(token)]
  if (!l) return null
  return { ...l, member: room.meta.members[memberId(l.id)], memberId: memberId(l.id) }
}

// ------------------------------------------------------------ fetching --

// Addresses a fetch must never reach: this machine, private networks, cloud metadata.
const blocked = new net.BlockList()
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(a, p, 'ipv4')
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32]]) blocked.addSubnet(a, p, 'ipv6')

/** Is `ip` on the public internet? */
export function publicAddress (ip) {
  const family = net.isIP(ip)
  if (!family) return false
  const mapped = family === 6 && /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped) return !blocked.check(mapped[1], 'ipv4')
  return !blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6')
}

/**
 * Downloads a file from a public https address: no private or local addresses (checked on
 * the address actually connected to, so DNS can't be turned against us), at most three
 * redirects, `maxBytes` and `timeoutMs`. Resolves to a Buffer; rejects with a plain reason.
 */
export function fetchPublicFile (address, { maxBytes = CHAT_ADD_MAX_BYTES, timeoutMs = 15000, redirects = 3, lookup = dns.lookup } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(address) } catch { return reject(new Error('that is not a web address')) }
    if (u.protocol !== 'https:') return reject(new Error('only https addresses can be added'))
    if (u.username || u.password) return reject(new Error('addresses with a user name or password are refused'))
    const safeLookup = (host, opts, cb) => {
      lookup(host, { all: true }, (err, addrs) => {
        if (err) return cb(err)
        const ok = (addrs || []).filter((a) => publicAddress(a.address))
        if (!ok.length || ok.length !== addrs.length) return cb(new Error('that address is not on the public internet'))
        if (opts && opts.all) return cb(null, ok)
        cb(null, ok[0].address, ok[0].family)
      })
    }
    const req = https.get(u, { lookup: safeLookup, timeout: timeoutMs, headers: { 'user-agent': 'Quilt chat link', accept: '*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (redirects <= 0) return reject(new Error('too many redirects'))
        let next
        try { next = new URL(res.headers.location, u).href } catch { return reject(new Error('a bad redirect')) }
        return fetchPublicFile(next, { maxBytes, timeoutMs, redirects: redirects - 1, lookup }).then(resolve, reject)
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`the address answered ${res.statusCode}`)) }
      const declared = Number(res.headers['content-length'])
      if (declared > maxBytes) { res.destroy(); return reject(new Error(`the file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`)) }
      const parts = []
      let size = 0
      res.on('data', (c) => {
        size += c.length
        if (size > maxBytes) { res.destroy(); reject(new Error(`the file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`)) } else parts.push(c)
      })
      res.on('end', () => { if (size <= maxBytes) resolve(Buffer.concat(parts)) })
      res.on('error', (e) => reject(new Error(e.message)))
    })
    req.on('timeout', () => req.destroy(new Error('the address took too long to answer')))
    req.on('error', (e) => reject(new Error(e.message)))
  })
}

// ------------------------------------------------------------ what may be added --

const isUtf8Text = (buf) => {
  if (buf.includes(0)) return false
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true } catch { return false }
}
const starts = (buf, ...bytes) => bytes.every((b, i) => buf[i] === b)
const ascii = (buf, at, s) => buf.slice(at, at + s.length).toString('latin1') === s

// What a chat AI may add, by extension: pictures, documents, notes. Never code. Each is
// checked against what the file really is, so a web page can't come in renamed .pdf.
export const ADDABLE = {
  png: { text: false, is: (b) => starts(b, 0x89, 0x50, 0x4e, 0x47) },
  jpg: { text: false, is: (b) => starts(b, 0xff, 0xd8, 0xff) },
  jpeg: { text: false, is: (b) => starts(b, 0xff, 0xd8, 0xff) },
  gif: { text: false, is: (b) => ascii(b, 0, 'GIF8') },
  webp: { text: false, is: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP') },
  pdf: { text: false, is: (b) => ascii(b, 0, '%PDF') },
  docx: { text: false, is: (b) => starts(b, 0x50, 0x4b, 0x03, 0x04) },
  xlsx: { text: false, is: (b) => starts(b, 0x50, 0x4b, 0x03, 0x04) },
  pptx: { text: false, is: (b) => starts(b, 0x50, 0x4b, 0x03, 0x04) },
  svg: { text: true, is: (b) => isUtf8Text(b) && /<svg[\s>]/i.test(b.slice(0, 4096).toString('utf8')) && !/<script|\son\w+\s*=/i.test(b.toString('utf8')) },
  csv: { text: true, is: isUtf8Text },
  txt: { text: true, is: isUtf8Text },
  md: { text: true, is: isUtf8Text }
}
const extOf = (rel) => (/\.([A-Za-z0-9]+)$/.exec(rel) || [])[1]?.toLowerCase() || ''

/** Why `rel` can't be added by a chat link, or null. */
export function addRefusal (rel) {
  if (!rel || !isSafeRelPath(rel)) return 'that is not a path inside the project'
  if (rel.split('/').some((p) => p.startsWith('.'))) return 'files and folders starting with "." are left alone'
  const ext = extOf(rel)
  if (!ADDABLE[ext]) return `only pictures, documents and notes can be added (${Object.keys(ADDABLE).join(', ')}), not .${ext || '(none)'} files`
  return null
}

// ------------------------------------------------------------ changes since --

// What changed on the board and in the chat, for "changes?since=<cursor>". Kept in memory on
// the relay's room from the first time a chat link opens it. A relay restart or an unloaded
// room starts a new log (another epoch), and a cursor older than what is kept has expired:
// either way the AI is told to read the board and messages again for a fresh cursor.
const LOG_CAP = 2000

export function changeLog (room) {
  if (room.chatChanges) return room.chatChanges
  const log = { epoch: crypto.randomBytes(4).toString('hex'), seq: 0, floor: 0, entries: [] }
  const note = (kind, id) => {
    log.entries.push({ seq: ++log.seq, kind, id })
    if (log.entries.length > LOG_CAP) log.floor = log.entries.splice(0, log.entries.length - LOG_CAP).pop().seq
  }
  room.doc.getMap('tasks').observe((e) => { for (const k of e.keysChanged) note('task', k) })
  room.doc.getMap('taskComments').observe((e) => { for (const k of e.keysChanged) note('task', k) })
  room.doc.getArray('chat').observe((e) => {
    for (const item of e.changes.added) for (const m of item.content.getContent()) if (m && m.id) note('message', m.id)
  })
  room.chatChanges = log
  return log
}

const cursorOf = (log) => `${log.epoch}.${log.seq}`

/** The log entries after `cursor`, or null when it isn't this log's or has expired. */
export function changesSince (log, cursor) {
  const m = /^([0-9a-f]{8})\.(\d{1,12})$/.exec(String(cursor || '').trim())
  if (!m || m[1] !== log.epoch) return null
  const seq = Number(m[2])
  if (seq > log.seq || seq < log.floor) return null
  return log.entries.filter((e) => e.seq > seq)
}

// ------------------------------------------------------------ the pages --

const clean = (s, max) => String(s ?? '').replace(/\r\n?/g, '\n').slice(0, max)
const cleanPath = (p) => String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - (ts || 0)) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`
}
const iso = (ts) => new Date(ts).toISOString()
const flag = (v) => v === '1' || v === 'true' || v === 'yes'
const MAX_BODY = 64 * 1024

/** "todo", "To do", "in progress", "QA"… to a column id, or null. */
function columnId (v) {
  const s = String(v || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ')
  if (COLUMN_IDS.has(s)) return s
  const named = COLUMNS.find((c) => c.name.toLowerCase() === s)
  if (named) return named.id
  return { 'to do': 'todo', 'in progress': 'doing', progress: 'doing', started: 'doing' }[s] || null
}

/** A POST's fields (JSON object or a form), merged under the link's own. */
function readBody (req) {
  return new Promise((resolve, reject) => {
    const parts = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) { reject(new Error(`the body is larger than ${MAX_BODY / 1024} KB`)); req.destroy() } else parts.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(parts).toString('utf8').trim()
      if (!raw) return resolve({})
      if (/json/i.test(String(req.headers['content-type'] || '')) || raw.startsWith('{')) {
        try {
          const o = JSON.parse(raw)
          if (!o || typeof o !== 'object' || Array.isArray(o)) return reject(new Error('send a JSON object'))
          return resolve(o)
        } catch { return reject(new Error('the body is not valid JSON')) }
      }
      resolve(Object.fromEntries(new URLSearchParams(raw)))
    })
    req.on('error', reject)
  })
}

/**
 * Serves one request to /c/<room>/<token>[/<action>]. Returns false when the path isn't a
 * chat link (the caller goes on), true once it answered. `relay` is { getRoom, roomEnded,
 * refused, dropIfUnused, fetchFile, endedMessage }.
 */
export function handleChatLink (req, res, url, relay) {
  const m = url.pathname.match(/^\/c\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{20,64})(?:\/([a-z-]+))?\/?$/)
  if (!m) return false
  const [, roomName, token, action = ''] = m
  const json = url.searchParams.get('format') === 'json' || /^\s*application\/json/i.test(String(req.headers.accept || ''))
  const reply = (code, body, data) => {
    res.writeHead(code, {
      'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff'
    })
    if (!json) return res.end(body)
    const text = String(body || '').trim()
    res.end(JSON.stringify(code < 400 ? { ok: true, ...(data || { message: text }) } : { ok: false, status: code, error: text, ...(data || {}) }))
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') { reply(405, 'Open these links with GET, or POST their fields as JSON.'); return true }
  if (relay.roomEnded(roomName)) { reply(410, relay.endedMessage); return true }
  const room = relay.getRoom(roomName)
  if (!room) { reply(...relay.refused(roomName)); return true }
  const done = () => { if (!room.conns.size && room.onEmpty) room.onEmpty() }
  const link = room.exists ? findChatLink(room, token) : null
  if (!link || !link.member) { relay.dropIfUnused(room); reply(404, 'This chat link is not valid any more: it expired or the session owner removed it. Ask them for a new one.', { expired: true }); return true }
  if (!rateOk(link.id)) { reply(429, 'Too many links opened in a minute; wait a little and try again.'); done(); return true }
  room.hostedActive(link.memberId)
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (/^(localhost|127\.|\[::1\])/.test(String(req.headers.host)) ? 'http' : 'https')
  const base = `${proto}://${req.headers.host}/c/${roomName}/${token}`
  const page = new ChatPage(room, link, base, { json })
  const q = url.searchParams
  Promise.resolve(req.method === 'POST' ? readBody(req) : {})
    .then((body) => {
      for (const [k, v] of Object.entries(body)) if (v != null && typeof v !== 'object') q.set(k, String(v))
      return page.run(action, q, relay)
    })
    .then(({ code = 200, body, data }) => reply(code, body, data))
    .catch((err) => reply(/body|JSON/.test(err.message) ? 400 : 500, `Something went wrong: ${err.message}`))
    .finally(done)
  return true
}

const hits = new Map() // link id -> { minute, n }
function rateOk (id) {
  const minute = Math.floor(Date.now() / 60000)
  const h = hits.get(id)
  if (!h || h.minute !== minute) { hits.set(id, { minute, n: 1 }); if (hits.size > 10000) hits.clear(); return true }
  h.n++
  return h.n <= RATE.perMinute
}

class ChatPage {
  constructor (room, link, base, { json = false } = {}) {
    this.room = room
    this.doc = room.doc
    this.me = link.member.name
    this.access = { role: link.member.role, scopes: link.member.scopes || [], scopesExcept: link.member.scopesExcept || [], talk: link.member.talk !== false }
    this.link = link
    this.base = base
    this.json = json
    this.log = changeLog(room)
  }

  /**
   * Chat links have no branch of their own: files are the session's active branch's. The default
   * branch may always start; any other new branch only for a link that may add files.
   */
  get branch () {
    if (!this._branch) {
      const key = this.room.activeBranch()
      this._branch = this.room.branchDoc(key, { by: this.me, editor: this.room.resolveKey(key) === this.room.defaultKey || this.access.role !== 'viewer' })
    }
    return this._branch
  }

  get bdoc () { return this.branch.doc }

  get chat () { return this.doc.getArray('chat') }

  get taskMap () { return this.doc.getMap('tasks') }

  get commentMap () { return this.doc.getMap('taskComments') }

  visible () { return this.chat.toArray().filter((m) => m && m.id && (!m.to || m.to === this.me || m.by === this.me)) }
  /** Everyone this AI could address: who is here and who has been in the chat. */
  memberNames () {
    const names = new Set(this.room.hostedOnline().map((h) => h.name))
    for (const st of this.room.awareness.getStates().values()) if (st && st.name) names.add(st.name)
    for (const m of this.visible()) { if (m.by) names.add(m.by); if (m.to) names.add(m.to) }
    for (const r of this.roster()) names.add(r.name)
    names.delete(this.me)
    return [...names].filter((n) => typeof n === 'string' && n)
  }

  url (action, params = {}) {
    const qs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&')
    return `${this.base}${action ? `/${action}` : ''}${qs ? `?${qs}` : ''}`
  }

  cursor () { return cursorOf(this.log) }

  menu () {
    if (this.json) return ''
    return [
      '',
      this.timeLeft(),
      'Links you can open (put your words in the link, URL-encoded; add &format=json to any of them for JSON):',
      `- Overview: ${this.url('')}`,
      `- What this link may do, with every action's inputs: ${this.url('actions')}`,
      `- Read messages: ${this.url('messages')}`,
      `- Send a message, starting with @Name of each person it is for (only they are told): ${this.url('say', { text: '@<name> <your message>' })}`,
      `- An announcement for everyone: ${this.url('say', { text: '<your message>', everyone: '1' })}`,
      `- Send a direct message: ${this.url('say', { to: '<name>', text: '<your message>' })}`,
      `- The members, with their roles, focus and open tasks: ${this.url('members')}`,
      `- Read the task board: ${this.url('tasks')}`,
      `- Read one task in full, with its comments: ${this.url('details', { id: '<task id>' })}`,
      `- Add a new task: ${this.url('task', { title: '<what needs doing>' })} (optionally &assignee=<name>)`,
      `- Change an existing task: ${this.url('update', { id: '<task id>', assignee: '<name>' })} (any of &assignee=, &to_ai=1, &column=todo|doing|qa|done, &title=; moving to qa needs &qaNotes=, to done needs &verified=)`,
      `- Comment on a task: ${this.url('comment', { id: '<task id>', text: '<your comment>' })}`,
      `- What changed since a cursor (the board and messages give you one): ${this.url('changes', { since: '<cursor>' })}`,
      `- List the project's files: ${this.url('files')} (optionally ?under=<folder>)`,
      `- Read a text file: ${this.url('file', { path: '<path>' })}`,
      `- Add a picture, PDF or document from the web: ${this.url('add', { url: '<https address of the file>', path: '<where, e.g. docs/mockup.png>' })}`,
      `- Add a short note: ${this.url('note', { path: '<notes/name.md>', text: '<the note>' })}`
    ].join('\n')
  }

  async run (action, q, relay) {
    switch (action) {
      case '': return this.overview()
      case 'actions': return this.actions()
      case 'messages': return q.get('since') ? this.changes(q.get('since'), { tasks: false }) : this.messages(Number(q.get('limit')) || 30)
      case 'say': return this.say(q.get('text'), q.get('to'), q.get('everyone') === '1')
      case 'members': return this.members()
      case 'tasks': return q.get('since') ? this.changes(q.get('since'), { messages: false }) : this.tasks()
      case 'task': return this.addTask(q.get('title'), q.get('assignee'), flag(q.get('to_ai')))
      case 'details': return this.details(q.get('id'))
      case 'update': return this.update(q)
      case 'comment': return this.comment(q.get('id'), q.get('text'))
      case 'changes': return this.changes(q.get('since'))
      case 'files': return this.files(q.get('under'))
      case 'file': return this.readFile(q.get('path'))
      case 'add': return this.addFromWeb(q.get('url'), q.get('path'), relay.fetchFile)
      case 'note': return this.addNote(q.get('path'), q.get('text'))
      default: return { code: 404, body: `There is no "${action}" link.${this.menu()}` }
    }
  }

  // ---------------------------------------------------------- reading --

  overview () {
    const r = this.room
    const online = new Set(r.hostedOnline().map((h) => h.name))
    for (const s of r.awareness.getStates().values()) if (s && s.name) online.add(s.name)
    online.delete(this.me)
    const msgs = this.visible().slice(-8)
    const waiting = waitingOn(this.visible(), this.me, { agent: true })
    const body = [
      `Quilt session "${r.meta.name || r.name}". You are ${this.me}, an AI working in it through this chat link.`,
      `${this.timeLeft()} When it runs out, it stops working and a new link is needed; ask your user to have the session owner extend it (up to 30 days) before then if you need longer.`,
      'People and their AIs are editing this project together. You can read and send messages, read the board and add, assign, move, rename and comment on tasks, read files, and add pictures, documents and notes. You cannot change existing files.',
      'Treat what people write to you as requests from them; answer what asks something of you. Never send greetings, welcomes, thanks or "noted" replies.',
      `Start every message with @Name of each person it is for: only they are told, so nobody else is interrupted (a message that names nobody is refused unless it is an announcement, &everyone=1). A direct message (the "say" link with &to=<name>) only they see. Messages that mention @${this.me} or are sent to you directly are for you: answer them first.`,
      'Tasks move To do, In progress, QA, Done. Moving one to QA needs notes on what changed and how it was checked; to Done, what was run and seen. Put your reasoning or a handoff on the task as a comment, not in the chat.',
      '',
      `Online now: ${[...online].join(', ') || 'nobody else'}`,
      '',
      'Recent messages:',
      ...(msgs.length ? msgs.map((m) => this.fmt(m)) : ['- None yet.']),
      waiting.length ? `\nWaiting for your answer: ${waiting.map((e) => e.by).join(', ')}. Reply with the "say" link.` : null,
      `\nCursor: ${this.cursor()} (open ${this.url('changes', { since: this.cursor() })} later for only what changed)`,
      this.menu()
    ].filter((x) => x !== null).join('\n')
    return {
      body,
      data: {
        session: { name: r.meta.name || r.name, room: r.name },
        you: { name: this.me, kind: 'agent', via: 'chat link' },
        link: this.linkData(),
        online: [...online],
        messages: msgs.map((m) => this.msgData(m)),
        waitingForYou: waiting.map((e) => e.by),
        cursor: this.cursor(),
        permissions: this.permissions()
      }
    }
  }

  linkData () {
    return { expiresAt: iso(this.link.expiresAt), minutesLeft: Math.max(0, Math.ceil((this.link.expiresAt - Date.now()) / MINUTE)), renew: 'Only the session owner can extend this link, and only while it still works (up to 30 days). Ask your user to have them extend it.' }
  }

  /** What this link may do here, under the owner's controls. */
  permissions () {
    const a = this.access
    const talk = a.talk && !this.room.full
    return {
      role: a.role,
      readMessages: true,
      sendMessages: talk,
      readTasks: true,
      addTasks: talk,
      updateTasks: talk,
      commentOnTasks: talk,
      readMembers: true,
      readFiles: true,
      addNewFiles: a.role !== 'viewer' && !this.room.full && !this.branchFull(),
      changeExistingFiles: false,
      ...(a.scopes.length ? { onlyIn: a.scopes } : {}),
      ...(a.scopesExcept.length ? { notIn: a.scopesExcept } : {}),
      ...(this.room.full ? { why: 'This session is over its size limit, so nothing new can be saved.' } : !a.talk ? { why: 'The session owner has turned off messages and task changes from you.' } : {})
    }
  }

  actions () {
    const p = this.permissions()
    const list = [
      { action: '', does: 'The overview: who is here, recent messages, a cursor', allowed: true },
      { action: 'actions', does: 'This list', allowed: true },
      { action: 'messages', does: 'Read messages (with since: only new ones)', params: { limit: 'how many, up to 100 (default 30)', since: 'a cursor' }, allowed: p.readMessages },
      { action: 'say', does: 'Send a message', params: { text: 'the message, starting with @Name of each person it is for', to: 'a name, for a direct message', everyone: '1 for an announcement to everyone' }, required: ['text'], allowed: p.sendMessages },
      { action: 'members', does: 'The members: name, human or agent, role, online, tool, focus and open tasks', allowed: p.readMembers },
      { action: 'tasks', does: 'Read the board (with since: only what changed)', params: { since: 'a cursor' }, allowed: p.readTasks },
      { action: 'details', does: 'One task in full: notes, files and comments', params: { id: 'the task id (or its first 6 or more characters)' }, required: ['id'], allowed: p.readTasks },
      { action: 'task', does: 'Create a new task in To do (it does not change an existing one: use update)', params: { title: 'what needs doing', assignee: 'a member\'s name, or "me"', to_ai: '1: that person\'s AI rather than the person' }, required: ['title'], allowed: p.addTasks },
      { action: 'update', does: 'Change an existing task and get it back as saved', params: { id: 'the task id', assignee: 'a member\'s name, "me", or empty to unassign', to_ai: '1: that person\'s AI', column: 'todo, doing, qa or done', title: 'a new title', qaNotes: 'needed to move to qa: what changed and how it was checked', verified: 'needed to move to done: what was run and seen' }, required: ['id'], allowed: p.updateTasks },
      { action: 'comment', does: 'Add a comment to a task (a work note, a handoff, why it went to whom)', params: { id: 'the task id', text: `the comment, up to ${MAX_COMMENT} characters` }, required: ['id', 'text'], allowed: p.commentOnTasks },
      { action: 'changes', does: 'What changed on the board and in messages since a cursor, with a new cursor', params: { since: 'a cursor from the overview, tasks, messages or an earlier changes' }, required: ['since'], allowed: true },
      { action: 'files', does: 'List the project\'s files', params: { under: 'a folder' }, allowed: p.readFiles },
      { action: 'file', does: 'Read a text file', params: { path: 'the file' }, required: ['path'], allowed: p.readFiles },
      { action: 'add', does: 'Add a picture, PDF or document from a public https address, as a new file', params: { url: 'the https address', path: 'where it goes' }, required: ['url'], allowed: p.addNewFiles },
      { action: 'note', does: 'Add a short note as a new .md or .txt file', params: { path: 'where it goes', text: 'the note' }, required: ['path', 'text'], allowed: p.addNewFiles }
    ].map((a) => ({ ...a, url: this.url(a.action) }))
    const body = [
      `What ${this.me} may do through this link (GET with the inputs in the link, or POST them as JSON; &format=json for JSON answers):`,
      ...list.map((a) => `- ${a.action || '(overview)'}: ${a.does}.${a.params ? ` Inputs: ${Object.entries(a.params).map(([k, v]) => `${k}${(a.required || []).includes(k) ? '' : ' (optional)'} = ${v}`).join('; ')}.` : ''}${a.allowed ? '' : ' NOT ALLOWED for you now.'}`),
      '',
      `You may not change existing files.${p.why ? ` ${p.why}` : ''}${p.onlyIn ? ` New files only in: ${p.onlyIn.join(', ')}.` : ''}${p.notIn ? ` Not in: ${p.notIn.join(', ')}.` : ''}`,
      this.menu()
    ].join('\n')
    return { body, data: { you: this.me, link: this.linkData(), permissions: p, actions: list } }
  }

  /** "This link works for 7 more minutes." */
  timeLeft () {
    const min = Math.max(0, Math.ceil((this.link.expiresAt - Date.now()) / MINUTE))
    const span = min < 60 ? `${min} more minute${min === 1 ? '' : 's'}` : min < 2880 ? `${Math.round(min / 60)} more hours` : `${Math.round(min / 1440)} more days`
    return `This link works for ${span} (until ${iso(this.link.expiresAt)}).`
  }

  fmt (m) { return `- ${m.by}${m.to ? ` → ${m.to} (direct)` : ''} (${ago(m.ts)}): ${m.text}${m.file ? ` [file: ${m.file.name}]` : ''}` }
  msgData (m) { return { id: m.id, by: m.by, to: m.to || null, text: m.text, at: iso(m.ts), ...(m.file ? { file: m.file.name } : {}) } }

  messages (limit) {
    const msgs = this.visible().slice(-Math.min(Math.max(limit, 1), 100))
    const body = (msgs.length ? msgs.map((m) => this.fmt(m)).join('\n') : 'No messages yet.') + `\n\nCursor: ${this.cursor()}` + this.menu()
    return { body, data: { messages: msgs.map((m) => this.msgData(m)), cursor: this.cursor() } }
  }

  /** The members, from the session's member list and who is connected, with their open work. */
  roster () {
    const tasks = readTasks(this.taskMap)
    const out = new Map()
    const put = (name, fields) => { if (typeof name === 'string' && name) out.set(name, { ...(out.get(name) || { name }), ...fields }) }
    for (const m of this.room.memberList ? this.room.memberList() : []) {
      put(m.name, { kind: m.kind === 'agent' ? 'agent' : 'human', role: m.role || 'editor', online: !!m.online, ...(m.chat ? { via: 'chat link' } : m.http ? { via: 'http' } : {}) })
    }
    for (const st of this.room.awareness.getStates().values()) {
      if (!st || typeof st.name !== 'string' || !st.name) continue
      const tool = typeof st.tool === 'string' && st.tool && st.tool !== 'unknown' ? { tool: st.tool.slice(0, 40) } : {}
      const focus = typeof st.focus === 'string' && st.focus ? { focus: st.focus.slice(0, 200) } : {}
      put(st.name, { kind: out.get(st.name)?.kind || (st.kind === 'agent' ? 'agent' : 'human'), online: true, ...tool, ...focus })
      for (const x of Array.isArray(st.personas) ? st.personas : []) {
        if (!x || typeof x.name !== 'string' || !x.name) continue
        put(x.name.slice(0, 80), { kind: 'agent', online: true, aiOf: st.name, ...(typeof x.tool === 'string' && x.tool ? { tool: x.tool.slice(0, 40) } : {}), ...(typeof x.focus === 'string' && x.focus ? { focus: x.focus.slice(0, 200) } : {}) })
      }
    }
    return [...out.values()].map((r) => {
      const open = tasks.filter((t) => t.assignee === r.name && t.column !== 'done')
      return { ...r, ...(r.name === this.me ? { you: true } : {}), openTasks: open.map((t) => ({ id: t.id, title: t.title, column: t.column, forAi: t.forAi })) }
    })
  }

  members () {
    const list = this.roster()
    const line = (r) => {
      const bits = [r.kind, r.role, r.online ? 'online' : 'away', r.aiOf ? `an AI session of ${r.aiOf}` : '', r.via ? `via ${r.via}` : ''].filter(Boolean).join(', ')
      const work = r.openTasks.length ? ` · open tasks: ${r.openTasks.map((t) => `${t.title} (${columnName(t.column)}${t.forAi ? ', their AI' : ''}, ${t.id})`).join('; ')}` : ' · no open tasks'
      return `- ${r.name}${r.you ? ' (you)' : ''} (${bits})${r.tool ? ` · ${r.tool}` : ''}${r.focus ? ` · focus: ${r.focus}` : ''}${work}`
    }
    const body = `Members (assign tasks by these names):\n${list.length ? list.map(line).join('\n') : '- Nobody yet.'}${this.menu()}`
    return { body, data: { members: list } }
  }

  taskData (t) {
    return {
      id: t.id,
      title: t.title,
      column: t.column,
      columnName: columnName(t.column),
      by: t.by,
      assignee: t.assignee || null,
      forAi: !!t.forAi,
      ...(t.tool ? { tool: t.tool } : {}),
      files: t.files || [],
      qaNotes: t.qaNotes || '',
      verified: t.verified || '',
      recurring: !!t.recurring,
      ...(t.cron ? { cron: t.cron } : {}),
      createdAt: iso(t.ts),
      comments: readComments(this.commentMap, t.id).map((c) => ({ id: c.id, by: c.by, text: c.text, at: iso(c.ts) }))
    }
  }

  taskText (t) { return formatTaskDetails({ ...t, comments: readComments(this.commentMap, t.id) }) }

  tasks () {
    const list = readTasks(this.taskMap)
    const counts = {}
    for (const [id, c] of Object.entries(Object.fromEntries([...this.commentMap.entries()]))) if (Array.isArray(c) && c.length) counts[id] = c.length
    const board = formatTasks(list, { name: this.me, asAi: false })
    const noted = Object.keys(counts).length ? `\n\nTasks with comments (open them with the details link): ${list.filter((t) => counts[t.id]).map((t) => `${t.id} (${counts[t.id]})`).join(', ')}` : ''
    return {
      body: `${board}${noted}\n\nCursor: ${this.cursor()}${this.menu()}`,
      data: { columns: COLUMNS.map((c) => ({ id: c.id, name: c.name })), tasks: withComments(list, this.commentMap).map((t) => this.taskData(t)), cursor: this.cursor() }
    }
  }

  /** The task `id` names (all of it, or a unique start of at least 6 characters), or a refusal. */
  findTask (id) {
    const want = String(id || '').trim().toLowerCase()
    if (!want || want === '<task id>') return { refusal: { code: 400, body: `Say which task, by the id the board shows: ${this.url('details', { id: '<task id>' })}${this.menu()}` } }
    const list = readTasks(this.taskMap)
    const exact = list.find((t) => t.id === want)
    if (exact) return { task: exact }
    const some = want.length >= 6 ? list.filter((t) => t.id.startsWith(want)) : []
    if (some.length === 1) return { task: some[0] }
    if (some.length > 1) return { refusal: { code: 400, body: `More than one task starts with ${want}; give more of its id.${this.menu()}` } }
    return { refusal: { code: 404, body: `There is no task ${want} on the board (it may have been removed). Read the board: ${this.url('tasks')}${this.menu()}` } }
  }

  details (id) {
    const { task, refusal } = this.findTask(id)
    if (refusal) return refusal
    return { body: this.taskText(task) + this.menu(), data: { task: this.taskData(task) } }
  }

  changes (cursor, { tasks = true, messages = true } = {}) {
    if (!cursor || cursor === '<cursor>') return { code: 400, body: `Give the cursor from the board, messages or overview: ${this.url('changes', { since: this.cursor() })}${this.menu()}` }
    const entries = changesSince(this.log, cursor)
    if (!entries) {
      return {
        code: 410,
        body: `That cursor has expired (the session restarted, or a lot changed since). Read the board (${this.url('tasks')}) and messages (${this.url('messages')}) again: each gives a fresh cursor.${this.menu()}`,
        data: { expired: true }
      }
    }
    const list = readTasks(this.taskMap)
    const ids = tasks ? [...new Set(entries.filter((e) => e.kind === 'task').map((e) => e.id))] : []
    const changed = ids.map((id) => list.find((t) => t.id === id)).filter(Boolean)
    const removed = ids.filter((id) => !list.some((t) => t.id === id))
    const msgIds = new Set(messages ? entries.filter((e) => e.kind === 'message').map((e) => e.id) : [])
    const msgs = this.visible().filter((m) => msgIds.has(m.id))
    const next = this.cursor()
    const lines = []
    if (changed.length) lines.push(`Tasks changed (${changed.length}):`, ...changed.map((t) => `- ${t.id}  ${t.title}  (${columnName(t.column)})${t.assignee ? `  → ${t.assignee}${t.forAi ? "'s AI" : ''}` : ''}`))
    if (removed.length) lines.push(`Tasks removed: ${removed.join(', ')}`)
    if (msgs.length) lines.push(`New messages (${msgs.length}):`, ...msgs.map((m) => this.fmt(m)))
    if (!lines.length) lines.push('Nothing changed since then.')
    return {
      body: `${lines.join('\n')}\n\nNext cursor: ${next} (${this.url('changes', { since: next })})${this.menu()}`,
      data: {
        ...(tasks ? { tasks: changed.map((t) => this.taskData(t)), removedTasks: removed } : {}),
        ...(messages ? { messages: msgs.map((m) => this.msgData(m)) } : {}),
        cursor: next
      }
    }
  }

  // ---------------------------------------------------------- writing --

  writable () {
    if (this.room.full) return 'This session is over its size limit, so nothing new can be saved.'
    return null
  }

  say (text, to, everyone = false) {
    const t = clean(text, MAX_TEXT).trim()
    if (!t || t === '<your message>' || t === '@<name> <your message>') return { code: 400, body: `Put your message in the link: ${this.url('say', { text: 'Hello%20everyone' })}` }
    if (!this.access.talk) return { code: 403, body: 'The session owner has turned off messages from you.' }
    const err = this.writable()
    if (err) return { code: 403, body: err }
    const who = to ? String(to).trim().slice(0, 80) : null
    const why = unaddressed(t, { to: who, everyone, names: this.memberNames() })
    if (why) return { code: 400, body: `${why.replace(/set "to"/, 'add &to=<name>').replace(/with everyone: true/, 'with &everyone=1')}${this.menu()}` }
    // A chat app may open the same link twice: the same words in the last two minutes are sent once.
    const recent = this.chat.toArray().slice(-50).find((m) => m && m.by === this.me && m.text === t && (m.to || null) === who && Date.now() - m.ts < 120000)
    if (recent) return { body: `Already sent.${this.menu()}`, data: { message: this.msgData(recent), duplicate: true } }
    const msg = { id: crypto.randomBytes(8).toString('hex'), by: this.me, to: who, text: t, ts: Date.now() }
    this.doc.transact(() => {
      this.chat.push([msg])
      if (this.chat.length > CHAT_CAP) this.chat.delete(0, this.chat.length - CHAT_CAP)
    }, ORIGIN)
    return { body: `${who ? `Sent to ${who}.` : 'Sent to everyone.'}${this.menu()}`, data: { message: this.msgData(msg) } }
  }

  /** Work moves on once nobody waits for an answer (duties.js), as for every agent. */
  held (what) {
    const w = renderUnanswered(waitingOn(this.visible(), this.me, { agent: true }), what)
    return w ? { code: 409, body: `${w.replace(/quilt_message \(to: their name\)/, 'the "say" link (with &to=<their name>)').replace(/ One that needs nothing back[^.]*\./, '')}${this.menu()}` } : null
  }

  /** Why this link may not change the board now, as a refusal, or null. */
  boardRefusal (what) {
    const wait = this.held(what)
    if (wait) return wait
    if (!this.access.talk) return { code: 403, body: 'The session owner has turned off messages and task changes from you.' }
    const err = this.writable()
    if (err) return { code: 403, body: err }
    return null
  }

  /** Assignment fields for `assignee` ("me", a member's name, or '' to clear), or a refusal. */
  assignTo (assignee, toAi) {
    const raw = String(assignee ?? '').trim()
    const name = raw === 'me' ? this.me : raw
    const roster = this.roster()
    if (name && name !== this.me && !roster.some((r) => r.name === name)) {
      const near = roster.find((r) => r.name.toLowerCase() === name.toLowerCase())
      return { refusal: { code: 400, body: `Nobody called "${name}" is in this session.${near ? ` Did you mean ${near.name}?` : ''} Members: ${roster.map((r) => r.name).join(', ') || 'none'} (${this.url('members')}).${this.menu()}` } }
    }
    try {
      return { fields: assignmentFields({ assignee: name, to_ai: toAi, me: this.me, peers: roster }) }
    } catch (e) { return { refusal: { code: 400, body: `${e.message}.${this.menu()}` } } }
  }

  addTask (title, assignee, toAi = false) {
    const t = clean(title, 300).trim()
    if (!t || t === '<what needs doing>') return { code: 400, body: `Put the task in the link: ${this.url('task', { title: 'Write%20the%20pricing%20page' })}` }
    const no = this.boardRefusal('open the task link again')
    if (no) return no
    const existing = readTasks(this.taskMap).find((x) => x.title === t && x.by === this.me && x.column !== 'done')
    if (existing) return { body: `That task is already on the board (${existing.id}).${this.menu()}`, data: { task: this.taskData(existing), duplicate: true } }
    let who = {}
    if (assignee) {
      const a = this.assignTo(assignee, toAi)
      if (a.refusal) return a.refusal
      who = a.fields
    }
    try {
      const task = addTask(this.doc, this.taskMap, { title: t, by: this.me, ...who }, ORIGIN)
      return { body: `Added to To do: ${task.title}${task.assignee ? ` (for ${task.assignee}${task.forAi ? "'s AI" : ''})` : ''}. Its id is ${task.id}.${this.menu()}`, data: { task: this.taskData(task) } }
    } catch (e) { return { code: 400, body: `${e.message}.${this.menu()}` } }
  }

  /** Changes an existing task: assignee, column, title. Answers with the task as saved. */
  update (q) {
    const { task: cur, refusal } = this.findTask(q.get('id'))
    if (refusal) return refusal
    const patch = { id: cur.id }
    let column
    if (q.has('column')) {
      column = columnId(q.get('column'))
      if (!column) return { code: 400, body: `column is todo, doing, qa or done, not "${String(q.get('column')).slice(0, 40)}".${this.menu()}` }
      patch.column = column
    }
    if (q.has('title')) patch.title = clean(q.get('title'), 300)
    if (q.has('assignee')) {
      const a = this.assignTo(q.get('assignee'), flag(q.get('to_ai')))
      if (a.refusal) return a.refusal
      Object.assign(patch, a.fields)
    } else if (q.has('to_ai')) {
      const a = this.assignTo(cur.assignee, flag(q.get('to_ai')))
      if (a.refusal) return a.refusal
      Object.assign(patch, a.fields)
    }
    if (q.has('qaNotes')) patch.qaNotes = q.get('qaNotes')
    if (q.has('verified')) patch.verified = q.get('verified')
    if (Object.keys(patch).length === 1) return { code: 400, body: `Say what to change: &assignee=, &to_ai=1, &column= or &title=. ${this.url('update', { id: cur.id, assignee: '<name>' })}${this.menu()}` }
    const no = this.boardRefusal('open the update link again')
    if (no) return no
    const checklist = () => pickChecklist(this.bdoc.getMap('files').get('AGENTS.md')?.toString(), this.bdoc.getMap('files').get('CLAUDE.md')?.toString())
    const refusalText = (s) => s.replace(/`qaNotes`/g, '&qaNotes=').replace(/`verified`/g, '&verified=')
    if (column === 'qa' && cur.column !== 'qa' && !qaNotesEnough(patch.qaNotes)) return { code: 400, body: refusalText(qaRefusal({ task: cur, checklist: checklist() })) + this.menu() }
    if (column === 'done' && cur.column !== 'done' && !verifiedEnough(patch.verified)) return { code: 400, body: refusalText(doneRefusal({ task: cur, checklist: checklist() })) + this.menu() }
    try {
      const task = updateTask(this.doc, this.taskMap, patch, ORIGIN)
      return { body: `Saved. The task now reads:\n\n${this.taskText(task)}${this.menu()}`, data: { task: this.taskData(task) } }
    } catch (e) { return { code: 400, body: `${e.message}.${this.menu()}` } }
  }

  comment (id, text) {
    const { task, refusal } = this.findTask(id)
    if (refusal) return refusal
    const t = clean(text, MAX_COMMENT + 100).trim()
    if (!t || t === '<your comment>') return { code: 400, body: `Put the comment in the link: ${this.url('comment', { id: task.id, text: 'Assigned%20to%20Dana%3A%20she%20wrote%20the%20parser' })}${this.menu()}` }
    const no = this.boardRefusal('open the comment link again')
    if (no) return no
    // A chat app may open the same link twice.
    const recent = readComments(this.commentMap, task.id).find((c) => c.by === this.me && c.text === t && Date.now() - c.ts < 120000)
    if (recent) return { body: `Already added.${this.menu()}`, data: { task: this.taskData(task), duplicate: true } }
    try {
      addComment(this.doc, this.commentMap, readTasks(this.taskMap), { taskId: task.id, by: this.me, text: t }, ORIGIN)
      return { body: `Comment added to "${task.title}".${this.menu()}`, data: { task: this.taskData(task) } }
    } catch (e) { return { code: 400, body: `${e.message}.${this.menu()}` } }
  }

  files (under) {
    const pre = under ? cleanPath(under).replace(/\/+$/, '') + '/' : ''
    const f = this.bdoc.getMap('files')
    const b = this.bdoc.getMap('blobs')
    const paths = [...new Set([...f.keys(), ...b.keys()])].filter((p) => isSafeRelPath(p) && (!pre || p.startsWith(pre))).sort()
    const shown = paths.slice(0, 400).map((p) => `- ${p}${b.has(p) ? ' (binary)' : ''}`)
    const body = (paths.length ? shown.join('\n') + (paths.length > 400 ? `\n… and ${paths.length - 400} more (use ?under=<folder>)` : '') : 'No files.') + this.menu()
    return { body, data: { files: paths.slice(0, 400).map((p) => ({ path: p, binary: b.has(p) })), total: paths.length } }
  }

  readFile (p) {
    const rel = cleanPath(p)
    if (!rel || !isSafeRelPath(rel)) return { code: 400, body: `Say which file: ${this.url('file', { path: 'README.md' })}` }
    const t = this.bdoc.getMap('files').get(rel)
    if (t) {
      const s = t.toString()
      const cut = s.length > MAX_READ
      return { body: cut ? `${s.slice(0, MAX_READ)}\n… (${s.length - MAX_READ} more characters not shown)` : s, data: { path: rel, text: s.slice(0, MAX_READ), truncated: cut } }
    }
    if (this.bdoc.getMap('blobs').has(rel)) return { code: 400, body: `${rel} is a binary file; it can't be shown as text.` }
    return { code: 404, body: `There is no file called ${rel}.${this.menu()}` }
  }

  /** Can a new file go at `rel`? A refusal as { code, body }, or null. */
  placeRefusal (rel) {
    const why = addRefusal(rel)
    if (why) return { code: 400, body: `${why}.` }
    if (this.bdoc.getMap('files').has(rel) || this.bdoc.getMap('blobs').has(rel)) return { code: 409, body: `${rel} already exists, and chat links only add new files. Pick another name.` }
    const refusal = changeRefusal(this.access, rel)
    if (refusal) return { code: 403, body: `The session owner says ${refusal}.` }
    const claim = (this.room.claimList ? this.room.claimList(this.branch.key) : []).find((c) => c.by !== this.me && globMatcher(c.pattern)(rel))
    if (claim) return { code: 409, body: `${rel} is in ${claim.pattern}, which ${claim.by} has claimed${claim.note ? ` (${claim.note})` : ''}. Put it somewhere else, or ask them with the "say" link.` }
    if (this.writable()) return { code: 403, body: this.writable() }
    return this.branchFull() ? { code: 403, body: this.branchFull() } : null
  }

  /** Why the branch files are added to can take nothing new (it is over its own size limit), or null. */
  branchFull () {
    let k
    try { k = this.branch.key } catch { return null } // no branch to add to: placeRefusal says why
    return this.room.branchFull && this.room.branchFull(k) ? `${k} is over the session's size limit for one branch, so no new files can be saved on it.` : null
  }

  async addFromWeb (address, p, fetchFile) {
    if (!address || address === '<https address of the file>') return { code: 400, body: `Give the file's web address: ${this.url('add', { url: 'https%3A%2F%2Fexample.com%2Fmockup.png', path: 'docs/mockup.png' })}` }
    let rel = cleanPath(p)
    if (!rel) { try { rel = `shared/${decodeURIComponent(new URL(address).pathname.split('/').pop() || '')}` } catch {} }
    const wait = this.held('open the add link again')
    if (wait) return wait
    const refused = this.placeRefusal(rel)
    if (refused) return { ...refused, body: refused.body + this.menu() }
    let buf
    try { buf = await fetchFile(address) } catch (e) { return { code: 502, body: `Could not get that file: ${e.message}.${this.menu()}` } }
    return this.place(rel, buf, `from ${new URL(address).host}`)
  }

  addNote (p, text) {
    const rel = cleanPath(p)
    if (!rel || !/\.(md|txt)$/i.test(rel)) return { code: 400, body: `Say where the note goes, as a .md or .txt file: ${this.url('note', { path: 'notes/meeting.md', text: 'Decisions%3A%20...' })}` }
    const t = clean(text, MAX_NOTE)
    if (!t.trim() || t === '<the note>') return { code: 400, body: 'Put the note in the link as text=…' }
    const wait = this.held('open the note link again')
    if (wait) return wait
    const refused = this.placeRefusal(rel)
    if (refused) return { ...refused, body: refused.body + this.menu() }
    return this.place(rel, Buffer.from(t.endsWith('\n') ? t : t + '\n', 'utf8'), 'a note')
  }

  /** Writes a new file into the shared project, checked against what its name says it is. */
  place (rel, buf, from) {
    const kind = ADDABLE[extOf(rel)]
    if (!kind.is(buf)) return { code: 400, body: `That isn't a real .${extOf(rel)} file (its contents say otherwise), so it was not added.${this.menu()}` }
    if (buf.length > CHAT_ADD_MAX_BYTES) return { code: 413, body: `That file is larger than ${CHAT_ADD_MAX_BYTES / 1024 / 1024} MB.` }
    const files = this.bdoc.getMap('files')
    const blobs = this.bdoc.getMap('blobs')
    const activity = this.doc.getArray('activity')
    const history = this.branch.historyLog || (this.branch.historyLog = new HistoryLog(this.bdoc, this.bdoc.getArray('history'), { origin: ORIGIN }))
    const detail = kind.text ? `${buf.toString('utf8').split('\n').length} lines` : `${buf.length} bytes`
    this.bdoc.transact(() => this.doc.transact(() => {
      if (kind.text) {
        const t = new Y.Text()
        t.insert(0, buf.toString('utf8'))
        files.set(rel, t)
      } else {
        blobs.set(rel, { hash: crypto.createHash('sha1').update(buf).digest('hex'), data: buf.toString('base64') })
      }
      activity.push([{ by: this.me, path: rel, kind: 'created', detail, branch: this.branch.key, ts: Date.now() }])
      if (activity.length > ACTIVITY_CAP) activity.delete(0, activity.length - ACTIVITY_CAP)
      history.record({ by: this.me, path: rel, kind: 'created', detail, ...(kind.text ? { before: '', after: buf.toString('utf8') } : {}) })
    }, ORIGIN), ORIGIN)
    return { body: `Added ${rel} (${detail}, ${from}). Everyone in the session has it now.${this.menu()}`, data: { path: rel, detail } }
  }
}
