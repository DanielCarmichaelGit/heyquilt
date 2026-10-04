// Claude Code hooks: files are claimed as they are edited, refused when someone
// else holds them (with a nudge to ask for help), and released when Claude is done.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { startControl } from '../src/control.js'
import { installHooks } from '../src/setup.js'
import { HOOK_COMMAND, releaseLeftoverHookClaims, hookState } from '../src/hooks.js'
import { openMerge } from '../src/merges.js'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'quilt.js')
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-hooks-${n}-`))
let relay, dana, sam, danaDir, samDir, control

async function waitFor (fn, ms = 8000) {
  const t = Date.now()
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)) }
  throw new Error('timed out')
}

/** Runs the real `quilt hook` in dana's folder with one event on stdin. */
function hook (event) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [BIN, 'hook'], { cwd: danaDir, env: { ...process.env, HOME: tmp('home') } })
    let out = ''; let err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', reject)
    p.on('close', (code) => resolve({ code, out: out.trim(), err, json: out.trim() ? JSON.parse(out.trim()) : null }))
    p.stdin.end(JSON.stringify({ session_id: 'claude-1', cwd: danaDir, ...event }))
  })
}
const edit = (file, tool = 'Edit') => hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: file } })

before(async () => {
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {} })
  const server = `ws://127.0.0.1:${relay.port}`
  danaDir = tmp('dana'); samDir = tmp('sam')
  fs.mkdirSync(path.join(danaDir, 'src'))
  fs.writeFileSync(path.join(danaDir, 'src', 'app.js'), 'console.log("hi")\n')
  fs.writeFileSync(path.join(danaDir, 'src', 'auth.js'), 'export const auth = 1\n')
  fs.writeFileSync(path.join(danaDir, '.gitignore'), 'dist/\n')
  dana = new Session({ dir: danaDir, server, room: 'pair', secret: 's3cret', name: 'dana' })
  await dana.start({ waitTimeoutMs: 5000 })
  control = await startControl(dana, {})
  sam = new Session({ dir: samDir, server, room: 'pair', secret: 's3cret', name: 'sam' })
  await sam.start({ waitTimeoutMs: 5000 })
  await waitFor(() => dana.status().peers.some((p) => p.name === 'sam'))
})

after(async () => {
  await control?.close()
  await dana?.stop()
  await sam?.stop()
  await relay?.close()
})

test('outside a session the hook does nothing', async () => {
  const p = await new Promise((resolve) => {
    const c = spawn(process.execPath, [BIN, 'hook'], { cwd: tmp('nowhere') })
    let out = ''
    c.stdout.on('data', (d) => { out += d })
    c.on('close', (code) => resolve({ code, out }))
    c.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'x.js' } }))
  })
  assert.equal(p.code, 0)
  assert.equal(p.out, '')
})

test('session start tells Claude the rule and who is here', async () => {
  const r = await hook({ hook_event_name: 'SessionStart', source: 'startup' })
  assert.ok(r.json, `no output; stderr: ${r.err}`)
  const ctx = r.json.hookSpecificOutput.additionalContext
  assert.match(ctx, /room pair/)
  assert.match(ctx, /with sam/)
  assert.match(ctx, /claims each file for you/)
})

test('session start mentions an open merge and nudges toward quilt_merges', async () => {
  openMerge(dana.doc, dana.merges, {
    path: 'src/needs-merge.js', by: 'sam', others: ['dana'], kind: 'conflict', ours: 'mine\n', base: 'base\n', theirsHash: 'abc', binary: false
  }, null)
  const r = await hook({ hook_event_name: 'SessionStart', source: 'startup' })
  const ctx = r.json.hookSpecificOutput.additionalContext
  assert.match(ctx, /src\/needs-merge\.js/)
  assert.match(ctx, /quilt_merges/)
  assert.match(ctx, /quilt_resolve_merge/)
})

test('editing an unclaimed file claims it for me and lets the edit through', async () => {
  const r = await edit('src/app.js')
  assert.equal(r.code, 0)
  assert.equal(r.out, '', 'allowed silently')
  const claim = await waitFor(() => sam.claimFor('src/app.js'))
  assert.equal(claim.by, 'dana')
  assert.equal(claim.note, 'editing')
  // The hook remembers its claim; editing again is a no-op.
  assert.deepEqual(hookState(danaDir, 'claude-1').read().claims, ['src/app.js'])
  assert.equal((await edit(path.join(danaDir, 'src', 'app.js'), 'Write')).out, '')
})

