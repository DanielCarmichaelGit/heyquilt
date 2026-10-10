// Commit requests (quilt_request_commit): an AI or a person asks for a commit, says what it
// is for and which files changed, and the session owner (whose machine usually commits) is
// told with a direct message. Shared by the folder's Session and the relay's hosted MCP so
// both build the same request and the same message.
import { isSafeRelPath } from './pathrules.js'

export const MAX_COMMIT_MESSAGE = 500
export const MAX_COMMIT_DESCRIPTION = 2000
export const MAX_COMMIT_FILES = 100

/** The changed files an agent listed: clean relative paths, no duplicates, at most MAX_COMMIT_FILES. */
export function cleanCommitFiles (files) {
  if (files == null) return []
  if (!Array.isArray(files)) throw new Error('files must be a list of paths')
  const out = []
  for (const f of files) {
    const rel = String(f == null ? '' : f).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    if (!rel) continue
    if (!isSafeRelPath(rel)) throw new Error(`not a path in the project: ${String(f).slice(0, 200)}`)
    if (!out.includes(rel)) out.push(rel)
  }
  if (out.length > MAX_COMMIT_FILES) throw new Error(`list at most ${MAX_COMMIT_FILES} files`)
  return out
}

/** The owner's name from a member list ({ name, role }), or ''. */
export function ownerName (members) {
  const o = (members || []).find((m) => m && m.role === 'owner' && m.name)
  return o ? String(o.name) : ''
}

/** A new open request. Throws when there is nothing to say. */
export function makeCommitRequest ({ id, by, message, description = '', files = [], branch = '', ts = Date.now() }) {
  const msg = String(message || '').trim().slice(0, MAX_COMMIT_MESSAGE)
  if (!msg) throw new Error('say what the commit is for')
  const desc = String(description || '').trim().slice(0, MAX_COMMIT_DESCRIPTION)
  const list = cleanCommitFiles(files)
  return { id, by, message: msg, ...(desc ? { description: desc } : {}), ...(list.length ? { files: list } : {}), ...(branch ? { branch } : {}), ts, state: 'open' }
}

/** What the owner is told: who wants a commit, what for, which files, and how to settle it. */
export function commitRequestText (r, { defaultBranch = 'main' } = {}) {
  const branch = r.branch && r.branch !== defaultBranch ? ` on \`${r.branch}\`` : ''
  const files = r.files && r.files.length
    ? ` Files (${r.files.length}): ${r.files.slice(0, 20).join(', ')}${r.files.length > 20 ? `, and ${r.files.length - 20} more` : ''}.`
    : ''
  const desc = r.description ? ` ${r.description.replace(/\s+/g, ' ')}` : ''
  return `📌 Commit requested${branch} (${r.id}): ${r.message.replace(/[.!?]+$/, '')}.${desc}${files} ` +
    'Commit with git when it is a good moment (quilt_commit_status), then mark it done with quilt_commit_request_done.'
}

/** The chat message that tells the owner, or null when there is no owner to tell or the owner asked. */
export function commitRequestMessage (r, { owner, id, defaultBranch, of = null }) {
  if (!owner || owner === r.by) return null
  return { id, by: r.by, to: owner, text: commitRequestText(r, { defaultBranch }), ts: r.ts, kind: 'commit', commit: r.id, ...(of ? { of } : {}) }
}

/** A message that tells the owner about a commit request: settled by committing, not by a reply. */
export const commitRequestNote = (m) => !!m && m.kind === 'commit'
