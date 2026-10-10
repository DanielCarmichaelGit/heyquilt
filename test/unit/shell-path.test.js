import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mergePath, pathFromOutput, loginShellPath, adoptLoginShellPath } from '../../src/shell-path.js'

test('mergePath puts the shell\'s PATH first, keeps the current one after, each directory once, in order', () => {
  if (path.delimiter !== ':') return // the POSIX cases; Windows is below
  assert.equal(
    mergePath('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', '/usr/bin:/bin:/usr/sbin:/sbin'),
    '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  )
  assert.equal(mergePath('/a::/b:/a', '/b:/c'), '/a:/b:/c:/usr/bin', 'empty entries and repeats dropped; /usr/bin kept')
  assert.equal(mergePath(null, '/usr/bin:/bin'), '/usr/bin:/bin', 'no shell PATH: the current one as it is')
  assert.equal(mergePath('', ''), '/usr/bin')
})

test('pathFromOutput reads the PATH between the markers, whatever the shell printed around it', () => {
  assert.equal(pathFromOutput('Welcome!\n__QUILT_PATH__/x:/y__QUILT_PATH__\n'), '/x:/y')
  assert.equal(pathFromOutput('nothing here'), null)
})

test('loginShellPath reads a shell\'s PATH, and gives up on one that does not answer in time', { skip: process.platform === 'win32' }, async () => {
  assert.ok((await loginShellPath({ shell: '/bin/sh' }) || '').includes('/'))
  const slow = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-shell-')), 'slow-shell')
  fs.writeFileSync(slow, '#!/bin/sh\nsleep 5\n', { mode: 0o755 })
  const started = Date.now()
  assert.equal(await loginShellPath({ shell: slow, timeoutMs: 200 }), null)
  assert.ok(Date.now() - started < 2000)
})

test('on Windows the PATH is left as it is: split on ";", and no /usr/bin', async () => {
  assert.equal(mergePath(null, 'C:\\Windows;C:\\Program Files\\Git\\cmd;C:\\Windows', ';'), 'C:\\Windows;C:\\Program Files\\Git\\cmd')
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  const before = process.env.PATH
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    process.env.PATH = 'C:\\Windows;C:\\Program Files\\Git\\cmd'
    assert.equal(await adoptLoginShellPath(), 'C:\\Windows;C:\\Program Files\\Git\\cmd')
    assert.equal(process.env.PATH, 'C:\\Windows;C:\\Program Files\\Git\\cmd')
  } finally {
    Object.defineProperty(process, 'platform', platform)
    process.env.PATH = before
  }
})
