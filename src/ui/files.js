// A workspace's file library: the Files section on the workspace page, the All files view
// (folders, tiles or a list, a preview panel, rename, move, delete, versions), uploads through
// the app's local server with progress, and a picker other screens use to choose a file.
// Bytes always come from the local server (/api/workspaces/<id>/files/<fid>/data), so
// thumbnails and previews stay same-origin under the page's CSP.
import { I, state, esc, toast, api, ask, ago, bytes, TOKEN } from './common.js'

const wsUrl = (id, rest = '') => `/api/workspaces/${encodeURIComponent(id)}${rest}`
const fileUrl = (id, fid, rest = '') => wsUrl(id, '/files/' + encodeURIComponent(fid) + rest)
/** The file's bytes for <img>, <video>, <audio>, <iframe> and links: the token rides in the query. */
const dataUrl = (id, f, extra = '') => fileUrl(id, f.id, '/data?t=' + encodeURIComponent(TOKEN || '')) + `&v=${encodeURIComponent(f.version || 1)}${extra}`
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
const MAX_TEXT_PREVIEW = 2 * 1024 * 1024
const CSV_ROWS = 200
const NEWEST = 8

// ----------------------------------------------------------------- types --
const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac',
  pdf: 'application/pdf', csv: 'text/csv', md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', json: 'application/json'
}
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'json', 'yml', 'yaml', 'toml', 'xml', 'html', 'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'sh', 'sql', 'log', 'ini', 'env', 'srt', 'vtt'])
const TEXT_MIME = new Set(['application/json', 'application/xml', 'application/javascript', 'application/x-yaml', 'application/yaml', 'application/toml', 'application/sql'])
const extOf = (name) => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name)); return m ? m[1].toLowerCase() : '' }
const mimeOf = (f) => String(f.mime || EXT_MIME[extOf(f.name)] || '').split(';')[0].toLowerCase()

/** What the preview panel does with a file: image, video, audio, pdf, csv, text or none. */
function previewKind (f) {
  const m = mimeOf(f)
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (m === 'application/pdf') return 'pdf'
  if (m === 'text/csv') return 'csv'
  if (m === 'text/markdown' || m.startsWith('text/') || TEXT_MIME.has(m) || TEXT_EXT.has(extOf(f.name))) return 'text'
  return 'none'
}

const BADGE = { image: '#c24f33', video: '#7b4f9e', audio: '#2e7a80', pdf: '#b3372e', csv: '#a8701c', sheet: '#3d7a4c', text: '#6e6c7e', none: '#6e6c7e' }
const SHEETS = new Set(['xlsx', 'xls', 'numbers', 'ods'])
const badgeText = (f) => (extOf(f.name) || 'file').slice(0, 4).toUpperCase()
const badgeColor = (f) => (SHEETS.has(extOf(f.name)) ? BADGE.sheet : BADGE[previewKind(f)])

// ------------------------------------------------------------------ data --
const filesOf = (d) => (d.files || []).filter((f) => f.kind !== 'folder')
const foldersOf = (d) => (d.files || []).filter((f) => f.kind === 'folder')
const newestFirst = (a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0)
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
const canEdit = (d) => d.access?.access === 'edit'
const inside = (folder, path) => folder === '' || path.startsWith(folder + '/')

/** Who uploaded: a member's name when the workspace knows them, else the account's kind. */
function whoOf (d, account) {
  if (!account) return ''
  const people = [d.owner, ...(d.members || [])].filter(Boolean)
  const m = people.find((p) => p.account === account)
  if (m?.name) return m.name
  if (state.account && account === `person:${state.account.id}`) return state.account.name || 'You'
  return String(account).startsWith('agent:') ? 'agent' : 'person'
}

function folderStats (d, path) {
  const list = filesOf(d).filter((f) => f.path.startsWith(path + '/'))
  return { count: list.length, size: list.reduce((n, f) => n + (f.size || 0), 0) }
}

function usageText (d) {
  const u = d.usage
  if (!u) return ''
  return Number.isFinite(u.quotaBytes) ? `${bytes(u.usedBytes || 0)} of ${bytes(u.quotaBytes)}` : `${bytes(u.usedBytes || 0)} used`
}

