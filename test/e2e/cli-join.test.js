// `quilt join` signs in to the relay with this computer's account (or a saved
// agent's keys), and won't start without one.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startTestApi, linkDevice, API_URL } from '../helpers/api-helpers.js'
import { startServer } from '../../src/server.js'
import { newPassKeys } from '../../src/passes.js'
import { loadIdentity } from '../../src/identity.js'
import { saveAccount } from '../../src/account.js'
import { agentJoin } from '../../src/agent-join.js'
import { encodeInvite } from '../../src/runner.js'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'quilt.js')
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-cli-join-${n}-`))
async function waitFor (fn, ms = 8000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await new Promise((resolve) => setTimeout(resolve, 50)) }
  throw new Error('timed out')
}
const KEYS = newPassKeys()
let t, relay
before(async () => {
  t = await startTestApi({ passKey: KEYS.privateKey })
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: KEYS.publicKey })
})
after(async () => { await relay.close(); await t.close() })

const envFor = (home) => ({ ...process.env, HOME: home, QUILT_API_URL: t.api.url, QUILT_SERVER: `ws://127.0.0.1:${relay.port}` })

/** Runs `quilt join` until it prints an invite link (or exits). */
function join (args, home, cwd = tmp('proj')) {
  const child = spawn(process.execPath, [BIN, 'join', ...args], { cwd, env: envFor(home) })
  let out = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('join did not start:\n' + out)) }, 15000)
    const onData = (d) => {
      out += d
      if (/\/join\/\S+#/.test(out)) { clearTimeout(timer); resolve({ child, out }) }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => { clearTimeout(timer); resolve({ child, out, code }) })
  })
}
const stop = (child) => new Promise((resolve) => {
  if (child.exitCode !== null) return resolve()
  child.on('exit', resolve)
  child.kill('SIGTERM')
})
const inRelay = () => [...relay.rooms.values()].flatMap((r) => [...r.access.values()].map((a) => [a.name, a.kind]))

test('without signing in, quilt join says to run quilt login first', async () => {
  const r = await join([], tmp('home'))
  assert.equal(r.code, 1)
  assert.match(r.out, /Run quilt login first\./)
})

test('a signed-in computer joins under its account name', async () => {
  const home = tmp('home')
  const identity = loadIdentity(path.join(home, '.quilt', 'identity.json'))
  const { token } = await linkDevice(t, 'mem', identity)
  saveAccount({ token, account: { id: 'mem', name: 'Mo', email: 'mo@acme.com' }, signedInAt: Date.now() }, path.join(home, '.quilt', 'account.json'))
  const { child, out } = await join([], home)
  try {
    assert.match(out, /as "Mo"/)
    await waitFor(() => inRelay().some(([n, k]) => n === 'Mo' && k === 'human'))
  } finally { await stop(child) }
})

test('quilt join --agent joins as a saved agent', async () => {
  const home = tmp('home')
  const link = (await t.call('POST', '/v1/agent-invites', {}, 'mem')).body.link.replace(API_URL, t.api.url)
  await agentJoin({ link, name: 'helper', dir: path.join(home, '.quilt'), log: () => {} })
  const { child, out } = await join(['--agent', 'helper'], home)
  try {
    assert.match(out, /as "helper"/)
    await waitFor(() => inRelay().some(([n, k]) => n === 'helper' && k === 'agent'))
  } finally { await stop(child) }
})

test("quilt join --agent in a person's folder syncs the agent's own copy and leaves theirs alone", async () => {
  const home = tmp('home')
  const link = (await t.call('POST', '/v1/agent-invites', {}, 'mem')).body.link.replace(API_URL, t.api.url)
  await agentJoin({ link, name: 'grok-bot', dir: path.join(home, '.quilt'), log: () => {} })
  // Mo's own folder for the room, from the app: saved, not being synced right now.
  const mine = tmp('mine')
  fs.mkdirSync(path.join(mine, '.quilt'))
  fs.writeFileSync(path.join(mine, 'notes.md'), 'mine\n')
  const saved = { server: `ws://127.0.0.1:${relay.port}`, room: 'elegy', secret: 's3cret', name: 'Mo', tool: 'Cursor', kind: 'human' }
  fs.writeFileSync(path.join(mine, '.quilt', 'config.json'), JSON.stringify(saved))
  const invite = encodeInvite({ server: `ws://127.0.0.1:${relay.port}`, room: 'elegy', secret: 's3cret' })
  const copy = path.join(home, 'quilt', 'quilt-elegy-grok-bot')
  const { child, out } = await join(['--agent', 'grok-bot', invite], home, mine)
  try {
    // Before: the agent synced Mo's folder itself, as the agent, which hid it from the app's
    // Recent list and made Rejoin fail with "already being synced" until the agent left.
    assert.match(out, new RegExp(`${mine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is a person's own copy of a session on this computer and stays theirs: syncing ${copy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} instead`))
    assert.match(out, /as "grok-bot"/)
    await waitFor(() => inRelay().some(([n, k]) => n === 'grok-bot' && k === 'agent'))
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(mine, '.quilt', 'config.json'), 'utf8')), saved, "Mo's saved session is untouched")
    assert.equal(fs.existsSync(path.join(mine, '.quilt', 'daemon.json')), false, 'nothing runs in her folder')
    assert.equal(JSON.parse(fs.readFileSync(path.join(copy, '.quilt', 'config.json'), 'utf8')).kind, 'agent')
    const recent = JSON.parse(fs.readFileSync(path.join(home, '.quilt', 'recent.json'), 'utf8'))
    assert.deepEqual(recent.map((r) => r.dir), [copy], "only the agent's copy was remembered, and that stays out of the app's list")
  } finally { await stop(child) }
})

test('quilt invite prints nothing for a session on a relay Quilt no longer supports', async () => {
  const { spawnSync } = await import('node:child_process')
  const invite = (server) => {
    const dir = tmp('saved')
    fs.mkdirSync(path.join(dir, '.quilt'))
    fs.writeFileSync(path.join(dir, '.quilt', 'config.json'), JSON.stringify({ server, room: 'room-old', secret: 's' }))
    return spawnSync(process.execPath, [BIN, 'invite'], { cwd: dir, env: envFor(tmp('home')), encoding: 'utf8' })
  }
  for (const server of ['wss://quiet-fox.trycloudflare.com', 'ws://192.168.1.4:4321']) {
    const r = invite(server)
    assert.equal(r.status, 1, server)
    assert.equal(r.stdout, '', server)
    assert.match(r.stderr, /ran on your computer's own relay, which Quilt no longer supports/, server)
  }
  const ok = invite('wss://relay.heyquilt.com')
  assert.equal(ok.status, 0)
  assert.equal(ok.stdout.trim(), 'https://join.heyquilt.com/room-old#s')
})
