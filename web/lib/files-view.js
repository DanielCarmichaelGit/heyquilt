// Pure helpers for the workspace file list, so they're unit-tested directly.
export function formatBytes (n) {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0; let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  const s = i === 0 ? String(v) : (Math.round(v * 10) / 10).toString()
  return `${s} ${units[i]}`
}
/** Files only (folders are implied by paths), sorted by folder then name. */
export function fileRows (files) {
  return (files || []).filter((f) => f.kind === 'file').sort((a, b) => (a.folder || '').localeCompare(b.folder || '') || a.name.localeCompare(b.name))
}
