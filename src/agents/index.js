// Starts every AI-chat reader for a folder and merges their output. Readers
// are best-effort: a failure in one never affects syncing or the others.
import { startClaudeCodeReader } from './claude-code.js'
import { startCursorReader } from './cursor.js'
import { startCursorTranscriptReader } from './cursor-transcripts.js'

const READERS = [
  ['Claude Code', startClaudeCodeReader],
  ['Cursor', startCursorReader],
  ['Cursor', startCursorTranscriptReader]
]

/**
 * @returns {{ stop(): void }}
 * onEntries(entries)  entries: { id, tool, conv, kind: 'prompt'|'reply'|'action', text, ts }
 * onState(state)      state:   { tool, status: 'working'|'idle'|'unavailable', reason? }
 *                     (one combined state: the tool that's working, else the last one active)
 */
export function startAgentReaders ({ dir, onEntries, onState, onLog = () => {}, readers = READERS, ...opts }) {
  const states = new Map()
  let lastActive = null
  let combined = ''

  const report = () => {
    const all = [...states.values()]
    // Until a tool shows activity, don't claim anyone uses it.
    const pick = all.find((s) => s.status === 'working') ||
      (lastActive != null && states.get(lastActive)) ||
      (all.length && all.every((s) => s.status === 'unavailable') ? all[0] : { tool: null, status: 'idle' })
    const unavailable = all.filter((s) => s.status === 'unavailable')
    const out = { ...pick }
    if (pick.status !== 'unavailable' && unavailable.length) out.notes = unavailable.map((s) => `${s.tool}: ${s.reason}`)
    const key = JSON.stringify(out)
    if (key === combined) return
    combined = key
    onState(out)
  }

  const handles = []
  // Two readers can share a tool name (Cursor's composer db and its transcripts).
  // Keep their states apart so one going idle cannot hide the other still working.
  readers.forEach(([tool, start], i) => {
    const guard = (fn) => (...args) => { try { fn(...args) } catch (err) { onLog(`${tool} feed error: ${err.message}`) } }
    try {
      handles.push(start({
        dir,
        ...opts,
        onLog,
        onEntries: guard((entries) => {
          if (!entries.length) return
          // Do not pin lastActive from entries alone: Claude Code (and others) backfill
          // history on start, which used to leave partners seeing "Claude Code idle"
          // forever even when the person actually uses Cursor / xAI / Grok.
          onEntries(entries)
          report()
        }),
        onState: guard((s) => {
          states.set(i, s)
          if (s.status === 'working') lastActive = i
          report()
        })
      }))
    } catch (err) {
      onLog(`${tool} feed could not start: ${err.message}`)
    }
  })
  return { stop () { for (const h of handles) { try { h.stop() } catch {} } } }
}
