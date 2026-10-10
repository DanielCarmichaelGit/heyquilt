import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = () => fs.readFileSync(new URL('../../supabase/migrations/20261005000000_workspace_files.sql', import.meta.url), 'utf8')
const bucket = () => fs.readFileSync(new URL('../../supabase/files-project/workspace_files_bucket.sql', import.meta.url), 'utf8')
const table = (s, name) => (s.match(new RegExp(`create table public\\.${name} \\([\\s\\S]*?\\n\\);`)) || [''])[0]

const FUNCTIONS = [
  'sweep_deleted_workspace_files (timestamptz)',
  'new_workspace_file_version (uuid, bigint, text, text, text, text, text, timestamptz, integer)',
  'rename_workspace_folder (uuid, text, text)',
  'delete_workspace_file (uuid, timestamptz)',
  'workspace_usage (uuid)',
  'revert_workspace_file_version (uuid)'
]

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
  assert.doesNotMatch(s, /\blike\b/i, 'folder matching uses prefix equality, not like')
  for (const t of ['workspace_files', 'workspace_file_versions']) assert.match(s, new RegExp(`alter table public\\.${t} enable row level security`), t)
  assert.doesNotMatch(s, /create policy/)
  assert.match(s, /revoke all on public\.workspace_files, public\.workspace_file_versions from anon, authenticated;/)
  assert.match(s, /grant all on public\.workspace_files, public\.workspace_file_versions to service_role;/)
  for (const f of FUNCTIONS) {
    assert.ok(s.includes(`revoke execute on function public.${f} from public, anon, authenticated;`), f)
    assert.ok(s.includes(`grant execute on function public.${f} to service_role;`), f)
  }
  const sweep = (s.match(/create function public\.sweep_deleted_workspace_files[\s\S]*?\n\$\$;/) || [''])[0]
  assert.ok(sweep.includes('array_agg(object_key)'), 'sweep collects keys into an array first')
  assert.ok(sweep.indexOf('array_agg(object_key)') < sweep.indexOf('delete from public.workspace_files'), 'sweep collects keys before deleting')
  for (const m of s.matchAll(/create function public\.\w+[\s\S]*?\nas \$\$/g)) assert.match(m[0], /set search_path = ''/)
})

test('the bucket is private with a 500 MB cap', () => {
  const b = bucket()
  assert.match(b, /insert into storage\.buckets \(id, name, public, file_size_limit\)\s*values \('workspace-files', 'workspace-files', false, 524288000\)/)
  assert.match(b, /on conflict \(id\) do nothing/)
})
