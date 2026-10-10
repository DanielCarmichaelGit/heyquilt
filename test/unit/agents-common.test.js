import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toolLabel } from '../../src/agents/common.js'

test('toolLabel maps MCP client names and model providers', () => {
  assert.equal(toolLabel('claude-code'), 'Claude Code')
  assert.equal(toolLabel('cursor'), 'Cursor')
  assert.equal(toolLabel('grok'), 'xAI')
  assert.equal(toolLabel('xAI'), 'xAI')
  assert.equal(toolLabel('Xai Grok'), 'xAI')
  assert.equal(toolLabel(''), 'AI agent')
  assert.equal(toolLabel('Mystery'), 'Mystery')
})
