import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aiMerge, findMergeCli, mergePrompt } from '../src/merge-ai.js'

const base = 'function add (a, b) {\n  return a + b\n}\n'
const ours = 'function add (a, b) {\n  // bob: guard\n  return a + b\n}\n'
const theirs = 'function add (a, b) {\n  return Number(a) + Number(b)\n}\n'
// Each test hands aiMerge its own `run`, so the tool is never started: a stand-in keeps the
// tests from depending on claude, codex or cursor-agent being installed (CI has none).
const cli = { cmd: 'stand-in-ai', args: [] }
const opts = { path: 'src/add.js', base, ours, theirs, mine: 'bob', theirsBy: 'alice', cli }

test('the prompt carries all three versions and the rule', () => {
  const p = mergePrompt(opts)
  assert.match(p, /src\/add\.js/)
  assert.match(p, /bob/)
  assert.match(p, /alice/)
  assert.ok(p.includes(base) && p.includes(ours) && p.includes(theirs))
  assert.match(p, /CONFLICT:/)
})

test('a fenced file in the answer is accepted', async () => {
  const merged = 'function add (a, b) {\n  // bob: guard\n  return Number(a) + Number(b)\n}\n'
  const run = async () => '```\n' + merged + '```\n'
  assert.deepEqual(await aiMerge({ ...opts, run }), { text: merged })
})

test('CONFLICT answers are refused with the reason', async () => {
  const run = async () => 'CONFLICT: both sides rewrote the return statement differently'
  assert.deepEqual(await aiMerge({ ...opts, run }), { refused: 'both sides rewrote the return statement differently' })
})

test('a fenced merged file containing a CONFLICT: line is accepted, not refused', async () => {
  const merged = 'function add (a, b) {\n  // bob: guard\n  // CONFLICT: see changelog\n  return Number(a) + Number(b)\n}\n'
  const run = async () => '```\n' + merged + '```\n'
  assert.deepEqual(await aiMerge({ ...opts, run }), { text: merged })
})

test('an answer that drops a line nobody touched is refused', async () => {
  const run = async () => '```\nfunction add (a, b) {\n  return Number(a) + Number(b)\n```\n'
  const r = await aiMerge({ ...opts, run })
  assert.match(r.refused, /dropped/)
})

test('an answer without a fenced file is refused', async () => {
  const r = await aiMerge({ ...opts, run: async () => 'Sure! Here is my thinking…' })
  assert.match(r.refused, /no file/)
})

test('a failing or slow command is refused, never thrown', async () => {
  const r = await aiMerge({ ...opts, run: async () => { throw new Error('timed out') } })
  assert.equal(r.refused, 'timed out')
})

test('files too big or binary are refused without running anything', async () => {
  let ran = false
  const run = async () => { ran = true; return '' }
  const big = 'x'.repeat(200_001)
  assert.match((await aiMerge({ ...opts, ours: big, run })).refused, /too large/)
  assert.equal(ran, false)
})

test('QUILT_MERGE_CMD wins; otherwise the first installed CLI', () => {
  assert.deepEqual(findMergeCli({ env: { QUILT_MERGE_CMD: 'node fake.js --x' }, exists: () => false }), { cmd: 'node', args: ['fake.js', '--x'] })
  const exists = (p) => p.endsWith('/codex')
  assert.deepEqual(findMergeCli({ env: { PATH: '/usr/bin' }, exists, claude: () => null }), { cmd: '/usr/bin/codex', args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-'] })
  assert.deepEqual(findMergeCli({ env: {}, exists: () => false, claude: () => '/bin/claude' }), { cmd: '/bin/claude', args: ['-p', '--no-session-persistence', '--tools', ''] })
  assert.equal(findMergeCli({ env: { PATH: '/usr/bin' }, exists: () => false, claude: () => null }), null)
  // cursor-agent's -p defaults to stream-json, which the fenced-file parser can't read: ask for plain text.
  const cursorOnly = (p) => p.endsWith('/cursor-agent')
  assert.deepEqual(
    findMergeCli({ env: { PATH: '/usr/bin' }, exists: cursorOnly, claude: () => null }),
    { cmd: '/usr/bin/cursor-agent', args: ['-p', '--output-format', 'text'] }
  )
})

// A Markdown file with a fenced block of its own, as the AI should wrap it: in a longer fence.
const mdBase = '# Notes\n\nIntro.\n\n```js\nconst a = 1\n```\n\nEnd.\n'
const mdOurs = '# Notes\n\nIntro, by bob.\n\n```js\nconst a = 1\n```\n\nEnd.\n'
const mdTheirs = '# Notes\n\nIntro.\n\n```js\nconst a = 1\n```\n\nEnd.\n\n```sh\nnpm test\n```\n'
const mdMerged = '# Notes\n\nIntro, by bob.\n\n```js\nconst a = 1\n```\n\nEnd.\n\n```sh\nnpm test\n```\n'
const md = { path: 'NOTES.md', base: mdBase, ours: mdOurs, theirs: mdTheirs, mine: 'bob', theirsBy: 'alice', cli }

test('a file with its own code fences comes back whole inside a longer fence', async () => {
  const run = async () => '````markdown\n' + mdMerged + '````\n'
  assert.deepEqual(await aiMerge({ ...md, run }), { text: mdMerged })
})

test('a file whose inner fences close the outer one is refused, not cut short', async () => {
  // Wrapped in the same three backticks it contains: the answer is several blocks, not one.
  const run = async () => '```\n' + mdMerged + '```\n'
  const r = await aiMerge({ ...md, run })
  assert.ok(r.refused, JSON.stringify(r))
})

test('an answer with two fenced blocks, or words around the block, is refused', async () => {
  const merged = 'function add (a, b) {\n  // bob: guard\n  return Number(a) + Number(b)\n}\n'
  assert.ok((await aiMerge({ ...opts, run: async () => '```\n' + merged + '```\n\n```\nmore\n```\n' })).refused)
  assert.ok((await aiMerge({ ...opts, run: async () => 'Here you go:\n```\n' + merged + '```\n' })).refused)
})

test('a fence with a language tag is accepted, with the trailing newline kept', async () => {
  const merged = 'function add (a, b) {\n  // bob: guard\n  return Number(a) + Number(b)\n}\n'
  assert.deepEqual(await aiMerge({ ...opts, run: async () => '```js\n' + merged + '```' }), { text: merged })
})

test('an empty answer is refused', async () => {
  assert.match((await aiMerge({ ...opts, run: async () => '' })).refused, /no file/)
  assert.match((await aiMerge({ ...opts, run: async () => '```\n```\n' })).refused, /dropped|empty|no file/)
})

test('the prompt asks for a fence longer than any inside the file', () => {
  const p = mergePrompt(md)
  assert.match(p, /````/, 'the versions are shown in a fence longer than theirs')
  assert.match(p, /longer than any/)
})
