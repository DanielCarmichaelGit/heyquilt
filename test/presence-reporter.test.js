// The relay's presence reports: a queue kept on disk, sent in order in batches,
// retried with backoff, and capped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PresenceReporter, PRESENCE_FILE } from '../src/presence.js'

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-presence-')), PRESENCE_FILE)
/** A stand-in for the accounts API: records each request, answers with `status()`. */
function fakeApi (status = () => 200) {
  const requests = []
  const fetch = async (url, init) => {
    requests.push({ url, headers: init.headers, events: JSON.parse(init.body).events })
    return { ok: status() < 300, status: status() }
  }
  return { fetch, requests, events: () => requests.flatMap((r) => r.events) }
}
const reporter = (o = {}) => {
  let clock = 1_000_000
  const logs = []
  const r = new PresenceReporter({ apiUrl: 'http://api.test/', secret: 's3cret', now: () => clock, log: (m) => logs.push(m), ...o })
  return { r, logs, advance: (ms) => { clock += ms }, at: () => clock }
}

test('a visit starts and ends once, with the account, name and owner; a rename is an event too', async () => {
  const api = fakeApi()
  const { r, advance } = reporter({ fetch: api.fetch })
  const v = r.visitStart({ room: 'r1', account: 'person:u1', name: 'Dana', owner: true })
  advance(5000)
  r.visitEnd(v)
  r.visitEnd(v)
  r.rename({ room: 'r1', name: 'Pricing' })
  assert.equal(await r.flush(), true)
  const [start, end, name] = api.events()
  assert.deepEqual({ ...start, id: 'x' }, { id: 'x', type: 'start', room: 'r1', account: 'person:u1', name: 'Dana', owner: true, at: 1_000_000 })
  assert.deepEqual({ ...end, id: 'x' }, { id: 'x', type: 'end', start: start.id, room: 'r1', account: 'person:u1', reason: 'left', at: 1_005_000 })
  assert.deepEqual({ ...name, id: 'x' }, { id: 'x', type: 'name', room: 'r1', name: 'Pricing', at: 1_005_000 })
  assert.equal(api.events().length, 3, 'one end per visit')
  assert.equal(api.requests[0].url, 'http://api.test/v1/relay/presence')
  assert.equal(api.requests[0].headers.authorization, 'Bearer s3cret')
  assert.equal(r.size, 0, 'sent events leave the queue')
})

test('sends at most 500 events per request, in order', async () => {
  const api = fakeApi()
  const { r } = reporter({ fetch: api.fetch })
  for (let i = 0; i < 1201; i++) r.rename({ room: `r${i}`, name: `n${i}` }) // one room each: a room keeps only its newest name
  assert.equal(await r.flush(), true)
  assert.deepEqual(api.requests.map((q) => q.events.length), [500, 500, 201])
  assert.deepEqual(api.events().map((e) => e.name), Array.from({ length: 1201 }, (_, i) => `n${i}`))
})

test('a failure keeps the events and backs off, doubling up to 10 minutes', async () => {
  let status = 503
  const api = fakeApi(() => status)
  const { r, logs, advance } = reporter({ fetch: api.fetch })
  r.rename({ room: 'r1', name: 'a' })
  const waits = []
  for (let i = 0; i < 6; i++) {
    assert.equal(await r.tick(), false)
    waits.push(r.retryAt - r.now())
    assert.equal(await r.tick(), false, 'too soon: not even tried')
    advance(waits[i])
  }
  assert.deepEqual(waits, [60_000, 120_000, 240_000, 480_000, 600_000, 600_000])
  assert.equal(api.requests.length, 6)
  assert.equal(r.size, 1)
  assert.match(logs[0], /could not report to the accounts API \(the accounts API answered 503\); trying again in 60 s/)
  assert.ok(logs.every((l) => !l.includes('s3cret')), 'the secret is never logged')
  status = 200
  assert.equal(await r.tick(), true)
  assert.equal(r.size, 0)
  assert.equal(r.failures, 0)
})

