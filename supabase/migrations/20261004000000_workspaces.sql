-- Workspaces: a container owned by a person or an org that holds sessions and members
-- (people and agents). Additive only: two tables and one nullable column. The accounts
-- API is the only reader and writer (service role), so row-level security is on with no
-- client policies and no client grants, like session activity and access types.

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users (id) on delete cascade,
  org_id uuid references public.orgs (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  description text not null default '' check (char_length(description) <= 500),
  -- One of the app's six pastel covers, or '' for the default.
  color text not null default '' check (char_length(color) <= 16),
  -- 'person:<uuid>' or 'agent:<uuid>'.
  created_by text not null check (created_by ~ '^(person|agent):[A-Za-z0-9_-]{1,64}$'),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  check ((owner_user_id is null) <> (org_id is null))
);
create index workspaces_owner_user_id on public.workspaces (owner_user_id);
create index workspaces_org_id on public.workspaces (org_id);

-- People and agents in a workspace, each with edit or view. The owner (a person) and an
-- org's managers (role permission) are not rows here: the API knows them.
create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  account text not null check (account ~ '^(person|agent):[A-Za-z0-9_-]{1,64}$'),
  access text not null check (access in ('edit', 'view')),
  added_by text not null check (added_by ~ '^(person|agent):[A-Za-z0-9_-]{1,64}$'),
  added_at timestamptz not null default now(),
  primary key (workspace_id, account)
);
create index workspace_members_account on public.workspace_members (account);

-- A session may belong to one workspace. Deleting the workspace leaves the session loose.
alter table public.relay_sessions add column workspace_id uuid references public.workspaces (id) on delete set null;
create index relay_sessions_workspace_id on public.relay_sessions (workspace_id);
-- Who linked it. Members get in through the workspace only while that is the session's
-- owner (as the relay reports it): linking a room is never a way to claim it.
alter table public.relay_sessions add column workspace_linked_by text check (workspace_linked_by ~ '^(person|agent):[A-Za-z0-9_-]{1,64}$');

-- Data, not shape: built-in role grants are copied into each org when it is made, so orgs
-- made before this get the Workspaces cells BUILTIN now gives Admin and Member
-- (src/api/permissions.js). Custom roles are left as their org made them.
update public.roles set grants = grants || '{"workspaces": {"c": true, "r": true, "u": true, "d": true}}'::jsonb where builtin = 'admin';
update public.roles set grants = grants || '{"workspaces": {"r": true}}'::jsonb where builtin = 'member';

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
revoke all on public.workspaces, public.workspace_members from anon, authenticated;
grant all on public.workspaces, public.workspace_members to service_role;

-- Every workspace an account can see as a member, with its access. Owners and org
-- managers are added by the API from workspaces.owner_user_id / org membership.
create function public.workspaces_for_account (p_account text)
returns table (workspace_id uuid, access text)
language sql
stable
set search_path = ''
as $$
  select m.workspace_id, m.access from public.workspace_members m where m.account = p_account;
$$;
revoke execute on function public.workspaces_for_account (text) from public, anon, authenticated;
grant execute on function public.workspaces_for_account (text) to service_role;

-- Deletes a workspace: its sessions become loose first (so the on delete set null never
-- races a concurrent link), then the row goes and members cascade.
create function public.delete_workspace (p_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.relay_sessions set workspace_id = null where workspace_id = p_id;
  delete from public.workspaces where id = p_id;
end;
$$;
revoke execute on function public.delete_workspace (uuid) from public, anon, authenticated;
grant execute on function public.delete_workspace (uuid) to service_role;

-- Links a room to a workspace (or none), recording who linked it. The app calls this as
-- soon as the relay has made the room, which may be before the relay's first presence
-- report: then the row is made here with no owner, and the report later sets the owner
-- (ingest_presence's on conflict never changes workspace_id). On an existing row only the
-- two workspace columns change.
create function public.set_session_workspace (p_room text, p_workspace uuid, p_linked_by text, p_at timestamptz)
returns public.relay_sessions
language plpgsql
set search_path = ''
as $$
declare
  s public.relay_sessions;
begin
  insert into public.relay_sessions as r (room, created_at, last_active_at, workspace_id, workspace_linked_by)
    values (p_room, p_at, p_at, p_workspace, p_linked_by)
    on conflict (room) do update set workspace_id = excluded.workspace_id, workspace_linked_by = excluded.workspace_linked_by
    returning * into s;
  return s;
end;
$$;
revoke execute on function public.set_session_workspace (text, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.set_session_workspace (text, uuid, text, timestamptz) to service_role;
