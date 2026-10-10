// The Loom: every AI conversation in the session at once. One lane per person
// (their thread), time running down like a feed. Each AI turn (a prompt, what
// the AI did, its reply) is one card in its person's lane, and so are chat
// messages and task notes. Cards in different lanes that touched the same file
// are stitched together. When the lanes don't all fit, the quiet ones fold into
// thin strips (and past a few strips, into one "crowd" column) where each thing
// they did is a knot in the same rows. Pure, so it can be tested without a browser.
import { conversations } from './feed-convs.js'
import { aiName } from './chat.js'

export const GAP_MS = 20 * 60 * 1000 // a pause this long between two things gets a "later" divider
export const TURN_GAP_MS = 10 * 60 * 1000 // a conversation quiet this long starts a new turn without a prompt
export const COLLIDE_MS = 15 * 60 * 1000 // two lanes on one file this close together: shown as a collision
export const MAX_ITEMS = 400 // newest first; older ones drop off the top
const MAX_STITCHES = 240
const PREVIEW = 600

// Column widths in px, for deciding how many lanes fit (loom.css draws them).
export const LANE_MIN = 250
export const STRIP_W = 46
export const CROWD_W = 58
const COL_GAP = 18
const PAD_X = 36
export const MAX_STRIPS = 6 // more folded lanes than this: the quietest share the crowd column
const RECENT_OPENS = 2 // the lanes you opened last stay open ahead of working AIs
export const MIN_STRIPS = 4 // a lane opens only while this many folded ones still show as strips

/**
 * Which lanes stay open when they don't all fit in `width`: a Map name ->
 * 'open' | 'strip' | 'crowd'. As many open as fit, at least one. They're picked
 * in this order: pinned, the last two lanes you opened (`opened`, latest first),
 * working AIs, you, lanes opened before that, then whoever did something most recently. Of the folded
 * ones, the first few are strips and the quietest share the crowd column; another
 * lane opens only while at least MIN_STRIPS of the folded ones still get a strip.
 */
export function foldPlan (lanes, { width = 0, pinned = [], opened = [] } = {}) {
  const plan = new Map(lanes.map((l) => [l.name, 'open']))
  const n = lanes.length
  const need = (k, s, c) => k * LANE_MIN + s * STRIP_W + (c ? CROWD_W : 0) + Math.max(0, k + s + (c ? 1 : 0) - 1) * COL_GAP + PAD_X
  if (!width || n <= 1 || need(n, 0, 0) <= width) return plan

  const pin = (l) => { const i = pinned.indexOf(l.name); return i === -1 ? Infinity : i }
  const seen = (l) => { const i = opened.indexOf(l.name); return i === -1 ? Infinity : i }
  const tiers = [
    (l) => pin(l),
    (l) => Math.min(seen(l), RECENT_OPENS),
    (l) => (l.working ? 0 : 1),
    (l) => (l.isMe ? 0 : 1),
    (l) => seen(l),
    (l) => -(l.lastTs || 0)
  ]
  const at = new Map(lanes.map((l, i) => [l.name, i]))
  const order = [...lanes].sort((a, b) => {
    for (const t of tiers) {
      const x = t(a)
      const y = t(b)
      if (x !== y) return x < y ? -1 : 1
    }
    return at.get(a.name) - at.get(b.name)
  })

  let k = 1
  let s = 0
  for (let open = n - 1; open >= 1; open--) {
    const rest = n - open
    let strips = Math.min(rest, MAX_STRIPS)
    let crowd = rest - strips
    if (crowd === 1) { strips++; crowd = 0 } // a crowd of one is just a strip
    while (strips >= 0 && need(open, strips, crowd) > width) { strips--; crowd++ }
    if (strips >= Math.min(rest, MIN_STRIPS) || open === 1) { k = open; s = Math.max(0, strips); break }
  }
  order.forEach((l, i) => plan.set(l.name, i < k ? 'open' : i < k + s ? 'strip' : 'crowd'))
  return plan
}

