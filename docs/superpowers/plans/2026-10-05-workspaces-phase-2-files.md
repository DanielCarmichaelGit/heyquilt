# Workspaces Phase 2 (Files) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every workspace gets a cloud file library: upload, folders, versions, preview and download in the app, download on the website, and "Attach from workspace" in a session's chat.

**Architecture:** File rows live in Postgres (`workspace_files`, `workspace_file_versions`) behind the accounts API; bytes live in a private Supabase Storage bucket in the Quilt Files project (or on the API's own disk for the memory API and tests), reached only through signed links the API hands out. The desktop app never talks to storage from the renderer (its CSP allows only same-origin): the app's local server (`src/ui-server.js`) receives uploads from the page and streams them to the signed link, and proxies downloads back, so previews are same-origin. The page refetches the open workspace every 20 seconds and after its own actions instead of a realtime subscription. The relay is untouched.

**Tech Stack:** Node 22 ES modules, `node:test`, Postgres/Supabase (SQL migration, supabase-js Storage signed URLs), the app's plain ES-module UI, Next.js website in `web/`.

**Spec:** `docs/superpowers/specs/2026-10-03-workspaces-design.md` ("Decisions" rows Files, Folders, Versions, Limits; "Data model" `workspace_files` and `workspace_file_versions`; "API" file routes; "Desktop app" Files section, All files view, Attach from workspace; "Website" file list; "Error handling"; Phase 2). Mockups: screens 3 and 4 of `docs/superpowers/specs/2026-10-03-workspaces-mockups.html`.

## Global Constraints

- Code style: StandardJS (no semicolons, 2-space indent, single quotes, space before function parens), ES modules, matching the files around it. User-facing text plain, active, no em dashes.
- Limits (defaults, overridable by `startApi` options): `maxFileBytes = 500 * 1024 * 1024`, `workspaceQuotaBytes = 5 * 1024 * 1024 * 1024`, `maxWorkspaceFiles = 2000`, versions kept per path `KEEP_VERSIONS = 10`, deleted files kept `DELETED_KEEP_MS = 30 days`, download links valid `LINK_MS = 10 minutes`.
- Paths: `path` is `folder/name` with `/` separators, 1 to 500 characters, no segment `.` or `..`, no leading or trailing `/`, no control characters, no `\`. A folder is a row with `kind = 'folder'`. Unique among non-deleted rows per workspace.
- Access: anyone with workspace access reads the index and downloads; `edit` uploads, renames, moves, deletes, makes folders; viewers get 403 with a plain message.
- Storage config on the API: `QUILT_STORAGE_URL` and `QUILT_STORAGE_KEY` (the Quilt Files project; same names the relay uses) and `QUILT_STORAGE_WS_BUCKET` (default `workspace-files`). Both unset: files on the API's disk under `QUILT_API_DATA` (default `./quilt-api-data`, a temp dir for `--memory`). Half set is a start-up error.
- Realtime: the app polls (refetch every 20 s while a workspace page is open, and after its own actions). No Supabase Realtime in this phase (ruling: the desktop app has no Supabase session; polling is reversible).
- Previews in the app: image, video, audio, PDF (same-origin iframe), CSV, text and Markdown (up to 2 MB rendered as text). Spreadsheets and everything else show name, size and Download only (ruling: no spreadsheet parser dependency this phase).
- The relay (`src/server.js`, `src/protocol.js`, `src/connection.js`) is not modified. `src/session.js` is not modified (Attach from workspace uses its existing `sendFile`).
- Migrations are additive. Every UI module imported is listed in `STATIC` in `src/ui-server.js`. Every user-visible change gets a bullet under the top section of `RELEASES.md` (Task 9).
- `npm test` from the repo root after every task (baseline 1043 pass / 0 fail / 2 skipped); `cd web && npm test` for website tasks. Commit after every task on the `workspaces` branch, messages ending with a blank line then `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File Structure

- Create `supabase/migrations/20261005000000_workspace_files.sql`: the two tables, quota columns on `workspaces`, sweep function. Create `supabase/files-project/workspace_files_bucket.sql`: the bucket.
- Create `src/api/file-store.js`: `DiskStore`, `SupabaseStore`, `makeFileStore(cfg, dir)`; one interface: `uploadTarget(key, size)`, `downloadTarget(key, { name, type })`, `exists(key)` → `{ size } | null`, `remove(keys)`.
- Create `src/api/file-paths.js`: pure path and name rules: `cleanFilePath`, `parentOf`, `nameOf`, `mimeOf(name)`, `isTextual(mime)`.
- Modify `src/api/memory-store.js`, `src/api/supabase-store.js`: file rows, versions, usage.
- Create `src/api/routes/workspace-files.js`: the file routes. Modify `src/api/routes/workspaces.js`: `GET /v1/workspaces/:id` answers `files` and `usage`; export `reach`-style helpers for the files routes. Modify `src/api/server.js`: `fileStore` option, raw `/v1/file-data/` handler for the disk store, the sweep in `pruneNow`. Modify `bin/quilt.js`, `docs/hosting.md`.
- Modify `src/account.js`: file helpers. Modify `src/ui-server.js`: upload and download proxies and the file actions; `STATIC` gains `files.js`.
- Create `src/ui/files.js`: the Files section tiles, the All files view, previews, upload with progress, the workspace file picker. Modify `src/ui/workspaces.js`, `src/ui/app.js`, `src/ui/home.js`, `src/ui/common.js`, `src/ui/app.css`.
- Modify `src/ui/session.js`: "Attach from workspace" in the composer. Modify `src/ui-server.js`: `POST /api/sessions/:id/attach-from-workspace`.
- Website: create `web/app/api/workspaces/[id]/files/[fileId]/route.js`, `web/components/WorkspaceFiles.js`; modify both `[id]` pages.
- Tests: `test/api-migration-workspace-files.test.js`, `test/api-file-store.test.js`, `test/api-file-paths.test.js`, `test/api-store-workspace-files.test.js`, `test/api-supabase-workspace-files.test.js`, `test/api-workspace-files.test.js`, `test/account-workspace-files.test.js`, `test/ui-workspace-files.test.js`, `test/ui-files-screens.test.js`, `test/ui-attach-from-workspace.test.js`, `web/test/workspace-files.test.js`.

---

### Task 1: Migration and bucket

**Files:**
- Create: `supabase/migrations/20261005000000_workspace_files.sql`, `supabase/files-project/workspace_files_bucket.sql`
- Test: `test/api-migration-workspace-files.test.js`

**Interfaces:**
- Tables `public.workspace_files`, `public.workspace_file_versions`; columns `workspaces.quota_bytes bigint not null default 5368709120`, `workspaces.used_bytes bigint not null default 0`, `workspaces.file_count integer not null default 0`; function `public.sweep_deleted_workspace_files (timestamptz) returns setof text` (the object keys to remove).

- [ ] **Step 1: Write the failing test**

```js
// test/api-migration-workspace-files.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = () => fs.readFileSync(new URL('../supabase/migrations/20261005000000_workspace_files.sql', import.meta.url), 'utf8')
const bucket = () => fs.readFileSync(new URL('../supabase/files-project/workspace_files_bucket.sql', import.meta.url), 'utf8')
const table = (s, name) => (s.match(new RegExp(`create table public\\.${name} \\([\\s\\S]*?\\n\\);`)) || [''])[0]

test('workspace_files and workspace_file_versions, with the columns the spec names', () => {
  const s = sql()
  const f = table(s, 'workspace_files')
  for (const col of ['id uuid primary key default gen_random_uuid()', 'workspace_id uuid not null references public.workspaces (id) on delete cascade', 'path text not null check (char_length(path) between 1 and 500)', "kind text not null check (kind in ('file', 'folder'))", 'size bigint not null default 0', "mime text not null default ''", "sha256 text not null default ''", 'version integer not null default 1', "object_key text not null default ''", "note text not null default '' check (char_length(note) <= 300)", 'uploaded_by text not null', 'uploaded_at timestamptz not null default now()', 'confirmed_at timestamptz', 'deleted_at timestamptz']) assert.ok(f.includes(col), col)
  assert.match(s, /create unique index workspace_files_live_path on public\.workspace_files \(workspace_id, path\) where deleted_at is null;/)
  assert.match(s, /create index workspace_files_workspace_id on public\.workspace_files \(workspace_id, kind, path\);/)
  const v = table(s, 'workspace_file_versions')
  for (const col of ['file_id uuid not null references public.workspace_files (id) on delete cascade', 'version integer not null', 'size bigint not null', 'sha256 text not null', 'object_key text not null', "note text not null default ''", 'uploaded_by text not null', 'uploaded_at timestamptz not null', 'primary key (file_id, version)']) assert.ok(v.includes(col), col)
  for (const col of ['alter table public.workspaces add column quota_bytes bigint not null default 5368709120;', 'alter table public.workspaces add column used_bytes bigint not null default 0;', 'alter table public.workspaces add column file_count integer not null default 0;']) assert.ok(s.includes(col), col)
})

test('additive only, RLS on, service role only', () => {
  const s = sql()
  assert.doesNotMatch(s, /\bdrop\b/i)
  for (const t of ['workspace_files', 'workspace_file_versions']) assert.match(s, new RegExp(`alter table public\\.${t} enable row level security`), t)
  assert.doesNotMatch(s, /create policy/)
  assert.match(s, /revoke all on public\.workspace_files, public\.workspace_file_versions from anon, authenticated;/)
  assert.match(s, /grant all on public\.workspace_files, public\.workspace_file_versions to service_role;/)
  assert.ok(s.includes('revoke execute on function public.sweep_deleted_workspace_files (timestamptz) from public, anon, authenticated;'))
  assert.ok(s.includes('grant execute on function public.sweep_deleted_workspace_files (timestamptz) to service_role;'))
  for (const m of s.matchAll(/create function public\.\w+[\s\S]*?\nas \$\$/g)) assert.match(m[0], /set search_path = ''/)
})

test('the bucket is private with a 500 MB cap', () => {
  const b = bucket()
  assert.match(b, /insert into storage\.buckets \(id, name, public, file_size_limit\)\s*values \('workspace-files', 'workspace-files', false, 524288000\)/)
  assert.match(b, /on conflict \(id\) do nothing/)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/api-migration-workspace-files.test.js`
Expected: FAIL with `ENOENT`.

- [ ] **Step 3: Write the migration and the bucket**

```sql
-- supabase/migrations/20261005000000_workspace_files.sql
-- Workspace files: the library's index. Bytes live in a private bucket in the Quilt Files
-- project (supabase/files-project/workspace_files_bucket.sql); the accounts API is the only
-- reader and writer of these rows and the only signer of links, so row-level security is on
-- with no client policies and no client grants. Additive only.

create table public.workspace_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- 'cuts/teaser-15s.mp4': folders are path prefixes; a folder row has kind 'folder'.
  path text not null check (char_length(path) between 1 and 500),
  kind text not null check (kind in ('file', 'folder')),
  size bigint not null default 0,
  mime text not null default '',
  sha256 text not null default '',
  version integer not null default 1,
  -- '<workspace id>/<file id>/<version>' in the bucket.
  object_key text not null default '',
  note text not null default '' check (char_length(note) <= 300),
  uploaded_by text not null check (uploaded_by ~ '^(person|agent):[A-Za-z0-9_-]{1,64}$'),
  uploaded_at timestamptz not null default now(),
  -- Set once the upload landed; rows never confirmed are removed after an hour.
  confirmed_at timestamptz,
  deleted_at timestamptz
);
create unique index workspace_files_live_path on public.workspace_files (workspace_id, path) where deleted_at is null;
create index workspace_files_workspace_id on public.workspace_files (workspace_id, kind, path);
create index workspace_files_deleted_at on public.workspace_files (deleted_at) where deleted_at is not null;

-- Earlier versions of a path. The current one is the workspace_files row itself.
create table public.workspace_file_versions (
  file_id uuid not null references public.workspace_files (id) on delete cascade,
  version integer not null,
  size bigint not null,
  sha256 text not null,
  object_key text not null,
  note text not null default '',
  uploaded_by text not null,
  uploaded_at timestamptz not null,
  primary key (file_id, version)
);

alter table public.workspaces add column quota_bytes bigint not null default 5368709120;
alter table public.workspaces add column used_bytes bigint not null default 0;
alter table public.workspaces add column file_count integer not null default 0;

alter table public.workspace_files enable row level security;
alter table public.workspace_file_versions enable row level security;
revoke all on public.workspace_files, public.workspace_file_versions from anon, authenticated;
grant all on public.workspace_files, public.workspace_file_versions to service_role;

-- Files deleted before p_before, and their versions: returns the object keys to remove from
-- storage and deletes the rows. The API removes the objects, then calls this.
create function public.sweep_deleted_workspace_files (p_before timestamptz)
returns setof text
language plpgsql
set search_path = ''
as $$
begin
  return query
    with gone as (
      delete from public.workspace_files f where f.deleted_at is not null and f.deleted_at < p_before
      returning f.id, f.object_key
    ), vers as (
      select v.object_key from public.workspace_file_versions v where v.file_id in (select id from gone)
    )
    select object_key from gone where object_key <> ''
    union all
    select object_key from vers;
end;
$$;
revoke execute on function public.sweep_deleted_workspace_files (timestamptz) from public, anon, authenticated;
grant execute on function public.sweep_deleted_workspace_files (timestamptz) to service_role;
```

Note: the `with ... delete ... returning` form reads the versions before the cascade removes them within the same statement; if Postgres refuses the ordering when the migration is applied, replace the body with: select the keys into a temp table first (`create temp table gone on commit drop as select id, object_key from public.workspace_files where deleted_at is not null and deleted_at < p_before;`), then `return query select object_key from gone where object_key <> '' union all select object_key from public.workspace_file_versions where file_id in (select id from gone);` followed by `delete from public.workspace_files where id in (select id from gone);`. The test only checks the function exists with the right name and grants.

```sql
-- supabase/files-project/workspace_files_bucket.sql
-- Workspace libraries. Applied to the separate "Quilt Files" Supabase project
-- (awuikewxoddlryghvknr), never the accounts project. Private: only the accounts API (with
-- its secret key) signs upload and download links, so no policies are needed.
-- 500 MB per file, matching the API's maxFileBytes.
insert into storage.buckets (id, name, public, file_size_limit)
values ('workspace-files', 'workspace-files', false, 524288000)
on conflict (id) do nothing;
```

- [ ] **Step 4: Run the test**

Run: `node --test test/api-migration-workspace-files.test.js test/api-migration-workspaces.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261005000000_workspace_files.sql supabase/files-project/workspace_files_bucket.sql test/api-migration-workspace-files.test.js
git commit -m "Workspace files: migration, bucket and sweep function"
```

---

### Task 2: Path rules and the file store

**Files:**
- Create: `src/api/file-paths.js`, `src/api/file-store.js`
- Modify: `src/api/server.js` (option `fileStore`, raw `/v1/file-data/` handler), `bin/quilt.js` (`apiCmd`: `makeFileStore`), `docs/hosting.md`
- Test: `test/api-file-paths.test.js`, `test/api-file-store.test.js`

**Interfaces:**
- `src/api/file-paths.js`:
  - `cleanFilePath(value) -> string`: trims, collapses `//`, strips leading/trailing `/`, rejects (throws `HttpError(400, …)`) empty, over 500 chars, segments `.`/`..`, `\`, control chars.
  - `parentOf(path) -> string` (`''` at the root), `nameOf(path) -> string`.
  - `mimeOf(name) -> string` from the extension (a small table: png jpg jpeg gif webp svg mp4 webm mov mp3 wav m4a pdf csv txt md json xlsx xls docx zip; default `application/octet-stream`).
  - `isTextual(mime) -> boolean` (`text/*`, `application/json`, csv, markdown).
- `src/api/file-store.js`:
  - `class DiskStore { constructor (dir, { now, signing }) ; uploadTarget(key, size) -> { method: 'PUT', url, headers: {} } ; downloadTarget(key, { name, type }) -> { url } ; exists(key) -> { size } | null ; remove(keys) -> void ; verify(key, method, exp, sig, size) -> boolean ; file(key) -> absolute path }`. URLs are relative: `/v1/file-data/<key>?m=PUT&exp=&sig=&n=<size>` and `/v1/file-data/<key>?m=GET&exp=&sig=&name=&type=`. Keys look like `<uuid>/<uuid>/<n>`; the store refuses keys with `..` or not matching `/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/\d+$/`.
  - `class SupabaseStore { constructor ({ url, key, bucket, client }) ; same methods }` using `createSignedUploadUrl(key, { upsert: false })`, `createSignedUrl(key, LINK_MS / 1000, { download: name })`, `list(prefix)` for `exists`, `remove(keys)`.
  - `makeFileStore(cfg, dir)`: both URL and key → Supabase; neither → Disk under `dir`; half → throw.
  - `LINK_MS = 10 * 60 * 1000`.
- `startApi` gains `fileStore` (default: a `DiskStore` in a fresh temp dir, so tests need nothing) and serves `PUT|GET /v1/file-data/<key>` for a `DiskStore` before the JSON dispatcher (like `/mcp`): PUT streams the body to `store.file(key)` refusing more than the signed `n` bytes (413) and bad signatures (403); GET streams the file with `content-type` from `type`, `content-disposition: attachment; filename="<name>"` when `name` is given, 404 when missing. Both answer with CORS headers like the rest.

- [ ] **Step 1: Write the failing tests**

```js
// test/api-file-paths.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanFilePath, parentOf, nameOf, mimeOf, isTextual } from '../src/api/file-paths.js'

test('cleanFilePath normalises and refuses the bad ones', () => {
  assert.equal(cleanFilePath(' cuts/teaser.mp4 '), 'cuts/teaser.mp4')
  assert.equal(cleanFilePath('/a//b/'), 'a/b')
  for (const bad of ['', '   ', 'a/../b', '.', 'a/./b', 'a\\b', 'a\u0000b', 'x'.repeat(501)]) assert.throws(() => cleanFilePath(bad), /400|path/i, JSON.stringify(bad))
})

test('parentOf and nameOf', () => {
  assert.equal(parentOf('cuts/v1/teaser.mp4'), 'cuts/v1')
  assert.equal(parentOf('teaser.mp4'), '')
  assert.equal(nameOf('cuts/v1/teaser.mp4'), 'teaser.mp4')
})

test('mimeOf and isTextual', () => {
  assert.equal(mimeOf('a.PNG'), 'image/png')
  assert.equal(mimeOf('a.mp4'), 'video/mp4')
  assert.equal(mimeOf('a.md'), 'text/markdown')
  assert.equal(mimeOf('a.csv'), 'text/csv')
  assert.equal(mimeOf('a.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assert.equal(mimeOf('a.unknownext'), 'application/octet-stream')
  assert.equal(isTextual('text/csv'), true)
  assert.equal(isTextual('application/json'), true)
  assert.equal(isTextual('video/mp4'), false)
})
```

```js
// test/api-file-store.test.js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DiskStore, SupabaseStore, makeFileStore, LINK_MS } from '../src/api/file-store.js'
import { startTestApi } from './api-helpers.js'

const KEY = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/1'
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-fstore-'))

test('disk store links are signed, bound to method, key and size, and expire', async () => {
  const store = new DiskStore(tmp())
  const up = await store.uploadTarget(KEY, 4)
  assert.equal(up.method, 'PUT')
  const q = new URL(up.url, 'http://x').searchParams
  assert.ok(up.url.startsWith(`/v1/file-data/${KEY}?`))
  assert.equal(store.verify(KEY, 'PUT', q.get('exp'), q.get('sig'), 4), true)
  assert.equal(store.verify(KEY, 'PUT', q.get('exp'), q.get('sig'), 5), false)
  assert.equal(store.verify(KEY, 'GET', q.get('exp'), q.get('sig'), 4), false)
  assert.equal(store.verify(KEY.replace('/1', '/2'), 'PUT', q.get('exp'), q.get('sig'), 4), false)
  assert.equal(store.verify(KEY, 'PUT', String(Date.now() - 1), q.get('sig'), 4), false)
  const down = await store.downloadTarget(KEY, { name: 'a b.txt', type: 'text/plain' })
  assert.match(down.url, /m=GET/)
  assert.ok(Number(new URL(down.url, 'http://x').searchParams.get('exp')) <= Date.now() + LINK_MS)
  assert.throws(() => store.file('../etc/passwd'), /key/)
})

test('disk store: exists and remove', async () => {
  const store = new DiskStore(tmp())
  assert.equal(await store.exists(KEY), null)
  fs.mkdirSync(path.dirname(store.file(KEY)), { recursive: true })
  fs.writeFileSync(store.file(KEY), 'abcd')
  assert.deepEqual(await store.exists(KEY), { size: 4 })
  await store.remove([KEY])
  assert.equal(await store.exists(KEY), null)
})

test('the API serves disk-store links: PUT within the signed size, GET with name and type, 403 on a bad signature', async () => {
  const dir = tmp()
  const store = new DiskStore(dir)
  const t = await startTestApi({ fileStore: store })
  try {
    const up = await store.uploadTarget(KEY, 4)
    const bad = await fetch(t.api.url + up.url.replace(/sig=[0-9a-f]+/, 'sig=00'), { method: 'PUT', body: 'abcd' })
    assert.equal(bad.status, 403)
    const big = await fetch(t.api.url + up.url, { method: 'PUT', body: 'abcde' })
    assert.equal(big.status, 413)
    assert.equal(await store.exists(KEY), null, 'nothing kept from a refused upload')
    const ok = await fetch(t.api.url + up.url, { method: 'PUT', body: 'abcd' })
    assert.equal(ok.status, 200)
    assert.deepEqual(await store.exists(KEY), { size: 4 })
    const down = await store.downloadTarget(KEY, { name: 'a b.txt', type: 'text/plain' })
    const got = await fetch(t.api.url + down.url)
    assert.equal(got.status, 200)
    assert.equal(got.headers.get('content-type'), 'text/plain')
    assert.equal(got.headers.get('content-disposition'), 'attachment; filename="a b.txt"')
    assert.equal(await got.text(), 'abcd')
    assert.equal((await fetch(t.api.url + (await store.downloadTarget(KEY.replace('/1', '/9'), {})).url)).status, 404)
  } finally { t.close() }
})

test('Supabase store signs through the client and lists for exists', async () => {
  const calls = []
  const from = () => ({
    createSignedUploadUrl: async (k, o) => { calls.push(['up', k, o]); return { data: { signedUrl: 'https://s/up/' + k }, error: null } },
    createSignedUrl: async (k, secs, o) => { calls.push(['down', k, secs, o]); return { data: { signedUrl: 'https://s/down/' + k }, error: null } },
    list: async (prefix, o) => { calls.push(['list', prefix, o]); return { data: [{ name: '1', metadata: { size: 4 } }], error: null } },
    remove: async (keys) => { calls.push(['remove', keys]); return { data: keys.map((k) => ({ name: k })), error: null } }
  })
  const store = new SupabaseStore({ client: { storage: { from } }, bucket: 'workspace-files' })
  assert.deepEqual(await store.uploadTarget(KEY, 4), { method: 'PUT', url: 'https://s/up/' + KEY, headers: {} })
  assert.deepEqual(await store.downloadTarget(KEY, { name: 'a.txt', type: 'text/plain' }), { url: 'https://s/down/' + KEY })
  assert.deepEqual(await store.exists(KEY), { size: 4 })
  await store.remove([KEY])
  assert.deepEqual(calls.map((c) => c[0]), ['up', 'down', 'list', 'remove'])
  assert.deepEqual(calls[1].slice(1), [KEY, LINK_MS / 1000, { download: 'a.txt' }])
})

test('makeFileStore needs both or neither storage settings', () => {
  const dir = tmp()
  assert.ok(makeFileStore({}, dir) instanceof DiskStore)
  assert.throws(() => makeFileStore({ storageUrl: 'https://x' }, dir), /half set up/)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/api-file-paths.test.js test/api-file-store.test.js`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

```js
// src/api/file-paths.js
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
  const raw = stripInvisible(String(value ?? '')).join('').trim()
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) throw new HttpError(400, 'That path has characters a file name cannot have.')
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
```

```js
// src/api/file-store.js
// Where workspace files' bytes live. The API only hands out short-lived links: apps upload
// and download straight to storage (Supabase) or, without storage settings, to the API's
// own disk through signed links the API serves itself.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

export const LINK_MS = 10 * 60 * 1000
const KEY = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/\d+$/

const checkKey = (key) => { if (!KEY.test(String(key))) throw new Error('not a storage key'); return key }

/** Files on the API's disk, reached through HMAC-signed links the API serves (tests, --memory, self-hosting). */
export class DiskStore {
  constructor (dir, { now = Date.now, signing = crypto.randomBytes(32) } = {}) {
    this.dir = dir
    this.now = now
    this.signing = signing
  }

  file (key) { return path.join(this.dir, ...checkKey(key).split('/')) }

  sign (key, method, exp, size) {
    return crypto.createHmac('sha256', this.signing).update(`${method} ${key} ${exp} ${size ?? ''}`).digest('hex')
  }

  verify (key, method, exp, sig, size) {
    if (!KEY.test(String(key)) || !(Number(exp) > this.now())) return false
    const want = Buffer.from(this.sign(key, method, exp, size), 'hex')
    const got = Buffer.from(String(sig || ''), 'hex')
    return got.length === want.length && crypto.timingSafeEqual(got, want)
  }

  async uploadTarget (key, size) {
    checkKey(key)
    const exp = this.now() + LINK_MS
    return { method: 'PUT', url: `/v1/file-data/${key}?m=PUT&exp=${exp}&sig=${this.sign(key, 'PUT', exp, size)}&n=${size}`, headers: {} }
  }

  async downloadTarget (key, { name = '', type = '' } = {}) {
    checkKey(key)
    const exp = this.now() + LINK_MS
    const q = new URLSearchParams({ m: 'GET', exp: String(exp), sig: this.sign(key, 'GET', exp), name, type })
    return { url: `/v1/file-data/${key}?${q}` }
  }

  async exists (key) {
    try { return { size: fs.statSync(this.file(key)).size } } catch { return null }
  }

  async remove (keys) { for (const k of keys) fs.rmSync(this.file(k), { force: true }) }
}

/** Files in a private Supabase Storage bucket in the Quilt Files project. */
export class SupabaseStore {
  constructor ({ url, key, bucket, client }) {
    const c = client || createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    this.bucket = c.storage.from(bucket)
  }

  async uploadTarget (key, size) {
    const { data, error } = await this.bucket.createSignedUploadUrl(checkKey(key), { upsert: false })
    if (error) throw new Error(`storage: ${error.message}`)
    return { method: 'PUT', url: data.signedUrl, headers: {} }
  }

  async downloadTarget (key, { name = '', type = '' } = {}) {
    const { data, error } = await this.bucket.createSignedUrl(checkKey(key), LINK_MS / 1000, name ? { download: name } : {})
    if (error) throw new Error(`storage: ${error.message}`)
    return { url: data.signedUrl }
  }

  async exists (key) {
    checkKey(key)
    const prefix = key.slice(0, key.lastIndexOf('/'))
    const leaf = key.slice(key.lastIndexOf('/') + 1)
    const { data, error } = await this.bucket.list(prefix, { limit: 100, search: leaf })
    if (error) throw new Error(`storage: ${error.message}`)
    const hit = (data || []).find((f) => f.name === leaf)
    return hit ? { size: Number(hit.metadata?.size || 0) } : null
  }

  async remove (keys) {
    if (!keys.length) return
    const { error } = await this.bucket.remove(keys.map(checkKey))
    if (error) throw new Error(`storage: ${error.message}`)
  }
}

export function makeFileStore (cfg, dir) {
  if (!cfg.storageUrl !== !cfg.storageKey) throw new Error('Workspace file storage is half set up: set both QUILT_STORAGE_URL and QUILT_STORAGE_KEY to use Supabase Storage, or neither to keep files on this server\'s disk.')
  if (cfg.storageUrl && cfg.storageKey) return new SupabaseStore({ url: cfg.storageUrl, key: cfg.storageKey, bucket: cfg.storageBucket || 'workspace-files' })
  return new DiskStore(dir)
}
```

In `src/api/server.js`: add `fileStore = null, maxFileBytes = 500 * 1024 * 1024, workspaceQuotaBytes = 5 * 1024 * 1024 * 1024, maxWorkspaceFiles = 2000` to the options; at the top of `startApi`, `const files = fileStore || new DiskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-api-files-')))` (import `DiskStore` from `./file-store.js`, plus `fs`, `os`, `path` if not already imported); put `files, maxFileBytes, workspaceQuotaBytes, maxWorkspaceFiles` into `ctx`. In the request handler, before the `/mcp` line:

```js
      if (pathname.startsWith('/v1/file-data/') && files instanceof DiskStore) return await serveFileData(req, res, send, pathname.slice('/v1/file-data/'.length))
```

and the function (near `proxyMcp`):

```js
  // The disk store's links: PUT streams an upload to the API's disk within the signed size; GET streams it back.
  async function serveFileData (req, res, send, key) {
    const q = new URL(req.url, 'http://x').searchParams
    const method = req.method
    if (!['PUT', 'GET'].includes(method) || q.get('m') !== method) return send(405, { error: 'method not allowed' })
    const size = method === 'PUT' ? Number(q.get('n')) : undefined
    if (!files.verify(key, method, q.get('exp'), q.get('sig'), size)) return send(403, { error: 'this link is not valid' })
    const file = files.file(key)
    if (method === 'PUT') {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.part`
      const out = fs.createWriteStream(tmp)
      let got = 0
      try {
        for await (const chunk of req) {
          got += chunk.length
          if (got > size) throw new HttpError(413, 'more bytes than the link allows')
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
        }
        await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
        fs.renameSync(tmp, file)
        return send(200, { ok: true })
      } catch (err) {
        out.destroy(); fs.rmSync(tmp, { force: true })
        return send(err.status || 500, { error: err.message })
      }
    }
    let stat
    try { stat = fs.statSync(file) } catch { return send(404, { error: 'not found' }) }
    const headers = { 'content-type': q.get('type') || 'application/octet-stream', 'content-length': stat.size, 'cache-control': 'no-store', ...cors(req) }
    if (q.get('name')) headers['content-disposition'] = `attachment; filename="${q.get('name').replace(/["\r\n]/g, '')}"`
    res.writeHead(200, headers)
    fs.createReadStream(file).pipe(res)
  }
