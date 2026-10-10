// Agents are told when their Quilt (their image) is behind the newest release.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { updateNotice, validImage, UpdateCheck, UPDATE_HOW } from '../../src/update-check.js'

test('an older image is told to update; a current or newer one, or junk, is not', () => {
  assert.equal(updateNotice('0.3.3', '0.3.4'), `You must update your app: you run Quilt 0.3.3 and 0.3.4 is out. ${UPDATE_HOW}`)
  assert.equal(updateNotice('v0.3.3', 'v0.3.10'), `You must update your app: you run Quilt 0.3.3 and 0.3.10 is out. ${UPDATE_HOW}`)
  assert.equal(updateNotice('0.3.4', '0.3.4'), '')
  assert.equal(updateNotice('0.4.0', '0.3.4'), '')
  assert.equal(updateNotice('', '0.3.4'), '')
  assert.equal(updateNotice('latest', '0.3.4'), '')
  assert.equal(updateNotice('0.3.3', ''), '')
  assert.ok(validImage('1.2.3') && validImage('v1.2.3') && !validImage('1.2') && !validImage('1.2.3-beta'))
})

test('UpdateCheck starts from its own version, learns a newer release, and answers for any image', async () => {
  let answer = null
  const uc = new UpdateCheck({ mine: '0.3.4', fetchLatest: async () => answer })
  assert.equal(uc.latest(), '0.3.4')
  assert.equal(uc.notice(), '')
  assert.equal(uc.describe(), 'Quilt 0.3.4 is current (the newest release is 0.3.4).')
  assert.equal(uc.describe('0.3.1'), `You must update your app: you run Quilt 0.3.1 and 0.3.4 is out. ${UPDATE_HOW}`)
  answer = { version: '0.3.2' } // older than us: ignored
  assert.equal(await uc.refresh(), '0.3.4')
  answer = { version: '0.5.0' }
  assert.equal(await uc.refresh(), '0.5.0')
  assert.match(uc.notice(), /you run Quilt 0\.3\.4 and 0\.5\.0 is out/)
  assert.match(uc.describe('v0.5.0'), /Quilt 0\.5\.0 is current/)
  assert.match(uc.describe('yesterday'), /^"yesterday" is not a Quilt version \(expected something like 0\.5\.0\)\. You must update your app/)
  const broken = new UpdateCheck({ mine: '0.3.4', fetchLatest: async () => { throw new Error('offline') } })
  assert.equal(await broken.refresh(), '0.3.4', 'a failed check keeps what it knows')
})
