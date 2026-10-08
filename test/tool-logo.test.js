import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toolLogo, toolLabel, resolveToolKey } from '../src/ui/tool-logo.js'

test('toolLabel falls back to AI', () => {
  assert.equal(toolLabel(''), 'AI')
  assert.equal(toolLabel(null), 'AI')
  assert.equal(toolLabel('Cursor'), 'Cursor')
})

test('resolveToolKey matches known tools and aliases', () => {
  assert.equal(resolveToolKey('Claude Code'), 'Claude Code')
  assert.equal(resolveToolKey('claude'), 'Claude Code')
  assert.equal(resolveToolKey('CURSOR'), 'Cursor')
  assert.equal(resolveToolKey('GitHub Copilot'), 'GitHub Copilot')
  assert.equal(resolveToolKey('copilot'), 'GitHub Copilot')
  assert.equal(resolveToolKey('MysteryBot'), null)
  assert.equal(resolveToolKey(''), null)
})

test('toolLogo renders a favicon img with accessible name', () => {
  const html = toolLogo('Claude Code')
  assert.match(html, /aria-label="Claude Code"/)
  assert.match(html, /title="Claude Code"/)
  assert.match(html, /<img class="tool-mark"/)
  assert.match(html, /google\.com\/s2\/favicons/)
  assert.match(html, /domain=anthropic\.com/)
  assert.match(html, /class="tool-logo"/)
  assert.doesNotMatch(html, />Claude Code</)
})

test('toolLogo uses a generic mark for unknown tools but keeps the label', () => {
  const html = toolLogo('MysteryBot')
  assert.match(html, /aria-label="MysteryBot"/)
  assert.match(html, /<svg[\s\S]*<\/svg>/)
  assert.doesNotMatch(html, /google\.com\/s2\/favicons/)
})

test('toolLogo empty tool is labeled AI', () => {
  const html = toolLogo('')
  assert.match(html, /aria-label="AI"/)
  assert.match(html, /<svg/)
})

test('each known TOOLS name has a distinct favicon domain', () => {
  const tools = [
    ['Claude Code', 'anthropic.com'],
    ['Cursor', 'cursor.com'],
    ['Codex', 'openai.com'],
    ['xAI', 'x.ai'],
    ['Windsurf', 'windsurf.com'],
    ['GitHub Copilot', 'github.com'],
    ['Zed', 'zed.dev'],
    ['Aider', 'aider.chat/docs']
  ]
  const srcs = []
  for (const [name, domain] of tools) {
    const html = toolLogo(name)
    assert.match(html, /google\.com\/s2\/favicons/)
    assert.match(html, new RegExp(`domain=${domain.replace(/\./g, '\\.')}`))
    assert.match(html, new RegExp(`aria-label="${name}"`))
    assert.match(html, new RegExp(`title="${name}"`))
    const src = html.match(/src="([^"]+)"/)[1]
    srcs.push(src)
  }
  assert.equal(new Set(srcs).size, srcs.length)
})

test('xAI / Grok resolve to xAI favicon', () => {
  assert.equal(resolveToolKey('xAI'), 'xAI')
  assert.equal(resolveToolKey('grok'), 'xAI')
  assert.equal(resolveToolKey('Grok'), 'xAI')
  const html = toolLogo('xAI')
  assert.match(html, /domain=x\.ai/)
  assert.match(html, /aria-label="xAI"/)
})