```

`bin/quilt.js` `apiCmd`: `const { makeFileStore } = await import('../src/api/file-store.js')`; `fileStore: makeFileStore({ storageUrl: env.QUILT_STORAGE_URL, storageKey: env.QUILT_STORAGE_KEY, storageBucket: env.QUILT_STORAGE_WS_BUCKET }, values.memory ? fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-api-files-')) : path.resolve(env.QUILT_API_DATA || './quilt-api-data'))` in the `startApi` options. `docs/hosting.md`: three rows after `QUILT_WORKSPACES`: `QUILT_STORAGE_URL` / `QUILT_STORAGE_KEY` ("On the accounts API: the Quilt Files project's URL and service key; workspace files are stored there in the `workspace-files` bucket. Both unset: files are kept on the API's disk under `QUILT_API_DATA`."), `QUILT_STORAGE_WS_BUCKET` (default `workspace-files`), `QUILT_API_DATA` (default `./quilt-api-data`).

- [ ] **Step 4: Run the tests**

Run: `node --test test/api-file-paths.test.js test/api-file-store.test.js test/api.test.js test/api-workspaces.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/file-paths.js src/api/file-store.js src/api/server.js bin/quilt.js docs/hosting.md test/api-file-paths.test.js test/api-file-store.test.js
git commit -m "Workspace files: path rules and a file store (disk or Supabase) with signed links"
```

---

### Task 3: Store methods (memory and Supabase)

**Files:**
- Modify: `src/api/memory-store.js` (after `listWorkspaceSessions`), `src/api/supabase-store.js` (constants after `WORKSPACE_MEMBER`; methods after `listWorkspaceSessions`; `WORKSPACE` select gains `quota_bytes, used_bytes, file_count`)
- Test: `test/api-store-workspace-files.test.js`, `test/api-supabase-workspace-files.test.js`

**Interfaces (both stores):**
- Workspace rows now carry `quotaBytes`, `usedBytes`, `fileCount` (memory: defaults `5368709120`, `0`, `0` on create).
- `createWorkspaceFile({ workspaceId, path, kind, size = 0, mime = '', sha256 = '', objectKey = '', note = '', uploadedBy }) -> row` (`version: 1`, `confirmedAt: null`, `deletedAt: null`; throws `duplicate('file')` (code 23505) when a live row has that path).
- `workspaceFileById(id) -> row | null`, `workspaceFileByPath(workspaceId, path) -> live row | null`.
- `listWorkspaceFiles(workspaceId, { includeDeleted = false } = {}) -> row[]` sorted folders first then by path.
- `newWorkspaceFileVersion(id, { size, mime, sha256, objectKey, note, uploadedBy, at }) -> row`: copies the current row into `workspace_file_versions`, bumps `version`, sets the new fields, `confirmedAt: null`. Keeps only the newest `keep` previous versions (`keep` parameter, default 10): returns `{ file, droppedKeys: [objectKey…] }`.
- `listWorkspaceFileVersions(id) -> version[]` newest first.
- `confirmWorkspaceFile(id, { size, at }) -> row` sets `size`, `confirmedAt`.
- `updateWorkspaceFile(id, { path?, note? }) -> row | null` (path unique among live rows; `duplicate` on clash). Moving a folder moves everything under it: `renameWorkspaceFolder(workspaceId, from, to, at) -> number` (rows changed).
- `deleteWorkspaceFile(id, at) -> row`; for a folder also marks every live row under its path deleted.
- `unconfirmedWorkspaceFiles(before) -> row[]` (files with `confirmedAt` null and `uploadedAt < before`); `removeWorkspaceFile(id) -> void` (hard delete, cascades versions).
- `sweepDeletedWorkspaceFiles(before) -> string[]` object keys of files deleted before `before` (and their versions), rows removed.
- `setWorkspaceUsage(workspaceId, { usedBytes, fileCount }) -> void` and `workspaceUsage(workspaceId) -> { usedBytes, fileCount }` computed from live confirmed files (sum of current sizes plus versions' sizes, count of live file rows).

- [ ] **Step 1: Write the failing memory-store test**

```js
// test/api-store-workspace-files.test.js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/api-store-workspace-files.test.js`
Expected: FAIL (`createWorkspaceFile is not a function`).

- [ ] **Step 3: Implement the memory store**

Add maps near the other workspace maps: `const workspaceFiles = new Map(); const workspaceFileVersions = new Map()` (versions keyed `${fileId}\n${version}`). In `createWorkspace` add `quotaBytes: 5368709120, usedBytes: 0, fileCount: 0` to the row. Make `deleteWorkspace` also drop that workspace's file rows and versions. Add after `listWorkspaceSessions`:

```js
    // Workspace files (see 20261005000000_workspace_files.sql).
    async createWorkspaceFile ({ workspaceId, path, kind, size = 0, mime = '', sha256 = '', objectKey = '', note = '', uploadedBy }) {
      if (!workspaces.has(workspaceId)) throw fkViolation('workspace', 'does not exist')
      if (all(workspaceFiles, (f) => f.workspaceId === workspaceId && f.path === path && !f.deletedAt).length) throw duplicate('file')
      const row = { id: uuid(), workspaceId, path, kind, size, mime, sha256, version: 1, objectKey, note, uploadedBy, uploadedAt: now(), confirmedAt: null, deletedAt: null }
      workspaceFiles.set(row.id, row); return copy(row)
    },
    async workspaceFileById (id) { return copy(workspaceFiles.get(id)) },
    async workspaceFileByPath (workspaceId, path) { return copy(all(workspaceFiles, (f) => f.workspaceId === workspaceId && f.path === path && !f.deletedAt)[0]) },
    async listWorkspaceFiles (workspaceId, { includeDeleted = false } = {}) {
      return all(workspaceFiles, (f) => f.workspaceId === workspaceId && (includeDeleted || !f.deletedAt))
        .sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'folder' ? -1 : 1)).map(copy)
    },
    async newWorkspaceFileVersion (id, { size, mime, sha256, objectKey, note = '', uploadedBy, at, keep = 10 }) {
      const f = workspaceFiles.get(id)
      if (!f) return null
      workspaceFileVersions.set(`${id}\n${f.version}`, { fileId: id, version: f.version, size: f.size, sha256: f.sha256, objectKey: f.objectKey, note: f.note, uploadedBy: f.uploadedBy, uploadedAt: f.uploadedAt })
      Object.assign(f, { version: f.version + 1, size, mime, sha256, objectKey, note, uploadedBy, uploadedAt: at, confirmedAt: null })
      const old = all(workspaceFileVersions, (v) => v.fileId === id).sort((a, b) => b.version - a.version).slice(keep)
      for (const v of old) workspaceFileVersions.delete(`${id}\n${v.version}`)
      return { file: copy(f), droppedKeys: old.map((v) => v.objectKey).filter(Boolean) }
    },
    async listWorkspaceFileVersions (id) { return all(workspaceFileVersions, (v) => v.fileId === id).sort((a, b) => b.version - a.version).map(copy) },
    async confirmWorkspaceFile (id, { size, at }) { const f = workspaceFiles.get(id); if (!f) return null; Object.assign(f, { size, confirmedAt: at }); return copy(f) },
    async updateWorkspaceFile (id, { path, note }) {
      const f = workspaceFiles.get(id)
      if (!f) return null
      if (path !== undefined && path !== f.path && all(workspaceFiles, (x) => x.workspaceId === f.workspaceId && x.path === path && !x.deletedAt && x.id !== id).length) throw duplicate('file')
      if (path !== undefined) f.path = path
      if (note !== undefined) f.note = note
      return copy(f)
    },
    // Moves a folder and everything in it: 'cuts' -> 'final' renames 'cuts', 'cuts/a', 'cuts/x/b'.
    async renameWorkspaceFolder (workspaceId, from, to, at) {
      const rows = all(workspaceFiles, (f) => f.workspaceId === workspaceId && !f.deletedAt && (f.path === from || f.path.startsWith(from + '/')))
      for (const f of rows) f.path = to + f.path.slice(from.length)
      return rows.length
    },
    async deleteWorkspaceFile (id, at) {
      const f = workspaceFiles.get(id)
      if (!f) return null
      const rows = f.kind === 'folder' ? all(workspaceFiles, (x) => x.workspaceId === f.workspaceId && !x.deletedAt && (x.id === id || x.path.startsWith(f.path + '/'))) : [f]
      for (const x of rows) x.deletedAt = at
      return copy(f)
    },
    async unconfirmedWorkspaceFiles (before) { return all(workspaceFiles, (f) => f.kind === 'file' && !f.confirmedAt && f.uploadedAt < before).map(copy) },
    async removeWorkspaceFile (id) { workspaceFiles.delete(id); for (const k of [...workspaceFileVersions.keys()]) if (k.startsWith(`${id}\n`)) workspaceFileVersions.delete(k) },
    async sweepDeletedWorkspaceFiles (before) {
      const gone = all(workspaceFiles, (f) => f.deletedAt && f.deletedAt < before)
      const keys = []
      for (const f of gone) {
        if (f.objectKey) keys.push(f.objectKey)
        for (const v of all(workspaceFileVersions, (v) => v.fileId === f.id)) if (v.objectKey) keys.push(v.objectKey)
        await this.removeWorkspaceFile(f.id)
      }
      return keys
    },
    async workspaceUsage (workspaceId) {
      const live = all(workspaceFiles, (f) => f.workspaceId === workspaceId && !f.deletedAt && f.kind === 'file')
      let usedBytes = 0
      for (const f of live) {
        if (f.confirmedAt) usedBytes += f.size
        for (const v of all(workspaceFileVersions, (v) => v.fileId === f.id)) usedBytes += v.size
      }
      return { usedBytes, fileCount: live.length }
    },
    async setWorkspaceUsage (workspaceId, { usedBytes, fileCount }) { const w = workspaces.get(workspaceId); if (w) Object.assign(w, { usedBytes, fileCount }) },
```

(`this.removeWorkspaceFile` works because the returned object is the store; if the file uses a plain object literal without `this`, call the local function form instead: define `const removeFile = (id) => {…}` above and use it in both methods.)

- [ ] **Step 4: Run it, then write the Supabase test**

Run: `node --test test/api-store-workspace-files.test.js test/api-store-workspaces.test.js`
Expected: PASS.

```js
// test/api-supabase-workspace-files.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseStore } from '../src/api/supabase-store.js'

// Records every call; answers come from `answers[table or rpc]`. Same shape as api-supabase-workspaces.test.js.
function fakeClient (answers = {}) {
  const calls = []
  const chain = (table) => {
    const c = { table, ops: [] }
    const q = new Proxy({}, {
      get (_, name) {
        if (name === 'then') return (res, rej) => Promise.resolve(answers[table] ?? { data: null, error: null }).then(res, rej)
        return (...args) => { c.ops.push([name, args]); return q }
      }
    })
    calls.push(c)
    return q
  }
  return { calls, from: (t) => chain(t), rpc: (name, args) => { calls.push({ rpc: name, args }); return Promise.resolve(answers[name] ?? { data: null, error: null }) } }
}

test('createWorkspaceFile inserts snake_case columns and maps the row back', async () => {
  const row = { id: 'f1', workspace_id: 'w1', path: 'a.txt', kind: 'file', size: 0, mime: 'text/plain', sha256: '', version: 1, object_key: 'w1/f1/1', note: '', uploaded_by: 'person:u1', uploaded_at: '2026-10-05T00:00:00.000Z', confirmed_at: null, deleted_at: null }
  const client = fakeClient({ workspace_files: { data: row, error: null } })
  const out = await createSupabaseStore({ client }).createWorkspaceFile({ workspaceId: 'w1', path: 'a.txt', kind: 'file', mime: 'text/plain', objectKey: 'w1/f1/1', uploadedBy: 'person:u1' })
  const ins = client.calls[0].ops.find(([op]) => op === 'insert')[1][0]
  assert.deepEqual(ins, { workspace_id: 'w1', path: 'a.txt', kind: 'file', size: 0, mime: 'text/plain', sha256: '', object_key: 'w1/f1/1', note: '', uploaded_by: 'person:u1' })
  assert.deepEqual([out.id, out.workspaceId, out.objectKey, out.uploadedAt, out.confirmedAt], ['f1', 'w1', 'w1/f1/1', Date.parse(row.uploaded_at), null])
})

test('newWorkspaceFileVersion and sweep go through service-role functions', async () => {
  const client = fakeClient({ new_workspace_file_version: { data: { file: { id: 'f1', version: 2 }, dropped_keys: ['w1/f1/1'] }, error: null }, sweep_deleted_workspace_files: { data: ['w1/a/1'], error: null } })
  const store = createSupabaseStore({ client })
  const r = await store.newWorkspaceFileVersion('f1', { size: 3, mime: 'text/plain', sha256: 's', objectKey: 'w1/f1/2', note: 'n', uploadedBy: 'person:u2', at: Date.parse('2026-10-05T00:00:00.000Z') })
  assert.deepEqual(client.calls[0], { rpc: 'new_workspace_file_version', args: { p_id: 'f1', p_size: 3, p_mime: 'text/plain', p_sha256: 's', p_object_key: 'w1/f1/2', p_note: 'n', p_uploaded_by: 'person:u2', p_at: '2026-10-05T00:00:00.000Z', p_keep: 10 } })
  assert.deepEqual(r, { file: { id: 'f1', version: 2 }, droppedKeys: ['w1/f1/1'] })
  assert.deepEqual(await store.sweepDeletedWorkspaceFiles(Date.parse('2026-10-05T00:00:00.000Z')), ['w1/a/1'])
  assert.deepEqual(client.calls[1], { rpc: 'sweep_deleted_workspace_files', args: { p_before: '2026-10-05T00:00:00.000Z' } })
})
```

The Supabase version bump needs a function so the copy-then-update is one transaction. Add to Task 1's migration (edit it in place; this phase's migration is unapplied) after the sweep function, and add `'new_workspace_file_version (uuid, bigint, text, text, text, text, text, timestamptz, integer)'` and `'rename_workspace_folder (uuid, text, text)'` and `'delete_workspace_file (uuid, timestamptz)'` and `'workspace_usage (uuid)'` to the migration test's revoke/grant checks:

```sql
-- Starts a new version of a file: the current row becomes a version row, the file row takes
-- the new bytes' facts, and only the newest p_keep versions stay. Returns the file and the
-- object keys of versions dropped, for the API to remove from storage.
create function public.new_workspace_file_version (p_id uuid, p_size bigint, p_mime text, p_sha256 text, p_object_key text, p_note text, p_uploaded_by text, p_at timestamptz, p_keep integer default 10)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  f public.workspace_files;
  dropped text[];
begin
  select * into f from public.workspace_files where id = p_id for update;
  if not found then return null; end if;
  insert into public.workspace_file_versions (file_id, version, size, sha256, object_key, note, uploaded_by, uploaded_at)
    values (f.id, f.version, f.size, f.sha256, f.object_key, f.note, f.uploaded_by, f.uploaded_at);
  update public.workspace_files set version = f.version + 1, size = p_size, mime = p_mime, sha256 = p_sha256, object_key = p_object_key, note = p_note, uploaded_by = p_uploaded_by, uploaded_at = p_at, confirmed_at = null
    where id = p_id returning * into f;
  with old as (
    delete from public.workspace_file_versions v where v.file_id = p_id and v.version not in (
      select version from public.workspace_file_versions where file_id = p_id order by version desc limit p_keep)
    returning object_key
  ) select coalesce(array_agg(object_key), '{}') into dropped from old where object_key <> '';
  return jsonb_build_object('file', to_jsonb(f), 'dropped_keys', to_jsonb(dropped));
end;
$$;
revoke execute on function public.new_workspace_file_version (uuid, bigint, text, text, text, text, text, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.new_workspace_file_version (uuid, bigint, text, text, text, text, text, timestamptz, integer) to service_role;

-- Moves a folder and everything under it. Returns how many rows changed.
create function public.rename_workspace_folder (p_workspace uuid, p_from text, p_to text)
returns integer
language plpgsql
set search_path = ''
as $$
declare n integer;
begin
  update public.workspace_files set path = p_to || substr(path, char_length(p_from) + 1)
    where workspace_id = p_workspace and deleted_at is null and (path = p_from or path like p_from || '/%');
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.rename_workspace_folder (uuid, text, text) from public, anon, authenticated;
grant execute on function public.rename_workspace_folder (uuid, text, text) to service_role;

-- Soft-deletes a file, or a folder with everything under it. Returns the row.
create function public.delete_workspace_file (p_id uuid, p_at timestamptz)
returns public.workspace_files
language plpgsql
set search_path = ''
as $$
declare f public.workspace_files;
begin
  select * into f from public.workspace_files where id = p_id;
  if not found then return null; end if;
  if f.kind = 'folder' then
    update public.workspace_files set deleted_at = p_at where workspace_id = f.workspace_id and deleted_at is null and (id = p_id or path like f.path || '/%');
  else
    update public.workspace_files set deleted_at = p_at where id = p_id;
  end if;
  select * into f from public.workspace_files where id = p_id;
  return f;
end;
$$;
revoke execute on function public.delete_workspace_file (uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.delete_workspace_file (uuid, timestamptz) to service_role;

-- Bytes in use (confirmed current files plus every kept version) and live file count.
create function public.workspace_usage (p_workspace uuid)
returns table (used_bytes bigint, file_count integer)
language sql
stable
set search_path = ''
as $$
  select
    coalesce((select sum(size) from public.workspace_files where workspace_id = p_workspace and deleted_at is null and kind = 'file' and confirmed_at is not null), 0)
      + coalesce((select sum(v.size) from public.workspace_file_versions v join public.workspace_files f on f.id = v.file_id where f.workspace_id = p_workspace and f.deleted_at is null), 0),
    (select count(*)::integer from public.workspace_files where workspace_id = p_workspace and deleted_at is null and kind = 'file');
$$;
revoke execute on function public.workspace_usage (uuid) from public, anon, authenticated;
grant execute on function public.workspace_usage (uuid) to service_role;
```

- [ ] **Step 5: Implement the Supabase store**

Constants: `const WORKSPACE_FILE = 'id, workspace_id, path, kind, size, mime, sha256, version, object_key, note, uploaded_by, uploaded_at, confirmed_at, deleted_at'`, `const WORKSPACE_FILE_VERSION = 'file_id, version, size, sha256, object_key, note, uploaded_by, uploaded_at'`; `WORKSPACE` select gains `, quota_bytes, used_bytes, file_count`. Methods:

```js
    // Workspace files (see 20261005000000_workspace_files.sql).
    async createWorkspaceFile ({ workspaceId, path, kind, size = 0, mime = '', sha256 = '', objectKey = '', note = '', uploadedBy }) {
      return rowFrom(await one(db.from('workspace_files').insert({ workspace_id: workspaceId, path, kind, size, mime, sha256, object_key: objectKey, note, uploaded_by: uploadedBy }).select(WORKSPACE_FILE).single()))
    },
    async workspaceFileById (id) { return rowFrom(await one(db.from('workspace_files').select(WORKSPACE_FILE).eq('id', id).maybeSingle())) },
    async workspaceFileByPath (workspaceId, path) { return rowFrom(await one(db.from('workspace_files').select(WORKSPACE_FILE).eq('workspace_id', workspaceId).eq('path', path).is('deleted_at', null).maybeSingle())) },
    async listWorkspaceFiles (workspaceId, { includeDeleted = false } = {}) {
      const rows = await pages(() => { let q = db.from('workspace_files').select(WORKSPACE_FILE).eq('workspace_id', workspaceId).order('kind', { ascending: false }).order('path'); return includeDeleted ? q : q.is('deleted_at', null) })
      return rows.map(rowFrom)
    },
    async newWorkspaceFileVersion (id, { size, mime, sha256, objectKey, note = '', uploadedBy, at, keep = 10 }) {
      const r = await one(db.rpc('new_workspace_file_version', { p_id: id, p_size: size, p_mime: mime, p_sha256: sha256, p_object_key: objectKey, p_note: note, p_uploaded_by: uploadedBy, p_at: ts(at), p_keep: keep }))
      return r ? { file: rowFrom(r.file), droppedKeys: r.dropped_keys || [] } : null
    },
    async listWorkspaceFileVersions (id) { return (await one(db.from('workspace_file_versions').select(WORKSPACE_FILE_VERSION).eq('file_id', id).order('version', { ascending: false }))).map(rowFrom) },
    async confirmWorkspaceFile (id, { size, at }) { return rowFrom(await one(db.from('workspace_files').update({ size, confirmed_at: ts(at) }).eq('id', id).select(WORKSPACE_FILE).maybeSingle())) },
    async updateWorkspaceFile (id, { path, note }) { return rowFrom(await one(db.from('workspace_files').update(toSnake({ path, note })).eq('id', id).select(WORKSPACE_FILE).maybeSingle())) },
    async renameWorkspaceFolder (workspaceId, from, to) { return await one(db.rpc('rename_workspace_folder', { p_workspace: workspaceId, p_from: from, p_to: to })) },
    async deleteWorkspaceFile (id, at) { return rowFrom(await one(db.rpc('delete_workspace_file', { p_id: id, p_at: ts(at) }))) },
    async unconfirmedWorkspaceFiles (before) { return (await one(db.from('workspace_files').select(WORKSPACE_FILE).eq('kind', 'file').is('confirmed_at', null).lt('uploaded_at', ts(before)))).map(rowFrom) },
    async removeWorkspaceFile (id) { await one(db.from('workspace_files').delete().eq('id', id)) },
    async sweepDeletedWorkspaceFiles (before) { return (await one(db.rpc('sweep_deleted_workspace_files', { p_before: ts(before) }))) || [] },
    async workspaceUsage (workspaceId) { const [r] = await one(db.rpc('workspace_usage', { p_workspace: workspaceId })); return { usedBytes: Number(r?.used_bytes || 0), fileCount: Number(r?.file_count || 0) } },
    async setWorkspaceUsage (workspaceId, { usedBytes, fileCount }) { await one(db.from('workspaces').update({ used_bytes: usedBytes, file_count: fileCount }).eq('id', workspaceId)) },
```

Note the memory store's `renameWorkspaceFolder` takes a fourth `at` the Supabase one ignores; keep the signature `(workspaceId, from, to, at)` in both (Supabase ignores `at`). The sorting in `listWorkspaceFiles` ("folders first then by path") relies on `kind` descending (`folder` > `file`); the memory store sorts the same way.

- [ ] **Step 6: Run everything for this task**

Run: `node --test test/api-store-workspace-files.test.js test/api-supabase-workspace-files.test.js test/api-supabase-workspaces.test.js test/api-migration-workspace-files.test.js test/api-store-workspaces.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/api/memory-store.js src/api/supabase-store.js supabase/migrations/20261005000000_workspace_files.sql test/api-store-workspace-files.test.js test/api-supabase-workspace-files.test.js test/api-migration-workspace-files.test.js
git commit -m "Workspace files: store methods, versions and usage in both stores"
```

---

### Task 4: API routes

**Files:**
- Create: `src/api/routes/workspace-files.js`
- Modify: `src/api/routes/workspaces.js` (export `makeReach(ctx)` or move `caller`/`reach` into a shared helper file `src/api/workspace-reach.js` used by both route files; `GET /v1/workspaces/:id` answers `files` and `usage`), `src/api/server.js` (mount; `pruneNow` sweeps)
- Test: `test/api-workspace-files.test.js`

**Interfaces (all gated by the flag like the other workspace routes; `file` views are rows minus `objectKey` plus `name` and `folder`):**

| Method and path | Who | Body / answer |
|---|---|---|
| `GET /v1/workspaces/:id/files?folder=<path>` | reader | `{ files: [view…] }` (all live rows when no folder; with folder, that folder's direct children) |
| `POST /v1/workspaces/:id/files` | edit | `{ path, size, mime?, sha256?, note? }` → `{ file: view, upload: { method, url, headers } }`. 400 bad path/size, 403 viewer, 413 `file too large` / `this workspace has used its storage` / `this workspace has too many files`. Existing live path → a new version of that file (same id). Parent folders are created as folder rows. |
| `POST /v1/workspaces/:id/files/:fileId/done` | edit | `{}` → `{ file: view }`; 409 `the upload did not land` when `exists()` is null; sets size from storage, `confirmedAt`, and recomputes usage |
| `GET /v1/workspaces/:id/files/:fileId/download?version=` | reader | `{ url, expiresAt, name, mime, size }` (relative url from the disk store is resolved to absolute with the API's own `api` base) |
| `PATCH /v1/workspaces/:id/files/:fileId` | edit | `{ path?, note? }` → `{ file: view }`; folders move their contents; 409 on a path clash |
| `DELETE /v1/workspaces/:id/files/:fileId` | edit | `{ ok: true }` (soft; folders take contents) |
| `POST /v1/workspaces/:id/folders` | edit | `{ path }` → `{ file: view }` (409 if it exists) |
| `GET /v1/workspaces/:id/files/:fileId/versions` | reader | `{ versions: [{ version, size, sha256, note, uploadedBy, uploadedAt }] }` |
| `GET /v1/workspaces/:id` | reader | now also `files: [view…]` (live) and `usage: { usedBytes, quotaBytes, fileCount, maxFiles }` |

Object keys: `<workspaceId>/<fileId>/<version>`. `expiresAt = now + LINK_MS`.

- [ ] **Step 1: Write the failing test**

```js
// test/api-workspace-files.test.js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestApi } from './api-helpers.js'
import { DiskStore } from '../src/api/file-store.js'

let t, store
before(async () => {
  store = new DiskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-wsfiles-')))
  t = await startTestApi({ workspaces: true, fileStore: store, maxFileBytes: 100, workspaceQuotaBytes: 250, maxWorkspaceFiles: 4 })
})
after(() => t.close())

async function upload (who, wsId, p, body, extra = {}) {
  const r = await t.call('POST', `/v1/workspaces/${wsId}/files`, { path: p, size: body.length, ...extra }, who)
  if (r.status !== 200) return r
  const put = await fetch(t.api.url + r.body.upload.url, { method: 'PUT', body })
  assert.equal(put.status, 200)
  const done = await t.call('POST', `/v1/workspaces/${wsId}/files/${r.body.file.id}/done`, {}, who)
  return done
}

test('upload, list, download, versions, rename, move folder, delete; viewers read only', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Files' }, 'mem')).body.workspace
  await t.call('PUT', `/v1/workspaces/${w.id}/members/person:lim`, { access: 'view' }, 'mem')
  const made = await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'cuts/teaser.txt', size: 5, note: 'first' }, 'mem')
  assert.equal(made.status, 200, JSON.stringify(made.body))
  assert.deepEqual([made.body.file.path, made.body.file.name, made.body.file.folder, made.body.file.version, made.body.file.mime, made.body.upload.method], ['cuts/teaser.txt', 'teaser.txt', 'cuts', 1, 'text/plain', 'PUT'])
  assert.equal('objectKey' in made.body.file, false)
  const before = await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')
  assert.deepEqual(before.body.files.map((f) => [f.path, f.kind]), [['cuts', 'folder']], 'unconfirmed uploads are not listed; the parent folder is')
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/files/${made.body.file.id}/done`, {}, 'mem')).status, 409, 'nothing landed yet')
  assert.equal((await fetch(t.api.url + made.body.upload.url, { method: 'PUT', body: 'hello' })).status, 200)
  const done = await t.call('POST', `/v1/workspaces/${w.id}/files/${made.body.file.id}/done`, {}, 'mem')
  assert.deepEqual([done.status, done.body.file.size], [200, 5])
  const got = await t.call('GET', `/v1/workspaces/${w.id}`, null, 'lim')
  assert.deepEqual(got.body.files.map((f) => f.path), ['cuts', 'cuts/teaser.txt'])
  assert.deepEqual(got.body.usage, { usedBytes: 5, quotaBytes: 250, fileCount: 1, maxFiles: 4 })
  const inFolder = await t.call('GET', `/v1/workspaces/${w.id}/files?folder=cuts`, null, 'lim')
  assert.deepEqual(inFolder.body.files.map((f) => f.name), ['teaser.txt'])
  const dl = await t.call('GET', `/v1/workspaces/${w.id}/files/${made.body.file.id}/download`, null, 'lim')
  assert.deepEqual([dl.status, dl.body.name, dl.body.mime, dl.body.size], [200, 'teaser.txt', 'text/plain', 5])
  assert.ok(dl.body.url.startsWith(t.api.url + '/v1/file-data/'))
  assert.equal(await (await fetch(dl.body.url)).text(), 'hello')
  // A viewer cannot write.
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'x.txt', size: 1 }, 'lim')).status, 403)
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}/files/${made.body.file.id}`, null, 'lim')).status, 403)
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}/files`, null, 'out')).status, 404)
  // A second upload to the same path is a new version.
  const v2 = await upload('mem', w.id, 'cuts/teaser.txt', 'hello world', { note: 'longer' })
  assert.deepEqual([v2.status, v2.body.file.id, v2.body.file.version, v2.body.file.size, v2.body.file.note], [200, made.body.file.id, 2, 11, 'longer'])
  const vs = await t.call('GET', `/v1/workspaces/${w.id}/files/${made.body.file.id}/versions`, null, 'lim')
  assert.deepEqual(vs.body.versions.map((v) => [v.version, v.size, v.note]), [[1, 5, 'first']])
  const old = await t.call('GET', `/v1/workspaces/${w.id}/files/${made.body.file.id}/download?version=1`, null, 'lim')
  assert.equal(await (await fetch(old.body.url)).text(), 'hello')
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')).body.usage.usedBytes, 16)
  // Rename, move a folder, make a folder, delete.
  assert.equal((await t.call('PATCH', `/v1/workspaces/${w.id}/files/${made.body.file.id}`, { path: 'cuts/final.txt' }, 'mem')).body.file.name, 'final.txt')
  const folder = got.body.files.find((f) => f.kind === 'folder')
  assert.equal((await t.call('PATCH', `/v1/workspaces/${w.id}/files/${folder.id}`, { path: 'done' }, 'mem')).status, 200)
  assert.deepEqual((await t.call('GET', `/v1/workspaces/${w.id}/files`, null, 'mem')).body.files.map((f) => f.path), ['done', 'done/final.txt'])
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/folders`, { path: 'done' }, 'mem')).status, 409)
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/folders`, { path: 'raw' }, 'mem')).body.file.kind, 'folder')
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}/files/${folder.id}`, null, 'mem')).status, 200)
  assert.deepEqual((await t.call('GET', `/v1/workspaces/${w.id}/files`, null, 'mem')).body.files.map((f) => f.path), ['raw'])
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')).body.usage.usedBytes, 0)
})

test('limits: file size, workspace quota, file count, bad paths', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Limits' }, 'mem')).body.workspace
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'big.bin', size: 101 }, 'mem')).status, 413)
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: '../x', size: 1 }, 'mem')).status, 400)
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'x', size: 0 }, 'mem')).status, 400)
  for (const n of [1, 2, 3]) assert.equal((await upload('mem', w.id, `f${n}.txt`, 'x'.repeat(80))).status, 200)
  const r = await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'f4.txt', size: 20 }, 'mem')
  assert.deepEqual([r.status, r.body.error], [413, 'this workspace has used its storage'])
  assert.equal((await upload('mem', w.id, 'f4.txt', 'y')).status, 200)
  const r5 = await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'f5.txt', size: 1 }, 'mem')
  assert.deepEqual([r5.status, r5.body.error], [413, 'this workspace has too many files'])
})

test('unconfirmed uploads are forgotten after an hour and deleted files swept after 30 days', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Sweep' }, 'mem')).body.workspace
  const stale = (await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'never.txt', size: 1 }, 'mem')).body.file
  const gone = await upload('mem', w.id, 'gone.txt', 'z')
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}/files/${gone.body.file.id}`, null, 'mem')).status, 200)
  await t.api.sweepFiles(Date.now() + 61 * 60 * 1000)
  assert.equal(await t.store.workspaceFileById(stale.id), null)
  assert.ok(await t.store.workspaceFileById(gone.body.file.id), 'kept 30 days')
  await t.api.sweepFiles(Date.now() + 31 * 24 * 60 * 60 * 1000)
  assert.equal(await t.store.workspaceFileById(gone.body.file.id), null)
  assert.equal(await store.exists(`${w.id}/${gone.body.file.id}/1`), null, 'bytes removed from storage')
})
```

`startApi` returns `{ url, port, close, … }`; add `sweepFiles(at)` to it (a method that runs the two sweeps as of `at`), used by tests and by `pruneNow`.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/api-workspace-files.test.js`
Expected: FAIL (404s).

