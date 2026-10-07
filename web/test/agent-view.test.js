import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentStatus, inviteStatusText, AGENT_JOIN_COMMAND, HOSTED_NOTE, agentInvitePaste } from '../lib/agent-view.js'

test('agentStatus explains a signed-out agent and says nothing for an active one', () => {
  assert.equal(agentStatus('active'), null)
  assert.equal(agentStatus(undefined), null)
  assert.equal(agentStatus('toString'), null)
  assert.equal(agentStatus('reused').label, 'Signed out')
  assert.match(agentStatus('reused').why, /old key/)
  assert.equal(agentStatus('expired').label, 'Signed out')
  assert.match(agentStatus('expired').why, /30 days/)
})

test('inviteStatusText names who used an invite', () => {
  assert.equal(inviteStatusText({ status: 'waiting' }), 'Waiting')
  assert.equal(inviteStatusText({ status: 'used', usedBy: { name: 'Larry', provider: 'Anthropic' } }), 'Used by Larry (Anthropic)')
  assert.equal(inviteStatusText({ status: 'used', usedBy: null }), 'Used')
  assert.equal(inviteStatusText({ status: 'expired' }), 'Expired')
  assert.equal(inviteStatusText({ status: 'cancelled' }), 'Cancelled')
  assert.equal(AGENT_JOIN_COMMAND, 'quilt agent join <link> --name my-agent')
})

test('HOSTED_NOTE explains how an agent with no key joins sessions', () => {
  assert.match(HOSTED_NOTE, /api\.heyquilt\.com\/mcp/)
  assert.match(HOSTED_NOTE, /needs no computer running Quilt/)
  assert.equal(HOSTED_NOTE.includes('—'), false, 'no em dash')
})

test('the invite paste tells the AI to open the link, which has the whole guide', () => {
  const t = agentInvitePaste('https://api.heyquilt.com/v1/join/qj_abc')
  assert.ok(t.includes('open https://api.heyquilt.com/v1/join/qj_abc and follow it'))
  assert.match(t, /webhooks/)
})
