// A workspace's file library: the index in Postgres, the bytes behind signed links.
// Behind the QUILT_WORKSPACES flag like the other workspace routes: off, each answers 404.
import { HttpError, needId } from '../http.js'
import { workspaceReach, canSeeFiles } from '../workspace-reach.js'
import { cleanFilePath, parentOf, nameOf, mimeOf } from '../file-paths.js'
import { LINK_MS } from '../file-store.js'

const MAX_NOTE = 300
const UNCONFIRMED_MS = 60 * 60 * 1000
export const DELETED_KEEP_MS = 30 * 24 * 60 * 60 * 1000
const KEEP_VERSIONS = 10

export const fileView = (f) => ({ id: f.id, path: f.path, name: nameOf(f.path), folder: parentOf(f.path), kind: f.kind, size: f.size, mime: f.mime, sha256: f.sha256, version: f.version, note: f.note, uploadedBy: f.uploadedBy, uploadedAt: f.uploadedAt, confirmedAt: f.confirmedAt })
const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

/** The version people get of a file: its current one once that has landed; while a new
 * version is still uploading, the newest earlier one (the row's own facts belong to the
 * pending upload). Null for a file whose first upload hasn't landed. */
async function servedVersion (store, f) {
  if (f.kind !== 'file' || f.confirmedAt) return null
  return (await store.listWorkspaceFileVersions(f.id))[0] || null
}

/** A row as people see it, or null while a new file's first upload hasn't landed. */
export async function viewOf (store, f) {
  if (f.kind === 'folder' || f.confirmedAt) return fileView(f)
  const v = await servedVersion(store, f)
  if (!v) return null
  return { ...fileView(f), version: v.version, size: v.size, sha256: v.sha256, note: v.note, uploadedBy: v.uploadedBy, uploadedAt: v.uploadedAt, confirmedAt: v.uploadedAt }
}

/** Live rows people see, as views: folders, and files with a version that landed. */
export async function listedFiles (store, rows) {
  const views = await Promise.all(rows.map((f) => viewOf(store, f)))
  return views.filter(Boolean)
}

/** A workspace's storage limit. The API's option is a ceiling on the row's own quota: a
 * smaller server (or a test) can lower every workspace's limit without touching the rows.
 * A row with no quota of its own gets the option; a quota of 0 means no storage. */
export const quotaOf = (ws, ceiling = Infinity) => Math.min(ws.quotaBytes ?? ceiling ?? Infinity, ceiling ?? Infinity)

/** What a workspace has used and may use, as the app shows it. */
export async function usageView (store, ws, { workspaceQuotaBytes, maxWorkspaceFiles } = {}) {
  const { usedBytes, fileCount } = await store.workspaceUsage(ws.id)
  return { usedBytes, quotaBytes: quotaOf(ws, workspaceQuotaBytes), fileCount, maxFiles: maxWorkspaceFiles }
}

/** Removes objects from the file store, 100 keys a call (Supabase's limit per remove).
 * A failed batch is logged and the rest still go: a leftover object costs storage, not data. */
export async function removeObjects (fileStore, keys, log = () => {}) {
  for (let i = 0; i < keys.length; i += 100) {
    try { await fileStore.remove(keys.slice(i, i + 100)) } catch (err) { log(`file store: ${err.message}`) }
  }
}