- [ ] **Step 3: Implement**

Move `caller`, `grantsIn`, `reach`, `nameOf`, `kindOf` out of `src/api/routes/workspaces.js` into `src/api/workspace-reach.js` as `export function workspaceReach (ctx) { … return { caller, grantsIn, reach, nameOf, kindOf } }` and have `workspaceRoutes` use it (no behaviour change; the existing tests must still pass). Then:

```js
// src/api/routes/workspace-files.js
// A workspace's file library: the index in Postgres, the bytes behind signed links.
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

export function workspaceFileRoutes (ctx) {
  const { store, now, files: fileStore, apiUrl, maxFileBytes, workspaceQuotaBytes, maxWorkspaceFiles, workspaces, log } = ctx
  const { reach } = workspaceReach(ctx)
  const gated = (fn) => async (...a) => { if (!workspaces) throw new HttpError(404, 'not found'); return fn(...a) }
  const cleanNote = (v) => { const s = String(v ?? '').trim(); if (s.length > MAX_NOTE) throw new HttpError(400, `Keep the note under ${MAX_NOTE} characters.`); return s }
  const absolute = (url) => (url.startsWith('/') ? apiUrl + url : url)

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
  const usageView = async (ws) => ({ ...(await store.workspaceUsage(ws.id)), quotaBytes: ws.quotaBytes ?? workspaceQuotaBytes, maxFiles: maxWorkspaceFiles })

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

  async function removeKeys (keys) { try { await fileStore.remove(keys) } catch (err) { log(`file store: ${err.message}`) } }

  /** Forgets uploads that never landed, and removes deleted files past their keep time. */
  async function sweep (at = now()) {
    for (const f of await store.unconfirmedWorkspaceFiles(at - UNCONFIRMED_MS)) {
      // A re-upload (new version) that never landed: put the previous version back rather than lose the file.
      const versions = await store.listWorkspaceFileVersions(f.id)
      if (versions.length) {
        const prev = versions[0]
        await store.confirmWorkspaceFile(f.id, { size: prev.size, at: prev.uploadedAt })
        await store.updateWorkspaceFile(f.id, { note: prev.note })
        // The current object key belongs to the failed upload; the row keeps the previous one.
        await store.newWorkspaceFileVersion === undefined // no-op guard for the memory store
        await removeKeys([f.objectKey].filter(Boolean))
        continue
      }
      await removeKeys([f.objectKey].filter(Boolean))
      await store.removeWorkspaceFile(f.id)
    }
    const keys = await store.sweepDeletedWorkspaceFiles(at - DELETED_KEEP_MS)
    if (keys.length) await removeKeys(keys)
  }

  const routes = [
    ['GET', /^\/v1\/workspaces\/([^/]+)\/files$/, gated(async (req, body, [id]) => {
      const r = await reach(req, id)
      const folder = new URL(req.url, 'http://x').searchParams.get('folder')
      let rows = listed(await store.listWorkspaceFiles(r.ws.id))
      if (folder !== null) rows = rows.filter((f) => parentOf(f.path) === cleanFilePathOrRoot(folder))
      return { files: rows.map(fileView) }
    })],

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
      const usage = await store.workspaceUsage(r.ws.id)
      const existing = await store.workspaceFileByPath(r.ws.id, p)
      if (existing && existing.kind === 'folder') throw new HttpError(409, `${p} is a folder`)
      if (!existing && usage.fileCount >= maxWorkspaceFiles) throw new HttpError(413, 'this workspace has too many files')
      if (usage.usedBytes + size > (r.ws.quotaBytes ?? workspaceQuotaBytes)) throw new HttpError(413, 'this workspace has used its storage')
      await ensureFolders(r.ws, p, r.me.account)
      let file
      if (existing) {
        const v = await store.newWorkspaceFileVersion(existing.id, { size, mime, sha256, objectKey: `${r.ws.id}/${existing.id}/${existing.version + 1}`, note, uploadedBy: r.me.account, at: now(), keep: KEEP_VERSIONS })
        file = v.file
        if (v.droppedKeys.length) await removeKeys(v.droppedKeys)
      } else {
        file = await store.createWorkspaceFile({ workspaceId: r.ws.id, path: p, kind: 'file', size, mime, sha256, note, uploadedBy: r.me.account })
        file = await store.updateWorkspaceFile(file.id, {}) // keep shape; objectKey set below
        file = await setObjectKey(file, `${r.ws.id}/${file.id}/1`)
      }
      const upload = await fileStore.uploadTarget(file.objectKey, size)
      return { file: fileView(file), upload: { ...upload, url: absolute(upload.url) } }
    })],

    ['POST', /^\/v1\/workspaces\/([^/]+)\/files\/([^/]+)\/done$/, gated(async (req, body, [id, fid]) => {
      const r = await reach(req, id)
      needEdit(r)
      const f = await store.workspaceFileById(needId(fid, 'file'))
      if (!f || f.workspaceId !== r.ws.id || f.deletedAt || f.kind !== 'file') throw new HttpError(404, 'no such file')
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
      const { url } = await fileStore.downloadTarget(key, { name: nameOf(f.path), type: f.mime })
      return { url: absolute(url), expiresAt: now() + LINK_MS, name: nameOf(f.path), mime: f.mime, size }
    })],

    ['GET', /^\/v1\/workspaces\/([^/]+)\/files\/([^/]+)\/versions$/, gated(async (req, body, [id, fid]) => {
      const r = await reach(req, id)
      const f = await fileIn(r, fid)
      return { versions: (await store.listWorkspaceFileVersions(f.id)).map((v) => ({ version: v.version, size: v.size, sha256: v.sha256, note: v.note, uploadedBy: v.uploadedBy, uploadedAt: v.uploadedAt })) }
    })],

    ['PATCH', /^\/v1\/workspaces\/([^/]+)\/files\/([^/]+)$/, gated(async (req, body, [id, fid]) => {
      const r = await reach(req, id)
      needEdit(r)
      const f = await fileIn(r, fid)
      const patch = {}
      if (body.note !== undefined) patch.note = cleanNote(body.note)
      if (body.path !== undefined) {
        const p = cleanFilePath(body.path)
        if (p !== f.path) {
          const clash = await store.workspaceFileByPath(r.ws.id, p)
          if (clash) throw new HttpError(409, 'something is already at that path')
          if (f.kind === 'folder' && (p === f.path || p.startsWith(f.path + '/'))) throw new HttpError(400, 'a folder cannot move into itself')
          await ensureFolders(r.ws, p, r.me.account)
          if (f.kind === 'folder') await store.renameWorkspaceFolder(r.ws.id, f.path, p, now())
          else patch.path = p
        }
      }
      const file = await store.updateWorkspaceFile(f.id, patch)
      return { file: fileView(file) }
    })],

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

  // Object keys are set after the row exists (they contain the file id). A tiny store method keeps this honest.
  async function setObjectKey (file, objectKey) { return store.setWorkspaceFileObjectKey(file.id, objectKey) }
  const cleanFilePathOrRoot = (v) => (String(v) === '' ? '' : cleanFilePath(v))

  return { routes, sweep, usageView, fileView, listed }
}
```

