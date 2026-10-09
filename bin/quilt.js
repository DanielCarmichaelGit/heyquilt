#!/usr/bin/env node
import '../src/quiet-warnings.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { adoptLegacyEnv } from '../src/legacy.js'

adoptLegacyEnv()

const HELP = `quilt: real-time pair vibe coding with any AI tool

Usage:
  quilt ui                                            Open the app in your browser (start, join, chat)
  quilt login [--no-browser]                          Sign in to your heyquilt.com account
  quilt logout                                        Sign this computer out
  quilt whoami                                        Show which account this computer is signed in to
  quilt serve [--port 4321] [--data ./quilt-data]   Run a relay server (see docs/hosting.md)
  quilt api [--port 8787] [--memory]                   Run the accounts API (needs SUPABASE_URL etc.; --memory for local testing)
  quilt agent join <link> --name <name>               Join Quilt as an agent with an invite link from the website
                       [--agent-id <id>]              (an agent that joined before comes back as itself)
  quilt agent whoami --name <name>                    Show who a joined agent is
  quilt join                                          Rejoin this folder's last session, or start a new one
  quilt join <invite-link>                            Join a partner's session in this folder
  quilt setup                                         Connect Claude Code / Cursor / others via MCP
  quilt status                                        Show collaborators, claims, activity, chat
  quilt history [path] [--by name] [--since 2h] [--task id] [--diff] [-n 30]
                                                      Who changed what, when, and for which task
  quilt chat                                          Live chat (messages, DMs, files) in this terminal
  quilt say [@name] <message>                         Message everyone, or one person with @name
  quilt send <file> [@name] [message]                 Send a file (not added to the project)
  quilt messages [--all] [--with name] [--grep text] [--before id] [-n 30]
                                                      Show unread messages, or read back: the conversation
                                                      with one person, a search, earlier messages
  quilt get <message-id> [dest]                       Download a shared file again
  quilt commit <message> [--files a,b] [--branch name] [--pr] [--with-others] [--task id]
                                                      Commit your work to GitHub from the session's copy
                                                      (no git needed here): a branch of your own by default
  quilt commit-request <message> [--files a,b] [--task id]
                                                      Ask a person to commit for you (when quilt commit can't)
  quilt commits                                       Open commit requests and recent commits
  quilt focus <what you're doing>                     Tell collaborators what you're working on
  quilt claim <path|glob> [reason]                    Mark files as yours for now
  quilt release <path|glob|*>                         Release a claim
  quilt chat-link [name] [--minutes N]                Owner: a link for a chat-only AI (ChatGPT, claude.ai, Grok); 10 minutes
  quilt chat-link extend <name> <minutes>             Owner: keep a chat link working for that long from now
  quilt github-token [--clear]                        Owner: a read-only GitHub token (read from stdin) so the relay brings in commits while everyone's offline
  quilt invite                                        Print this session's invite code
  quilt workspace list|files|get|put|write|mkdir|mv|rm  The workspace library (quilt workspace for help)
  quilt stop                                          Shut down everything quilt is running (relay, app, syncs)
  quilt doctor [folder] [--watch 30]                  Check what quilt can see of your Claude Code / Cursor chats
  quilt mcp                                           Run the MCP server (used by AI tools)
  quilt hook                                          Claude Code hook (installed by quilt setup; reads the event on stdin)

Join options:
  --agent <name>      Join as a Quilt agent saved with \`quilt agent join\` (default: your account)
  --tool <tool>       What you're coding with, e.g. claude, cursor (shown to others)
  --dir <folder>      Project folder (default: current folder)
  --room <name> --secret <secret>   Join/create a specific room instead of using an invite
  --prefer local      On first join, keep your local version of files that differ
                      (default: take the session's version and back yours up)
`

const cmd = process.argv[2]
const argv = process.argv.slice(3)

