// Required workflow every agent must follow when it picks up a ticket, the
// briefing it gets when it does, and the notes it owes before QA (then Done).
// Included in MCP server instructions (local + relay) and in the project
// agent guides written by `quilt setup` (AGENTS.md / CLAUDE.md).

/** Heading of the project's own checks in AGENTS.md / CLAUDE.md (matched case-insensitively on "## Verif…"). */
export const CHECKLIST_HEADING = '## Verifying a change'
const CHECKLIST_RE = /^##\s+verif[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im

/** The least an agent must say about what it verified before a ticket may be Done. */
export const MIN_VERIFIED = 12
export const MAX_VERIFIED = 1000

/**
 * One short paragraph: grok → plan → build → test → QA with qaNotes.
 * Keep this the single source of truth so every briefing path says the same thing.
 */
export const TASK_WORKFLOW =
  'When you pick up a ticket (move it to In progress, or start work on one assigned to you): ' +
  'first grok the codebase and workspace (explore the relevant files, how they fit together, and quilt_history for recent changes to them), ' +
  'then implement a plan, then build the change, then test it (confirm the tests you touch pass) ' +
  'and run the project\'s own checks under "Verifying a change" in AGENTS.md. ' +
  'When finished, move the ticket to QA (not straight to Done) with `qaNotes`: describe the changes you made and how you self-validated them. ' +
  'Keep qaNotes, verified and task comments brief: a few short sentences, no logs or play-by-play. ' +
  'Moving to Done still requires `verified` (what you ran and what you saw). Unit tests passing is not enough when the app itself was not exercised. ' +
  'Commit the task\'s files with `quilt_commit` before you move it to QA (or, when agents may not commit, ask with `quilt_request_commit`): work only in the session has not shipped.'

/** Markdown bullets for AGENTS.md / CLAUDE.md (same steps as TASK_WORKFLOW). */
export const TASK_WORKFLOW_MD =
  '- When you pick up a ticket (move it to In progress, or start work on one assigned to you):\n' +
  '  1. **Grok** the codebase and workspace - explore the relevant files, how they fit together, and `quilt_history` for recent changes to them.\n' +
  '  2. **Plan** the change.\n' +
  '  3. **Build** it.\n' +
  '  4. **Test** it: confirm the tests you touch pass, then run the project\'s own checks under "Verifying a change" below.\n' +
  '  5. **QA**: move to `qa` (not straight to Done) with `qaNotes` describing the changes and how you self-validated them.\n' +
  '     Keep `qaNotes`, `verified` and task comments brief: a few short sentences, no logs or play-by-play.\n' +
  '  6. **Done** (after QA): `quilt_move_task` to `done` needs `verified`, what you ran and what you saw. Unit tests passing is not enough when the app itself was not exercised.\n' +
  '  7. **Commit** before QA: `quilt_commit` with the task\'s files and a message (a branch of your own with a pull request, or the session\'s branch when the owner allows). When agents may not commit, ask with `quilt_request_commit`. Work only in the session has not shipped.'

/** Scaffolded into AGENTS.md by `quilt setup` when the project has no checklist yet. Owners edit it in place. */
export const CHECKLIST_SCAFFOLD = `${CHECKLIST_HEADING}

Every agent reads this when it picks up a ticket and must run these checks before moving
it to QA. Replace the examples with what proves a change works in this project.

- Run the test suite and make sure it passes.
- Start the app and exercise the part you changed; confirm it loads and behaves.
- Note anything this project needs that tests do not catch (allowlists, registrations, config).
`

const PLACEHOLDER = /Replace the examples with what proves a change works/

/**
 * The checklist body under "## Verifying a change" in an agent guide, trimmed.
 * '' when the text has no such section.
 */
export function extractChecklist (text) {
  const m = CHECKLIST_RE.exec(String(text || ''))
  if (!m) return ''
  return m[1].replace(/\s+$/, '').replace(/^\s*\n/, '')
}

/** The first non-empty checklist among several guide texts (AGENTS.md first, then CLAUDE.md). */
export function pickChecklist (...texts) {
  for (const t of texts) { const c = extractChecklist(t); if (c) return c }
  return ''
}

function checklistBlock (checklist) {
  if (!checklist) {
    return 'This project has no "Verifying a change" section in AGENTS.md yet. Run its tests and exercise the app yourself, ' +
      'and ask the owner what proves a change works here.'
  }
  const head = PLACEHOLDER.test(checklist)
    ? 'This project\'s checks (AGENTS.md, still the template: ask the owner what proves a change works here):'
    : 'This project\'s checks (from AGENTS.md):'
  return `${head}\n${checklist}`
}

