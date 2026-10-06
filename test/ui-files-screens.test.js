// test/ui-files-screens.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const ui = (f) => fs.readFileSync(new URL(`../src/ui/${f}`, import.meta.url), 'utf8')
const EM_DASH = String.fromCharCode(0x2014)

test('the workspace page has a Files section with tiles, an upload tile, drag and drop and an All files link', () => {
  const w = ui('workspaces.js'); const f = ui('files.js')
  assert.ok(w.includes("from './files.js'") && w.includes('filesSectionHtml(d)') && w.includes('bindFilesSection('))
  for (const bit of ['class="tiles"', 'class="tile folder"', 'class="tile add"', 'data-upload-tile', 'type="file" multiple', 'data-all-files', "'dragover'", "'drop'", 'of ${bytes(', '/data?t=']) assert.ok(f.includes(bit), bit)
})

test('All files: breadcrumb, tiles or list, new folder, upload, preview panel by type, download, rename, move, delete, versions', () => {
  const f = ui('files.js')
  for (const bit of ['export function allFilesHtml', 'data-ws-open', 'data-folder=', 'data-files-mode=', 'data-new-folder', 'data-upload', 'class="file-preview"', '<img ', '<video controls', '<audio controls', '<iframe ', 'No preview for this kind of file.', 'download=1', 'data-rename', 'data-move', 'data-delete', 'data-versions', 'Download this version', "'/files/'", "'/update'", "'/delete'", "'/folders'"]) assert.ok(f.includes(bit), bit)
  assert.ok(f.includes('text/csv') && f.includes('text/markdown'))
})

test('uploads go through the local server with progress; a picker exists for sessions', () => {
  const f = ui('files.js')
  for (const bit of ['export async function uploadFiles', 'new XMLHttpRequest()', "xhr.upload.onprogress", "'x-path'", '/upload', 'export async function workspaceFilePicker']) assert.ok(f.includes(bit), bit)
})

test('app routes wsfiles: views and polls the open workspace every 20 seconds', () => {
  const a = ui('app.js'); const h = ui('home.js')
  assert.ok(a.includes("startsWith('wsfiles:')") && a.includes('20000'))
  assert.ok(h.includes('allFilesHtml') && h.includes("view.startsWith('wsfiles:')"))
  assert.ok(ui('common.js').includes('filesView:'))
})

test('no em dashes', () => { for (const f of ['files.js', 'workspaces.js', 'app.js', 'home.js', 'app.css']) assert.ok(!ui(f).includes(EM_DASH), f) })

test('picking a file never reflows the tiles: the preview column is always there on wide windows', () => {
  const f = ui('files.js'); const css = ui('app.css')
  assert.ok(f.includes('<aside class="file-preview empty"'))
  assert.ok(!f.includes('has-preview') && !css.includes('has-preview'))
  assert.ok(css.includes('.files-body { display: grid; grid-template-columns: minmax(0, 1fr) 300px;'))
  assert.ok(css.includes('.file-preview.empty { display: none; }'))
})

test('folders: New folder on the workspace page and in All files; files drag onto folders to move', () => {
  const f = ui('files.js')
  for (const bit of ['async function newFolder (id, parent, reload)', "const FILE_DRAG = 'application/x-quilt-file'", 'function bindMoveToFolder', ' draggable="true"', "'dragstart'", "newFolder(id, '', reload)", 'bindMoveToFolder(sec, d, id, reload)', 'bindMoveToFolder(root, d, id, reload)', '<span>New folder</span>']) assert.ok(f.includes(bit), bit)
  assert.ok(ui('app.css').includes('.tile.folder.drop-on'))
})

test('the sidebar stays a sidebar at the desktop app\'s minimum width (880px); it stacks only below 760px', () => {
  const css = ui('app.css')
  assert.ok(css.includes('@media (max-width: 760px) {\n  .app-shell { grid-template-columns: 1fr;'))
  assert.ok(!/@media \(max-width: 900px\) \{\n  \.app-shell/.test(css))
  // Narrow windows get a slim bar and the sidebar as a drawer, not a stacked header.
  assert.ok(css.includes('.mbar, .side-scrim { display: none; }'))
  assert.ok(css.includes('.app-shell.side-open .side { transform: none; }'))
  const h = ui('home.js')
  for (const bit of ['function mobileBarHtml (view)', 'data-side-open', 'data-side-close', "shell.classList.toggle('side-open', open)", '${mobileBarHtml(view)}']) assert.ok(h.includes(bit), bit)
})

