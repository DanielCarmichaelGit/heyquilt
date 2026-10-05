// Chat links: an AI with only a chat window works in a session by opening links. Runs a real
// relay and the owner's real session; the "web" a chat AI adds files from is a stand-in.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { makeChatLink, findChatLink, publicAddress, fetchPublicFile, addRefusal } from '../src/chat-links.js'

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-chat-home-'))
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-chat-${n}-`))
async function waitFor (fn, ms = 5000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}

// What the stand-in web serves.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake image body')])
const WEB = {
  'https://img.example/mockup.png': PNG,
  'https://evil.example/report.pdf': Buffer.from('<html><script>alert(1)</script></html>')
}
let srv, dana, danaDir, link
const open = async (action = '', params = '') => {
  const res = await fetch(`${link.url}${action ? `/${action}` : ''}${params ? `?${params}` : ''}`)
  return { status: res.status, text: await res.text(), headers: res.headers }
}

before(async () => {
  srv = await startServer({
    port: 0,
    host: '127.0.0.1',
    log: () => {},
    chatFetch: async (u) => { if (WEB[u]) return WEB[u]; throw new Error('the address answered 404') }
  })
  danaDir = tmp('dana')
  fs.mkdirSync(path.join(danaDir, 'src'))
  fs.writeFileSync(path.join(danaDir, 'README.md'), '# Project\n')
  fs.writeFileSync(path.join(danaDir, 'src', 'app.js'), 'console.log("hi")\n')
  dana = new Session({ dir: danaDir, server: `ws://127.0.0.1:${srv.port}`, room: 'chatroom', secret: 's3cret', viewSecret: 'v1ew', name: 'dana' })
  await dana.start({ waitTimeoutMs: 5000 })
  await waitFor(() => dana.isOwner)
  link = await dana.createChatLink({ name: 'ChatGPT' })
})

after(async () => {
  await dana?.stop()
  await srv?.close()
})

test('the owner makes a link; it opens to a page that says what the AI can do and lists the next links', async () => {
  assert.match(link.url, /^http:\/\/127\.0\.0\.1:\d+\/c\/chatroom\/[A-Za-z0-9_-]{32}$/)
  assert.equal(link.name, 'ChatGPT')
  const r = await open()
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow')
  assert.match(r.text, /^Quilt session "chatroom"\. You are ChatGPT/)
  assert.match(r.text, /You cannot change existing files/)
  assert.match(r.text, /Online now: dana/)
  for (const a of ['messages', 'say', 'tasks', 'task', 'files', 'file', 'add', 'note']) assert.ok(r.text.includes(`${link.url}/${a}`), a)
  // It is a member of the session, as itself.
  await waitFor(() => dana.members.some((m) => m.name === 'ChatGPT'))
  // A wrong token, or another room's, gets nothing.
  const bad = await fetch(link.url.replace(/[A-Za-z0-9_-]{32}$/, 'x'.repeat(32)))
  assert.equal(bad.status, 404)
  assert.match(await bad.text(), /not valid any more/)
})

test('the AI reads and sends messages; the same words opened twice are sent once', async () => {
  dana.say('hi chat, what do you think of the README?')
  await waitFor(async () => (await open('messages')).text.includes('what do you think'))
  assert.match((await open('say', 'text=Looks%20good%2C%20add%20a%20usage%20section')).text, /^Sent to everyone\./)
  await waitFor(() => dana.messages({ markRead: false }).some((m) => m.by === 'ChatGPT' && m.text === 'Looks good, add a usage section'))
  assert.match((await open('say', 'text=Looks%20good%2C%20add%20a%20usage%20section')).text, /^Already sent\./)
  assert.equal(dana.messages({ markRead: false }).filter((m) => m.by === 'ChatGPT').length, 1)
  assert.match((await open('say', 'to=dana&text=just%20for%20you')).text, /^Sent to dana\./)
  await waitFor(() => dana.messages({ markRead: false }).some((m) => m.by === 'ChatGPT' && m.to === 'dana'))
  assert.equal((await open('say')).status, 400, 'no text')
})

test('the AI reads the board and adds tasks', async () => {
  const added = await open('task', 'title=Write%20a%20usage%20section&assignee=dana')
  assert.match(added.text, /^Added to To do: Write a usage section \(for dana\)\./)
  const task = await waitFor(() => dana.taskList().find((t) => t.title === 'Write a usage section'))
  assert.equal(task.by, 'ChatGPT')
  assert.equal(task.column, 'todo')
  assert.match((await open('task', 'title=Write%20a%20usage%20section')).text, /already on the board/)
  assert.match((await open('tasks')).text, /Write a usage section/)
})

test('the AI lists and reads files, but cannot change them', async () => {
  const files = (await open('files')).text
  assert.match(files, /- README\.md/)
  assert.match(files, /- src\/app\.js/)
  assert.equal((await open('file', 'path=README.md')).text, '# Project\n')
  assert.equal((await open('file', 'path=../etc/passwd')).status, 400)
  assert.equal((await open('file', 'path=missing.md')).status, 404)
  // Adding over an existing file, or adding code, is refused.
  const over = await open('note', 'path=README.md&text=gone')
  assert.equal(over.status, 409)
  assert.match(over.text, /README\.md already exists, and chat links only add new files/)
  const code = await open('add', `url=${encodeURIComponent('https://img.example/mockup.png')}&path=src/evil.js`)
  assert.equal(code.status, 400)
  assert.match(code.text, /only pictures, documents and notes can be added/)
  assert.equal(fs.readFileSync(path.join(danaDir, 'README.md'), 'utf8'), '# Project\n')
})

