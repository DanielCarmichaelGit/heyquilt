// Wires Quilt into every AI tool on this computer, with nothing for the person to do.
// Tools that run hooks from their user settings (Gemini CLI) get Quilt's hooks there too, so
// its rules are applied by the tool itself (see hooks.js); Claude Code and Cursor get theirs
// from each session folder's .claude/settings.local.json (setup.js installHooks).
//
// Each tool that reads MCP servers from a user-level config gets Quilt's server there,
// pointed at this install by absolute path: GUI tools started from the Dock or Start menu
// don't see the shell's PATH, and project files can't hold one computer's paths (they
// sync to everyone). A tool is only touched when it looks installed (its config folder
// exists), only Quilt's own entry is written, and a file Quilt can't read safely (JSON
// with comments, say) is left alone and reported. Run whenever the app or a session
// starts: it's idempotent, and it follows the app when it moves or updates.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { geminiHookSettings, isQuiltHook } from './hooks.js'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'quilt.js')

/** How to run this Quilt: { command, args, env }. The desktop app's Electron runs it as Node. */
export function quiltLaunch ({ execPath = process.execPath, electron = !!process.versions.electron, bin = BIN } = {}) {
  return { command: execPath, args: [bin], env: electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} }
}

/** The same, as one shell command line (for Claude Code's hooks), with `extra` arguments. */
export function quiltShellCommand (extra = [], launch = quiltLaunch(), platform = process.platform) {
  const q = (s) => `"${platform === 'win32' ? String(s).replace(/\\/g, '/') : String(s)}"`
  const env = Object.entries(launch.env).map(([k, v]) => `${k}=${v} `).join('')
  return `${env}${[launch.command, ...launch.args].map(q).join(' ')}${extra.length ? ' ' + extra.join(' ') : ''}`
}

/** The MCP server entry most tools take: { command, args, env }. */
export function mcpServer (launch = quiltLaunch()) {
  return { command: launch.command, args: [...launch.args, 'mcp'], ...(Object.keys(launch.env).length ? { env: launch.env } : {}) }
}

// ------------------------------------------------------------- files --

/** Reads JSON, tolerating none. `null` means "there, but not plain JSON": not ours to rewrite. */
function readJson (file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return { json: {}, text: '' } }
  if (!text.trim()) return { json: {}, text }
  try {
    const json = JSON.parse(text)
    return json && typeof json === 'object' && !Array.isArray(json) ? { json, text } : { json: null, text }
  } catch { return { json: null, text } }
}