test('editing a file someone else claimed is refused, with a nudge to ask them', async () => {
  await sam.claim('src/auth.js', 'adding sign-in')
  await waitFor(() => dana.claimFor('src/auth.js'))
  const r = await edit('src/auth.js', 'MultiEdit')
  const o = r.json.hookSpecificOutput
  assert.equal(o.hookEventName, 'PreToolUse')
  assert.equal(o.permissionDecision, 'deny')
  assert.match(o.permissionDecisionReason, /src\/auth\.js is claimed by sam \(adding sign-in\)/)
  assert.match(o.permissionDecisionReason, /quilt_message \(to: "sam"\)/)
  assert.match(o.permissionDecisionReason, /Do not retry/)
  assert.equal(hookState(danaDir, 'claude-1').read().claims.includes('src/auth.js'), false)
})

test('a folder claim covers new files in it', async () => {
  await sam.claim('docs', 'writing the guide')
  await waitFor(() => dana.claimFor('docs/new.md'))
  const r = await edit('docs/new.md', 'Write')
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /docs\/new\.md is claimed by sam \(writing the guide\), as part of their claim on docs/)
})

test('files Quilt does not sync, or outside the project, need no claim', async () => {
  for (const f of ['dist/bundle.js', '.quilt/STATUS.md', '.env', path.join(os.tmpdir(), 'elsewhere.js')]) {
    const r = await edit(f)
    assert.equal(r.out, '', f)
  }
  assert.equal(sam.claimFor('dist/bundle.js'), null)
})

