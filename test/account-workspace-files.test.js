import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listWorkspaceFiles, createWorkspaceFile, confirmWorkspaceFile, workspaceFileDownload, updateWorkspaceFile, deleteWorkspaceFile, createWorkspaceFolder, listWorkspaceFileVersions } from '../src/account.js'

const fakeFetch = (body) => { const calls = []; const f = async (url, init = {}) => { calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null }); return { ok: true, status: 200, json: async () => body } }; f.calls = calls; return f }

test('the file helpers hit the right routes', async () => {
  const fetch = fakeFetch({ files: [], file: { id: 'f' }, upload: { method: 'PUT', url: 'u' }, url: 'd', versions: [] })
  const o = { token: 't', api: 'https://api.test', fetch, id: 'w1' }
  await listWorkspaceFiles({ ...o, folder: 'cuts' })
  await createWorkspaceFile({ ...o, path: 'a.txt', size: 3, mime: 'text/plain', sha256: 's', note: 'n' })
  await confirmWorkspaceFile({ ...o, fileId: 'f' })
  await workspaceFileDownload({ ...o, fileId: 'f', version: 2 })
  await updateWorkspaceFile({ ...o, fileId: 'f', patch: { path: 'b.txt' } })
  await deleteWorkspaceFile({ ...o, fileId: 'f' })
  await createWorkspaceFolder({ ...o, path: 'raw' })
  await listWorkspaceFileVersions({ ...o, fileId: 'f' })
  assert.deepEqual(fetch.calls.map((c) => [c.method, c.url, c.body]), [
    ['GET', 'https://api.test/v1/workspaces/w1/files?folder=cuts', null],
    ['POST', 'https://api.test/v1/workspaces/w1/files', { path: 'a.txt', size: 3, mime: 'text/plain', sha256: 's', note: 'n' }],
    ['POST', 'https://api.test/v1/workspaces/w1/files/f/done', {}],
    ['GET', 'https://api.test/v1/workspaces/w1/files/f/download?version=2', null],
    ['PATCH', 'https://api.test/v1/workspaces/w1/files/f', { path: 'b.txt' }],
    ['DELETE', 'https://api.test/v1/workspaces/w1/files/f', null],
    ['POST', 'https://api.test/v1/workspaces/w1/folders', { path: 'raw' }],
    ['GET', 'https://api.test/v1/workspaces/w1/files/f/versions', null]
  ])
})