test('beyond the cap, the oldest tenth drops in one go, as whole start/end pairs; logging is once per episode', async () => {
  const api = fakeApi()
  const { r, logs } = reporter({ fetch: api.fetch, maxQueue: 20 })
  // A name, queued first: the least disposable thing here, never a drop candidate.
  r.rename({ room: 'r1', name: 'kept-name' })
  // 10 old, finished visits: start+end pairs, the most disposable things in the queue.
  for (let i = 0; i < 10; i++) {
    const v = r.visitStart({ room: 'r1', account: `person:old${i}`, name: `old${i}` })
    r.visitEnd(v)
  }
  // One still-open visit: its lone `start` has no matching `end` yet.
  const open = r.visitStart({ room: 'r1', account: 'person:open', name: 'Open' })
  assert.ok(r.size <= 20, 'the first overflow already dropped more than one event')
  assert.equal(logs.length, 1)
  const m = logs[0].match(/presence: the queue is full \(20 events\); dropped (\d+) oldest event\(s\)/)
  assert.ok(m, logs[0])
  assert.ok(Number(m[1]) >= 2, 'drops a batch (a tenth of the cap), not one event at a time')
  // The name and the still-open visit's start both survive every drop.
  assert.ok(r.queue.some((x) => x.ev.type === 'name' && x.ev.name === 'kept-name'))
  assert.ok(r.queue.some((x) => x.ev.id === open.start))
  // Whatever's left is either a `name`, that one open `start`, or a matched pair: no orphan `end`.
  for (const x of r.queue) {
    if (x.ev.type !== 'end') continue
    assert.ok(r.queue.some((y) => y.ev.id === x.ev.start), `end ${x.ev.id} has no matching start left in the queue`)
  }
  // More overflows while nothing is sent: still the one log line, not one per event.
  for (let i = 0; i < 10; i++) r.rename({ room: `more${i}`, name: `more${i}` })
  assert.equal(logs.length, 1, 'the episode has not drained: no second log line')
  await r.flush()
  assert.equal(r.size, 0)
  // Once the queue has actually drained (by sending), a fresh overflow logs again.
  for (let i = 0; i < 25; i++) r.rename({ room: `again${i}`, name: `again${i}` })
  assert.equal(logs.length, 2, 'a new overflow episode after a drain logs again')
})

test('name events are never dropped, however badly the queue is overflowing', () => {
  const { r } = reporter({ maxQueue: 5 })
  r.rename({ room: 'r1', name: 'kept' })
  for (let i = 0; i < 50; i++) r.visitStart({ room: 'r1', account: `person:u${i}`, name: `n${i}` })
  assert.ok(r.size <= 5)
  assert.ok(r.queue.some((x) => x.ev.type === 'name' && x.ev.name === 'kept'))
})

test('during a long outage, new starts keep being recorded while old start/end pairs are dropped first', () => {
  const { r } = reporter({ maxQueue: 8 })
  // 5 visits that already finished: no longer useful once the queue is full.
  for (let i = 0; i < 5; i++) {
    const v = r.visitStart({ room: 'r1', account: `person:old${i}`, name: `old${i}` })
    r.visitEnd(v)
  }
  // 8 more visits start, none of them ending: the outage is still going.
  const fresh = []
  for (let i = 0; i < 8; i++) fresh.push(r.visitStart({ room: 'r1', account: `person:new${i}`, name: `new${i}` }).start)
  // Every still-open, freshly started visit survived...
  for (const id of fresh) assert.ok(r.queue.some((x) => x.ev.id === id), `fresh start ${id} should not have been dropped`)
  // ...and nothing of the old, finished visits is left: a dropped pair leaves no orphan.
  assert.ok(r.queue.every((x) => fresh.includes(x.ev.id)))
})

test('dropping from a queue of about 100,000 events is linear, not quadratic', () => {
  const { r } = reporter({ maxQueue: 100_000 })
  for (let i = 0; i < 100_000; i++) {
    const v = r.visitStart({ room: 'r1', account: `person:u${i}`, name: `n${i}` })
    if (i % 2 === 0) r.visitEnd(v) // half already finished pairs, half still open
  }
  assert.ok(r.size <= 100_000)
  const started = Date.now()
  r.rename({ room: 'r1', name: 'tip' }) // one more push: triggers exactly one drop of ~10,000 events
  const elapsed = Date.now() - started
  assert.ok(elapsed < 100, `dropping took ${elapsed}ms; should be well under 100ms`)
})