test('the AI adds a picture from the web and a note; both land on the owner\'s disk', async () => {
  const r = await open('add', `url=${encodeURIComponent('https://img.example/mockup.png')}&path=docs/mockup.png`)
  assert.equal(r.status, 200, r.text)
  assert.match(r.text, /^Added docs\/mockup\.png \(\d+ bytes, from img\.example\)/)
  await waitFor(() => fs.existsSync(path.join(danaDir, 'docs', 'mockup.png')))
  assert.deepEqual(fs.readFileSync(path.join(danaDir, 'docs', 'mockup.png')), PNG)
  // Again at the same place: it exists now.
  assert.equal((await open('add', `url=${encodeURIComponent('https://img.example/mockup.png')}&path=docs/mockup.png`)).status, 409)
  // A web page dressed up as a PDF is refused for what it is.
  const fake = await open('add', `url=${encodeURIComponent('https://evil.example/report.pdf')}&path=docs/report.pdf`)
  assert.equal(fake.status, 400)
  assert.match(fake.text, /isn't a real \.pdf file/)
  assert.equal(fs.existsSync(path.join(danaDir, 'docs', 'report.pdf')), false)
  // A note.
  assert.match((await open('note', `path=notes/ideas.md&text=${encodeURIComponent('# Ideas\n- usage section')}`)).text, /^Added notes\/ideas\.md/)
  await waitFor(() => fs.existsSync(path.join(danaDir, 'notes', 'ideas.md')))
  assert.equal(fs.readFileSync(path.join(danaDir, 'notes', 'ideas.md'), 'utf8'), '# Ideas\n- usage section\n')
  // It shows in the chronology as the AI's.
  await waitFor(() => dana.historyQuery({ path: 'notes/ideas.md' }).some((e) => e.by === 'ChatGPT'))
})

test('a claimed folder, and a message waiting for an answer, hold the AI back like any agent', async () => {
  await dana.claim('design', 'redoing the design')
  assert.match((await open('note', 'path=design/a.md&text=x')).text, /design, which dana has claimed \(redoing the design\)/)
  await dana.release('design')
  dana.say('ChatGPT, before anything else: which logo do you prefer?', { to: 'ChatGPT' })
  const held = await waitFor(async () => { const r = await open('task', 'title=Pick%20a%20logo'); return r.status === 409 && r })
  assert.match(held.text, /dana sent you a direct message: "ChatGPT, before anything else/)
  assert.match(held.text, /the "say" link/)
  assert.match((await open()).text, /Waiting for your answer: dana/)
  await open('say', 'to=dana&text=The%20round%20one')
  assert.match((await open('task', 'title=Pick%20a%20logo')).text, /^Added to To do: Pick a logo/)
})

test('the owner\'s controls apply: messages off, then removing the member ends the link', async () => {
  const m = await waitFor(() => dana.members.find((x) => x.name === 'ChatGPT'))
  await dana.setMember(m.key, { access: { files: 'edit', folders: [], foldersExcept: [], talk: false } })
  await waitFor(async () => (await open('say', 'text=still%20here%3F')).status === 403)
  await dana.removeMember(m.key)
  const r = await open()
  assert.equal(r.status, 404)
  assert.match(r.text, /expired or the session owner removed it/)
})

test('only the owner can make a link', async () => {
  const other = { meta: { members: {}, identities: {} }, saveMeta () {} }
  const l = makeChatLink(other, { name: 'Grok', hours: 1 }, 1000)
  assert.ok(findChatLink(other, l.token, 2000), 'live')
  assert.equal(findChatLink(other, l.token, 1000 + 3600 * 1000 + 1), null, 'expired after its hours')
  assert.equal(other.meta.members[`chat:${l.id}`], undefined, 'and its member is gone with it')
  // Names never clash with someone already in the session.
  const room = { meta: { members: { a: { name: 'ChatGPT' } }, identities: { dana: 'k' } }, saveMeta () {} }
  assert.equal(makeChatLink(room, { name: 'ChatGPT' }).name, 'ChatGPT 2')
  assert.equal(makeChatLink(room, { name: 'dana' }).name, 'dana 2')
  // From a session that isn't the owner's: refused before asking the relay.
  const s = Object.create(Session.prototype)
  Object.assign(s, { conn: {}, access: { owner: false } })
  await assert.rejects(s.createChatLink({ name: 'x' }), /only the session owner/)
})

test('files come only from the public internet, and only things that are not code', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1']) assert.equal(publicAddress(ip), false, ip)
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:808:808']) assert.equal(publicAddress(ip), true, ip)
  await assert.rejects(fetchPublicFile('http://img.example/a.png'), /only https/)
  await assert.rejects(fetchPublicFile('https://user:pw@img.example/a.png'), /user name or password/)
  const toLocal = (host, opts, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }])
  await assert.rejects(fetchPublicFile('https://sneaky.example/a.png', { lookup: toLocal }), /not on the public internet/)
  const mixed = (host, opts, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }])
  await assert.rejects(fetchPublicFile('https://sneaky.example/a.png', { lookup: mixed }), /not on the public internet/)
  for (const p of ['src/app.js', 'run.sh', 'a.html', 'Makefile', '.github/x.png', 'x/.env.md']) assert.ok(addRefusal(p), p)
  for (const p of ['docs/a.png', 'b.pdf', 'notes/c.md', 'd.xlsx', 'e.svg']) assert.equal(addRefusal(p), null, p)
})
