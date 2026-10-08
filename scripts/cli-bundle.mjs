#!/usr/bin/env node
// Builds the Quilt command line for Linux machines without a desktop (servers, cloud
// machines, containers): dist/quilt-cli-linux-<arch>.tar.gz for x64 and arm64, plus
// dist/install.sh that fetches the right one. Each bundle carries its own Node.js, so the
// machine needs nothing installed: agents there get `quilt` and its MCP server.
//
//   node scripts/cli-bundle.mjs                 both architectures
//   node scripts/cli-bundle.mjs --arch x64      one
//
// Quilt's runtime dependencies are plain JavaScript, so one set of node_modules serves
// every architecture; only the Node.js binary differs. It is the version running this
// script, downloaded from nodejs.org and checked against its published SHA-256 sums.
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, currentVersion } from '../src/releases.js'

const args = process.argv.slice(2)
const pick = args.includes('--arch') ? [args[args.indexOf('--arch') + 1]] : ['x64', 'arm64']
for (const a of pick) if (!['x64', 'arm64'].includes(a)) throw new Error(`unknown architecture ${a}`)
const NODE = process.versions.node
const DIST = path.join(ROOT, 'dist')
const WORK = path.join(DIST, 'cli-work')
const APP_FILES = ['bin', 'src', 'assets', 'package.json', 'package-lock.json', 'RELEASES.md', 'LICENSE']

const sh = (cmd, a, opts = {}) => execFileSync(cmd, a, { stdio: ['ignore', 'pipe', 'inherit'], ...opts })
// curl, not fetch: it follows the machine's proxy settings, and every CI runner has it.
const download = (url, dest) => sh('curl', ['-fsSL', '--retry', '3', '-o', dest, url])
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(WORK, { recursive: true })

// The app itself, with its runtime dependencies only (no Electron, no build tools).
const app = path.join(WORK, 'app')
fs.mkdirSync(app)
for (const f of APP_FILES) fs.cpSync(path.join(ROOT, f), path.join(app, f), { recursive: true })
console.log(`installing runtime dependencies for Quilt ${currentVersion()}…`)
sh('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: app, stdio: ['ignore', 'inherit', 'inherit'] })

// Node's published checksums, to check each download against.
const sumsFile = path.join(WORK, 'SHASUMS256.txt')
download(`https://nodejs.org/dist/v${NODE}/SHASUMS256.txt`, sumsFile)
const sums = new Map(fs.readFileSync(sumsFile, 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+/).reverse()))

const LAUNCHER = `#!/bin/sh
# The Quilt command line, with its own Node.js (${NODE}).
here=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
exec "$here/node/bin/node" "$here/app/bin/quilt.js" "$@"
`

for (const arch of pick) {
  const name = `node-v${NODE}-linux-${arch}`
  const tarball = path.join(WORK, `${name}.tar.xz`)
  console.log(`downloading Node.js ${NODE} for linux-${arch}…`)
  download(`https://nodejs.org/dist/v${NODE}/${name}.tar.xz`, tarball)
  const want = sums.get(`${name}.tar.xz`)
  if (!want || sha256(tarball) !== want) throw new Error(`${name}.tar.xz does not match nodejs.org's checksum`)
  sh('tar', ['-xJf', tarball, '-C', WORK])

  // quilt/  quilt (launcher)  app/  node/bin/node  node/LICENSE
  const root = path.join(WORK, `stage-${arch}`, 'quilt')
  fs.mkdirSync(path.join(root, 'node', 'bin'), { recursive: true })
  fs.copyFileSync(path.join(WORK, name, 'bin', 'node'), path.join(root, 'node', 'bin', 'node'))
  fs.chmodSync(path.join(root, 'node', 'bin', 'node'), 0o755)
  fs.copyFileSync(path.join(WORK, name, 'LICENSE'), path.join(root, 'node', 'LICENSE'))
  fs.cpSync(app, path.join(root, 'app'), { recursive: true })
  fs.writeFileSync(path.join(root, 'quilt'), LAUNCHER, { mode: 0o755 })

  const out = path.join(DIST, `quilt-cli-linux-${arch}.tar.gz`)
  sh('tar', ['-czf', out, '-C', path.dirname(root), 'quilt'])
  console.log(`built ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)`)
}

fs.copyFileSync(path.join(ROOT, 'scripts', 'install.sh'), path.join(DIST, 'install.sh'))
console.log('copied dist/install.sh')
fs.rmSync(WORK, { recursive: true, force: true })
