-- An agent's id (agents.id) is public, like a person's: just who it is, never a key.
-- Every agent is told to keep it. An agent that is sent a new invite gives its id
-- when it joins and comes back as itself (same agent, history and memberships)
-- instead of as a second agent with the same name: the invite proves the person (or
-- org) still wants it, so the id only has to name an agent of theirs. Its profile and
-- resume key are renewed, and an agent a person removed is let back in.
-- rejoined says which invites brought an existing agent back, for the dashboard.
alter table public.agent_invites add column rejoined boolean not null default false;