Clean-ups the executor must make while transcribing: drop the two no-op lines in `sweep` (`await store.newWorkspaceFileVersion === undefined` and the `updateWorkspaceFile(file.id, {})` call); add `setWorkspaceFileObjectKey(id, objectKey) -> row` to both stores (memory: set and copy; Supabase: `update({ object_key }).eq('id', id).select(WORKSPACE_FILE).maybeSingle()`); in `sweep`'s re-upload branch, the row's `objectKey` must go back to the previous version's key and that version row must be removed: add `revertWorkspaceFileVersion(id) -> row` to both stores (memory: take the newest version row, write its size/sha256/objectKey/note/uploadedBy/uploadedAt back into the file row with `version = that.version`, delete the version row, set `confirmedAt` to its `uploadedAt`; Supabase: a service-role function `revert_workspace_file_version (uuid)` added to the migration with the same steps in one transaction, plus the revoke/grant pair and an entry in the migration test). Use it in `sweep` instead of the confirm/update dance, and remove the failed upload's key from storage.

Mount in `src/api/server.js`: `const wsFiles = workspaceFileRoutes({ ...ctx, workspaces })` next to the workspace routes, `routes.push(...wsFiles.routes)`, call `await wsFiles.sweep()` inside `pruneNow` (wrapped in try/catch with `log`), and return `sweepFiles: (at) => wsFiles.sweep(at)` from `startApi`. In `src/api/routes/workspaces.js` `GET /v1/workspaces/:id`: add `files: listed(await store.listWorkspaceFiles(ws.id)).map(fileView)` and `usage: await usageView(ws)` (import `fileView`, `listed` from `./workspace-files.js`; pass `usageView` through ctx or compute inline the same way).

