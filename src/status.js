// Renders a session status snapshot as Markdown. Used for .quilt/STATUS.md,
// `quilt status`, and the MCP `quilt_status` tool, so every tool sees the same view.

import { taskMarkdown } from './tasks.js'
import { mergeAction } from './merges.js'

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
  out.push(`You: **${st.me.name}** (${st.me.tool})${st.me.focus ? ` · focus: ${st.me.focus}` : ''}`)
  out.push('')

  out.push('## Partners online')
  if (!st.peers.length) out.push('_Nobody else is connected right now._')
  for (const p of st.peers) {
    const tools = [p.tool, ...(p.agents || [])].filter((t) => t && t !== 'unknown')
    out.push(`- **${p.name}**${p.kind === 'agent' ? ' [AI agent]' : ''}${tools.length ? ` (${[...new Set(tools)].join(', ')})` : ''}${p.focus ? `: working on: ${p.focus}` : ''}`)
    const ai = aiLine(p.agent)
    if (ai) out.push(`  - AI: ${ai}`)
    const editing = p.editing.slice(0, 8)
    if (editing.length) out.push(`  - recently edited: ${editing.map((e) => `\`${e.path}\` (${e.secondsAgo}s ago)`).join(', ')}`)
  }
  out.push('')

  out.push('## Tasks')
  out.push(taskMarkdown(st.tasks, st.me.name, { tool: st.me.tool, asAi, mentionYours }))
  out.push('')

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
    out.push(`- ${ago(a.ts)}: ${who} ${a.kind} \`${a.path}\`${a.detail ? ` (${a.detail})` : ''}`)
  }
  out.push('')

  out.push('## Changes')
  const changes = st.changes || []
  if (!changes.length) out.push('_No changes yet._')
  for (const p of changes) {
    const who = p.name === st.me.name ? 'you' : `**${p.name}**`
    const n = p.fileCount ?? p.files.length
    const files = p.files.map((f) => `\`${f.path}\` (${fileChange(f)})`)
    if (n > p.files.length) files.push(`and ${n - p.files.length} more`)
    out.push(`- ${who}: ${n} file${n === 1 ? '' : 's'}, +${p.added} -${p.removed} (${ago(p.ts)}): ${files.join(', ')}`)
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