async function main () {
  switch (cmd) {
    case 'serve': return serve()
    case 'api': return apiCmd()
    case 'agent': return agentCmd()
    case 'ui': return ui()
    case 'login': return login()
    case 'logout': return logout()
    case 'whoami': return whoami()
    case 'join': return join()
    case 'setup': return doSetup()
    case 'mcp': return (await import('../src/mcp.js')).runMcp()
    case 'hook': process.exitCode = await (await import('../src/hooks.js')).runHook(); return
    case 'status': return status()
    case 'history': return history()
    case 'say': return say()
    case 'send': return sendFile()
    case 'messages': case 'inbox': return messages()
    case 'get': return getFile()
    case 'commit-request': return commitRequest()
    case 'commits': return commits()
    case 'commit': return commitToGit()
    case 'chat': return chat()
    case 'focus': return simple('/focus', { text: argv.join(' ') }, () => 'focus updated')
    case 'claim': return simple('/claim', { pattern: argv[0], note: argv.slice(1).join(' ') }, (r) =>
      `claimed ${argv[0]}` + (r.overlapping?.length ? `\nwarning: overlaps ${r.overlapping.map((c) => `${c.by}'s ${c.pattern}`).join(', ')}` : ''))
    case 'release': return simple('/release', { pattern: argv[0] || '*' }, (r) => `released ${r.released} claim(s)`)
    case 'chat-link': {
      if (argv[0] === 'extend') {
        if (!argv[1] || !Number(argv[2])) fail('usage: quilt chat-link extend <name> <minutes>')
        return simple('/chat-link/extend', { who: argv[1], minutes: Number(argv[2]) }, (r) => `${r.name}'s chat link now works until ${new Date(r.expiresAt).toLocaleString()}.`)
      }
      const i = argv.indexOf('--minutes')
      const minutes = i >= 0 ? Number(argv[i + 1]) : undefined
      const name = argv.filter((a, k) => !(i >= 0 && (k === i || k === i + 1))).join(' ')
      return simple('/chat-link', { name, minutes }, (r) => `Chat link for ${r.name}, until ${new Date(r.expiresAt).toLocaleTimeString()}:\n\n  ${r.url}\n\nPaste it into ChatGPT, claude.ai or Grok with "Open this link and follow it to join our Quilt session."\nAnyone with it can act as ${r.name}. Extend it with \`quilt chat-link extend ${r.name} <minutes>\`; once it runs out, make a new one.`)
    }
    case 'github-token': {
      // Read from stdin, never the command line (where shell history and ps would keep it).
      if (argv[0] === '--clear') return simple('/github-token', { token: '' }, () => 'The relay no longer has a GitHub token for this session.')
      if (argv.length) fail('usage: quilt github-token [--clear]   (the token is read from stdin: pbpaste | quilt github-token)')
      if (process.stdin.isTTY) process.stderr.write('Paste a read-only GitHub token (contents: read) and press Enter: ')
      const token = await new Promise((resolve) => {
        let buf = ''
        process.stdin.setEncoding('utf8')
        process.stdin.on('data', (d) => { buf += d; if (process.stdin.isTTY && buf.includes('\n')) { process.stdin.pause(); resolve(buf) } })
        process.stdin.on('end', () => resolve(buf))
      })
      if (!token.trim()) fail('no token given')
      return simple('/github-token', { token: token.trim() }, () => 'The relay has the token: it brings in commits from your private repository while nobody\'s folder is online.')
    }
    case 'invite': return invite()
    case 'workspace': case 'workspaces': return workspaceCmd()
    case 'stop': return stopAll()
    case 'doctor': {
      const i = argv.indexOf('--watch')
      const secs = i >= 0 ? Number(argv[i + 1]) || 30 : 0
      const dir = argv.find((a, k) => !a.startsWith('--') && !(i >= 0 && k === i + 1))
      return (await import('../src/doctor.js')).doctor({ dir, watchSeconds: secs })
    }
    case '-v': case '--version': case 'version':
      console.log(`quilt ${(await import('../src/releases.js')).currentVersion()}`); return
    case undefined: case '-h': case '--help': case 'help':
      process.stdout.write(HELP); return
    default:
      console.error(`unknown command: ${cmd}\n`); process.stdout.write(HELP); process.exit(1)
  }
}

async function serve () {
  const { values } = parseArgs({ args: argv, options: { port: { type: 'string' }, host: { type: 'string' }, data: { type: 'string' }, key: { type: 'string' } } })
  const { startServer } = await import('../src/server.js')
  const port = Number(values.port || process.env.PORT || 4321)
  const dataDir = path.resolve(values.data || process.env.QUILT_DATA || './quilt-data')
  const srv = await startServer({ port, host: values.host || '0.0.0.0', dataDir, ...(values.key ? { relayKey: values.key } : {}) })
  // One bad request must never take every session down with it.
  process.on('uncaughtException', (err) => console.error('relay: unexpected error, carrying on:', err))
  process.on('unhandledRejection', (err) => console.error('relay: unexpected rejection, carrying on:', err))
  const c = srv.config
  console.log(`quilt relay listening on :${srv.port} (data: ${dataDir})`)
  console.log(`  sign-in: ${c.passPublicKey ? 'a pass from the accounts API is required; new sessions are limited per account' : 'off (set QUILT_PASS_PUBLIC_KEY to require it)'}`)
  console.log(`  dashboard: ${c.apiUrl && c.relayApiSecret ? `reports who is in which session to ${c.apiUrl}` : 'off (set QUILT_API_URL and RELAY_API_SECRET to report sessions to the dashboard)'}`)
  if (!c.passPublicKey) console.log(`  new sessions: ${c.relayKey ? 'need the relay key' : 'open to anyone who can reach this relay (set QUILT_RELAY_KEY to restrict)'}`)
  console.log(`  limits: ${Math.round(c.maxRoomBytes / 1048576)} MB per session, ${Math.round(c.maxRoomFileBytes / 1048576)} MB of shared files, ${c.maxConnsPerIp} connections per address, idle sessions removed after ${c.roomTtlDays} days`)
  console.log(`for development, point Quilt at it with QUILT_SERVER=ws://<this-host>:${srv.port}`)
  const { registerProcess } = await import('../src/procs.js')
  registerProcess('relay', { port: srv.port, dataDir })
  const shutdown = async () => { await srv.close(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function apiCmd () {
  const { values } = parseArgs({ args: argv, options: { port: { type: 'string' }, host: { type: 'string' }, memory: { type: 'boolean' } } })
  const { startApi } = await import('../src/api/server.js')
  const { makeFileStore } = await import('../src/api/file-store.js')
  const env = process.env
  let store, verifyUser, mailer
  if (values.memory) {
    const { createMemoryStore } = await import('../src/api/memory-store.js')
    store = createMemoryStore(); store.addUser('local', { name: 'Local user' })
    verifyUser = async (t) => (t === 'local' ? { userId: 'local', email: '' } : null)
    console.log('in-memory mode: use "Authorization: Bearer local" as the signed-in user')
    const { createConsoleMailer } = await import('../src/api/mailer.js')
    mailer = createConsoleMailer(console.log)
  } else {
    for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'QUILT_SITE_URL', 'SMTP_URL', 'SMTP_FROM', 'PASS_SIGNING_KEY']) if (!env[k]) fail(`${k} is not set`)
    const { createSupabaseStore } = await import('../src/api/supabase-store.js')
    const { createUserVerifier } = await import('../src/api/auth.js')
    store = createSupabaseStore({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY })
    verifyUser = createUserVerifier({ supabaseUrl: env.SUPABASE_URL })
    const { createSmtpMailer } = await import('../src/api/mailer.js')
    mailer = createSmtpMailer({ url: env.SMTP_URL, from: env.SMTP_FROM })
  }
  let passKey = env.PASS_SIGNING_KEY || ''
  if (values.memory && !passKey) {
    const { newPassKeys } = await import('../src/passes.js')
    const keys = newPassKeys()
    passKey = keys.privateKey
    console.log(`pass signing key made for this run; start a local relay with QUILT_PASS_PUBLIC_KEY=${keys.publicKey}`)
  }
  // In memory anyone may use "Bearer local", so only listen on this machine unless asked.
  const host = values.host || (values.memory ? '127.0.0.1' : '0.0.0.0')
  const port = Number(values.port || env.PORT || 8787)
  const api = await startApi({
    port, host, store, verifyUser, mailer, passKey,
    reportKey: env.QUILT_REPORT_KEY || '',
    // The relay signs its presence reports with this (scripts/relay-api-secret.mjs).
    relaySecret: env.RELAY_API_SECRET || '',
    // Quilt's GitHub App (GITHUB_APP_*), for agents' commits; off when not set.
    github: (await import('../src/api/github-app.js')).appConfig(env),
    // Where agents reach this API (invite links point here).
    apiUrl: env.QUILT_API_PUBLIC_URL || (values.memory ? `http://${host}:${port}` : 'https://api.heyquilt.com'),
    siteUrl: env.QUILT_SITE_URL || 'http://localhost:3000',
    trustProxy: /^(1|true|yes)$/i.test(env.QUILT_TRUST_PROXY || ''), log: console.log,
    workspaces: env.QUILT_WORKSPACES === '1' || env.QUILT_WORKSPACES === 'true',
    fileStore: makeFileStore(
      { storageUrl: env.QUILT_STORAGE_URL, storageKey: env.QUILT_STORAGE_KEY, storageBucket: env.QUILT_STORAGE_WS_BUCKET },
      values.memory ? fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-api-files-')) : path.resolve(env.QUILT_API_DATA || './quilt-api-data')
    )
  })
  console.log(`quilt accounts API listening on ${api.url}`)
  if (!env.RELAY_API_SECRET) console.log('RELAY_API_SECRET is not set: the relay cannot report sessions for the dashboard')
  const shutdown = async () => { await api.close(); process.exit(0) }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
}

async function agentCmd () {
  const usage = 'usage: quilt agent join <link> --name <name> [--agent-id <id>] [--provider <p>] [--type <t>] [--description <d>]\n       quilt agent whoami --name <name>'
  const [sub, ...rest] = argv
  let parsed = { values: {}, positionals: [] }
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, options: { name: { type: 'string' }, 'agent-id': { type: 'string' }, provider: { type: 'string' }, type: { type: 'string' }, description: { type: 'string' } } })
  } catch { fail(usage) }
  const { values, positionals } = parsed
  if (!values.name || !((sub === 'join' && positionals[0]) || sub === 'whoami')) fail(usage)
  const { agentJoin, agentWhoami, describeAgent } = await import('../src/agent-join.js')
  try {
    if (sub === 'join') await agentJoin({ link: positionals[0], name: values.name, agentId: values['agent-id'], provider: values.provider, type: values.type, description: values.description })
    else console.log(describeAgent(await agentWhoami({ name: values.name })))
  } catch (err) {
    fail(err.message)
  }
}

