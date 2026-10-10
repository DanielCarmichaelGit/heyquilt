// The Loom (see loom-model.js): everyone's AI conversations at once, one lane
// per person, time running down. Cards open in place; file chips light up every
// lane that touched the file; threads stitch lanes that worked on the same file.
// Lanes that don't fit fold into strips of knots (and a crowd column past that).
import { esc, clock, ago, avatar, colorFor, basename, I } from './common.js'
import { toolLogo, toolLabel } from './tool-logo.js'
import { markdown, visiblePrompt } from './feed.js'
import { textHtml } from './chat.js'

const MERGE_BELOW = 620 // narrower than this, lanes fold into one column
const FILES_SHOWN = 4

let expanded = new Set() // card keys opened in place
let seen = null // card keys already shown (null: nothing shown yet, so nothing is "new")
let lastHtml = ''
let model = null
let focused = null // file path lit from a chip or the file tree
let anchor = null // { key, y }: a card just opened or closed stays where it was on screen
let crowdOpen = false // the crowd column's list of people is showing
let lastWidth = 0
let handlers = { onAction: () => {} }
const bound = new WeakSet()

/** Forget open cards and what was shown: another session is being shown. */
export function resetLoom () {
  expanded = new Set()
  seen = null
  lastHtml = ''
  model = null
  focused = null
  crowdOpen = false
}

/** True when `el` holds the Loom now. */
export const showsLoom = (el) => !!el?.querySelector(':scope > .loom')

/**
 * Renders the Loom into `el`. `build(merged, width)` returns the model
 * (loom-model.js) for one column or for lanes in `width` px; `prefs`: { chat,
 * tasks, density, layout, hidden, pinned };
 * `onAction(kind, value)`: open 'person' (a name), 'conv' ({ name, conv }), 'file'
 * (a path) or 'task' (an id); change a pref: 'hide' / 'unhide' (a name), 'toggle'
 * ('chat' | 'tasks'), 'density', 'layout', 'pin' / 'open-lane' (a name); or just
 * render again ('expand', 'refresh').
 * Skips the DOM when nothing changed.
 */
export function renderLoom (el, { build, prefs, me, names, meAgent, onAction }) {
  handlers = { onAction }
  const wasLoom = showsLoom(el)
  const merged = prefs.layout === 'merged' || (el.clientWidth > 0 && el.clientWidth < MERGE_BELOW)
  lastWidth = el.clientWidth
  model = build(merged, Math.max(0, el.clientWidth - 14)) // less a scrollbar
  const html = loomHtml(model, { prefs, me, names, meAgent, merged })
  if (wasLoom && html === lastHtml) return
  const scroller = el.querySelector('.loom-scroll')
  const atBottom = !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
  const top = scroller ? scroller.scrollTop : 0
  const left = scroller ? scroller.scrollLeft : 0
  lastHtml = html
  el.innerHTML = html
  const s = el.querySelector('.loom-scroll')
  const held = anchor && [...s.querySelectorAll('[data-key]')].find((c) => c.dataset.key === anchor.key)
  if (held) s.scrollTop += held.getBoundingClientRect().top - anchor.y
  else if (!wasLoom || atBottom) s.scrollTop = s.scrollHeight
  else {
    s.scrollTop = top
    if (seen && model.items.some((it) => it.lane && !seen.has(it.key))) el.querySelector('.loom-jump').hidden = false
  }
  s.scrollLeft = left
  anchor = null
  if (!seen) seen = new Set()
  for (const it of model.items) seen.add(it.key)
  bind(el)
  watchSize(el)
  drawThreads(el)
  if (focused) focusFile(el, focused)
}

// ------------------------------------------------------------- markup --

