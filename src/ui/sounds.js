// Sounds for the moments that need you: someone mentions you or writes to you directly,
// someone asks to be let in (only when you may let them in), or a task is handed to you.
// What to play is worked out by pure helpers (tested in node); the tones are made with
// Web Audio, so there are no sound files to ship and nothing for the CSP to allow.

/** The events that can play a sound, the profile setting that turns each on, and its label. */
export const SOUND_EVENTS = [
  { kind: 'mention', setting: 'soundMentions', label: 'Mentions and direct messages', hint: 'Someone writes @you, or sends you a direct message.' },
  { kind: 'letIn', setting: 'soundLetIn', label: 'Requests to join', hint: 'Someone asks to be let in, and you may let them in.' },
  { kind: 'task', setting: 'soundTasks', label: 'Tasks for you', hint: 'A task is assigned to you or to your AI.' }
]

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** True when `text` mentions `name` the way chat does: @ starts a word, the name ends one, and "@Name's AI" is the AI's. */
export function mentions (text, name) {
  const n = String(name || '').trim()
  if (!n || !text) return false
  return new RegExp(`(^|[^\\w@])@${escapeRe(n)}(?![\\w-])(?!'s AI(?![\\w-]))`, 'iu').test(String(text))
}

/** Whether a live chat message is for `me`: a direct message to me, or one that mentions me. Never my own. */
export function messageSound (message, me) {
  if (!message || !me || typeof message.by !== 'string' || message.by === me) return null
  if (message.to) return message.to === me ? 'mention' : null
  return mentions(message.text, me) ? 'mention' : null
}

/** Whether someone new is asking to be let in. `waiting` is only sent to people who may let them in. */
export function letInSound (before, after) {
  if (!Array.isArray(after) || !after.length) return null
  const known = new Set((Array.isArray(before) ? before : []).map((p) => p && p.key))
  return after.some((p) => p && p.key && !known.has(p.key)) ? 'letIn' : null
}

const forMe = (t, me) => !!t && !t.archived && t.assignee === me && t.column !== 'done'

/** Whether a task became mine (to me or to my AI) between two task lists, by someone else. */
export function taskSound (before, after, me) {
  if (!me || !Array.isArray(after)) return null
  const was = new Map((Array.isArray(before) ? before : []).map((t) => [t && t.id, t]))
  for (const t of after) {
    if (!forMe(t, me)) continue
    const old = was.get(t.id)
    if (old && old.assignee === me && !!old.forAi === !!t.forAi) continue
    // Your own new task, assigned to you as you add it, needs no sound.
    if (!old && t.by === me) continue
    return 'task'
  }
  return null
}

/** Whether `kind` is switched on in the profile. Every sound is on unless switched off. */
export function soundOn (profile, kind) {
  const ev = SOUND_EVENTS.find((e) => e.kind === kind)
  return !!ev && (profile ? profile[ev.setting] : undefined) !== false
}

// A short, soft chime per event: [frequency Hz, start s, length s].
const TONES = {
  mention: [[880, 0, 0.12], [1318.5, 0.1, 0.18]],
  letIn: [[659.3, 0, 0.12], [880, 0.12, 0.12], [1046.5, 0.24, 0.2]],
  task: [[987.8, 0, 0.1], [740, 0.1, 0.18]]
}
const GAP_MS = 1500 // one sound for a burst of events, not one per event

let ctx = null
let last = 0

function audio () {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext
  if (!AC) return null
  if (!ctx) ctx = new AC()
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  return ctx
}

/** Plays the chime for `kind`, at most once every GAP_MS. `force` skips the gap (the Settings preview). */
export function playSound (kind, { force = false } = {}) {
  const tones = TONES[kind]
  if (!tones) return false
  const now = Date.now()
  if (!force && now - last < GAP_MS) return false
  last = now
  try {
    const ac = audio()
    if (!ac) return false
    const t0 = ac.currentTime + 0.01
    for (const [freq, start, len] of tones) {
      const osc = ac.createOscillator()
      const gain = ac.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t0 + start)
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + start + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + len)
      osc.connect(gain).connect(ac.destination)
      osc.start(t0 + start)
      osc.stop(t0 + start + len + 0.02)
    }
    return true
  } catch { return false }
}

/** Browsers start audio muted until the page is used: wake it on the first click or key. */
export function unlockSounds () {
  const wake = () => { try { audio() } catch {} }
  globalThis.addEventListener?.('pointerdown', wake, { once: true })
  globalThis.addEventListener?.('keydown', wake, { once: true })
}
