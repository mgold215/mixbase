-- 026: DistroKid submission metadata + waterfall release sequencing.
-- Everything DistroKid's upload form asks for lives on the release row, so the
-- pipeline can generate a copy-ready submission sheet and validate readiness.
-- All statements are additive/idempotent (safe to re-run; iOS Codable ignores
-- unknown keys, so extra columns don't break the native app).

alter table mb_releases add column if not exists artist_name      text;
alter table mb_releases add column if not exists release_type     text not null default 'single';
alter table mb_releases add column if not exists featured_artists text;
alter table mb_releases add column if not exists songwriters      text;
alter table mb_releases add column if not exists producers        text;
alter table mb_releases add column if not exists explicit         boolean not null default false;
alter table mb_releases add column if not exists instrumental     boolean not null default false;
alter table mb_releases add column if not exists language         text not null default 'English';
alter table mb_releases add column if not exists secondary_genre  text;
alter table mb_releases add column if not exists version_info     text;
alter table mb_releases add column if not exists upc              text;

-- Waterfall sequencing: releases sharing a waterfall_group_id form one run;
-- waterfall_position is 1-based in drop order (1 = the first single). The
-- DistroKid release for position N re-releases tracks 1..N-1 under their
-- original ISRCs, with the new track on top.
alter table mb_releases add column if not exists waterfall_group_id uuid;
alter table mb_releases add column if not exists waterfall_position integer;

create index if not exists idx_releases_waterfall_group
  on mb_releases(waterfall_group_id, waterfall_position);
