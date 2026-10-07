-- App keys (qk_): a key that signs one agent in and doesn't run out, for apps that
-- connect to Quilt with a pasted key and can't swap keys every hour (Pipedream,
-- Zapier, Make, n8n, a script of your own). The agent's owner makes and revokes
-- them on heyquilt.com; the key itself is shown once and only its hash is kept.
-- Revoking the agent revokes its app keys too, so a rejoin never brings one back.
create table public.agent_app_keys (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index agent_app_keys_agent_id on public.agent_app_keys (agent_id);

alter table public.agent_app_keys enable row level security;
-- No client policies or grants: key hashes are only for the API.
revoke all on public.agent_app_keys from anon, authenticated;
