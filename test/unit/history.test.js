// The chronology: every change to a shared file is kept with who, when, what
// (a capped unified diff) and the task it was for, and can be queried.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { HistoryLog, lineDiff, queryHistory, parseSince, formatHistory, currentTask, HISTORY_CAP, MAX_DIFF_CHARS } from '../../src/history.js'

const fresh = () => { const doc = new Y.Doc(); return { doc, log: new HistoryLog(doc, doc.getArray('history'), { origin: 'test' }) } }
const T0 = Date.parse('2026-10-02T12:00:00Z')

test('lineDiff: unified hunks with context, empty when equal', () => {
  assert.equal(lineDiff('a\nb\n', 'a\nb\n'), '')
  const d = lineDiff('one\ntwo\nthree\nfour\nfive\nsix\nseven\n', 'one\ntwo\nthree\nFOUR\nfive\nsix\nseven\n')
  assert.match(d, /^@@ -2,5 \+2,5 @@\n two\n three\n-four\n\+FOUR\n five\n six\n?$/)
  const created = lineDiff('', 'x\ny\n')
  assert.equal(created, '@@ -0,0 +1,2 @@\n+x\n+y')
  const deleted = lineDiff('x\n', '')
  assert.equal(deleted, '@@ -1,1 +0,0 @@\n-x')
})

