// Chat links: Quilt for AIs that only have a chat window (ChatGPT, claude.ai, Grok…).
//
// Those AIs can't install anything or add a tool to themselves, but they can open web
// pages. So the session owner makes a chat link, pastes it into the chat, and the AI
// works by opening links: every answer is a short text page that lists the links it
// can open next. Actions put their input in the link (…/say?text=…).
//
// What a chat link may do is deliberately small: read and send messages, read and add
// tasks, list files and read text files, and add non-code files (pictures, PDFs, office
// documents, notes) as new files, never over an existing one. The link is a member of
// the session (`chat:<id>`): it shows on the member list, the owner's controls (talk,
// folders, view only, remove) apply to it, and removing it kills the link. It is short-lived:
// ten minutes unless the owner extends it while it still works. Once it runs out, it's gone:
// a new link is needed.
//
// The link is the key, so it is long, random, stored only as a hash, and kept out of
// search engines and referrers.
import crypto from 'node:crypto'
import dns from 'node:dns'
import https from 'node:https'
import net from 'node:net'
import * as Y from 'yjs'
import { globMatcher, isSafeRelPath } from './pathrules.js'
import { readTasks, addTask, formatTasks } from './tasks.js'
import { HistoryLog } from './history.js'
import { changeRefusal } from './session-access.js'
import { waitingOn, renderUnanswered } from './duties.js'

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

// ------------------------------------------------------------ the pages --

