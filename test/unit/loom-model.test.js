import { test } from 'node:test'
import assert from 'node:assert/strict'

const { fileOf, turnsOf, mentionsIn, packRows, buildLoom, foldPlan, foldAiLanes, GAP_MS, COLLIDE_MS, LANE_MIN, STRIP_W, MAX_STRIPS } = await import('../../src/ui/loom-model.js')

let n = 0
const e = (kind, text, ts, conv = 'c1', tool = 'Claude Code') => ({ id: `e${++n}`, kind, text, ts, conv, tool })
const MIN = 60 * 1000

test('fileOf: reads the file out of every tool\'s action line, and nothing else', () => {
  assert.deepEqual(fileOf('Edited src/a.js'), { verb: 'edited', path: 'src/a.js' })
  assert.deepEqual(fileOf('Created docs/new file.md'), { verb: 'created', path: 'docs/new file.md' })
  assert.deepEqual(fileOf('Read README.md'), { verb: 'read', path: 'README.md' })
  assert.equal(fileOf('Edited a file'), null)
  assert.equal(fileOf('Ran npm test'), null)
  assert.equal(fileOf('Searched the code'), null)
})

test('turnsOf: a prompt opens a turn that gathers its conversation\'s actions and replies', () => {
  const turns = turnsOf([
    e('prompt', 'Fix login', 1000),
    e('action', 'Read src/login.js', 1100),
    e('action', 'Edited src/login.js', 1200),
    e('action', 'Edited src/login.js', 1250),
    e('action', 'Ran npm test', 1300),
    e('reply', 'Fixed it', 1400),
    e('prompt', 'Now the docs', 2000),
    e('action', 'Created docs/login.md', 2100)
  ], 'Ann')
  assert.equal(turns.length, 2)
  const [a, b] = turns
  assert.equal(a.prompt, 'Fix login')
  assert.deepEqual(a.edits, ['src/login.js']) // once, however often
  assert.equal(a.reads, 1)
  assert.equal(a.runs, 1)
  assert.deepEqual(a.replies.map((r) => r.text), ['Fixed it'])
  assert.equal(a.end, 1400)
  assert.equal(a.convLabel, 'Fix login')
  assert.deepEqual(b.edits, ['docs/login.md'])
  assert.equal(a.lane, 'Ann')
})

test('turnsOf: concurrent conversations keep their own turns; a long quiet starts a new one', () => {
  const turns = turnsOf([
    e('prompt', 'A', 0, 'x'),
    e('prompt', 'B', 10, 'y', 'Cursor'),
    e('action', 'Edited a.js', 20, 'x'),
    e('action', 'Edited b.js', 30, 'y', 'Cursor'),
    e('reply', 'late', 30 * MIN, 'x')
  ], 'Ann')
  assert.equal(turns.length, 3)
  assert.deepEqual(turns[0].edits, ['a.js'])
  assert.deepEqual(turns[1].edits, ['b.js'])
  assert.equal(turns[1].tool, 'Cursor')
  assert.equal(turns[2].prompt, '')
  assert.equal(turns[2].replies[0].text, 'late')
})

test('turnsOf: pause marks pass through; junk is dropped', () => {
  const turns = turnsOf([null, 'x', { id: 'p', kind: 'paused', ts: 5 }, e('weird', 'x', 6)], 'Ann')
  assert.deepEqual(turns.map((t) => t.type), ['paused'])
})

test('mentionsIn: whole names only, any case, @Agents means every agent, emails are not mentions', () => {
  const names = ['Ann', 'Ann Lee', 'Bob']
  assert.deepEqual(mentionsIn('hey @ann lee and @BOB', names), ['Ann Lee', 'Bob'])
  assert.deepEqual(mentionsIn('mail bob@Bob.com', names), [])
  assert.deepEqual(mentionsIn('@Annie hi', names), [])
  assert.deepEqual(mentionsIn('@Agents go', names, ['Bot1', 'Bot2']), ['Bot1', 'Bot2'])
})

