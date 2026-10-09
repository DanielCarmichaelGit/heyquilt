// `quilt workspace ...`: the workspace library from a shell, for agents (and people) that work
// with commands rather than MCP. Each command runs the same tool the MCP offers
// (workspace-tools.js), as whoever the MCP would act as here (mcp.js workspaceActor): this
// folder's agent, or the person signed in on this computer.
import { registerWorkspaceTools } from './workspace-tools.js'

export const WORKSPACE_USAGE = `Usage:
  quilt workspace list                                    Workspaces you can reach
  quilt workspace files <workspace> [folder] [--glob g]   What is in its library
  quilt workspace get <workspace> <path> [--version n]    Read a file (text is printed; anything else is saved and its path printed)
  quilt workspace put <workspace> <path> <local file> [--note "what it is"]
                                                          Upload a file from this project (a new version if the path exists)
  quilt workspace write <workspace> <path> <text> [--note n]
                                                          Save text as a file
  quilt workspace mkdir <workspace> <folder>              Make a folder (and any above it)
  quilt workspace mv <workspace> <path> <new path>        Rename or move a file or folder
  quilt workspace rm <workspace> <path>                   Delete a file or folder
  quilt workspace webhook <https url> | webhook-off       Workspace events to your URL (agents)
<workspace> is its name or id.`

/** Pulls `--name value` options out of `args`: { opts, rest }. */
function options (args, names) {
  const opts = {}
  const rest = []
  for (let i = 0; i < args.length; i++) {
    const m = String(args[i]).match(/^--([a-z]+)(?:=(.*))?$/)
    if (m && names.includes(m[1])) {
      opts[m[1]] = m[2] !== undefined ? m[2] : args[++i]
      if (opts[m[1]] === undefined) throw new Error(`--${m[1]} needs a value`)
    } else rest.push(args[i])
  }
  return { opts, rest }
}

/** Which tool a command runs, with what arguments; throws the usage when it doesn't fit. */
export function toolCall (sub, args) {
  const { opts, rest } = options(args, ['glob', 'version', 'note'])
  const [ws, a, b] = rest
  const need = (n) => { if (rest.length < n) throw new Error(WORKSPACE_USAGE) }
  switch (sub) {
    case 'list': case 'ls': return ['quilt_workspaces', {}]
    case 'files': need(1); return ['quilt_workspace_files', { workspace: ws, ...(a !== undefined ? { folder: a } : {}), ...(opts.glob ? { glob: opts.glob } : {}) }]
    case 'get': case 'read': need(2); return ['quilt_workspace_read_file', { workspace: ws, path: a, ...(opts.version ? { version: Number(opts.version) } : {}) }]
    case 'put': case 'upload': need(3); return ['quilt_workspace_write_file', { workspace: ws, path: a, fromPath: b, ...(opts.note ? { note: opts.note } : {}) }]
    case 'write': need(3); return ['quilt_workspace_write_file', { workspace: ws, path: a, text: rest.slice(2).join(' '), ...(opts.note ? { note: opts.note } : {}) }]
    case 'mkdir': need(2); return ['quilt_workspace_make_folder', { workspace: ws, path: a }]
    case 'mv': case 'move': need(3); return ['quilt_workspace_move_file', { workspace: ws, path: a, to: b }]
    case 'rm': case 'delete': need(2); return ['quilt_workspace_delete_file', { workspace: ws, path: a }]
    case 'webhook': need(1); return ['quilt_workspace_webhook', { url: ws }]
    case 'webhook-off': return ['quilt_workspace_webhook_off', {}]
    default: throw new Error(WORKSPACE_USAGE)
  }
}

/** Runs one command with `access` (localWorkspaceAccess): { ok, text }. */
export async function runWorkspaceCommand (sub, args, access) {
  const [name, input] = toolCall(sub, args)
  const tools = new Map()
  registerWorkspaceTools({ registerTool: (n, def, fn) => tools.set(n, fn) }, access)
  const r = await tools.get(name)(input)
  return { ok: !r.isError, text: r.content.map((c) => c.text).join('\n') }
}
