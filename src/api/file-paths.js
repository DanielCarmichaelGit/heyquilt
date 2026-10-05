// Rules for a workspace file's path and name. Pure.
import { HttpError, stripInvisible } from './http.js'

const MAX_PATH = 500
const MIMES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  pdf: 'application/pdf', csv: 'text/csv', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', zip: 'application/zip'
}

/** 'cuts/teaser.mp4': trimmed, single slashes, no '.' or '..' segments, no backslashes or control characters. */
export function cleanFilePath (value) {
  const str = String(value ?? '')
  // Checked on the raw string: stripInvisible would otherwise quietly erase the
  // very control characters this is meant to catch.
  if (/[\\\u0000-\u001f\u007f]/.test(str)) throw new HttpError(400, 'That path has characters a file name cannot have.')
  const raw = stripInvisible(str).join('').trim()
  const parts = raw.split('/').map((p) => p.trim()).filter((p) => p !== '')
  if (!parts.length) throw new HttpError(400, 'Give the file a path.')
  if (parts.some((p) => p === '.' || p === '..')) throw new HttpError(400, 'A path cannot contain . or .. parts.')
  const out = parts.join('/')
  if (out.length > MAX_PATH) throw new HttpError(400, `Keep the path under ${MAX_PATH} characters.`)
  return out
}

export const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
export const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1)
export const mimeOf = (name) => MIMES[String(name).toLowerCase().split('.').pop()] || 'application/octet-stream'
export const isTextual = (mime) => /^text\//.test(mime) || mime === 'application/json'
