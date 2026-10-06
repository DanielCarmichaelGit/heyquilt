// Whether an agent's Quilt (its "image": the build it runs) is current. Every
// Quilt MCP tells an agent in each answer when a newer Quilt is out, and
// quilt_check_update answers for whatever image the agent names.
import { currentVersion, latestRelease, compareVersions } from './releases.js'

export const UPDATE_HOW = 'Update Quilt (the desktop app: Settings → About → Update Quilt; the CLI: npm i -g github:DanielCarmichaelGit/heyquilt, or on a Linux server run its install script again: curl -fsSL https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download/install.sh | sh), then rejoin the session.'

/** True when `image` looks like a Quilt version. */
export const validImage = (image) => /^v?\d+\.\d+\.\d+$/.test(String(image || '').trim())

/**
 * The line to show an agent whose image is older than `latest`, or '' when it is current
 * (or when the image is unknown or unparseable: nobody is told to update on a guess).
 */
export function updateNotice (image, latest) {
  if (!validImage(image) || !validImage(latest)) return ''
  const mine = String(image).trim().replace(/^v/, '')
  const newest = String(latest).trim().replace(/^v/, '')
  if (compareVersions(mine, newest) >= 0) return ''
  return `You must update your app: you run Quilt ${mine} and ${newest} is out. ${UPDATE_HOW}`
}

/**
 * Keeps the newest Quilt version this process knows of: its own, or GitHub's latest
 * release when that is newer. `latest()` answers at once from what it knows;
 * `refresh()` asks GitHub (cached ten minutes by latestRelease) and is run on a timer.
 */
export class UpdateCheck {
  constructor ({ mine = currentVersion(), fetchLatest = latestRelease, everyMs = 10 * 60 * 1000 } = {}) {
    this.mine = mine
    this.newest = mine
    this.fetchLatest = fetchLatest
    this.everyMs = everyMs
    this.timer = null
  }

  async refresh () {
    const r = await this.fetchLatest().catch(() => null)
    if (r && validImage(r.version) && compareVersions(r.version, this.newest) > 0) this.newest = r.version
    return this.newest
  }

  /** Starts refreshing in the background (never blocks a tool call). */
  start () {
    if (this.timer) return this
    this.refresh().catch(() => {})
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.everyMs)
    this.timer.unref()
    return this
  }

  stop () { if (this.timer) clearInterval(this.timer); this.timer = null }

  latest () { return this.newest }

  /** The update line for `image` (this process's own version when none is given), or ''. */
  notice (image = this.mine) { return updateNotice(image, this.newest) }

  /** What quilt_check_update answers. */
  describe (image) {
    const given = image != null && String(image).trim() !== ''
    if (given && !validImage(image)) return `"${String(image).trim().slice(0, 40)}" is not a Quilt version (expected something like ${this.newest}). ${this.describe()}`
    const mine = given ? String(image).trim().replace(/^v/, '') : this.mine
    const n = updateNotice(mine, this.newest)
    return n || `Quilt ${mine} is current (the newest release is ${this.newest}).`
  }
}
