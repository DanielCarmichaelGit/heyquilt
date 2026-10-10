// Loaded before every test file (`--import` in the npm test scripts), and before every Node
// process a test starts (through NODE_OPTIONS). It keeps tests out of the real home folder:
//
// - The run gets a throwaway home, unless a test gave its child process one of its own.
// - os.homedir() follows HOME. On macOS and Linux it already does; on Windows it reads
//   USERPROFILE, so a test that set HOME used to read and write the real ~/.quilt there
//   (its account, settings and recent sessions).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'

const systemHome = os.homedir
const real = process.env.QUILT_TEST_REAL_HOME || systemHome()
process.env.QUILT_TEST_REAL_HOME = real

const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
if (!process.env.HOME || same(process.env.HOME, real)) {
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-test-home-'))
}
process.env.USERPROFILE = process.env.HOME

// Git as on a fresh machine. Without this, one computer's settings change what tests see:
// Git for Windows turns core.autocrlf on system-wide, so files check out with \r\n.
// (The personal ~/.gitconfig is already out of reach: HOME is a throwaway folder.)
process.env.GIT_CONFIG_NOSYSTEM = '1'

os.homedir = () => {
  const home = process.env.HOME || process.env.USERPROFILE
  if (!home || same(home, real)) throw new Error(`a test asked for the real home folder (${real}); give it a temporary one`)
  return home
}
syncBuiltinESMExports()

const self = `--import=${import.meta.url}` // a file: URL, so a space in the path can't split NODE_OPTIONS
if (!(process.env.NODE_OPTIONS || '').includes(self)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} ${self}`.trim()
}
