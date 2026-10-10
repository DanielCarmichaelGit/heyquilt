import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startClaudeCodeReader, slugFor } from '../../src/agents/claude-code.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-cc-'))
const project = path.join(home, 'code', 'my-app')
fs.mkdirSync(path.join(project, 'web'), { recursive: true })
const projDir = path.join(home, '.claude', 'projects', slugFor(project))
fs.mkdirSync(projDir, { recursive: true })

let n = 0
const ts = () => new Date(Date.now() + n++).toISOString()
const user = (content, extra = {}) => ({ type: 'user', uuid: `u${n}`, sessionId: 'conv1', cwd: project, timestamp: ts(), message: { role: 'user', content }, ...extra })
const asst = (content, extra = {}) => ({ type: 'assistant', uuid: `a${n}`, sessionId: 'conv1', cwd: project, timestamp: ts(), message: { role: 'assistant', content, stop_reason: 'tool_use' }, ...extra })
const lines = (...objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n'

function collect () {
  const entries = []
  const states = []
  const r = startClaudeCodeReader({ dir: project, home, onEntries: (e) => entries.push(...e), onState: (s) => states.push(s.status), pollMs: 20 })
  return { entries, states, r }
}
const wait = (ms) => new Promise((res) => setTimeout(res, ms))

test('maps prompts, replies and actions; drops thinking, tool results, sidechains and meta', async () => {
  fs.writeFileSync(path.join(projDir, 'conv1.jsonl'), lines(
    user('Add a login page'),
    user('<command-name>/clear</command-name>'),
    user('internal', { isMeta: true }),
    asst([{ type: 'thinking', thinking: 'secret plan' }]),
    asst([{ type: 'text', text: 'Sure, I will add it.' }, { type: 'tool_use', name: 'Read', input: { file_path: path.join(project, 'web/app.ts') } }]),
    user([{ type: 'tool_result', content: 'file contents here' }]),
    asst([{ type: 'tool_use', name: 'Bash', input: { command: 'TOKEN=abc npm test -- --grep x' } }]),
    asst([{ type: 'text', text: 'subagent chatter' }], { isSidechain: true }),
    asst([{ type: 'tool_use', name: 'Write', input: { file_path: path.join(project, 'web/login.ts') } }]),
    { ...asst([{ type: 'text', text: 'Done!' }]), message: { role: 'assistant', content: [{ type: 'text', text: 'Done!' }], stop_reason: 'end_turn' } }
  ))
  const { entries, r } = collect()
  r.stop()
  assert.deepEqual(entries.map((e) => [e.kind, e.text]), [
    ['prompt', 'Add a login page'],
    ['reply', 'Sure, I will add it.'],
    ['action', 'Read web/app.ts'],
    ['action', 'Ran npm test'],
    ['action', 'Created web/login.ts'],
    ['reply', 'Done!']
  ])
  assert.ok(entries.every((e) => e.conv === 'conv1' && e.tool === 'Claude Code' && e.id))
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length, 'ids are unique')
})

test('ignores conversations from other folders but includes subfolders', async () => {
  const other = path.join(home, '.claude', 'projects', slugFor(project) + '-other')
  fs.mkdirSync(other, { recursive: true })
  fs.writeFileSync(path.join(other, 'c.jsonl'), lines(user('elsewhere', { cwd: project + '-other', sessionId: 'c' })))
  const sub = path.join(home, '.claude', 'projects', slugFor(path.join(project, 'web')))
  fs.mkdirSync(sub, { recursive: true })
  fs.writeFileSync(path.join(sub, 's.jsonl'), lines(user('from the web folder', { cwd: path.join(project, 'web'), sessionId: 's' })))
  const { entries, r } = collect()
  r.stop()
  const texts = entries.map((e) => e.text)
  assert.ok(texts.includes('from the web folder'))
  assert.ok(!texts.includes('elsewhere'))
})

test('picks up live appends, handles partial lines, and tracks working/idle', async () => {
  const file = path.join(projDir, 'live.jsonl')
  fs.writeFileSync(file, '')
  const { entries, states, r } = collect()
  const first = JSON.stringify(user('live prompt', { sessionId: 'live' }))
  fs.appendFileSync(file, first.slice(0, 20)) // half a line
  await wait(80)
  assert.equal(entries.filter((e) => e.conv === 'live').length, 0)
  fs.appendFileSync(file, first.slice(20) + '\n')
  await wait(80)
  assert.deepEqual(entries.filter((e) => e.conv === 'live').map((e) => e.text), ['live prompt'])
  assert.equal(states.at(-1), 'working')
  fs.appendFileSync(file, 'not json at all\n' + lines({ ...asst([{ type: 'text', text: 'ok' }], { sessionId: 'live' }), message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } }))
  await wait(80)
  r.stop()
  assert.equal(entries.filter((e) => e.conv === 'live').at(-1).text, 'ok')
  assert.equal(states.at(-1), 'idle')
})

test('old conversations are not backfilled, and long text is truncated', async () => {
  const old = path.join(projDir, 'old.jsonl')
  fs.writeFileSync(old, lines(user('ancient history', { sessionId: 'old' })))
  const past = new Date(Date.now() - 3 * 60 * 60 * 1000)
  fs.utimesSync(old, past, past)
  const { entries, r } = collect()
  fs.appendFileSync(old, lines(user('x'.repeat(9000), { sessionId: 'old' })))
  await wait(80)
  r.stop()
  const oldEntries = entries.filter((e) => e.conv === 'old')
  assert.equal(oldEntries.length, 1)
  assert.ok(oldEntries[0].text.endsWith('…(truncated)'))
  assert.equal(oldEntries[0].text.length, 8000 + '…(truncated)'.length)
})

test('an agent that synced into a subfolder shares its own chat (chatDir)', async () => {
  // e.g. Claude Code in the cloud runs in the repo, and quilt_join_session synced into ./quilt-<room>.
  const synced = path.join(project, 'quilt-room1')
  fs.mkdirSync(synced, { recursive: true })
  fs.writeFileSync(path.join(projDir, 'agent.jsonl'), lines(
    user('Fix the header', { sessionId: 'agent' }),
    asst([{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(synced, 'header.css') } }], { sessionId: 'agent' })
  ))
  const without = []
  const r1 = startClaudeCodeReader({ dir: synced, home, onEntries: (e) => without.push(...e), onState: () => {}, pollMs: 20 })
  r1.stop()
  assert.equal(without.length, 0, 'the chat lives above the synced folder')

  const got = []
  const r2 = startClaudeCodeReader({ dir: synced, chatDir: project, home, onEntries: (e) => got.push(...e), onState: () => {}, pollMs: 20 })
  r2.stop()
  const mine = got.filter((e) => e.conv === 'agent').map((e) => e.text)
  assert.deepEqual(mine, ['Fix the header', 'Edited header.css'])
})
