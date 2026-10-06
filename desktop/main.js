// Quilt desktop app: the same app as `quilt ui`, in its own window. Sessions
// keep syncing from the menu bar when the window is closed, and invite links
// (quilt://join?invite=…) open straight into the join screen.
import '../src/quiet-warnings.js'
import { app, BrowserWindow, Tray, Menu, shell, dialog, ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startUi } from '../src/ui-server.js'
import { registerProcess } from '../src/procs.js'
import { decodeInvite } from '../src/runner.js'
import { quiltHome, adoptLegacyEnv } from '../src/legacy.js'
import { downloadUrl } from '../src/releases.js'
import { installUpdate } from './updater.js'
import { registerOnStart } from '../src/integrations.js'
import { adoptLoginShellPath } from '../src/shell-path.js'

adoptLegacyEnv()
// Opened from Finder or the Dock, the app has a minimal PATH: git (Homebrew's, Xcode's) is
// found through your login shell's PATH, read while the app gets ready. Never rejects.
const shellPath = adoptLoginShellPath()

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI_SHIM = path.join(quiltHome(), 'bin', 'quilt')
const CLI_LINK = '/usr/local/bin/quilt'

let ui = null
let win = null
let tray = null
let quitting = false
let pendingInvite = null
let rendererReady = false

/** The invite link inside a quilt:// URL, or null. */
function inviteFrom (url) {
  try {
    const u = new URL(url)
    if (u.protocol !== 'quilt:') return null
    const link = u.searchParams.get('invite') || ''
    decodeInvite(link)
    return link
  } catch { return null }
}

function openInvite (link) {
  if (!link) return
  if (!win || !rendererReady) { pendingInvite = link; if (win) showWindow(); return }
  showWindow()
  win.webContents.send('invite', link)
}

/** Tells Quilt about a crash in this process, when the app is far enough along to. Never throws. */
async function reportCrash (name, err) {
  try {
    if (!ui) return
    ui.report({ kind: 'crash', name, outcome: 'error', message: err?.stack || err?.message || String(err) })
    await ui.flushReports()
  } catch {}
}

// Electron would show its own dialog and carry on; do the same, after telling Quilt.
process.on('uncaughtException', (err) => {
  reportCrash('main', err).finally(() => dialog.showErrorBox('quilt hit a problem', err?.stack || err?.message || String(err)))
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // A second launch (Windows/Linux invite links arrive this way) focuses this one.
  app.on('second-instance', (e, argv) => {
    showWindow()
    openInvite(argv.map(inviteFrom).find(Boolean))
  })
  // macOS delivers quilt:// links here, possibly before the app is ready.
  // Any other quilt:// link (e.g. quilt://open from the website) just brings the app forward.
  app.on('open-url', (e, url) => {
    e.preventDefault()
    const link = inviteFrom(url)
    if (link) openInvite(link)
    else if (win) showWindow()
  })

  if (process.defaultApp) app.setAsDefaultProtocolClient('quilt', process.execPath, [path.resolve(process.argv[1])])
  else app.setAsDefaultProtocolClient('quilt')

  pendingInvite = process.argv.map(inviteFrom).find(Boolean) || null
  app.whenReady().then(start).catch(async (err) => {
    await reportCrash('start', err)
    dialog.showErrorBox('quilt could not start', err.stack || err.message)
    app.exit(1)
  })
}

async function start () {
  await shellPath // before anything can run git
  ui = await startUi({ port: 0, onShutdown: () => app.quit() })
  registerProcess('app', { port: ui.port, url: ui.url, desktop: true })
  process.on('SIGTERM', () => app.quit()) // `quilt stop`
  if (app.isPackaged) writeCliShim()
  // Every AI tool on this computer gets Quilt's MCP server before anyone joins anything.
  registerOnStart((line) => console.log(line))

  ipcMain.handle('ready', () => { rendererReady = true; const l = pendingInvite; pendingInvite = null; return l })
  ipcMain.handle('pick-folder', async (e, current) => {
    const expanded = String(current || '').replace(/^~(?=$|\/)/, os.homedir())
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose a folder',
      buttonLabel: 'Use this folder',
      defaultPath: expanded && fs.existsSync(expanded) ? expanded : os.homedir(),
      properties: ['openDirectory', 'createDirectory']
    })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('install-update', () => update())

  Menu.setApplicationMenu(appMenu())
  makeTray()
  createWindow()
}

// ---------------------------------------------------------------- update --
// "Update Quilt" in the app: download the newest build, install it, restart.
let updating = null
function update () {
  if (updating) return updating
  updating = (async () => {
    if (!app.isPackaged) throw new Error('Updates install into the packaged app only; from source, pull and restart.')
    const progress = (p) => { if (win && !win.isDestroyed()) win.webContents.send('update-progress', p) }
    try {
      const next = await installUpdate(downloadUrl(), { tempDir: app.getPath('temp'), onProgress: progress })
      quitting = true
      if (next === 'relaunch') app.relaunch()
      setTimeout(() => app.quit(), 300) // let the renderer show "Restarting…"
      return { ok: true }
    } catch (err) {
      updating = null
      throw new Error(err.message || 'The update failed.')
    }
  })()
  return updating
}

function createWindow () {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 600,
    title: 'quilt',
    show: false,
    backgroundColor: '#f4efe6',
    webPreferences: { preload: path.join(HERE, 'preload.cjs'), contextIsolation: true, sandbox: true }
  })
  rendererReady = false
  win.loadURL(ui.url)
  win.once('ready-to-show', () => win.show())
  win.webContents.on('did-start-navigation', (e) => { if (e.isMainFrame && !e.isSameDocument) rendererReady = false })

  // Links to anywhere else open in the browser, never inside the app.
  const origin = new URL(ui.url).origin
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url) && !url.startsWith(origin)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(origin)) return
    e.preventDefault()
    if (/^https?:/.test(url)) shell.openExternal(url)
  })

  // Closing the window keeps sessions syncing in the menu bar.
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    win.hide()
  })
}

