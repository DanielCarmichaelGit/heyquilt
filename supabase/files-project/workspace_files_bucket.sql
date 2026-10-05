-- Workspace libraries. Applied to the separate "Quilt Files" Supabase project
-- (awuikewxoddlryghvknr), never the accounts project. Private: only the accounts API (with
-- its secret key) signs upload and download links, so no policies are needed.
-- 500 MB per file, matching the API's maxFileBytes.
insert into storage.buckets (id, name, public, file_size_limit)
values ('workspace-files', 'workspace-files', false, 524288000)
on conflict (id) do nothing;
