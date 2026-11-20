-- 048: the mixing intern's step log.
--
-- `steps` is what a job did, in order, as the helper on the owner's Mac
-- reported it: each stage it reached and what it found or set there
-- ([{ at, text, detail? }]). `changes` stays the short list of moves; this is
-- the whole account, shown on the Mix Check card's Intern tab.
alter table public.mb_intern_jobs add column if not exists steps jsonb not null default '[]'::jsonb;

notify pgrst, 'reload schema';
