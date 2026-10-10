// The session task board: four columns. Task ids and titles come from the
// shared room, so every string is escaped. Column ids match src/tasks.js.
import { I, esc, ago, colorFor } from './common.js'
import { markdown } from './feed.js'
import { cronToText } from './schedule.js'

// Arms stay inside the view box so a round stroke isn't clipped into a plus.
const CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg>'
// Fold a column to a strip (chevrons pointing in), and open one (pointing out).
const FOLD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7l5 5-5 5M20 7l-5 5 5 5"/></svg>'
const UNFOLD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/></svg>'
const SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>'
const FILTER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16l-6 7.5V19l-4 1.5v-8L4 5z"/></svg>'
const RESTORE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>'
const ARCHIVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/></svg>'

const COLUMNS = [
  { id: 'todo', name: 'To do', moves: [{ column: 'doing', name: 'In progress', label: 'Start', icon: 'arrowRight' }] },
  { id: 'doing', name: 'In progress', moves: [{ column: 'todo', name: 'To do', label: 'To do', icon: 'arrowLeft' }, { column: 'qa', name: 'QA', label: 'QA', icon: 'arrowRight' }] },
  { id: 'qa', name: 'QA', moves: [{ column: 'doing', name: 'In progress', label: 'Reopen', icon: 'arrowLeft' }, { column: 'done', name: 'Done', label: 'Done', icon: 'check' }] },
  { id: 'done', name: 'Done', moves: [{ column: 'qa', name: 'QA', label: 'Reopen', icon: 'arrowLeft' }] }
]

/**
 * `archived` shows the archived tasks in place of the columns. `show` keeps only some tasks:
 * '' everyone's, 'none' unassigned ones, `p:name` a person's, `a:name` that person's AI's.
 */
export function renderBoard (tasks, me, people = [], assignTo = '', { archived = false, show = '', closedGroups = [] } = {}) {
  const every = (Array.isArray(tasks) ? tasks : []).filter(Boolean)
  const all = every.filter((t) => showsTask(t, show))
  const list = all.filter((t) => !t.archived)
  const shelved = all.filter((t) => t.archived)
  const showArchived = archived && shelved.length > 0
  const cols = COLUMNS.map((col) => {
    const cards = list.filter((t) => t && t.column === col.id)
    const body = cards.length
      ? cards.map((t) => card(t, col, me, people)).join('')
      : `<p class="board-empty">${col.id === 'todo' ? 'Nothing here yet.' : 'Nothing here.'}</p>`
    const n = cards.length
    // When the board is too narrow for every column, session.js folds some to a strip:
    // the strip (its name and count) opens it again, and takes a dropped card.
    return `<section class="board-col" data-column="${col.id}" aria-label="${esc(col.name)}" tabindex="-1">
      <button type="button" class="board-strip" data-unfold="${col.id}" title="Open ${esc(col.name)}" aria-label="Open ${esc(col.name)}, ${n} task${n === 1 ? '' : 's'}">
        <span class="board-strip-n" data-n="${n}">${n}</span><span class="board-strip-name">${esc(col.name)}</span>${UNFOLD}
      </button>
      <h3>${esc(col.name)} <span class="board-n">${n}</span><button type="button" class="board-fold" data-fold="${col.id}" title="Fold ${esc(col.name)} to a strip" aria-label="Fold ${esc(col.name)}">${FOLD}</button></h3>
      <div class="board-list">${body}</div>
    </section>`
  }).join('')
  const head = showArchived
    ? `<h2 class="board-title">Archived <span class="board-n">${shelved.length}</span></h2>
      <label class="board-archive-search">
        ${SEARCH}
        <input id="archive-filter" type="search" maxlength="200" placeholder="Filter archived tasks" aria-label="Filter archived tasks" autocomplete="off">
      </label>`
    : `<h2 class="board-title" title="Shared with everyone in this session. Assign a task to a person or their AI.">Tasks</h2>
      <form id="task-add-form" class="board-add">
        <label class="board-add-task">
          ${I.plus}
          <input id="task-add" maxlength="200" placeholder="What needs doing?" aria-label="New task" autocomplete="off">
        </label>
        <div class="board-add-assign">
          <label for="task-add-assign">Assign to</label>
          <select id="task-add-assign" class="task-add-assign" aria-label="Assign new task to">${assignOptions(taskForAssign(assignTo), me, people)}</select>
        </div>
        <button class="btn sm primary" type="submit">Add task</button>
      </form>`
  return `<div class="board${showArchived ? ' archived' : ''}">
    <div class="board-head">
      ${head}
      ${filterHtml(every, me, people, show, { search: !showArchived })}
      ${archiveToggle(shelved.length, showArchived)}
    </div>
    ${showArchived ? archivedHtml(shelved, me, people, closedGroups) : `<div class="board-cols">${cols}</div>`}
  </div>`
}