/** "5m ago", "3h ago", "now", or a date. */
const when = (ts) => { if (!ts) return ''; const a = ago(ts); return /^\d+[mh]$/.test(a) ? `${a} ago` : a }

// ----------------------------------------------------------- upload state --
// One upload at a time per page, kept outside the DOM so a re-render (the 20 s poll) still
// shows its progress.
let progress = null // { id, n, m, pct }
const progressLabel = () => `Uploading ${progress.n} of ${progress.m} · ${progress.pct}%`
const uploadingTo = (id) => !!progress && progress.id === id

function paintProgress () {
  document.querySelectorAll('[data-progress]').forEach((el) => { el.textContent = progress ? progressLabel() : (el.dataset.idle || '') })
  document.querySelectorAll('[data-progress-bar]').forEach((el) => { el.style.width = `${progress ? progress.pct : 0}%` })
}

async function startUpload (id, list, folder, reload) {
  const files = [...list]
  if (!files.length) return
  if (progress) return toast('Wait for the upload in progress to finish.')
  const view = state.view
  progress = { id, n: 1, m: files.length, pct: 0 }
  paintProgress()
  document.querySelectorAll('[data-upload-tile]').forEach((t) => { t.dataset.busy = '' })
  try {
    await uploadFiles(id, files, {
      folder,
      onProgress: (file, loaded, total) => {
        progress = { id, n: files.indexOf(file) + 1, m: files.length, pct: total ? Math.min(100, Math.round((loaded / total) * 100)) : 0 }
        paintProgress()
      }
    })
  } finally {
    progress = null
    // Redraw only the screen the upload started on; anywhere else, the 20 s poll catches up.
    if (state.view === view) await reload()
  }
}

/** One PUT per file to the local server, which streams it on to the workspace's storage. */
export async function uploadFiles (id, files, { folder = '', onProgress = () => {} } = {}) {
  for (const file of files) {
    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('PUT', wsUrl(id, '/upload'))
        xhr.setRequestHeader('x-quilt-token', TOKEN || '')
        xhr.setRequestHeader('x-path', encodeURIComponent(folder ? folder + '/' + file.name : file.name))
        xhr.setRequestHeader('content-type', file.type || 'application/octet-stream')
        xhr.upload.onprogress = (e) => onProgress(file, e.loaded, e.lengthComputable ? e.total : file.size)
        xhr.onload = () => {
          let body = {}
          try { body = JSON.parse(xhr.responseText || '{}') } catch {}
          if (xhr.status >= 200 && xhr.status < 300) { onProgress(file, file.size, file.size); return resolve(body) }
          if (xhr.status === 401 && body.signedOut) window.dispatchEvent(new Event('quilt-signed-out'))
          reject(new Error(body.error || `Upload failed (${xhr.status})`))
        }
        xhr.onerror = () => reject(new Error('The upload did not reach Quilt.'))
        xhr.send(file)
      })
    } catch (err) {
      toast(`${file.name}: ${err.message}`)
    }
  }
}

// ----------------------------------------------------------------- tiles --
function folderTileHtml (d, f) {
  const s = folderStats(d, f.path)
  return `
    <button type="button" class="tile folder" data-folder="${esc(f.path)}" title="${esc(f.path)}">
      <span class="thumb">${I.folder}</span>
      <span class="nm">${esc(f.name)}</span><span class="mu">${esc(plural(s.count, 'file', 'files'))}${s.count ? ` · ${esc(bytes(s.size))}` : ''}</span>
    </button>`
}

function thumbHtml (d, f) {
  const kind = previewKind(f)
  const inner = kind === 'image'
    ? `<img loading="lazy" alt="" src="${esc(dataUrl(d.workspace.id, f))}">`
    : kind === 'video' ? `<span class="play">${I.play}</span>` : `<span class="stem">${esc(f.name.replace(/\.[^.]+$/, '').slice(0, 14))}</span>`
  return `<span class="thumb${kind === 'image' ? ' img' : kind === 'video' ? ' vid' : ''}">${inner}<span class="badge" style="background:${badgeColor(f)}">${esc(badgeText(f))}</span>${f.version > 1 ? `<span class="ver">v${esc(f.version)}</span>` : ''}</span>`
}