function showReleaseNotes () {
  showWindow()
  win.webContents.send('release-notes')
}

function showWindow () {
  if (!win || win.isDestroyed()) return createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function makeTray () {
  tray = new Tray(path.join(HERE, 'icons', process.platform === 'darwin' ? 'trayTemplate.png' : 'tray-color.png'))
  tray.setToolTip('quilt')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Quilt', click: showWindow },
    { type: 'separator' },
    { label: 'Quit Quilt', click: () => app.quit() }
  ]))
  if (process.platform !== 'darwin') tray.on('click', showWindow)
}

function appMenu () {
  const isMac = process.platform === 'darwin'
  return Menu.buildFromTemplate([
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { label: 'What’s New in Quilt…', click: showReleaseNotes },
            { type: 'separator' },
            { label: 'Install the Quilt Command…', click: installCli },
            { type: 'separator' },
            { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
          ]
        }]
      : [{ label: 'File', submenu: [{ label: 'What’s New in Quilt…', click: showReleaseNotes }, { type: 'separator' }, { role: 'quit' }] }]),
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' }
  ])
}

// ------------------------------------------------------ command line --
// AI tools reach Quilt through the `quilt` command (its MCP server). The
// app ships that command; this keeps a small launcher for it up to date.
function writeCliShim () {
  const main = path.join(app.getAppPath(), 'bin', 'quilt.js')
  const script = `#!/bin/sh\n# The Quilt command, run by the Quilt desktop app's copy of Node.\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${main}" "$@"\n`
  try {
    fs.mkdirSync(path.dirname(CLI_SHIM), { recursive: true })
    if (!fs.existsSync(CLI_SHIM) || fs.readFileSync(CLI_SHIM, 'utf8') !== script) fs.writeFileSync(CLI_SHIM, script, { mode: 0o755 })
  } catch {}
}

async function installCli () {
  if (!app.isPackaged) {
    return dialog.showMessageBox(win, { message: 'Install the command from the packaged app', detail: 'When running from source, use `npm link` in the Quilt folder instead.' })
  }
  writeCliShim()
  let current = null
  try { current = fs.readlinkSync(CLI_LINK) } catch {}
  if (current === CLI_SHIM) {
    return dialog.showMessageBox(win, { message: 'The Quilt command is installed', detail: `You can run \`quilt\` in any terminal, and AI tools can use it.` })
  }
  if (fs.existsSync(CLI_LINK) && current !== CLI_SHIM) {
    const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Replace', 'Cancel'], defaultId: 0, cancelId: 1, message: 'A Quilt command is already installed', detail: `${CLI_LINK} already exists. Replace it with the one from this app?` })
    if (r.response !== 0) return
  }
  try {
    fs.mkdirSync(path.dirname(CLI_LINK), { recursive: true })
    fs.rmSync(CLI_LINK, { force: true })
    fs.symlinkSync(CLI_SHIM, CLI_LINK)
  } catch {
    // /usr/local/bin usually needs an administrator; macOS asks for the password.
    const cmd = `mkdir -p /usr/local/bin && ln -sf '${CLI_SHIM}' '${CLI_LINK}'`
    const ok = await new Promise((resolve) => execFile('osascript', ['-e', `do shell script "${cmd}" with administrator privileges`], (err) => resolve(!err)))
    if (!ok) return
  }
  dialog.showMessageBox(win, { message: 'The Quilt command is installed', detail: 'You can now run `quilt` in any terminal. AI tools like Claude Code and Cursor use it to see your session.' })
}

// Quit cleanly: stop every session (so edits are flushed) before exiting.
let closed = false
app.on('before-quit', (e) => {
  quitting = true
  if (closed || !ui) return
  e.preventDefault()
  ui.close().catch(() => {}).finally(() => { closed = true; app.quit() })
})
app.on('activate', showWindow)
app.on('window-all-closed', () => {}) // stay in the menu bar
