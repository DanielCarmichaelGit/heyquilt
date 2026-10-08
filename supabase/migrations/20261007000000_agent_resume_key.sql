-- Every agent gets a resume key when it joins (qs_, kept by the agent, only its
-- hash here). It swaps for a fresh pair of keys after its refresh key stopped
-- working: a copy used twice, or a reply lost while offline. The same for agents
-- on a computer and agents over HTTP. Agents that joined before this have none.
alter table public.agents add column resume_hash text unique;
-- Not readable by people: the column grant on agents (select for authenticated)
-- names its columns, and resume_hash is not one of them.
