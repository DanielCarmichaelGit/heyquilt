// A workspace's file library: the index in Postgres, the bytes behind signed links.
// Behind the QUILT_WORKSPACES flag like the other workspace routes: off, each answers 404.
import { HttpError, needId } from '../http.js'
import { workspaceReach } from '../workspace-reach.js'
import { cleanFilePath, parentOf, nameOf, mimeOf } from '../file-paths.js'
import { LINK_MS } from '../file-store.js'

const MAX_NOTE = 300
const UNCONFIRMED_MS = 60 * 60 * 1000
export const DELETED_KEEP_MS = 30 * 24 * 60 * 60 * 1000
const KEEP_VERSIONS = 10

export const fileView = (f) => ({ id: f.id, path: f.path, name: nameOf(f.path), folder: parentOf(f.path), kind: f.kind, size: f.size, mime: f.mime, sha256: f.sha256, version: f.version, note: f.note, uploadedBy: f.uploadedBy, uploadedAt: f.uploadedAt, confirmedAt: f.confirmedAt })
/** Live rows people see: folders, and files whose current version landed. */
export const listed = (rows) => rows.filter((f) => f.kind === 'folder' || f.confirmedAt)

/** A workspace's storage limit. The API's option is a ceiling on the row's own quota: a
 * smaller server (or a test) can lower every workspace's limit without touching the rows. */
export const quotaOf = (ws, ceiling = Infinity) => Math.min(ws.quotaBytes || Infinity, ceiling ?? Infinity)

/** What a workspace has used and may use, as the app shows it. */
export async function usageView (store, ws, { workspaceQuotaBytes, maxWorkspaceFiles } = {}) {
  const { usedBytes, fileCount } = await store.workspaceUsage(ws.id)
  return { usedBytes, quotaBytes: quotaOf(ws, workspaceQuotaBytes), fileCount, maxFiles: maxWorkspaceFiles }
}

