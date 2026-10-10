import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { homeEnv } from '../helpers/home.js'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'quilt.js')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-home-'))
const env = homeEnv(home)

const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

test('quilt stop shuts down a running relay', async (t) => {
  const relay = spawn(process.execPath, [BIN, 'serve', '--port', '0', '--data', path.join(home, 'data')], { env, stdio: 'ignore' })
  const exited = new Promise((resolve) => relay.on('exit', resolve))
  // A failed step must not leave the relay running: it would keep this file (and the run) alive.
  t.after(() => { if (relay.exitCode === null) relay.kill() })
  const procs = path.join(home, '.quilt', 'procs')
  await waitFor(() => fs.existsSync(path.join(procs, `${relay.pid}.json`)))

  const out = execFileSync(process.execPath, [BIN, 'stop'], { env, encoding: 'utf8' })
  assert.match(out, new RegExp(`relay on :\\d+ \\(pid ${relay.pid}\\)`))
  await exited
  assert.deepEqual(fs.readdirSync(procs), [], 'registry is cleaned up')

  const again = execFileSync(process.execPath, [BIN, 'stop'], { env, encoding: 'utf8' })
  assert.match(again, /nothing to stop/)
})

test('stale registry entries are ignored and removed', async () => {
  const procs = path.join(home, '.quilt', 'procs')
  fs.mkdirSync(procs, { recursive: true })
  fs.writeFileSync(path.join(procs, '999999.json'), JSON.stringify({ pid: 999999, kind: 'relay', port: 1, startedAt: 0 }))
  const { listProcesses } = await import('../../src/procs.js')
  process.env.HOME = process.env.USERPROFILE = home
  assert.deepEqual(listProcesses(), [])
  assert.equal(fs.existsSync(path.join(procs, '999999.json')), false)
})

test('registry entries are private, and runningAppUrl prefers the desktop app', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-home-'))
  const procs = path.join(dir, '.quilt', 'procs')
  fs.mkdirSync(procs, { recursive: true })
  // Two live "apps": this test process stands in for both pids (alive), plus a dead one.
  const me = process.pid
  fs.writeFileSync(path.join(procs, `${me}.json`), JSON.stringify({ pid: me, kind: 'app', url: 'http://127.0.0.1:1/?t=cli', startedAt: 1 }))
  const parent = process.ppid
  fs.writeFileSync(path.join(procs, `${parent}.json`), JSON.stringify({ pid: parent, kind: 'app', url: 'http://127.0.0.1:2/?t=desk', desktop: true, startedAt: 2 }))
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', "import { runningAppUrl } from './src/procs.js'; console.log(runningAppUrl())"], { env: homeEnv(dir), encoding: 'utf8' })
  assert.equal(out.trim(), 'http://127.0.0.1:2/?t=desk')

  const reg = execFileSync(process.execPath, ['--input-type=module', '-e', "import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import { registerProcess } from './src/procs.js'; registerProcess('app', { url: 'x' }); console.log((fs.statSync(path.join(os.homedir(), '.quilt', 'procs', process.pid + '.json')).mode & 0o777).toString(8))"], { env: homeEnv(dir), encoding: 'utf8' })
  // Windows has no POSIX modes: every file reads back as 666 there.
  if (process.platform !== 'win32') assert.equal(reg.trim(), '600')
})
