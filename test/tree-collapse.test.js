// The file tree (leftmost sidebar) can collapse and expand with a smooth transition.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const css = fs.readFileSync(path.join(root, 'src/ui/app.css'), 'utf8')
const session = fs.readFileSync(path.join(root, 'src/ui/session.js'), 'utf8')

test('the file pane has a collapse control wired to persisted layout state', () => {
  assert.match(session, /id="collapse-tree"/)
  assert.match(session, /aria-controls="tree"/)
  assert.match(session, /function toggleTreeCollapsed/)
  assert.match(session, /w\.treeCollapsed = !w\.treeCollapsed/)
  assert.match(session, /saveWs\(current\)/)
  assert.match(session, /body\.classList\.toggle\('tree-collapsed', collapsed\)/)
  assert.match(session, /applyTreeCollapsed\(\)/)
})

test('collapsing the tree animates the column and honors reduced motion', () => {
  assert.match(css, /\.ws-body \{[^}]*transition:\s*grid-template-columns \.28s ease/)
  assert.match(css, /\.ws-body\.tree-collapsed \{[^}]*grid-template-columns:\s*40px/)
  assert.match(css, /@media \(min-width: 901px\) \{[\s\S]*\.ws-body\.tree-collapsed \.tree-scroll \{[^}]*opacity:\s*0/)
  assert.match(css, /@media \(max-width: 900px\) \{[\s\S]*\.ws-body\.tree-collapsed \{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.ws-body, \.tree-scroll \{[^}]*transition:\s*none/)
})
