-- 034: Smart mix status (2026-08-22)
--
-- The version workflow is now Mix → Master → Finished → Released. The old
-- hand-picked 'WIP' and 'Mix/Master' statuses are retired: a fresh upload's
-- status is detected server-side from its filename ("MIX 3.wav" → 'Mix',
-- "MASTER 2.wav" → 'Master') by src/lib/mix-status.ts, and the app's UI only
-- offers the four current values.
--
-- The column stays plain text (no CHECK constraint) — the app is the authority
-- on the value set, exactly as before, and a constraint would make the next
-- rename a lockstep deploy problem.

-- New rows that somehow skip the API's detection land on the workflow floor.
alter table mb_versions alter column status set default 'Mix';

-- Retrofit the existing catalog with the same smart read the upload route now
-- applies: rows in a retired status become 'Master' when their filename names a
-- master (the word standing alone — "remaster"/"mastering" don't count, matching
-- the app-side parser), otherwise 'Mix'. Finished/Released rows are untouched:
-- those are real statements the artist made, not workflow guesses.
update mb_versions
set status = case
  when audio_filename ~* '(^|[^a-z])master([^a-z]|$)'
    or label ~* '(^|[^a-z])master([^a-z]|$)' then 'Master'
  else 'Mix'
end
where status in ('WIP', 'Mix/Master');
