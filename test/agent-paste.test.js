// The one text the app and the website hand you to paste into an AI so it joins as your agent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { agentPaste } from '../src/ui/invite.js'

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

test('every Invite agent button uses this one paste, with nothing session-specific in it', () => {
  for (const f of ['src/ui/app.js', 'src/ui/home.js']) {
    const src = fs.readFileSync(f, 'utf8')
    assert.ok(src.includes('agentPaste({ link: inv.link })'), f)
  }
  assert.ok(fs.readFileSync('web/components/AgentInvite.js', 'utf8').includes("import { agentPaste } from '../../src/ui/invite.js'"))
  for (const f of ['web/app/dashboard/agents/page.js', 'web/app/org/[slug]/people/page.js']) {
    assert.ok(fs.readFileSync(f, 'utf8').includes('<AgentInvite'), f)
  }
})