test('a full rewrite caused by a drop happens at most once a minute, not on every drop', () => {
  const file = tmp()
  const { r, advance } = reporter({ file, maxQueue: 10 })
  // Unmatched starts: a `name` can't be dropped any more, so it can't stand in here.
  for (let i = 0; i < 12; i++) r.visitStart({ room: 'r1', account: `person:a${i}`, name: `a${i}` }) // overflows once: the first-ever rewrite is never throttled
  r.persist()
  const linesAfterFirst = fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(linesAfterFirst.length, 11, '1 header line + the 10 that survived the drop')
  for (let i = 0; i < 12; i++) r.visitStart({ room: 'r1', account: `person:b${i}`, name: `b${i}` }) // overflows again, under a minute later
  r.persist()
  const linesAfterSecond = fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(linesAfterSecond.length, 23, 'new events are still appended; the drop itself is throttled, so stale lines stay')
  advance(60_000)
  r.persist()
  const linesAfterCatchup = fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(linesAfterCatchup.length, 11, 'a minute later, the deferred rewrite catches up and the stale lines are gone')
})

test('a queue file line that parses but is not an event object (null, a number, a string) is skipped, not fatal', () => {
  const file = tmp()
  fs.writeFileSync(file, ['null', '42', '"oops"', '{"open":[]}'].join('\n') + '\n')
  const { r, logs } = reporter({ file })
  assert.equal(r.load(), 0)
  assert.match(logs[0], /skipped 3 unreadable line/)
})

test('the queue survives a restart, and visits left open are ended at startup', async () => {
  const file = tmp()
  const down = fakeApi(() => 500)
  const first = reporter({ file, fetch: down.fetch })
  const a = first.r.visitStart({ room: 'r1', account: 'person:u1', name: 'Dana' })
  const b = first.r.visitStart({ room: 'r1', account: 'agent:a1', name: 'Larry' })
  first.r.visitEnd(b)
  first.r.persist()
  // The process dies here: no close(). A line cut off mid-write is skipped.
  fs.appendFileSync(file, '{"id":"half')
  const api = fakeApi()
  const second = reporter({ file, fetch: api.fetch })
  second.advance(60_000)
  assert.equal(second.r.load(), 1)
  assert.match(second.logs[0], /skipped 1 unreadable line/)
  assert.equal(await second.r.flush(), true)
  const events = api.events()
  assert.deepEqual(events.map((e) => [e.type, e.account]), [['start', 'person:u1'], ['start', 'agent:a1'], ['end', 'agent:a1'], ['end', 'person:u1']])
  assert.equal(events[3].start, a.start)
  assert.equal(events[3].at, 1_060_000, 'ended when the relay came back')
  // Everything was sent, so a third start finds nothing to send or end.
  const third = reporter({ file, fetch: api.fetch })
  assert.equal(third.r.load(), 0)
  assert.equal(third.r.size, 0)
})

test('a visit whose start was already sent is still ended after a crash', async () => {
  const file = tmp()
  const api = fakeApi()
  const first = reporter({ file, fetch: api.fetch })
  const v = first.r.visitStart({ room: 'r1', account: 'person:u1', name: 'Dana' })
  await first.r.flush() // the start is sent, and leaves the queue
  assert.equal(first.r.size, 0)
  const second = reporter({ file, fetch: api.fetch })
  assert.equal(second.r.load(), 1)
  await second.r.flush()
  const last = api.events().at(-1)
  assert.deepEqual([last.type, last.start], ['end', v.start])
})