function writeAtomic (file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.quilt-${process.pid}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** Sets json[key...] = value in a JSON file. Returns 'added' | 'updated' | 'unchanged' | 'skipped'. */
export function upsertJsonKey (file, keys, value) {
  const { json, text } = readJson(file)
  if (json === null) return 'skipped'
  let at = json
  for (const k of keys.slice(0, -1)) {
    if (!at[k] || typeof at[k] !== 'object' || Array.isArray(at[k])) at[k] = {}
    at = at[k]
  }
  const last = keys[keys.length - 1]
  if (same(at[last], value)) return 'unchanged'
  const was = at[last] !== undefined
  at[last] = value
  // Keep the file's indentation when we can tell it.
  const indent = (text.match(/\n([ \t]+)"/) || [null, '  '])[1]
  writeAtomic(file, JSON.stringify(json, null, indent) + '\n')
  return was ? 'updated' : 'added'
}

/**
 * Codex's config.toml: Quilt's [mcp_servers.quilt] table between markers, replaced in place.
 * A quilt table someone wrote themselves is left alone (TOML refuses a table defined twice).
 */
export function upsertCodexToml (file, server) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch {}
  const START = '# quilt:start (written by Quilt; edits here are replaced)'
  const END = '# quilt:end'
  const str = (s) => JSON.stringify(String(s)) // TOML basic strings take JSON escapes
  const env = server.env && Object.keys(server.env).length ? `env = { ${Object.entries(server.env).map(([k, v]) => `${k} = ${str(v)}`).join(', ')} }\n` : ''
  const block = `${START}\n[mcp_servers.quilt]\ncommand = ${str(server.command)}\nargs = [${server.args.map(str).join(', ')}]\n${env}${END}`
  const re = /# quilt:start[^\n]*\n[\s\S]*?# quilt:end/
  if (re.test(text)) {
    const next = text.replace(re, block)
    if (next === text) return 'unchanged'
    writeAtomic(file, next)
    return 'updated'
  }
  if (/^\s*\[mcp_servers\.(quilt|"quilt")\]/m.test(text)) return 'unchanged'
  writeAtomic(file, (text ? text.replace(/\s*$/, '\n\n') : '') + block + '\n')
  return 'added'
}

/**
 * Zed's settings.json usually has comments. When it isn't plain JSON and has no
 * context_servers yet, Quilt's entry goes in right after the opening brace, leaving every
 * comment where it was.
 */
function upsertZed (file, entry) {
  const r = upsertJsonKey(file, ['context_servers', 'quilt'], entry)
  if (r !== 'skipped') return r
  const text = fs.readFileSync(file, 'utf8')
  if (/"context_servers"/.test(text)) return 'skipped'
  const at = text.indexOf('{')
  if (at < 0) return 'skipped'
  const body = JSON.stringify({ quilt: entry }, null, 2).replace(/\n/g, '\n  ')
  writeAtomic(file, `${text.slice(0, at + 1)}\n  "context_servers": ${body},${text.slice(at + 1)}`)
  return 'added'
}

/**
 * Quilt's entries in a JSON settings file's `hooks` (Claude Code's shape, which Gemini CLI shares):
 * earlier Quilt entries replaced, everyone else's left alone. Returns like upsertJsonKey.
 */
export function upsertHooks (file, ours) {
  const { json } = readJson(file)
  if (json === null) return 'skipped'
  const hooks = json.hooks && typeof json.hooks === 'object' && !Array.isArray(json.hooks) ? { ...json.hooks } : {}
  for (const [event, entries] of Object.entries(ours)) {
    const kept = (Array.isArray(hooks[event]) ? hooks[event] : [])
      .map((e) => (e && Array.isArray(e.hooks) ? { ...e, hooks: e.hooks.filter((h) => !isQuiltHook(h)) } : e))
      .filter((e) => e && (!Array.isArray(e.hooks) || e.hooks.length))
    hooks[event] = [...kept, ...entries]
  }
  return upsertJsonKey(file, ['hooks'], hooks)
}

/** Both of two writes: 'unchanged' only when both were, the first problem otherwise. */
const both = (a, b) => ['skipped', 'busy', 'failed'].find((r) => r === a || r === b) || (a === 'unchanged' && b === 'unchanged' ? 'unchanged' : a === 'added' ? 'added' : 'updated')

// ------------------------------------------------------------- tools --

/**
 * Every AI tool Quilt knows how to wire up: where it keeps MCP servers, and in what shape.
 * `home` and `platform` are injectable for tests.
 */
export function knownTools ({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming')
  const appSupport = platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : platform === 'win32' ? appData : (env.XDG_CONFIG_HOME || path.join(home, '.config'))
  const xdg = env.XDG_CONFIG_HOME || path.join(home, '.config')
  const json = (keys, shape = (s) => s) => (file, s) => upsertJsonKey(file, keys, shape(s))
  const vscodeLike = (product) => {
    const user = path.join(appSupport, product, 'User')
    return [
      { name: product === 'Code' ? 'VS Code (GitHub Copilot)' : product, dir: user, file: path.join(user, 'mcp.json'), write: json(['servers', 'quilt'], (s) => ({ type: 'stdio', ...s })) },
      { name: `Cline (${product})`, dir: path.join(user, 'globalStorage', 'saoudrizwan.claude-dev'), file: path.join(user, 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'), write: json(['mcpServers', 'quilt']) },
      { name: `Roo Code (${product})`, dir: path.join(user, 'globalStorage', 'rooveterinaryinc.roo-cline'), file: path.join(user, 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'), write: json(['mcpServers', 'quilt']) }
    ]
  }
  const codexHome = env.CODEX_HOME || path.join(home, '.codex')
  return [
    { name: 'Claude Code', dir: path.join(home, '.claude'), file: path.join(home, '.claude.json'), write: json(['mcpServers', 'quilt'], (s) => ({ type: 'stdio', ...s })), busy: (f) => fs.existsSync(`${f}.lock`) },
    { name: 'Claude Desktop', dir: path.join(appSupport, 'Claude'), file: path.join(appSupport, 'Claude', 'claude_desktop_config.json'), write: json(['mcpServers', 'quilt']) },
    { name: 'Cursor', dir: path.join(home, '.cursor'), file: path.join(home, '.cursor', 'mcp.json'), write: json(['mcpServers', 'quilt']) },
    { name: 'Windsurf', dir: path.join(home, '.codeium', 'windsurf'), file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), write: json(['mcpServers', 'quilt']) },
    { name: 'Codex', dir: codexHome, file: path.join(codexHome, 'config.toml'), write: upsertCodexToml },
    { name: 'Gemini CLI', dir: path.join(home, '.gemini'), file: path.join(home, '.gemini', 'settings.json'), write: (f, s, launch) => { const r = json(['mcpServers', 'quilt'])(f, s); return r === 'skipped' ? r : both(r, upsertHooks(f, geminiHookSettings(quiltShellCommand(['hook', 'gemini'], launch)))) } },
    { name: 'GitHub Copilot CLI', dir: path.join(home, '.copilot'), file: path.join(home, '.copilot', 'mcp-config.json'), write: json(['mcpServers', 'quilt'], (s) => ({ type: 'local', ...s, tools: ['*'] })) },
    { name: 'Zed', dir: platform === 'win32' ? path.join(appData, 'Zed') : path.join(xdg, 'zed'), file: platform === 'win32' ? path.join(appData, 'Zed', 'settings.json') : path.join(xdg, 'zed', 'settings.json'), write: (f, s) => upsertZed(f, { source: 'custom', command: s.command, args: s.args, env: s.env || {} }) },
    { name: 'opencode', dir: path.join(xdg, 'opencode'), file: path.join(xdg, 'opencode', 'opencode.json'), write: json(['mcp', 'quilt'], (s) => ({ type: 'local', command: [s.command, ...s.args], enabled: true, ...(s.env ? { environment: s.env } : {}) })) },
    { name: 'Kiro', dir: path.join(home, '.kiro'), file: path.join(home, '.kiro', 'settings', 'mcp.json'), write: json(['mcpServers', 'quilt']) },
    { name: 'Amp', dir: path.join(xdg, 'amp'), file: path.join(xdg, 'amp', 'settings.json'), write: json(['amp.mcpServers', 'quilt']) },
    { name: 'Junie', dir: path.join(home, '.junie'), file: path.join(home, '.junie', 'mcp', 'mcp.json'), write: json(['mcpServers', 'quilt']) },
    { name: 'Continue', dir: path.join(home, '.continue'), file: path.join(home, '.continue', 'mcpServers', 'quilt.json'), write: json(['mcpServers', 'quilt']) },
    ...vscodeLike('Code'),
    ...vscodeLike('Code - Insiders')
  ]
}

/**
 * Registers Quilt's MCP server with every AI tool installed here. Never throws.
 * Returns [{ name, file, result }] for every tool found ('added' | 'updated' |
 * 'unchanged' | 'skipped' | 'busy' | 'failed', with `error` for failed).
 */
export function registerEverywhere ({ launch = quiltLaunch(), ...where } = {}) {
  const server = mcpServer(launch)
  const out = []
  for (const t of knownTools(where)) {
    if (!fs.existsSync(t.dir)) continue
    try {
      if (t.busy && t.busy(t.file)) { out.push({ name: t.name, file: t.file, result: 'busy' }); continue }
      out.push({ name: t.name, file: t.file, result: t.write(t.file, server, launch) })
    } catch (err) {
      out.push({ name: t.name, file: t.file, result: 'failed', error: err.message })
    }
  }
  return out
}

/** One line for logs: which tools just got Quilt, and which need a look. Empty when nothing changed. */
export function describeRegistration (results) {
  const done = results.filter((r) => r.result === 'added' || r.result === 'updated').map((r) => r.name)
  const left = results.filter((r) => r.result === 'skipped' || r.result === 'failed').map((r) => `${r.name} (${r.file})`)
  const parts = []
  if (done.length) parts.push(`🔌 Quilt is now available to ${done.join(', ')}; restart a tool that was open to pick it up`)
  if (left.length) parts.push(`could not safely edit: ${left.join(', ')}`)
  return parts.join('. ')
}

/**
 * What the app, a session and `quilt login` run as they start: register, and log what changed.
 * Skipped under the test runner (it would write to the developer's own tool settings) unless
 * QUILT_REGISTER_TOOLS=1 asks for it.
 */
export function registerOnStart (log = () => {}, opts = {}) {
  if (process.env.NODE_TEST_CONTEXT && process.env.QUILT_REGISTER_TOOLS !== '1') return []
  let results = []
  try { results = registerEverywhere(opts) } catch { return [] }
  const line = describeRegistration(results)
  if (line) log(line)
  return results
}