function loomHtml (m, { prefs, me, names, meAgent, merged }) {
  const lanes = m.lanes
  const byName = new Map(lanes.map((l) => [l.name, l]))
  const WIDTH = { open: 'minmax(250px, 1fr)', strip: '46px', crowd: '58px', merged: 'minmax(0, 1fr)' }
  const cols = m.columns.length ? m.columns.map((c) => WIDTH[c.kind]).join(' ') : 'minmax(0, 1fr)'
  const colorOf = new Map(lanes.map((l) => [l.name, colorFor(l.name, l.color)]))
  const turns = m.items.filter((it) => it.type === 'turn')
  const convs = new Set(turns.map((t) => `${t.lane}|${t.conv}`)).size
  const working = lanes.filter((l) => l.working).length
  const dens = prefs.density === 'compact' ? 'compact' : 'detailed'
  const hidden = (prefs.hidden || []).filter(Boolean)

  const bar = `<div class="loom-bar">
    <div class="loom-title"><b>Everyone</b><span class="hint">${convs} conversation${convs === 1 ? '' : 's'} · ${m.files.size} file${m.files.size === 1 ? '' : 's'} changed${working ? ` · <span class="loom-live"><span class="pulse"></span>${working} working</span>` : ''}</span></div>
    <span class="spacer"></span>
    ${hidden.map((n) => `<button class="loom-chip off" data-loom-unhide="${esc(n)}" title="Show ${esc(n)}'s lane">${I.eye}<span>${esc(n)}</span></button>`).join('')}
    <div class="loom-seg" role="group" aria-label="Show">
      <button class="loom-chip${prefs.chat !== false ? ' on' : ''}" data-loom-pref="chat" aria-pressed="${prefs.chat !== false}">${I.chat}<span>Chat</span></button>
      <button class="loom-chip${prefs.tasks !== false ? ' on' : ''}" data-loom-pref="tasks" aria-pressed="${prefs.tasks !== false}">${I.board}<span>Tasks</span></button>
    </div>
    <div class="loom-seg" role="group" aria-label="Detail">
      <button class="loom-chip${dens === 'detailed' ? ' on' : ''}" data-loom-density="detailed" aria-pressed="${dens === 'detailed'}">Detailed</button>
      <button class="loom-chip${dens === 'compact' ? ' on' : ''}" data-loom-density="compact" aria-pressed="${dens === 'compact'}">Compact</button>
    </div>
    <div class="loom-seg wide-only" role="group" aria-label="Layout">
      <button class="loom-chip${prefs.layout !== 'merged' ? ' on' : ''}" data-loom-layout="lanes" aria-pressed="${prefs.layout !== 'merged'}" title="A lane per person">Lanes</button>
      <button class="loom-chip${prefs.layout === 'merged' ? ' on' : ''}" data-loom-layout="merged" aria-pressed="${prefs.layout === 'merged'}" title="One column, in time order">One column</button>
    </div>
  </div>`

  const heads = merged
    ? ''
    : `<div class="loom-heads" style="grid-template-columns:${cols}">${m.columns.map((c) => {
      if (c.kind === 'crowd') return crowdHeadHtml(c.lanes.map((n) => byName.get(n)), colorOf)
      const l = byName.get(c.lane)
      return c.kind === 'strip' ? stripHeadHtml(l, colorOf.get(l.name)) : headHtml(l, colorOf.get(l.name))
    }).join('')}</div>`

  const parts = []
  if (!merged) {
    m.columns.forEach((c, i) => {
      const l = c.lane ? byName.get(c.lane) : null
      const cls = l ? `${l.sharing ? '' : ' paused'}${l.working ? ' live' : ''}${c.kind === 'strip' ? ' strip' : ''}` : ' crowd'
      parts.push(`<div class="loom-thread${cls}" style="grid-column:${i + 1};grid-row:1 / ${m.rows + 2};--c:${esc(l ? colorOf.get(l.name) : 'var(--border-strong)')}" aria-hidden="true"></div>`)
    })
  } else {
    parts.push(`<div class="loom-thread merged" style="grid-column:1;grid-row:1 / ${m.rows + 2}" aria-hidden="true"></div>`)
  }
  for (const it of m.items) if (!it.folded) parts.push(itemHtml(it, { colorOf, me, names, meAgent, merged, dens }))
  for (const k of m.knots) parts.push(knotHtml(k, m, colorOf, me))
  if (!m.items.some((it) => it.lane)) {
    parts.push(`<div class="loom-empty" style="grid-column:1 / -1;grid-row:1">
      <div class="t">Nothing woven yet</div>
      <div class="hint">When anyone here works with their AI, each turn shows up in their lane: what they asked, what it did and which files it changed. Chat and task notes appear in the lane of whoever wrote them.</div></div>`)
  }
  // A working AI's needle, with the file its latest turn last changed.
  let stacked = 0 // one column: needles one under another
  lanes.forEach((l) => {
    if (!l.working || l.fold === 'crowd') return
    if (l.fold === 'strip') {
      parts.push(`<div class="loom-needle mini" style="grid-column:${l.col + 1};grid-row:${m.rows + 1};--c:${esc(colorOf.get(l.name))}" title="${esc(`${l.name}'s AI is stitching`)}">${NEEDLE}</div>`)
      return
    }
    const turn = m.items.filter((it) => it.type === 'turn' && it.lane === l.name).pop()
    const file = turn && turn.edits.length ? turn.edits[turn.edits.length - 1] : ''
    const who = l.isMe ? 'Your AI' : `${l.name}'s AI`
    const what = file ? ` <code title="${esc(file)}">${esc(basename(file))}</code>` : ''
    const col = merged ? 1 : l.col + 1
    const row = m.rows + 1 + (merged ? stacked++ : 0)
    parts.push(`<div class="loom-needle" style="grid-column:${col};grid-row:${row};--c:${esc(colorOf.get(l.name))}">${NEEDLE}<span>${esc(who)} is stitching${what}…</span></div>`)
  })

  return `<div class="loom${merged ? ' merged' : ''}" data-density="${dens}">
    ${bar}
    <div class="loom-scroll">
      ${heads}
      <div class="loom-grid" role="feed" aria-label="Everyone's AI conversations, chat and task notes" style="grid-template-columns:${cols}">
        ${parts.join('')}
        <svg class="loom-stitches" aria-hidden="true"></svg>
      </div>
    </div>
    <button class="btn sm loom-jump" hidden>${I.down}<span>New activity</span></button>
    <div class="loom-tip" role="tooltip" hidden></div>
  </div>`
}

function headHtml (l, color) {
  const status = !l.sharing ? '<span class="lh-st paused">paused</span>'
    : l.working ? '<span class="lh-st live"><span class="pulse"></span>working</span>'
      : l.online ? '<span class="lh-st">idle</span>' : '<span class="lh-st off">offline</span>'
  const holds = l.holds.length
    ? `<span class="lh-holds" title="${esc(`Holds ${l.holds.join(', ')}`)}">holds ${l.holds.length}${l.waiting ? ` · ${l.waiting} waiting` : ''}</span>`
    : ''
  return `<div class="loom-head" style="--c:${esc(color)}">
    <button class="lh-who" data-loom-person="${esc(l.name)}" title="${esc(l.isMe ? 'Your AI chat' : `${l.name}'s AI chat`)}">
      ${avatar(l.name, l.color, l.online)}
      <span class="lh-name">${esc(l.isMe ? 'You' : l.name)}</span>
      ${l.tool ? `<span class="lh-tool" title="${esc(toolLabel(l.tool))}">${toolLogo(l.tool)}</span>` : ''}
      ${l.kind === 'agent' ? '<span class="tag">AI</span>' : ''}
    </button>
    <span class="lh-meta">${status}${holds}</span>
    <button class="lh-pin${l.pinned ? ' on' : ''}" data-loom-pin="${esc(l.name)}" title="${l.pinned ? 'Unpin: let this lane fold when there\'s no room' : 'Pin: keep this lane open'}" aria-pressed="${l.pinned}" aria-label="${esc(`${l.pinned ? 'Unpin' : 'Pin'} ${l.name}'s lane`)}">${PIN}</button>
    <button class="lh-hide" data-loom-hide="${esc(l.name)}" title="Hide this lane" aria-label="Hide ${esc(l.name)}'s lane">${I.x}</button>
  </div>`
}

/** A folded lane's head: its avatar, a pulse while its AI works. Click to open the lane. */
function stripHeadHtml (l, color) {
  const status = !l.sharing ? 'paused' : l.working ? 'working' : l.online ? 'idle' : 'offline'
  return `<button class="loom-head strip${l.working ? ' live' : ''}" data-loom-open="${esc(l.name)}" style="--c:${esc(color)}" title="${esc(`${l.isMe ? 'You' : l.name} (${status}${l.lastTs ? `, last active ${ago(l.lastTs)}` : ''}). Click to open this lane`)}" aria-label="${esc(`Open ${l.name}'s lane`)}">
    ${avatar(l.name, l.color, l.online)}${l.working ? '<span class="pulse"></span>' : ''}
  </button>`
}

/** The crowd column's head: a few avatars and a count; it opens a list of everyone in it. */
function crowdHeadHtml (lanes, colorOf) {
  const live = lanes.filter((l) => l.working).length
  const list = [...lanes].sort((a, b) => b.lastTs - a.lastTs).map((l) => `<button class="lcw-row" data-loom-open="${esc(l.name)}" role="menuitem">
      ${avatar(l.name, l.color, l.online)}<span class="lcw-name">${esc(l.isMe ? 'You' : l.name)}</span>
      <span class="lcw-st">${l.working ? '<span class="pulse"></span>working' : l.lastTs ? esc(ago(l.lastTs)) : 'nothing yet'}</span></button>`).join('')
  return `<div class="loom-head crowd${crowdOpen ? ' open' : ''}">
    <button class="lcw-btn" data-loom-crowd aria-haspopup="true" aria-expanded="${crowdOpen}" title="${esc(`${lanes.length} quieter lanes: ${lanes.map((l) => l.name).join(', ')}`)}">
      <span class="lcw-stack">${lanes.slice(0, 3).map((l) => avatar(l.name, colorOf.get(l.name))).join('')}</span>
      <span class="lcw-n">+${lanes.length}</span>${live ? '<span class="pulse"></span>' : ''}
    </button>
    <div class="lcw-list" role="menu" aria-label="Quieter lanes"${crowdOpen ? '' : ' hidden'}>
      <div class="lcw-title">Quieter lanes</div>${list}
    </div>
  </div>`
}

/** Everything a folded lane did around one row, as one knot (a count when it's several). */
function knotHtml (k, m, colorOf, me) {
  const lane = k.lanes[k.lanes.length - 1]
  const fresh = seen && k.keys.some((key) => !seen.has(key)) ? ' kn-new' : ''
  const who = k.lanes.map((n) => (n === me ? 'You' : n)).join(', ')
  const n = k.ids.length
  return `<button class="loom-knot${fresh}" data-knot="${k.ids.join(' ')}" data-loom-open="${esc(lane)}" tabindex="-1" style="grid-column:${k.col + 1};grid-row:${k.row};--c:${esc(colorOf.get(lane) || colorFor(lane))}" aria-label="${esc(`${who}: ${n} thing${n === 1 ? '' : 's'} at ${clock(k.ts)}. Open the lane`)}">
    <span class="kn-dot"></span>${n > 1 ? `<span class="kn-n">${n}</span>` : ''}</button>`
}

function place (it, merged) {
  return `grid-column:${merged || it.col == null ? '1 / -1' : it.col + 1};grid-row:${it.row} / span ${it.span || 1}`
}

function itemHtml (it, { colorOf, me, names, meAgent, merged, dens }) {
  if (it.type === 'gap' || it.type === 'day') {
    const label = it.type === 'day'
      ? new Date(it.ts).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
      : `${later(it.ms)} later`
    return `<div class="loom-gap" style="grid-column:1 / -1;grid-row:${it.row}"><span>${esc(label)}</span></div>`
  }
  const color = colorOf.get(it.lane) || colorFor(it.lane)
  const style = `${place(it, merged)};--c:${esc(color)}`
  const fresh = seen && !seen.has(it.key) ? ' lc-new' : ''
  const who = merged ? `<span class="lc-who">${avatar(it.lane, color)}<b>${esc(it.lane === me ? 'You' : it.lane)}</b></span>` : ''
  const time = `<time title="${esc(new Date(it.ts).toLocaleString())}">${esc(clock(it.ts))}</time>`

  if (it.type === 'paused' || it.type === 'resumed') {
    return `<div class="lc-mark" data-id="${it.id}" style="${style}">${who}<span>${it.type === 'paused' ? 'Paused sharing' : 'Resumed sharing'}</span>${time}</div>`
  }
  if (it.type === 'chat') {
    const to = it.to ? `<span class="lc-dm">to ${esc(it.to === me ? 'you' : it.to)}</span>` : ''
    return `<article class="lc lc-chat${fresh}" data-id="${it.id}" tabindex="0" style="${style}" aria-label="${esc(`${it.lane} in chat`)}">
      <header class="lc-head">${who}<span class="lc-kind">${I.chat}</span><span class="lc-label">${it.to ? 'Direct message' : 'Chat'}</span>${to}${time}</header>
      ${it.text ? `<div class="lc-text">${textHtml(it.text, names, me, { meAgent })}</div>` : ''}
      ${it.file ? `<div class="lc-files"><span class="lc-file plain">${I.clip}${esc(it.file)}</span></div>` : ''}
    </article>`
  }
  if (it.type === 'task' || it.type === 'note') {
    const col = `<span class="lc-col c-${esc(it.task.column)}">${esc(COLUMN[it.task.column] || it.task.column)}</span>`
    return `<article class="lc lc-task${fresh}" data-id="${it.id}" tabindex="0" style="${style}" aria-label="${esc(it.type === 'task' ? `${it.lane} added a task` : `${it.lane} left a note on a task`)}">
      <header class="lc-head">${who}<span class="lc-kind">${I.board}</span><span class="lc-label">${it.type === 'task' ? 'Added a task' : 'Note on a task'}</span>${time}</header>
      <button class="lc-tasklink" data-loom-task="${esc(it.task.id)}" title="Open the task board">${esc(it.task.title)}</button>${col}
      ${it.type === 'note' ? `<div class="lc-text">${esc(it.text)}</div>` : ''}
    </article>`
  }

  // An AI turn.
  const open = expanded.has(it.key)
  const prompt = visiblePrompt(it.prompt)
  const reply = it.replies.length ? it.replies[it.replies.length - 1] : null
  const done = (it.tasks || []).some((t) => t.column === 'done')
  const files = open ? it.edits : it.edits.slice(0, FILES_SHOWN)
  const more = it.edits.length - files.length
  const counts = [
    it.edits.length ? `${it.edits.length} file${it.edits.length === 1 ? '' : 's'} changed` : '',
    it.reads ? `${it.reads} read` : '',
    it.runs ? `${it.runs} command${it.runs === 1 ? '' : 's'}` : ''
  ].filter(Boolean)
  const tasks = (it.tasks || []).map((t) => `<button class="lc-taskchip c-${esc(t.column)}" data-loom-task="${esc(t.id)}" title="${esc(`${COLUMN[t.column] || t.column}: ${t.title}`)}">${I.board}<span>${esc(t.title)}</span></button>`).join('')
  const summary = it.summary || (reply && reply.summary) ? '<span class="tag summary" title="Summarized before sharing">summary</span>' : ''
  return `<article class="lc lc-turn${open ? ' open' : ''}${done ? ' hemmed' : ''}${fresh}" data-id="${it.id}" data-key="${esc(it.key)}" tabindex="0" style="${style}" aria-expanded="${open}" aria-label="${esc(`${it.lane}'s AI: ${prompt.slice(0, 80) || 'a turn'}`)}">
    <header class="lc-head">${who}<span class="lc-tool" title="${esc(toolLabel(it.tool))}">${toolLogo(it.tool)}</span>
      <button class="lc-conv" data-loom-conv="${esc(it.lane)}" data-loom-convid="${esc(it.conv)}" title="Open this conversation">${esc(it.convLabel || toolLabel(it.tool))}</button>${summary}${time}</header>
    ${prompt ? `<div class="lc-prompt">${esc(prompt)}</div>` : ''}
    ${reply && dens === 'detailed' && !open ? `<div class="lc-reply">${esc(plain(reply.text))}</div>` : ''}
    ${open ? `<div class="lc-replies">${it.replies.map((r) => `<div class="md">${markdown(r.text)}</div>`).join('')}</div>` : ''}
    ${files.length && (dens === 'detailed' || open) ? `<div class="lc-files">${files.map((p) => `<button class="lc-file" data-file="${esc(p)}">${esc(basename(p))}</button>`).join('')}${more > 0 ? `<span class="lc-more">+${more}</span>` : ''}</div>` : ''}
    ${counts.length || tasks ? `<div class="lc-meta">${counts.length ? `<span>${esc(counts.join(' · '))}</span>` : ''}${tasks}</div>` : ''}
    ${open && it.actions.length ? `<ol class="lc-actions">${it.actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ol>` : ''}
    ${open ? `<div class="lc-foot"><button class="btn sm" data-loom-conv="${esc(it.lane)}" data-loom-convid="${esc(it.conv)}">Open the whole conversation${I.arrowRight}</button></div>` : ''}
  </article>`
}

const COLUMN = { todo: 'To do', doing: 'In progress', qa: 'QA', done: 'Done' }

/** Markdown as one plain line of text, for a card's preview of a reply. */
function plain (text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function later (ms) {
  const min = Math.round(ms / 60000)
  if (min < 60) return `${min} min`
  const h = Math.round(min / 6) / 10
  return `${h % 1 ? h.toFixed(1) : h} h`
}

const PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5" /><path d="M9 10.8V4h6v6.8l2.6 3.2H6.4z" /></svg>'
const NEEDLE = '<svg class="needle" viewBox="0 0 40 40" aria-hidden="true"><path class="eye" d="M28 6 L34 12" /><path class="shaft" d="M31 9 L9 31" /><path class="yarn" d="M9 31 C 4 36, 14 38, 18 33 S 30 30, 34 36" /></svg>'

// ------------------------------------------------------------- threads --

const SVGNS = 'http://www.w3.org/2000/svg'
let sizeObs = null
let raf = 0

function watchSize (el) {
  if (sizeObs) sizeObs.disconnect()
  const grid = el.querySelector('.loom-grid')
  if (!grid || typeof ResizeObserver === 'undefined') return
  sizeObs = new ResizeObserver(() => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      const root = el.querySelector(':scope > .loom')
      if (!root) return
      // A new width can fit more lanes or fewer (or fold them into one column): render again.
      if (el.clientWidth !== lastWidth) { handlers.onAction('refresh'); drawThreads(el) }
      else drawThreads(el)
    })
  })
  sizeObs.observe(grid)
  sizeObs.observe(el)
}

/** Draws the stitches between cards that touched the same file, and @mention arrows. */
function drawThreads (el) {
  const grid = el.querySelector('.loom-grid')
  const svg = el.querySelector('.loom-stitches')
  if (!grid || !svg || !model) return
  const g = grid.getBoundingClientRect()
  // The grid's own box, not its scroll size: that counts this svg too, so once tall it could
  // never shrink, and left empty space under the last card when the cards got shorter.
  const w = grid.clientWidth
  const h = grid.clientHeight
  svg.setAttribute('width', String(w))
  svg.setAttribute('height', String(h))
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
  const merged = el.querySelector('.loom').classList.contains('merged')
  const card = (id) => nodeFor(grid, id)
  const box = (node) => { const r = node.getBoundingClientRect(); return { l: r.left - g.left, r: r.right - g.left, t: r.top - g.top, b: r.bottom - g.top, h: r.height } }
  const colorOf = new Map(model.lanes.map((l) => [l.name, colorFor(l.name, l.color)]))
  const byId = new Map(model.items.map((it) => [it.id, it]))
  const out = []
  for (const s of model.stitches) {
    const a = card(s.from)
    const b = card(s.to)
    if (!a || !b || a === b) continue
    const chipY = (node, fallback) => {
      const chip = [...node.querySelectorAll('[data-file]')].find((c) => c.dataset.file === s.path)
      if (!chip) return fallback.t + Math.min(20, fallback.h / 2)
      const c = box(chip)
      return c.t + c.h / 2
    }
    const A = box(a)
    const B = box(b)
    const y1 = chipY(a, A)
    const y2 = chipY(b, B)
    let d
    if (merged) {
      const x = Math.max(A.r, B.r)
      const bulge = Math.min(60, 18 + Math.abs(y2 - y1) / 8)
      d = `M ${A.r} ${y1} C ${x + bulge} ${y1}, ${x + bulge} ${y2}, ${B.r} ${y2}`
    } else {
      const right = A.l < B.l
      const x1 = right ? A.r : A.l
      const x2 = right ? B.l : B.r
      const dx = (x2 - x1) / 2
      d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
    }
    const color = colorOf.get(byId.get(s.to)?.lane) || 'currentColor'
    out.push(`<path class="st${s.collide ? ' collide' : ''}" data-path="${esc(s.path)}" data-from="${s.from}" data-to="${s.to}" d="${d}" style="--c:${esc(color)}" />`)
    if (s.collide && !merged) {
      const right = A.l < B.l
      const mx = ((right ? A.r : A.l) + (right ? B.l : B.r)) / 2
      const my = (y1 + y2) / 2
      out.push(`<g class="knot" data-path="${esc(s.path)}" data-from="${s.from}" data-to="${s.to}" transform="translate(${mx} ${my})"><circle r="7" /><path d="M1 -4 L-2 1 L1 1 L-1 4" /></g>`)
    }
  }
  if (!merged) {
    const heads = [...el.querySelectorAll('.loom-head')]
    for (const mn of model.mentions) {
      const a = card(mn.from)
      const head = heads[mn.col]
      if (!a || !head || a.matches('.loom-knot')) continue // a folded lane's mentions stay folded too
      const A = box(a)
      const h = head.getBoundingClientRect()
      const x2 = h.left - g.left + h.width / 2
      const right = A.l < x2
      const x1 = right ? A.r : A.l
      const y = A.t + Math.min(26, A.h / 2)
      if (Math.abs(x2 - x1) < 4) continue
      const color = colorOf.get(mn.lane) || 'currentColor'
      out.push(`<path class="mention-line" data-from="${mn.from}" d="M ${x1} ${y} C ${(x1 + x2) / 2} ${y - 18}, ${x2} ${y - 10}, ${x2} ${y}" style="--c:${esc(color)}" /><circle class="mention-dot" data-from="${mn.from}" cx="${x2}" cy="${y}" r="3.5" style="--c:${esc(color)}" />`)
    }
  }
  svg.innerHTML = out.join('')
  if (focused) focusFile(el, focused)
}

// ------------------------------------------------------------- focus --

/** The card showing item `id`, or the knot it's folded into. */
function nodeFor (root, id) {
  return root.querySelector(`.loom-grid > [data-id="${id}"]`) || root.querySelector(`.loom-grid > [data-knot~="${id}"]`)
}

/** Lights every card and stitch on `path` and dims the rest (null: back to normal). */
export function focusFile (el, path) {
  focused = path || null
  const root = el?.querySelector('.loom')
  if (!root) return
  for (const n of root.querySelectorAll('.lit')) n.classList.remove('lit')
  root.classList.toggle('focusing', !!focused)
  if (!focused || !model) return
  const f = model.files.get(focused)
  for (const t of f ? f.touches : []) nodeFor(root, t.id)?.classList.add('lit')
  for (const n of root.querySelectorAll('[data-path], [data-file]')) {
    if ((n.dataset.path ?? n.dataset.file) === focused) n.classList.add('lit')
  }
}

/** A card's own stitches and the cards at their other end, lit while the pointer is on it. */
function traceCard (root, id, on) {
  for (const n of root.querySelectorAll('.traced')) n.classList.remove('traced')
  root.classList.toggle('tracing', !!(on && id))
  if (!on || !id) return
  root.querySelector(`[data-id="${id}"]`)?.classList.add('traced')
  for (const n of root.querySelectorAll(`.loom-stitches [data-from="${id}"], .loom-stitches [data-to="${id}"]`)) {
    n.classList.add('traced')
    const other = n.dataset.from === id ? n.dataset.to : n.dataset.from
    if (other) nodeFor(root, other)?.classList.add('traced')
  }
}

function tipFor (path) {
  const f = model && model.files.get(path)
  if (!f) return `<b>${esc(path)}</b>`
  const touches = f.touches.map((t) => `${t.lane} ${clock(t.ts)}`)
  const lanes = new Set(f.touches.map((t) => t.lane))
  const claim = f.claim ? `<div>Held by ${esc(f.claim.by)}${f.claim.waiting.length ? ` · waiting: ${esc(f.claim.waiting.join(', '))}` : ''}</div>` : ''
  return `<b>${esc(path)}</b>
    <div>Changed by ${esc(touches.slice(-5).join(', '))}${touches.length > 5 ? ` and ${touches.length - 5} more` : ''}</div>
    ${lanes.size > 1 ? `<div class="warn">${lanes.size} people's AIs worked on this file</div>` : ''}${claim}
    <div class="hint">Click to open it</div>`
}

function knotTip (ids) {
  const byId = new Map(model.items.map((it) => [it.id, it]))
  const list = ids.map((id) => byId.get(id)).filter(Boolean)
  const line = (it) => {
    if (it.type === 'turn') {
      const ask = visiblePrompt(it.prompt).split('\n')[0].slice(0, 90) || it.convLabel || 'AI turn'
      return `${esc(ask)}${it.edits.length ? ` <span class="hint">· ${it.edits.length} file${it.edits.length === 1 ? '' : 's'}</span>` : ''}`
    }
    if (it.type === 'chat') return `<span class="hint">Chat:</span> ${esc(it.text.slice(0, 90))}`
    if (it.type === 'task') return `<span class="hint">Added a task:</span> ${esc(it.task.title)}`
    if (it.type === 'note') return `<span class="hint">Note on</span> ${esc(it.task.title)}`
    return esc(it.type === 'paused' ? 'Paused sharing' : 'Resumed sharing')
  }
  const lanes = [...new Set(list.map((it) => it.lane))]
  return `<b class="kt-who">${esc(lanes.join(', '))}</b>
    ${list.slice(-4).map((it) => `<div class="kt-line"><span class="hint">${esc(clock(it.ts))}</span> ${line(it)}</div>`).join('')}
    ${list.length > 4 ? `<div class="hint">and ${list.length - 4} more</div>` : ''}
    <div class="hint">Click to open ${lanes.length === 1 ? 'this lane' : `${esc(lanes[lanes.length - 1])}'s lane`}</div>`
}

function showTip (root, anchor, html) {
  const tip = root.querySelector('.loom-tip')
  if (!tip) return
  tip.innerHTML = html
  tip.hidden = false
  const r = anchor.getBoundingClientRect()
  const w = tip.offsetWidth
  const h = tip.offsetHeight
  let x = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2))
  let y = r.top - h - 8
  if (y < 8) y = r.bottom + 8
  tip.style.left = `${Math.round(x)}px`
  tip.style.top = `${Math.round(y)}px`
}

// ------------------------------------------------------------- events --

function bind (el) {
  const root = el.querySelector('.loom')
  const s = root.querySelector('.loom-scroll')
  const jump = root.querySelector('.loom-jump')
  jump.onclick = () => { s.scrollTo({ top: s.scrollHeight, behavior: 'smooth' }); jump.hidden = true }
  s.addEventListener('scroll', () => {
    if (s.scrollHeight - s.scrollTop - s.clientHeight < 80) jump.hidden = true
    root.querySelector('.loom-tip').hidden = true
  }, { passive: true })
  if (bound.has(el)) return
  bound.add(el)

  el.addEventListener('click', (e) => {
    const r = el.querySelector('.loom')
    if (!r || !r.contains(e.target)) return
    const act = handlers.onAction
    const t = e.target
    const pick = (sel) => t.closest(sel)
    let b
    const crowd = r.querySelector('.loom-head.crowd')
    if ((b = pick('[data-loom-crowd]'))) {
      crowdOpen = !crowdOpen
      crowd.classList.toggle('open', crowdOpen)
      b.setAttribute('aria-expanded', String(crowdOpen))
      crowd.querySelector('.lcw-list').hidden = !crowdOpen
      return
    }
    if (crowdOpen && crowd && !crowd.contains(t)) { crowdOpen = false; crowd.classList.remove('open'); crowd.querySelector('.lcw-list').hidden = true }
    if ((b = pick('[data-loom-open]'))) { crowdOpen = false; return act('open-lane', b.dataset.loomOpen) }
    if ((b = pick('[data-loom-pin]'))) return act('pin', b.dataset.loomPin)
    if ((b = pick('[data-loom-person]'))) return act('person', b.dataset.loomPerson)
    if ((b = pick('[data-loom-conv]'))) return act('conv', { name: b.dataset.loomConv, conv: b.dataset.loomConvid })
    if ((b = pick('[data-loom-task]'))) return act('task', b.dataset.loomTask)
    if ((b = pick('[data-file]'))) return act('file', b.dataset.file)
    if ((b = pick('[data-loom-hide]'))) return act('hide', b.dataset.loomHide)
    if ((b = pick('[data-loom-unhide]'))) return act('unhide', b.dataset.loomUnhide)
    if ((b = pick('[data-loom-pref]'))) return act('toggle', b.dataset.loomPref)
    if ((b = pick('[data-loom-density]'))) return act('density', b.dataset.loomDensity)
    if ((b = pick('[data-loom-layout]'))) return act('layout', b.dataset.loomLayout)
    if (t.closest('a, button')) return
    if (String(window.getSelection?.() || '')) return // selecting text in a card, not opening it
    const c = pick('.lc-turn')
    if (c) toggle(el, c)
  })
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && crowdOpen) {
      crowdOpen = false
      const crowd = el.querySelector('.loom-head.crowd')
      if (crowd) { crowd.classList.remove('open'); crowd.querySelector('.lcw-list').hidden = true; crowd.querySelector('[data-loom-crowd]').focus() }
      return
    }
    if (e.key !== 'Enter' && e.key !== ' ') return
    const c = e.target.closest?.('.lc-turn')
    if (!c || e.target !== c) return
    e.preventDefault()
    toggle(el, c)
  })
  el.addEventListener('mouseover', (e) => {
    const r = el.querySelector('.loom')
    if (!r || !r.contains(e.target)) return
    const chip = e.target.closest('[data-file]')
    if (chip) {
      focusFile(el, chip.dataset.file)
      showTip(r, chip, tipFor(chip.dataset.file))
      return
    }
    const knot = e.target.closest('[data-knot]')
    if (knot) {
      showTip(r, knot, knotTip(knot.dataset.knot.split(' ')))
      traceCard(r, knot.dataset.knot.split(' ')[0], true)
      return
    }
    const c = e.target.closest('.loom-grid > [data-id]')
    traceCard(r, c?.dataset.id, true)
  })
  el.addEventListener('mouseout', (e) => {
    const r = el.querySelector('.loom')
    if (!r) return
    const chip = e.target.closest?.('[data-file]')
    if (chip && !chip.contains(e.relatedTarget)) {
      focusFile(el, null)
      r.querySelector('.loom-tip').hidden = true
    }
    const knot = e.target.closest?.('[data-knot]')
    if (knot && !knot.contains(e.relatedTarget)) { r.querySelector('.loom-tip').hidden = true; traceCard(r, null, false) }
    const c = e.target.closest?.('.loom-grid > [data-id]')
    if (c && !c.contains(e.relatedTarget)) traceCard(r, null, false)
  })
}

function toggle (el, card) {
  const key = card.dataset.key
  if (!key) return
  if (expanded.has(key)) expanded.delete(key)
  else expanded.add(key)
  anchor = { key, y: card.getBoundingClientRect().top }
  handlers.onAction('expand', key) // the owner re-renders; the card keeps its place
}
