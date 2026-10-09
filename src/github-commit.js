// Commits made by the relay, through GitHub's API, for any member of a session: an agent on any
// tool (Codex, Cursor, Claude Code, a hosted agent over HTTP), with no git and no credentials on
// its machine, and with nobody else online. The session's copy of the files is the content; the
// branch's commit on GitHub is the parent; only the files named change. No folder, index or
// working tree is involved, so nobody's uncommitted work is swept in.
//
// It never rewrites history: a ref is only moved forward (GitHub refuses anything else without
// force, which is never sent), and a file that changed on GitHub since the session's copy was
// taken is refused rather than overwritten. Public and private repositories work alike: writing
// needs the session's GitHub token with write access to the repository's contents (and to pull
// requests, to open one).
//
// The owner decides what agents may do (AGENT_COMMITS): nothing, their own branches only
// (quilt/<agent>/…, the default), or any branch, the session's own included. People commit with
// git as they always have; through Quilt they may commit to any branch.
import crypto from 'node:crypto'
import { blameChange } from './history.js'

const API = 'https://api.github.com'
export const AGENT_COMMITS = ['off', 'branches', 'any']
export const DEFAULT_AGENT_COMMITS = 'branches'
export const MAX_COMMIT_FILES = 300
export const MAX_COMMIT_BYTES = 20 * 1024 * 1024
const BRANCH = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*\.lock(\/|$))(?!.*[\s~^:?*[\\\x00-\x1f\x7f])(?!.*@\{)[^]+(?<![/.])$/

export class CommitRefused extends Error {}

/** git's id for a file's bytes (what GitHub's trees list), so content is compared without fetching it. */
export function gitBlobSha (buf) {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')
}

/** "duncan", "daniel-carmichael": a name as a branch path segment. */
export function slug (s, max = 40) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, max).replace(/-$/, '') || 'work'
}

/** The branches an agent owns: quilt/<its name>/… */
export const agentPrefix = (name) => `quilt/${slug(name, 30)}/`

/** Whether `name` is a branch name git and GitHub accept. */
export const validBranchName = (name) => typeof name === 'string' && name.length > 0 && name.length <= 200 && BRANCH.test(name)

/**
 * Where a member's commit goes, or why it may not: { branch, own } or throws CommitRefused.
 * `sessionBranch`: the GitHub branch the session's branch follows (main). `target`: what they
 * asked for ('' = the default). `kind`: 'agent' for agents, anything else for people.
 */
