import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shorten, createSummarizer } from '../../src/summarize.js'
import { startServer } from '../../src/server.js'
import { Session } from '../../src/session.js'
import { generateIdentity } from '../../src/identity.js'

const LONG = 'Please refactor the login form so it validates the email on blur, shows inline errors under each field, and disables the submit button until everything is valid. Also add tests for all of it.'

test('shortening keeps the first sentence and drops code', () => {
  assert.equal(shorten(LONG), 'Please refactor the login form so it validates the email on blur, shows inline errors under each field, and disables the submit button until everything is…')
  assert.equal(shorten('Done. I also fixed the tests.'), 'Done. I also fixed the tests.')
  assert.equal(shorten('Fixed the bug in the parser today. ```js\nconst x = 1\n```'), 'Fixed the bug in the parser today.')
})

test('summaries come from the CLI, short text is left alone, failures fall back to shortening', async () => {
  const calls = []
  const ok = createSummarizer({ run: async (cmd, args, input) => { calls.push({ cmd, args, input }); return 'Refactor login form validation and add tests.\n' } })
  assert.deepEqual(await ok('prompt', LONG), { text: 'Refactor login form validation and add tests.', how: 'ai' })
  assert.equal(calls[0].cmd, 'claude')
  assert.ok(calls[0].args.includes('--no-session-persistence'))
  assert.equal(calls[0].input, LONG)
  assert.deepEqual(await ok('prompt', 'fix the typo'), { text: 'fix the typo', how: 'as-is' })
  assert.deepEqual(await ok('action', LONG), { text: LONG, how: 'as-is' }, 'actions are shared as they are')

  const warnings = []
  let tries = 0
  const broken = createSummarizer({ onWarn: (m) => warnings.push(m), run: async () => { tries++; throw new Error('Failed to authenticate: OAuth session expired') } })
  assert.equal((await broken('reply', LONG)).how, 'shortened')
  assert.equal((await broken('reply', LONG)).how, 'shortened')
  assert.equal(tries, 1, "doesn't retry a broken CLI on every message")
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /isn't signed in/)
})

test('a session shares summaries instead of the words, in order', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {} })
  const server = `ws://127.0.0.1:${srv.port}`
  const mk = (name) => new Session({ dir: fs.mkdtempSync(path.join(os.tmpdir(), `quilt-sum-${name}-`)), server, room: 'sum', secret: 's', name, identity: generateIdentity() })
  const a = mk('ann')
  const b = mk('ben')
  await a.start({ waitTimeoutMs: 5000 })
  await b.start({ waitTimeoutMs: 5000 })
  a.summarizer = async (kind, text) => ({ text: `summary of ${kind}`, how: 'ai' })
  a.pushAgentEntries([
    { id: '1', kind: 'prompt', text: LONG, ts: 1 },
    { id: '2', kind: 'action', text: 'Edited src/login.ts', ts: 2 },
    { id: '3', kind: 'reply', text: LONG, ts: 3 }
  ])
  const start = Date.now()
  while (b.agentFeedFor('ann').length < 3 && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 25))
  assert.deepEqual(b.agentFeedFor('ann').map((e) => [e.kind, e.text, e.summary || null]), [
    ['prompt', 'summary of prompt', 'ai'], ['action', 'Edited src/login.ts', null], ['reply', 'summary of reply', 'ai']
  ])
  await a.stop(); await b.stop(); await srv.close()
})
