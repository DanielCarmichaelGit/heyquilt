// Renders a session status snapshot as Markdown. Used for .quilt/STATUS.md,
// `quilt status`, and the MCP `quilt_status` tool, so every tool sees the same view.

import { branchesMarkdown } from './branches.js'
import { taskMarkdown } from './tasks.js'
import { mergeAction } from './merges.js'
import { catchUpMarkdown } from './catchup.js'

/** A shell word for a path (quoted only when it needs to be). */
const shellWord = (p) => /^[\w./@+-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`

/** The one line that makes way for a pull over files the session put here, and pulls. */
export function makeWayCommand (paths) {
  return `rm ${paths.map(shellWord).join(' ')} && git pull --autostash`
}

/**
 * What to tell a person's AI when the upstream adds files the session already
 * put in this folder (git refuses to pull over untracked files). `adds`: [{ path, same, waiting }].
 */
export function pullAdvice ({ upstream, behind, adds }) {
  const inWay = adds.filter((a) => !a.waiting)
  const differ = adds.filter((a) => !a.same)
  const list = (xs) => xs.map((a) => a.path).join(', ')
  const lines = [`${upstream} has ${behind} commit${behind === 1 ? '' : 's'} adding ${list(adds)}, which the session already put in this folder${differ.length ? '' : ' with the same content'}.`]
  if (inWay.length) lines.push(`git won't pull over untracked files: make way and pull with \`${makeWayCommand(inWay.map((a) => a.path))}\`. Quilt keeps them for everyone and doesn't share the removal (a plain delete at any other time deletes for everyone).`)
  else lines.push('They are out of the way: pull now (`git pull --autostash`). Quilt keeps them for everyone meanwhile.')
  for (const a of differ) lines.push(`${a.path} differs from the session's: after the pull Quilt merges the two (a merge record if they clash).`)
  return lines.join(' ')
}

const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

