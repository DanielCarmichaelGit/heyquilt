import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeAction, summarizeCommand } from '../../src/agents/actions.js'

const dir = '/home/me/app'

test('edits and reads show project-relative paths', () => {
  assert.equal(describeAction('Edit', { file_path: '/home/me/app/src/a.ts' }, dir), 'Edited src/a.ts')
  assert.equal(describeAction('MultiEdit', { file_path: '/home/me/app/b.js' }, dir), 'Edited b.js')
  assert.equal(describeAction('edit_file', { target_file: 'src/x.ts' }, dir), 'Edited src/x.ts')
  assert.equal(describeAction('search_replace', { file_path: './y.ts' }, dir), 'Edited y.ts')
  assert.equal(describeAction('StrReplace', { path: '/home/me/app/src/ui/board.js' }, dir), 'Edited src/ui/board.js')
  assert.equal(describeAction('edit_file_v2', { target_file: 'src/x.ts' }, dir), 'Edited src/x.ts')
  assert.equal(describeAction('delete_file', { target_file: 'old.js' }, dir), 'Deleted old.js')
  assert.equal(describeAction('run_terminal_command_v2', { command: 'npm test' }, dir), 'Ran npm test')
  assert.equal(describeAction('Read', { file_path: '/home/me/app/README.md' }, dir), 'Read README.md')
  assert.equal(describeAction('read_file', { target_file: 'pkg.json' }, dir), 'Read pkg.json')
})

test('Write says Created for new files', () => {
  const existed = (p) => p.endsWith('old.ts')
  assert.equal(describeAction('Write', { file_path: '/home/me/app/new.ts' }, dir, { existed }), 'Created new.ts')
  assert.equal(describeAction('Write', { file_path: '/home/me/app/old.ts' }, dir, { existed }), 'Edited old.ts')
})

test('paths outside the project only show the file name', () => {
  assert.equal(describeAction('Read', { file_path: '/home/me/.ssh/config' }, dir), 'Read config')
})

test('searches are generic', () => {
  for (const t of ['Grep', 'Glob', 'grep_search', 'file_search', 'codebase_search']) {
    assert.equal(describeAction(t, { pattern: 'secret' }, dir), 'Searched the code')
  }
})

test('commands keep only the program and one plain word', () => {
  assert.equal(describeAction('Bash', { command: 'npm test -- --watch' }, dir), 'Ran npm test')
  assert.equal(describeAction('Bash', { command: 'git status' }, dir), 'Ran git status')
  assert.equal(describeAction('run_terminal_cmd', { command: 'pytest -x tests/' }, dir), 'Ran pytest')
  assert.equal(summarizeCommand('API_KEY=sk-123 TOKEN=abc npm run build'), 'npm run')
  assert.equal(summarizeCommand('curl https://example.com/?token=abc'), 'curl')
  assert.equal(summarizeCommand('curl -H "Authorization: Bearer x" https://x'), 'curl')
  assert.equal(summarizeCommand('/usr/local/bin/node script.js'), 'node')
  assert.equal(summarizeCommand('echo $SECRET'), 'echo')
  assert.equal(summarizeCommand('   '), '')
  assert.equal(summarizeCommand('cd /home/me/app && npm run build'), 'npm run')
  assert.equal(summarizeCommand('export TOKEN=x; git push origin main'), 'git push')
  assert.equal(summarizeCommand('cd somewhere'), 'cd')
})

test('unknown tools', () => {
  assert.equal(describeAction('WebFetch', { url: 'https://secret' }, dir), 'Used WebFetch')
  assert.equal(describeAction('', {}, dir), 'Used a tool')
})