- [ ] **Step 4: Run the tests**

Run: `node --test test/api-workspace-files.test.js test/api-workspaces.test.js test/api-access-workspace.test.js test/api-file-store.test.js test/api-store-workspace-files.test.js test/api-migration-workspace-files.test.js`
Expected: PASS. Then `npm test 2>&1 | tail -6`.

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/workspace-files.js src/api/routes/workspaces.js src/api/workspace-reach.js src/api/server.js src/api/memory-store.js src/api/supabase-store.js supabase/migrations/20261005000000_workspace_files.sql test/api-workspace-files.test.js test/api-migration-workspace-files.test.js
git commit -m "Workspace files: API routes for upload, download, versions, folders and the sweep"
```

---

### Task 5: Account helpers and the app's local routes

**Files:**
- Modify: `src/account.js` (after the workspace helpers), `src/ui-server.js` (`api` map; raw upload and download handlers next to `receiveUpload`; `STATIC` gains `'/files.js'`)
- Test: `test/account-workspace-files.test.js`, `test/ui-workspace-files.test.js`

**Interfaces:**
- `src/account.js`: `listWorkspaceFiles({ token, id, folder? })`, `createWorkspaceFile({ token, id, path, size, mime, sha256, note })` → `{ file, upload }`, `confirmWorkspaceFile({ token, id, fileId })`, `workspaceFileDownload({ token, id, fileId, version? })` → `{ url, expiresAt, name, mime, size }`, `updateWorkspaceFile({ token, id, fileId, patch })`, `deleteWorkspaceFile({ token, id, fileId })`, `createWorkspaceFolder({ token, id, path })`, `listWorkspaceFileVersions({ token, id, fileId })`.
- Local routes (token-protected like the rest):
  - `PUT /api/workspaces/:id/upload` raw body; headers `x-path` (URL-encoded path), `x-note` (URL-encoded, optional), `content-length`. The server writes the body to a temp file, computes sha256 and size, calls `createWorkspaceFile`, streams the temp file to `upload.url` with `fetch(url, { method: 'PUT', body: fs.createReadStream(tmp), duplex: 'half', headers: { 'content-type': mime, 'content-length': size, ...upload.headers } })`, calls `confirmWorkspaceFile`, answers `{ file }`. Errors from the API pass through with their status and message. Rejects bodies over 500 MB (413) before contacting the API.
  - `GET /api/workspaces/:id/files/:fileId/data?version=` streams the bytes: gets the download target, fetches it from Node, pipes with `content-type` from the API's `mime`, `content-length` when known, and `content-disposition: inline; filename="<name>"` (or `attachment` when `?download=1`).
  - `GET /api/workspaces/:id/files?folder=` → `{ files }`; `GET /api/workspaces/:id/files/:fileId/versions` → `{ versions }`; `POST /api/workspaces/:id/files/:fileId/update` `{ path?, note? }`; `POST /api/workspaces/:id/files/:fileId/delete`; `POST /api/workspaces/:id/folders` `{ path }`.

- [ ] **Step 1: Write the failing tests**

```js
// test/account-workspace-files.test.js
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
```

```js
// test/ui-workspace-files.test.js
// The app's local file routes: upload through the local server to the API's store, list, stream back, rename, delete.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ui-wsfiles-'))
process.env.HOME = process.env.USERPROFILE = home
const { startUi } = await import('../src/ui-server.js')
const { startServer } = await import('../src/server.js')
const { startTestApi, linkDevice } = await import('./api-helpers.js')
const { newPassKeys } = await import('../src/passes.js')
const { loadIdentity } = await import('../src/identity.js')
const { saveAccount } = await import('../src/account.js')

