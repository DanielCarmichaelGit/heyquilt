import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ensureQuiltIgnored, ignoresQuilt } from '../../src/gitignore.js'

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-gi-${n}-`))
const gitFolder = () => { const dir = tmp('repo'); execFileSync('git', ['init', '-q'], { cwd: dir }); return dir }
const gi = (dir) => path.join(dir, '.gitignore')

test('a git folder with no .gitignore gets one that ignores .quilt/', () => {
  const dir = gitFolder()
  assert.deepEqual(ensureQuiltIgnored(dir), { added: true })
  assert.equal(fs.readFileSync(gi(dir), 'utf8'), "# Quilt keeps this session's local state here\n.quilt/\n")
  assert.deepEqual(ensureQuiltIgnored(dir), { added: false }, 'once is enough')
  assert.equal(execFileSync('git', ['check-ignore', '.quilt/state.json'], { cwd: dir, encoding: 'utf8' }).trim(), '.quilt/state.json')
})

test('the lines go after what is there, in its line endings, on a line of their own', () => {
  const dir = gitFolder()
  fs.writeFileSync(gi(dir), 'node_modules\r\ndist')
  ensureQuiltIgnored(dir)
  assert.equal(fs.readFileSync(gi(dir), 'utf8'), "node_modules\r\ndist\r\n# Quilt keeps this session's local state here\r\n.quilt/\r\n")
  const lf = gitFolder()
  fs.writeFileSync(gi(lf), 'node_modules\n')
  ensureQuiltIgnored(lf)
  assert.equal(fs.readFileSync(gi(lf), 'utf8'), "node_modules\n# Quilt keeps this session's local state here\n.quilt/\n")
})

test('a .gitignore that already ignores .quilt is left byte for byte', () => {
  for (const line of ['.quilt/', '.quilt', '/.quilt', '/.quilt/', '.quilt/  ']) {
    const dir = gitFolder()
    const text = `dist\r\n${line}\r\nbuild`
    fs.writeFileSync(gi(dir), text)
    assert.deepEqual(ensureQuiltIgnored(dir), { added: false }, line)
    assert.equal(fs.readFileSync(gi(dir), 'utf8'), text, line)
  }
  assert.equal(ignoresQuilt('.quilt/*\n# .quilt/\nfoo/.quilt\n'), false, 'only a line that ignores the folder itself')
  assert.equal(ignoresQuilt('  .quilt/\n'), false, 'leading spaces are part of git\'s pattern: "  .quilt/" is another name')
})

test('a folder without git is untouched', () => {
  const dir = tmp('plain')
  assert.deepEqual(ensureQuiltIgnored(dir), { added: false })
  assert.equal(fs.existsSync(gi(dir)), false)
})

test('a .gitignore that cannot be written is said, not thrown', { skip: process.getuid && process.getuid() === 0 }, () => {
  const dir = gitFolder()
  fs.writeFileSync(gi(dir), 'dist\n', { mode: 0o444 })
  const r = ensureQuiltIgnored(dir)
  assert.equal(r.added, false)
  assert.ok(r.error)
  assert.equal(fs.readFileSync(gi(dir), 'utf8'), 'dist\n')
})