test('lineDiff: far-apart changes make separate hunks; huge files get a coarse diff', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`)
  const after = lines.slice(); after[5] = 'LINE 5'; after[50] = 'LINE 50'
  const d = lineDiff(lines.join('\n'), after.join('\n'))
  assert.equal((d.match(/^@@/gm) || []).length, 2)
  const big = Array.from({ length: 5000 }, (_, i) => `${i} ${Math.random()}`).join('\n')
  const bigAfter = Array.from({ length: 5000 }, (_, i) => `${i} ${Math.random()}`).join('\n')
  const coarse = lineDiff(big, bigAfter)
  assert.ok(coarse.length <= MAX_DIFF_CHARS + 40, 'capped')
  assert.match(coarse, /truncated/)
})

test('record keeps who, what, when, counts, the diff and the task; deletes and binaries too', () => {
  const { log } = fresh()
  const task = { id: 't1', title: 'Pricing page' }
  log.record({ by: 'Dana', path: 'src/a.js', kind: 'created', before: '', after: 'a\nb\n', task, ts: T0 })
  log.record({ by: 'Dana', path: 'img.png', kind: 'created', detail: '12 bytes', ts: T0 + 1000 })
  log.record({ by: 'Sam', path: 'src/a.js', kind: 'deleted', before: 'a\nb\n', after: '', ts: T0 + 60000 })
  const e = log.entries()
  assert.equal(e.length, 3)
  assert.deepEqual({ ...e[0], id: undefined }, { id: undefined, by: 'Dana', path: 'src/a.js', kind: 'created', ts: T0, from: T0, added: 2, removed: 0, detail: '+2 -0', task: { id: 't1', title: 'Pricing page' }, diff: '@@ -0,0 +1,2 @@\n+a\n+b' })
  assert.ok(typeof e[0].id === 'string' && e[0].id.length >= 8)
  assert.equal(e[1].diff, '')
  assert.equal(e[1].detail, '12 bytes')
  assert.equal(e[1].task, null)
  assert.equal(e[2].kind, 'deleted')
  assert.equal(e[2].removed, 2)
})

test('a burst of saves to one file by one person folds into one entry spanning the burst', () => {
  const { log } = fresh()
  log.record({ by: 'Dana', path: 'src/a.js', kind: 'edited', before: 'a\nb\nc\n', after: 'a\nB\nc\n', ts: T0 })
  log.record({ by: 'Dana', path: 'src/a.js', kind: 'edited', before: 'a\nB\nc\n', after: 'a\nB\nC\n', ts: T0 + 5000 })
  log.record({ by: 'Sam', path: 'src/a.js', kind: 'edited', before: 'a\nB\nC\n', after: 'a\nB\nC\nd\n', ts: T0 + 6000 })
  log.record({ by: 'Dana', path: 'src/a.js', kind: 'edited', before: 'a\nB\nC\nd\n', after: 'a\nB\nC\nd\ne\n', ts: T0 + 90000 })
  const e = log.entries()
  assert.deepEqual(e.map((x) => [x.by, x.from, x.ts]), [['Dana', T0, T0 + 5000], ['Sam', T0 + 6000, T0 + 6000], ['Dana', T0 + 90000, T0 + 90000]])
  assert.equal(e[0].diff, '@@ -1,3 +1,3 @@\n a\n-b\n-c\n+B\n+C')
  assert.equal(e[0].added, 2)
  assert.equal(e[0].removed, 2)
  // A file created and saved again in the same burst stays "created", with the diff from nothing.
  const { log: l3 } = fresh()
  l3.record({ by: 'Dana', path: 'n.md', kind: 'created', before: '', after: 'a\n', ts: T0 })
  l3.record({ by: 'Dana', path: 'n.md', kind: 'edited', before: 'a\n', after: 'a\nb\n', ts: T0 + 2000 })
  assert.deepEqual(l3.entries().map((x) => [x.kind, x.added, x.diff]), [['created', 2, '@@ -0,0 +1,2 @@\n+a\n+b']])
  // A fold that lands back on the original text leaves a no-op entry rather than a lie.
  const { log: l2 } = fresh()
  l2.record({ by: 'Dana', path: 'x', kind: 'edited', before: 'a\n', after: 'b\n', ts: T0 })
  l2.record({ by: 'Dana', path: 'x', kind: 'edited', before: 'b\n', after: 'a\n', ts: T0 + 1000 })
  assert.equal(l2.entries().length, 1)
  assert.equal(l2.entries()[0].diff, '')
  assert.equal(l2.entries()[0].detail, '+0 -0')
})

test('the log is capped by entries and by total size, oldest first', () => {
  const { log } = fresh()
  for (let i = 0; i < HISTORY_CAP + 25; i++) log.record({ by: 'D', path: `f${i}`, kind: 'created', before: '', after: `${i}\n`, ts: T0 + i * 60000 })
  assert.equal(log.entries().length, HISTORY_CAP)
  assert.equal(log.entries()[0].path, 'f25')
  const { log: l2 } = fresh()
  const bigText = Array.from({ length: 400 }, (_, i) => `row ${i} ${'x'.repeat(20)}`).join('\n')
  for (let i = 0; i < 400; i++) l2.record({ by: 'D', path: `g${i}`, kind: 'created', before: '', after: bigText, ts: T0 + i * 60000 })
  const total = l2.entries().reduce((n, e) => n + e.diff.length, 0)
  assert.ok(total <= 1_500_000, `total ${total}`)
  assert.ok(l2.entries().length < 400)
  assert.equal(l2.entries().at(-1).path, 'g399')
})

test('parseSince understands durations, day words and dates', () => {
  const now = Date.parse('2026-10-02T15:30:00Z')
  assert.equal(parseSince('2h', now), now - 2 * 3600e3)
  assert.equal(parseSince('45m', now), now - 45 * 60e3)
  assert.equal(parseSince('3d', now), now - 3 * 86400e3)
  assert.equal(parseSince('1w', now), now - 7 * 86400e3)
  assert.equal(parseSince('2026-10-01T10:00:00Z', now), Date.parse('2026-10-01T10:00:00Z'))
  assert.equal(parseSince('today', now), new Date(now).setHours(0, 0, 0, 0))
  assert.equal(parseSince('yesterday', now), new Date(now).setHours(0, 0, 0, 0) - 86400e3)
  assert.equal(parseSince('', now), null)
  assert.equal(parseSince('soonish', now), undefined)
})

test('queryHistory filters by path or glob, person, task and time; newest last; limit keeps the newest', () => {
  const { log } = fresh()
  log.record({ by: 'Dana', path: 'src/ui/app.js', kind: 'edited', before: 'a\n', after: 'b\n', task: { id: 't1', title: 'UI' }, ts: T0 })
  log.record({ by: 'Sam', path: 'src/server.js', kind: 'edited', before: 'a\n', after: 'c\n', ts: T0 + 60000 })
  log.record({ by: 'Dana', path: 'src/ui/feed.js', kind: 'created', before: '', after: 'x\n', task: { id: 't1', title: 'UI' }, ts: T0 + 120000 })
  log.record({ by: 'Duncan', path: 'README.md', kind: 'edited', before: 'a\n', after: 'd\n', ts: T0 + 180000 })
  const all = log.entries()
  assert.deepEqual(queryHistory(all, { path: 'src/ui/**' }).map((e) => e.path), ['src/ui/app.js', 'src/ui/feed.js'])
  assert.deepEqual(queryHistory(all, { path: 'src/ui/app.js' }).map((e) => e.by), ['Dana'])
  assert.deepEqual(queryHistory(all, { path: 'src/' }).map((e) => e.path), ['src/ui/app.js', 'src/server.js', 'src/ui/feed.js'])
  assert.deepEqual(queryHistory(all, { by: 'duncan' }).map((e) => e.path), ['README.md'])
  assert.deepEqual(queryHistory(all, { task: 't1' }).length, 2)
  assert.deepEqual(queryHistory(all, { since: T0 + 90000 }).map((e) => e.path), ['src/ui/feed.js', 'README.md'])
  assert.deepEqual(queryHistory(all, { limit: 2 }).map((e) => e.path), ['src/ui/feed.js', 'README.md'])
})

test('formatHistory is one readable line per change, with diffs on request', () => {
  const { log } = fresh()
  log.record({ by: 'Dana', path: 'src/a.js', kind: 'edited', before: 'a\nb\n', after: 'a\nc\n', task: { id: 't1', title: 'Pricing page' }, ts: T0 })
  log.record({ by: 'Sam', path: 'src/b.js', kind: 'created', before: '', after: 'x\n', ts: T0 + 30000 })
  const now = T0 + 3600e3
  const txt = formatHistory(log.entries(), { now })
  const lines = txt.split('\n')
  assert.match(lines[0], /^\[1h ago\] Dana edited src\/a\.js \(\+1 -1\) for "Pricing page" \[t1\]$/)
  assert.match(lines[1], /^\[59m ago\] Sam created src\/b\.js \(\+1 -0\)$/)
  const withDiff = formatHistory(log.entries(), { now, withDiff: true })
  assert.match(withDiff, /-b\n\+c/)
  assert.equal(formatHistory([], { now }), 'No changes match.')
})

test('currentTask: the first In-progress task assigned to this name, the AI\'s first when the AI is working', () => {
  const tasks = [
    { id: 'a', title: 'Person task', column: 'doing', assignee: 'Dana', forAi: false, order: 2 },
    { id: 'b', title: 'AI task', column: 'doing', assignee: 'Dana', forAi: true, order: 3 },
    { id: 'c', title: 'Todo', column: 'todo', assignee: 'Dana', forAi: false, order: 1 },
    { id: 'd', title: 'Sam task', column: 'doing', assignee: 'Sam', forAi: false, order: 0 }
  ]
  assert.deepEqual(currentTask(tasks, 'Dana'), { id: 'a', title: 'Person task' })
  assert.deepEqual(currentTask(tasks, 'Dana', { preferAi: true }), { id: 'b', title: 'AI task' })
  assert.deepEqual(currentTask(tasks, 'Sam'), { id: 'd', title: 'Sam task' })
  assert.equal(currentTask(tasks, 'Nobody'), null)
  assert.equal(currentTask([], 'Dana'), null)
})
