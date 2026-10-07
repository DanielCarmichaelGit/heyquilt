-- Agent kinds (workspaces phase 3): an agent invite can make a global agent, one placed in all
-- of its owner's workspaces when it joins. Additive only. The accounts API selects this column
-- for every agent invite, so apply this migration before deploying the API.
alter table public.agent_invites add column global boolean not null default false;
