-- 042: THUMB DRIVE — every account's built-in "all my songs" playlist.
--
-- The idea: an artist should be able to hand someone ALL of their songs with
-- one link. THUMB DRIVE is an ordinary mb_collections playlist (so the web
-- collection page, the public /album/... share player, the iOS app and the
-- tracklist export all work on it unchanged) with one difference: the server
-- keeps it filled.
--
--   * every account has exactly one (created here for existing accounts, and
--     on demand for new ones by ensureThumbDrive in src/lib/thumb-drive.ts);
--   * a song is added — at the top — when its FIRST mix is uploaded
--     (POST /api/versions, the only version write path, web and iOS);
--   * it always plays each song's NEWEST mix. Nothing has to be rewritten when
--     a new version lands: collection items point at the song (project), and
--     every player resolves the highest version_number at play time.
--
-- The artist can still remove, reorder or add songs by hand; a removed song is
-- not forced back in by a later mix. Delete, rename and type changes are
-- refused by /api/collections/[id] and hidden in both clients.
--
-- is_thumb_drive marks the row. The partial unique index makes "one per
-- account" a database fact, so two racing first-requests can't mint two.

alter table public.mb_collections
  add column if not exists is_thumb_drive boolean not null default false;

create unique index if not exists idx_collections_one_thumb_drive
  on public.mb_collections(user_id) where is_thumb_drive;

-- One THUMB DRIVE per existing account.
insert into public.mb_collections (user_id, title, type, is_thumb_drive)
select p.id, 'THUMB DRIVE', 'playlist', true
from public.profiles p
where exists (select 1 from auth.users u where u.id = p.id)
  and not exists (
    select 1 from public.mb_collections c where c.user_id = p.id and c.is_thumb_drive
  );

-- Fill each still-empty THUMB DRIVE with the account's songs that have at least
-- one uploaded mix, newest song first (position 0 = top). Songs with no audio
-- yet have nothing to play and join when their first mix is uploaded. The
-- "still empty" guard keeps a re-run from duplicating anything.
insert into public.mb_collection_items (collection_id, project_id, position)
select c.id,
       pr.id,
       (row_number() over (partition by c.id order by pr.created_at desc nulls last, pr.id) - 1)::int
from public.mb_collections c
join public.mb_projects pr on pr.user_id = c.user_id
where c.is_thumb_drive
  and exists (select 1 from public.mb_versions v where v.project_id = pr.id)
  and not exists (select 1 from public.mb_collection_items i where i.collection_id = c.id);

notify pgrst, 'reload schema';
