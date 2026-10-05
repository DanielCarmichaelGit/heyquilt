import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../src/api/memory-store.js'

async function ws (store) { return store.createWorkspace({ ownerUserId: 'u1', name: 'W', createdBy: 'person:u1' }) }

test('files: create, read by id and path, list folders first, duplicates refused', async () => {
  const store = createMemoryStore({ now: () => 1000 })
  const w = await ws(store)
  assert.deepEqual([w.quotaBytes, w.usedBytes, w.fileCount], [5368709120, 0, 0])
  const folder = await store.createWorkspaceFile({ workspaceId: w.id, path: 'cuts', kind: 'folder', uploadedBy: 'person:u1' })
  const f = await store.createWorkspaceFile({ workspaceId: w.id, path: 'cuts/teaser.mp4', kind: 'file', size: 10, mime: 'video/mp4', sha256: 'abc', objectKey: `${w.id}/x/1`, note: 'first', uploadedBy: 'person:u1' })
  assert.deepEqual(f, { id: f.id, workspaceId: w.id, path: 'cuts/teaser.mp4', kind: 'file', size: 10, mime: 'video/mp4', sha256: 'abc', version: 1, objectKey: `${w.id}/x/1`, note: 'first', uploadedBy: 'person:u1', uploadedAt: 1000, confirmedAt: null, deletedAt: null })
  await store.createWorkspaceFile({ workspaceId: w.id, path: 'a.txt', kind: 'file', uploadedBy: 'person:u1' })
  assert.deepEqual((await store.listWorkspaceFiles(w.id)).map((x) => x.path), ['cuts', 'a.txt', 'cuts/teaser.mp4'])
  assert.deepEqual(await store.workspaceFileById(f.id), f)
  assert.deepEqual((await store.workspaceFileByPath(w.id, 'cuts/teaser.mp4')).id, f.id)
  await assert.rejects(store.createWorkspaceFile({ workspaceId: w.id, path: 'cuts/teaser.mp4', kind: 'file', uploadedBy: 'person:u1' }), (e) => e.code === '23505')
  assert.equal(folder.kind, 'folder')
})

test('versions: a new version keeps the old one, at most 10 are kept, confirm sets the size', async () => {
  let t = 1000
  const store = createMemoryStore({ now: () => t })
  const w = await ws(store)
  const f = await store.createWorkspaceFile({ workspaceId: w.id, path: 'a.txt', kind: 'file', size: 1, objectKey: `${w.id}/f/1`, uploadedBy: 'person:u1' })
  await store.confirmWorkspaceFile(f.id, { size: 1, at: 1001 })
  let dropped = []
  for (let v = 2; v <= 12; v++) {
    t = 1000 + v
    const r = await store.newWorkspaceFileVersion(f.id, { size: v, mime: 'text/plain', sha256: `s${v}`, objectKey: `${w.id}/f/${v}`, note: `v${v}`, uploadedBy: 'person:u2', at: t })
    dropped = dropped.concat(r.droppedKeys)
    assert.equal(r.file.version, v)
    assert.equal(r.file.confirmedAt, null)
    await store.confirmWorkspaceFile(f.id, { size: v, at: t })
  }
  const versions = await store.listWorkspaceFileVersions(f.id)
  assert.equal(versions.length, 10)
  assert.deepEqual(versions.map((x) => x.version), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2])
  assert.deepEqual(dropped, [`${w.id}/f/1`])
  const cur = await store.workspaceFileById(f.id)
  assert.deepEqual([cur.version, cur.size, cur.note, cur.uploadedBy, cur.objectKey], [12, 12, 'v12', 'person:u2', `${w.id}/f/12`])
  assert.deepEqual(await store.workspaceUsage(w.id), { usedBytes: 12 + (2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11), fileCount: 1 })
})