test('closing ends open visits, saves the queue and sends it; nothing is recorded after', async () => {
  const file = tmp()
  const api = fakeApi()
  const { r } = reporter({ file, fetch: api.fetch })
  r.visitStart({ room: 'r1', account: 'person:u1', name: 'Dana' })
  await r.close()
  assert.deepEqual(api.events().map((e) => e.type), ['start', 'end'])
  assert.equal(r.visitStart({ room: 'r1', account: 'person:u1', name: 'Dana' }), null)
  assert.equal(r.size, 0)
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.deepEqual(lines, ['{"open":[]}'], 'only the (empty) list of open visits is left on disk')
})

test('with no file the queue lives in memory', async () => {
  const api = fakeApi()
  const { r } = reporter({ fetch: api.fetch })
  assert.equal(r.load(), 0)
  r.rename({ room: 'r1', name: 'x' })
  r.persist()
  assert.equal(await r.flush(), true)
})

test('a room keeps at most one name waiting: 1,000 rapid renames queue just the newest', async () => {
  const api = fakeApi()
  const { r } = reporter({ fetch: api.fetch })
  r.rename({ room: 'other', name: 'Other' })
  for (let i = 0; i < 1000; i++) r.rename({ room: 'r1', name: `n${i}` })
  assert.deepEqual(r.queue.filter((x) => x.ev.room === 'r1').map((x) => x.ev.name), ['n999'])
  assert.equal(r.size, 2, "another room's name is left alone")
  assert.equal(await r.flush(), true)
  assert.deepEqual(api.events().map((e) => e.name), ['Other', 'n999'])
})

/** A fetch that waits until the test lets it answer, so a send can be caught in flight. */
function heldApi () {
  const api = fakeApi()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const fetch = async (url, init) => { await gate; return api.fetch(url, init) }
  return { ...api, fetch, release }
}

test('a rename while the room\'s last name is being sent queues the new one; neither is lost', async () => {
  const api = heldApi()
  const { r } = reporter({ fetch: api.fetch })
  r.rename({ room: 'r1', name: 'first' })
  const sending = r.flush()
  r.rename({ room: 'r1', name: 'second' })
  api.release()
  assert.equal(await sending, true)
  assert.deepEqual(api.events().map((e) => e.name), ['first', 'second'])
})

test('an overflow never drops the end of a visit whose start was already sent', async () => {
  const api = fakeApi()
  const { r } = reporter({ fetch: api.fetch, maxQueue: 10 })
  const sent = r.visitStart({ room: 'r1', account: 'person:sent', name: 'Sent' })
  await r.flush() // its start reached the API: only its end can close the visit there
  r.visitEnd(sent)
  // The queue fills with dropped visits' leftovers: open starts first, then ends whose starts went.
  const later = []
  for (let i = 0; i < 30; i++) later.push(r.visitStart({ room: 'r1', account: `person:u${i}`, name: `u${i}` }))
  for (const v of later) r.visitEnd(v)
  assert.ok(r.queue.some((x) => x.ev.type === 'end' && x.ev.start === sent.start), 'the sent visit\'s end is still queued')
  await r.flush()
  assert.ok(api.events().some((e) => e.type === 'end' && e.start === sent.start))
})

test('an overflow never drops a start that is in the batch being sent', async () => {
  const api = heldApi()
  const { r } = reporter({ fetch: api.fetch, maxQueue: 10 })
  const inFlight = []
  for (let i = 0; i < 5; i++) inFlight.push(r.visitStart({ room: 'r1', account: `person:f${i}`, name: `f${i}` }))
  const sending = r.flush()
  // While those five are on their way, their visits end and the queue overflows.
  for (const v of inFlight) r.visitEnd(v)
  for (let i = 0; i < 30; i++) r.visitStart({ room: 'r1', account: `person:u${i}`, name: `u${i}` })
  for (const v of inFlight) {
    assert.ok(r.queue.some((x) => x.ev.id === v.start), 'the start in flight is still queued')
    assert.ok(r.queue.some((x) => x.ev.type === 'end' && x.ev.start === v.start), 'and so is its end')
  }
  api.release()
  await sending
  const events = api.events()
  for (const v of inFlight) assert.ok(events.some((e) => e.type === 'end' && e.start === v.start), 'every visit sent is closed')
})

