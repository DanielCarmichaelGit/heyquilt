import { test } from 'node:test'
import assert from 'node:assert/strict'
import { downloadFor, pickDownloads, detectDownloads, DOWNLOADS } from '../lib/platform.js'

test('the right download for each system', () => {
  assert.equal(downloadFor('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'), DOWNLOADS.macArm, 'Macs report "Intel" even on Apple silicon; offer Apple silicon (most Macs now)')
  assert.equal(downloadFor('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), DOWNLOADS.windows)
  assert.equal(downloadFor('Mozilla/5.0 (X11; Linux x86_64)'), DOWNLOADS.linux)
  assert.equal(downloadFor('Mozilla/5.0 (Linux; Android 14; Pixel 8)'), null, 'no app for phones')
  assert.equal(downloadFor(''), null)
  assert.match(DOWNLOADS.windows.href, /^https:\/\/github\.com\/DanielCarmichaelGit\/heyquilt\/releases\/latest\/download\/quilt-windows-x64\.exe$/)
})

test('pickDownloads: Mac, Apple silicon', () => {
  const { primary, others } = pickDownloads({ platform: 'macOS', architecture: 'arm' })
  assert.deepEqual(primary, [DOWNLOADS.macArm])
  assert.deepEqual(others, [DOWNLOADS.macIntel, DOWNLOADS.windows])
})

test('pickDownloads: Mac, Intel', () => {
  const { primary, others } = pickDownloads({ platform: 'macOS', architecture: 'x86' })
  assert.deepEqual(primary, [{ ...DOWNLOADS.macIntel, label: 'Download for Mac' }])
  assert.deepEqual(others, [DOWNLOADS.macArm, DOWNLOADS.windows])
})

test('pickDownloads: Windows', () => {
  const { primary, others } = pickDownloads({ platform: 'Windows', architecture: 'x86' })
  assert.deepEqual(primary, [DOWNLOADS.windows])
  assert.deepEqual(others, [DOWNLOADS.macArm, DOWNLOADS.linux])
})

test('pickDownloads: Linux gets the AppImage for its processor', () => {
  const x86 = pickDownloads({ platform: 'Linux', architecture: 'x86' })
  assert.deepEqual(x86.primary, [DOWNLOADS.linux])
  assert.deepEqual(x86.others, [DOWNLOADS.linuxArm, DOWNLOADS.macArm, DOWNLOADS.windows])
  assert.deepEqual(pickDownloads({ platform: 'Linux', architecture: 'arm' }).primary, [DOWNLOADS.linuxArm])
  assert.deepEqual(pickDownloads({ ua: 'Mozilla/5.0 (X11; Linux aarch64)' }).primary, [DOWNLOADS.linuxArm])
  assert.match(DOWNLOADS.linux.href, /\/quilt-linux-x86_64\.AppImage$/)
})

test('pickDownloads: unknown (empty input) falls back to both, and a UA string still helps', () => {
  assert.deepEqual(pickDownloads({}).primary, [DOWNLOADS.macArm, DOWNLOADS.windows])
  const { primary } = pickDownloads({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
  assert.deepEqual(primary, [DOWNLOADS.windows])
})

test('detectDownloads: no navigator offers both', async () => {
  assert.deepEqual((await detectDownloads(undefined)).primary, [DOWNLOADS.macArm, DOWNLOADS.windows])
})

test('detectDownloads: high-entropy values win over the user-agent string', async () => {
  const nav = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    userAgentData: { getHighEntropyValues: async () => ({ platform: 'macOS', architecture: 'x86' }) }
  }
  assert.deepEqual((await detectDownloads(nav)).primary, [{ ...DOWNLOADS.macIntel, label: 'Download for Mac' }])
})

test('detectDownloads: falls back to the user-agent string when high-entropy values fail or are missing', async () => {
  const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
  const failing = { userAgent: win, userAgentData: { getHighEntropyValues: async () => { throw new Error('nope') } } }
  assert.deepEqual((await detectDownloads(failing)).primary, [DOWNLOADS.windows])
  assert.deepEqual((await detectDownloads({ userAgent: win })).primary, [DOWNLOADS.windows])
  assert.deepEqual((await detectDownloads({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).primary, [DOWNLOADS.linux])
})

test('pickDownloads: an iPhone says "like Mac OS X" but gets both, like any phone', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
  assert.deepEqual(pickDownloads({ ua: iphone }).primary, [DOWNLOADS.macArm, DOWNLOADS.windows])
})