test('rename, move a folder, delete (folder takes its contents), sweep and unconfirmed cleanup', async () => {
  const store = createMemoryStore({ now: () => 1000 })
  const w = await ws(store)
  await store.createWorkspaceFile({ workspaceId: w.id, path: 'cuts', kind: 'folder', uploadedBy: 'person:u1' })
  const a = await store.createWorkspaceFile({ workspaceId: w.id, path: 'cuts/a.txt', kind: 'file', objectKey: `${w.id}/a/1`, uploadedBy: 'person:u1' })
  const b = await store.createWorkspaceFile({ workspaceId: w.id, path: 'cuts/b.txt', kind: 'file', objectKey: `${w.id}/b/1`, uploadedBy: 'person:u1' })
  await store.confirmWorkspaceFile(a.id, { size: 1, at: 1000 }); await store.confirmWorkspaceFile(b.id, { size: 1, at: 1000 })
  assert.equal((await store.updateWorkspaceFile(a.id, { path: 'cuts/a2.txt', note: 'renamed' })).path, 'cuts/a2.txt')
  await assert.rejects(store.updateWorkspaceFile(a.id, { path: 'cuts/b.txt' }), (e) => e.code === '23505')
  assert.equal(await store.renameWorkspaceFolder(w.id, 'cuts', 'final', 1500), 3)
  assert.deepEqual((await store.listWorkspaceFiles(w.id)).map((x) => x.path), ['final', 'final/a2.txt', 'final/b.txt'])
  const folder = await store.workspaceFileByPath(w.id, 'final')
  await store.deleteWorkspaceFile(folder.id, 2000)
  assert.deepEqual(await store.listWorkspaceFiles(w.id), [])
  assert.equal((await store.listWorkspaceFiles(w.id, { includeDeleted: true })).length, 3)
  assert.deepEqual((await store.sweepDeletedWorkspaceFiles(1999)), [], 'not old enough')
  assert.deepEqual((await store.sweepDeletedWorkspaceFiles(2001)).sort(), [`${w.id}/a/1`, `${w.id}/b/1`])
  assert.deepEqual(await store.listWorkspaceFiles(w.id, { includeDeleted: true }), [])
  const u = await store.createWorkspaceFile({ workspaceId: w.id, path: 'u.txt', kind: 'file', objectKey: `${w.id}/u/1`, uploadedBy: 'person:u1' })
  assert.deepEqual((await store.unconfirmedWorkspaceFiles(1001)).map((x) => x.id), [u.id])
  await store.removeWorkspaceFile(u.id)
  assert.equal(await store.workspaceFileById(u.id), null)
  await store.setWorkspaceUsage(w.id, { usedBytes: 7, fileCount: 2 })
  assert.deepEqual([(await store.workspaceById(w.id)).usedBytes, (await store.workspaceById(w.id)).fileCount], [7, 2])
})

test('setWorkspaceFileObjectKey round-trips', async () => {
  const store = createMemoryStore({ now: () => 1000 })
  const w = await ws(store)
  const f = await store.createWorkspaceFile({ workspaceId: w.id, path: 'a.txt', kind: 'file', objectKey: `${w.id}/a/1`, uploadedBy: 'person:u1' })
  const out = await store.setWorkspaceFileObjectKey(f.id, `${w.id}/a/2`)
  assert.equal(out.objectKey, `${w.id}/a/2`)
  assert.equal((await store.workspaceFileById(f.id)).objectKey, `${w.id}/a/2`)
})

test('revert after a failed re-upload restores version 1\'s facts and removes the version row', async () => {
  const store = createMemoryStore({ now: () => 1000 })
  const w = await ws(store)
  const f = await store.createWorkspaceFile({ workspaceId: w.id, path: 'a.txt', kind: 'file', size: 1, sha256: 's1', objectKey: `${w.id}/f/1`, note: 'n1', uploadedBy: 'person:u1' })
  await store.confirmWorkspaceFile(f.id, { size: 1, at: 1000 })
  const bumped = await store.newWorkspaceFileVersion(f.id, { size: 2, mime: 'text/plain', sha256: 's2', objectKey: `${w.id}/f/2`, note: 'n2', uploadedBy: 'person:u2', at: 1100 })
  assert.equal(bumped.file.confirmedAt, null)
  // The re-upload never confirmed: revert undoes the bump.
  const reverted = await store.revertWorkspaceFileVersion(f.id)
  assert.deepEqual([reverted.version, reverted.size, reverted.sha256, reverted.objectKey, reverted.note, reverted.uploadedBy, reverted.confirmedAt], [1, 1, 's1', `${w.id}/f/1`, 'n1', 'person:u1', 1000])
  assert.deepEqual(await store.listWorkspaceFileVersions(f.id), [])
  // No earlier version left: the row comes back unchanged.
  const again = await store.revertWorkspaceFileVersion(f.id)
  assert.deepEqual(again, reverted)
})
