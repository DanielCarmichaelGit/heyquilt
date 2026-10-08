// Installs a newer Quilt from inside the app. The builds are unsigned, so Electron's own
// updater (Squirrel) would refuse them on macOS; this does the same job by hand:
//   macOS   download the DMG, mount it, swap the .app in place, relaunch
//   Windows download the installer and run it (the one-click installer relaunches Quilt)
//   Linux   download the AppImage next to the running one, swap it in, relaunch
// Nothing here imports Electron, so the pieces can be tested on their own.
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => err ? reject(new Error(String(stderr || err.message).trim())) : resolve(stdout))
})

/** The file a download URL ends in: quilt-mac-arm64.dmg, quilt-windows-x64.exe, quilt-linux-x86_64.AppImage. */
export function updateFileName (url) {
  const name = decodeURIComponent(String(url).split(/[?#]/)[0].split('/').pop() || '')
  return /^[\w.-]+\.(dmg|exe|AppImage)$/i.test(name) ? name : null
}

/** The .app bundle a macOS executable path lives in, or null when it isn't in one. */
export function bundlePath (execPath) {
  const m = String(execPath).match(/^(.*?\.app)\/Contents\//)
  return m ? m[1] : null
}

/**
 * Downloads `url` to `dest`, reporting { received, total } as it goes.
 * `total` is 0 when the server doesn't say.
 */
export async function download (url, dest, { onProgress = () => {}, fetchFn = fetch, signal } = {}) {
  const res = await fetchFn(url, { redirect: 'follow', signal, headers: { 'user-agent': 'quilt-updater' } })
  if (!res.ok || !res.body) throw new Error(`The download failed (${res.status}).`)
  const total = Number(res.headers.get('content-length')) || 0
  let received = 0
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  const counter = async function * (src) {
    for await (const chunk of src) { received += chunk.length; onProgress({ received, total }); yield chunk }
  }
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp))
  if (total && received !== total) throw new Error('The download stopped early.')
  fs.renameSync(tmp, dest)
  return dest
}

/**
 * Puts `fresh` where `current` is: the old bundle is moved aside, the new one moved in,
 * then the old one removed. Works while the old app is still running.
 */
export function swapBundle (current, fresh) {
  const old = `${current}.old`
  fs.rmSync(old, { recursive: true, force: true })
  fs.renameSync(current, old)
  try {
    fs.renameSync(fresh, current)
  } catch (err) {
    fs.renameSync(old, current) // put it back
    throw err
  }
  fs.rmSync(old, { recursive: true, force: true })
}

/** The one .app inside a mounted DMG. */
export function findApp (dir) {
  const apps = fs.readdirSync(dir).filter((f) => f.endsWith('.app'))
  if (apps.length !== 1) throw new Error(apps.length ? 'The download has more than one app in it.' : 'The download has no app in it.')
  return path.join(dir, apps[0])
}

async function installMac (dmg, { execPath, onProgress }) {
  const current = bundlePath(execPath)
  if (!current) throw new Error('Quilt is not running from an app bundle.')
  onProgress({ phase: 'installing' })
  const mount = fs.mkdtempSync(path.join(path.dirname(dmg), 'mount-'))
  await run('hdiutil', ['attach', dmg, '-nobrowse', '-noautoopen', '-noverify', '-mountpoint', mount])
  try {
    const fresh = `${current}.new`
    fs.rmSync(fresh, { recursive: true, force: true })
    try {
      await run('ditto', [findApp(mount), fresh])
      swapBundle(current, fresh)
    } catch (err) {
      fs.rmSync(fresh, { recursive: true, force: true })
      if (err.code !== 'EACCES' && err.code !== 'EPERM' && !/permission denied/i.test(err.message)) throw err
      // The folder (usually /Applications) belongs to someone else: ask for an administrator.
      const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
      const cmd = `rm -rf ${q(fresh)} ${q(current + '.old')} && ditto ${q(findApp(mount))} ${q(fresh)} && mv ${q(current)} ${q(current + '.old')} && mv ${q(fresh)} ${q(current)} && rm -rf ${q(current + '.old')}`
      await run('osascript', ['-e', `do shell script "${cmd.replace(/[\\"]/g, '\\$&')}" with administrator privileges`])
    }
  } finally {
    await run('hdiutil', ['detach', mount, '-force']).catch(() => {})
    fs.rmSync(mount, { recursive: true, force: true })
  }
}

function installWindows (exe, { onProgress }) {
  onProgress({ phase: 'installing' })
  // The installer closes Quilt, installs over it and starts it again.
  const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
}

/**
 * Puts a downloaded AppImage where the running one is. An AppImage is one file, and the
 * running copy keeps working from its own mount after it is replaced.
 */
function installLinux (file, { appImage, onProgress }) {
  if (!appImage) throw new Error('Quilt updates itself only when it runs as an AppImage. Download the newest one from the releases page.')
  onProgress({ phase: 'installing' })
  fs.chmodSync(file, 0o755)
  const next = `${appImage}.new`
  // The same folder as the running one, so the swap is one rename (no copy across disks).
  fs.copyFileSync(file, next)
  fs.chmodSync(next, 0o755)
  fs.renameSync(next, appImage)
}

/**
 * Downloads and installs the update at `url`, then tells the caller to relaunch.
 * `onProgress` gets { phase: 'downloading', received, total } then { phase: 'installing' }.
 * Resolves to 'relaunch' (macOS: start the new app) or 'quit' (Windows: the installer relaunches).
 */
export async function installUpdate (url, { platform = process.platform, execPath = process.execPath, appImage = process.env.APPIMAGE, tempDir, onProgress = () => {}, fetchFn } = {}) {
  const name = updateFileName(url)
  if (!name) throw new Error('There is no installer for this computer.')
  if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') throw new Error('Updates install themselves on Mac, Windows and Linux only.')
  if (platform === 'linux' && !appImage) throw new Error('Quilt updates itself only when it runs as an AppImage. Download the newest one from the releases page.')
  const dir = path.join(tempDir, 'quilt-update')
  fs.rmSync(dir, { recursive: true, force: true })
  const file = await download(url, path.join(dir, name), { fetchFn, onProgress: (p) => onProgress({ phase: 'downloading', ...p }) })
  if (platform === 'darwin') {
    await installMac(file, { execPath, onProgress })
    fs.rmSync(dir, { recursive: true, force: true })
    return 'relaunch'
  }
  if (platform === 'linux') {
    installLinux(file, { appImage, onProgress })
    fs.rmSync(dir, { recursive: true, force: true })
    return 'relaunch'
  }
  installWindows(file, { onProgress })
  return 'quit'
}