export function workspaceFileRoutes (ctx) {
  const { store, now, files: fileStore, apiUrl, maxFileBytes, workspaceQuotaBytes, maxWorkspaceFiles, workspaces = false, log = () => {} } = ctx
  const { reach: reachWorkspace } = workspaceReach(ctx)
  /** The workspace, for a caller who may see its files; to anyone else the files aren't there. */
  const reach = async (req, id) => {
    const r = await reachWorkspace(req, id)
    if (!canSeeFiles(r.access)) throw new HttpError(404, 'not found')
    return r
  }
  const gated = (fn) => async (...a) => { if (!workspaces) throw new HttpError(404, 'not found'); return fn(...a) }
  const cleanNote = (v) => { const s = String(v ?? '').trim(); if (s.length > MAX_NOTE) throw new HttpError(400, `Keep the note under ${MAX_NOTE} characters.`); return s }
  const cleanFilePathOrRoot = (v) => (String(v) === '' ? '' : cleanFilePath(v))
  // The disk store's links are paths on this API, made absolute on apiUrl. A caller on a
  // loopback address (a local or test API, listening on a port apiUrl doesn't know) gets
  // them on the address it used; any other Host header is ignored, so a forged one can't
  // point links elsewhere. Storage links (Supabase) are absolute already and pass through.
  const absolute = (url, req) => {
    if (!url.startsWith('/')) return url
    const host = String(req.headers.host || '')
    return (LOOPBACK.test(host) ? `http://${host}` : apiUrl) + url
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

  const removeKeys = (keys) => removeObjects(fileStore, keys, log)

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
      let rows = await store.listWorkspaceFiles(r.ws.id)
      if (folder !== null) { const want = cleanFilePathOrRoot(folder); rows = rows.filter((f) => parentOf(f.path) === want) }
      return { files: await listedFiles(store, rows) }
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
      // A type/subtype and nothing else (no parameters, spaces or line breaks), or the one the name suggests.
      const given = String(body.mime || '')
      const mime = given.length <= 100 && MIME.test(given) ? given : mimeOf(nameOf(p))
      const sha256 = String(body.sha256 || '').slice(0, 64)
      let existing = await store.workspaceFileByPath(r.ws.id, p)
      if (existing && existing.kind === 'folder') throw new HttpError(409, `${p} is a folder`)
      // An earlier upload to this path that hasn't landed. Once its link has expired it
      // never will (a dropped connection): undo it, so it leaves no phantom version or bytes
      // behind. Before then someone may still be uploading it: they go first.
      if (existing && !existing.confirmedAt) {
        // The same person may take over their own attempt (a retry after a dropped upload).
        if (existing.uploadedBy !== r.me.account && now() - existing.uploadedAt <= LINK_MS) throw new HttpError(409, 'someone is uploading this file right now; try again in a moment')
        existing = await abandon(existing)
      }
      const usage = await store.workspaceUsage(r.ws.id)
      if (!existing && usage.fileCount >= maxWorkspaceFiles) throw new HttpError(413, 'this workspace has too many files')
      if (usage.usedBytes + size > quotaOf(r.ws, workspaceQuotaBytes)) throw new HttpError(413, 'this workspace has used its storage')
      await ensureFolders(r.ws, p, r.me.account)
      let file
      if (existing) {
        // The version comes from the store (another upload may have got in since `existing`
        // was read), so the object key, which holds it, is set once the store has answered.
        const v = await store.newWorkspaceFileVersion(existing.id, { size, mime, sha256, objectKey: '', note, uploadedBy: r.me.account, at: now(), keep: KEEP_VERSIONS })
        file = await store.setWorkspaceFileObjectKey(existing.id, `${r.ws.id}/${existing.id}/${v.file.version}`)
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
      // Done twice (a client retrying after a lost answer): nothing to do; the checks below
      // would otherwise count the file's own bytes against the quota and abandon a landed file.
      if (f.confirmedAt) return { file: fileView(f) }
      const there = await fileStore.exists(f.objectKey)
      if (!there) throw new HttpError(409, 'the upload did not land')
      // The declared size was checked when the upload started, but storage may hold more
      // (or fewer) bytes than that: check what actually landed, against the same limits.
      // Usage counts confirmed bytes only, so this row's pending upload is not in it yet.
      const usage = await store.workspaceUsage(r.ws.id)
      const refusal = there.size > maxFileBytes ? new HttpError(413, 'file too large')
        : usage.usedBytes + there.size > quotaOf(r.ws, workspaceQuotaBytes) ? new HttpError(413, 'this workspace has used its storage')
          : there.size !== f.size ? new HttpError(409, 'the upload did not match its declared size')
            : null
      if (refusal) {
        await abandon(f)
        await refreshUsage(r.ws.id)
        throw refusal
      }
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
      } else if (!f.confirmedAt) {
        // A new version is still uploading: with no version asked for, serve the one before it.
        const v = !want && await servedVersion(store, f)
        if (!v) throw new HttpError(409, 'the upload has not landed yet')
        key = v.objectKey; size = v.size
      }
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
      // A folder move has already happened, with nothing left to patch: an empty update is
      // an error on Supabase, so read the row back instead.
      const file = Object.keys(patch).length ? await store.updateWorkspaceFile(f.id, patch) : await store.workspaceFileById(f.id)
      return { file: (await viewOf(store, file)) || fileView(file) }
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