function fileTileHtml (d, f, { meta, on = false }) {
  return `
    <button type="button" class="tile${on ? ' on' : ''}" data-pick-file="${esc(f.id)}" title="${esc(f.path)}">
      ${thumbHtml(d, f)}
      <span class="nm">${esc(f.name)}</span><span class="mu">${esc(meta)}</span>
    </button>`
}

function uploadTileHtml (id, label) {
  const busy = uploadingTo(id)
  return `
    <button type="button" class="tile add" data-upload-tile${busy ? ' data-busy' : ''}>
      <span class="up">${I.upload}</span><span class="lbl" data-progress data-idle="${esc(label)}">${esc(busy ? progressLabel() : label)}</span>
      <span class="bar"><span data-progress-bar style="width:${busy ? progress.pct : 0}%"></span></span>
    </button>
    <input type="file" multiple hidden data-upload-input>`
}

// ------------------------------------------------- the workspace's section --
export function filesSectionHtml (d) {
  const root = foldersOf(d).filter((f) => f.folder === '').sort(byName)
  const newest = filesOf(d).filter((f) => f.folder === '').sort(newestFirst).slice(0, NEWEST)
  const count = filesOf(d).length
  const usage = usageText(d)
  const empty = !root.length && !newest.length && !canEdit(d)
  return `
  <section class="sec files-sec" data-files-drop>
    <div class="sec-head"><h2>Files</h2><span class="count">${count}</span>${usage ? `<span class="hint">${esc(usage)}</span>` : ''}<span class="spacer"></span>
      <a href="#" class="sec-link" data-all-files>All files ${I.caret}</a></div>
    ${empty ? '<p class="hint">No files yet.</p>' : `<div class="tiles">
      ${root.map((f) => folderTileHtml(d, f)).join('')}
      ${newest.map((f) => fileTileHtml(d, f, { meta: [whoOf(d, f.uploadedBy), when(f.uploadedAt)].filter(Boolean).join(' · ') })).join('')}
      ${canEdit(d) ? uploadTileHtml(d.workspace.id, 'Upload or drop files') : ''}
    </div>`}
  </section>`
}

/** Drag and drop onto an element: highlights while files hover, uploads them on drop. */
function bindDrop (zone, onFiles) {
  if (!zone) return
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files')
  zone.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    zone.classList.add('files-dragging')
  })
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('files-dragging') })
  zone.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    zone.classList.remove('files-dragging')
    onFiles(e.dataTransfer.files)
  })
}

function bindUpload (root, upload) {
  const input = root.querySelector('[data-upload-input]')
  if (!input) return
  input.onchange = () => { const list = [...input.files]; input.value = ''; upload(list) }
  root.querySelectorAll('[data-upload-tile], [data-upload]').forEach((b) => { b.onclick = () => { if (!progress) input.click() } })
}

export function bindFilesSection (root, { id, reload, go }) {
  const d = state.workspace
  const sec = root.querySelector('[data-files-drop]')
  if (!d || !sec) return
  const open = (patch) => { state.filesView = { ...state.filesView, folder: '', picked: null, ...patch }; go(`wsfiles:${id}`) }
  sec.querySelector('[data-all-files]').onclick = (e) => { e.preventDefault(); open({}) }
  sec.querySelectorAll('[data-folder]').forEach((b) => { b.onclick = () => open({ folder: b.dataset.folder }) })
  sec.querySelectorAll('[data-pick-file]').forEach((b) => {
    b.onclick = () => { const f = filesOf(d).find((x) => x.id === b.dataset.pickFile); if (f) open({ folder: f.folder, picked: f.id }) }
  })
  if (!canEdit(d)) return
  const upload = (list) => startUpload(id, list, '', reload)
  bindUpload(sec, upload)
  bindDrop(sec, upload)
}

