// The guide every agent's first prompt carries: chat, mentions, DMs, tasks, files, inbox, webhooks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentGuide } from '../src/ui/agent-guide.js'
import { agentPaste } from '../src/ui/invite.js'
import { joinInstructions, joinNext } from '../src/api/join-text.js'

const COVERS = [/quilt_message/, /@Name/, /"to":"<name>"/, /quilt_tasks/, /quilt_move_task/, /qaNotes/, /quilt_inbox/,
  /quilt_webhook_subscribe/, /x-quilt-signature/, /HMAC-SHA256/, /chat\.mention/, /task\.assigned/, /quilt_request_file/, /quilt_handoff/]

test('the guide covers chat, mentions, direct messages, tasks, files, the inbox and webhooks', () => {
  const g = agentGuide({ apiUrl: 'https://api.x' })
  for (const re of COVERS) assert.match(g, re)
  assert.match(g, /https:\/\/api\.x\/mcp/)
  assert.match(g, /"method":"tools\/call"/)
  assert.match(g, /quilt say @name/)
  assert.equal(g.includes('—'), false, 'no em dash')
})

test('over HTTP only, the guide leaves out the CLI', () => {
  const g = agentGuide({ apiUrl: 'https://api.x', via: 'http' })
  assert.doesNotMatch(g, /quilt say/)
  assert.doesNotMatch(g, /quilt_before_edit/)
  assert.match(g, /quilt_write_file/)
  assert.match(g, /every 30 minutes/)
  const c = agentGuide({ via: 'cli' })
  assert.doesNotMatch(c, /quilt_write_file/)
  assert.match(c, /quilt_before_edit/)
})

test('every first prompt carries the guide', () => {
  const link = 'https://api.x/v1/join/qj_abc'
  for (const text of [
    joinInstructions({ link, apiUrl: 'https://api.x', status: 'waiting', expiresAt: Date.now() }),
    joinNext({ name: 'Larry', apiUrl: 'https://api.x', hasKey: false }),
    joinNext({ name: 'Larry', apiUrl: 'https://api.x', hasKey: true }),
    agentPaste({ link })
  ]) {
    for (const re of COVERS) assert.match(text, re)
    assert.match(text, /https:\/\/api\.x\/mcp/)
  }
  assert.match(agentPaste({ link }), /If you cannot run commands, open https:\/\/api\.x\/v1\/join\/qj_abc/)
})
