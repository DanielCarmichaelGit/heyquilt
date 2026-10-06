-- Agents in workspaces (phase 3): where an agent works, a workspace's say over a global
-- agent, per-session keep-outs, and an agent's own webhook for "session started". Additive
-- only. The accounts API is the only reader and writer, so row-level security is on with no
-- client policies and no client grants.

-- An agent added to a workspace may also join every session in it as it starts.
alter table public.workspace_members add column sessions text not null default 'invited' check (sessions in ('all', 'invited'));

-- Where an agent works, set by its owner (a person for a personal agent; an org admin for an
-- org's). reach 'all' is every workspace of the agent's owner; 'workspaces' the listed ones;
-- 'manual' only where someone adds it.
create table public.agent_placements (
  agent_id uuid primary key references public.agents (id) on delete cascade,
  reach text not null default 'manual' check (reach in ('all', 'workspaces', 'manual')),
  workspace_ids uuid[] not null default '{}',
  sessions text not null default 'invited' check (sessions in ('all', 'invited')),
  access text not null default 'edit' check (access in ('edit', 'view')),
  scopes text[] not null default '{}' check (cardinality(scopes) <= 20),
  updated_by text not null,
  updated_at timestamptz not null default now()
);

-- A workspace's say over an agent that reaches it by placement.
create table public.workspace_agent_overrides (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  sessions text check (sessions in ('all', 'invited')),
  excluded boolean not null default false,
  primary key (workspace_id, agent_id)
);

-- A session owner keeps an agent out of one session.
create table public.session_agent_exclusions (
  room text not null references public.relay_sessions (room) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  excluded_by text not null,
  created_at timestamptz not null default now(),
  primary key (room, agent_id)
);

-- An agent's own webhook on the accounts API, for workspace events (session.started). The
-- secret signs deliveries, so it is kept as given; only the service role reads this table.
create table public.agent_webhooks (
  agent_id uuid primary key references public.agents (id) on delete cascade,
  url text not null check (char_length(url) <= 2000),
  secret text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- An agent invite may put the new agent straight into a workspace.
alter table public.agent_invites add column workspace_id uuid references public.workspaces (id) on delete cascade;
alter table public.agent_invites add column workspace_access text check (workspace_access in ('edit', 'view'));
alter table public.agent_invites add column workspace_sessions text check (workspace_sessions in ('all', 'invited'));

alter table public.agent_placements enable row level security;
alter table public.workspace_agent_overrides enable row level security;
alter table public.session_agent_exclusions enable row level security;
alter table public.agent_webhooks enable row level security;
revoke all on public.agent_placements, public.workspace_agent_overrides, public.session_agent_exclusions, public.agent_webhooks from anon, authenticated;
grant all on public.agent_placements, public.workspace_agent_overrides, public.session_agent_exclusions, public.agent_webhooks to service_role;