test('a direct message from a collaborator is shown once, after an edit', async () => {
  sam.say('I wanted to change the auth flow in src/app.js, can you help?', { to: 'dana' })
  sam.say('hello everyone') // public chat is left to the person
  await waitFor(() => dana.messages({ markRead: false }).some((m) => m.to === 'dana'))
  const r = await hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/app.js' } })
  const ctx = r.json.hookSpecificOutput.additionalContext
  assert.match(ctx, /sam sent you a direct message: I wanted to change the auth flow/)
  assert.doesNotMatch(ctx, /hello everyone/)
  assert.match(ctx, /quilt_message \(to: their name\)/)
  // Shown once per Claude session, and the person still sees it as unread in the app.
  assert.equal((await hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/app.js' } })).out, '')
  assert.equal(dana.messages({ unreadOnly: true, markRead: false }).length, 2)
})

test('stopping with an unanswered message asks Claude to reply first; then releases the claims', async () => {
  sam.say('when will src/app.js be free?', { to: 'dana' })
  await waitFor(() => dana.messages({ markRead: false }).some((m) => m.text.startsWith('when will')))
  const blocked = await hook({ hook_event_name: 'Stop', stop_hook_active: false })
  assert.equal(blocked.json.decision, 'block')
  assert.match(blocked.json.reason, /sam sent you a direct message: when will src\/app\.js be free\?/)
  assert.match(blocked.json.reason, /Reply with quilt_message, and take or decline a task you were handed, before you finish/)
  assert.ok(sam.claimFor('src/app.js'), 'still claimed while Claude answers')
  // Claude answered and stops again (stop_hook_active): hook claims are released.
  const done = await hook({ hook_event_name: 'Stop', stop_hook_active: true })
  assert.equal(done.out, '')
  await waitFor(() => !sam.claimFor('src/app.js'))
  assert.deepEqual(hookState(danaDir, 'claude-1').read().claims, [])
  // A message Claude was shown after an edit but never answered holds it back once at stop too.
  sam.say('one more thing: is src/lib ok to touch?', { to: 'dana' })
  await waitFor(() => dana.messages({ markRead: false }).some((m) => m.text.startsWith('one more thing')))
  assert.match((await hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/app.js' } })).out, /one more thing/)
  const owed = await hook({ hook_event_name: 'Stop', stop_hook_active: false })
  assert.equal(owed.json.decision, 'block')
  assert.match(owed.json.reason, /one more thing: is src\/lib ok to touch\?/)
  assert.doesNotMatch(owed.json.reason, /when will/, 'each one holds Claude back once')
  // Once each was asked about (or answered), a quiet stop just releases.
  dana.say('free in ten minutes', { to: 'sam' })
  await edit('src/app.js')
  await waitFor(() => sam.claimFor('src/app.js'))
  assert.equal((await hook({ hook_event_name: 'Stop', stop_hook_active: false })).out, '')
  await waitFor(() => !sam.claimFor('src/app.js'))
})

test('before an edit, Claude is shown what was asked about that file, once', async () => {
  sam.say('please leave src/auth.js alone for an hour')
  sam.say('src/app.js is fine to touch') // about another file
  await waitFor(() => dana.messages({ markRead: false }).some((m) => m.text.startsWith('please leave')))
  await sam.release('src/auth.js')
  await waitFor(() => !dana.claimFor('src/auth.js'))
  const r = await edit('src/auth.js')
  const o = r.json.hookSpecificOutput
  assert.equal(o.hookEventName, 'PreToolUse')
  assert.equal(o.permissionDecision, undefined, 'informs, never grants permission')
  assert.match(o.additionalContext, /sam about src\/auth\.js: "please leave src\/auth\.js alone for an hour"/)
  assert.doesNotMatch(o.additionalContext, /fine to touch/)
  assert.equal((await edit('src/auth.js')).out, '', 'shown once per Claude session')
  await hook({ hook_event_name: 'Stop', stop_hook_active: true })
  await waitFor(() => !sam.claimFor('src/auth.js'))
})

test('a mention in public chat and a task handed to my AI are shown too', async () => {
  sam.say('hey @dana, can your AI pick up the pricing page?')
  const task = sam.addTask({ title: 'Pricing page', assignee: 'dana', forAi: true })
  sam.addTask({ title: 'For dana herself', assignee: 'dana' }) // for the person, not their AI
  await waitFor(() => dana.taskList().length >= 2 && dana.messages({ markRead: false }).some((m) => m.text.startsWith('hey @dana')))
  const r = await hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/app.js' } })
  const ctx = r.json.hookSpecificOutput.additionalContext
  assert.match(ctx, /sam mentioned you in chat: hey @dana, can your AI pick up the pricing page\?/)
  assert.match(ctx, new RegExp(`sam handed you a task: "Pricing page" \\(id ${task.id}\\)`))
  assert.doesNotMatch(ctx, /For dana herself/)
  assert.match(ctx, /Take a task you were handed with quilt_move_task/)
  assert.equal((await hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/app.js' } })).out, '')
})

test('explicit claims are never released by the hooks', async () => {
  await dana.claim('src/lib', 'mine for a while')
  await edit('src/app.js')
  await hook({ hook_event_name: 'SessionEnd', reason: 'exit' })
  await waitFor(() => !sam.claimFor('src/app.js'))
  assert.equal(sam.claimFor('src/lib/x.js').by, 'dana')
  assert.equal(fs.existsSync(hookState(danaDir, 'claude-1').file), false)
  await dana.release('src/lib')
})

test('a new session releases claims left by a Claude that never said goodbye', async () => {
  await edit('src/app.js')
  await waitFor(() => sam.claimFor('src/app.js'))
  assert.equal(await releaseLeftoverHookClaims(dana), 1)
  await waitFor(() => !sam.claimFor('src/app.js'))
  assert.equal(fs.existsSync(path.join(danaDir, '.quilt', 'hooks', 'claude-1.json')), false)
})

test('installHooks writes the hooks, keeps other hooks, and is idempotent', () => {
  const dir = tmp('settings')
  assert.equal(installHooks(dir), true)
  const file = path.join(dir, '.claude', 'settings.local.json')
  let json = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const ev of ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']) assert.ok(json.hooks[ev], ev)
  assert.equal(json.hooks.PreToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit')
  assert.equal(json.hooks.PreToolUse[0].hooks[0].command, HOOK_COMMAND)
  assert.equal(installHooks(dir), false, 'nothing to change')
  // Someone's own hook stays; an older Quilt entry is replaced, not duplicated.
  json.hooks.PreToolUse.unshift({ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] })
  json.hooks.Stop[0].hooks[0].command = 'quilt hook --old'
  json.permissions = { allow: ['Bash(npm test)'] }
  fs.writeFileSync(file, JSON.stringify(json))
  assert.equal(installHooks(dir), true)
  json = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(json.permissions, { allow: ['Bash(npm test)'] })
  assert.equal(json.hooks.PreToolUse.length, 2)
  assert.equal(json.hooks.PreToolUse[0].hooks[0].command, 'echo mine')
  assert.equal(json.hooks.Stop.length, 1)
  assert.equal(json.hooks.Stop[0].hooks[0].command, HOOK_COMMAND)
  // A broken file is replaced rather than crashing.
  fs.writeFileSync(file, '{not json')
  assert.equal(installHooks(dir), true)
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.Stop)
})
