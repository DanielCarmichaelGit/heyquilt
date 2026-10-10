import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BIN = fileURLToPath(new URL('../../bin/quilt.js', import.meta.url))

// Runs `quilt api ...` until it prints `until` (or exits), then stops it.
function run (args, env = {}, until = /listening/) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-api-cli-'))
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SUPABASE_|AGENT_KEY_SECRET|QUILT_|SMTP_)/.test(k)))
  const child = spawn(process.execPath, [BIN, 'api', ...args], { env: { ...clean, HOME: home, ...env } })
  let out = ''
  return new Promise((resolve) => {
    const done = (code) => { child.kill(); resolve({ out, code }) }
    const onData = (d) => { out += d; if (until.test(out)) done(null) }
    child.stdout.on('data', onData); child.stderr.on('data', onData)
    child.on('exit', (code) => resolve({ out, code }))
    setTimeout(() => done('timeout'), 10_000)
  })
}

test('quilt api --memory listens on localhost only, since anyone can use "Bearer local"', async () => {
  const { out } = await run(['--memory', '--port', '0'])
  assert.match(out, /listening on http:\/\/127\.0\.0\.1:\d+/)
})

test('quilt api --memory --host still lets you choose the address', async () => {
  const { out } = await run(['--memory', '--port', '0', '--host', '0.0.0.0'])
  assert.match(out, /listening on http:\/\/0\.0\.0\.0:\d+/)
})

const prodEnv = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', QUILT_SITE_URL: 'https://quilt.test', SMTP_URL: 'smtp://u:p@127.0.0.1:2525', SMTP_FROM: 'Quilt <invites@quilt.test>', PASS_SIGNING_KEY: 'MC4CAQAwBQYDK2VwBCIEIGbPaRjDSS1hZHoyOjotVXoczXIIBtFMCGfNWWMCOmba' }

test('quilt api starts without AGENT_KEY_SECRET: agents hold their own keys now', async () => {
  const { out } = await run(['--port', '0', '--host', '127.0.0.1'], prodEnv)
  assert.match(out, /listening on/)
})

test('quilt api refuses to start without SMTP settings, since invites need email', async () => {
  for (const k of ['SMTP_URL', 'SMTP_FROM']) {
    const env = { ...prodEnv }
    delete env[k]
    const { out, code } = await run(['--port', '0'], env)
    assert.equal(code, 1, k)
    assert.match(out, new RegExp(`${k} is not set`))
  }
})
