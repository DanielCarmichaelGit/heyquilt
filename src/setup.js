// Wires quilt into AI coding tools in the current project: registers the MCP
// server for Claude Code / Cursor and adds pairing guidance to the agent
// instruction files. These files live in the project, so they sync to
// everyone in the session.
import fs from 'node:fs'
import path from 'node:path'
import { hookSettings, isQuiltHook } from './hooks.js'
import { registerEverywhere } from './integrations.js'
import { TASK_WORKFLOW_MD, CHECKLIST_SCAFFOLD, extractChecklist } from './agent-task-workflow.js'

const START = '<!-- quilt:start -->'
const END = '<!-- quilt:end -->'

export const AGENT_GUIDE = `${START}
## Live pair session (quilt)

This project is being edited **live by more than one person at once**, each
with their own AI coding tool. Files can change underneath you at any time.

- Before starting a task, check what your collaborators are doing: call the
  \`quilt_status\` MCP tool, or run \`quilt status\` in a shell, or read
  \`.quilt/STATUS.md\`.
- The session has a shared task board (To do, In progress, Done). Read it with
  \`quilt_tasks\`. Add work with \`quilt_add_task\`. Move a task to In progress
  when you start it and to Done when you finish (\`quilt_move_task\`).
${TASK_WORKFLOW_MD}
- See what a partner's AI is doing with \`quilt_partner_feed\`, and where people
  are working with \`quilt_list_files\` (recent edits and claims).
- Announce what you're working on (\`quilt_set_focus\` / \`quilt focus "..."\`).
- Share your work with \`quilt_share\`: when you start a request (what was asked,
  your plan) and when you finish (what you did, the files you changed). Partners
  see it in their feed, it goes on the task board, and the host won't commit under you.
- Before you change files, call \`quilt_before_edit\` with their paths. It tells you
  whether each one is yours to edit (claiming free ones for you) and shows what
  people asked about those files. Don't edit a file it refuses.
- Claims follow edits, whatever tool you are: the moment you change a file nobody
  holds, Quilt claims it for you, and lets go when you finish (your AI goes idle, or
  the file has been quiet for a few minutes). Claim ahead only for a larger change
  across several files (\`quilt_claim\` / \`quilt claim <path>\`) and release it when
  done (\`quilt_release\` / \`quilt release <path>\`).
- If a file is claimed by someone else, your edit is refused or undone, and the next
  quilt tool you call tells you so. Don't retry or work around it: send them a direct
  message (\`quilt_message\` with "to" / \`quilt say @name "..."\`) saying what you
  wanted to change and asking for help, then carry on with other work.
- Answer collaborators' messages (\`quilt_read_messages\`): help with their change,
  hand the file over, or say when you'll be done. New ones are shown at the top of
  every quilt answer. When you finish, call \`quilt_set_work\` with "done": it is
  refused until everyone who wrote to you has an answer.
- \`quilt_inbox\` lists what is waiting for you: mentions of you (@yourname), direct
  messages and tasks handed to you. Read it when you start and act on each one.
- Before moving a ticket to Done, run the checks under "Verifying a change" (in
  AGENTS.md; add them there if the section is missing) and pass what you ran and saw
  as \`verified\` to \`quilt_move_task\`. Done without evidence is refused.
- Always re-read a file right before editing it; never rely on an old copy.
- Prefer small, focused edits over rewriting whole files.
- Don't run git commands that rewrite the working tree (checkout, reset,
  stash, rebase) without asking: those changes sync to everyone instantly.
${END}`

function upsertBlock (file, block) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch {}
  const re = new RegExp(`${START}[\\s\\S]*?${END}`)
  const next = re.test(text) ? text.replace(re, block) : (text ? text.replace(/\s*$/, '\n\n') : '') + block + '\n'
  if (next !== text) fs.writeFileSync(file, next)
  return next !== text
}

/** Where Quilt's Claude Code hooks live: this person's own settings, which never sync or get committed. */
export const HOOKS_FILE = '.claude/settings.local.json'

/**
 * Puts Quilt's hooks into the project's .claude/settings.local.json, replacing earlier
 * Quilt entries and leaving other hooks and settings alone. Returns true when the file changed.
 */
export function installHooks (root) {
  const file = path.join(root, HOOKS_FILE)
  let prev = ''
  try { prev = fs.readFileSync(file, 'utf8') } catch {}
  let json = {}
  try { json = JSON.parse(prev) || {} } catch {}
  if (typeof json !== 'object' || Array.isArray(json)) json = {}
  const hooks = (json.hooks && typeof json.hooks === 'object' && !Array.isArray(json.hooks)) ? json.hooks : {}
  const ours = isQuiltHook
  for (const [event, entries] of Object.entries(hookSettings())) {
    const kept = (Array.isArray(hooks[event]) ? hooks[event] : [])
      .map((e) => (e && Array.isArray(e.hooks) ? { ...e, hooks: e.hooks.filter((h) => !ours(h)) } : e))
      .filter((e) => e && (!Array.isArray(e.hooks) || e.hooks.length))
    hooks[event] = [...kept, ...entries]
  }
  json.hooks = hooks
  const text = JSON.stringify(json, null, 2) + '\n'
  if (prev === text) return false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return true
}

/**
 * Adds the "Verifying a change" template to AGENTS.md when neither guide has that
 * section yet, outside Quilt's block so owners can edit it. Returns true when written.
 */
export function scaffoldChecklist (root) {
  const read = (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8') } catch { return '' } }
  if (extractChecklist(read('AGENTS.md')) || extractChecklist(read('CLAUDE.md'))) return false
  const file = path.join(root, 'AGENTS.md')
  const text = read('AGENTS.md')
  fs.writeFileSync(file, (text ? text.replace(/\s*$/, '\n\n') : '') + CHECKLIST_SCAFFOLD)
  return true
}

export function setup (root, { home } = {}) {
  const changed = []
  // MCP servers go in each AI tool's own settings on this computer (with this install's path),
  // not in the project, whose files sync to everyone. See integrations.js.
  for (const r of registerEverywhere(home ? { home } : {})) {
    if (r.result === 'added' || r.result === 'updated') changed.push(`${r.file} (${r.name} MCP server)`)
    else if (r.result === 'skipped' || r.result === 'failed') changed.push(`${r.file}: left alone, not plain JSON (${r.name})`)
  }
  if (installHooks(root)) changed.push(`${HOOKS_FILE} (Claude Code hooks: files are claimed as you edit them)`)
  if (upsertBlock(path.join(root, 'AGENTS.md'), AGENT_GUIDE)) changed.push('AGENTS.md (Cursor, Codex, and other agents)')
  if (upsertBlock(path.join(root, 'CLAUDE.md'), AGENT_GUIDE)) changed.push('CLAUDE.md (Claude Code)')
  if (scaffoldChecklist(root)) changed.push('AGENTS.md ("Verifying a change": fill in what proves a change works here)')
  return changed
}