test('packRows: lanes share rows while order reads top to bottom; a card spans to its lane\'s next one', () => {
  const items = [
    { col: 0 }, // A1
    { col: 1 }, // B1, beside A1
    { col: 1 }, // B2
    { col: 1 }, // B3
    { col: 0 }, // A2: after B3, so not above it
    { col: null }, // divider across
    { col: 1 }
  ]
  const rows = packRows(items, 2)
  assert.deepEqual(items.map((i) => i.row), [1, 1, 2, 3, 3, 4, 5])
  assert.equal(items[0].span, 2) // A1 runs down beside B1..B2 until A2
  assert.equal(items[1].span, 1)
  assert.equal(items[4].span, 1) // A2 stops at the divider
  assert.equal(rows, 5)
})

test('buildLoom: lanes, turns, chat and task notes in time order, with stitches where lanes share a file', () => {
  const t0 = new Date(2026, 9, 7, 10).getTime()
  const feeds = new Map([
    ['Ann', [e('prompt', 'Edit app', t0), e('action', 'Edited src/app.js', t0 + MIN)]],
    ['Bob', [e('prompt', 'Also app', t0 + 2 * MIN, 'b'), e('action', 'Edited src/app.js', t0 + 3 * MIN, 'b'), e('action', 'Edited src/other.js', t0 + 3 * MIN, 'b')]]
  ])
  const m = buildLoom({
    people: [
      { name: 'Ann', isMe: true, agent: { status: 'working', sharing: true } },
      { name: 'Bob', kind: 'agent', agent: { status: 'idle' } },
      { name: 'Cy' }
    ],
    feeds,
    messages: [{ id: 'aaaaaaaa', by: 'Ann', text: '@Bob careful with app.js', ts: t0 + 4 * MIN }],
    tasks: [{ id: 't1', title: 'App work', column: 'done', by: 'Cy', ts: t0 + 5 * MIN, conv: 'b', comments: [{ id: 'c1', by: 'Bob', text: 'done', ts: t0 + 6 * MIN }] }],
    claims: [{ by: 'Bob', pattern: 'src/app.js', queue: [{ by: 'Ann' }] }]
  })
  assert.deepEqual(m.lanes.map((l) => [l.name, l.working, l.kind]), [['Ann', true, 'human'], ['Bob', false, 'agent'], ['Cy', false, 'human']])
  assert.deepEqual(m.lanes[1].holds, ['src/app.js'])
  assert.equal(m.lanes[1].waiting, 1)
  assert.deepEqual(m.items.map((i) => i.type), ['turn', 'turn', 'chat', 'task', 'note'])
  assert.deepEqual(m.items.map((i) => i.col), [0, 1, 0, 2, 1])
  assert.equal(m.stitches.length, 1)
  assert.equal(m.stitches[0].path, 'src/app.js')
  assert.equal(m.stitches[0].collide, true) // within COLLIDE_MS
  assert.deepEqual(m.mentions.map((x) => x.lane), ['Bob'])
  assert.deepEqual(m.files.get('src/app.js').claim, { by: 'Bob', waiting: ['Ann'] })
  assert.deepEqual(m.items[1].tasks, [{ id: 't1', title: 'App work', column: 'done' }]) // the turn knows its task
  assert.ok(COLLIDE_MS > 3 * MIN)
})

test('buildLoom: hidden lanes, chat and tasks switched off, gaps and one column', () => {
  const t0 = new Date(2026, 9, 7, 10).getTime()
  const feeds = new Map([['Ann', [e('prompt', 'one', t0), e('prompt', 'two', t0 + GAP_MS + MIN)]], ['Bob', [e('prompt', 'b', t0)]]])
  const people = [{ name: 'Ann' }, { name: 'Bob' }]
  const messages = [{ id: 'bbbbbbbb', by: 'Ann', text: 'hi', ts: t0 + 1 }]
  const off = buildLoom({ people, feeds, messages, show: { chat: false }, hidden: ['Bob'] })
  assert.deepEqual(off.lanes.map((l) => l.name), ['Ann'])
  assert.deepEqual(off.items.map((i) => i.type), ['turn', 'gap', 'turn'])
  const one = buildLoom({ people, feeds, messages, merged: true })
  assert.ok(one.items.filter((i) => i.lane).every((i) => i.col === 0))
  const rows = one.items.map((i) => i.row)
  assert.deepEqual(rows, [...rows].sort((a, b) => a - b))
  assert.equal(new Set(rows).size, rows.length) // one column: one card a row
})