// Folding (session.js lays it out): open columns are BOARD_COL wide at least, a folded
// one is a BOARD_STRIP-wide strip, BOARD_GAP apart. Match .board-col and .board-cols in app.css.
export const BOARD_COL = 320
export const BOARD_STRIP = 44
export const BOARD_GAP = 10
// Before you open or fold one yourself, the work in flight stays open first.
const IN_FLIGHT_FIRST = ['doing', 'qa', 'todo', 'done']

/**
 * Which columns are open in `room` px. `picked`: the columns you opened, most recent first;
 * `folded`: ones you folded yourself, which stay folded at any width; `counts`: tasks per
 * column, so empty ones give way. As many open as fit beside the strips (at least one).
 * Too narrow even for that, the board stacks: one open, the others as bars.
 */
export function foldPlan ({ room, picked = [], folded = [], counts = {} }) {
  const ids = COLUMNS.map((c) => c.id)
  const known = (id) => ids.includes(id)
  const fallback = [...IN_FLIGHT_FIRST].sort((a, b) => Number(!counts[a]) - Number(!counts[b])) // stable: empty ones last
  const order = [...new Set([...picked.filter(known), ...fallback])]
  const fits = (n) => n * BOARD_COL + (ids.length - n) * BOARD_STRIP + (ids.length - 1) * BOARD_GAP <= room
  const stack = !fits(1)
  const n = stack ? 1 : [4, 3, 2, 1].find(fits)
  const mine = folded.filter(known)
  const wanted = order.filter((id) => !mine.includes(id))
  return { layout: stack ? 'stack' : 'row', open: wanted.length ? wanted.slice(0, n) : order.slice(0, 1), order, folded: mine }
}

/** Whether the board's Show choice keeps `t`. See renderBoard. */
export function showsTask (t, show) {
  if (!show) return true
  if (show === 'none') return !t.assignee
  return assignValue(t) === show
}

/** Everyone, Unassigned, then each person and their AI, with how many tasks each has on the board. */
/** Everyone, Unassigned, then each person and their AI, with how many tasks each has on the board: [{ value, label, n }]. */
export function showChoices (tasks, me, people, show) {
  const open = tasks.filter((t) => !t.archived)
  const n = (value) => open.filter((t) => showsTask(t, value)).length
  const label = (value) => {
    const name = value.slice(2)
    const you = name === me
    if (value.startsWith('p:')) return you ? 'You' : name
    const tool = people.find((p) => p?.name === name)?.tool || open.find((t) => t.assignee === name && t.forAi)?.tool || 'AI'
    return you ? `Your ${tool}` : `${name}'s ${tool}`
  }
  // People here now, then anyone who isn't but still has tasks, then the current choice.
  const values = []
  const add = (v) => { if (v && !values.includes(v)) values.push(v) }
  for (const p of people) {
    if (!p?.name) continue
    add(`p:${p.name}`)
    if (!p.agent) add(`a:${p.name}`)
  }
  for (const t of open) add(assignValue(t))
  if (show && show !== 'none') add(show)
  return [
    { value: '', label: 'Everyone', n: open.length },
    { value: 'none', label: 'Unassigned', n: n('none') },
    ...values.map((v) => ({ value: v, label: label(v), n: n(v) }))
  ]
}

/**
 * The Filter button and its panel: the search (on the board; the archive has its own
 * filter) and whose tasks to show. The button says what's on, so a filtered board never
 * passes for a short one: session.js adds the search to what the button says.
 */