let ui, accounts, relay
before(async () => {
  const keys = newPassKeys()
  accounts = await startTestApi({ passKey: keys.privateKey, workspaces: true })
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: keys.publicKey })
  process.env.QUILT_API_URL = accounts.api.url
  process.env.QUILT_SERVER = `ws://127.0.0.1:${relay.port}`
  const { token } = await linkDevice(accounts, 'mem', loadIdentity())
  saveAccount({ token, account: { id: 'mem', name: 'Mo', email: 'mo@acme.com' }, signedInAt: Date.now() })
  ui = await startUi({ port: 0 })
})
after(async () => { await ui.close(); await relay.close(); await accounts.close() })

const base = () => `http://127.0.0.1:${ui.port}`
const api = (method, p, body) => fetch(base() + p, { method, headers: { 'x-quilt-token': ui.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }))

test('upload, list, stream, rename, delete through the app', async () => {
  const id = (await api('POST', '/api/workspaces', { name: 'Lib' })).body.workspace.id
  const up = await fetch(`${base()}/api/workspaces/${id}/upload`, { method: 'PUT', headers: { 'x-quilt-token': ui.token, 'x-path': encodeURIComponent('notes/hello.txt'), 'x-note': encodeURIComponent('first'), 'content-type': 'text/plain' }, body: 'hello there' })
  const made = await up.json()
  assert.equal(up.status, 200, JSON.stringify(made))
  assert.deepEqual([made.file.path, made.file.size, made.file.version, made.file.note], ['notes/hello.txt', 11, 1, 'first'])
  const list = await api('GET', `/api/workspaces/${id}/files`)
  assert.deepEqual(list.body.files.map((f) => [f.path, f.kind]), [['notes', 'folder'], ['notes/hello.txt', 'file']])
  const data = await fetch(`${base()}/api/workspaces/${id}/files/${made.file.id}/data`, { headers: { 'x-quilt-token': ui.token } })
  assert.equal(data.status, 200)
  assert.equal(data.headers.get('content-type'), 'text/plain')
  assert.match(data.headers.get('content-disposition'), /inline; filename="hello.txt"/)
  assert.equal(await data.text(), 'hello there')
  const got = await api('GET', `/api/workspaces/${id}`)
  assert.equal(got.body.files.length, 2)
  assert.equal(got.body.usage.usedBytes, 11)
  assert.equal((await api('POST', `/api/workspaces/${id}/files/${made.file.id}/update`, { path: 'notes/hi.txt' })).body.file.name, 'hi.txt')
  assert.equal((await api('POST', `/api/workspaces/${id}/folders`, { path: 'raw' })).body.file.kind, 'folder')
  assert.equal((await api('POST', `/api/workspaces/${id}/files/${made.file.id}/delete`)).status, 200)
  assert.deepEqual((await api('GET', `/api/workspaces/${id}/files`)).body.files.map((f) => f.path), ['notes', 'raw'])
})

