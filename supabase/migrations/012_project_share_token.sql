-- 012: Add project-level share token so shared links always resolve to the latest mix.
-- Each project gets a stable token. /share/[token] will look up the project
-- and serve whichever version is newest — so old links always play the current mix.

alter table mb_projects
  add column if not exists share_token text unique default replace(gen_random_uuid()::text, '-', '');

-- Back-fill any existing projects that don't have a token yet
update mb_projects
set share_token = replace(gen_random_uuid()::text, '-', '')
where share_token is null;

create index if not exists idx_projects_share_token on mb_projects(share_token);
