// Shared state and helpers for the Quilt app (native ES modules, no build step).
import { parseInvite } from './invite.js'

// The app only ever talks to Quilt's own relay, so an old-style relay link that happens
// to be this address resolves the same way a join.heyquilt.com link does.
const HOSTED_RELAY = 'wss://relay.heyquilt.com'
// Same list as settings.js: the hosted relay under its current and older address.
const HOSTED_ALIASES = [HOSTED_RELAY, 'wss://cowove-relay.fly.dev']

// ---------------------------------------------------------------- token --
const params = new URLSearchParams(location.search)
if (params.get('t')) {
  try { sessionStorage.setItem('quilt-token', params.get('t')) } catch {}
  history.replaceState(null, '', '/')
}
export let TOKEN = params.get('t')
try { TOKEN = TOKEN || sessionStorage.getItem('quilt-token') } catch {}

// ---------------------------------------------------------------- icons --
export const I = {
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  power: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/></svg>',
  bot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><path d="M9 14h.01M15 14h.01"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/></svg>',
  tree: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h6M3 12h18M3 19h18M13 5h8"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  chevDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  caret: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
  branch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9a6 6 0 0 1-6 6H6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
  board: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7.5"/><path d="m8.4 12.1 2.4 2.4 4.8-5"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  arrowRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l10.4-6.5a1 1 0 0 0 0-1.8L9.5 4.6A1 1 0 0 0 8 5.5z"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  arrowLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m11 18-6-6 6-6"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>',
  external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>'
}

export const TOOLS = ['Claude Code', 'Cursor', 'Codex', 'Windsurf', 'GitHub Copilot', 'Zed', 'Aider', 'Other']

// ---------------------------------------------------------------- state --
export const state = {
  loaded: false,
  account: null, // { id, name, email }: who this computer is signed in as
  sessions: new Map(), // id -> summary
  messages: new Map(), // id -> [message]
  recent: [],
  defaults: {},
  profile: {}, // name, tool, color, joinDir, shareAgent, summarize, preferLocal
  maxFileBytes: 0,
  view: 'home', // 'home' | session id
  pane: 'chat', // mobile pane
  to: '', // chat recipient ('' = everyone)
  pending: [], // files queued in the composer
  error: null,
  feeds: new Map(), // session id -> Map(person -> entries[])
  trees: new Map(), // session id -> { files, claims }
  files: new Map(), // `${id}\n${path}` -> file contents from /file
  sv: new Map(), // session id -> session view layout (mode, tabs, expanded folders)
  accessTypes: null, // the account's access types (built-ins first), once loaded; null if the API can't be reached
  workspaces: null, // [] once /api/workspaces answered; null before
  orgs: [], // the account's orgs ({ slug, name }), for the Add workspace form and the filter
  addingWorkspace: false, // the Add workspace card is showing its form
  workspacesOn: false, // the accounts API has workspaces on
  workspace: null, // the open workspace page's data
  spaceFilter: 'all', // the home grid's Personal / org switch
  filesView: { folder: '', picked: null, mode: 'tiles' }, // the All files view: folder shown, file previewed, tiles or list
  pollTimer: null // refreshes the open workspace (ws: or wsfiles:) every 20 seconds
}