async function join () {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      room: { type: 'string' }, secret: { type: 'string' },
      tool: { type: 'string' }, dir: { type: 'string' }, prefer: { type: 'string' }, agent: { type: 'string' }
    }
  })
  const { runSession, decodeInvite, newConn, readConfig, personsFolder, agentCopyFolder } = await import('../src/runner.js')
  const { sessionPasses } = await import('../src/pass-source.js')
  const { clearAccount, readAccount, resumeAccount } = await import('../src/account.js')
  // Every session signs in: as this computer's account, or as a saved agent. A computer
  // linked before signs itself back in when its sign-in was lost.
  if (!values.agent && !readAccount()) await resumeAccount().catch(() => null)
  let auth
  try { auth = sessionPasses({ agent: values.agent || null }) } catch (err) { fail(err.message) }
  const whyStopped = (err) => {
    if (!err.signedOut || values.agent) return err.message
    clearAccount()
    return 'This computer was signed out. Run quilt login again.'
  }
  let dir = path.resolve(values.dir || '.')
  const saved = readConfig(dir) || {}

  const { unsupportedRelay } = await import('../src/settings.js')
  let conn
  if (positionals[0]) {
    try { conn = decodeInvite(positionals[0]) } catch (err) { fail(err.message) }
  } else if (values.room) {
    conn = newConn()
    conn.room = values.room
    if (values.secret || process.env.QUILT_SECRET) conn.secret = values.secret || process.env.QUILT_SECRET
  } else if (saved.server && !unsupportedRelay(saved.server)) {
    conn = { server: saved.server, room: saved.room, secret: saved.secret, ...(saved.viewSecret ? { viewSecret: saved.viewSecret } : {}) }
  } else {
    if (saved.server) console.log("This folder's last session ran on your computer's own relay, which Quilt no longer supports. Starting a new session.")
    conn = newConn()
    console.log('starting a new session')
  }

  // An agent never takes over a folder a person synced from this computer (they'd lose it
  // from the app's Recent list and couldn't get back in): it keeps its own copy of the room.
  if (auth.kind === 'agent' && personsFolder(dir)) {
    const copy = agentCopyFolder(conn.room, auth.name)
    console.log(`${dir} is a person's own copy of a session on this computer and stays theirs: syncing ${copy} instead.`)
    dir = copy
  }

  const stamp = () => new Date().toLocaleTimeString()
  console.log(`quilt: syncing ${dir}`)
  let run
  try {
    let tool = values.tool || saved.tool
    if (!tool && auth.kind === 'agent') {
      try {
        const { agentWhoami } = await import('../src/agent-join.js')
        const { toolLabel } = await import('../src/agents/common.js')
        const me = await agentWhoami({ name: auth.name })
        const provider = me?.agent?.provider
        if (provider) {
          const labeled = toolLabel(provider)
          const known = new Set(['Claude Code', 'Cursor', 'Codex', 'xAI', 'Windsurf', 'Zed', 'GitHub Copilot', 'Aider'])
          if (known.has(labeled)) tool = labeled
          else tool = labeled || tool
        }
      } catch {}
    }
    run = await runSession({
      dir,
      conn,
      name: auth.name,
      tool,
      prefer: values.prefer === 'local' ? 'local' : 'remote',
      kind: auth.kind,
      passes: auth.passes,
      identity: auth.identity,
      inviteServer: saved.room === conn.room ? saved.inviteServer : undefined,
      onLog: (m) => console.log(`[${stamp()}] ${m}`),
      onDebug: process.env.QUILT_DEBUG ? (m) => console.log(`[${stamp()}] debug: ${m}`) : undefined,
      onFatal: (err) => fail(whyStopped(err))
    })
  } catch (err) {
    fail(whyStopped(err))
  }
  console.log(`  room ${conn.room} on ${conn.server} as "${run.session.name}"`)

  const { registerProcess } = await import('../src/procs.js')
  registerProcess('sync', { dir })
  console.log(`\nInvite your partner by sending them this link:\n\n  ${run.invite}\n\nThey paste it into quilt (Join a session), or run \`quilt join <link>\` in an empty (or matching) folder.\n`)
  console.log('Tip: run `quilt setup` once so your AI tools can see each other. Ctrl+C to stop.\n')

  const stop = async () => {
    console.log('\nstopping…')
    await run.stop()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

async function ui () {
  const { values } = parseArgs({ args: argv, options: { port: { type: 'string' }, 'no-open': { type: 'boolean' }, preview: { type: 'boolean' } } })
  const { startUi } = await import('../src/ui-server.js')
  const { registerProcess, stopProcesses } = await import('../src/procs.js')
  ;(await import('../src/integrations.js')).registerOnStart((line) => console.log(line))
  const app = await startUi({
    port: Number(values.port || 7420),
    preview: !!values.preview,
    // The app's "Shut down" button: stop every other quilt process, then this one.
    onShutdown: async () => {
      console.log('\nshutting down everything…')
      await stopProcesses()
      await app.close()
      process.exit(0)
    }
  })
  registerProcess('app', { port: app.port, url: app.url })
  console.log(`quilt is running at:\n\n  ${app.url}\n`)
  console.log('Keep this terminal open while you work. Ctrl+C to stop, or `quilt stop` to shut everything down.')
  if (!values['no-open']) openBrowser(app.url)
  const stop = async () => { console.log('\nstopping…'); await app.close(); process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

async function login () {
  const { values } = parseArgs({ args: argv, options: { 'no-browser': { type: 'boolean' } } })
  const { readAccount, saveAccount, startLink, waitForLink, accountFromProfile, resumeAccount } = await import('../src/account.js')
  const { loadIdentity } = await import('../src/identity.js')
  const current = readAccount()
  if (current) return console.log(`Already signed in as ${current.account.name} (${current.account.email}). Run quilt logout first to switch accounts.`)
  const identity = loadIdentity()
  // Linked before: signs straight back in, no browser.
  const back = await resumeAccount({ identity, asked: true }).catch(() => null)
  if (back) return console.log(`Signed in as ${back.account.name} (${back.account.email}).`)
  let link
  try { link = await startLink({ identity }) } catch (err) { fail(err.message) }
  console.log(`To sign in, open this page and approve this computer:\n\n  ${link.verificationUrl}\n\nCheck it shows the code ${link.userCode}. Waiting…`)
  if (!values['no-browser']) openBrowser(link.verificationUrl)
  let r
  try { r = await waitForLink({ identity, link }) } catch (err) { fail(err.expired ? 'The code expired. Run quilt login again.' : err.message) }
  const account = accountFromProfile(r.profile)
  saveAccount({ token: r.token, account, signedInAt: Date.now() })
  console.log(`Signed in as ${account.name} (${account.email}).`)
  ;(await import('../src/integrations.js')).registerOnStart((line) => console.log(line))
}

async function logout () {
  const { readAccount, signOut } = await import('../src/account.js')
  const current = readAccount()
  if (!current) return console.log('Not signed in')
  await signOut({ token: current.token })
  console.log(`Signed out of ${current.account.email}.`)
}

async function whoami () {
  const { readAccount } = await import('../src/account.js')
  const current = readAccount()
  if (!current) {
    console.log('Not signed in')
    process.exitCode = 1
    return
  }
  console.log(`${current.account.name} (${current.account.email})`)
}

async function openBrowser (url) {
  const { spawn } = await import('node:child_process')
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref() } catch {}
}

async function doSetup () {
  const { setup } = await import('../src/setup.js')
  const changed = setup(process.cwd())
  if (!changed.length) return console.log('already set up')
  console.log('updated:\n' + changed.map((c) => `  - ${c}`).join('\n'))
  console.log('\nAn AI tool that was already open picks up the "quilt" MCP server when it restarts.')
}

async function daemonOrFail () {
  const { findDaemon, call } = await import('../src/control.js')
  const d = findDaemon()
  if (!d) fail('quilt is not running here. Start it with `quilt join` in the project folder.')
  return { d, call }
}

async function status () {
  const { d, call } = await daemonOrFail()
  console.log((await call(d, 'GET', '/status')).markdown)
}

async function history () {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { by: { type: 'string' }, since: { type: 'string' }, task: { type: 'string' }, diff: { type: 'boolean' }, n: { type: 'string', short: 'n' } } })
  const { formatHistory } = await import('../src/history.js')
  await simple('/history', { path: positionals[0], by: values.by, since: values.since, task: values.task, limit: Number(values.n || 30) }, (r) => formatHistory(r.entries, { withDiff: !!values.diff }))
}

