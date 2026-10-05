import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workspacePatch } from '../lib/workspace-form.js'

const form = (fields) => ({ get: (k) => (k in fields ? fields[k] : null) })

test('the settings form sends archived only when the toggle changed', () => {
  const base = { name: 'Core', description: 'About', color: 'mint' }
  assert.deepEqual(workspacePatch(form({ ...base, archived: 'on', was_archived: 'on' })), base, 'still archived: archivedAt is left alone')
  assert.deepEqual(workspacePatch(form({ ...base })), base, 'still not archived')
  assert.deepEqual(workspacePatch(form({ ...base, archived: 'on' })), { ...base, archived: true })
  assert.deepEqual(workspacePatch(form({ ...base, was_archived: 'on' })), { ...base, archived: false })
  assert.deepEqual(workspacePatch(form({ name: 'Core' })), { name: 'Core', description: '', color: '' })
})
