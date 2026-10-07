-- The audit trail: for each visit, how the member came in (the app or a hosted agent, and
-- which tool), why it ended, and what it did meanwhile. Actions name a path, a task id or
-- a tool; never file contents, chat text or task text. Kept as long as visits are (12
-- months), and only the session owner reads them, through the accounts API. As before,
-- row-level security is on with no client policies and no client grants.

alter table public.session_visits
  add column via text check (via is null or via in ('app', 'hosted')),
  add column tool text check (tool is null or char_length(tool) <= 40),
  add column end_reason text check (end_reason is null or end_reason in
    ('left', 'disconnected', 'removed', 'pass_expired', 'session_ended', 'relay_restart', 'idle', 'replaced', 'needs_update'));

create table public.visit_actions (
  -- The relay's id for the "act" event: a replayed event can't make a second row.
  id uuid primary key,
  visit_start_id uuid not null references public.session_visits (event_start_id) on delete cascade,
  room text not null,
  account text not null check (account ~ '^(person|agent):[A-Za-z0-9_-]{1,64}$'),
  action text not null check (action in
    ('created', 'edited', 'deleted', 'claimed', 'released', 'requested', 'handed_off', 'withdrew', 'messaged', 'task', 'tool')),
  target text not null default '' check (char_length(target) <= 300),
  at timestamptz not null
);
create index visit_actions_room_at on public.visit_actions (room, at);
create index visit_actions_visit on public.visit_actions (visit_start_id, at);

alter table public.visit_actions enable row level security;
revoke all on public.visit_actions from anon, authenticated;
grant all on public.visit_actions to service_role;

-- As before, plus: a start's via and tool, an end's reason, and act events. An act whose
-- visit never arrived (its start was dropped from a full queue) is skipped.
create or replace function public.ingest_presence (p_events jsonb, p_received_at timestamptz default now())
returns integer
language plpgsql
set search_path = ''
as $$
declare
  e jsonb;
  t timestamptz;
  applied integer := 0;
begin
  for e in select value from jsonb_array_elements(p_events) loop
    insert into public.relay_events_seen (id, received_at) values ((e->>'id')::uuid, p_received_at)
      on conflict (id) do nothing;
    if not found then
      continue;
    end if;
    applied := applied + 1;
    t := to_timestamp((e->>'at')::double precision / 1000);
    if e->>'type' = 'start' then
      insert into public.relay_sessions as s (room, owner_account, created_at, last_active_at)
        values (e->>'room', case when (e->>'owner')::boolean then e->>'account' end, t, t)
        on conflict (room) do update set
          owner_account = coalesce(s.owner_account, excluded.owner_account),
          last_active_at = greatest(s.last_active_at, excluded.last_active_at);
      insert into public.session_visits (event_start_id, room, account, account_name, kind, started_at, via, tool)
        values ((e->>'id')::uuid, e->>'room', e->>'account', coalesce(e->>'name', ''), split_part(e->>'account', ':', 1), t,
          nullif(e->>'via', ''), nullif(e->>'tool', ''))
        on conflict (event_start_id) do nothing;
    elsif e->>'type' = 'end' then
      update public.session_visits set ended_at = greatest(started_at, t), end_reason = nullif(e->>'reason', '')
        where event_start_id = (e->>'start')::uuid and ended_at is null;
      update public.relay_sessions set last_active_at = greatest(last_active_at, t)
        where room = e->>'room';
    elsif e->>'type' = 'act' then
      insert into public.visit_actions (id, visit_start_id, room, account, action, target, at)
        select (e->>'id')::uuid, v.event_start_id, v.room, v.account, e->>'action', coalesce(e->>'target', ''), t
        from public.session_visits v where v.event_start_id = (e->>'start')::uuid
        on conflict (id) do nothing;
    elsif e->>'type' = 'name' then
      insert into public.relay_sessions as s (room, name, created_at, last_active_at)
        values (e->>'room', e->>'name', t, t)
        on conflict (room) do update set name = excluded.name
        where s.renamed_at is null;
    end if;
  end loop;
  return applied;
end;
$$;

-- What was done in a session between two times, oldest first, at most p_limit rows.
create function public.actions_in_room (p_room text, p_from timestamptz, p_to timestamptz, p_limit integer)
returns setof public.visit_actions
language sql
stable
set search_path = ''
as $$
  select a.* from public.visit_actions a
  where a.room = p_room and a.at >= p_from and a.at < p_to
  order by a.at, a.id
  limit p_limit;
$$;

revoke execute on function public.actions_in_room (text, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.actions_in_room (text, timestamptz, timestamptz, integer) to service_role;
