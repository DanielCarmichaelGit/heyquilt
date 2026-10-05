// Quilt keeps a session's local state in .quilt/. In a git folder that is an
// untracked folder, so `git stash -u` or `git clean -fd` would take it away. The
// project's own .gitignore is where git is told to leave it alone: a line is
// added there (and shared, like any edit of .gitignore). Nothing under .git is
// ever touched.
import fs from 'node:fs'
import path from 'node:path'
import { gitDir } from './gitstate.js'

const IGNORES_QUILT = new Set(['.quilt', '.quilt/', '/.quilt', '/.quilt/'])
export const QUILT_IGNORE_COMMENT = "# Quilt keeps this session's local state here"

/**
 * Whether .gitignore's text already has a line ignoring .quilt. Trailing
 * spaces don't count (git drops them); leading ones are part of the pattern.
 */
export function ignoresQuilt (text) {
  return String(text).split(/\r?\n/).some((line) => IGNORES_QUILT.has(line.replace(/\s+$/, '')))
}

/**
 * In a git folder, makes sure .gitignore ignores .quilt/: appends a comment
 * and `.quilt/` when no line does (creating the file if need be, in its own
 * line endings). Returns { added: true }, { added: false } (nothing to do:
 * not a git folder, or already ignored), or { added: false, error } when
 * .gitignore couldn't be read or written.
 */
export function ensureQuiltIgnored (root) {
  if (!gitDir(root)) return { added: false }
  const file = path.join(root, '.gitignore')
  let text = ''
  try {
    const st = fs.lstatSync(file)
    if (!st.isFile()) return { added: false, error: new Error('.gitignore is not a plain file') }
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') return { added: false, error: err }
  }
  if (ignoresQuilt(text)) return { added: false }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lead = text && !text.endsWith('\n') ? eol : ''
  try {
    // Appended, so the file's own bytes stay as they are; O_NOFOLLOW: never through a link put there meanwhile.
    fs.writeFileSync(file, `${lead}${QUILT_IGNORE_COMMENT}${eol}.quilt/${eol}`, { flag: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0) })
  } catch (err) {
    return { added: false, error: err }
  }
  return { added: true }
}