// ------------------------------------------------------------- All files --
function crumbsHtml (d, folder) {
  const parts = folder ? folder.split('/') : []
  const crumbs = [`<a href="#" data-folder="">${esc(d.workspace.name)}</a>`]
  parts.forEach((p, i) => {
    const path = parts.slice(0, i + 1).join('/')
    crumbs.push(i === parts.length - 1 ? `<span class="here">${esc(p)}</span>` : `<a href="#" data-folder="${esc(path)}">${esc(p)}</a>`)
  })
  return `<h1 class="crumbs">${crumbs.join('<span class="sep">/</span>')}</h1>`
}

function listHtml (d, folders, files, picked) {
  return `
  <div class="files-scroll"><table class="files-list">
    <thead><tr><th>Name</th><th>Size</th><th>Uploaded by</th><th>Date</th><th>Version</th></tr></thead>
    <tbody>
      ${folders.map((f) => { const s = folderStats(d, f.path); return `<tr class="is-folder" tabindex="0" data-folder="${esc(f.path)}"><td class="nm">${I.folder}<span>${esc(f.name)}</span></td><td>${esc(plural(s.count, 'file', 'files'))}</td><td></td><td></td><td></td></tr>` }).join('')}
      ${files.map((f) => `<tr tabindex="0" data-pick-file="${esc(f.id)}" class="${f.id === picked ? 'on' : ''}"><td class="nm"><span class="badge" style="background:${badgeColor(f)}">${esc(badgeText(f))}</span><span>${esc(f.name)}</span></td><td>${esc(bytes(f.size || 0))}</td><td>${esc(whoOf(d, f.uploadedBy))}</td><td>${esc(f.uploadedAt ? new Date(f.uploadedAt).toLocaleDateString() : '')}</td><td>v${esc(f.version || 1)}</td></tr>`).join('')}
    </tbody>
  </table></div>`
}

// Preview text and tables, cached per file version so the poll's re-render doesn't flicker.
const previewCache = new Map() // `${fid}:${version}` -> html

function previewMediaHtml (d, f) {
  const id = d.workspace.id
  const src = esc(dataUrl(id, f))
  const kind = previewKind(f)
  if (kind === 'image') return `<img src="${src}" alt="${esc(f.name)}">`
  if (kind === 'video') return `<video controls preload="metadata" src="${src}"></video>`
  if (kind === 'audio') return `<audio controls preload="metadata" src="${src}"></audio>`
  if (kind === 'pdf') return `<iframe src="${src}" title="${esc(f.name)}"></iframe>`
  if (kind === 'csv' || kind === 'text') {
    if ((f.size || 0) > MAX_TEXT_PREVIEW) return '<p class="hint">Too big to preview; download it.</p>'
    const cached = previewCache.get(`${f.id}:${f.version}`)
    return cached || `<div class="fp-text" data-preview-load="${kind}"><p class="hint">Loading…</p></div>`
  }
  return '<p class="hint">No preview for this kind of file.</p>'
}

/** Splits CSV text into rows of cells: commas, quoted fields, "" for a quote inside one. */
export function parseCsv (text, maxRows = CSV_ROWS) {
  const rows = []
  let row = []; let cell = ''; let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c !== '"') cell += c
      else if (text[i + 1] === '"') { cell += '"'; i++ } else quoted = false
    } else if (c === '"' && cell === '') quoted = true
    else if (c === ',') { row.push(cell); cell = '' } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
      if (rows.length >= maxRows) return rows
    } else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows
}

const csvTableHtml = (rows) => `<div class="fp-table"><table>${rows.map((r, i) => `<tr>${r.map((c) => (i === 0 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('')}</table></div>`

async function loadPreviewText (root, d, f) {
  const box = root.querySelector('[data-preview-load]')
  if (!box) return
  const kind = box.dataset.previewLoad
  let html
  try {
    const res = await fetch(fileUrl(d.workspace.id, f.id, '/data') + `?v=${encodeURIComponent(f.version || 1)}`, { headers: { 'x-quilt-token': TOKEN || '' } })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Could not load it (${res.status}).`)
    const text = await res.text()
    html = kind === 'csv' ? csvTableHtml(parseCsv(text)) : `<pre class="fp-pre">${esc(text)}</pre>`
    previewCache.set(`${f.id}:${f.version}`, html)
  } catch (err) {
    html = `<p class="hint">${esc(err.message)}</p>`
  }
  if (box.isConnected) box.outerHTML = html
}

