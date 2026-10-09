// When commits from elsewhere and the session's work both only added lines in the same place,
// or both changed one import line, the catch-up keeps both instead of stopping (src/merge3.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeAdditive } from '../src/merge3.js'

test('both sides appended different code at the end of a file: both kept, ours first', () => {
  const base = 'export const a = 1\n'
  const r = mergeAdditive(base, base + 'export const typing = 2\n', base + 'export const aiName = 3\n')
  assert.deepEqual(r.conflicts, [])
  assert.equal(r.text, 'export const a = 1\nexport const typing = 2\nexport const aiName = 3\n')
})

test('two new release sections with the same heading become one heading with both bullets', () => {
  const base = '# Releases\n\n## 0.3.24\n\n- old\n'
  const ours = '# Releases\n\n## 0.3.25\n\n- **Typing.** Dots.\n\n## 0.3.24\n\n- old\n'
  const theirs = '# Releases\n\n## 0.3.25\n\n- **CLI first.** Agents.\n\n## 0.3.24\n\n- old\n'
  const r = mergeAdditive(base, ours, theirs)
  assert.deepEqual(r.conflicts, [])
  assert.equal(r.text, '# Releases\n\n## 0.3.25\n\n- **Typing.** Dots.\n- **CLI first.** Agents.\n\n## 0.3.24\n\n- old\n')
})

test('both sides changed the same import line: one import with every name, removals kept', () => {
  const base = "import { a, b, c } from './chat.js'\nuse()\n"
  const ours = "import { a, b, typingNames } from './chat.js'\nuse()\n" // dropped c
  const theirs = "import { a, b, c, foldPersonas } from './chat.js'\nuse()\n"
  const r = mergeAdditive(base, ours, theirs)
  assert.deepEqual(r.conflicts, [])
  assert.equal(r.text, "import { a, b, typingNames, foldPersonas } from './chat.js'\nuse()\n")
})

test('real edits to the same lines, or imports of different modules, stay conflicts', () => {
  assert.equal(mergeAdditive('x = 1\n', 'x = 2\n', 'x = 3\n').conflicts.length, 1)
  assert.equal(mergeAdditive("import { a } from './a.js'\n", "import { a, b } from './a.js'\n", "import { a } from './b.js'\n").conflicts.length, 1)
})
