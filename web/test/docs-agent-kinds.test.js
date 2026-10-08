// The Agent kinds docs page the app's Invite an agent menu links to: static, the three kinds,
// invited then let in, and where each is changed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const page = () => readFileSync(new URL('../app/docs/agent-kinds/page.js', import.meta.url), 'utf8')

test('docs/agent-kinds: a static page about the three kinds, inheritance as an invitation, and where to change it', () => {
  const s = page()
  for (const bit of ['Global agent', 'Workspace agent', 'Session agent', 'In all your workspaces, invited to their sessions.', 'In one workspace, invited to its sessions.', 'Invited to one session.', 'Invited, then let in', 'lets it in', 'Where to change it', 'A workspace\\\'s People', 'A session\\\'s People', 'Settings, Agents', 'part of workspaces']) assert.ok(s.includes(bit), bit)
  assert.doesNotMatch(s, /next\/headers|currentUser\(/, 'prerendered: nothing per request')
})

test('the app links to it', () => {
  assert.ok(readFileSync(new URL('../../src/ui/agent-kinds.js', import.meta.url), 'utf8').includes("export const DOCS_URL = 'https://heyquilt.com/docs/agent-kinds'"))
})