function previewHtml (d, f) {
  const edit = canEdit(d)
  const who = whoOf(d, f.uploadedBy)
  return `
  <aside class="file-preview" aria-label="${esc(f.name)}">
    <div class="fp-top"><b class="fp-name" title="${esc(f.path)}">${esc(f.name)}</b><button class="btn sm ghost icon" data-close-preview title="Close" aria-label="Close the preview">${I.x}</button></div>
    <div class="fp-media">${previewMediaHtml(d, f)}</div>
    <div class="fp-meta">${esc(bytes(f.size || 0))} · ${esc(mimeOf(f) || 'unknown type')}<br>${esc([who, when(f.uploadedAt)].filter(Boolean).join(' · '))}</div>
    ${f.note ? `<p class="fp-note">${esc(f.note)}</p>` : ''}
    <div class="fp-acts">
      <a class="btn sm primary" download="${esc(f.name)}" href="${esc(dataUrl(d.workspace.id, f, '&download=1'))}">${I.down}<span>Download</span></a>
      ${edit ? `<button class="btn sm" data-rename>Rename</button><button class="btn sm" data-move>Move</button><button class="btn sm ghost danger" data-delete>Delete</button>` : ''}
    </div>
    <div class="fp-versions" data-versions-box>
      <button class="btn sm ghost" data-versions>Versions${f.version > 1 ? ` (${esc(f.version)})` : ''}</button>
    </div>
  </aside>`
}

export function allFilesHtml (d) {
  const id = String(state.view).slice('wsfiles:'.length)
  if (!d || d.workspace.id !== id) return '<p class="hint">Loading…</p>'
  const fv = state.filesView
  // A folder someone removed (or a stale saved view) falls back to the top.
  if (fv.folder && !foldersOf(d).some((f) => f.path === fv.folder)) fv.folder = ''
  const folders = foldersOf(d).filter((f) => f.folder === fv.folder).sort(byName)
  const files = filesOf(d).filter((f) => f.folder === fv.folder).sort(byName)
  const picked = filesOf(d).find((f) => f.id === fv.picked) || null
  if (!picked) fv.picked = null
  const here = filesOf(d).filter((f) => inside(fv.folder, f.path))
  const usage = usageText(d)
  const edit = canEdit(d)
  const grid = !folders.length && !files.length && !edit ? ''
    : fv.mode === 'list' ? (folders.length || files.length ? listHtml(d, folders, files, fv.picked) : '')
      : `<div class="tiles">
        ${folders.map((f) => folderTileHtml(d, f)).join('')}
        ${files.map((f) => fileTileHtml(d, f, { on: f.id === fv.picked, meta: [bytes(f.size || 0), whoOf(d, f.uploadedBy)].filter(Boolean).join(' · ') })).join('')}
        ${edit ? uploadTileHtml(id, fv.folder ? `Upload to ${fv.folder.split('/').pop()}` : 'Upload or drop files') : ''}
      </div>`
  return `
  <a class="ws-back" href="#" data-ws-open="${esc(id)}">${I.caret} ${esc(d.workspace.name)}</a>
  <header class="files-head">
    <div class="t">${crumbsHtml(d, fv.folder)}<p class="hint">${esc(`${plural(here.length, 'file', 'files')} · ${bytes(here.reduce((n, f) => n + (f.size || 0), 0))}${usage ? ` · ${usage} in this workspace` : ''}`)}</p></div>
    <span class="spacer"></span>
    <div class="segmented files-mode" role="tablist" aria-label="Show as">
      <button type="button" role="tab" data-files-mode="tiles" class="${fv.mode !== 'list' ? 'on' : ''}" aria-selected="${fv.mode !== 'list'}">Tiles</button>
      <button type="button" role="tab" data-files-mode="list" class="${fv.mode === 'list' ? 'on' : ''}" aria-selected="${fv.mode === 'list'}">List</button>
    </div>
    ${edit ? `<button class="btn sm" data-new-folder>${I.plus}<span>Folder</span></button><button class="btn sm primary" data-upload>${I.upload}<span>Upload</span></button>` : ''}
  </header>
  ${fv.mode === 'list' && edit ? `<p class="hint files-progress" data-progress>${uploadingTo(id) ? esc(progressLabel()) : ''}</p><input type="file" multiple hidden data-upload-input>` : ''}
  <div class="files-body${picked ? ' has-preview' : ''}" data-files-drop>
    <div class="files-main">${grid || '<p class="hint">Nothing in this folder yet.</p>'}</div>
    ${picked ? previewHtml(d, picked) : ''}
  </div>`
}