export function workspaceFileRoutes (ctx) {
  const { store, now, files: fileStore, apiUrl, maxFileBytes, workspaceQuotaBytes, maxWorkspaceFiles, workspaces = false, log = () => {} } = ctx
  const { reach } = workspaceReach(ctx)
  const gated = (fn) => async (...a) => { if (!workspaces) throw new HttpError(404, 'not found'); return fn(...a) }
  const cleanNote = (v) => { const s = String(v ?? '').trim(); if (s.length > MAX_NOTE) throw new HttpError(400, `Keep the note under ${MAX_NOTE} characters.`); return s }
  const cleanFilePathOrRoot = (v) => (String(v) === '' ? '' : cleanFilePath(v))
  const apiHost = new URL(apiUrl).host
  // The disk store's links are paths on this API. They point at the address the caller
  // used (a local or test API listens on a port the configured apiUrl doesn't know), or at
  // apiUrl itself when that is the address, since it carries the https scheme a proxy hides.
  // Storage links (Supabase) are absolute already and pass through.
  const absolute = (url, req) => {
    if (!url.startsWith('/')) return url
    const host = String(req.headers.host || '')
    return (!host || host === apiHost ? apiUrl : `http://${host}`) + url
  }

  async function fileIn (r, id) {
    const f = await store.workspaceFileById(needId(id, 'file'))
    if (!f || f.workspaceId !== r.ws.id || f.deletedAt) throw new HttpError(404, 'no such file')
    return f
  }
  const needEdit = (r) => { if (r.access.access !== 'edit') throw new HttpError(403, 'you can only view this workspace') }

  async function refreshUsage (wsId) {
    const u = await store.workspaceUsage(wsId)
    await store.setWorkspaceUsage(wsId, u)
    return u
  }

  /** Makes every missing folder on the way to `p` (not `p` itself). */
  async function ensureFolders (ws, p, by) {
    const parts = p.split('/').slice(0, -1)
    for (let i = 1; i <= parts.length; i++) {
      const fp = parts.slice(0, i).join('/')
      const row = await store.workspaceFileByPath(ws.id, fp)
      if (row && row.kind !== 'folder') throw new HttpError(409, `${fp} is a file, not a folder`)
      if (!row) await store.createWorkspaceFile({ workspaceId: ws.id, path: fp, kind: 'folder', uploadedBy: by })
    }
  }

  async function removeKeys (keys) {
    if (!keys.length) return
    try { await fileStore.remove(keys) } catch (err) { log(`file store: ${err.message}`) }
  }

  /** Undoes an upload that never landed: a re-upload goes back to the version before it;
   * a new file is forgotten. Either way the failed upload's object is removed. */
  async function abandon (f) {
    await removeKeys([f.objectKey].filter(Boolean))
    if ((await store.listWorkspaceFileVersions(f.id)).length) return store.revertWorkspaceFileVersion(f.id)
    await store.removeWorkspaceFile(f.id)
    return null
  }

  /** Forgets uploads that never landed, and removes deleted files past their keep time. */
  async function sweep (at = now()) {
    const touched = new Set()
    for (const f of await store.unconfirmedWorkspaceFiles(at - UNCONFIRMED_MS)) {
      await abandon(f)
      touched.add(f.workspaceId)
    }
    for (const wsId of touched) await refreshUsage(wsId)
    await removeKeys(await store.sweepDeletedWorkspaceFiles(at - DELETED_KEEP_MS))
  }

  const routes = [
    ['GET', /^\/v1\/workspaces\/([^/]+)\/files$/, gated(async (req, body, [id]) => {
      const r = await reach(req, id)
      const folder = new URL(req.url, 'http://x').searchParams.get('folder')
      let rows = listed(await store.listWorkspaceFiles(r.ws.id))
      if (folder !== null) { const want = cleanFilePathOrRoot(folder); rows = rows.filter((f) => parentOf(f.path) === want) }
      return { files: rows.map(fileView) }
    })],

    // Starts an upload: the row now, the bytes straight to storage through the link, then /done.
    ['POST', /^\/v1\/workspaces\/([^/]+)\/files$/, gated(async (req, body, [id]) => {
      const r = await reach(req, id)
      needEdit(r)
      const p = cleanFilePath(body.path)
      const size = Number(body.size)
      if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, 'Say how many bytes the file is.')
      if (size > maxFileBytes) throw new HttpError(413, 'file too large')
      const note = cleanNote(body.note)
      const mime = String(body.mime || '') || mimeOf(nameOf(p))
      const sha256 = String(body.sha256 || '').slice(0, 64)
      let existing = await store.workspaceFileByPath(r.ws.id, p)
      if (existing && existing.kind === 'folder') throw new HttpError(409, `${p} is a folder`)
      // An earlier upload to this path that never landed (a retry after a dropped
      // connection): undo it first, so it leaves no phantom version or bytes behind.
      if (existing && !existing.confirmedAt) existing = await abandon(existing)
      const usage = await store.workspaceUsage(r.ws.id)
      if (!existing && usage.fileCount >= maxWorkspaceFiles) throw new HttpError(413, 'this workspace has too many files')
      if (usage.usedBytes + size > quotaOf(r.ws, workspaceQuotaBytes)) throw new HttpError(413, 'this workspace has used its storage')
      await ensureFolders(r.ws, p, r.me.account)
      let file
      if (existing) {
        const v = await store.newWorkspaceFileVersion(existing.id, { size, mime, sha256, objectKey: `${r.ws.id}/${existing.id}/${existing.version + 1}`, note, uploadedBy: r.me.account, at: now(), keep: KEEP_VERSIONS })
        file = v.file
        await removeKeys(v.droppedKeys)
      } else {
        // The object key holds the file's id, so it is set once the row exists.
        file = await store.createWorkspaceFile({ workspaceId: r.ws.id, path: p, kind: 'file', size, mime, sha256, note, uploadedBy: r.me.account })
        file = await store.setWorkspaceFileObjectKey(file.id, `${r.ws.id}/${file.id}/1`)
      }
      const upload = await fileStore.uploadTarget(file.objectKey, size)
      return { file: fileView(file), upload: { ...upload, url: absolute(upload.url, req) } }
    })],

    ['POST', /^\/v1\/workspaces\/([^/]+)\/files\/([^/]+)\/done$/, gated(async (req, body, [id, fid]) => {
      const r = await reach(req, id)
      needEdit(r)
      const f = await fileIn(r, fid)
      if (f.kind !== 'file') throw new HttpError(404, 'no such file')
      const there = await fileStore.exists(f.objectKey)
      if (!there) throw new HttpError(409, 'the upload did not land')
      const file = await store.confirmWorkspaceFile(f.id, { size: there.size, at: now() })
      await refreshUsage(r.ws.id)
      return { file: fileView(file) }
    })],

    ['GET', /^\/v1\/workspaces\/([^/]+)\/files\/([^/]+)\/download$/, gated(async (req, body, [id, fid]) => {
      const r = await reach(req, id)
      const f = await fileIn(r, fid)
      if (f.kind !== 'file') throw new HttpError(400, 'that is a folder')
      const want = new URL(req.url, 'http://x').searchParams.get('version')
      let key = f.objectKey; let size = f.size
      if (want && Number(want) !== f.version) {
        const v = (await store.listWorkspaceFileVersions(f.id)).find((x) => x.version === Number(want))
        if (!v) throw new HttpError(404, 'no such version')
        key = v.objectKey; size = v.size
      } else if (!f.confirmedAt) throw new HttpError(409, 'the upload has not landed yet')
      const name = nameOf(f.path)
      const { url } = await fileStore.downloadTarget(key, { name, type: f.mime })
      return { url: absolute(url, req), expiresAt: now() + LINK_MS, name, mime: f.mime, size }
    })],

    ['GET', /^\/v1\/workspaces\/([^/]+)\/files\/([^/]+)\/versions$/, gated(async (req, body, [id, fid]) => {
      const r = await reach(req, id)
      const f = await fileIn(r, fid)
      return { versions: (await store.listWorkspaceFileVersions(f.id)).map((v) => ({ version: v.version, size: v.size, sha256: v.sha256, note: v.note, uploadedBy: v.uploadedBy, uploadedAt: v.uploadedAt })) }
    })],

    // Renames or moves (a folder takes everything in it), or changes the note.
    ['PATCH', /^\/v1\/workspaces\/([^/]+)\/files\/([^/]+)$/, gated(async (req, body, [id, fid]) => {
      const r = await reach(req, id)
      needEdit(r)
      const f = await fileIn(r, fid)
      const patch = {}
      if (body.note !== undefined) patch.note = cleanNote(body.note)
      if (body.path !== undefined) {
        const p = cleanFilePath(body.path)
        if (p !== f.path) {
          if (f.kind === 'folder' && p.startsWith(f.path + '/')) throw new HttpError(400, 'a folder cannot move into itself')
          if (await store.workspaceFileByPath(r.ws.id, p)) throw new HttpError(409, 'something is already at that path')
          await ensureFolders(r.ws, p, r.me.account)
          if (f.kind === 'folder') await store.renameWorkspaceFolder(r.ws.id, f.path, p, now())
          else patch.path = p
        }
      }
      return { file: fileView(await store.updateWorkspaceFile(f.id, patch)) }
    })],

    // Soft: the bytes stay 30 days (the sweep removes them); a folder takes its contents.
    ['DELETE', /^\/v1\/workspaces\/([^/]+)\/files\/([^/]+)$/, gated(async (req, body, [id, fid]) => {
      const r = await reach(req, id)
      needEdit(r)
      const f = await fileIn(r, fid)
      await store.deleteWorkspaceFile(f.id, now())
      await refreshUsage(r.ws.id)
      return { ok: true }
    })],

    ['POST', /^\/v1\/workspaces\/([^/]+)\/folders$/, gated(async (req, body, [id]) => {
      const r = await reach(req, id)
      needEdit(r)
      const p = cleanFilePath(body.path)
      if (await store.workspaceFileByPath(r.ws.id, p)) throw new HttpError(409, 'something is already at that path')
      await ensureFolders(r.ws, p, r.me.account)
      return { file: fileView(await store.createWorkspaceFile({ workspaceId: r.ws.id, path: p, kind: 'folder', uploadedBy: r.me.account })) }
    })]
  ]

  return { routes, sweep }
}
