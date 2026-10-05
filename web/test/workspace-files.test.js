import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { formatBytes, fileRows } from '../lib/files-view.js'

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(5 * 1024 * 1024 * 1024), '5 GB')
})

test('fileRows lists files only, by folder then name', () => {
  const rows = fileRows([{ kind: 'folder', path: 'b' }, { kind: 'file', path: 'b/z.txt', name: 'z.txt', folder: 'b' }, { kind: 'file', path: 'a.txt', name: 'a.txt', folder: '' }, { kind: 'file', path: 'b/a.txt', name: 'a.txt', folder: 'b' }])
  assert.deepEqual(rows.map((r) => r.path), ['a.txt', 'b/a.txt', 'b/z.txt'])
})

test('the pages show the Files section and the download route redirects', () => {
  for (const p of ['../app/dashboard/workspaces/[id]/page.js', '../app/org/[slug]/workspaces/[id]/page.js']) {
    const s = fs.readFileSync(new URL(p, import.meta.url), 'utf8')
    assert.ok(s.includes("from '@/components/WorkspaceFiles.js'") && s.includes('<WorkspaceFiles '), p)
  }
  const r = fs.readFileSync(new URL('../app/api/workspaces/[id]/files/[fileId]/route.js', import.meta.url), 'utf8')
  for (const bit of ['export async function GET', 'currentUser', "'/download", 'redirect(', '401', '404']) assert.ok(r.includes(bit), bit)
})
