#!/usr/bin/env node
import '../src/quiet-warnings.js'
import fs from 'node:fs'
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
  quilt messages [--all] [--with name]                Show unread (or all) messages
  quilt get <message-id> [dest]                       Download a shared file again
  quilt focus <what you're doing>                     Tell collaborators what you're working on
  quilt claim <path|glob> [reason]                    Mark files as yours for now
  quilt release <path|glob|*>                         Release a claim
  quilt chat-link [name] [--hours N]                  Owner: a link for a chat-only AI (ChatGPT, claude.ai, Grok)
  quilt invite                                        Print this session's invite code
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
    case 'chat': return chat()
    case 'focus': return simple('/focus', { text: argv.join(' ') }, () => 'focus updated')
    case 'claim': return simple('/claim', { pattern: argv[0], note: argv.slice(1).join(' ') }, (r) =>
      `claimed ${argv[0]}` + (r.overlapping?.length ? `\nwarning: overlaps ${r.overlapping.map((c) => `${c.by}'s ${c.pattern}`).join(', ')}` : ''))
    case 'release': return simple('/release', { pattern: argv[0] || '*' }, (r) => `released ${r.released} claim(s)`)
    case 'chat-link': {
      const i = argv.indexOf('--hours')
      const hours = i >= 0 ? Number(argv[i + 1]) : undefined
      const name = argv.filter((a, k) => !(i >= 0 && (k === i || k === i + 1))).join(' ')
      return simple('/chat-link', { name, hours }, (r) => `Chat link for ${r.name}, until ${new Date(r.expiresAt).toLocaleString()}:\n\n  ${r.url}\n\nPaste it into ChatGPT, claude.ai or Grok with "Open this link and follow it to join our Quilt session."\nAnyone with it can act as ${r.name}; remove ${r.name} from the session to end it.`)
    }
    case 'invite': return invite()
    case 'stop': return stopAll()
    case 'doctor': {
      const i = argv.indexOf('--watch')
      const secs = i >= 0 ? Number(argv[i + 1]) || 30 : 0
      const dir = argv.find((a, k) => !a.startsWith('--') && !(i >= 0 && k === i + 1))
      return (await import('../src/doctor.js')).doctor({ dir, watchSeconds: secs })
    }
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
    // Where agents reach this API (invite links point here).
    apiUrl: env.QUILT_API_PUBLIC_URL || (values.memory ? `http://${host}:${port}` : 'https://api.heyquilt.com'),
    siteUrl: env.QUILT_SITE_URL || 'http://localhost:3000',
    trustProxy: /^(1|true|yes)$/i.test(env.QUILT_TRUST_PROXY || ''), log: console.log
  })
  console.log(`quilt accounts API listening on ${api.url}`)
  if (!env.RELAY_API_SECRET) console.log('RELAY_API_SECRET is not set: the relay cannot report sessions for the dashboard')
  const shutdown = async () => { await api.close(); process.exit(0) }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
}

async function agentCmd () {
  const usage = 'usage: quilt agent join <link> --name <name> [--provider <p>] [--type <t>] [--description <d>]\n       quilt agent whoami --name <name>'
  const [sub, ...rest] = argv
  let parsed = { values: {}, positionals: [] }
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, options: { name: { type: 'string' }, provider: { type: 'string' }, type: { type: 'string' }, description: { type: 'string' } } })
  } catch { fail(usage) }
  const { values, positionals } = parsed
  if (!values.name || !((sub === 'join' && positionals[0]) || sub === 'whoami')) fail(usage)
  const { agentJoin, agentWhoami, describeAgent } = await import('../src/agent-join.js')
  try {
    if (sub === 'join') await agentJoin({ link: positionals[0], name: values.name, provider: values.provider, type: values.type, description: values.description })
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
    run = await runSession({
      dir,
      conn,
      name: auth.name,
      tool: values.tool || saved.tool,
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
  const { to, rest } = splitRecipient(argv)
  if (!rest.length) fail('usage: quilt say [@name] <message>')
  await simple('/say', { text: rest.join(' '), to }, (r) =>
    to ? `sent to ${to}${r.recipientOnline ? '' : ' (offline, they will see it when they reconnect)'}` : 'sent')
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
  const { values } = parseArgs({ args: argv, options: { all: { type: 'boolean' }, with: { type: 'string' }, n: { type: 'string', short: 'n' } } })
  const { d, call } = await daemonOrFail()
  const { renderMessage } = await import('../src/status.js')
  const all = values.all || !!values.with
  const { messages } = await call(d, 'POST', '/messages', { unreadOnly: !all, with: values.with, limit: Number(values.n || 50) })
  const me = (await call(d, 'GET', '/status')).me.name
  if (!messages.length) return console.log(all ? 'no messages yet' : 'no unread messages (use --all to see history)')
  for (const m of messages) console.log(plain(renderMessage(m, me)))
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
        const r = await call(d, 'POST', '/say', { text: rest.join(' '), to })
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