// -------------------------------------------------------------- helpers --
export const $ = (sel, root = document) => root.querySelector(sel)
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
export const basename = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || p
export const bytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(1)} GB`
export const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 45) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return new Date(ts).toLocaleDateString()
}
export const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
export const PALETTE = ['#b9432b', '#3b6a9a', '#4a7a45', '#855a9c', '#a8701c', '#2e7a80', '#9c4f6b']
export const colorFor = (name, given) => given || PALETTE[Math.abs([...String(name)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0)) % PALETTE.length]
/** A workspace's colours (its cover, its dot in the sidebar). */
export const COLORS = { lilac: '#d9c6ea', mint: '#cfe6d4', peach: '#f6dcc0', rose: '#f3d3d0', periwinkle: '#e0dcf0', sky: '#cfe0ee' }

export const avatar = (name, color, online = false) =>
  `<div class="avatar${online ? ' online' : ''}" style="background:${esc(colorFor(name, color))}">${esc(String(name || '?').slice(0, 1))}</div>`

export function toast (msg) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => t.classList.remove('show'), 2400)
}

/**
 * An in-app replacement for confirm()/prompt(): browser dialogs are blocked in
 * some embedded views (a preview pane answers "no" without showing anything).
 * Resolves true/false, or with `input` the trimmed text (null when cancelled).
 * `input.select` ([{ value, label }]) shows a dropdown instead and resolves with the chosen value.
 */
export function ask ({ title, message = '', ok = 'OK', danger = false, input = null }) {
  return new Promise((resolve) => {
    const back = document.createElement('div')
    back.className = 'modal-back'
    back.innerHTML = `<form class="card modal" role="dialog" aria-modal="true" aria-labelledby="ask-title" autocomplete="off">
      <h3 id="ask-title">${esc(title)}</h3>
      ${message ? `<p class="lead">${esc(message)}</p>` : ''}
      ${input ? `<div class="field"><label for="ask-input">${esc(input.label || '')}</label>${Array.isArray(input.select)
        ? `<select class="input" id="ask-input">${input.select.map((o) => `<option value="${esc(o.value)}" ${o.value === input.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
        : `<input class="input" id="ask-input" placeholder="${esc(input.placeholder || '')}" value="${esc(input.value || '')}">`}</div>` : ''}
      <div class="actions"><button type="button" class="btn" data-no>Cancel</button><button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(ok)}</button></div>
    </form>`
    document.body.appendChild(back)
    const form = back.querySelector('form')
    const field = back.querySelector('#ask-input')
    const done = (v) => { back.remove(); resolve(v) }
    const cancel = () => done(input ? null : false)
    back.addEventListener('mousedown', (e) => { if (e.target === back) cancel() })
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancel() })
    back.querySelector('[data-no]').onclick = cancel
    form.onsubmit = (e) => {
      e.preventDefault()
      if (!input) return done(true)
      const v = field.value.trim()
      if (v) done(v)
      else field.focus()
    }
    ;(field || back.querySelector('[type=submit]')).focus()
  })
}

export async function api (method, path, body, headers = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'x-quilt-token': TOKEN || '', ...(body && !(body instanceof Blob) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body instanceof Blob ? body : body ? JSON.stringify(body) : undefined
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`)
    // This computer isn't signed in (any more): the app goes back to the sign-in screen.
    if (res.status === 401 && data.signedOut) {
      err.signedOut = true
      window.dispatchEvent(new Event('quilt-signed-out'))
    }
    throw err
  }
  return data
}

// ------------------------------------------------------------ access types --
export const NO_POSTING = "You can't post in this session."
export const ACCOUNT_KEY = /^(person|agent):[A-Za-z0-9_-]{1,64}$/

/** Loads this account's access types into state.accessTypes (null when the accounts API can't be reached). */
export async function loadAccessTypes () {
  try { state.accessTypes = (await api('GET', '/api/access-types')).types } catch { state.accessTypes = null }
  return state.accessTypes
}

/** <option>s for an access type picker, "Can edit" selected unless `selected` says otherwise. */
export function typeOptions (selected = 'builtin:edit') {
  return (state.accessTypes || []).map((t) => `<option value="${esc(t.id)}" ${t.id === selected ? 'selected' : ''}>${esc(t.name)}</option>`).join('')
}

/** "Can edit · src · except src/keys · no posting": what someone's access comes to, from the relay's member list. */
export function accessLine (m) {
  if (m.role === 'viewer') return m.talk === false ? 'View only · no posting' : 'View only'
  const parts = ['Can edit', m.scopes && m.scopes.length ? m.scopes.join(', ') : 'all folders']
  if (m.scopesExcept && m.scopesExcept.length) parts.push(`except ${m.scopesExcept.join(', ')}`)
  if (m.talk === false) parts.push('no posting')
  return parts.join(' · ')
}

