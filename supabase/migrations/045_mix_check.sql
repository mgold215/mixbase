-- 045: Mix Check — a measured report on a mix, and the reference tracks it is
-- judged against.
--
-- mb_versions.mix_check holds what POST /api/versions/<id>/mix-check measured
-- (src/lib/mix-check.ts) and concluded (src/lib/mix-check-findings.ts): a small
-- `summary` every other mix is compared with, the per-second `detail` the
-- report draws, and the `findings` that were written into the mix notes. A
-- mix's audio never changes (a new mix is a new row), so the measurement never
-- goes stale; the findings are replaced when the check is run again.
--
-- mb_mix_references holds commercial tracks per genre family as MEASUREMENTS
-- ONLY — the audio is never stored. user_id NULL is the shared set every song
-- is compared with; a row carrying a user_id is a track that artist added
-- from a full-quality file, which then stands in for a preview-measured row of
-- the same track. Written by the server only (no client insert/update/delete
-- policy); an artist can read their own rows.
alter table public.mb_versions
  add column if not exists mix_check jsonb;

create table if not exists public.mb_mix_references (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  family text not null,
  artist text not null,
  title text not null,
  source text not null check (source in ('preview', 'full')),
  summary jsonb not null,
  created_at timestamptz not null default now()
);

create unique index if not exists mb_mix_references_track
  on public.mb_mix_references (coalesce(user_id::text, ''), family, lower(artist), lower(title));

alter table public.mb_mix_references enable row level security;

drop policy if exists "users_read_own_mix_references" on public.mb_mix_references;
create policy "users_read_own_mix_references" on public.mb_mix_references
  for select using (user_id = auth.uid());

notify pgrst, 'reload schema';
