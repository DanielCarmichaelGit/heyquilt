// npm run test:coverage: files no test loads count as not run, instead of being left out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseLcov, sourceFiles, summarize, render } from '../../scripts/coverage.mjs'

const root = path.join(os.tmpdir(), 'quilt-coverage-root')
const lcov = [
  'TN:',
  `SF:${path.join('src', 'a.js')}`, // relative, with this computer's separator (\ on Windows)
  'FNF:4', 'FNH:2', 'BRF:10', 'BRH:5', 'LF:100', 'LH:80',
  'end_of_record',
  'TN:',
  `SF:${path.join(root, 'bin', 'cli.js')}`, // absolute
  'FNF:2', 'FNH:2', 'BRF:0', 'BRH:0', 'LF:50', 'LH:50',
  'end_of_record'
].join('\n')

test('parseLcov reads each file\'s counts, with paths relative to the project and /', () => {
  const files = parseLcov(lcov, root)
  assert.deepEqual([...files.keys()], ['src/a.js', 'bin/cli.js'])
  assert.deepEqual(files.get('src/a.js'), { lines: [80, 100], branches: [5, 10], functions: [2, 4] })
  assert.deepEqual(files.get('bin/cli.js'), { lines: [50, 50], branches: [0, 0], functions: [2, 2] })
})

test('a file no test loads counts as not run, and is listed; branches and functions stay over loaded files', () => {
  const s = summarize(parseLcov(lcov, root), ['bin/cli.js', 'src/a.js', 'src/ui/never.js'], () => 150)
  assert.deepEqual(s.lines, { hit: 130, total: 300, pct: (100 * 130) / 300 })
  assert.equal(s.loadedLines.pct, (100 * 130) / 150, 'what node\'s own table shows')
  assert.equal(s.branches.pct, 50)
  assert.equal(s.functions.pct, (100 * 4) / 6)
  assert.deepEqual(s.never.map((r) => r.file), ['src/ui/never.js'])
  assert.deepEqual(s.worst.map((r) => [r.file, r.missing]), [['src/a.js', 20], ['bin/cli.js', 0]])
})

test('the report says both numbers and names what no test loads', () => {
  const s = summarize(parseLcov(lcov, root), ['bin/cli.js', 'src/a.js', 'src/ui/never.js'], () => 150)
  const text = render(s)
  assert.match(text, /lines +43\.3% +130 of 300, counting files no test loads \(node's own table says 86\.7%\)/)
  assert.match(text, /Never loaded by any test \(1 files, 150 lines\):\n +150 lines +src\/ui\/never\.js/)
  assert.match(text, /20 lines +80\.0% of lines +50\.0% of branches +src\/a\.js/)
  assert.doesNotMatch(text, /bin\/cli\.js/, 'a fully run file is not in the list')
})

test('nothing to count is 100%, not NaN', () => {
  const s = summarize(new Map(), [], () => 0)
  assert.equal(s.lines.pct, 100)
  assert.equal(s.branches.pct, 100)
  assert.doesNotMatch(render(s), /NaN/)
})

test('sourceFiles finds .js, .mjs and .cjs under the roots, and skips node_modules and dot folders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-coverage-files-'))
  for (const f of ['src/a.js', 'src/ui/b.mjs', 'desktop/c.cjs', 'src/readme.md', 'src/node_modules/x.js', 'src/.cache/y.js', 'other/z.js']) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
    fs.writeFileSync(path.join(dir, f), '')
  }
  assert.deepEqual(sourceFiles(dir, ['src', 'desktop', 'missing']), ['desktop/c.cjs', 'src/a.js', 'src/ui/b.mjs'])
})
