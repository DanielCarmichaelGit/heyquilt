-- Invites people see in their own Quilt (the app's home and heyquilt.com/dashboard):
-- a session invite now keeps its link for the person it was sent to, and a workspace can
-- invite people (by account or email) who accept or decline it there.

-- The session's join link, shown only to the account or address it was sent to.
alter table public.session_invites add column link text check (char_length(link) <= 2048);
create index session_invites_email on public.session_invites (email);

create table public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email text check (email = lower(email) and char_length(email) <= 254),
  account text check (account ~ '^person:[A-Za-z0-9_-]{1,64}$'),
  -- The name the inviter saw when inviting an account (never its email).
  account_name text not null default '' check (char_length(account_name) <= 64),
  access text not null check (access in ('edit', 'view')),
  invited_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by text,
  declined_at timestamptz,
  cancelled_at timestamptz,
  check ((email is null) <> (account is null))
);
create index workspace_invites_workspace on public.workspace_invites (workspace_id, created_at);
create index workspace_invites_account on public.workspace_invites (account);
create index workspace_invites_email on public.workspace_invites (email);
-- One open invite per address or account in a workspace. The API deletes that key's
-- expired, unanswered invites just before inserting.
create unique index workspace_invites_open_email on public.workspace_invites (workspace_id, email) where accepted_at is null and declined_at is null and cancelled_at is null;
create unique index workspace_invites_open_account on public.workspace_invites (workspace_id, account) where accepted_at is null and declined_at is null and cancelled_at is null;

alter table public.workspace_invites enable row level security;
revoke all on public.workspace_invites from anon, authenticated;
grant all on public.workspace_invites to service_role;
