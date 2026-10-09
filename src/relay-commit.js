// quilt_commit, on the relay: a member's finished work committed to GitHub from the session's
// copy of the files (github-commit.js), for an agent on any tool or a person, from a folder
// (through its connection) or over HTTP (hosted agents). The relay is always there, so an
// agent's work is never held up waiting for a person to be online.
import { parseRepo, upstreamsOf, validToken } from './relay-upstream.js'
import { RELAY_BY } from './branches.js'
import { appCredentials } from './relay-github.js'
import { mayChange } from './session-access.js'
import { isSafeRelPath } from './pathrules.js'
import {
  CommitRefused, commitTarget, commitOnGitHub, githubWriter, gitBlobSha, messageFor, noreply, othersEditing, othersInChange, writeProblem,
  AGENT_COMMITS, DEFAULT_AGENT_COMMITS, MAX_COMMIT_FILES, MAX_COMMIT_BYTES
} from './github-commit.js'

export { CommitRefused }

/** What the owner lets agents do with commits in this session: 'off', 'branches' or 'any'. */
export const agentCommitsOf = (room) => AGENT_COMMITS.includes(room.meta.agentCommits) ? room.meta.agentCommits : DEFAULT_AGENT_COMMITS

export const POLICY_WORDS = {
  off: 'agents may not commit: they ask a person (quilt_request_commit)',
  branches: 'agents may commit to branches of their own (quilt/<agent>/…) and open pull requests; people merge them',
  any: 'agents may commit to any branch, the session\'s own included'
}

