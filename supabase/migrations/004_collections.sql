-- Collections: playlists, EPs, albums that group projects together
create table if not exists mb_collections (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  type text not null default 'playlist', -- 'playlist', 'ep', 'album'
  artwork_url text,
  release_date date,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Collection items: which projects are in a collection and in what order
create table if not exists mb_collection_items (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references mb_collections(id) on delete cascade,
  project_id uuid not null references mb_projects(id) on delete cascade,
  position int not null default 0,
  created_at timestamptz default now()
);

-- Enable RLS — service-role key (all server-side ops) bypasses RLS entirely.
-- No anon policies needed or desired.
alter table mb_collections enable row level security;
alter table mb_collection_items enable row level security;