/** `rerender` draws the page again from state (home.js passes renderShell); without it, go(). */
export function bindAllFiles (root, { id, reload, go, rerender = () => go(`wsfiles:${id}`) }) {
  const d = state.workspace
  if (!d || d.workspace.id !== id) return
  const fv = state.filesView
  root.querySelector('[data-ws-open]').onclick = (e) => { e.preventDefault(); go(`ws:${id}`) }
  root.querySelectorAll('[data-folder]').forEach((el) => {
    const open = (e) => { e?.preventDefault(); fv.folder = el.dataset.folder; fv.picked = null; rerender() }
    el.onclick = open
    if (el.tagName === 'TR') el.onkeydown = (e) => { if (e.key === 'Enter') open(e) }
  })
  root.querySelectorAll('[data-pick-file]').forEach((el) => {
    const pick = () => { fv.picked = fv.picked === el.dataset.pickFile ? null : el.dataset.pickFile; rerender() }
    el.onclick = pick
    if (el.tagName === 'TR') el.onkeydown = (e) => { if (e.key === 'Enter') pick() }
  })
  root.querySelectorAll('[data-files-mode]').forEach((b) => { b.onclick = () => { fv.mode = b.dataset.filesMode; rerender() } })
  root.querySelector('[data-close-preview]')?.addEventListener('click', () => { fv.picked = null; rerender() })

  if (canEdit(d)) {
    const upload = (list) => startUpload(id, list, fv.folder, reload)
    bindUpload(root, upload)
    bindDrop(root.querySelector('[data-files-drop]'), upload)
    root.querySelector('[data-new-folder]').onclick = async () => {
      const name = await ask({ title: 'New folder', message: fv.folder ? `Inside ${fv.folder}.` : '', input: { placeholder: 'Name' }, ok: 'Create' })
      if (!name) return
      try { await api('POST', wsUrl(id, '/folders'), { path: fv.folder ? `${fv.folder}/${name}` : name }); await reload() } catch (err) { toast(err.message) }
    }
  }

  const f = filesOf(d).find((x) => x.id === fv.picked)
  if (!f) return
  loadPreviewText(root, d, f)
  const update = async (patch, done) => {
    try { await api('POST', fileUrl(id, f.id, '/update'), patch); toast(done); await reload() } catch (err) { toast(err.message) }
  }
  root.querySelector('[data-rename]')?.addEventListener('click', async () => {
    const name = await ask({ title: `Rename ${f.name}`, input: { label: 'Name', value: f.name }, ok: 'Rename' })
    if (!name || name === f.name) return
    await update({ path: f.folder ? `${f.folder}/${name}` : name }, 'Renamed')
  })
  root.querySelector('[data-move]')?.addEventListener('click', async () => {
    // A select of the folders there are: '/' stands for the top, since ask() wants a value.
    const options = [{ value: '/', label: d.workspace.name }, ...foldersOf(d).map((x) => ({ value: x.path, label: x.path })).sort((a, b) => a.label.localeCompare(b.label))]
    const to = await ask({ title: `Move ${f.name} to`, input: { label: 'Folder', select: options, value: f.folder || '/' }, ok: 'Move' })
    if (!to) return
    const folder = to === '/' ? '' : to
    if (folder === f.folder) return
    fv.folder = folder
    await update({ path: folder ? `${folder}/${f.name}` : f.name }, 'Moved')
  })
  root.querySelector('[data-delete]')?.addEventListener('click', async () => {
    if (!await ask({ title: `Delete ${f.name}?`, message: 'It goes for everyone in this workspace, with its earlier versions.', ok: 'Delete', danger: true })) return
    try { await api('POST', fileUrl(id, f.id, '/delete')); fv.picked = null; toast('Deleted'); await reload() } catch (err) { toast(err.message) }
  })
  root.querySelector('[data-versions]')?.addEventListener('click', async (e) => {
    const box = root.querySelector('[data-versions-box]')
    e.currentTarget.disabled = true
    try {
      // The list holds the earlier versions; the one people get now is the file itself.
      const { versions: earlier } = await api('GET', fileUrl(id, f.id, '/versions'))
      const versions = [f, ...earlier.filter((v) => v.version !== f.version)]
      box.innerHTML = `<b>Versions</b>${versions.map((v) => `
        <div class="fp-version"><span class="mono">v${esc(v.version)}</span><span class="grow">${esc([whoOf(d, v.uploadedBy), when(v.uploadedAt), bytes(v.size || 0)].filter(Boolean).join(' · '))}${v.version === f.version ? ' · <b class="cur">current</b>' : ''}${v.note ? `<span class="hint">${esc(v.note)}</span>` : ''}</span>
          <a href="${esc(fileUrl(id, f.id, '/data?t=' + encodeURIComponent(TOKEN || '')) + `&version=${encodeURIComponent(v.version)}&download=1`)}" download="${esc(f.name)}">Download this version</a></div>`).join('')}${earlier.length ? '' : '<p class="hint">No earlier versions.</p>'}`
    } catch (err) { toast(err.message); e.currentTarget.disabled = false }
  })
}