export function renderStatus (st, { asAi = false, mentionYours = false } = {}) {
  const out = []
  out.push(`# Quilt pair session: room \`${st.room}\``)
  out.push('')
  out.push(`Relay: ${st.connected ? 'connected' : '**disconnected** (edits are kept and will sync on reconnect)'} · ${st.fileCount} shared files`)
  if (!st.connected && st.problem) out.push(`⚠️ ${st.problem}`)
  out.push(`You: **${st.me.name}** (${st.me.tool})${st.me.persona ? `, one of ${st.me.of}'s AI sessions` : ''}${st.me.focus ? ` · focus: ${st.me.focus}` : ''}`)
  if (st.workspaceName || st.workspace) out.push(`Workspace: ${st.workspaceName || st.workspace}`)
  out.push('')

  const away = catchUpMarkdown(st.catchUp, { ago })
  if (away.length) out.push(...away, '')

  out.push('## Partners online')
  if (!st.peers.length) out.push('_Nobody else is connected right now._')
  for (const p of st.peers.filter((x) => x.name !== st.me.name)) {
    const tools = [p.tool, ...(p.agents || [])].filter((t) => t && t !== 'unknown')
    const kind = p.persona ? ` [AI session of ${p.mine && st.me.persona ? 'your person' : p.of}]` : p.kind === 'agent' ? ' [AI agent]' : ''
    out.push(`- **${p.name}**${kind}${tools.length ? ` (${[...new Set(tools)].join(', ')})` : ''}${p.focus ? `: working on: ${p.focus}` : ''}`)
    const ai = aiLine(p.agent)
    if (ai) out.push(`  - AI: ${ai}`)
    const editing = p.editing.slice(0, 8)
    if (editing.length) out.push(`  - recently edited: ${editing.map((e) => `\`${e.path}\` (${e.secondsAgo}s ago)`).join(', ')}`)
  }
  out.push('')

  out.push('## Tasks')
  out.push(taskMarkdown(st.tasks, st.me.name, { tool: st.me.tool, asAi, mentionYours }))
  out.push('')

  if (st.branches && st.branches.length) {
    out.push('## Branches')
    out.push(branchesMarkdown(st.branches, { limit: 6 }))
    out.push('')
  }

  const pull = st.git && st.git.pull
  if (pull && pull.adds && pull.adds.length) {
    out.push('## Pulling')
    out.push(pullAdvice(pull))
    for (const a of pull.adds) out.push(`- \`${a.path}\`: ${a.waiting ? 'out of the way, waiting for your pull' : a.same ? 'same content as the session\'s' : 'differs from the session\'s'}`)
    out.push('')
  }

  out.push('## Claimed files')
  if (!st.claims.length) out.push('_No claims._')
  for (const c of st.claims) {
    const who = c.by === st.me.name ? 'you' : c.by
    out.push(`- \`${c.pattern}\`: ${who}${c.note ? `: ${c.note}` : ''} (${ago(c.ts)})`)
  }
  out.push('')

  const merges = (st.merges || []).filter((m) => m.state !== 'done')
  if (merges.length) {
    out.push('## Merges to settle')
    for (const m of merges) {
      const who = m.by === st.me.name ? 'you' : m.by
      const otherName = m.others[0] ? (m.others[0] === st.me.name ? 'you' : m.others[0]) : null
      const action = mergeAction(m)
      const theirsPart = m.theirsHash === null ? ', it was deleted in the session' : otherName ? `, ${otherName} changed it in the session` : ''
      out.push(`- \`${m.path}\` (id ${m.id}): ${who} ${action}${theirsPart}${m.kind === 'ai' ? '; merged by AI, needs a look' : ''}. See quilt_merges.`)
    }
    out.push('')
  }

  out.push('## Recent activity')
  const act = st.activity.slice(-15).reverse()
  if (!act.length) out.push('_Nothing yet._')
  for (const a of act) {
    const who = a.by === st.me.name ? 'you' : a.by
    if (a.kind === 'pulled') out.push(`- ${ago(a.ts)}: ${who} pulled ${a.detail || 'commits'}`)
    else out.push(`- ${ago(a.ts)}: ${who} ${a.kind} \`${a.path}\`${a.detail ? ` (${a.detail})` : ''}`)
  }
  out.push('')

  out.push('## Changes')
  const changes = st.changes || []
  if (!changes.length) out.push('_No changes yet._')
  for (const p of changes) {
    const who = p.name === st.me.name ? 'you' : `**${p.name}**`
    const line = (g, label) => {
      const n = g.fileCount ?? g.files.length
      const files = g.files.map((f) => `\`${f.path}\` (${fileChange(f)})`)
      if (n > g.files.length) files.push(`and ${n - g.files.length} more`)
      out.push(`- ${who}${label}: ${n} file${n === 1 ? '' : 's'}, +${g.added} -${g.removed} (${ago(g.ts)}): ${files.join(', ')}`)
    }
    // Their own edits, then what their git pulls brought (other people's commits), never mixed.
    if ((p.fileCount ?? p.files.length) || !p.pulled) line(p, '')
    if (p.pulled) line(p.pulled, ' pulled from git')
  }
  out.push('')

  out.push(`## Messages${st.unread ? ` (${st.unread} unread)` : ''}`)
  if (!st.chat.length) out.push('_No messages._')
  for (const m of st.chat.slice(-10)) out.push(`- ${renderMessage(m, st.me.name)}`)
  out.push('')
  return out.join('\n')
}

function aiLine (a) {
  if (!a) return ''
  if (a.sharing === false) return 'sharing paused'
  if (a.status === 'unavailable') return `${a.tool || 'feed'} unavailable`
  if (!a.tool) return ''
  return `${a.tool} ${a.status === 'working' ? 'is working' : 'idle'} (see quilt_partner_feed)`
}

export function renderMessage (m, me) {
  const from = m.by === me ? 'you' : m.by
  const to = m.to ? ` → ${m.to === me ? 'you' : m.to} (direct)` : ''
  let line = `${ago(m.ts)} ${m.unread ? '🆕 ' : ''}**${from}${to}:** ${m.text}`
  if (m.file) {
    line += ` 📎 \`${m.file.name}\` (${formatBytes(m.file.size)})`
    line += m.file.localPath ? `, saved at \`${m.file.localPath}\`` : `, id \`${m.id}\``
  }
  return line
}

export function formatBytes (n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** One file's change in a few words: "deleted", "new, +5" or "+12 -1". */
function fileChange (f) {
  if (f.kind === 'deleted') return 'deleted'
  if (f.kind === 'created') return `new, +${f.added}${f.removed ? ` -${f.removed}` : ''}`
  return `+${f.added} -${f.removed}`
}
