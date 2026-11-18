-- 046: the mixing intern's jobs.
--
-- One row is one request to fix a mix: the owner taps "Hand to the intern" on
-- a mix (POST /api/versions/<id>/intern), the mixBASE Mac app claims the job
-- (POST /api/intern/jobs/claim), works on a copy of the Logic project, reports
-- each stage (PATCH /api/intern/jobs/<id>) and finishes with the new version
-- it uploaded. `notes` is what it was asked to fix, as the notes stood when
-- the job was made; `changes` is what it did, move by move.
--
-- Written by the server only (no client insert/update/delete policy); the
-- owner can read their own rows.
create table if not exists public.mb_intern_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.mb_projects(id) on delete cascade,
  version_id uuid not null references public.mb_versions(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'working', 'done', 'failed', 'cancelled')),
  stage text,
  notes jsonb not null default '[]'::jsonb,
  changes jsonb not null default '[]'::jsonb,
  result_version_id uuid references public.mb_versions(id) on delete set null,
  error text,
  device text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  heartbeat_at timestamptz,
  finished_at timestamptz
);

create index if not exists mb_intern_jobs_user_status on public.mb_intern_jobs (user_id, status, created_at);
create index if not exists mb_intern_jobs_version on public.mb_intern_jobs (version_id, created_at desc);
-- One job in flight per mix.
create unique index if not exists mb_intern_jobs_one_active
  on public.mb_intern_jobs (version_id) where status in ('queued', 'working');

alter table public.mb_intern_jobs enable row level security;

drop policy if exists "users_read_own_intern_jobs" on public.mb_intern_jobs;
create policy "users_read_own_intern_jobs" on public.mb_intern_jobs
  for select using (user_id = auth.uid());

notify pgrst, 'reload schema';