function agoText (ts, now) {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 172800) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/**
 * What an agent gets when it moves a ticket to In progress: the ticket, its files,
 * recent changes to them (from the chronology), who holds claims on them, the
 * workflow and the project's checks.
 * @param {object} o
 * @param {{id:string,title:string,files?:string[]}} o.task
 * @param {Array<{by:string,path:string,kind:string,detail?:string,ts:number,task?:{title:string}|null}>} [o.history] oldest first
 * @param {Array<{by:string,pattern:string,note?:string}>} [o.claims]
 * @param {string} [o.checklist]
 * @param {string} [o.me]
 * @param {number} [o.now]
 */
export function pickupBrief ({ task, history = [], claims = [], checklist = '', me = '', now = Date.now() }) {
  const files = task?.files || []
  const lines = [`Picked up "${task?.title || 'this ticket'}" [${task?.id || ''}].`]
  lines.push(files.length ? `Files: ${files.join(', ')}` : 'Files: none listed. Add them with quilt_assign_task once you know which you will touch.')
  const recent = history.slice(-8)
  if (recent.length) {
    lines.push('', files.length ? 'Recent changes to these files (oldest first):' : 'Recent changes in the project (oldest first):')
    for (const e of recent) {
      const who = e.by === me ? 'you' : e.by
      const forTask = e.task?.title ? ` for "${e.task.title}"` : ''
      lines.push(`- [${agoText(e.ts, now)}] ${who} ${e.kind} ${e.path}${e.detail ? ` (${e.detail})` : ''}${forTask}`)
    }
    lines.push('Read the diffs with quilt_history before building on them.')
  } else {
    lines.push('', files.length ? 'No recorded changes to these files yet.' : 'No recorded changes yet.')
  }
  const comments = Array.isArray(task?.comments) ? task.comments.slice(-5) : []
  if (comments.length) {
    lines.push('', 'Comments on the task (latest last):')
    for (const c of comments) lines.push(`- ${c.by === me ? 'you' : c.by} [${agoText(c.ts, now)}]: ${String(c.text).replace(/\n/g, '\n  ')}`)
  }
  const others = claims.filter((c) => c.by !== me)
  if (others.length) {
    lines.push('', 'Claims to respect (ask for the file with quilt_request_file instead of editing it):')
    for (const c of others) lines.push(`- ${c.pattern} by ${c.by}${c.note ? ` (${c.note})` : ''}`)
  }
  lines.push('', TASK_WORKFLOW, '', checklistBlock(checklist))
  return lines.join('\n')
}

/** Reminder appended when an agent moves a task to In progress (short form, no context). */
export function pickupReminder (title) {
  const who = title ? `"${title}"` : 'this ticket'
  return `Picked up ${who}. ${TASK_WORKFLOW}`
}

/** True when `verified` is enough evidence to move a ticket to Done. */
export function verifiedEnough (verified) {
  return String(verified || '').trim().length >= MIN_VERIFIED
}

/** Why a move to Done was refused, and what to do instead. */
export function doneRefusal ({ task, checklist = '' } = {}) {
  const title = task?.title ? `"${task.title}"` : 'this ticket'
  return `Not moved: ${title} needs \`verified\` before it can be Done. ` +
    'Say what you ran and what you saw (for example: "npm test passed, 612 tests; launched the app and the session page rendered with the new column"). ' +
    'Vague words like "tested" are not enough.\n\n' + checklistBlock(checklist)
}

/** The line shown on the board for a finished ticket's evidence. */
export function verifiedLine (task) {
  const v = String(task?.verified || '').replace(/\s+/g, ' ').trim()
  if (!v) return ''
  return v.length > 160 ? `${v.slice(0, 157)}…` : v
}

/** True when `qaNotes` is enough to move a ticket to QA. */
export function qaNotesEnough (qaNotes) {
  return String(qaNotes || '').trim().length >= MIN_VERIFIED
}

/** Why a move to QA was refused, and what to do instead. */
export function qaRefusal ({ task, checklist = '' } = {}) {
  const title = task?.title ? `"${task.title}"` : 'this ticket'
  return `Not moved: ${title} needs \`qaNotes\` before it can go to QA. ` +
    'Describe the changes you made and how you self-validated them ' +
    '(for example: "Added QA column and qaNotes field; npm test passed; board shows four columns"). ' +
    'Vague words like "done" are not enough.\n\n' + checklistBlock(checklist)
}

/** The line shown for a QA ticket's change description. */
export function qaNotesLine (task) {
  const v = String(task?.qaNotes || '').replace(/\s+/g, ' ').trim()
  if (!v) return ''
  return v.length > 160 ? `${v.slice(0, 157)}…` : v
}