async function simple (route, body, format) {
  const { d, call } = await daemonOrFail()
  try { console.log(format(await call(d, 'POST', route, body))) } catch (err) { fail(err.message) }
}

/** Splits "@bob rest of message" into { to: 'bob', rest: [...] }. */
function splitRecipient (args) {
  const i = args.indexOf('--to')
  if (i !== -1) return { to: args[i + 1], rest: [...args.slice(0, i), ...args.slice(i + 2)] }
  if (args[0] && args[0].startsWith('@') && args[0].length > 1) return { to: args[0].slice(1), rest: args.slice(1) }
  return { to: undefined, rest: args }
}

async function say () {
  const flag = (f) => { const i = argv.indexOf(f); if (i === -1) return false; argv.splice(i, 1); return true }
  const everyone = flag('--everyone')
  const also = flag('--also')
  const { to, rest } = splitRecipient(argv)
  if (!rest.length) fail('usage: quilt say [@name] <message>  (a message to everyone names who it is for with @Name, or add --everyone)')
  await simple('/say', { text: rest.join(' '), to, everyone, also }, (r) =>
    to ? `sent to ${to}${r.recipientOnline ? '' : ' (offline, they will see it when they reconnect)'}` : 'sent')
}

async function workspaceCmd () {
  const { WORKSPACE_USAGE, runWorkspaceCommand } = await import('../src/workspace-cli.js')
  const [sub, ...rest] = argv
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') return console.log(WORKSPACE_USAGE)
  const { localWorkspaceAccess } = await import('../src/mcp.js')
  const { findDaemon } = await import('../src/control.js')
  const here = process.env.QUILT_DIR || process.cwd()
  // Whoever this folder's session is (an agent's copy names its agent), from anywhere inside it.
  const projectDirs = () => [here, findDaemon(here)?.dir].filter((d) => d && d !== os.homedir())
  let r
  try {
    r = await runWorkspaceCommand(sub, rest, localWorkspaceAccess({ projectDirs }))
  } catch (err) { fail(err.message) }
  if (!r.ok) fail(r.text.replace(/^Error: /, ''))
  console.log(r.text)
}

