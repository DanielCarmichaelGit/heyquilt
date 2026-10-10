// Release notes and the update check. RELEASES.md (shipped with the app) says what changed
// in each version; GitHub's latest release says whether a newer build exists.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSettings, saveSettings } from './settings.js'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const REPO = 'DanielCarmichaelGit/heyquilt'
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES_PAGE = `https://github.com/${REPO}/releases`
const CACHE_MS = 10 * 60 * 1000

/** The version this app is, from package.json. */
export function currentVersion () {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
}

/**
 * The sections of a RELEASES.md: [{ version, date, summary, items }], in file order.
 * A section starts at `## <version> — <date>`; its first plain line is the summary and
 * its `- ` lines are the items. Anything before the first section is ignored.
 */
export function parseReleases (md) {
  const out = []
  let cur = null
  for (const raw of String(md).split(/\r?\n/)) {
    const line = raw.trimEnd()
    const head = line.match(/^## +v?(\d+\.\d+\.\d+)\s*(?:[—–-]+\s*(\d{4}-\d{2}-\d{2}))?\s*$/)
    if (head) { cur = { version: head[1], date: head[2] || '', summary: '', items: [] }; out.push(cur); continue }
    if (!cur) continue
    const item = line.match(/^[-*] +(.*)$/)
    if (item) cur.items.push(item[1].trim())
    else if (line.trim() && !cur.items.length && !cur.summary && !/^#/.test(line)) cur.summary = line.trim()
  }
  return out
}

let local = null
/** The releases listed in this app's RELEASES.md, newest first. */
export function localReleases () {
  if (local) return local
  let md = ''
  try { md = fs.readFileSync(path.join(ROOT, 'RELEASES.md'), 'utf8') } catch {}
  local = parseReleases(md).sort((a, b) => compareVersions(b.version, a.version))
  return local
}

/** Semver order: negative when a < b, 0 when equal, positive when a > b. Unparseable versions sort lowest. */
export function compareVersions (a, b) {
  const num = (v) => { const m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/); return m ? m.slice(1, 4).map(Number) : null }
  const x = num(a); const y = num(b)
  if (!x && !y) return 0
  if (!x) return -1
  if (!y) return 1
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

/** Where to get the newest build for this computer. */
export function downloadUrl (platform = process.platform, arch = process.arch) {
  const file = platform === 'darwin' ? `quilt-mac-${arch === 'arm64' ? 'arm64' : 'x64'}.dmg`
    : platform === 'win32' ? 'quilt-windows-x64.exe'
      : platform === 'linux' ? `quilt-linux-${arch === 'arm64' ? 'arm64' : 'x86_64'}.AppImage`
        : null
  return file ? `${RELEASES_PAGE}/latest/download/${file}` : `${RELEASES_PAGE}/latest`
}

/** The notes inside a GitHub release body written by releaseNotesBody (or by hand in that shape). */
function parseGitHubBody (body) {
  const text = String(body || '').split(/\n\*\*Downloads\*\*/)[0].replace(/^\*\*What's new in [^*]*\*\*\s*/i, '')
  const r = parseReleases(`## 0.0.0\n${text}`)[0] || { summary: '', items: [] }
  return { summary: r.summary, items: r.items }
}

const cache = new Map() // url -> { at, release }
/**
 * The newest release on GitHub: { version, url, date, summary, items }, or null when it can't be
 * reached and nothing is cached. Asks at most every ten minutes; a failed refresh keeps the last answer.
 */
export async function latestRelease ({ url = process.env.QUILT_RELEASES_URL || LATEST_API, now = Date.now, timeoutMs = 6000 } = {}) {
  const hit = cache.get(url)
  if (hit && now() - hit.at < CACHE_MS) return hit.release
  try {
    const res = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': `quilt/${currentVersion()}` }, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
    const r = await res.json()
    const version = String(r.tag_name || '').replace(/^v/, '')
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('no version in the release')
    const release = { version, url: r.html_url || `${RELEASES_PAGE}/tag/v${version}`, date: String(r.published_at || '').slice(0, 10), ...parseGitHubBody(r.body) }
    cache.set(url, { at: now(), release })
    return release
  } catch {
    if (hit) { hit.at = now(); return hit.release } // try again in ten minutes
    return null
  }
}

/** The last version whose notes this computer has seen. */
export function seenVersion () { return String(getSettings().seenRelease || '') }
export function markSeen (version) { saveSettings({ seenRelease: String(version || '') }) }

// "Don't show this again" on the update bar: the newer release it was said for. Kept in the
// settings file, not the page's storage (the app's address changes every launch), and only
// for that release: a newer one shows the bar again.
export function hiddenUpdate () { return String(getSettings().hiddenUpdate || '') }
export function hideUpdate (version) {
  const v = String(version || '')
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error('that is not a version')
  saveSettings({ hiddenUpdate: v })
}

/** The GitHub release body for a RELEASES.md section: the notes, then where to download. */
export function releaseNotesBody (release) {
  const lines = [`**What's new in ${release.version}**`, '']
  if (release.summary) lines.push(release.summary, '')
  for (const it of release.items) lines.push(`- ${it}`)
  lines.push('', '**Downloads**',
    '- Mac (Apple silicon): quilt-mac-arm64.dmg',
    '- Mac (Intel): quilt-mac-x64.dmg',
    '- Windows: quilt-windows-x64.exe',
    '- Linux desktop: quilt-linux-x86_64.AppImage (Intel/AMD), quilt-linux-arm64.AppImage (ARM)',
    `- Linux servers and cloud machines (no desktop): \`curl -fsSL ${RELEASES_PAGE}/latest/download/install.sh | sh\``,
    '',
    '**Note on signing:** these builds are unsigned (no Apple Developer ID / notarization, no Windows code-signing certificate configured). Windows SmartScreen or macOS Gatekeeper may warn on first launch.',
    '',
    '- **macOS:** if you see "Apple could not verify Quilt is free of malware," click **Done**, then open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to Quilt. You only need to do this once. (On older macOS you can instead right-click the app and choose **Open**.)',
    '- **Windows:** if SmartScreen shows "Windows protected your PC," click **More info**, then **Run anyway**.',
    '- **Linux:** make the AppImage runnable (`chmod +x quilt-linux-*.AppImage`) and open it. If it says FUSE is missing, install `libfuse2` (or run it with `--appimage-extract-and-run`).')
  return lines.join('\n') + '\n'
}