/**
 * What an action line says about a file: { verb, path }, or null when it names
 * none. Action lines come from every tool's reader in one form ("Edited a/b.js",
 * "Read a/b.js", see src/agents/actions.js).
 */
export function fileOf (text) {
  const m = String(text || '').match(/^(Edited|Created|Deleted|Read) (.+)$/)
  if (!m || m[2] === 'a file') return null
  return { verb: m[1].toLowerCase(), path: m[2].trim() }
}

const changes = (verb) => verb === 'edited' || verb === 'created' || verb === 'deleted'

/**
 * One person's feed as turns, oldest first. A turn starts at a prompt (or at the
 * first thing in a conversation, or after it went quiet) and gathers that
 * conversation's actions and replies until its next prompt. Concurrent
 * conversations of one person each keep their own turn open. Pause and resume
 * marks come through as their own items.
 */
export function turnsOf (entries, lane) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e === 'object')
  const labels = new Map(conversations(list).map((c) => [c.conv, c.label]))
  const out = []
  const open = new Map() // conv -> its turn
  for (const e of [...list].sort((a, b) => (a.ts || 0) - (b.ts || 0))) {
    const ts = Number(e.ts) || 0
    if (e.kind === 'paused' || e.kind === 'resumed') {
      out.push({ type: e.kind, lane, ts, key: `${lane}|${e.id}` })
      continue
    }
    if (!['prompt', 'reply', 'action'].includes(e.kind)) continue
    const conv = String(e.conv || '')
    let t = open.get(conv)
    if (e.kind === 'prompt' || !t || ts - t.end > TURN_GAP_MS) {
      t = {
        type: 'turn',
        key: `${lane}|${e.id}`,
        lane,
        conv,
        convLabel: labels.get(conv) || '',
        tool: e.tool || null,
        ts,
        end: ts,
        prompt: '',
        summary: false,
        replies: [],
        actions: [],
        edits: [],
        reads: 0,
        runs: 0
      }
      out.push(t)
      open.set(conv, t)
    }
    if (!t.tool && e.tool) t.tool = e.tool
    t.end = Math.max(t.end, ts)
    const text = String(e.text || '')
    if (e.kind === 'prompt') {
      t.prompt = text
      if (e.summary) t.summary = true
    } else if (e.kind === 'reply') {
      t.replies.push({ text, ts, summary: !!e.summary })
    } else {
      t.actions.push(text)
      const f = fileOf(text)
      if (f && changes(f.verb)) { if (!t.edits.includes(f.path)) t.edits.push(f.path) } else if (f) t.reads++
      else if (/^Ran /.test(text)) t.runs++
    }
  }
  return out
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The members `text` @mentions, by the rule chat uses (src/ui/chat.js): the @
 * starts a word and the name ends one. @Agents names every agent in `agents`.
 */
export function mentionsIn (text, names, agents = []) {
  const t = String(text || '')
  if (!t.includes('@')) return []
  const list = [...new Set([...names, 'Agents'].filter(Boolean))].sort((a, b) => b.length - a.length)
  const re = new RegExp(`(^|[^\\w@])@(${list.map(escapeRe).join('|')})(?![\\w-])`, 'giu')
  const out = new Set()
  for (const m of t.matchAll(re)) {
    const said = m[2].toLowerCase()
    if (said === 'agents') { for (const a of agents) out.add(a); continue }
    const name = names.find((n) => n.toLowerCase() === said)
    if (name) out.add(name)
  }
  return [...out]
}

/**
 * Rows for the cards, in time order: a card starts no earlier than the one
 * before it (anywhere), and below the last card in its own lane, so cards in
 * different lanes sit side by side while order reads top to bottom. A card spans
 * down to the next card in its lane, so a long turn doesn't push its neighbours
 * apart. Dividers take a row across every lane. Rows count from 1 (CSS grid).
 */