function filterHtml (tasks, me, people, show, { search = true } = {}) {
  const choices = showChoices(tasks, me, people, show)
  const picked = choices.find((c) => c.value === show) || choices[0]
  return `<div class="board-filter${show ? ' on' : ''}" id="board-filter" data-show-label="${show ? esc(picked.label) : ''}" data-total="${tasks.filter((t) => !t.archived).length}">
      <button type="button" class="btn sm board-filter-btn" data-filter-toggle aria-haspopup="dialog" aria-expanded="false" aria-controls="board-filter-panel" title="Search and filter tickets (/)">
        ${FILTER}<span class="board-filter-label">${show ? esc(picked.label) : 'Filter'}</span>
      </button>
      <button type="button" class="board-filter-x" data-filter-clear title="Clear filters" aria-label="Clear filters"${show ? '' : ' hidden'}>${CLOSE}</button>
      <div class="popover board-filter-panel" id="board-filter-panel" role="dialog" aria-label="Search and filter tickets" hidden>
        ${search ? `<label class="board-search">
          ${SEARCH}
          <input id="board-search" type="search" maxlength="200" placeholder="Search tickets" aria-label="Search tickets" autocomplete="off">
          <span class="board-search-n" aria-live="polite"></span>
        </label>
        <p class="board-filter-hint">Title, id, who it's for, who made it, files and notes. Every word, any order.</p>` : ''}
        <div class="board-filter-show" role="radiogroup" aria-label="Show tasks for">
          <span class="board-filter-head">Show</span>
          ${choices.map((c) => `<button type="button" role="radio" class="board-filter-opt" data-show-pick="${esc(c.value)}" aria-checked="${c.value === show}"><span class="bf-name">${esc(c.label)}</span><span class="bf-n">${c.n}</span></button>`).join('')}
        </div>
        <button type="button" class="btn sm ghost board-filter-clear" data-filter-clear${show ? '' : ' hidden'}>Clear filters</button>
      </div>
    </div>`
}

function archiveToggle (n, on) {
  if (!n) return ''
  const label = on ? 'Back to the board' : 'Archived'
  return `<button type="button" class="btn sm board-archive-toggle${on ? ' on' : ''}" data-archived-toggle aria-pressed="${on ? 'true' : 'false'}" title="${on ? 'Show the board' : 'Show archived tasks'}">${ARCHIVE}<span>${label}</span>${on ? '' : ` <span class="board-n">${n}</span>`}</button>`
}

/**
 * The archived tasks: off the board, kept until someone brings one back or removes it. Two
 * groups, each newest archived first: Finished (they were in Done) and Set aside (archived
 * from any other column). session.js filters the rows as you type and confirms a removal.
 * `closedGroups`: the groups you folded ('finished', 'aside').
 */
export function archivedHtml (tasks, me, people = [], closedGroups = []) {
  const newest = (a, b) => (b.archivedAt || 0) - (a.archivedAt || 0) || (b.ts || 0) - (a.ts || 0)
  const groups = [
    { id: 'finished', name: 'Finished', hint: 'Done when they were archived', tasks: tasks.filter((t) => t.column === 'done').sort(newest) },
    { id: 'aside', name: 'Set aside', hint: 'Archived before they were done', tasks: tasks.filter((t) => t.column !== 'done').sort(newest) }
  ].filter((g) => g.tasks.length)
  const colorOf = (name) => colorFor(name, people.find((p) => p.name === name)?.color)
  return `<section class="board-archive" aria-label="Archived tasks">
    <p class="board-archive-lead">Off the board and out of every AI's task list. Restore one to put it back where it was.</p>
    ${groups.map((g) => `
    <details class="archive-group" data-group="${g.id}"${closedGroups.includes(g.id) ? '' : ' open'}>
      <summary><span class="archive-caret">${I.caret}</span><span class="archive-group-name">${g.name}</span><span class="board-n" data-group-count>${g.tasks.length}</span><span class="archive-group-hint">${g.hint}</span></summary>
      <ul class="board-archive-list">${g.tasks.map((t) => archivedRow(t, me, colorOf)).join('')}</ul>
    </details>`).join('')}
    <p class="board-archive-none" hidden>No archived tasks match.</p>
  </section>`
}

function archivedRow (t, me, colorOf) {
  const col = COLUMNS.find((c) => c.id === t.column)?.name || 'its column'
  const who = assigneeText(t, me)
  const when = archivedWhen(t.archivedAt)
  const meta = [
    t.column === 'done'
      ? (t.verified ? `<span class="arch-verified" title="${esc(t.verified)}">${I.check}Verified</span>` : '')
      : `<span class="arch-col" data-column="${esc(t.column)}">${esc(col)}</span>`,
    who ? `<span class="arch-who"><i style="--c:${esc(colorOf(t.assignee))}"></i>${esc(who)}</span>` : '',
    t.by ? `<span>by ${esc(t.by === me ? 'you' : t.by)}</span>` : '',
    when ? `<span title="Archived ${esc(new Date(t.archivedAt).toLocaleString())}">${esc(when)}</span>` : ''
  ].filter(Boolean).join('')
  return `<li class="task-archived" data-task="${esc(t.id)}" data-title="${esc(t.title.toLowerCase())}">
      <div class="task-archived-text">
        <span class="task-archived-title" title="${esc(t.title)}">${esc(t.title)}</span>
        <span class="task-archived-meta">${meta}</span>
      </div>
      <div class="task-archived-actions">
        ${notesButton(t)}
        <button type="button" class="btn sm ghost arch-restore" data-task-unarchive title="Put it back in ${esc(col)}">${RESTORE}<span>Restore to ${esc(col)}</span></button>
        <button type="button" class="task-icon task-x" data-task-remove-ask title="Remove for good" aria-label="Remove ${esc(t.title)} for good">${CLOSE}</button>
      </div>
      <div class="arch-confirm" role="group" aria-label="Remove ${esc(t.title)} for good?">
        <span>Remove for good? It can't be brought back.</span>
        <button type="button" class="btn sm danger" data-task-delete>Remove</button>
        <button type="button" class="btn sm ghost" data-task-remove-cancel>Keep it</button>
      </div>
    </li>`
}

/** "archived just now", "archived 5m ago", "archived 3h ago", "archived 10/2/2026"; '' when not known. */
export function archivedWhen (at) {
  if (!at) return ''
  const t = ago(at)
  if (t === 'now') return 'archived just now'
  return /^\d+[mh]$/.test(t) ? `archived ${t} ago` : `archived ${t}`
}

function assigneeText (t, me) {
  if (!t.assignee) return ''
  const tool = t.tool || 'AI'
  if (t.forAi) return t.assignee === me ? `your ${tool}` : `${t.assignee}'s ${tool}`
  return t.assignee === me ? 'you' : t.assignee
}