async function sendFile () {
  const [file, ...more] = argv
  if (!file) fail('usage: quilt send <file> [@name] [message]')
  if (!fs.existsSync(file)) fail(`no such file: ${file}`)
  const { to, rest } = splitRecipient(more)
  await simple('/send', { path: path.resolve(file), to, text: rest.join(' ') }, (r) =>
    `sent ${r.file.name}${to ? ` to ${to}` : ''}`)
}

async function messages () {
  const { values } = parseArgs({ args: argv, options: { all: { type: 'boolean' }, with: { type: 'string' }, grep: { type: 'string' }, before: { type: 'string' }, n: { type: 'string', short: 'n' } } })
  const { d, call } = await daemonOrFail()
  if (values.with || values.grep || values.before) {
    // Reading back (conversation.js): the kept chat, past the room's newest 500, with message ids.
    const { renderConversation } = await import('../src/conversation.js')
    const r = await call(d, 'POST', '/conversation', { with: values.with, q: values.grep, before: values.before, limit: Number(values.n || 30) })
    return console.log(renderConversation(r, { me: r.me, with: values.with, q: values.grep }).replace(/quilt_conversation|call again with before: "([^"]+)"/g, (m, id) => id ? `run again with --before ${id}` : m))
  }
  const { renderMessage } = await import('../src/status.js')
  const all = values.all
  const { messages } = await call(d, 'POST', '/messages', { unreadOnly: !all, with: values.with, limit: Number(values.n || 50) })
  const me = (await call(d, 'GET', '/status')).me.name
  if (!messages.length) return console.log(all ? 'no messages yet' : 'no unread messages (use --all to see history)')
  for (const m of messages) console.log(plain(renderMessage(m, me)))
}

