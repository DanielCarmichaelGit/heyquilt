// The in-app updater: picks the installer from the URL, downloads it with progress,
// and swaps a macOS app bundle in place.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { updateFileName, bundlePath, download, swapBundle, findApp, installUpdate } from '../../desktop/updater.js'
import { NO_POSIX_MODES } from '../helpers/platform.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-updater-'))

test('updateFileName takes the installer name from the download URL', () => {
  assert.equal(updateFileName('https://github.com/x/releases/latest/download/quilt-mac-arm64.dmg'), 'quilt-mac-arm64.dmg')
  assert.equal(updateFileName('https://github.com/x/releases/latest/download/quilt-windows-x64.exe?x=1'), 'quilt-windows-x64.exe')
  assert.equal(updateFileName('https://github.com/x/releases/latest/download/quilt-linux-x86_64.AppImage'), 'quilt-linux-x86_64.AppImage')
  assert.equal(updateFileName('https://github.com/x/releases/latest'), null)
  assert.equal(updateFileName('https://github.com/x/releases/latest/download/..%2Fevil.dmg'), null)
})

test('bundlePath finds the .app a macOS executable lives in', () => {
  assert.equal(bundlePath('/Applications/Quilt.app/Contents/MacOS/Quilt'), '/Applications/Quilt.app')
  assert.equal(bundlePath('/Users/me/Quilt.app/Contents/Frameworks/x.app/Contents/MacOS/x'), '/Users/me/Quilt.app')
  assert.equal(bundlePath('/usr/local/bin/node'), null)
})

test('download writes the file and reports progress', async () => {
  const body = Buffer.alloc(100_000, 7)
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-length': body.length }); res.end(body) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const dest = path.join(tmp(), 'sub', 'file.bin')
    const seen = []
    await download(`http://127.0.0.1:${srv.address().port}/file.bin`, dest, { onProgress: (p) => seen.push(p) })
    assert.ok(fs.readFileSync(dest).equals(body))
    assert.ok(!fs.existsSync(`${dest}.part`))
    assert.ok(seen.length >= 1)
    assert.deepEqual(seen.at(-1), { received: body.length, total: body.length })
  } finally { srv.close() }
})

test('download fails on an error status', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(404); res.end('no') })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    await assert.rejects(download(`http://127.0.0.1:${srv.address().port}/x`, path.join(tmp(), 'x')), /404/)
  } finally { srv.close() }
})

test('swapBundle puts the new bundle where the old one was and removes the old one', () => {
  const dir = tmp()
  const current = path.join(dir, 'Quilt.app'); const fresh = path.join(dir, 'Quilt.app.new')
  fs.mkdirSync(path.join(current, 'Contents'), { recursive: true }); fs.writeFileSync(path.join(current, 'Contents', 'v'), 'old')
  fs.mkdirSync(path.join(fresh, 'Contents'), { recursive: true }); fs.writeFileSync(path.join(fresh, 'Contents', 'v'), 'new')
  swapBundle(current, fresh)
  assert.equal(fs.readFileSync(path.join(current, 'Contents', 'v'), 'utf8'), 'new')
  assert.deepEqual(fs.readdirSync(dir), ['Quilt.app'])
})

test('swapBundle restores the old bundle when the new one cannot be moved in', () => {
  const dir = tmp()
  const current = path.join(dir, 'Quilt.app')
  fs.mkdirSync(path.join(current, 'Contents'), { recursive: true }); fs.writeFileSync(path.join(current, 'Contents', 'v'), 'old')
  assert.throws(() => swapBundle(current, path.join(dir, 'missing.app')))
  assert.equal(fs.readFileSync(path.join(current, 'Contents', 'v'), 'utf8'), 'old')
  assert.deepEqual(fs.readdirSync(dir), ['Quilt.app'])
})

test('findApp wants exactly one .app', () => {
  const dir = tmp()
  assert.throws(() => findApp(dir), /no app/)
  fs.mkdirSync(path.join(dir, 'Quilt.app'))
  assert.equal(findApp(dir), path.join(dir, 'Quilt.app'))
  fs.mkdirSync(path.join(dir, 'Other.app'))
  assert.throws(() => findApp(dir), /more than one/)
})

test('installUpdate refuses URLs without an installer and platforms it cannot update', async () => {
  await assert.rejects(installUpdate('https://github.com/x/releases/latest', { tempDir: tmp() }), /no installer/)
  await assert.rejects(installUpdate('https://x/quilt-mac-arm64.dmg', { platform: 'freebsd', tempDir: tmp() }), /Mac, Windows and Linux/)
  await assert.rejects(installUpdate('https://x/quilt-linux-x86_64.AppImage', { platform: 'linux', appImage: '', tempDir: tmp() }), /only when it runs as an AppImage/)
})

test('on Linux, the new AppImage takes the running one\'s place, runnable', { skip: NO_POSIX_MODES }, async () => {
  const body = Buffer.from('#!/bin/sh\necho new quilt\n')
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-length': body.length }); res.end(body) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const dir = tmp()
    const appImage = path.join(dir, 'Quilt.AppImage')
    fs.writeFileSync(appImage, 'old', { mode: 0o755 })
    const phases = []
    const next = await installUpdate(`http://127.0.0.1:${srv.address().port}/quilt-linux-x86_64.AppImage`, { platform: 'linux', appImage, tempDir: tmp(), onProgress: (p) => phases.push(p.phase) })
    assert.equal(next, 'relaunch')
    assert.deepEqual(fs.readFileSync(appImage), body)
    assert.equal(fs.statSync(appImage).mode & 0o111, 0o111, 'executable')
    assert.ok(phases.includes('installing'))
    assert.deepEqual(fs.readdirSync(dir), ['Quilt.AppImage'], 'nothing left beside it')
  } finally { srv.close() }
})
