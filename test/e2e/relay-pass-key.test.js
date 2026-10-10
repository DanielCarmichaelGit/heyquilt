// scripts/relay-pass-key.mjs: turns the API's published pass key into the line
// `fly secrets import` reads, and refuses anything that would crash the relay.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { newPassKeys } from '../../src/passes.js'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'relay-pass-key.mjs')
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-rpk-home-'))

/** A fake accounts API whose /v1/passes/key answers with `status` and `body`. */
async function fakeApi (t, status, body) {
  const seen = []
  const srv = http.createServer((req, res) => {
    seen.push(req.url)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => srv.close(resolve)))
  return { url: `http://127.0.0.1:${srv.address().port}`, seen }
}

function run (apiUrl) {
  const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, HOME, QUILT_API_URL: apiUrl } })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })))
}

test('prints the line fly secrets import reads, for a real Ed25519 key', async (t) => {
  const { publicKey } = newPassKeys()
  const api = await fakeApi(t, 200, { publicKey })
  const r = await run(api.url + '/')
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout, `QUILT_PASS_PUBLIC_KEY=${publicKey}\n`)
  assert.deepEqual(api.seen, ['/v1/passes/key'])
})

test('anything else prints nothing and exits non-zero, with a reason', async (t) => {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
  const cases = [
    [503, { error: 'passes are not set up on this server' }, /503/],
    [200, 'not json', /JSON/],
    [200, {}, /no public key/],
    [200, { publicKey: '' }, /no public key/],
    [200, { publicKey: 'undefined' }, /not an Ed25519 public key/],
    [200, { publicKey: rsa }, /not an Ed25519 public key/],
    [200, { publicKey: `${newPassKeys().publicKey}\nOTHER=1` }, /not an Ed25519 public key/]
  ]
  for (const [status, body, why] of cases) {
    const api = await fakeApi(t, status, body)
    const r = await run(api.url)
    assert.notEqual(r.code, 0, JSON.stringify(body))
    assert.equal(r.stdout, '', JSON.stringify(body))
    assert.match(r.stderr, why, JSON.stringify(body))
  }
  // Nothing listening.
  const gone = await run('http://127.0.0.1:9')
  assert.notEqual(gone.code, 0)
  assert.equal(gone.stdout, '')
  assert.match(gone.stderr, /Could not reach/)
})
