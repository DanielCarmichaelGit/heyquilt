// scripts/relay-api-secret.mjs: one new secret, the same for both Fly apps, never printed.
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { NO_SHELL_SCRIPTS } from '../helpers/platform.js'

const script = fileURLToPath(new URL('../../scripts/relay-api-secret.mjs', import.meta.url))

/** A stand-in for fly that records its arguments and stdin, and exits with `code` for `failApp`. */
function fakeFly (failApp = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-fakefly-'))
  const bin = path.join(dir, 'fly')
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs')
const input = fs.readFileSync(0, 'utf8')
fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.jsonl'))}, JSON.stringify({ args: process.argv.slice(2), input }) + '\\n')
process.exit(process.argv.includes(${JSON.stringify(failApp)}) ? 1 : 0)
`, { mode: 0o755 })
  const calls = () => fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  return { bin, calls }
}

test('stages one fresh secret on both apps and never prints it', { skip: NO_SHELL_SCRIPTS }, () => {
  const fly = fakeFly()
  const r = spawnSync(process.execPath, [script], { env: { ...process.env, FLY_BIN: fly.bin }, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const calls = fly.calls()
  assert.deepEqual(calls.map((c) => c.args), [['secrets', 'import', '--app', 'quilt-api', '--stage'], ['secrets', 'import', '--app', 'cowove-relay', '--stage']])
  const [a, b] = calls.map((c) => c.input)
  assert.match(a, /^RELAY_API_SECRET=[A-Za-z0-9_-]{43}\n$/)
  assert.equal(a, b, 'the same secret on both')
  const secret = a.trim().split('=')[1]
  assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), 'never printed')
  assert.match(r.stdout, /staged on quilt-api and cowove-relay/)
  const again = fakeFly()
  spawnSync(process.execPath, [script], { env: { ...process.env, FLY_BIN: again.bin } })
  assert.notEqual(again.calls()[0].input, a, 'a new secret every run')
})

test('a failed import stops with a non-zero exit and says to run it again', { skip: NO_SHELL_SCRIPTS }, () => {
  const fly = fakeFly('quilt-api')
  const r = spawnSync(process.execPath, [script], { env: { ...process.env, FLY_BIN: fly.bin }, encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /failed for quilt-api\. Run this again/)
  assert.equal(fly.calls().length, 1, 'the relay is not given a secret the API does not have')
})
