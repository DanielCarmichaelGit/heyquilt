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

-- Undoes a version bump that never landed: restores the newest kept version's bytes onto
-- the file row (with that version's own version number and confirmed_at), and removes the
-- version row. A file with no earlier version is returned unchanged.
create function public.revert_workspace_file_version (p_id uuid)
returns public.workspace_files
language plpgsql
set search_path = ''
as $$
declare
  f public.workspace_files;
  v public.workspace_file_versions;
begin
  select * into f from public.workspace_files where id = p_id for update;
  if not found then return null; end if;
  select * into v from public.workspace_file_versions where file_id = p_id order by version desc limit 1;
  if not found then return f; end if;
  update public.workspace_files set version = v.version, size = v.size, sha256 = v.sha256, object_key = v.object_key, note = v.note, uploaded_by = v.uploaded_by, uploaded_at = v.uploaded_at, confirmed_at = v.uploaded_at
    where id = p_id returning * into f;
  delete from public.workspace_file_versions where file_id = p_id and version = v.version;
  return f;
end;
$$;
revoke execute on function public.revert_workspace_file_version (uuid) from public, anon, authenticated;
grant execute on function public.revert_workspace_file_version (uuid) to service_role;
