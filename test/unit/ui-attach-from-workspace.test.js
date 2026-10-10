// The session chat composer offers an "Attach from workspace" button when the session
// belongs to a workspace, wired to the workspace file picker and the local attach route.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
const ui = (f) => fs.readFileSync(new URL(`../../src/ui/${f}`, import.meta.url), 'utf8')

test('the composer offers Attach from workspace when the session is in one', () => {
  const s = ui('session.js')
  for (const bit of ['data-attach-workspace', 'title="Attach from workspace"', "from './files.js'", 'workspaceFilePicker(', '/attach-from-workspace']) assert.ok(s.includes(bit), bit)
  assert.ok(s.includes('.workspace ?') || s.includes('.workspace\n') || s.includes('workspace ? `<button'), 'only when the session has a workspace')
})
