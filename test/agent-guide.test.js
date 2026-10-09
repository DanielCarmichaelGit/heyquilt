// The guide every agent's first prompt carries: chat, mentions, DMs, tasks, files, inbox, webhooks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentGuide } from '../src/ui/agent-guide.js'
import { agentPaste } from '../src/ui/invite.js'
import { joinInstructions, joinNext } from '../src/api/join-text.js'

const COVERS = [/quilt_message/, /@Name/, /"to":"<name>"/, /quilt_tasks/, /quilt_move_task/, /qaNotes/, /quilt_inbox/,
  /quilt_webhook_subscribe/, /x-quilt-signature/, /HMAC-SHA256/, /chat\.mention/, /task\.assigned/, /quilt_request_file/, /quilt_handoff/,
  /invisible to every person/, /\[AI agent\]/, /share the person's name/, /to_ai: true/, /Never send greetings, welcomes, thanks.*no_reply/, /a person's word wins/,
  /quilt_partner_feed/, /never commits, merges git history or pushes/, /@Agents/]

test('the guide covers chat, mentions, direct messages, tasks, files, the inbox and webhooks', () => {
  const g = agentGuide({ apiUrl: 'https://api.x' })
  for (const re of COVERS) assert.match(g, re)
  assert.match(g, /https:\/\/api\.x\/mcp/)
  assert.match(g, /"method":"tools\/call"/)
  assert.match(g, /quilt say @name/)
  assert.equal(g.includes('—'), false, 'no em dash')
})

test('tools only the CLI has are marked when both ways are explained, and left out over HTTP', () => {
  const g = agentGuide({})
  assert.match(g, /quilt_merges`.*\(CLI only\)\./)
  assert.match(g, /quilt_send_file`.*\(CLI only\)\./)
  const h = agentGuide({ via: 'http' })
  for (const tool of ['quilt_merges', 'quilt_send_file', 'quilt_wait_until_idle', 'quilt_set_work', 'quilt_before_edit']) assert.doesNotMatch(h, new RegExp(tool))
  assert.doesNotMatch(agentGuide({ via: 'cli' }), /CLI only/)
})

test('git: each way in is told how commits really come in, and the tools it has for them', () => {
  const h = agentGuide({ via: 'http' })
  // Over HTTP the relay brings commits in: no "git pull in your folder", and the git tools hosted agents have.
  assert.doesNotMatch(h, /git pull in your folder/)
  assert.match(h, /the relay brings them in from GitHub about every 10 minutes/)
  assert.match(h, /`quilt_sync_branch` brings in new commits now.*the relay asks GitHub, at most once a minute per branch/)
  assert.match(h, /`quilt_write_file` it without conflict markers; each such write makes the relay look again at once/)
  assert.match(h, /move the task to QA/)
  assert.match(h, /`quilt_switch_branch`.*on GitHub but not yet in the session is loaded at its latest commit/)
  for (const tool of ['quilt_branches', 'quilt_request_commit', 'quilt_commit_status', 'quilt_commit_request_done', 'quilt_github_token']) assert.match(h, new RegExp(tool))
  assert.match(h, /ask the session owner/)
  // With the CLI: a git clone with fetch credentials that work without a prompt, or the relay covers the branch.
  const c = agentGuide({ via: 'cli' })
  assert.match(c, /join from a git clone of the repository/)
  assert.match(c, /fetch credentials that work without a prompt/)
  assert.match(c, /the relay then brings them in from GitHub for that branch/)
  assert.match(c, /git pull in your folder/)
  assert.doesNotMatch(c, /quilt_switch_branch/, 'a folder switches with git checkout')
  // Both: quilt_branches is not marked CLI only any more.
  assert.doesNotMatch(agentGuide({}), /quilt_branches`[^.]*\(CLI only\)/)
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
  assert.match(agentPaste({ link }), /make HTTP requests: open https:\/\/api\.x\/v1\/join\/qj_abc/)
})

test('every prompt says how to install on Linux, and to keep quilt join running in the background', () => {
  const link = 'https://api.x/v1/join/qj_abc'
  const paste = agentPaste({ link })
  const page = joinInstructions({ link, apiUrl: 'https://api.x', status: 'waiting', expiresAt: Date.now() })
  for (const text of [paste, page]) {
    assert.ok(text.includes('curl -fsSL https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download/install.sh | sh'), 'Linux install')
    assert.match(text, /~\/\.local\/bin\/quilt/)
    assert.match(text, /nohup quilt join <session invite link> --agent <your name>/)
  }
  assert.match(agentGuide({ via: 'cli' }), /nohup quilt join/)
  assert.doesNotMatch(agentGuide({ via: 'http' }), /nohup/)
})

test('every prompt makes an agent that can run commands use the CLI, and keeps HTTP for agents with no computer', () => {
  const link = 'https://api.x/v1/join/qj_abc'
  const paste = agentPaste({ link })
  const page = joinInstructions({ link, apiUrl: 'https://api.x', status: 'waiting', expiresAt: Date.now() })
  for (const text of [paste, page]) {
    assert.match(text, /This is not optional: an agent that can run commands must join with the CLI/)
    assert.match(text, /Never choose HTTP because it looks quicker/)
    // The CLI comes before HTTP.
    assert.ok(text.indexOf('quilt agent join') < text.indexOf('join over HTTP'), 'CLI first')
  }
  assert.match(paste, /Only if you have no computer and can do nothing but make HTTP requests/)
  assert.match(page, /## Only if you have no computer: join over HTTP/)
  const http = joinNext({ name: 'Larry', agentId: 'ag_1', apiUrl: 'https://api.x', hasKey: false })
  assert.match(http, /stop and switch to the Quilt CLI now/)
  assert.match(http, /quilt agent join <invite link> --name Larry --agent-id ag_1/)
})