// ------------------------------------------------------------- reports --
// Errors nothing caught (a bug in the page) go to the app, which tells Quilt. The same
// message within ten seconds is sent once. api() failures are not sent from here: the
// handler that failed already recorded them.
const recentReports = new Map()
function reportRendererError (message) {
  const text = String(message || '').slice(0, 500)
  if (!text) return
  const t = Date.now()
  if (recentReports.get(text) > t - 10_000) return
  recentReports.set(text, t)
  for (const [k, v] of recentReports) if (v < t - 60_000) recentReports.delete(k)
  fetch('/api/report', {
    method: 'POST',
    headers: { 'x-quilt-token': TOKEN || '', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'renderer', message: text, context: { view: String(state.view || '') } })
  }).catch(() => {})
}
window.addEventListener('error', (e) => reportRendererError(e.message || (e.error && e.error.message) || ''))
window.addEventListener('unhandledrejection', (e) => reportRendererError((e.reason && e.reason.message) || String(e.reason || '')))

/**
 * Same as decodeInvite in runner.js (room and relay only): an invite link, or an older base64 code.
 * A link naming its own relay must name Quilt's relay or the one this app uses (state.defaults.relay).
 */
export function decodeInvite (code) {
  const allowRelay = (s) => HOSTED_ALIASES.includes(String(s).replace(/\/+$/, '')) || (!!state.defaults.relay && s === state.defaults.relay)
  try {
    const r = parseInvite(code, { allowRelay })
    return { server: r.relay || HOSTED_RELAY, room: r.room }
  } catch {
    return null
  }
}

export function remember (key, value) { try { localStorage.setItem(`quilt-${key}`, value) } catch {} }
export function recall (key, fallback = '') { try { return localStorage.getItem(`quilt-${key}`) ?? fallback } catch { return fallback } }