/** True while a preview is playing, so the poll's re-render doesn't restart it. */
export function previewBusy () {
  return [...document.querySelectorAll('.file-preview video, .file-preview audio')].some((m) => !m.paused)
}

// ---------------------------------------------------------------- picker --
/** A dialog to choose one of the workspace's files. Resolves { id, name }, or null. */
export async function workspaceFilePicker (id) {
  let files
  try { files = (await api('GET', wsUrl(id, '/files'))).files.filter((f) => f.kind !== 'folder').sort((a, b) => a.path.localeCompare(b.path)) } catch (err) { toast(err.message); return null }
  return new Promise((resolve) => {
    const back = document.createElement('div')
    back.className = 'modal-back'
    back.innerHTML = `<div class="card modal file-picker" role="dialog" aria-modal="true" aria-labelledby="fpk-title">
      <h3 id="fpk-title">Choose a file</h3>
      <input class="input" type="search" placeholder="Search files" aria-label="Search files" data-pick-search>
      <div class="fpk-list" data-pick-list></div>
      <div class="actions"><button type="button" class="btn" data-no>Cancel</button></div>
    </div>`
    document.body.appendChild(back)
    const list = back.querySelector('[data-pick-list]')
    const search = back.querySelector('[data-pick-search]')
    const done = (v) => { back.remove(); resolve(v) }
    const draw = () => {
      const q = search.value.trim().toLowerCase()
      const shown = files.filter((f) => !q || f.path.toLowerCase().includes(q))
      list.innerHTML = shown.length
        ? shown.map((f) => `<button type="button" class="fpk-row" data-pick="${esc(f.id)}"><span class="badge" style="background:${badgeColor(f)}">${esc(badgeText(f))}</span><span class="grow">${esc(f.path)}</span><span class="hint">${esc(bytes(f.size || 0))}</span></button>`).join('')
        : `<p class="hint">${files.length ? 'No file matches.' : 'This workspace has no files yet.'}</p>`
    }
    draw()
    search.oninput = draw
    search.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); list.querySelector('[data-pick]')?.click() } }
    list.onclick = (e) => {
      const b = e.target.closest('[data-pick]')
      const f = b && files.find((x) => x.id === b.dataset.pick)
      if (f) done({ id: f.id, name: f.name })
    }
    back.addEventListener('mousedown', (e) => { if (e.target === back) done(null) })
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null) })
    back.querySelector('[data-no]').onclick = () => done(null)
    search.focus()
  })
}