async function commitRequest () {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { files: { type: 'string' }, task: { type: 'string' } } })
  const files = values.files ? values.files.split(',').map((f) => f.trim()).filter(Boolean) : undefined
  await simple('/commit-request', { message: positionals.join(' '), files, task: values.task }, (r) =>
    `asked for a commit [${r.id}] of ${r.files.length} file${r.files.length === 1 ? '' : 's'}: ${r.files.slice(0, 12).join(', ')}${r.files.length > 12 ? ', …' : ''}\n${r.committer}`)
}

async function commitToGit () {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { files: { type: 'string' }, branch: { type: 'string' }, pr: { type: 'boolean' }, 'with-others': { type: 'boolean' }, task: { type: 'string' } } })
  const files = values.files ? values.files.split(',').map((f) => f.trim()).filter(Boolean) : undefined
  const { describeCommit } = await import('../src/relay-commit.js')
  await simple('/commit', { message: positionals.join(' '), files, branch: values.branch, pullRequest: !!values.pr, withOthers: !!values['with-others'], task: values.task }, (r) =>
    plain(describeCommit(r, { policy: r.agentCommits }).replace(/quilt_commit again and pull_request: true/g, 'quilt commit --pr')))
}

async function commits () {
  const { d, call } = await daemonOrFail()
  const { describeCommitRequests } = await import('../src/commit.js')
  const c = await call(d, 'GET', '/commits')
  console.log(plain(describeCommitRequests(c, { canCommit: !!c.canCommit }).replace(/quilt_commit \(id\)/g, 'quilt commit <id>')))
}

