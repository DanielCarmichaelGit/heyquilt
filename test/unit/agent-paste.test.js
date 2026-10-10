// The one text the app and the website hand you to paste into an AI so it joins as your agent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { agentPaste } from '../../src/ui/invite.js'

const LINK = 'https://api.heyquilt.com/v1/join/qj_abc'

test('the paste registers the agent by CLI or HTTP, says how to join a session, and carries the guide', () => {
  const text = agentPaste({ link: LINK })
  assert.match(text, /^Join Quilt as my AI agent\./)
  assert.ok(text.includes(`quilt agent join ${LINK} --name <your name>`), 'register command')
  assert.ok(text.includes(`open ${LINK} and follow it`), 'HTTP way')
  assert.ok(text.includes('quilt join <session invite link> --agent <your name>'))
  assert.ok(text.includes('quilt_join_session'))
  assert.ok(text.includes('within an hour'))
  assert.match(text, /## Working in a Quilt session/)
  assert.match(text, /https:\/\/api\.heyquilt\.com\/mcp/)
  assert.equal(text.includes('—'), false, 'no em dash')
})

test("from a session's Invite, the paste carries that session's invite link to join next", () => {
  const SESSION = 'https://join.heyquilt.com/room-1#s3cret'
  const text = agentPaste({ link: LINK, session: SESSION })
  assert.ok(text.includes(`session invite link: ${SESSION}`))
  assert.ok(text.includes(`quilt join ${SESSION} --agent <your name>`))
  assert.equal(text.includes('I will send you a session invite link'), false)
  assert.ok(text.includes(`quilt agent join ${LINK} --name <your name>`), 'still registers first')
  assert.equal(text.includes('—'), false, 'no em dash')
})

test('every Invite agent button uses this one paste; a session\'s Invite adds its link', () => {
  assert.ok(fs.readFileSync('src/ui/app.js', 'utf8').includes('agentPaste({ link: inv.link, session: s.invite })'))
  assert.ok(fs.readFileSync('src/ui/home.js', 'utf8').includes('agentPaste({ link: inv.link })'))
  assert.ok(fs.readFileSync('web/components/AgentInvite.js', 'utf8').includes("import { agentPaste } from '../../src/ui/invite.js'"))
  for (const f of ['web/app/dashboard/agents/page.js', 'web/app/org/[slug]/people/page.js']) {
    assert.ok(fs.readFileSync(f, 'utf8').includes('<AgentInvite'), f)
  }
})

test('a global or workspace agent is told to set a webhook to hear about new sessions; others are not', () => {
  assert.doesNotMatch(agentPaste({ link: LINK }), /quilt_workspace_webhook/)
  assert.doesNotMatch(agentPaste({ link: LINK, session: 'https://join.heyquilt.com/room-1#s3cret' }), /quilt_workspace_webhook/)
  const text = agentPaste({ link: LINK, invitedToSessions: true })
  assert.match(text, /3\. You are invited to each new session in my workspaces\. To hear about them, call quilt_workspace_webhook/)
  assert.match(text, /`session\.started`/)
})
