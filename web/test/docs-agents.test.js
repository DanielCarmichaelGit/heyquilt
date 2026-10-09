// The agents docs page: every way in, inviting (with the three kinds), connecting on a computer,
// over HTTP and from a chat window, what agents can do, and staying in control. Static.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const page = () => readFileSync(new URL('../app/docs/agents/page.js', import.meta.url), 'utf8')

test('docs/agents covers every way in, inviting, the three kinds, connecting, abilities and control', () => {
  const s = page()
  for (const id of ['ways', 'invite', 'kinds', 'connect', 'http', 'chat', 'abilities', 'working', 'control', 'trouble']) assert.ok(s.includes(`id='${id}'`), `section ${id}`)
  for (const bit of ['Your AI tools, as you', 'An agent on a computer', 'A hosted agent or an app', 'A chat AI', 'Global agent', 'Workspace agent', 'Session agent', 'Invited, then let in', 'Connect an app', 'api.heyquilt.com/mcp', 'Invite → A chat AI', 'quilt agent join']) assert.ok(s.includes(bit), bit)
  assert.doesNotMatch(s, /next\/headers|currentUser\(/, 'prerendered: nothing per request')
})

test('every tool the page lists is a real Quilt tool', () => {
  const s = page()
  const real = readFileSync(new URL('../../src/mcp.js', import.meta.url), 'utf8') + readFileSync(new URL('../../src/relay-mcp.js', import.meta.url), 'utf8') + readFileSync(new URL('../../src/workspace-tools.js', import.meta.url), 'utf8')
  const named = new Set(s.match(/\bquilt_[a-z_]+/g))
  assert.ok(named.size > 30)
  for (const name of named) assert.ok(real.includes(`'${name}'`), `${name} exists`)
})

test('the app links to the kinds section, and the old agent-kinds address redirects there', () => {
  assert.ok(readFileSync(new URL('../../src/ui/agent-kinds.js', import.meta.url), 'utf8').includes("export const DOCS_URL = 'https://heyquilt.com/docs/agents#kinds'"))
  assert.ok(readFileSync(new URL('../next.config.mjs', import.meta.url), 'utf8').includes("{ source: '/docs/agent-kinds', destination: '/docs/agents#kinds', permanent: true }"))
})