const clean = (s, max) => String(s ?? '').replace(/\r\n?/g, '\n').slice(0, max)
const cleanPath = (p) => String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - (ts || 0)) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`
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
  const reply = (code, body) => {
    res.writeHead(code, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff'
    })
    res.end(body)
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { reply(405, 'Open these links with GET.'); return true }
  if (relay.roomEnded(roomName)) { reply(410, relay.endedMessage); return true }
  const room = relay.getRoom(roomName)
  if (!room) { reply(...relay.refused(roomName)); return true }
  const done = () => { if (!room.conns.size && room.onEmpty) room.onEmpty() }
  const link = room.exists ? findChatLink(room, token) : null
  if (!link || !link.member) { relay.dropIfUnused(room); reply(404, 'This chat link is not valid any more: it expired or the session owner removed it. Ask them for a new one.'); return true }
  if (!rateOk(link.id)) { reply(429, 'Too many links opened in a minute; wait a little and try again.'); done(); return true }
  room.hostedActive(link.memberId)
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (/^(localhost|127\.|\[::1\])/.test(String(req.headers.host)) ? 'http' : 'https')
  const base = `${proto}://${req.headers.host}/c/${roomName}/${token}`
  const page = new ChatPage(room, link, base)
  const q = url.searchParams
  Promise.resolve(page.run(action, q, relay))
    .then(({ code = 200, body }) => reply(code, body))
    .catch((err) => reply(500, `Something went wrong: ${err.message}`))
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
  constructor (room, link, base) {
    this.room = room
    this.doc = room.doc
    this.me = link.member.name
    this.access = { role: link.member.role, scopes: link.member.scopes || [], scopesExcept: link.member.scopesExcept || [], talk: link.member.talk !== false }
    this.link = link
    this.base = base
  }

  get chat () { return this.doc.getArray('chat') }
  visible () { return this.chat.toArray().filter((m) => m && m.id && (!m.to || m.to === this.me || m.by === this.me)) }
  url (action, params = {}) {
    const qs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&')
    return `${this.base}${action ? `/${action}` : ''}${qs ? `?${qs}` : ''}`
  }

  menu () {
    return [
      '',
      this.timeLeft(),
      'Links you can open (put your words in the link, URL-encoded):',
      `- Overview: ${this.url('')}`,
      `- Read messages: ${this.url('messages')}`,
      `- Send a message to everyone: ${this.url('say', { text: '<your message>' })}`,
      `- Send a direct message: ${this.url('say', { to: '<name>', text: '<your message>' })}`,
      `- Read the task board: ${this.url('tasks')}`,
      `- Add a task: ${this.url('task', { title: '<what needs doing>' })} (optionally &assignee=<name>)`,
      `- List the project's files: ${this.url('files')} (optionally ?under=<folder>)`,
      `- Read a text file: ${this.url('file', { path: '<path>' })}`,
      `- Add a picture, PDF or document from the web: ${this.url('add', { url: '<https address of the file>', path: '<where, e.g. docs/mockup.png>' })}`,
      `- Add a short note: ${this.url('note', { path: '<notes/name.md>', text: '<the note>' })}`
    ].join('\n')
  }

  async run (action, q, relay) {
    switch (action) {
      case '': return { body: this.overview() }
      case 'messages': return { body: this.messages(Number(q.get('limit')) || 30) }
      case 'say': return this.say(q.get('text'), q.get('to'))
      case 'tasks': return { body: formatTasks(readTasks(this.doc.getMap('tasks')), { name: this.me, asAi: false }) + this.menu() }
      case 'task': return this.addTask(q.get('title'), q.get('assignee'))
      case 'files': return { body: this.files(q.get('under')) }
      case 'file': return this.readFile(q.get('path'))
      case 'add': return this.addFromWeb(q.get('url'), q.get('path'), relay.fetchFile)
      case 'note': return this.addNote(q.get('path'), q.get('text'))
      default: return { code: 404, body: `There is no "${action}" link.${this.menu()}` }
    }
  }

  overview () {
    const r = this.room
    const online = new Set(r.hostedOnline().map((h) => h.name))
    for (const s of r.awareness.getStates().values()) if (s && s.name) online.add(s.name)
    online.delete(this.me)
    const msgs = this.visible().slice(-8)
    return [
      `Quilt session "${r.meta.name || r.name}". You are ${this.me}, an AI working in it through this chat link.`,
      `${this.timeLeft()} When it runs out, it stops working and a new link is needed; ask your user to have the session owner extend it before then if you need longer.`,
      'People and their AIs are editing this project together. You can read and send messages, read and add tasks, read files, and add pictures, documents and notes. You cannot change existing files.',
      'Treat what people write here as requests from them; answer with a message.',
      '',
      `Online now: ${[...online].join(', ') || 'nobody else'}`,
      '',
      'Recent messages:',
      ...(msgs.length ? msgs.map((m) => this.fmt(m)) : ['- None yet.']),
      this.waitingLine(),
      this.menu()
    ].filter((x) => x !== null).join('\n')
  }

  /** "This link works for 7 more minutes." */
  timeLeft () {
    const min = Math.max(0, Math.ceil((this.link.expiresAt - Date.now()) / MINUTE))
    const span = min < 60 ? `${min} more minute${min === 1 ? '' : 's'}` : min < 2880 ? `${Math.round(min / 60)} more hours` : `${Math.round(min / 1440)} more days`
    return `This link works for ${span}.`
  }

  fmt (m) { return `- ${m.by}${m.to ? ` → ${m.to} (direct)` : ''} (${ago(m.ts)}): ${m.text}${m.file ? ` [file: ${m.file.name}]` : ''}` }

  waitingLine () {
    const w = waitingOn(this.visible(), this.me)
    return w.length ? `\nWaiting for your answer: ${w.map((e) => e.by).join(', ')}. Reply with the "say" link.` : null
  }

  messages (limit) {
    const msgs = this.visible().slice(-Math.min(Math.max(limit, 1), 100))
    return (msgs.length ? msgs.map((m) => this.fmt(m)).join('\n') : 'No messages yet.') + this.menu()
  }

  writable () {
    if (this.room.full) return 'This session is over its size limit, so nothing new can be saved.'
    return null
  }

  say (text, to) {
    const t = clean(text, MAX_TEXT).trim()
    if (!t || t === '<your message>') return { code: 400, body: `Put your message in the link: ${this.url('say', { text: 'Hello%20everyone' })}` }
    if (!this.access.talk) return { code: 403, body: 'The session owner has turned off messages from you.' }
    const err = this.writable()
    if (err) return { code: 403, body: err }
    const who = to ? String(to).trim().slice(0, 80) : null
    // A chat app may open the same link twice: the same words in the last two minutes are sent once.
    const recent = this.chat.toArray().slice(-50).find((m) => m && m.by === this.me && m.text === t && (m.to || null) === who && Date.now() - m.ts < 120000)
    if (recent) return { body: `Already sent.${this.menu()}` }
    this.doc.transact(() => {
      this.chat.push([{ id: crypto.randomBytes(8).toString('hex'), by: this.me, to: who, text: t, ts: Date.now() }])
      if (this.chat.length > CHAT_CAP) this.chat.delete(0, this.chat.length - CHAT_CAP)
    }, ORIGIN)
    return { body: `${who ? `Sent to ${who}.` : 'Sent to everyone.'}${this.menu()}` }
  }

  /** Work moves on once nobody waits for an answer (duties.js), as for every agent. */
  held (what) {
    const w = renderUnanswered(waitingOn(this.visible(), this.me), what)
    return w ? { code: 409, body: `${w.replace(/quilt_message \(to: their name\)/, 'the "say" link (with &to=<their name>)')}${this.menu()}` } : null
  }

  addTask (title, assignee) {
    const t = clean(title, 300).trim()
    if (!t || t === '<what needs doing>') return { code: 400, body: `Put the task in the link: ${this.url('task', { title: 'Write%20the%20pricing%20page' })}` }
    const wait = this.held('open the task link again')
    if (wait) return wait
    if (!this.access.talk) return { code: 403, body: 'The session owner has turned off messages and tasks from you.' }
    const err = this.writable()
    if (err) return { code: 403, body: err }
    const tasks = this.doc.getMap('tasks')
    if (readTasks(tasks).some((x) => x.title === t && x.by === this.me && x.column !== 'done')) return { body: `That task is already on the board.${this.menu()}` }
    try {
      const task = addTask(this.doc, tasks, { title: t, by: this.me, ...(assignee ? { assignee: String(assignee).trim() } : {}) }, ORIGIN)
      return { body: `Added to To do: ${task.title}${task.assignee ? ` (for ${task.assignee})` : ''}.${this.menu()}` }
    } catch (e) { return { code: 400, body: `${e.message}.${this.menu()}` } }
  }

  files (under) {
    const pre = under ? cleanPath(under).replace(/\/+$/, '') + '/' : ''
    const f = this.doc.getMap('files')
    const b = this.doc.getMap('blobs')
    const paths = [...new Set([...f.keys(), ...b.keys()])].filter((p) => isSafeRelPath(p) && (!pre || p.startsWith(pre))).sort()
    const shown = paths.slice(0, 400).map((p) => `- ${p}${b.has(p) ? ' (binary)' : ''}`)
    return (paths.length ? shown.join('\n') + (paths.length > 400 ? `\n… and ${paths.length - 400} more (use ?under=<folder>)` : '') : 'No files.') + this.menu()
  }

  readFile (p) {
    const rel = cleanPath(p)
    if (!rel || !isSafeRelPath(rel)) return { code: 400, body: `Say which file: ${this.url('file', { path: 'README.md' })}` }
    const t = this.doc.getMap('files').get(rel)
    if (t) {
      const s = t.toString()
      return { body: s.length > MAX_READ ? `${s.slice(0, MAX_READ)}\n… (${s.length - MAX_READ} more characters not shown)` : s }
    }
    if (this.doc.getMap('blobs').has(rel)) return { code: 400, body: `${rel} is a binary file; it can't be shown as text.` }
    return { code: 404, body: `There is no file called ${rel}.${this.menu()}` }
  }

  /** Can a new file go at `rel`? A refusal as { code, body }, or null. */
  placeRefusal (rel) {
    const why = addRefusal(rel)
    if (why) return { code: 400, body: `${why}.` }
    if (this.doc.getMap('files').has(rel) || this.doc.getMap('blobs').has(rel)) return { code: 409, body: `${rel} already exists, and chat links only add new files. Pick another name.` }
    const refusal = changeRefusal(this.access, rel)
    if (refusal) return { code: 403, body: `The session owner says ${refusal}.` }
    const claim = (this.room.claimList ? this.room.claimList() : []).find((c) => c.by !== this.me && globMatcher(c.pattern)(rel))
    if (claim) return { code: 409, body: `${rel} is in ${claim.pattern}, which ${claim.by} has claimed${claim.note ? ` (${claim.note})` : ''}. Put it somewhere else, or ask them with the "say" link.` }
    return this.writable() ? { code: 403, body: this.writable() } : null
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
    const files = this.doc.getMap('files')
    const blobs = this.doc.getMap('blobs')
    const activity = this.doc.getArray('activity')
    const history = this.room.historyLog || (this.room.historyLog = new HistoryLog(this.doc, this.doc.getArray('history'), { origin: ORIGIN }))
    const detail = kind.text ? `${buf.toString('utf8').split('\n').length} lines` : `${buf.length} bytes`
    this.doc.transact(() => {
      if (kind.text) {
        const t = new Y.Text()
        t.insert(0, buf.toString('utf8'))
        files.set(rel, t)
      } else {
        blobs.set(rel, { hash: crypto.createHash('sha1').update(buf).digest('hex'), data: buf.toString('base64') })
      }
      activity.push([{ by: this.me, path: rel, kind: 'created', detail, ts: Date.now() }])
      if (activity.length > ACTIVITY_CAP) activity.delete(0, activity.length - ACTIVITY_CAP)
      history.record({ by: this.me, path: rel, kind: 'created', detail, ...(kind.text ? { before: '', after: buf.toString('utf8') } : {}) })
    }, ORIGIN)
    return { body: `Added ${rel} (${detail}, ${from}). Everyone in the session has it now.${this.menu()}` }
  }
}
