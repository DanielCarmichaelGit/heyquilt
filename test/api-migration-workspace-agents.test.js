import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = () => fs.readFileSync(new URL('../supabase/migrations/20261007000000_workspace_agents.sql', import.meta.url), 'utf8')
const table = (s, name) => (s.match(new RegExp(`create table public\\.${name} \\([\\s\\S]*?\\n\\);`)) || [''])[0]

test('the columns and tables the spec names', () => {
  const s = sql()
  assert.match(s, /alter table public\.workspace_members add column sessions text not null default 'invited' check \(sessions in \('all', 'invited'\)\);/)
  const p = table(s, 'agent_placements')
  for (const col of ['agent_id uuid primary key references public.agents (id) on delete cascade', "reach text not null default 'manual' check (reach in ('all', 'workspaces', 'manual'))", "workspace_ids uuid[] not null default '{}'", "sessions text not null default 'invited' check (sessions in ('all', 'invited'))", "access text not null default 'edit' check (access in ('edit', 'view'))", "scopes text[] not null default '{}' check (cardinality(scopes) <= 20)", 'updated_by text not null', 'updated_at timestamptz not null default now()']) assert.ok(p.includes(col), col)
  const o = table(s, 'workspace_agent_overrides')
  for (const col of ['workspace_id uuid not null references public.workspaces (id) on delete cascade', 'agent_id uuid not null references public.agents (id) on delete cascade', "sessions text check (sessions in ('all', 'invited'))", 'excluded boolean not null default false', 'primary key (workspace_id, agent_id)']) assert.ok(o.includes(col), col)
  const x = table(s, 'session_agent_exclusions')
  for (const col of ['room text not null references public.relay_sessions (room) on delete cascade', 'agent_id uuid not null references public.agents (id) on delete cascade', 'excluded_by text not null', 'primary key (room, agent_id)']) assert.ok(x.includes(col), col)
  const w = table(s, 'agent_webhooks')
  for (const col of ['agent_id uuid primary key references public.agents (id) on delete cascade', 'url text not null check (char_length(url) <= 2000)', 'secret text not null', 'created_at timestamptz not null default now()']) assert.ok(w.includes(col), col)
  for (const col of ['alter table public.agent_invites add column workspace_id uuid references public.workspaces (id) on delete cascade;', "alter table public.agent_invites add column workspace_access text check (workspace_access in ('edit', 'view'));", "alter table public.agent_invites add column workspace_sessions text check (workspace_sessions in ('all', 'invited'));"]) assert.ok(s.includes(col), col)
})

test('additive only, RLS on, service role only', () => {
  const s = sql()
  assert.doesNotMatch(s, /\bdrop\b/i)
  for (const t of ['agent_placements', 'workspace_agent_overrides', 'session_agent_exclusions', 'agent_webhooks']) assert.match(s, new RegExp(`alter table public\\.${t} enable row level security`), t)
  assert.doesNotMatch(s, /create policy/)
  assert.match(s, /revoke all on public\.agent_placements, public\.workspace_agent_overrides, public\.session_agent_exclusions, public\.agent_webhooks from anon, authenticated;/)
  assert.match(s, /grant all on public\.agent_placements, public\.workspace_agent_overrides, public\.session_agent_exclusions, public\.agent_webhooks to service_role;/)
})
