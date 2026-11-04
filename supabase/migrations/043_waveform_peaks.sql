-- 043: the real waveform behind the public share player.
--
-- Before this the share page drew a plain progress bar: it carried nothing
-- about the music. GET /api/share/<token>/peaks now decodes a mix once on the
-- server (ffmpeg → mono PCM → 200 peaks, src/lib/waveform-peaks.ts) and keeps
-- the result here, so every later listener gets it in one small read and a
-- 2 GB WAV is never decoded twice — or on a phone.
--
-- Write-once: the route fills a NULL only (.is('waveform_peaks', null) on the
-- UPDATE itself), the same discipline as duration_seconds. A mix's audio never
-- changes (a new mix is a new row), so the value never goes stale.
--
-- jsonb (not text): PostgREST returns it as the array it is.
alter table public.mb_versions
  add column if not exists waveform_peaks jsonb;

notify pgrst, 'reload schema';
