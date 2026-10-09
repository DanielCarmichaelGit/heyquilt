-- The GitHub account a person connected through Quilt's GitHub App (src/api/routes/github.js).
-- The relay commits agents' work to a repository only when the session owner's GitHub account
-- may write to it. Only the API reads and writes this table (service role).
create table public.github_links (
  user_id uuid primary key references auth.users (id) on delete cascade,
  github_id bigint not null,
  login text not null check (char_length(login) between 1 and 100),
  linked_at timestamptz not null default now()
);
alter table public.github_links enable row level security;