const lane = (name, extra = {}) => ({ name, lastTs: 0, ...extra })
const folds = (plan) => Object.fromEntries(plan)

test('foldPlan: everyone open when they fit (or no width is known)', () => {
  const lanes = [lane('A'), lane('B'), lane('C')]
  assert.deepEqual(folds(foldPlan(lanes, { width: 3 * LANE_MIN + 100 })), { A: 'open', B: 'open', C: 'open' })
  assert.deepEqual(folds(foldPlan(lanes, { width: 0 })), { A: 'open', B: 'open', C: 'open' })
})

test('foldPlan: as many open as fit; pinned, just opened, working, you, then most recent', () => {
  const lanes = [
    lane('Old', { lastTs: 1 }),
    lane('Recent', { lastTs: 50 }),
    lane('Me', { isMe: true, lastTs: 2 }),
    lane('Busy', { working: true, lastTs: 3 }),
    lane('Pin', { lastTs: 0 }),
    lane('Clicked', { lastTs: 0 })
  ]
  const width = 2 * LANE_MIN + 4 * STRIP_W + 200 // two open, the rest strips
  const open = (opts) => [...foldPlan(lanes, { width, ...opts })].filter(([, f]) => f === 'open').map(([n]) => n)
  assert.deepEqual(open({}), ['Me', 'Busy']) // working first, then you
  assert.deepEqual(open({ pinned: ['Pin'] }), ['Busy', 'Pin'])
  assert.deepEqual(open({ pinned: ['Pin'], opened: ['Clicked'] }), ['Pin', 'Clicked']) // the click wins over working
  assert.deepEqual(open({ opened: ['Old', 'Recent'] }), ['Old', 'Recent']) // your last two opens stay open
  assert.deepEqual(open({ opened: ['Old', 'Recent', 'Clicked'] }), ['Old', 'Recent']) // an older one doesn't
  const plan = foldPlan(lanes, { width })
  assert.equal(plan.get('Recent'), 'strip')
  assert.ok([...plan.values()].every((f) => f !== 'crowd'))
})

test('foldPlan: past a few strips the quietest share the crowd; always one lane open', () => {
  const lanes = Array.from({ length: 14 }, (_, i) => lane(`P${i}`, { lastTs: i }))
  const plan = foldPlan(lanes, { width: LANE_MIN + 200 }) // one lane and a strip; the rest crowd
  const by = (f) => [...plan].filter(([, x]) => x === f).map(([n]) => n)
  assert.deepEqual(by('open'), ['P13'])
  assert.ok(by('strip').length <= MAX_STRIPS)
  assert.ok(by('crowd').includes('P0')) // the quietest
  assert.ok(!by('crowd').includes('P12'))
  assert.deepEqual(by('open').length, 1)
  assert.equal(foldPlan(lanes, { width: 10 }).get('P13'), 'open')
})

test('buildLoom: a folded lane\'s things become knots in the rows around them, still stitched', () => {
  const t0 = new Date(2026, 9, 7, 10).getTime()
  const feeds = new Map([
    ['A', [e('prompt', 'a1', t0, 'a'), e('action', 'Edited x.js', t0 + MIN, 'a'), e('prompt', 'a2', t0 + 4 * MIN, 'a')]],
    ['B', [e('prompt', 'b1', t0 + 2 * MIN, 'b'), e('action', 'Edited x.js', t0 + 2 * MIN, 'b'), e('prompt', 'b2', t0 + 3 * MIN, 'b2')]]
  ])
  const m = buildLoom({ people: [{ name: 'A', isMe: true }, { name: 'B' }], feeds, width: LANE_MIN + 200 })
  assert.deepEqual(m.lanes.map((l) => [l.name, l.fold, l.col]), [['A', 'open', 0], ['B', 'strip', 1]])
  assert.deepEqual(m.columns.map((c) => c.kind), ['open', 'strip'])
  const turns = m.items.filter((i) => i.type === 'turn')
  assert.deepEqual(turns.map((t) => [t.lane, t.folded, t.row]), [['A', false, 1], ['B', true, 1], ['B', true, 1], ['A', false, 2]])
  assert.equal(m.knots.length, 1) // B's two turns share A's first row
  assert.deepEqual(m.knots[0].ids.length, 2)
  assert.equal(m.stitches.length, 1) // A's x.js to B's x.js still joins
})