test('an upload the API refuses is reported with its message', async () => {
  const id = (await api('POST', '/api/workspaces', { name: 'Lib2' })).body.workspace.id
  const bad = await fetch(`${base()}/api/workspaces/${id}/upload`, { method: 'PUT', headers: { 'x-quilt-token': ui.token, 'x-path': encodeURIComponent('../evil') }, body: 'x' })
  assert.equal(bad.status, 400)
  assert.match((await bad.json()).error, /path/i)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/account-workspace-files.test.js test/ui-workspace-files.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/account.js` (reusing `call`, `ws$`, `BAD_REPLY`):

```js
// Workspace files (phase 2). Each throws with .status when the API says no.
const file$ = (id, fileId) => `${ws$(id)}/files/${encodeURIComponent(fileId)}`
export async function listWorkspaceFiles ({ token, id, folder, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'GET', `${ws$(id)}/files${folder !== undefined ? `?folder=${encodeURIComponent(folder)}` : ''}`, null, token)
  if (!Array.isArray(r.files)) throw new Error(BAD_REPLY)
  return r.files
}
export async function createWorkspaceFile ({ token, id, path, size, mime = '', sha256 = '', note = '', api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'POST', `${ws$(id)}/files`, { path, size, mime, sha256, note }, token)
  if (!r.file || !r.upload) throw new Error(BAD_REPLY)
  return r
}
export async function confirmWorkspaceFile ({ token, id, fileId, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'POST', `${file$(id, fileId)}/done`, {}, token)
  if (!r.file) throw new Error(BAD_REPLY)
  return r.file
}
export async function workspaceFileDownload ({ token, id, fileId, version, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'GET', `${file$(id, fileId)}/download${version ? `?version=${encodeURIComponent(version)}` : ''}`, null, token)
  if (!r.url) throw new Error(BAD_REPLY)
  return r
}
export async function updateWorkspaceFile ({ token, id, fileId, patch, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'PATCH', file$(id, fileId), patch, token)
  if (!r.file) throw new Error(BAD_REPLY)
  return r.file
}
export async function deleteWorkspaceFile ({ token, id, fileId, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  await call(fetchImpl, api, 'DELETE', file$(id, fileId), null, token)
}
export async function createWorkspaceFolder ({ token, id, path, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'POST', `${ws$(id)}/folders`, { path }, token)
  if (!r.file) throw new Error(BAD_REPLY)
  return r.file
}
export async function listWorkspaceFileVersions ({ token, id, fileId, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'GET', `${file$(id, fileId)}/versions`, null, token)
  if (!Array.isArray(r.versions)) throw new Error(BAD_REPLY)
  return r.versions
}
```

`src/ui-server.js`: next to `receiveUpload`, with `MAX_WS_FILE_BYTES = 500 * 1024 * 1024` and `crypto` imported:

```js
  // A workspace upload from the page: the bytes go to a temp file, the API hands out a signed
  // link, Node streams the file there, and the API confirms it. The page never talks to storage.
  async function receiveWorkspaceUpload (req, id) {
    const account = readAccount()
    if (!account) throw Object.assign(httpError(401, 'Sign in to Quilt first.'), { signedOut: true })
    const filePath = decodeURIComponent(req.headers['x-path'] || '')
    const note = req.headers['x-note'] ? decodeURIComponent(req.headers['x-note']) : ''
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-wsup-'))
    const tmp = path.join(dir, 'upload')
    try {
      const hash = crypto.createHash('sha256')
      let size = 0
      const out = fs.createWriteStream(tmp)
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_WS_FILE_BYTES) { out.destroy(); throw httpError(413, 'File is too large (500 MB at most).') }
        hash.update(chunk)
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
      if (!size) throw httpError(400, 'The file is empty.')
      const mime = String(req.headers['content-type'] || '').split(';')[0] || ''
      return await asAccount(async (token) => {
        const { file, upload } = await createWorkspaceFile({ token, id: needWorkspaceId(id), path: filePath, size, mime: mime === 'application/octet-stream' ? '' : mime, sha256: hash.digest('hex'), note })
        const put = await fetch(upload.url, { method: upload.method, headers: { 'content-type': file.mime || 'application/octet-stream', 'content-length': String(size), ...(upload.headers || {}) }, body: fs.createReadStream(tmp), duplex: 'half' })
        if (!put.ok) throw httpError(502, `The file could not be stored (${put.status}).`)
        return { file: await confirmWorkspaceFile({ token, id, fileId: file.id }) }
      })
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  }

  /** Streams a workspace file to the page, so previews stay same-origin. */
  async function streamWorkspaceFile (req, res, id, fileId) {
    const url = new URL(req.url, 'http://x')
    const info = await asAccount((token) => workspaceFileDownload({ token, id: needWorkspaceId(id), fileId, version: url.searchParams.get('version') || undefined }))
    const r = await fetch(info.url)
    if (!r.ok) { res.writeHead(502, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: `The file could not be fetched (${r.status}).` })) }
    const disposition = url.searchParams.get('download') ? 'attachment' : 'inline'
    res.writeHead(200, { 'content-type': info.mime || 'application/octet-stream', ...(info.size ? { 'content-length': String(info.size) } : {}), 'content-disposition': `${disposition}; filename="${String(info.name).replace(/["\r\n]/g, '')}"`, 'cache-control': 'private, max-age=60' })
    const { Readable } = await import('node:stream')
    Readable.fromWeb(r.body).pipe(res)
  }
```

Wire them in the request handler where `receiveUpload` is dispatched (before the JSON `api` map): `const wu = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/upload$/); if (req.method === 'PUT' && wu) return json(200, await receiveWorkspaceUpload(req, wu[1]))` and `const wd = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/files\/([^/]+)\/data$/); if (req.method === 'GET' && wd) return streamWorkspaceFile(req, res, wd[1], wd[2])` (inside the same try/catch that turns `httpError`s into JSON). JSON routes in the `api` map:

```js
    'GET /api/workspaces/:id/files': (b, id, url) => asAccount(async (token) => ({ files: await listWorkspaceFiles({ token, id: needWorkspaceId(id), folder: url.searchParams.get('folder') ?? undefined }) })),
    'GET /api/workspaces/:id/files/:fid/versions': (b, id, url, fid) => asAccount(async (token) => ({ versions: await listWorkspaceFileVersions({ token, id: needWorkspaceId(id), fileId: fid }) })),
    'POST /api/workspaces/:id/files/:fid/update': (b, id, url, fid) => asAccount(async (token) => ({ file: await updateWorkspaceFile({ token, id: needWorkspaceId(id), fileId: fid, patch: { path: b.path, note: b.note } }) })),
    'POST /api/workspaces/:id/files/:fid/delete': (b, id, url, fid) => asAccount(async (token) => { await deleteWorkspaceFile({ token, id: needWorkspaceId(id), fileId: fid }); return { ok: true } }),
    'POST /api/workspaces/:id/folders': (b, id) => asAccount(async (token) => ({ file: await createWorkspaceFolder({ token, id: needWorkspaceId(id), path: String(b.path || '') }) })),
```

Check how the `api` map's dispatcher extracts `:id` and whether it supports a second parameter (`:fid`); Task 7 of phase 1 added `pathKey`/`sid` handling for `/api/workspaces/:id/...`; extend it so a second segment after `/files/` is passed as a fourth argument (keep the existing three-argument routes working). Add `'/files.js': ['files.js', 'text/javascript; charset=utf-8']` to `STATIC` (the module arrives in Task 6; the allowlist test fails until then, as in phase 1).

- [ ] **Step 4: Run the tests**

Run: `node --test test/account-workspace-files.test.js test/ui-workspace-files.test.js test/ui-workspaces.test.js test/ui.test.js test/account-workspaces.test.js`
Expected: PASS (allowlist test excepted until Task 6).

- [ ] **Step 5: Commit**

```bash
git add src/account.js src/ui-server.js test/account-workspace-files.test.js test/ui-workspace-files.test.js
git commit -m "Workspace files: the app uploads through its local server and streams files back"
```

---

### Task 6: The Files section, the All files view and previews

**Files:**
- Create: `src/ui/files.js`
- Modify: `src/ui/workspaces.js` (Files section between Sessions and People; `openWorkspace` keeps `files` and `usage`; polling), `src/ui/app.js` (`wsfiles:<id>` view; the poll timer), `src/ui/home.js` (`renderShell` routes `wsfiles:`), `src/ui/common.js` (`state.filesView`), `src/ui/app.css`
- Test: `test/ui-files-screens.test.js`

**Interfaces:**
- `state.workspace.files` (views) and `state.workspace.usage` come from `GET /api/workspaces/:id` (Task 4 added them to the API answer; the local route passes the whole answer through).
- `state.filesView = { folder: '', picked: null, mode: 'tiles' | 'list' }`.
- `src/ui/files.js` exports:
  - `filesSectionHtml(d) -> string`: the workspace page's Files section: a `sec-head` with "Files", the count, usage ("1.2 GB of 5 GB"), an "All files" link (`data-all-files`), and a tile grid (`.tiles`): folders first (`.tile.folder`), then the newest 8 files (`.tile` with a thumbnail: `<img src="/api/workspaces/<id>/files/<fid>/data?t=<token>">` for images, a type badge otherwise), then the upload tile (`.tile.add`, `data-upload-tile`) with a hidden `<input type="file" multiple>`; drag-and-drop on the section (`dragover` adds `.dragging`, `drop` uploads).
  - `bindFilesSection(root, { id, reload })`.
  - `allFilesHtml(d) -> string`: the All files page: back link to the workspace (`data-ws-open`), a breadcrumb for `state.filesView.folder` (`data-folder` crumbs), a Tiles / List switch (`data-files-mode`), "New folder" (`data-new-folder`) and "Upload" (`data-upload`), the grid of the folder's direct children (tiles or a list with name, size, uploader, date, version), and when `picked` is set a preview panel (`.file-preview`): image `<img>`, video `<video controls>`, audio `<audio controls>`, PDF `<iframe>`, CSV as a table (first 200 rows, fetched as text), text and Markdown as `<pre>` (up to 2 MB), everything else "No preview for this kind of file." Below: name, size, type, uploader and age, note, buttons Download (`<a download href="…?download=1">`), Rename (`data-rename`), Move (`data-move`), Delete (`data-delete`), and the versions list (`data-versions`, loaded on demand) each with "Download this version".
  - `bindAllFiles(root, { id, reload, go })`.
  - `uploadFiles(id, files, { folder, onProgress }) -> Promise<void>`: one `XMLHttpRequest` PUT per file to `/api/workspaces/<id>/upload` with `x-path` = `folder ? folder + '/' + file.name : file.name`, `content-type` = `file.type || 'application/octet-stream'`, progress to `onProgress(file, loaded, total)`; errors surface through `toast` with the server's message.
  - `workspaceFilePicker(id) -> Promise<{ id, name } | null>`: a dialog listing the workspace's files (flat, by path) with a search box; resolves with the picked file or null (used by Task 7).
- Polling: while `state.view` is `ws:` or `wsfiles:`, `app.js` runs `setInterval(() => openWorkspace(id).then(render), 20000)` and clears it on `go()`; actions call `reload()` which does `openWorkspace` then re-render.
- Human-readable sizes: use `bytes()` from `common.js`, extended to GB (`n < 1073741824 ? MB : GB with one decimal`).

- [ ] **Step 1: Write the failing screen test**

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/ui-files-screens.test.js`
Expected: FAIL (`files.js` missing).

- [ ] **Step 3: Implement**

Write `src/ui/files.js` to the interface above. Guidance that is not optional:

