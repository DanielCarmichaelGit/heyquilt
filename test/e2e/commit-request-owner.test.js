// quilt_request_commit from a folder: an agent lists the files it changed and describes them,
// and the session owner's AI is told with a direct message that waits until the request is done.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer } from '../../src/server.js'
import { Session } from '../../src/session.js'
import { generateIdentity } from '../../src/identity.js'
import { startControl, call } from '../../src/control.js'
import { renderStatus } from '../../src/status.js'
import { PASS_KEYS, testPasses } from '../helpers/pass-helpers.js'

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-cro-home-'))
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-cro-${n}-`))
async function waitFor (fn, ms = 6000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}
const EDIT = { files: 'edit', folders: [], foldersExcept: [], talk: true }

test('an agent asks for a commit with its files and a description; the owner is told, once, until it is done', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, passPublicKey: PASS_KEYS.publicKey })
  const server = `ws://127.0.0.1:${srv.port}`
  const room = 'cro-1'
  const oid = generateIdentity()
  const ownerDir = tmp('owner')
  fs.writeFileSync(path.join(ownerDir, 'README.md'), 'hello\n')
  const owner = new Session({ dir: ownerDir, server, room, secret: 'e', viewSecret: 'v', name: 'Olive', identity: oid, passes: testPasses(oid, { name: 'Olive', sub: 'olive' }) })
  await owner.start({ waitTimeoutMs: 5000 })
  await waitFor(() => owner.isOwner)
  const gid = generateIdentity()
  const agent = new Session({ dir: tmp('agent'), server, room, secret: 'e', name: 'Gus', kind: 'agent', identity: gid, passes: testPasses(gid, { name: 'Gus', kind: 'agent', sub: 'gus', room, access: EDIT }) })
  await agent.start({ waitTimeoutMs: 5000 })
  await waitFor(() => agent.access?.state === 'approved' && agent.members.some((m) => m.role === 'owner' && m.name === 'Olive'))

  const ctl = await startControl(agent, { joined: true })
  const d = JSON.parse(fs.readFileSync(path.join(agent.stateDir, 'daemon.json'), 'utf8'))
  await assert.rejects(call(d, 'POST', '/commit-request', { message: 'x', files: ['../outside.js'] }), /not a path in the project/)
  await assert.rejects(call(d, 'POST', '/commit-request', { message: '  ', files: ['a.js'] }), /say what the commit is for/)
  const r = await call(d, 'POST', '/commit-request', { message: 'Blog page', description: 'Adds the blog index and post pages.', files: ['web/app/blog/page.js', './web/app/blog/page.js', 'web/lib/blog.js'] })
  assert.equal(r.notified, 'Olive')
  assert.deepEqual(r.files, ['web/app/blog/page.js', 'web/lib/blog.js'])
  assert.equal(r.description, 'Adds the blog index and post pages.')

  // The owner sees the request with its files, and one direct message that wakes their AI.
  await waitFor(() => owner.commitStatus().open.length === 1)
  assert.deepEqual(owner.commitStatus().open[0].files, ['web/app/blog/page.js', 'web/lib/blog.js'])
  assert.match(renderStatus(owner.status()), /Gus asked for a commit: Blog page\n {2}Files: web\/app\/blog\/page\.js, web\/lib\/blog\.js\n {2}Adds the blog index and post pages\./)
  const note = await waitFor(() => owner.chat.toArray().find((m) => m.kind === 'commit'))
  assert.deepEqual([note.by, note.to, note.commit], ['Gus', 'Olive', r.id])
  assert.match(note.text, /Commit requested \([0-9a-f]{12}\): Blog page\. Adds the blog index and post pages\. Files \(2\): web\/app\/blog\/page\.js, web\/lib\/blog\.js\./)
  const ev = await waitFor(() => owner.inbox().events.find((e) => e.commit === r.id))
  assert.equal(ev.kind, 'dm')
  assert.deepEqual(owner.duties().waiting.filter((w) => w.id === note.id), [], 'no reply owed: the owner\'s AI is not blocked on it')

  // A reply does not settle it; marking the request done does.
  owner.say('on it', { to: 'Gus' })
  assert.ok(owner.inbox().events.some((e) => e.commit === r.id), 'still waiting after a reply')
  owner.resolveCommitRequests({ ids: [r.id] })
  assert.equal(owner.inbox().events.some((e) => e.commit === r.id), false)

  // The owner asking for a commit tells nobody.
  const mine = owner.requestCommit('Owner change', { files: ['README.md'] })
  assert.equal(mine.notified, null)
  assert.equal(owner.chat.toArray().filter((m) => m.kind === 'commit').length, 1)

  await ctl.close()
  await agent.stop(); await owner.stop(); await srv.close()
})