/** Whose AI is still working, from a session status (for commit timing). */
export function busyPeople (st, { includeMe = true } = {}) {
  const people = [...(includeMe ? [{ ...st.me, isMe: true }] : []), ...st.peers]
  const out = []
  for (const p of people) {
    const a = p.agent
    if (a && a.sharing !== false && a.status === 'working') out.push(`${p.isMe ? 'your' : `${p.name}'s`} ${a.tool || 'AI'}`)
    else if (p.work && p.work.state === 'working') out.push(p.isMe ? 'you' : p.name)
  }
  return out
}

/** Tools someone is using, for badges. */
export const toolsOf = (p) => [...new Set([p.tool, ...(p.agents || [])].filter((t) => t && t !== 'unknown'))]

// Native <select> menus look out of place, so every select gets a styled button
// and menu. The real select stays (hidden) in the form, so .value, form data
// and change events work exactly as before.
let openMenu = null
function closeMenu (refocus) {
  if (!openMenu) return
  const { menu, btn } = openMenu
  openMenu = null
  menu.remove()
  btn.setAttribute('aria-expanded', 'false')
  if (refocus) btn.focus()
}

function syncDropdown (sel, btn) {
  const o = sel.options[sel.selectedIndex]
  btn.querySelector('.dd-label').textContent = o ? o.textContent : ''
  btn.disabled = sel.disabled
}

function openDropdown (sel, btn) {
  closeMenu()
  const menu = document.createElement('div')
  menu.className = 'dd-menu'
  menu.setAttribute('role', 'listbox')
  ;[...sel.options].forEach((o, i) => {
    const item = document.createElement('div')
    item.className = 'dd-item' + (i === sel.selectedIndex ? ' on' : '')
    item.setAttribute('role', 'option')
    item.setAttribute('aria-selected', String(i === sel.selectedIndex))
    if (o.disabled) item.setAttribute('aria-disabled', 'true')
    item.dataset.i = i
    item.innerHTML = `<span>${esc(o.textContent)}</span>${I.check || ''}`
    menu.append(item)
  })
  document.body.append(menu)
  const r = btn.getBoundingClientRect()
  menu.style.minWidth = `${r.width}px`
  const below = window.innerHeight - r.bottom
  const h = Math.min(menu.scrollHeight, 280)
  menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)}px`
  menu.style.top = below < h + 12 && r.top > below ? `${r.top - h - 4}px` : `${r.bottom + 4}px`
  btn.setAttribute('aria-expanded', 'true')
  openMenu = { menu, btn, sel, active: Math.max(0, sel.selectedIndex) }
  highlight(openMenu.active)

  menu.addEventListener('mousedown', (e) => e.preventDefault())
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.dd-item')
    if (item && item.getAttribute('aria-disabled') !== 'true') choose(Number(item.dataset.i))
  })
  menu.addEventListener('mousemove', (e) => {
    const item = e.target.closest('.dd-item')
    if (item) highlight(Number(item.dataset.i), false)
  })
}

function highlight (i, scroll = true) {
  if (!openMenu) return
  const items = openMenu.menu.children
  if (!items.length) return
  openMenu.active = Math.max(0, Math.min(items.length - 1, i))
  ;[...items].forEach((x, j) => x.classList.toggle('active', j === openMenu.active))
  if (!scroll) return
  // Scroll only the menu: scrollIntoView can scroll the page, which closes the menu.
  const { menu } = openMenu
  const it = items[openMenu.active]
  if (it.offsetTop < menu.scrollTop) menu.scrollTop = it.offsetTop
  else if (it.offsetTop + it.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = it.offsetTop + it.offsetHeight - menu.clientHeight
}

function choose (i) {
  const { sel } = openMenu
  closeMenu(true)
  if (i === sel.selectedIndex || sel.options[i]?.disabled) return
  sel.selectedIndex = i
  sel.dispatchEvent(new Event('input', { bubbles: true }))
  sel.dispatchEvent(new Event('change', { bubbles: true }))
}

function enhanceSelect (sel) {
  if (sel.dataset.dd) return
  sel.dataset.dd = '1'
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = `dd-btn ${sel.className}`.trim()
  btn.setAttribute('aria-haspopup', 'listbox')
  btn.setAttribute('aria-expanded', 'false')
  const label = sel.getAttribute('aria-label') || (sel.id && document.querySelector(`label[for="${CSS.escape(sel.id)}"]`)?.textContent)
  if (label) btn.setAttribute('aria-label', label)
  btn.innerHTML = `<span class="dd-label"></span>${I.chevDown}`
  sel.classList.add('dd-native')
  sel.tabIndex = -1
  sel.setAttribute('aria-hidden', 'true')
  sel.after(btn)
  syncDropdown(sel, btn)

  // A <label for> click focuses the hidden select; send it to the button.
  sel.addEventListener('focus', () => btn.focus())
  sel.addEventListener('change', () => syncDropdown(sel, btn))
  new MutationObserver(() => syncDropdown(sel, btn)).observe(sel, { childList: true, subtree: true, attributes: true, characterData: true })
  btn.addEventListener('click', () => {
    if (openMenu?.btn === btn) closeMenu()
    else openDropdown(sel, btn)
  })
  btn.addEventListener('keydown', (e) => {
    const open = openMenu?.btn === btn
    if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); openDropdown(sel, btn); return }
    if (!open) return
    const keys = {
      ArrowDown: () => highlight(openMenu.active + 1),
      ArrowUp: () => highlight(openMenu.active - 1),
      Home: () => highlight(0),
      End: () => highlight(Infinity),
      Enter: () => choose(openMenu.active),
      ' ': () => choose(openMenu.active),
      Escape: () => { e.stopPropagation(); closeMenu(true) }
    }
    if (keys[e.key]) { e.preventDefault(); keys[e.key](); return }
    if (e.key === 'Tab') { closeMenu(); return }
    if (e.key.length === 1) {
      const k = e.key.toLowerCase()
      const opts = [...sel.options]
      const n = opts.length
      for (let j = 1; j <= n; j++) {
        const idx = (openMenu.active + j) % n
        if (opts[idx].textContent.trim().toLowerCase().startsWith(k)) { highlight(idx); break }
      }
    }
  })
}

export function startDropdowns (root = document.body) {
  root.querySelectorAll('select').forEach(enhanceSelect)
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue
        if (n.tagName === 'SELECT') enhanceSelect(n)
        else n.querySelectorAll?.('select').forEach(enhanceSelect)
      }
      // Remove a menu whose button left the page (e.g. a re-render).
      if (openMenu && !openMenu.btn.isConnected) closeMenu()
    }
  }).observe(root, { childList: true, subtree: true })
  document.addEventListener('mousedown', (e) => {
    if (openMenu && !openMenu.menu.contains(e.target) && !openMenu.btn.contains(e.target)) closeMenu()
  })
  window.addEventListener('resize', () => closeMenu())
  document.addEventListener('scroll', (e) => { if (openMenu && !openMenu.menu.contains(e.target)) closeMenu() }, true)
}