- Every interpolated string goes through `esc()`; file ids are UUIDs but escape them anyway. Thumbnails and previews use `/api/workspaces/${id}/files/${fid}/data?t=${encodeURIComponent(TOKEN)}` (the local server accepts the token as a query parameter for `GET` the way `/api/events` does; check `src/ui-server.js` and add `?t=` acceptance to the `data` route if it only reads the header).
- Tiles: `.tile .thumb` 84px tall; image tiles load lazily (`loading="lazy"`); type badge text from the extension (`PNG`, `MP4`, `XLSX`); version pill `v2` when `version > 1`; name and "uploader · age" under it (`ago()` from common.js; the uploader shows as a name when the API gives one, else the account's kind).
- Folder navigation: clicking a folder tile sets `state.filesView.folder` and re-renders; the breadcrumb's crumbs go up. On the workspace page the Files section shows the root; "All files" goes to `wsfiles:<id>`.
- Upload progress: the upload tile shows "Uploading n of m · 64%" while `uploadFiles` runs; on finish call `reload()`.
- Preview text fetches `.../data` with `fetch` and the token header, caps at 2 MB (check `size` first; larger shows "Too big to preview; download it.").
- CSV: split lines, split on commas (quoted fields with a tiny state machine: quotes, escaped `""`), render a `<table>` of the first 200 rows.
- Rename and Move use `ask()` with a text input prefilled (`input: { value }`); Delete confirms with `ask({ danger: true })`.
- The picker dialog lists files with `data-pick="<id>"` rows and filters as you type.
- CSS: `.tiles` grid `repeat(auto-fill, minmax(150px, 1fr))`, `.tile`, `.tile.folder`, `.tile.add` dashed, `.thumb` with `.badge`, `.file-preview` two-column layout on wide screens (grid left, preview right 300px), `.files-dragging` outline on the section, `.crumbs`, `.files-list` table rows. Add under a `/* ---------- workspace files ---------- */` block.
- `app.js`: `isFiles = (v) => v.startsWith('wsfiles:')`; `go()` treats it like `ws:` (loads the workspace); the 20 s poll: `state.pollTimer = setInterval(…)` set when entering `ws:`/`wsfiles:` views and cleared on every `go()` and on sign-out.
- `workspaces.js` `workspacePageHtml`: insert `filesSectionHtml(d)` between the Sessions and the People sections; `bindWorkspacePage` calls `bindFilesSection(root, { id, reload })`.

- [ ] **Step 4: Run the tests, then look at it**

Run: `node --test test/ui-files-screens.test.js test/ui-static-allowlist.test.js test/ui-workspaces-screens.test.js test/ui-workspace-files.test.js test/ui.test.js`
Expected: PASS.

Then start the signed-in preview (the script `scratchpad/preview-ws.mjs` from the controller session, or the same steps: a test API with `workspaces: true` and a `DiskStore`, a relay, `linkDevice` + `saveAccount`, `startUi`) and, in a browser: upload an image and a text file by the tile, see the thumbnail, open All files, click the text file and see the preview, rename it, make a folder, drag a file into the section, delete a file, check the usage line. Record what you saw.

- [ ] **Step 5: Commit**

```bash
git add src/ui/files.js src/ui/workspaces.js src/ui/app.js src/ui/home.js src/ui/common.js src/ui/app.css test/ui-files-screens.test.js
git commit -m "Workspace files: the Files section, All files view, previews and uploads in the app"
```

---

### Task 7: Attach from workspace in session chat

**Files:**
- Modify: `src/ui/session.js` (composer button `data-attach-workspace`, shown only when the session's `summary.workspace` is set), `src/ui-server.js` (`POST /api/sessions/:id/attach-from-workspace { fileId, to?, text? }`)
- Test: `test/ui-attach-from-workspace.test.js` (screen checks on `session.js`) and a case in `test/ui-workspace-files.test.js`

**Interfaces:**
- The local route reads the session's `workspace` from its config, downloads the file to a temp dir with `workspaceFileDownload` + `fetch`, calls `session.sendFile(tmpPath, { to, text })` (the existing chat-attachment path, 100 MB cap applies: 413 "That file is too big to send in chat (100 MB at most)."), removes the temp dir, answers the sent message.
- In the session view: a second icon button next to the clip, `title="Attach from workspace"`, that opens `workspaceFilePicker(summary.workspace)` and posts the pick to the route; the message appears like any attachment.

- [ ] **Step 1: Write the failing tests**

```js
// test/ui-attach-from-workspace.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
const ui = (f) => fs.readFileSync(new URL(`../src/ui/${f}`, import.meta.url), 'utf8')

test('the composer offers Attach from workspace when the session is in one', () => {
  const s = ui('session.js')
  for (const bit of ['data-attach-workspace', 'title="Attach from workspace"', "from './files.js'", 'workspaceFilePicker(', '/attach-from-workspace']) assert.ok(s.includes(bit), bit)
  assert.ok(s.includes('.workspace ?') || s.includes('.workspace\n') || s.includes('workspace ? `<button'), 'only when the session has a workspace')
})
```

Add to `test/ui-workspace-files.test.js`:

```js
test('attach from workspace sends the file into the session chat', async () => {
  const id = (await api('POST', '/api/workspaces', { name: 'Chat' })).body.workspace.id
  const up = await fetch(`${base()}/api/workspaces/${id}/upload`, { method: 'PUT', headers: { 'x-quilt-token': ui.token, 'x-path': encodeURIComponent('brief.txt'), 'content-type': 'text/plain' }, body: 'the brief' })
  const { file } = await up.json()
  const s = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'chatproj'), workspace: id })
  assert.equal(s.status, 200)
  const sent = await api('POST', `/api/sessions/${s.body.id}/attach-from-workspace`, { fileId: file.id, text: 'from the library' })
  assert.equal(sent.status, 200, JSON.stringify(sent.body))
  const msgs = (await api('GET', `/api/sessions/${s.body.id}/messages`)).body.messages
  const m = msgs.find((x) => x.file && x.file.name === 'brief.txt')
  assert.ok(m, 'the attachment is in the chat')
  assert.equal(m.text, 'from the library')
  await api('POST', `/api/sessions/${s.body.id}/stop`)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/ui-attach-from-workspace.test.js test/ui-workspace-files.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/ui-server.js`:

```js
    'POST /api/sessions/:id/attach-from-workspace': async (b, id) => {
      const s = get(id)
      const workspace = (readConfig(s.root) || {}).workspace
      if (!workspace) throw httpError(400, 'This session is not in a workspace.')
      const info = await asAccount((token) => workspaceFileDownload({ token, id: workspace, fileId: String(b.fileId || '') }))
      if (info.size > MAX_SHARED_FILE_BYTES) throw httpError(413, 'That file is too big to send in chat (100 MB at most).')
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-wsattach-'))
      try {
        const file = path.join(dir, path.basename(info.name) || 'file')
        const r = await fetch(info.url)
        if (!r.ok) throw httpError(502, `The file could not be fetched (${r.status}).`)
        const { Readable } = await import('node:stream')
        await new Promise((resolve, reject) => Readable.fromWeb(r.body).pipe(fs.createWriteStream(file)).on('finish', resolve).on('error', reject))
        return await s.sendFile(file, { to: b.to || null, text: String(b.text || '') })
      } finally { fs.rmSync(dir, { recursive: true, force: true }) }
    },
```

(`get(id)` returns the Session; confirm the root dir property name used elsewhere, e.g. `get(id).root` in the merges route.) `src/ui/session.js`: next to `#attach-btn`, when `summary.workspace` is truthy render `<button type="button" class="btn ghost icon" data-attach-workspace title="Attach from workspace" aria-label="Attach from workspace">${I.folder}</button>`; bind: `const pick = await workspaceFilePicker(summary.workspace); if (pick) { await api('POST', \`/api/sessions/${id}/attach-from-workspace\`, { fileId: pick.id, to: state.to || null, text: composerText() }); clear the composer }` with the same muted/no-posting guard the clip button has. Import `workspaceFilePicker` from `./files.js`.

- [ ] **Step 4: Run the tests**

Run: `node --test test/ui-attach-from-workspace.test.js test/ui-workspace-files.test.js test/ui-access-screens.test.js test/ui-static-allowlist.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/session.js src/ui-server.js test/ui-attach-from-workspace.test.js test/ui-workspace-files.test.js
git commit -m "Session chat: attach a file from the workspace library"
```

---

### Task 8: Website: file list and download

**Files:**
- Create: `web/components/WorkspaceFiles.js`, `web/app/api/workspaces/[id]/files/[fileId]/route.js`
- Modify: `web/app/dashboard/workspaces/[id]/page.js`, `web/app/org/[slug]/workspaces/[id]/page.js` (a Files section between Members and Sessions)
- Test: `web/test/workspace-files.test.js`

**Interfaces:**
- `WorkspaceFiles({ files, usage, downloadHref })`: a `card stack` section "Files" with the usage line, and a list (`list-row` per file: name with its folder in muted text, size, uploader and date, version pill, a Download link to `downloadHref(f)`). Folders are not listed on the website (files show their folder). Empty: "No files yet. Upload from the app."
- Route handler `GET /api/workspaces/[id]/files/[fileId]?version=`: requires the signed-in user (`currentUser` from `@/lib/session.js`; 401 otherwise), calls the API's download route with `apiCall`, and `redirect`s (302) to `url`; 404 when the API says so.
- Pure helper `web/lib/files-view.js`: `formatBytes(n)`, `fileRows(files)` (files only, sorted by folder then name) for tests.

- [ ] **Step 1: Write the failing test**

```js
// web/test/workspace-files.test.js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && node --conditions=react-server --test test/workspace-files.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

```js
// web/lib/files-view.js
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
```

```jsx
// web/components/WorkspaceFiles.js
import { formatBytes, fileRows } from '@/lib/files-view.js'
import { when } from '@/lib/org-view.js'

/** The workspace's files, download only: uploads happen in the app. */
export default function WorkspaceFiles ({ files, usage, downloadHref }) {
  const rows = fileRows(files)
  return (
    <section className='card stack'>
      <h2>Files</h2>
      {usage && <p className='muted'>{formatBytes(usage.usedBytes)} of {formatBytes(usage.quotaBytes)} used · {usage.fileCount} {usage.fileCount === 1 ? 'file' : 'files'}</p>}
      {!rows.length && <p className='muted'>No files yet. Upload from the app.</p>}
      <div>
        {rows.map((f) => (
          <div key={f.id} className='list-row'>
            <span className='stack' style={{ gap: 2 }}>
              <b>{f.name}{f.folder && <span className='muted'> · {f.folder}</span>} {f.version > 1 && <span className='pill'>v{f.version}</span>}</b>
              <span className='muted'>{formatBytes(f.size)} · {f.uploadedBy?.split(':')[0] || 'someone'} · {when(f.uploadedAt)}{f.note ? ` · ${f.note}` : ''}</span>
            </span>
            <a className='btn' href={downloadHref(f)}>Download</a>
          </div>))}
      </div>
    </section>
  )
}
```

```js
// web/app/api/workspaces/[id]/files/[fileId]/route.js
// Download a workspace file: the API signs a short-lived link for the signed-in person and we send them there.
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'

export async function GET (req, { params }) {
  const { id, fileId } = await params
  const user = await currentUser()
  if (!user) return new Response('sign in first', { status: 401 })
  const version = new URL(req.url).searchParams.get('version')
  const r = await apiCall(user, 'GET', `/v1/workspaces/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}/download${version ? `?version=${encodeURIComponent(version)}` : ''}`, undefined, { expect404: true })
  if (r.status === 404) return new Response('not found', { status: 404 })
  if (!r.ok || !r.data?.url) return new Response('the file could not be fetched right now', { status: 502 })
  redirect(r.data.url)
}
```

Check `currentUser` exists in `web/lib/session.js` (the report route uses it) and `apiCall`'s options signature. In both `[id]` pages read `files = []` and `usage` from `r.data` and render `<WorkspaceFiles files={files} usage={usage} downloadHref={(f) => \`/api/workspaces/${encodeURIComponent(w.id)}/files/${encodeURIComponent(f.id)}\`} />` between the Members and Sessions sections.

- [ ] **Step 4: Run the website tests**

Run: `cd web && npm test` (builds the site; the routes test must still pass). The controller may run it for you if it is slow; say so in the report.

- [ ] **Step 5: Commit**

```bash
git add web/lib/files-view.js web/components/WorkspaceFiles.js web/app/api/workspaces web/app/dashboard/workspaces/\[id\]/page.js web/app/org/\[slug\]/workspaces/\[id\]/page.js web/test/workspace-files.test.js
git commit -m "Website: a workspace's files, with download"
```

---

### Task 9: Release notes, docs, full suite, window check

**Files:**
- Modify: `RELEASES.md` (bullets under the `## 0.3.8 — 2026-10-05` section), `README.md` (the workspaces paragraph mentions files), `docs/hosting.md` (confirm Task 2's rows), `docs/superpowers/specs/2026-10-03-workspaces-design.md` (Realtime row: polling in phase 2; Previews: spreadsheets later)

- [ ] **Step 1: Write the bullets**

Add to the 0.3.8 section:

```
- **A workspace has files.** Upload images, video, PDFs, spreadsheets, CSV, zips and documents to a workspace and everyone in it, people and agents alike, sees them at once. The workspace page shows the newest files as tiles; **All files** has folders, a tiles or list view, a preview (images, video, audio, PDF, CSV, text and Markdown), rename, move, delete, and every file's versions: uploading to the same name keeps the last ten. 500 MB per file, 5 GB per workspace. heyquilt.com lists a workspace's files with Download.
- **Attach from workspace.** In a session inside a workspace, the chat composer's folder button picks a library file to send, without downloading it first.
- **For servers:** the accounts API stores workspace files in the Quilt Files project's `workspace-files` bucket with `QUILT_STORAGE_URL` and `QUILT_STORAGE_KEY`, or on its own disk under `QUILT_API_DATA` without them.
```

Update the spec's Decisions table: Realtime row says "Phase 2 ships polling (every 20 seconds while a workspace is open, and after each action); Supabase Realtime is a later improvement"; add to the Previews sentence "spreadsheets show name, size and Download in phase 2".

- [ ] **Step 2: Run everything**

Run: `npm test 2>&1 | tail -8` and `cd web && npm test 2>&1 | tail -6`. Everything passes.

- [ ] **Step 3: Window check**

Start the signed-in preview and, in a browser, do the Task 6 checklist again plus Attach from workspace in a session started from the workspace page. Record what you saw in the report.

- [ ] **Step 4: Commit**

```bash
git add RELEASES.md README.md docs/hosting.md docs/superpowers/specs/2026-10-03-workspaces-design.md
git commit -m "Workspace files: release notes and docs"
```

---

## Self-review notes

- Spec coverage: library storage (1, 2), index and versions (3), routes with quota and sweep (4), app upload and streaming (5), Files section, All files, previews, drag-and-drop, folders, versions, usage (6), Attach from workspace (7), website file list with download (8), notes and docs (9). Not in this phase by ruling: Supabase Realtime (polling instead), spreadsheet previews, "Save to workspace" from a session chat attachment and mounting the library (phase 4 bridges), agent tools (phase 3).
- Names used consistently: store `createWorkspaceFile / workspaceFileById / workspaceFileByPath / listWorkspaceFiles / newWorkspaceFileVersion / listWorkspaceFileVersions / confirmWorkspaceFile / updateWorkspaceFile / renameWorkspaceFolder / deleteWorkspaceFile / unconfirmedWorkspaceFiles / removeWorkspaceFile / sweepDeletedWorkspaceFiles / workspaceUsage / setWorkspaceUsage / setWorkspaceFileObjectKey / revertWorkspaceFileVersion`; file store `uploadTarget / downloadTarget / exists / remove`; API routes as the Task 4 table; account helpers as Task 5; local routes `/api/workspaces/:id/upload`, `/files`, `/files/:fid/data|versions|update|delete`, `/folders`, `/api/sessions/:id/attach-from-workspace`; UI exports `filesSectionHtml / bindFilesSection / allFilesHtml / bindAllFiles / uploadFiles / workspaceFilePicker`.