async function getFile () {
  if (!argv[0]) fail('usage: quilt get <message-id> [dest]')
  await simple('/get', { id: argv[0], dest: argv[1] ? path.resolve(argv[1]) : undefined }, (r) => `saved to ${r.path}`)
}

const plain = (md) => md.replace(/\*\*/g, '').replace(/`/g, '')

async function chat () {
  const { d, call } = await daemonOrFail()
  const { renderMessage } = await import('../src/status.js')
  const readline = await import('node:readline')
  const st = await call(d, 'GET', '/status')
  const me = st.me.name
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' })
  const print = (line) => {
    readline.clearLine(process.stdout, 0)
    readline.cursorTo(process.stdout, 0)
    console.log(line)
    rl.prompt(true)
  }

  console.log(`chatting in room ${st.room} as ${me}. Online: ${st.peers.map((p) => p.name).join(', ') || 'nobody else yet'}`)
  console.log('type a message, "@name msg" for a direct message, "/send <file> [@name] [msg]", "/get <id> [dest]", "/who", "/quit"\n')
  const { messages: backlog } = await call(d, 'POST', '/messages', { limit: 20 })
  for (const m of backlog) console.log(plain(renderMessage(m, me)))

  // Live messages over server-sent events.
  const ctrl = new AbortController()
  ;(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${d.port}/events`, { headers: { authorization: `Bearer ${d.token}` }, signal: ctrl.signal })
      const decoder = new TextDecoder()
      let buf = ''
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const event = (block.match(/^event: (.*)$/m) || [])[1]
          const data = (block.match(/^data: (.*)$/m) || [])[1]
          if (!event || !data) continue
          const payload = JSON.parse(data)
          if (event === 'message' && payload.by !== me) print(plain(renderMessage({ ...payload, unread: false }, me)))
          else if (event === 'log' && !payload.startsWith('💬')) print(`  · ${payload}`)
        }
      }
      if (!ctrl.signal.aborted) { print('lost connection to quilt'); process.exit(1) }
    } catch (err) {
      if (!ctrl.signal.aborted) { print(`lost connection to quilt: ${err.message}`); process.exit(1) }
    }
  })()

  rl.prompt()
  rl.on('line', async (line) => {
    line = line.trim()
    try {
      if (!line) {
        // nothing
      } else if (line === '/quit' || line === '/exit') {
        return rl.close()
      } else if (line === '/who') {
        const s = await call(d, 'GET', '/status')
        print(s.peers.length ? s.peers.map((p) => `  ${p.name} (${p.tool})${p.focus ? `: ${p.focus}` : ''}`).join('\n') : '  nobody else is online')
      } else if (line.startsWith('/send ')) {
        const [file, ...more] = line.slice(6).trim().split(/\s+/)
        const { to, rest } = splitRecipient(more)
        const r = await call(d, 'POST', '/send', { path: path.resolve(file), to, text: rest.join(' ') })
        print(`  sent ${r.file.name}${to ? ` to ${to}` : ''}`)
      } else if (line.startsWith('/get ')) {
        const [id, dest] = line.slice(5).trim().split(/\s+/)
        const r = await call(d, 'POST', '/get', { id, dest: dest ? path.resolve(dest) : undefined })
        print(`  saved to ${r.path}`)
      } else if (line.startsWith('/')) {
        print('  unknown command')
      } else {
        const { to, rest } = splitRecipient(line.split(' '))
        // A person typing here, not an AI: what they send needs no @Name.
        const r = await call(d, 'POST', '/say', { text: rest.join(' '), to, everyone: true })
        if (to && !r.recipientOnline) print(`  (${to} is offline; they'll see it when they reconnect)`)
      }
    } catch (err) {
      print(`  error: ${err.message}`)
    }
    rl.prompt()
  })
  rl.on('close', () => { ctrl.abort(); process.exit(0) })
}

