// AI sessions as their own members. Several AI sessions often work through one person's
// app at once (Claude Code in one window, Cursor in another, two Claude Code chats). Each
// gets a name of its own, after what it works on, so partners can tell them apart, message
// the right one, and see whose claims are whose: "Daniel · file-queue", "Daniel · hosted costs".
//
// The name is the person's first name and a label. The label comes from the session's git
// branch when it works on one (a branch names the work and doesn't change), otherwise from
// the first thing it says it is doing (its focus, what it shares, the task it takes), and
// the agent can rename itself. Until then it is named after its tool.
import { execFileSync } from 'node:child_process'

export const PERSONA_SEP = ' · '
const MAX_LABEL = 32

/** The person's first name: "Daniel Carmichael" -> "Daniel". */
export const firstName = (person) => String(person || '').trim().split(/\s+/)[0] || 'AI'

/**
 * A label as it may appear in a name: one line, no separator or @, at most 32 characters
 * (cut at a word). '' when nothing is left.
 */
export function cleanLabel (label) {
  let s = String(label || '').replace(/[\r\n\t]+/g, ' ').replace(/[@·]/g, ' ').replace(/[`"'<>]/g, '').replace(/\s+/g, ' ').trim()
  if (s.length > MAX_LABEL) {
    const cut = s.slice(0, MAX_LABEL + 1)
    s = (cut.lastIndexOf(' ') > 8 ? cut.slice(0, cut.lastIndexOf(' ')) : cut.slice(0, MAX_LABEL)).trim()
  }
  return s.replace(/[\s.,;:!?-]+$/, '')
}

/** "Daniel · file-queue". */
export const personaName = (person, label) => `${firstName(person)}${PERSONA_SEP}${cleanLabel(label) || 'AI'}`

const PLAIN_BRANCHES = new Set(['main', 'master', 'trunk', 'develop', 'dev', 'head', ''])

/**
 * A label from a git branch, or '' for one that says nothing about the work (main, master,
 * a detached HEAD). Tool prefixes ("claude/", "cursor/", "feature/") are dropped.
 */
export function labelFromBranch (branch) {
  const b = String(branch || '').trim()
  if (PLAIN_BRANCHES.has(b.toLowerCase())) return ''
  const last = b.split('/').filter(Boolean).pop() || ''
  return cleanLabel(last)
}

/** The git branch checked out in `dir`, or '' (not a repository, or git missing). */
export function gitBranch (dir) {
  try {
    // symbolic-ref also answers on a branch with no commits yet; a detached HEAD has no branch.
    return execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim()
  } catch { return '' }
}

const FILLER = new Set(['i', 'im', 'i\'m', 'am', 'is', 'are', 'was', 'the', 'a', 'an', 'to', 'for', 'on', 'of', 'and', 'or', 'my', 'our', 'me', 'now', 'just', 'currently', 'working', 'work', 'going', 'will', 'be', 'about', 'with', 'in', 'this', 'that', 'these', 'it', 'its', 'please', 'can', 'could', 'would', 'you', 'we', 'let', 'lets', 'let\'s', 'start', 'starting', 'why', 'what', 'how', 'when', 'where', 'there', 'some', 'so', 'do', 'does', 'did', 'have', 'has', 'hey', 'hi', 'ok', 'okay', 'yes', 'no', 'all', 'also', 'into', 'at', 'from', 'by', 'up', 'out', 'make', 'sure', 'want', 'need', 'like', 'use', 'using', 'thanks', 'thank'])

/** A label from what a session says it is doing (or was asked): its first few words that carry meaning. */
export function labelFromText (text) {
  const words = String(text || '').split(/\s+/).filter((w) => w && !/^(https?:|\/|~|<)/.test(w))
    .map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, '').replace(/^['-]+|['-]+$/g, '')).filter(Boolean)
  const kept = []
  for (const w of words) {
    if (FILLER.has(w.toLowerCase()) || w.length > 24) continue
    kept.push(w.toLowerCase())
    if (kept.length === 3) break
  }
  return cleanLabel(kept.join(' '))
}

/** A label from the first file a session edits: its name without the extension ("session.js" -> "session"). */
export function labelFromFile (rel) {
  const base = String(rel || '').split('/').filter(Boolean).pop() || ''
  return cleanLabel(base.replace(/\.[A-Za-z0-9]+$/, ''))
}

// "Daniel's AI": all of a person's AI sessions as one name (pure, shared with the app).
export { AI_SUFFIX, aiName, foldPersonas } from './ui/chat.js'
