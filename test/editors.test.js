import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { installedEditors, openCommand, claudeCli, claudeSessionCommand, openIn } from '../src/editors.js'

const mac = (apps) => ({ platform: 'darwin', home: '/Users/me', exists: (p) => apps.includes(p) })

test('only installed apps are offered, from /Applications or ~/Applications', () => {
  const opts = mac(['/Applications/Claude.app', '/Users/me/Applications/Cursor.app'])
  assert.deepEqual(installedEditors(opts).map((e) => e.id), ['claude', 'cursor'])
})

test('Claude opens a new Claude Code session on the folder', () => {
  const [file, args] = openCommand('claude', '/Users/me/My Project', mac(['/Applications/Claude.app']))
  assert.equal(file, 'open')
  assert.deepEqual(args, ['claude://code/new?folder=%2FUsers%2Fme%2FMy%20Project'])
})

test('Cursor opens a classic window on the folder, not its Agents window', () => {
  const [file, args] = openCommand('cursor', '/Users/me/p', mac(['/Applications/Cursor.app']))
  assert.equal(file, '/Applications/Cursor.app/Contents/Resources/app/bin/cursor')
  assert.deepEqual(args, ['--classic', '--new-window', '/Users/me/p'])
})

test('Claude on Windows is found from a direct install, the Store package, or its link', () => {
  const base = 'C:\\Users\\me\\AppData\\Local'
  const win = { platform: 'win32', home: 'C:\\Users\\me', localAppData: base, protocols: () => false }
  const direct = path.join(base, 'Programs', 'Claude', 'Claude.exe')
  const pkg = path.join(base, 'Packages', 'Claude_pzs8sxrjxfjjc')
  assert.deepEqual(installedEditors({ ...win, exists: (p) => p === direct }).map((e) => e.id), ['claude'])
  assert.deepEqual(installedEditors({ ...win, exists: (p) => p === pkg }).map((e) => e.id), ['claude'])
  assert.deepEqual(installedEditors({ ...win, exists: () => false, protocols: (name) => name === 'claude' }).map((e) => e.id), ['claude'])
  assert.deepEqual(installedEditors({ ...win, exists: () => false }).map((e) => e.id), [])
  const [file, args] = openCommand('claude', 'C:\\Users\\me\\My Project', { ...win, exists: (p) => p === pkg })
  assert.equal(file, 'cmd')
  assert.deepEqual(args, ['/c', 'start', '""', `claude://code/new?folder=${encodeURIComponent('C:\\Users\\me\\My Project')}`])
})

test('on Windows Cursor opens through its CLI so the window comes forward', () => {
  const base = 'C:\\Users\\me\\AppData\\Local'
  const exe = path.join(base, 'Programs', 'cursor', 'Cursor.exe')
  const cli = path.join(base, 'Programs', 'cursor', 'resources', 'app', 'bin', 'cursor.cmd')
  const opts = { platform: 'win32', home: 'C:\\Users\\me', localAppData: base, exists: (p) => p === exe || p === cli }
  const [file, args, run] = openCommand('cursor', 'C:\\Users\\me\\My Project', opts)
  assert.equal(file, 'cmd.exe')
  assert.deepEqual(args, ['/c', 'start', '', cli, '--classic', '--new-window', 'C:\\Users\\me\\My Project'])
  assert.equal(run.activate, true)
})

test('other apps get the folder handed to them', () => {
  const [file, args] = openCommand('zed', '/Users/me/p', mac(['/Applications/Zed.app']))
  assert.equal(file, 'open')
  assert.deepEqual(args, ['-a', '/Applications/Zed.app', '/Users/me/p'])
})

test('unknown or missing apps are refused', () => {
  assert.throws(() => openCommand('rm -rf', '/x', mac([])), /Unknown app/)
  assert.throws(() => openCommand('zed', '/x', mac([])), /isn't installed/)
})

test('the Claude CLI is found on its own, or inside the Claude app', () => {
  const home = '/Users/me'
  const base = { platform: 'darwin', home, readdir: () => ['2.1.9', '2.1.281'] }
  assert.equal(claudeCli({ ...base, exists: (p) => p === '/Users/me/.local/bin/claude' }), '/Users/me/.local/bin/claude')
  const bundled = '/Users/me/Library/Application Support/Claude/claude-code/2.1.281/claude.app/Contents/MacOS/claude'
  assert.equal(claudeCli({ ...base, exists: (p) => p === bundled || p.includes('2.1.9/') }), bundled)
  assert.equal(claudeCli({ ...base, exists: () => false }), null)
})

test('a Claude session is made in the folder with a free local command', () => {
  const [file, args, opts] = claudeSessionCommand('/bin/claude', '/Users/me/Panorama', 'abc')
  assert.equal(file, '/bin/claude')
  assert.deepEqual(args, ['-p', '/rename Panorama (quilt)', '--session-id', 'abc'])
  assert.deepEqual(opts, { cwd: '/Users/me/Panorama' })
})

// A Claude CLI is installed both as the app bundle (for `locate`) and the free-standing
// binary at ~/.local/bin (for `claudeCli`), with an injectable `run` and `copy` so no real
// process is spawned.
const claudeInstalled = { ...mac(['/Applications/Claude.app']), exists: (p) => p === '/Applications/Claude.app' || p === '/Users/me/.local/bin/claude' }

test('sending a merge to Claude Code runs nothing: the prompt goes on the clipboard and the folder opens', async () => {
  const calls = []
  const run = async (file, args) => { calls.push({ file, args }) }
  const copied = []
  const copy = async (text) => { copied.push(text); return true }
  const result = await openIn('claude', '/Users/me/Panorama', { ...claudeInstalled, run, copy, prompt: 'Merge conflict' })
  assert.deepEqual(result, { copied: true })
  assert.deepEqual(copied, ['Merge conflict'])
  assert.deepEqual(calls.map((c) => c.file), ['open'], 'no claude command was run')
  assert.match(calls[0].args[0], /^claude:\/\/code\/new\?folder=/)
})

test('a send to an unknown or missing app is refused before anything reaches the clipboard', async () => {
  const copied = []
  const copy = async (text) => { copied.push(text); return true }
  const run = async () => { throw new Error('nothing should run') }
  await assert.rejects(openIn('nope', '/Users/me/p', { ...mac([]), run, copy, prompt: 'Merge conflict' }), /Unknown app/)
  await assert.rejects(openIn('zed', '/Users/me/p', { ...mac([]), run, copy, prompt: 'Merge conflict' }), /isn't installed/)
  await assert.rejects(openIn('claude', '/Users/me/p', { ...mac([]), run, copy, prompt: 'Merge conflict' }), /isn't installed/)
  assert.deepEqual(copied, [])
})

test('a send to another app copies the prompt, then opens the folder', async () => {
  const order = []
  const copy = async () => { order.push('copy'); return true }
  const run = async (file) => { order.push(`run ${file}`) }
  const r = await openIn('zed', '/Users/me/p', { ...mac(['/Applications/Zed.app']), run, copy, prompt: 'Merge conflict' })
  assert.deepEqual(r, { copied: true })
  assert.deepEqual(order, ['copy', 'run open'])
})