const cleanList = (files) => {
  const out = []
  for (const f of Array.isArray(files) ? files : []) {
    const p = String(f || '').trim().replace(/\\/g, '/').replace(/^\.\//, '')
    if (isSafeRelPath(p) && !out.includes(p)) out.push(p)
  }
  return out
}

/**
 * What the relay commits to owner/name with: the session owner's GitHub connection (relay-github.js),
 * or a token the owner set by hand (quilt_github_token). Throws CommitRefused saying what the owner
 * can do when there is neither.
 */
async function credentialsFor (room, repo) {
  const full = `${repo.owner}/${repo.name}`
  const r = await appCredentials(room, full)
  if (r.token) return r.token
  if (validToken(room.meta.githubToken)) return room.meta.githubToken
  const who = room.meta.ownerName || 'The session owner'
  if (r.state === 'not-installed') throw new CommitRefused(`Quilt's GitHub app isn't installed on ${full}. ${who} adds it there with Connect GitHub (the app's commit panel); until then ask a person for the commit (quilt_request_commit).`)
  if (r.state === 'no-access') throw new CommitRefused(`${who}'s GitHub account (@${r.login}) can't write to ${full}, so Quilt won't commit there for this session. Ask a person for the commit (quilt_request_commit).`)
  if (r.state === 'not-connected') throw new CommitRefused(`${who} hasn't connected GitHub yet: Connect GitHub in the app's commit panel (one click). Until then ask a person for the commit (quilt_request_commit).`)
  throw new CommitRefused(`Quilt can't commit to ${full} yet: the session owner connects GitHub in the app's commit panel (one click). Until then ask a person for the commit (quilt_request_commit).`)
}

/** The session's copy of a file on a branch: its bytes, null when it isn't there, or throws for one the relay can't read. */
function sessionBytes (e, rel) {
  const t = e.files.get(rel)
  if (t) return Buffer.from(t.toString(), 'utf8')
  const b = e.blobs.get(rel)
  if (b && b.stored) throw new CommitRefused(`${rel} is a large file kept encrypted in storage, which the relay can't read: commit it from a folder with git.`)
  if (b) return Buffer.from(b.data || '', 'base64')
  return null
}

/**
 * Commits `files` (or, without them, the files `who` changed on record, or a task's) from
 * branch `key` of the session to GitHub. `who`: { name, kind ('agent' | 'human'), access }.
 * Resolves { sha, branch, created, changed, same, url, pr, nothing } or throws (CommitRefused, or
 * an Error saying what GitHub refused).
 */
export async function commitForMember (room, { who, key, files = null, message = '', branch: target = '', pullRequest = false, withOthers = false, task = null }, { fetch = globalThis.fetch, log = () => {} } = {}) {
  const a = who.access || {}
  if (a.state && a.state !== 'approved') throw new CommitRefused('You are not let into this session yet.')
  if (a.role === 'viewer') throw new CommitRefused('You can only view this session, so you can\'t commit.')
  key = room.resolveKey ? room.resolveKey(key) : key
  const rec = upstreamsOf(room)[key]
  if (!rec || !rec.repo || !rec.ref) throw new CommitRefused(`Quilt doesn't know which GitHub repository \`${key}\` follows yet: a member's folder on it that is a git clone tells it once it is online.`)
  if (!rec.sha) throw new CommitRefused(`Quilt doesn't know which commit the session's files on \`${key}\` are at yet: a member's folder on it, in step with the session, tells it.`)
  const repo = parseRepo(`https://${rec.repo}`)
  if (!repo || !repo.github) throw new CommitRefused(`\`${key}\` follows ${rec.repo}, which isn't on GitHub: commit from a folder with git, or ask a person (quilt_request_commit).`)
  const token = await credentialsFor(room, repo)
  const t = task ? room.doc.getMap('tasks').get(String(task)) : null
  if (task && !t) throw new CommitRefused(`No task ${task} on the board.`)
  message = String(message || (t && t.title) || '').trim().slice(0, 2000)
  if (!message) throw new CommitRefused('Say what the commit does (message).')
  const where = commitTarget({ policy: agentCommitsOf(room), kind: who.kind, name: who.name, sessionBranch: rec.ref, target, message })

  const e = room.branchDoc(key)
  const history = e.doc.getArray('history').toArray()
  let list = cleanList(files)
  if (Array.isArray(files) && files.length && !list.length) throw new CommitRefused('None of those are files in the project (give paths relative to its top folder).')
  if (!list.length) {
    // What was changed for the task, or by this member, on record (pulls from git are nobody's).
    for (const h of history) {
      if (!h || h.pulled || typeof h.path !== 'string') continue
      if (t ? h.task && h.task.id === t.id : h.by === who.name) { if (!list.includes(h.path)) list.push(h.path) }
    }
    if (t) for (const f of Array.isArray(t.files) ? t.files : []) if (!list.includes(f)) list.push(f)
    list = cleanList(list)
  }
  if (!list.length) throw new CommitRefused(t ? `Task ${t.id} has no changed files on record: give them in files.` : 'Quilt has no changes of yours on record on this branch: give the files in files.')
  if (list.length > MAX_COMMIT_FILES) throw new CommitRefused(`That is ${list.length} files; commit at most ${MAX_COMMIT_FILES} at a time.`)
  const outside = list.filter((rel) => !mayChange(a, rel))
  if (outside.length) throw new CommitRefused(`You may not change ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ', …' : ''} in this session, so you can't commit ${outside.length === 1 ? 'it' : 'them'}.`)
  const content = new Map()
  let bytes = 0
  for (const rel of list) {
    const b = sessionBytes(e, rel)
    bytes += b ? b.length : 0
    content.set(rel, b)
  }
  if (bytes > MAX_COMMIT_BYTES) throw new CommitRefused(`Those files come to ${Math.round(bytes / 1048576)} MB; commit at most ${MAX_COMMIT_BYTES / 1048576} MB at a time.`)

  const gh = githubWriter({ fetch, token, owner: repo.owner, name: repo.name })
  const full = `${repo.owner}/${repo.name}`
  try {
    // Other people's unfinished work in these files would go in with them: said, not swept in.
    const base = await gh.commit(rec.sha)
    const baseBlobs = await gh.blobs(base.tree)
    const differ = baseBlobs ? list.filter((rel) => (content.get(rel) ? gitBlobSha(content.get(rel)) : null) !== (baseBlobs.get(rel) || null)) : list
    // Each changed line is put down to whoever added or removed it last (the session's history);
    // a file the relay can't read as text falls back to who edited it since the session's commit.
    const others = new Map()
    for (const rel of differ) {
      const now = content.get(rel)
      const text = !e.blobs.get(rel) && (now === null || e.files.get(rel))
      let names
      if (text) {
        const was = baseBlobs && baseBlobs.get(rel) ? await gh.content(rec.sha, rel) : null
        names = othersInChange({ before: was ? was.toString('utf8') : '', after: now ? now.toString('utf8') : '', entries: history.filter((h) => h && h.path === rel), me: who.name })
      } else names = othersEditing([rel], history, { me: who.name, since: base.ts }).get(rel) || []
      names = names.filter((n) => n !== RELAY_BY)
      if (names.length) others.set(rel, names)
    }
    if (others.size && !withOthers) {
      const lines = [...others].map(([rel, names]) => `${rel} (${names.join(', ')})`)
      throw new CommitRefused(`These files also hold changes by others that are not in git yet: ${lines.join('; ')}. ` +
        'Leave them out (files), ask those people to commit first, or commit them together with with_others: true (they are named as co-authors).')
    }
    const coAuthors = [...new Set([...others.values()].flat())]
    const r = await commitOnGitHub(gh, {
      files: content,
      branch: where.branch,
      from: rec.sha,
      base: where.own ? null : rec.sha,
      message: messageFor({ message, by: who.name, task: t ? { id: t.id, title: t.title } : null, coAuthors: withOthers ? coAuthors : [] }),
      author: who.kind === 'agent' ? { name: who.name, email: noreply(who.name) } : null
    })
    const out = { ...r, repo: full, url: `https://github.com/${full}/commit/${r.sha}` }
    const pr = () => gh.pull({ title: message.split('\n')[0].slice(0, 200), head: where.branch, base: rec.ref, body: `Made in Quilt by ${who.name}${t ? ` for task ${t.id}: ${t.title}` : ''}.\n\n${message}` })
    // Already committed: a pull request can still be asked for, for a branch that is there.
    if (r.nothing) { if (pullRequest && where.own && r.exists) out.pr = await pr(); return out }
    if (pullRequest && where.own) {
      out.pr = await pr()
    }
    log(`[${room.name}] ${key}: ${who.name} committed ${r.sha.slice(0, 7)} to ${full} ${where.branch} (${r.changed.length} files)`)
    // Everyone sees what went into git, and by whom; it wakes nobody.
    if (room.postChat) {
      room.postChat({ by: RELAY_BY, text: `${who.name} committed ${r.sha.slice(0, 7)} to ${where.branch}${r.created ? ' (a new branch)' : ''}: "${message.split('\n')[0].slice(0, 200)}" (${r.changed.length} file${r.changed.length === 1 ? '' : 's'})${out.pr ? `, pull request ${out.pr.url}` : ''}.`, kind: 'commit' })
    }
    // The session's own branch moved. Made on the session's commit, the new one is where the session
    // now stands (its files are the session's own): measured from it, so the next commit isn't taken
    // for a change on GitHub. On a later commit, folders and the relay bring the rest in as usual.
    if (!where.own) {
      if (r.parent === rec.sha) { rec.sha = r.sha; rec.head = r.sha; room.saveMeta(); if (room.broadcastBranches) room.broadcastBranches() }
      if (room.upstreamSoon) room.upstreamSoon(key)
    }
    closeRequests(room, who.name, new Set([...r.changed, ...r.same]), r.sha)
    return out
  } catch (err) {
    if (err instanceof CommitRefused) throw err
    throw new Error(writeProblem(err, full))
  }
}

/** Open commit requests by `name` whose files are all in this commit: done, with its hash. */
function closeRequests (room, name, files, sha) {
  const map = room.doc.getMap('commitRequests')
  room.doc.transact(() => {
    for (const r of map.values()) {
      if (!r || r.state !== 'open' || r.by !== name || !Array.isArray(r.files) || !r.files.length) continue
      if (r.files.every((f) => files.has(f))) map.set(r.id, { ...r, state: 'done', doneBy: name, hash: sha, doneAt: Date.now(), pushed: true })
    }
  })
}

/** quilt_commit's answer. */
export function describeCommit (r, { policy } = {}) {
  if (r.nothing) return `Nothing to commit: ${r.same.length ? r.same.join(', ') : 'those files'} ${r.same.length === 1 ? 'is' : 'are'} already on ${r.branch} as they are in the session.`
  const lines = [`Committed ${r.sha.slice(0, 7)} to ${r.repo} ${r.branch}${r.created ? ' (new branch)' : ''}: ${r.changed.length} file${r.changed.length === 1 ? '' : 's'} (${r.changed.slice(0, 10).join(', ')}${r.changed.length > 10 ? ', …' : ''}). ${r.url}`]
  if (r.same.length) lines.push(`Already as in the session, so not in the commit: ${r.same.slice(0, 10).join(', ')}${r.same.length > 10 ? ', …' : ''}.`)
  if (r.pr) lines.push(`Pull request${r.pr.existed ? ' (already open)' : ''}: ${r.pr.url}`)
  else if (r.created && policy === 'branches') lines.push('Open a pull request for it with quilt_commit again and pull_request: true, or ask a person to merge the branch.')
  return lines.join('\n')
}
