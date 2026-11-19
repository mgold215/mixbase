-- 047: SYNC CATALOG — a collection that music supervisors can pitch from.
--
-- A collection marked is_sync gets a second public address,
-- mixbase.app/sync/<share_token>, laid out for licensing rather than
-- listening: BPM, key, genre and length per track, the instrumental beside the
-- full mix, a download of each, and the one-stop rights line (master and
-- publishing both controlled by the artist's company).
--
-- The flag is the gate. Every shared album link already carries a share_token;
-- without the flag, rewriting /album/... to /sync/... would hand anyone holding
-- an ordinary album link the instrumentals and downloads of every song in it.
-- /sync/<token> answers 404 unless the collection is marked.

alter table public.mb_collections
  add column if not exists is_sync boolean not null default false;

notify pgrst, 'reload schema';