test('while the disk is failing, appends are given up for one rewrite later, and logged once per episode', () => {
  const file = tmp()
  fs.mkdirSync(file) // the queue file's path is a folder: every write fails
  const { r, logs, advance } = reporter({ file })
  for (let i = 0; i < 3; i++) {
    r.visitStart({ room: 'r1', account: `person:u${i}`, name: `u${i}` })
    r.persist()
    advance(1000)
  }
  assert.equal(logs.filter((l) => l.includes('could not save the queue')).length, 1, 'one line per failure episode, not every second')
  assert.deepEqual(r.unwritten, [], 'nothing piles up waiting for an append')
  assert.equal(r.rewrite, true, 'the next save writes the queue whole')
  // The disk recovers: the rewrite brings the file back in line with the queue.
  fs.rmdirSync(file)
  advance(60_000)
  r.persist()
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 4, 'the header line and all three starts')
  // A new failure is a new episode, and logs again.
  fs.rmSync(file)
  fs.mkdirSync(file)
  r.visitStart({ room: 'r1', account: 'person:later', name: 'Later' })
  r.persist()
  assert.equal(logs.filter((l) => l.includes('could not save the queue')).length, 2)
})

test('the audit trail: a visit says how it came in, why it ended (and when, if given), and what it did, a repeat once a minute', async () => {
  const api = fakeApi()
  const { r, advance } = reporter({ fetch: api.fetch })
  const v = r.visitStart({ room: 'r1', account: 'agent:a1', name: 'Bot', via: 'hosted', tool: 'Codex' })
  r.act(v, 'edited', 'src/a.js')
  advance(30_000)
  r.act(v, 'edited', 'src/a.js') // within the minute: not again
  r.act(v, 'claimed', 'src/a.js')
  r.act(v, 'nonsense', 'x') // not an action
  advance(30_000)
  r.act(v, 'edited', 'src/a.js') // a minute on: again
  r.visitEnd(v, 'idle', 1_010_000)
  r.act(v, 'edited', 'src/b.js') // after it ended: nothing
  assert.equal(await r.flush(), true)
  const evs = api.events()
  assert.deepEqual([evs[0].via, evs[0].tool], ['hosted', 'Codex'])
  assert.deepEqual(evs.filter((e) => e.type === 'act').map((e) => [e.action, e.target, e.start === evs[0].id, e.at]), [
    ['edited', 'src/a.js', true, 1_000_000], ['claimed', 'src/a.js', true, 1_030_000], ['edited', 'src/a.js', true, 1_060_000]
  ])
  const end = evs.at(-1)
  assert.deepEqual([end.type, end.reason, end.at], ['end', 'idle', 1_010_000])
})

test('an unknown end reason is left out, and an end time is never in the future', async () => {
  const api = fakeApi()
  const { r } = reporter({ fetch: api.fetch })
  const v = r.visitStart({ room: 'r1', account: 'person:u1', name: 'Dana' })
  r.visitEnd(v, 'because', 5_000_000)
  await r.flush()
  const end = api.events().at(-1)
  assert.equal(end.reason, undefined)
  assert.equal(end.at, 1_000_000)
})

test('over the cap, what visits did goes first; starts and ends stay', () => {
  const { r } = reporter({ maxQueue: 20 })
  const v = r.visitStart({ room: 'r1', account: 'person:u1', name: 'Dana' })
  for (let i = 0; i < 30; i++) r.act(v, 'edited', `f${i}`)
  r.visitEnd(v, 'left')
  const types = r.queue.map((x) => x.ev.type)
  assert.ok(types.includes('start') && types.includes('end'))
  assert.ok(r.size <= 20)
})

test('visits a crash left open end as relay_restart on the next start', () => {
  const file = tmp()
  const a = new PresenceReporter({ apiUrl: 'http://api.test', secret: 's', file, fetch: async () => ({ ok: false, status: 503 }) })
  a.visitStart({ room: 'r1', account: 'person:u1', name: 'Dana' })
  a.persist(true)
  const b = new PresenceReporter({ apiUrl: 'http://api.test', secret: 's', file })
  assert.equal(b.load(), 1)
  assert.equal(b.queue.at(-1).ev.reason, 'relay_restart')
})