function assignValue (t) {
  if (!t.assignee) return ''
  return `${t.forAi ? 'a' : 'p'}:${t.assignee}`
}

/** `p:name` is the person, `a:name` is their AI. Anything else is unassigned. */
function taskForAssign (value) {
  const forAi = typeof value === 'string' && value.startsWith('a:')
  const person = typeof value === 'string' && value.startsWith('p:')
  if (!forAi && !person) return { assignee: '' }
  return { assignee: value.slice(2), forAi, tool: '' }
}

function assignOptions (task, me, people) {
  const opts = [{ value: '', label: 'Unassigned' }]
  const seen = new Set()
  for (const p of people) {
    if (!p?.name || seen.has(p.name)) continue
    seen.add(p.name)
    const you = p.name === me
    opts.push({ value: `p:${p.name}`, label: you ? 'You' : p.name })
    if (!p.agent) {
      const tool = p.tool || 'AI'
      opts.push({ value: `a:${p.name}`, label: you ? `Your ${tool}` : `${p.name}'s ${tool}` })
    }
  }
  const cur = assignValue(task)
  if (cur && !opts.some((o) => o.value === cur)) {
    const tool = task.tool || 'AI'
    const label = task.forAi
      ? (task.assignee === me ? `Your ${tool}` : `${task.assignee}'s ${tool}`)
      : (task.assignee === me ? 'You' : task.assignee)
    opts.push({ value: cur, label })
  }
  const selected = cur
  return opts.map((o) => `<option value="${esc(o.value)}"${o.value === selected ? ' selected' : ''}>${esc(o.label)}</option>`).join('')
}

function filesHtml (files) {
  if (!files?.length) return ''
  return `<ul class="task-files">${files.map((f) => {
    const base = f.split('/').pop()
    return `<li class="task-file-chip" title="${esc(f)}"><code>${esc(base)}</code><button type="button" class="task-file-x" data-file-remove="${esc(f)}" aria-label="Remove ${esc(f)}">${CLOSE}</button></li>`
  }).join('')}</ul>`
}

function noteFields (t) {
  const qa = String(t?.qaNotes || '').trim()
  const verified = String(t?.verified || '').trim()
  const sections = []
  if (qa) sections.push({ label: 'QA notes', text: qa })
  if (verified) sections.push({ label: 'Done notes', text: verified })
  return sections
}

