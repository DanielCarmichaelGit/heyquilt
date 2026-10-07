// Favicon marks for AI coding tools shown in the partner feed (conversation
// chips and AI reply badges). Names match profile/tool strings in TOOLS.
// Browser-free so unit tests can import it from Node.

function esc (s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/** Accessible display name for a tool string (empty → "AI"). */
export function toolLabel (tool) {
  const t = String(tool || '').trim()
  return t || 'AI'
}

// Company domains for Google's favicon service (sz=128 → crisp at 14–16px).
const DOMAINS = {
  'Claude Code': 'anthropic.com',
  Cursor: 'cursor.com',
  Codex: 'openai.com',
  Windsurf: 'windsurf.com',
  'GitHub Copilot': 'github.com',
  Zed: 'zed.dev',
  Aider: 'aider.chat/docs',  // root returns Google's empty globe; /docs has the real icon
  xAI: 'x.ai'
  // Other → generic sparkle below
}

const faviconImg = (domain) =>
  `<img class="tool-mark" src="https://www.google.com/s2/favicons?domain=${esc(domain)}&sz=128" width="16" height="16" alt="" />`

const GENERIC = (
  // Tiny inline SVG sparkle — fallback ONLY for unknown / empty / Other
  `<svg class="tool-mark" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">` +
  '<path fill="currentColor" d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9z"/>' +
  '<path fill="currentColor" d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>' +
  '</svg>'
)

const ALIASES = {
  claude: 'Claude Code',
  'claude code': 'Claude Code',
  'claude-code': 'Claude Code',
  anthropic: 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex',
  openai: 'Codex',
  windsurf: 'Windsurf',
  codeium: 'Windsurf',
  copilot: 'GitHub Copilot',
  'github copilot': 'GitHub Copilot',
  'vs code': 'GitHub Copilot',
  vscode: 'GitHub Copilot',
  zed: 'Zed',
  aider: 'Aider',
  xai: 'xAI',
  'x.ai': 'xAI',
  grok: 'xAI',
  other: 'Other'
}

/** Canonical TOOLS key for a free-form tool string, or null if unknown. */
export function resolveToolKey (tool) {
  const raw = String(tool || '').trim()
  if (!raw) return null
  if (Object.prototype.hasOwnProperty.call(DOMAINS, raw) || raw === 'Other') return raw
  const lower = raw.toLowerCase()
  if (ALIASES[lower]) return ALIASES[lower]
  for (const key of [...Object.keys(DOMAINS), 'Other']) {
    if (key.toLowerCase() === lower) return key
  }
  return null
}

/**
 * HTML for a provider logo. Uses title + aria-label for the tool name so the
 * visible string can be dropped from chips/badges. Known tools get a Google
 * favicon <img>; unknown / empty / Other get a generic AI sparkle mark.
 */
export function toolLogo (tool, { className = 'tool-logo' } = {}) {
  const label = toolLabel(tool)
  const key = resolveToolKey(tool)
  const domain = key && DOMAINS[key]
  const mark = domain ? faviconImg(domain) : GENERIC
  const cls = className ? ` class="${esc(className)}"` : ''
  return `<span${cls} title="${esc(label)}" aria-label="${esc(label)}">${mark}</span>`
}