test('buildLoom: lanes past the strips go to one crowd column at the end', () => {
  const people = Array.from({ length: 10 }, (_, i) => ({ name: `P${i}` }))
  const feeds = new Map(people.map((p, i) => [p.name, [e('prompt', 'hi', 1000 + i, p.name)]]))
  const m = buildLoom({ people, feeds, width: LANE_MIN + 300 })
  const crowd = m.columns[m.columns.length - 1]
  assert.equal(crowd.kind, 'crowd')
  assert.ok(crowd.lanes.length >= 2)
  for (const n of crowd.lanes) assert.equal(m.lanes.find((l) => l.name === n).col, m.columns.length - 1)
  const merged = buildLoom({ people, feeds, width: LANE_MIN + 300, merged: true })
  assert.ok(merged.lanes.every((l) => l.fold === 'open'))
  assert.equal(merged.knots.length, 0)
})

test('foldAiLanes: a person\'s AI sessions, here or gone, share one "<person>\'s AI" lane', () => {
  const owners = new Map([['Dan · Claude Code', 'Dan'], ['Dan · Claude Code 2', 'Dan'], ['Dan · old work', 'Dan']])
  const f = foldAiLanes({
    people: [
      { name: 'Dan', isMe: true, online: true },
      { name: 'Ann', online: true },
      { name: 'Dan · Claude Code', kind: 'agent', tool: 'claude-code', online: true, optional: true },
      { name: 'Dan · Claude Code 2', kind: 'agent', online: true, optional: true }
    ],
    owners,
    feeds: new Map([['Dan', [{ id: 'a', ts: 1 }]], ['Dan · Claude Code', [{ id: 'b', ts: 3 }]], ['Dan · Claude Code 2', [{ id: 'c', ts: 2 }]]]),
    messages: [
      { id: 'm1', by: 'Dan · Claude Code 2', to: 'Ann', text: 'hi', ts: 5 },
      { id: 'm2', by: 'Dan · old work', text: '@Ann done', ts: 6 },
      { id: 'm3', by: 'Ann', to: 'Dan · Claude Code', text: 'thanks', ts: 7 }
    ],
    tasks: [{ id: 't1', by: 'Dan · old work', comments: [{ id: 'c1', by: 'Dan · Claude Code', text: 'note' }] }],
    claims: [{ pattern: 'a.js', by: 'Dan · Claude Code 2' }]
  })
  assert.deepEqual(f.people.map((p) => p.name), ['Dan', 'Ann', "Dan's AI"])
  assert.equal(f.people[2].tool, 'claude-code')
  assert.equal(f.people[2].optional, true)
  assert.equal(f.personOf.get("Dan's AI"), 'Dan')
  assert.deepEqual(f.feeds.get("Dan's AI").map((x) => x.id), ['c', 'b'])
  assert.deepEqual(f.feeds.get('Dan').map((x) => x.id), ['a'])
  assert.deepEqual(f.messages.map((m) => [m.by, m.to]), [["Dan's AI", 'Ann'], ["Dan's AI", undefined], ['Ann', "Dan's AI"]])
  assert.equal(f.tasks[0].by, "Dan's AI")
  assert.equal(f.tasks[0].comments[0].by, "Dan's AI")
  assert.equal(f.claims[0].by, "Dan's AI")

  const loom = buildLoom(f)
  assert.deepEqual(loom.lanes.map((l) => l.name), ['Dan', 'Ann', "Dan's AI"])
  assert.deepEqual(loom.lanes[2].holds, ['a.js'])
})

test('foldAiLanes: an AI session gone from the session still gets its person\'s AI lane for what it said', () => {
  const f = foldAiLanes({ people: [{ name: 'Dan', isMe: true }], owners: new Map([['Dan · Claude Code 3', 'Dan']]), messages: [{ id: 'm', by: 'Dan · Claude Code 3', text: '@Dan hi', ts: 1 }] })
  const loom = buildLoom(f)
  assert.deepEqual(loom.lanes.map((l) => [l.name, l.online]), [['Dan', false], ["Dan's AI", false]])
  assert.equal(buildLoom({ ...f, messages: [] }).lanes.length, 1) // nothing to show: no lane
})
