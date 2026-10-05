import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('Notice renders a message query param as a success notice, and still has saved/error branches', () => {
  const src = fs.readFileSync(new URL('../components/Notice.js', import.meta.url), 'utf8')
  assert.match(src, /safeMessage\(q\?\.message\)/)
  assert.match(src, /<p className='notice'>\{m\}<\/p>/)
  assert.match(src, /<p className='notice'>Saved\.<\/p>/)
  assert.match(src, /<p className='notice bad'>\{e\}<\/p>/)
})
