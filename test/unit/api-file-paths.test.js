import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanFilePath, parentOf, nameOf, mimeOf, isTextual, contentDisposition } from '../../src/api/file-paths.js'

test('cleanFilePath normalises and refuses the bad ones', () => {
  assert.equal(cleanFilePath(' cuts/teaser.mp4 '), 'cuts/teaser.mp4')
  assert.equal(cleanFilePath('/a//b/'), 'a/b')
  for (const bad of ['', '   ', 'a/../b', '.', 'a/./b', 'a\\b', 'a\u0000b', 'x'.repeat(501)]) assert.throws(() => cleanFilePath(bad), /400|path/i, JSON.stringify(bad))
})

test('parentOf and nameOf', () => {
  assert.equal(parentOf('cuts/v1/teaser.mp4'), 'cuts/v1')
  assert.equal(parentOf('teaser.mp4'), '')
  assert.equal(nameOf('cuts/v1/teaser.mp4'), 'teaser.mp4')
})

test('mimeOf and isTextual', () => {
  assert.equal(mimeOf('a.PNG'), 'image/png')
  assert.equal(mimeOf('a.mp4'), 'video/mp4')
  assert.equal(mimeOf('a.md'), 'text/markdown')
  assert.equal(mimeOf('a.csv'), 'text/csv')
  assert.equal(mimeOf('a.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assert.equal(mimeOf('a.unknownext'), 'application/octet-stream')
  assert.equal(isTextual('text/csv'), true)
  assert.equal(isTextual('application/json'), true)
  assert.equal(isTextual('video/mp4'), false)
})

test('contentDisposition keeps any name as a header: an ASCII fallback plus the UTF-8 name', () => {
  assert.equal(contentDisposition('inline', 'hello.txt'), `inline; filename="hello.txt"; filename*=UTF-8''hello.txt`)
  const h = contentDisposition('attachment', 'Shot 9.41\u202fPM \u{1F3AC} "x" (1).png')
  assert.equal(h, `attachment; filename="Shot 9.41_PM _ _x_ (1).png"; filename*=UTF-8''Shot%209.41%E2%80%AFPM%20%F0%9F%8E%AC%20%22x%22%20%281%29.png`)
  assert.equal(/^[\x20-\x7e]*$/.test(h), true, 'nothing outside printable ASCII')
  assert.equal(contentDisposition('inline', 'a\r\nb\\c'), `inline; filename="a__b_c"; filename*=UTF-8''a%0D%0Ab%5Cc`)
})