/** Full ticket notes and comments for the notes modal. Markdown is rendered; raw HTML is escaped. */
export function taskNotesModalHtml (t) {
  const sections = noteFields(t)
  const notes = sections.map((s) => `<section class="task-notes-sec"><h4>${esc(s.label)}</h4><div class="task-notes-body md">${markdown(s.text)}</div></section>`).join('')
  const comments = Array.isArray(t?.comments) ? t.comments : []
  const thread = comments.length
    ? `<ol class="task-comments">${comments.map((c) => `<li class="task-comment"><div class="task-comment-head"><b>${esc(c.by)}</b> <span>${esc(ago(c.ts))}</span></div><div class="md">${markdown(c.text)}</div></li>`).join('')}</ol>`
    : '<p class="lead">No comments yet.</p>'
  const col = COLUMNS.find((c) => c.id === t?.column)?.name || ''
  return `<div class="card modal task-notes-modal" role="dialog" aria-modal="true" aria-labelledby="task-notes-title">
    <h3 id="task-notes-title">${esc(t?.title || 'Task')}</h3>
    ${col ? `<p class="lead">${esc(col)}</p>` : ''}
    ${notes}
    <section class="task-notes-sec"><h4>Comments</h4>${thread}</section>
    <form class="task-comment-form">
      <textarea class="task-comment-text" rows="2" maxlength="2000" placeholder="Add a comment: a work note, a handoff, why it went to whom" aria-label="Comment on ${esc(t?.title || 'this task')}"></textarea>
      <div class="actions"><button type="button" class="btn" data-close-notes>Close</button><button type="submit" class="btn primary">Comment</button></div>
    </form>
  </div>`
}

function notesButton (t) {
  const n = Array.isArray(t.comments) ? t.comments.length : 0
  const has = noteFields(t).length || n
  const label = `Notes and comments${n ? ` (${n})` : ''}`
  return `<button type="button" class="task-icon task-notes-btn${has ? ' on' : ''}" data-task-notes title="${esc(label)}" aria-label="${esc(label)} on ${esc(t.title)}">${has && !n ? I.eye : I.chat}${n ? `<span class="task-count">${n}</span>` : ''}</button>`
}

// Only a repeating task shows the icon (it turns repeating off); the ⋯ menu turns it on.
function recurButton (t) {
  const on = !!t.recurring
  if (!on) return ''
  const when = t.cron ? cronToText(t.cron) : ''
  const title = when ? `Recurring: ${when}` : 'Recurring'
  return `<button type="button" class="task-icon task-recur${on ? ' on' : ''}" data-task-recur aria-pressed="${on ? 'true' : 'false'}" title="${esc(title)}" aria-label="${esc(title)} for ${esc(t.title)}">${I.repeat}</button>`
}

function recurHtml (t) {
  if (!t.recurring) return ''
  const read = t.cron ? cronToText(t.cron) : 'Add a schedule'
  return `<form class="task-cron-form">
    <div class="task-cron-row">
      <input class="task-cron" value="${esc(t.cron || '')}" placeholder="daily at 9, or 0 9 * * *" aria-label="Repeat schedule for ${esc(t.title)}" maxlength="80" autocomplete="off">
      <button type="submit" class="task-cron-set">Set</button>
    </div>
    <span class="task-cron-read">${esc(read)}</span>
  </form>`
}

function verifiedHtml (t) {
  if (t.column !== 'done' || !t.verified) return ''
  const v = String(t.verified).replace(/\s+/g, ' ').trim()
  return `<p class="task-verified" title="${esc(v)}">${esc(v.length > 160 ? `${v.slice(0, 157)}…` : v)}</p>`
}

function qaNotesHtml (t) {
  if (t.column !== 'qa' || !t.qaNotes) return ''
  const v = String(t.qaNotes).replace(/\s+/g, ' ').trim()
  return `<p class="task-qa-notes" title="${esc(v)}">${esc(v.length > 160 ? `${v.slice(0, 157)}…` : v)}</p>`
}

/**
 * The ⋯ menu on a card: rename, repeat, archive, remove. `on` is { edit, recur, archive, remove }.
 * It hangs off `anchor` and closes on a choice, a click elsewhere, Escape, or the ⋯ again.
 */