async function invite () {
  const { encodeInvite } = await import('../src/runner.js')
  const { unsupportedRelay } = await import('../src/settings.js')
  let dir = process.cwd()
  while (true) {
    const f = path.join(dir, '.quilt', 'config.json')
    if (fs.existsSync(f)) {
      const c = JSON.parse(fs.readFileSync(f, 'utf8'))
      // Never hand out an invite to a relay Quilt won't connect to (or let anyone else connect to).
      if (unsupportedRelay(c.server)) fail("This folder's last session ran on your computer's own relay, which Quilt no longer supports. Run quilt join here to start a new session.")
      return console.log(encodeInvite({ ...c, server: c.inviteServer && !unsupportedRelay(c.inviteServer) ? c.inviteServer : c.server }))
    }
    if (path.dirname(dir) === dir) fail('no session configured in this folder')
    dir = path.dirname(dir)
  }
}

async function stopAll () {
  const { stopProcesses, describeProcess } = await import('../src/procs.js')
  const stopped = await stopProcesses()
  if (!stopped.length) return console.log('nothing to stop: quilt is not running')
  console.log('stopped:\n' + stopped.map((p) => `  - ${describeProcess(p)}`).join('\n'))
}

function fail (msg) {
  console.error(msg)
  process.exit(1)
}

main().catch((err) => fail(err.stack || err.message))
