// Git for starting a session from GitHub: checking names, listing repos and
// branches, cloning. Quilt never commits, pulls or pushes. Wraps the `git`
// and `gh` CLIs; arguments are always passed as a list, never through a shell.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

// QUILT_GH lets tests stand in a fake `gh`.
const GH = () => process.env.QUILT_GH || 'gh'
const REPO_RE = /^[\w.-]+\/[\w.-]+$/
// Never stop to ask for a password or open an editor.
const ENV = { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GIT_EDITOR: 'true', GH_NO_UPDATE_NOTIFIER: '1' }

/** Runs a command; resolves to stdout, or rejects with a short message from stderr. */
function run (cmd, args, { cwd, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, env: { ...process.env, ...ENV }, maxBuffer: 32 * 1024 * 1024, timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout)
      if (allowFail) return resolve(null)
      if (err.code === 'ENOENT') return reject(new Error(cmd === GH() ? 'The GitHub CLI (gh) is not installed.' : 'git is not installed.'))
      const e = new Error(shortError(stderr || stdout || err.message))
      e.stderr = String(stderr || '')
      e.exitCode = err.code
      reject(e)
    })
  })
}
const git = (dir, args, opts) => run('git', args, { cwd: dir, ...opts })
const gh = (args, opts) => run(GH(), args, opts)

/** The first useful line of a CLI error, without "fatal:"/"error:" noise. */
function shortError (text) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean)
  const line = lines.find((l) => /^(fatal|error|remote|GraphQL|HTTP)/i.test(l)) || lines[0] || 'Something went wrong.'
  return line.replace(/^(fatal|error):\s*/i, '').replace(/^remote:\s*/i, '').slice(0, 300)
}

/** Throws unless `name` is a valid branch name. */
export async function checkBranchName (name) {
  name = String(name || '').trim()
  if (!name) throw new Error('Enter a branch name.')
  // Not `--branch`: it expands @{-N} using the current folder's repo, so the
  // answer would depend on where quilt happens to run.
  if (name.startsWith('-') || name === 'HEAD' || (await run('git', ['check-ref-format', `refs/heads/${name}`], { allowFail: true })) === null) {
    throw new Error(`"${name}" isn't a valid branch name.`)
  }
  return name
}

function checkRepo (repo) {
  repo = String(repo || '').trim()
  if (!REPO_RE.test(repo) || repo.split('/').some((p) => /^\.+$/.test(p))) throw new Error('Pick a repository (owner/name).')
  return repo
}

// --------------------------------------------------------------- GitHub --

/** Is gh installed and signed in? { installed, authenticated, user, message } */
export async function ghStatus () {
  const probe = (args) => new Promise((resolve) => {
    execFile(GH(), args, { env: { ...process.env, ...ENV }, timeout: 20000 }, (err, stdout, stderr) => resolve({ err, text: `${stdout}\n${stderr}` }))
  })
  const version = await probe(['--version'])
  if (version.err && version.err.code === 'ENOENT') return { installed: false, authenticated: false, user: null, message: 'Install the GitHub CLI (gh), then run `gh auth login`.' }
  const out = await probe(['auth', 'status', '--hostname', 'github.com'])
  if (out.err) return { installed: true, authenticated: false, user: null, message: 'Run `gh auth login` in a terminal to connect GitHub.' }
  const user = (out.text.match(/account (\S+)/) || out.text.match(/as (\S+)/) || [])[1] || null
  return { installed: true, authenticated: true, user, message: null }
}

/** Your repos, plus your organizations' repos, most recently updated first. */
export async function listRepos ({ limit = 100 } = {}) {
  limit = Math.max(1, Math.min(1000, Number(limit) || 100))
  const fields = ['--json', 'nameWithOwner,description,updatedAt,defaultBranchRef']
  const parse = (out) => { try { return JSON.parse(out || '[]') } catch { return [] } }
  const mine = parse(await gh(['repo', 'list', ...fields, '--limit', String(limit)]))
  const orgs = String(await gh(['api', 'user/orgs', '--jq', '.[].login'], { allowFail: true }) || '').split('\n').filter(Boolean).slice(0, 10)
  const theirs = await Promise.all(orgs.map((o) => gh(['repo', 'list', o, ...fields, '--limit', String(Math.min(limit, 100))], { allowFail: true }).then(parse)))
  const seen = new Set()
  return [...mine, ...theirs.flat()]
    .filter((r) => r && r.nameWithOwner && !seen.has(r.nameWithOwner) && seen.add(r.nameWithOwner))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .map((r) => ({ name: r.nameWithOwner, description: r.description || '', updatedAt: r.updatedAt || null, defaultBranch: r.defaultBranchRef?.name || null }))
}

/** Branch names of a GitHub repo, and which one is the default. */
export async function listBranches (repo) {
  repo = checkRepo(repo)
  const [names, def] = await Promise.all([
    gh(['api', `repos/${repo}/branches`, '--paginate', '--jq', '.[].name']),
    gh(['api', `repos/${repo}`, '--jq', '.default_branch'])
  ])
  const defaultBranch = def.trim() || null
  const branches = names.split('\n').map((s) => s.trim()).filter(Boolean)
  // Default branch first, then alphabetical.
  branches.sort((a, b) => (a === defaultBranch ? -1 : b === defaultBranch ? 1 : a.localeCompare(b)))
  return { branches, defaultBranch }
}

async function defaultBranchOf (dir) {
  const head = await git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true })
  if (head && head.trim()) return head.trim().replace(/^origin\//, '')
  for (const b of ['main', 'master']) {
    if ((await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`], { allowFail: true })) !== null) return b
  }
  return null
}

/**
 * Clones `repo` into `dir` (which must be new or empty), then checks out
 * `branch`, or creates `newBranch` from origin/`base` (default: the default branch).
 */
export async function cloneRepo ({ repo, dir, branch, newBranch, base }) {
  repo = checkRepo(repo)
  if (!dir) throw new Error('Choose a folder to clone into.')
  dir = path.resolve(dir)
  if (branch) branch = await checkBranchName(branch)
  if (newBranch) newBranch = await checkBranchName(newBranch)
  if (base) base = await checkBranchName(base)
  const existed = fs.existsSync(dir)
  if (existed && fs.readdirSync(dir).some((f) => f !== '.DS_Store')) {
    throw new Error(`${path.basename(dir)} already has files in it. Pick an empty or new folder.`)
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  try {
    await gh(['repo', 'clone', repo, dir])
    const has = async (b) => (await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`], { allowFail: true })) !== null
    if (newBranch) {
      base = base || await defaultBranchOf(dir)
      if (!base || !(await has(base))) throw new Error(`There's no branch named ${base} on GitHub to start from.`)
      if (await has(newBranch)) throw new Error(`A branch named ${newBranch} already exists. Use it instead, or pick another name.`)
      await git(dir, ['checkout', '-q', '--no-track', '-b', newBranch, `origin/${base}`])
    } else if (branch) {
      const current = (await git(dir, ['branch', '--show-current'])).trim()
      if (branch !== current) {
        if (!(await has(branch))) throw new Error(`There's no branch named ${branch} on GitHub.`)
        await git(dir, ['checkout', '-q', '-b', branch, '--track', `origin/${branch}`])
      }
    }
    return { dir, branch: (await git(dir, ['branch', '--show-current'])).trim() }
  } catch (err) {
    // Only clean up what we made.
    if (!existed) fs.rmSync(dir, { recursive: true, force: true })
    else for (const f of fs.readdirSync(dir)) if (f !== '.DS_Store') fs.rmSync(path.join(dir, f), { recursive: true, force: true })
    throw err
  }
}