export function commitTarget ({ policy = DEFAULT_AGENT_COMMITS, kind = 'human', name, sessionBranch, target = '', message = '' }) {
  const agent = kind === 'agent'
  const mode = AGENT_COMMITS.includes(policy) ? policy : DEFAULT_AGENT_COMMITS
  if (agent && mode === 'off') throw new CommitRefused('The session owner has not let agents commit. Ask a person for the commit with quilt_request_commit (your files and a message).')
  const prefix = agentPrefix(name)
  let branch = String(target || '').trim().replace(/^refs\/heads\//, '')
  if (!branch) branch = agent && mode === 'branches' ? `${prefix}${slug(message, 40)}` : sessionBranch
  if (!validBranchName(branch)) throw new CommitRefused(`"${branch}" is not a branch name git accepts.`)
  if (agent && mode === 'branches' && !branch.startsWith(prefix)) {
    throw new CommitRefused(`The session owner lets agents commit only to branches of their own: ${prefix}<topic>${branch === sessionBranch ? ` (not ${sessionBranch} itself)` : ''}. Leave branch out to get one, and open a pull request with pull_request: true.`)
  }
  return { branch, own: branch !== sessionBranch }
}

/**
 * What a commit of `files` would change: { changes: [{ path, sha?, deleted, bytes }], same: [paths], moved: [paths] }.
 * `files`: Map path -> Buffer (the session's content) or null (deleted in the session).
 * `parent`: Map path -> blob sha at the commit the new one goes on; `base`: at the commit the
 * session's copy is measured from. A file whose blob differs between the two changed on GitHub
 * since the session took its copy: it is `moved`, and committing the session's copy would undo
 * that change. Without `base` (a branch only its agent writes to) nothing counts as moved.
 */
export function planCommit (files, { parent, base = null }) {
  const changes = []
  const same = []
  const moved = []
  for (const [rel, buf] of files) {
    const now = buf ? gitBlobSha(buf) : null
    const at = parent.get(rel) || null
    if (now === at) { same.push(rel); continue }
    if (base && (base.get(rel) || null) !== at) { moved.push(rel); continue }
    changes.push({ path: rel, sha: now, deleted: !buf, bytes: buf || null })
  }
  return { changes, same, moved }
}

/**
 * Who changed each file in the session since `since` (ms) besides `me`, from the branch's
 * history (entries oldest first): Map path -> [names]. Pulls from git are nobody's.
 */
export function othersEditing (paths, history, { me, since = 0 } = {}) {
  const want = new Set(paths)
  const out = new Map()
  for (const e of history || []) {
    if (!e || !want.has(e.path) || e.pulled || !e.by || e.by === me || (e.ts || 0) <= since) continue
    const list = out.get(e.path) || []
    if (!list.includes(e.by)) list.push(e.by)
    out.set(e.path, list)
  }
  return out
}

/** Who besides `me` made the changes a commit of one text file would carry (history.js blameChange). */
export function othersInChange ({ before = '', after = '', entries = [], me }) {
  return blameChange({ before, after, entries }).filter((n) => n !== me)
}

/** The commit message, and who made it: an agent is named as the author, the token's account commits it. */
export function messageFor ({ message, by, task = null, coAuthors = [] }) {
  const lines = [String(message || '').trim() || 'Changes from the Quilt session']
  const trailer = [`Made in Quilt by ${by}${task ? ` for task ${task.id}: ${task.title}` : ''}.`]
  for (const n of coAuthors) trailer.push(`Co-authored-by: ${n} <${noreply(n)}>`)
  return `${lines.join('\n')}\n\n${trailer.join('\n')}`
}

export const noreply = (name) => `${slug(name, 40)}@agents.noreply.heyquilt.com`

class GitHubWriteError extends Error {
  constructor (status, what, body) {
    super(`GitHub answered ${status} to ${what}${body && body.message ? `: ${body.message}` : ''}`)
    this.status = status
    this.body = body
  }
}

/** The GitHub calls a commit needs. The token goes in a header, never a URL. */
export function githubWriter ({ fetch = globalThis.fetch, token, owner, name }) {
  const headers = { 'user-agent': 'quilt-relay', 'x-github-api-version': '2022-11-28', accept: 'application/vnd.github+json', authorization: `Bearer ${token}` }
  const repo = `${API}/repos/${owner}/${name}`
  const req = async (method, path, body, what) => {
    const res = await fetch(`${repo}${path}`, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'follow' })
    let json = null
    try { json = await res.json() } catch {}
    if (!res.ok) throw new GitHubWriteError(res.status, what, json)
    return json
  }
  const enc = (ref) => ref.split('/').map(encodeURIComponent).join('/')
  return {
    /** The branch's head commit, or null when there is no such branch. */
    async ref (branch) {
      try { return (await req('GET', `/git/ref/heads/${enc(branch)}`, null, `branch ${branch}`)).object.sha } catch (err) { if (err.status === 404) return null; throw err }
    },
    /** A commit's tree sha and date. */
    async commit (sha) {
      const c = await req('GET', `/git/commits/${sha}`, null, `commit ${sha.slice(0, 7)}`)
      return { tree: c.tree.sha, ts: Date.parse(c.committer && c.committer.date) || 0 }
    },
    /** Every file's blob sha in a tree: Map path -> sha (null when GitHub cut the listing short). */
    async blobs (treeSha) {
      const t = await req('GET', `/git/trees/${treeSha}?recursive=1`, null, 'the file list')
      if (t.truncated) return null
      return new Map((t.tree || []).filter((x) => x.type === 'blob').map((x) => [x.path, x.sha]))
    },
    async modes (treeSha) {
      const t = await req('GET', `/git/trees/${treeSha}?recursive=1`, null, 'the file list')
      return new Map((t.tree || []).filter((x) => x.type === 'blob').map((x) => [x.path, x.mode]))
    },
    /** A file's bytes at a commit, or null when it isn't there. */
    async content (sha, rel) {
      const res = await fetch(`${repo}/contents/${enc(rel)}?ref=${sha}`, { headers: { ...headers, accept: 'application/vnd.github.raw' }, redirect: 'follow' })
      if (res.status === 404) return null
      if (!res.ok) throw new GitHubWriteError(res.status, rel, null)
      return Buffer.from(await res.arrayBuffer())
    },
    async blob (buf) { return (await req('POST', '/git/blobs', { content: buf.toString('base64'), encoding: 'base64' }, 'a file')).sha },
    async tree (baseTree, entries) { return (await req('POST', '/git/trees', { base_tree: baseTree, tree: entries }, 'the new file list')).sha },
    async newCommit ({ message, tree, parent, author }) {
      return (await req('POST', '/git/commits', { message, tree, parents: [parent], ...(author ? { author } : {}) }, 'the commit')).sha
    },
    /** Moves the branch forward to `sha` (never forced: GitHub refuses a move that would lose commits). */
    async move (branch, sha) { await req('PATCH', `/git/refs/heads/${enc(branch)}`, { sha, force: false }, `branch ${branch}`) },
    async create (branch, sha) { await req('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha }, `new branch ${branch}`) },
    async pull ({ title, head, base, body }) {
      try {
        const p = await req('POST', '/pulls', { title, head, base, body }, 'the pull request')
        return { number: p.number, url: p.html_url }
      } catch (err) {
        // One is already open for this branch: say which.
        if (err.status === 422) {
          const open = await req('GET', `/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&state=open`, null, 'pull requests')
          if (Array.isArray(open) && open[0]) return { number: open[0].number, url: open[0].html_url, existed: true }
        }
        throw err
      }
    }
  }
}

/** Why GitHub refused, in words for whoever asked (never the token). */
export function writeProblem (err, repo) {
  const s = err && err.status
  if (s === 401) return `the session's GitHub token was refused by GitHub (expired or revoked): ask the session owner for a new one (quilt_github_token)`
  if (s === 403 || s === 404) return `the session's GitHub token can't write to ${repo}: the owner needs a token with "Contents: Read and write" on it (and "Pull requests: Read and write" to open pull requests), set with quilt_github_token`
  if (s === 409) return `${repo} is empty or being changed: try again`
  if (s === 422) return `GitHub refused: ${err.body && err.body.message ? err.body.message : 'the branch moved meanwhile'}`
  return err && err.message ? err.message : String(err)
}

/**
 * Makes the commit on GitHub: `files` (Map path -> Buffer|null) onto `branch`, which starts at
 * `from` when it doesn't exist yet (the session's commit), checked against `base` (the commit
 * the session's copy is measured from; null for a branch of the asker's own, which only they write to). Resolves { sha, branch, created, changed, same } or
 * throws CommitRefused (nothing to commit, files changed on GitHub) or a GitHub error.
 */
export async function commitOnGitHub (gh, { files, branch, from, base, message, author, tries = 2 }) {
  for (let attempt = 1; ; attempt++) {
    const head = await gh.ref(branch)
    const parent = head || from
    const pc = await gh.commit(parent)
    const parentBlobs = await gh.blobs(pc.tree)
    if (!parentBlobs) throw new CommitRefused('The repository is too large for GitHub to list in one go; commit from a folder with git.')
    const baseBlobs = !base ? null : base === parent ? parentBlobs : await gh.blobs((await gh.commit(base)).tree)
    if (base && !baseBlobs) throw new CommitRefused('The repository is too large for GitHub to list in one go; commit from a folder with git.')
    const plan = planCommit(files, { parent: parentBlobs, base: baseBlobs })
    if (plan.moved.length) {
      throw new CommitRefused(`${plan.moved.join(', ')} changed on ${head ? branch : 'GitHub'} since the session's copy was taken, so committing the session's copy would undo that. ` +
        'Bring those commits into the session first (quilt_sync_branch; the session then has both), then commit again.')
    }
    if (!plan.changes.length) return { sha: parent, branch, created: false, changed: [], same: plan.same, nothing: true, exists: !!head }
    const modes = await gh.modes(pc.tree)
    const entries = []
    for (const c of plan.changes) {
      if (c.deleted) entries.push({ path: c.path, mode: modes.get(c.path) || '100644', type: 'blob', sha: null })
      else entries.push({ path: c.path, mode: modes.get(c.path) || '100644', type: 'blob', sha: await gh.blob(c.bytes) })
    }
    const tree = await gh.tree(pc.tree, entries)
    const sha = await gh.newCommit({ message, tree, parent, author })
    try {
      if (head) await gh.move(branch, sha)
      else await gh.create(branch, sha)
      return { sha, parent, branch, created: !head, changed: plan.changes.map((c) => c.path), same: plan.same }
    } catch (err) {
      // Someone pushed to the branch meanwhile: start again from its new head.
      if ((err.status === 422 || err.status === 409) && attempt < tries) continue
      throw err
    }
  }
}

/** quilt_commit, the same for every agent (local MCP, hosted MCP, CLI). */
export const COMMIT_DESCRIPTION = 'Commit your finished work to the repository on GitHub yourself: no git or credentials needed on your machine, and nobody else needs to be online. ' +
  'Quilt commits the session\'s copy of exactly these files (by default every change of yours on record on this branch) with your message, and everyone sees it in chat. ' +
  'Where it goes is the session owner\'s call: by default a branch of your own (quilt/<you>/<topic>; pull_request: true opens a pull request to the session\'s branch); ' +
  'when the owner lets agents commit to any branch, leaving branch out commits to the session\'s branch itself. ' +
  'Refused for a file that changed on GitHub since the session\'s copy (bring it in with quilt_sync_branch first) and for one holding others\' uncommitted changes (unless with_others). ' +
  'Commit as soon as work is finished and tested: work that is only in the session has not shipped. When the owner keeps agents from committing, ask a person with quilt_request_commit.'

/** quilt_commit's arguments, the same for the local and the hosted tool (`z`: zod). */
export const commitSchema = (z) => ({
  message: z.string().max(2000).optional().describe('The commit message: what the change does (a task\'s title by default)'),
  files: z.array(z.string().max(1024)).max(300).optional().describe('The files to commit, relative to the project\'s top folder (deleted ones too); default: every change of yours on record on this branch'),
  branch: z.string().max(200).optional().describe('The GitHub branch to commit to; default: a branch of your own (quilt/<you>/<topic>), or the session\'s branch when the owner lets agents commit there'),
  pull_request: z.boolean().optional().describe('Open a pull request from your branch to the session\'s branch'),
  with_others: z.boolean().optional().describe('Also commit files that hold others\' uncommitted changes (they are named as co-authors)'),
  task: z.string().max(40).optional().describe('The task this work was for: its title is the message and its changes the files, unless you give them')
})