export function packRows (items, laneCount) {
  const next = new Array(Math.max(1, laneCount)).fill(1)
  const last = new Array(Math.max(1, laneCount)).fill(null)
  let floor = 1
  for (const it of items) {
    if (it.col == null) {
      const row = Math.max(floor, ...next)
      it.row = row
      it.span = 1
      for (let i = 0; i < next.length; i++) {
        if (last[i]) last[i].span = Math.max(1, row - last[i].row)
        next[i] = row + 1
        last[i] = null
      }
      floor = row + 1
      continue
    }
    const row = Math.max(floor, next[it.col])
    const prev = last[it.col]
    if (prev) prev.span = Math.max(1, row - prev.row)
    it.row = row
    it.span = 1
    next[it.col] = row + 1
    last[it.col] = it
    floor = row
  }
  return Math.max(floor, ...next) - 1
}

function dayOf (ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/**
 * One lane per person's AI, as chat shows it: every AI session of a person ("Daniel · Claude
 * Code", "Daniel · Claude Code 2", ones gone since) becomes "Daniel's AI". `owners`: AI session
 * name -> its person (chat.js aiOwners). Returns the buildLoom inputs with those names folded,
 * and `personOf`: lane name -> the person whose AI chat it opens.
 */
export function foldAiLanes ({ people = [], owners = new Map(), feeds = new Map(), messages = [], tasks = [], claims = [] } = {}) {
  const lane = (name) => owners.has(name) ? aiName(owners.get(name)) : name
  const personOf = new Map()
  const out = []
  const groups = new Map()
  for (const p of people) {
    if (!p || !p.name) continue
    if (!owners.has(p.name)) { out.push(p); continue }
    const name = lane(p.name)
    const g = groups.get(name)
    if (g) { g.online = g.online || p.online; if (!g.tool && p.tool) g.tool = p.tool; continue }
    const folded = { name, kind: 'agent', tool: p.tool || '', online: p.online || false, optional: true, agent: null }
    groups.set(name, folded)
    personOf.set(name, owners.get(p.name))
    out.push(folded)
  }
  // An AI session that is gone still has its chat and notes: they go to its person's AI lane.
  for (const person of new Set(owners.values())) {
    const name = aiName(person)
    if (groups.has(name)) continue
    groups.set(name, true)
    personOf.set(name, person)
    out.push({ name, kind: 'agent', tool: '', online: false, optional: true, agent: null })
  }
  const folded = new Map()
  for (const [name, list] of feeds) {
    const key = lane(name)
    const items = Array.isArray(list) ? list : []
    folded.set(key, folded.has(key) ? [...folded.get(key), ...items].sort((a, b) => (a.ts || 0) - (b.ts || 0)) : items)
  }
  const by = (x) => owners.has(x.by) ? { ...x, by: lane(x.by) } : x
  return {
    people: out,
    feeds: folded,
    messages: (messages || []).map((m) => m && (owners.has(m.by) || owners.has(m.to)) ? { ...m, by: lane(m.by), ...(m.to ? { to: lane(m.to) } : {}) } : m),
    tasks: (tasks || []).map((t) => t ? { ...by(t), comments: (t.comments || []).map(by) } : t),
    claims: (claims || []).map((c) => c ? by(c) : c),
    personOf
  }
}

/**
 * Everything the Loom shows. `people`: [{ name, color, isMe, kind, tool, online,
 * agent, optional }] in lane order; `feeds`: Map name -> feed entries; `messages`: the
 * room's chat (already validated); `tasks`: the board, with comments; `claims`:
 * the session's claims. `show`: { chat, tasks } (both on unless false);
 * `hidden`: names whose lanes are off; `merged`: one column for everyone (a
 * narrow window). `width`: the room for lanes, in px (0: as many as there are);
 * `pinned`, `opened`: see foldPlan. Returns { lanes, columns, items, knots, rows,
 * stitches, mentions, files }: a lane's `fold` is 'open', 'strip' or 'crowd' and
 * `col` its column; things in a folded lane aren't cards but `knots`, one per
 * column and row.
 */
export function buildLoom ({ people = [], feeds = new Map(), messages = [], tasks = [], claims = [], show = {}, hidden = [], merged = false, width = 0, pinned = [], opened = [] } = {}) {
  const off = new Set(hidden)
  // Someone `optional` (an AI session working through a person's app) gets a lane only with something in it.
  const active = new Set([...feeds].filter(([, list]) => Array.isArray(list) && list.length).map(([name]) => name))
  for (const m of messages || []) active.add(m.by)
  for (const t of tasks || []) { active.add(t.by); for (const c of t.comments || []) active.add(c.by) }
  const lanes = people.filter((p) => p && p.name && !off.has(p.name) && (!p.optional || active.has(p.name))).map((p) => {
    const agent = p.agent || null
    const sharing = !agent || agent.sharing !== false
    return {
      name: p.name,
      color: p.color || null,
      isMe: !!p.isMe,
      kind: p.kind === 'agent' ? 'agent' : 'human',
      tool: p.tool && p.tool !== 'unknown' ? p.tool : (agent && agent.tool) || null,
      online: p.online || false,
      sharing,
      working: sharing && !!agent && agent.status === 'working',
      pinned: pinned.includes(p.name),
      holds: [],
      waiting: 0,
      lastTs: 0,
      fold: 'open',
      col: 0
    }
  })
  const index = new Map(lanes.map((l, i) => [l.name, i]))
  const names = people.map((p) => p && p.name).filter(Boolean)
  const agentNames = people.filter((p) => p && p.kind === 'agent').map((p) => p.name)

  for (const c of claims || []) {
    const i = index.get(c && c.by)
    if (i === undefined) continue
    lanes[i].holds.push(c.pattern)
    lanes[i].waiting += Array.isArray(c.queue) ? c.queue.length : 0
  }

  let items = []
  for (const l of lanes) items.push(...turnsOf(feeds.get(l.name), l.name))

  const doneByConv = new Map() // conv -> tasks filed under it
  for (const t of tasks || []) {
    if (!t || t.archived) continue
    if (t.conv) {
      if (!doneByConv.has(t.conv)) doneByConv.set(t.conv, [])
      doneByConv.get(t.conv).push({ id: t.id, title: t.title, column: t.column })
    }
    if (show.tasks === false) continue
    if (index.has(t.by)) items.push({ type: 'task', key: `task|${t.id}`, lane: t.by, ts: Number(t.ts) || 0, task: { id: t.id, title: t.title, column: t.column, assignee: t.assignee || '' } })
    for (const c of t.comments || []) {
      if (index.has(c.by)) items.push({ type: 'note', key: `note|${c.id}`, lane: c.by, ts: Number(c.ts) || 0, text: String(c.text || '').slice(0, PREVIEW), task: { id: t.id, title: t.title, column: t.column } })
    }
  }
  for (const it of items) if (it.type === 'turn' && it.conv && doneByConv.has(it.conv)) it.tasks = doneByConv.get(it.conv)

  if (show.chat !== false) {
    for (const m of messages || []) {
      if (!index.has(m.by)) continue
      const text = String(m.text || '')
      items.push({
        type: 'chat',
        key: `chat|${m.id}`,
        lane: m.by,
        ts: Number(m.ts) || 0,
        text: text.slice(0, PREVIEW),
        to: m.to || '',
        file: m.file ? String(m.file.name || '') : '',
        mentions: [...new Set([...(m.to ? [m.to] : []), ...mentionsIn(text, names, agentNames)])].filter((n) => n !== m.by)
      })
    }
  }

  items.sort((a, b) => a.ts - b.ts)
  if (items.length > MAX_ITEMS) items = items.slice(-MAX_ITEMS)
  for (const it of items) { const l = lanes[index.get(it.lane)]; if (l && it.ts > l.lastTs) l.lastTs = it.ts }

  // Columns: open lanes and strips in lane order, then the crowd (if any) last.
  const plan = merged ? new Map(lanes.map((l) => [l.name, 'open'])) : foldPlan(lanes, { width, pinned, opened })
  const columns = []
  const crowd = []
  for (const l of lanes) {
    l.fold = plan.get(l.name)
    if (merged) { l.col = 0; continue }
    if (l.fold === 'crowd') { crowd.push(l); continue }
    l.col = columns.length
    columns.push({ kind: l.fold, lane: l.name })
  }
  if (merged) columns.push({ kind: 'merged' })
  if (crowd.length) {
    for (const l of crowd) l.col = columns.length
    columns.push({ kind: 'crowd', lanes: crowd.map((l) => l.name) })
  }
  const laneOf = (name) => lanes[index.get(name)]

  // "Later" and day dividers between things far apart.
  const withGaps = []
  let prevTs = null
  for (const it of items) {
    if (prevTs !== null && it.ts) {
      if (dayOf(it.ts) !== dayOf(prevTs)) withGaps.push({ type: 'day', key: `day|${it.ts}`, ts: it.ts })
      else if (it.ts - prevTs >= GAP_MS) withGaps.push({ type: 'gap', key: `gap|${it.ts}`, ts: it.ts, ms: it.ts - prevTs })
    }
    withGaps.push(it)
    if (it.ts) prevTs = it.ts
  }
  items = withGaps
  items.forEach((it, i) => {
    it.id = `k${i}`
    const l = it.lane == null ? null : laneOf(it.lane)
    it.col = l ? l.col : null
    it.folded = !!l && l.fold !== 'open'
  })
  let rows = packRows(items.filter((it) => !it.folded), columns.length)

  // A folded lane's things sit in the row of the card just before them (or just after,
  // at the top or after a divider), one knot per column and row.
  let cur = null
  let lastRow = null
  let pending = []
  for (const it of items) {
    if (it.folded) { if (cur !== null) it.row = cur; else pending.push(it); continue }
    if (it.col == null) { cur = null; continue }
    cur = lastRow = it.row
    for (const p of pending) p.row = cur
    pending = []
  }
  if (pending.length) {
    if (lastRow === null || items.some((it) => !it.folded && it.col == null && it.row > lastRow)) lastRow = ++rows
    for (const p of pending) p.row = lastRow
  }
  const knots = []
  const knotAt = new Map()
  for (const it of items) {
    if (!it.folded) continue
    const at = `${it.col}|${it.row}`
    let k = knotAt.get(at)
    if (!k) { k = { id: `n${knots.length}`, col: it.col, row: it.row, ids: [], keys: [], lanes: [], ts: 0 }; knotAt.set(at, k); knots.push(k) }
    k.ids.push(it.id)
    k.keys.push(it.key)
    if (!k.lanes.includes(it.lane)) k.lanes.push(it.lane)
    k.ts = Math.max(k.ts, it.ts)
  }

  // Files: who touched each, in order, and the stitches between lanes.
  const files = new Map() // path -> { touches: [{ id, lane, ts }], claim }
  for (const it of items) {
    if (it.type !== 'turn') continue
    for (const p of it.edits) {
      if (!files.has(p)) files.set(p, { touches: [], claim: null })
      files.get(p).touches.push({ id: it.id, lane: it.lane, ts: it.ts, end: it.end })
    }
  }
  for (const c of claims || []) {
    if (c && files.has(c.pattern)) files.get(c.pattern).claim = { by: c.by, waiting: Array.isArray(c.queue) ? c.queue.map((r) => r.by) : [] }
  }
  const stitches = []
  for (const [path, f] of files) {
    for (let i = 1; i < f.touches.length; i++) {
      const a = f.touches[i - 1]
      const b = f.touches[i]
      if (a.lane === b.lane) continue
      stitches.push({ from: a.id, to: b.id, path, collide: b.ts - a.end <= COLLIDE_MS })
    }
  }
  stitches.sort((x, y) => Number(y.collide) - Number(x.collide))
  if (stitches.length > MAX_STITCHES) stitches.length = MAX_STITCHES

  const mentions = []
  for (const it of items) {
    if (it.type !== 'chat') continue
    for (const n of it.mentions) if (index.has(n)) mentions.push({ from: it.id, lane: n, col: laneOf(n).col })
  }

  return { lanes, columns, items, knots, rows, stitches, mentions, files }
}
