import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrateDir, adoptLegacyEnv } from '../../src/legacy.js'
import { relayConfig } from '../../src/server.js'

test('a folder from before the rename (.cowove) is moved to .quilt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-legacy-'))
  fs.mkdirSync(path.join(dir, '.cowove'))
  fs.writeFileSync(path.join(dir, '.cowove', 'config.json'), '{"room":"r"}')
  assert.equal(migrateDir(dir), path.join(dir, '.quilt'))
  assert.equal(fs.readFileSync(path.join(dir, '.quilt', 'config.json'), 'utf8'), '{"room":"r"}')
  assert.ok(!fs.existsSync(path.join(dir, '.cowove')))
})

test('an existing .quilt folder is never replaced by an old .cowove one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-legacy-'))
  fs.mkdirSync(path.join(dir, '.quilt'))
  fs.mkdirSync(path.join(dir, '.cowove'))
  migrateDir(dir)
  assert.ok(fs.existsSync(path.join(dir, '.cowove')))
})

test('COWOVE_* settings count as QUILT_* ones, and new names win', () => {
  const env = adoptLegacyEnv({ COWOVE_RELAY_KEY: 'old', COWOVE_DEBUG: '1', QUILT_DEBUG: '0' })
  assert.equal(env.QUILT_RELAY_KEY, 'old')
  assert.equal(env.QUILT_DEBUG, '0')
})

test('a relay configured under the old name keeps its relay key', () => {
  const prev = process.env.COWOVE_RELAY_KEY
  process.env.COWOVE_RELAY_KEY = 'k'
  try { assert.equal(relayConfig().relayKey, 'k') } finally {
    if (prev === undefined) delete process.env.COWOVE_RELAY_KEY
    else process.env.COWOVE_RELAY_KEY = prev
  }
})
