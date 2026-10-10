// What this computer can't do, for tests that need it: false when it can, or the reason to
// skip (node:test shows it). CI runs on Linux, where every one of these is false.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const windows = process.platform === 'win32'

/** POSIX permissions (0600 and the like): Windows has none, so every file reads back as 0666. */
export const NO_POSIX_MODES = windows && 'Windows has no POSIX file permissions'

/** Making a folder refuse writes with chmod: Windows ignores it on folders. */
export const NO_READONLY_DIRS = windows && 'Windows ignores chmod on folders'

/** Running a #!/bin/sh script as a program (a fake git or gh). */
export const NO_SHELL_SCRIPTS = windows && 'Windows cannot run a shell script as a program'

/** Characters Windows refuses in a file name, such as * (a file named "*.txt"). */
export const NO_GLOB_NAMES = windows && 'Windows does not allow * in a file name'

/** Creating symlinks: on Windows only in Developer Mode or an elevated shell. */
export const NO_SYMLINKS = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-symlink-check-'))
  try {
    fs.symlinkSync(dir, path.join(dir, 'link'))
    return false
  } catch {
    return 'this computer cannot create symlinks (on Windows, turn on Developer Mode)'
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})()

/** A project path as Quilt shares it, with / whatever the computer uses. */
export const slashes = (p) => p.split(path.sep).join('/')
