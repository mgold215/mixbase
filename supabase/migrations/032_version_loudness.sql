-- 032: per-version loudness — persist the BS.1770-4 measurement on mb_versions.
--
-- ⚠️ WRITTEN BUT NOT APPLIED. Apply/verify/rollback steps are at the bottom.
-- Railway deploys the moment a PR merges but migrations here are applied by
-- hand, so the code always lands first; src/lib/schema-heal.ts carries these
-- same idempotent ALTERs as a runtime heal (ensureVersionLoudnessColumns) and
-- POST /api/versions/[id]/loudness retries through it. Without that heal the
-- feature is dead on arrival, because PostgREST rejects the ENTIRE update when
-- one referenced column is missing.
--
-- WHY
-- src/lib/loudness.ts has measured integrated loudness since the master-check
-- shipped, but the number only ever lived in the browser's localStorage: it died
-- on a device switch, a cleared cache, or a second browser, and no two versions
-- could ever be compared. Persisting it per version turns a one-shot reading
-- into a history — "v7 is 3.0 dB louder than v6, but the loudest 3 s only moved
-- 0.4 dB" — which is the comparison a DAW structurally cannot make, because a
-- DAW only ever has one bounce in front of it.
--
-- SHAPE
-- Nullable, no defaults, and NO BACKFILL, on purpose. A measurement is seconds
-- of CPU over the fully decoded audio, so it can only ever come from a user
-- pressing "Measure loudness"; NULL means "never measured", which is a real and
-- permanent state that must stay distinguishable from a measured value.
-- `real` (float4, ~7 significant digits) is far more precision than a figure
-- rendered to one decimal place can use.
-- Silence measures as -Infinity in LoudnessMeasurement; the API stores NULL for
-- that rather than a float4 infinity, so "unmeasurable" and "not measured" read
-- the same to every downstream consumer instead of poisoning arithmetic.
-- loudness_algo records WHICH implementation produced the row, so a future
-- correction to the K-weighting or the gating can be identified and re-measured
-- rather than silently averaged with the old generation inside one delta.
--
-- Additive only, and iOS Codable ignores unknown JSON keys, so shipped app
-- builds are unaffected.

alter table mb_versions add column if not exists loudness_lufs            real;
alter table mb_versions add column if not exists loudness_short_term_lufs real;
alter table mb_versions add column if not exists sample_peak_db           real;
alter table mb_versions add column if not exists loudness_measured_at     timestamptz;
alter table mb_versions add column if not exists loudness_algo            text;

-- PostgREST caches the schema. Without this nudge the first write after the
-- ALTER still fails with "column not found in schema cache" (PGRST204).
notify pgrst, 'reload schema';

-- APPLY: run this file as-is in the Supabase SQL editor. Every statement is
-- idempotent, so it is safe to re-run and safe to run after the runtime heal has
-- already added the columns.
--
-- VERIFY (expect five rows, all is_nullable = YES, no column_default):
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_name = 'mb_versions'
--     and column_name in ('loudness_lufs', 'loudness_short_term_lufs',
--                         'sample_peak_db', 'loudness_measured_at', 'loudness_algo')
--   order by column_name;
--
-- SMOKE TEST: open a project, press "Measure loudness" on the current mix, then
-- hard-reload. The reading must still be on screen (it now comes from the row,
-- not localStorage). Measure a second mix and the delta line appears.
--
-- ROLLBACK (destroys every stored measurement — recoverable only by each user
-- pressing the button again on each mix):
--   alter table mb_versions
--     drop column if exists loudness_lufs,
--     drop column if exists loudness_short_term_lufs,
--     drop column if exists sample_peak_db,
--     drop column if exists loudness_measured_at,
--     drop column if exists loudness_algo;
--   notify pgrst, 'reload schema';
