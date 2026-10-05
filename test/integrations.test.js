// Quilt wires itself into every AI tool on the computer, with nothing for the person to do.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerEverywhere, registerOnStart, quiltLaunch, quiltShellCommand, mcpServer, upsertCodexToml } from '../src/integrations.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-integrations-'))
const launch = { command: '/Applications/Quilt.app/Contents/MacOS/Quilt', args: ['/Applications/Quilt.app/Contents/Resources/app.asar/bin/quilt.js'], env: { ELECTRON_RUN_AS_NODE: '1' } }
const server = mcpServer(launch)
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
const results = (rs) => Object.fromEntries(rs.map((r) => [r.name, r.result]))

test('every installed tool gets Quilt by absolute path; tools that are not installed are left alone', () => {
  const home = tmp()
  for (const d of ['.claude', '.cursor', '.codeium/windsurf', '.codex', '.gemini', '.copilot', '.kiro', '.junie', '.continue', 'Library/Application Support/Code/User', 'Library/Application Support/Claude', '.config/zed', '.config/opencode']) fs.mkdirSync(path.join(home, d), { recursive: true })
  fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, 4))
  const rs = registerEverywhere({ home, platform: 'darwin', env: {}, launch })
  const r = results(rs)
  for (const name of ['Claude Code', 'Claude Desktop', 'Cursor', 'Windsurf', 'Codex', 'Gemini CLI', 'GitHub Copilot CLI', 'Kiro', 'Junie', 'Continue', 'VS Code (GitHub Copilot)', 'Zed', 'opencode']) assert.equal(r[name], 'added', name)
  assert.equal(r.Amp, undefined, 'not installed: untouched')
  assert.equal(fs.existsSync(path.join(home, '.config', 'amp')), false)
  // The shapes each tool expects, with this install's absolute path and environment.
  assert.deepEqual(server, { command: launch.command, args: [launch.args[0], 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1' } })
  assert.deepEqual(readJson(path.join(home, '.claude.json')).mcpServers.quilt, { type: 'stdio', ...server })
  const cursor = readJson(path.join(home, '.cursor', 'mcp.json'))
  assert.deepEqual(cursor.mcpServers, { other: { command: 'x' }, quilt: server }, 'other servers kept')
  assert.match(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'), /\n {4}"mcpServers"/, 'indentation kept')
  assert.deepEqual(readJson(path.join(home, 'Library/Application Support/Code/User/mcp.json')).servers.quilt, { type: 'stdio', ...server })
  assert.deepEqual(readJson(path.join(home, '.copilot', 'mcp-config.json')).mcpServers.quilt, { type: 'local', ...server, tools: ['*'] })
  assert.deepEqual(readJson(path.join(home, '.config', 'opencode', 'opencode.json')).mcp.quilt, { type: 'local', command: [server.command, ...server.args], enabled: true, environment: server.env })
  assert.deepEqual(readJson(path.join(home, '.config', 'zed', 'settings.json')).context_servers.quilt, { source: 'custom', command: server.command, args: server.args, env: server.env })
  const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')
  assert.match(toml, /\[mcp_servers\.quilt\]\ncommand = "\/Applications\/Quilt\.app\/Contents\/MacOS\/Quilt"\nargs = \["[^"]+quilt\.js", "mcp"\]\nenv = \{ ELECTRON_RUN_AS_NODE = "1" \}/)
  // Idempotent; a moved app updates every entry.
  assert.ok(registerEverywhere({ home, platform: 'darwin', env: {}, launch }).every((x) => x.result === 'unchanged'))
  const moved = { ...launch, command: '/Users/me/Apps/Quilt.app/Contents/MacOS/Quilt' }
  assert.ok(registerEverywhere({ home, platform: 'darwin', env: {}, launch: moved }).every((x) => x.result === 'updated'))
  assert.equal((fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8').match(/\[mcp_servers\.quilt\]/g) || []).length, 1)
})

test('settings Quilt cannot rewrite safely are left alone; Zed gets its entry without losing comments', () => {
  const home = tmp()
  const vs = path.join(home, '.config', 'Code', 'User')
  fs.mkdirSync(vs, { recursive: true })
  fs.writeFileSync(path.join(vs, 'mcp.json'), '// mine\n{ "servers": {} }\n')
  fs.mkdirSync(path.join(home, '.config', 'zed'), { recursive: true })
  fs.writeFileSync(path.join(home, '.config', 'zed', 'settings.json'), '// Zed settings\n{\n  // the theme\n  "theme": "One Dark"\n}\n')
  fs.mkdirSync(path.join(home, '.claude'))
  fs.writeFileSync(path.join(home, '.claude.json.lock'), '')
  const r = results(registerEverywhere({ home, platform: 'linux', env: {}, launch }))
  assert.equal(r['VS Code (GitHub Copilot)'], 'skipped')
  assert.equal(fs.readFileSync(path.join(vs, 'mcp.json'), 'utf8'), '// mine\n{ "servers": {} }\n', 'untouched')
  assert.equal(r['Claude Code'], 'busy', 'Claude Code is writing its settings: next time')
  assert.equal(r.Zed, 'added')
  const zed = fs.readFileSync(path.join(home, '.config', 'zed', 'settings.json'), 'utf8')
  assert.match(zed, /^\/\/ Zed settings\n\{\n {2}"context_servers": \{\n {4}"quilt": \{/)
  assert.match(zed, /\/\/ the theme\n {2}"theme": "One Dark"/)
})

test('a Codex table someone wrote themselves is not defined twice', () => {
  const file = path.join(tmp(), 'config.toml')
  fs.writeFileSync(file, 'model = "o4"\n\n[mcp_servers.quilt]\ncommand = "quilt"\nargs = ["mcp"]\n')
  assert.equal(upsertCodexToml(file, server), 'unchanged')
  assert.equal((fs.readFileSync(file, 'utf8').match(/\[mcp_servers\.quilt\]/g) || []).length, 1)
})

test('the launch command needs no PATH, and the app runs itself as Node', () => {
  const l = quiltLaunch({ execPath: '/x/Quilt', electron: true, bin: '/x/app.asar/bin/quilt.js' })
  assert.deepEqual(l, { command: '/x/Quilt', args: ['/x/app.asar/bin/quilt.js'], env: { ELECTRON_RUN_AS_NODE: '1' } })
  assert.equal(quiltShellCommand(['hook'], l, 'darwin'), 'ELECTRON_RUN_AS_NODE=1 "/x/Quilt" "/x/app.asar/bin/quilt.js" hook')
  assert.equal(quiltShellCommand(['hook'], { command: 'C:\\Quilt\\Quilt.exe', args: ['C:\\Quilt\\bin\\quilt.js'], env: {} }, 'win32'), '"C:/Quilt/Quilt.exe" "C:/Quilt/bin/quilt.js" hook')
  assert.deepEqual(quiltLaunch({ execPath: '/usr/bin/node', electron: false, bin: '/q/bin/quilt.js' }).env, {})
})

test('start-up registration never touches a developer\'s own tools from the test runner', () => {
  const home = tmp()
  fs.mkdirSync(path.join(home, '.cursor'))
  assert.deepEqual(registerOnStart(() => {}, { home }), [])
  assert.equal(fs.existsSync(path.join(home, '.cursor', 'mcp.json')), false)
})
