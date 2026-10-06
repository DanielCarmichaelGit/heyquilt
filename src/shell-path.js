// An app opened from Finder or the Dock gets a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin),
// so git from Homebrew or Xcode's tools isn't found. The PATH your login shell sets up is
// read once at startup and put in front of it.
import { execFile } from 'node:child_process'
import path from 'node:path'

const MARK = '__QUILT_PATH__'

/**
 * The shell's PATH entries first, then the current ones, each once, in order;
 * on macOS and Linux (`sep` ":"), /usr/bin is always there (the system git lives in it).
 */
export function mergePath (shellPath, currentPath, sep = path.delimiter) {
  const seen = new Set()
  const out = []
  for (const dir of [...String(shellPath || '').split(sep), ...String(currentPath || '').split(sep), ...(sep === ':' ? ['/usr/bin'] : [])]) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    out.push(dir)
  }
  return out.join(sep)
}

/** The PATH printed between two markers (a shell's startup files may print their own lines), or null. */
export function pathFromOutput (out) {
  const m = new RegExp(`${MARK}(.*?)${MARK}`, 's').exec(String(out || ''))
  return m && m[1].trim() ? m[1].trim() : null
}

/** Your login shell's PATH, or null when it can't be read within `timeoutMs`. Never rejects. */
export function loginShellPath ({ shell = process.env.SHELL || '/bin/zsh', timeoutMs = 3000 } = {}) {
  if (process.platform === 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(shell, ['-ilc', `echo "${MARK}\${PATH}${MARK}"`], { timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }, (err, stdout) => {
      resolve(err ? null : pathFromOutput(stdout))
    })
  })
}

/** Sets process.env.PATH to your login shell's PATH merged with the current one. Not on Windows: its PATH is left as it is. */
export async function adoptLoginShellPath (opts) {
  if (process.platform === 'win32') return process.env.PATH
  const shellPath = await loginShellPath(opts)
  process.env.PATH = mergePath(shellPath, process.env.PATH)
  return process.env.PATH
}
