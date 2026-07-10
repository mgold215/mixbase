-- 019: Collection-level share token — powers the public /share/album/<token>
-- player. Same shape as the project token (012): stable per collection, so a
-- shared album link keeps working as tracks are added, removed, or re-mixed.

alter table mb_collections
  add column if not exists share_token text unique default replace(gen_random_uuid()::text, '-', '');

-- Back-fill any existing collections that don't have a token yet
update mb_collections
set share_token = replace(gen_random_uuid()::text, '-', '')
where share_token is null;

create index if not exists idx_collections_share_token on mb_collections(share_token);