export function openTaskMenu (anchor, t, on) {
  const again = closeTaskMenu.anchor === anchor
  closeTaskMenu()
  if (again) return
  const menu = document.createElement('div')
  menu.className = 'popover more-menu task-menu'
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', `Actions for ${t.title}`)
  menu.innerHTML = `
    <button type="button" class="pop-item" data-act="edit" role="menuitem">${I.pencil}Rename</button>
    <button type="button" class="pop-item" data-act="recur" role="menuitem">${I.repeat}${t.recurring ? 'Stop repeating' : 'Make recurring'}</button>
    <button type="button" class="pop-item" data-act="archive" role="menuitem">${ARCHIVE}Archive</button>
    <button type="button" class="pop-item danger" data-act="remove" role="menuitem">${I.trash}Remove</button>`
  document.body.appendChild(menu)
  const r = anchor.getBoundingClientRect()
  const w = menu.offsetWidth
  menu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`
  menu.style.top = `${Math.max(8, Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8))}px`
  anchor.setAttribute('aria-expanded', 'true')
  const items = [...menu.querySelectorAll('.pop-item')]
  items[0].focus()
  menu.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act
    if (!act) return
    closeTaskMenu()
    on[act]?.()
  })
  const away = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) closeTaskMenu() }
  const keys = (e) => {
    if (e.key === 'Escape') { closeTaskMenu(); anchor.focus?.() }
    const i = items.indexOf(document.activeElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus()
    }
  }
  setTimeout(() => document.addEventListener('mousedown', away), 0)
  document.addEventListener('keydown', keys)
  // A scroll would leave the menu hanging away from its card.
  const scroll = (e) => { if (!menu.contains(e.target)) closeTaskMenu() }
  document.addEventListener('scroll', scroll, true)
  closeTaskMenu.cleanup = () => {
    document.removeEventListener('mousedown', away)
    document.removeEventListener('keydown', keys)
    document.removeEventListener('scroll', scroll, true)
    anchor.setAttribute('aria-expanded', 'false')
    menu.remove()
    closeTaskMenu.anchor = null
  }
  closeTaskMenu.anchor = anchor
}

export function closeTaskMenu () {
  if (closeTaskMenu.cleanup) { closeTaskMenu.cleanup(); closeTaskMenu.cleanup = null }
}

/**
 * What the board's search looks through for a task, lowercased: its title and id, who it's
 * for (as the card says it, and by name and tool), who made it, its files and its QA and
 * verified notes. session.js hides the cards whose text doesn't hold every word typed.
 */
export function searchText (t, me) {
  return [t.title, t.id, assigneeText(t, me), t.assignee, t.tool, t.by === me ? 'you' : '', t.by, ...(t.files || []), t.qaNotes, t.verified]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').toLowerCase()
}

/** Whether a task's search text (searchText) holds every word of `query`, in any order. */
export function matchesSearch (text, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  return words.every((w) => text.includes(w))
}

function card (t, col, me, people) {
  const who = t.by === me ? 'You' : (t.by || '')
  const mine = t.assignee === me && !t.forAi ? ' mine' : t.assignee === me && t.forAi ? ' mine-ai' : ''
  const moves = col.moves.map((m) =>
    `<button type="button" class="task-move" data-move="${m.column}" title="Move to ${esc(m.name)}" aria-label="Move to ${esc(m.name)}">${I[m.icon]}<span>${esc(m.label)}</span></button>`
  ).join('')
  return `<article class="task${mine}" draggable="true" data-task="${esc(t.id)}" data-search="${esc(searchText(t, me))}">
    <div class="task-main">
      <div class="task-tools">
        ${notesButton(t)}
        ${recurButton(t)}
        <button type="button" class="task-icon" data-task-more title="More" aria-label="More for ${esc(t.title)}" aria-haspopup="menu" aria-expanded="false">${I.more}</button>
      </div>
      <p class="task-title" title="Click to rename">${esc(t.title)}</p>
    </div>
    <select class="task-assign" aria-label="Assign ${esc(t.title)}">${assignOptions(t, me, people)}</select>
    ${recurHtml(t)}
    ${filesHtml(t.files)}
    ${verifiedHtml(t)}
    ${qaNotesHtml(t)}
    <form class="task-file-form">
      <input class="task-file" placeholder="Add a file…" aria-label="Add a file to ${esc(t.title)}" maxlength="240" autocomplete="off">
    </form>
    <div class="task-foot">
      <span class="task-by">${esc(who)}</span>
      <div class="task-moves">${moves}</div>
    </div>
  </article>`
}
