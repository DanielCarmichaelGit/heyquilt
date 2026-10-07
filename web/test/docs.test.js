import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CLI_COMMANDS, CLI_GROUPS, DOCS_NAV } from '../lib/docs.js'
import { GIT_GROUPS } from '../lib/git-ops.js'

// The commands `quilt --help` lists: the first word after "quilt " on each usage line.
const help = readFileSync(new URL('../../bin/quilt.js', import.meta.url), 'utf8').split('const HELP = `')[1].split('`')[0]
const helpCommands = [...new Set([...help.matchAll(/^ {2}quilt ([a-z-]+)/gm)].map((m) => m[1]))]

test('the CLI docs cover every command in quilt --help, and nothing it lacks', () => {
  assert.ok(helpCommands.length > 20)
  assert.deepEqual([...CLI_COMMANDS].sort(), [...helpCommands].sort())
})

test('every CLI command and group has what the page renders', () => {
  for (const g of CLI_GROUPS) {
    assert.ok(g.id && g.title && g.text, g.id)
    for (const c of g.commands) {
      assert.ok(c.usage.startsWith(`quilt ${c.name}`), c.name)
      assert.ok(c.text, c.name)
    }
  }
})

test('the docs nav starts with the CLI reference and has the git page', () => {
  assert.equal(DOCS_NAV[0].href, '/docs')
  assert.ok(DOCS_NAV.some((d) => d.href === '/docs/git'))
  assert.ok(DOCS_NAV.some((d) => d.href === '/docs/agents'))
})

test('every git operation has commands, a known tag kind and text', () => {
  for (const g of GIT_GROUPS) {
    for (const op of g.ops) {
      assert.ok(op.cmds.length && op.text, op.cmds.join())
      assert.ok(['merged', 'kept', 'shared', 'paused', 'none'].includes(op.kind), op.kind)
    }
  }
})
