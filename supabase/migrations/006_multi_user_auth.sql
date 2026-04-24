-- ============================================================================
-- Migration 006: Multi-User Auth
-- Adds user ownership to all tables, enables Row-Level Security,
-- creates profiles table, and sets up first-user migration trigger.
-- ============================================================================

-- 1. Profiles table (auto-populated on signup)
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  is_owner boolean default false,
  created_at timestamptz default now()
);

alter table profiles enable row level security;

create policy "anyone_can_read_profiles" on profiles
  for select using (true);

create policy "users_update_own_profile" on profiles
  for update using (id = auth.uid())
  with check (id = auth.uid());

-- 2. Add user_id columns (nullable first — migration fills them)

alter table mb_projects
  add column if not exists user_id uuid references auth.users(id);

alter table mb_releases
  add column if not exists user_id uuid references auth.users(id);

alter table mb_collections
  add column if not exists user_id uuid references auth.users(id);

alter table mb_activity
  add column if not exists user_id uuid references auth.users(id);

alter table mb_favorites
  add column if not exists user_id uuid references auth.users(id);

alter table mb_spotify_auth
  add column if not exists user_id uuid references auth.users(id);

-- 3. Indexes on user_id columns
create index if not exists idx_projects_user_id on mb_projects(user_id);
create index if not exists idx_releases_user_id on mb_releases(user_id);
create index if not exists idx_collections_user_id on mb_collections(user_id);
create index if not exists idx_activity_user_id on mb_activity(user_id);

-- 4. Enable RLS on all tables

alter table mb_projects enable row level security;
alter table mb_versions enable row level security;
alter table mb_releases enable row level security;
alter table mb_collections enable row level security;
alter table mb_collection_items enable row level security;
alter table mb_activity enable row level security;
alter table mb_favorites enable row level security;
alter table mb_feedback enable row level security;
alter table mb_spotify_auth enable row level security;
alter table mb_spotify_links enable row level security;
alter table mb_spotify_stats enable row level security;
alter table mb_press_kits enable row level security;
alter table mb_social_posts enable row level security;
alter table mb_curator_submissions enable row level security;

-- 5. Drop old permissive policies from migration 005
drop policy if exists "Enable all access for all users" on mb_spotify_auth;
drop policy if exists "Enable all access for all users" on mb_spotify_links;
drop policy if exists "Enable all access for all users" on mb_spotify_stats;
drop policy if exists "Enable all access for all users" on mb_favorites;
drop policy if exists "Enable all access for all users" on mb_press_kits;
drop policy if exists "Enable all access for all users" on mb_social_posts;
drop policy if exists "Enable all access for all users" on mb_curator_submissions;

-- 6. RLS Policies

-- mb_projects: owner access only
create policy "users_own_projects" on mb_projects
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- mb_versions: access through project ownership
create policy "users_own_versions" on mb_versions
  for all using (
    project_id in (select id from mb_projects where user_id = auth.uid())
  ) with check (
    project_id in (select id from mb_projects where user_id = auth.uid())
  );

-- mb_versions: public read via share token (for /share/[token] pages)
create policy "public_share_read" on mb_versions
  for select using (share_token is not null);

-- mb_releases: owner access only
create policy "users_own_releases" on mb_releases
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- mb_collections: owner access only
create policy "users_own_collections" on mb_collections
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- mb_collection_items: access through collection ownership
create policy "users_own_collection_items" on mb_collection_items
  for all using (
    collection_id in (select id from mb_collections where user_id = auth.uid())
  ) with check (
    collection_id in (select id from mb_collections where user_id = auth.uid())
  );

-- mb_activity: owner access only
create policy "users_own_activity" on mb_activity
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- mb_favorites: owner access only
create policy "users_own_favorites" on mb_favorites
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- mb_feedback: anyone can insert (public share pages), owner reads
create policy "public_feedback_insert" on mb_feedback
  for insert with check (true);

create policy "owner_reads_feedback" on mb_feedback
  for select using (
    version_id in (
      select v.id from mb_versions v
      join mb_projects p on v.project_id = p.id
      where p.user_id = auth.uid()
    )
  );

-- mb_spotify_auth: owner access only
create policy "users_own_spotify_auth" on mb_spotify_auth
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- mb_spotify_links: access through project ownership
create policy "users_own_spotify_links" on mb_spotify_links
  for all using (
    project_id in (select id from mb_projects where user_id = auth.uid())
  ) with check (
    project_id in (select id from mb_projects where user_id = auth.uid())
  );

-- mb_spotify_stats: access through spotify_links -> project ownership
create policy "users_own_spotify_stats" on mb_spotify_stats
  for all using (
    spotify_link_id in (
      select sl.id from mb_spotify_links sl
      join mb_projects p on sl.project_id = p.id
      where p.user_id = auth.uid()
    )
  ) with check (
    spotify_link_id in (
      select sl.id from mb_spotify_links sl
      join mb_projects p on sl.project_id = p.id
      where p.user_id = auth.uid()
    )
  );

-- mb_press_kits: access through project ownership
create policy "users_own_press_kits" on mb_press_kits
  for all using (
    project_id in (select id from mb_projects where user_id = auth.uid())
  ) with check (
    project_id in (select id from mb_projects where user_id = auth.uid())
  );

-- mb_social_posts: access through project ownership
create policy "users_own_social_posts" on mb_social_posts
  for all using (
    project_id in (select id from mb_projects where user_id = auth.uid())
  ) with check (
    project_id in (select id from mb_projects where user_id = auth.uid())
  );

-- mb_curator_submissions: access through project ownership
create policy "users_own_curator_submissions" on mb_curator_submissions
  for all using (
    project_id in (select id from mb_projects where user_id = auth.uid())
  ) with check (
    project_id in (select id from mb_projects where user_id = auth.uid())
  );

-- 7. First-user trigger: auto-create profile and migrate existing data
create or replace function handle_new_user()
returns trigger as $$
declare
  user_count int;
begin
  -- Create profile for every new user
  insert into profiles (id, display_name, avatar_url, is_owner)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    new.raw_user_meta_data->>'avatar_url',
    false
  );

  -- Check if this is the first user
  select count(*) into user_count from profiles;

  if user_count = 1 then
    -- Mark as owner
    update profiles set is_owner = true where id = new.id;

    -- Migrate all existing data to this user
    update mb_projects set user_id = new.id where user_id is null;
    update mb_releases set user_id = new.id where user_id is null;
    update mb_collections set user_id = new.id where user_id is null;
    update mb_activity set user_id = new.id where user_id is null;
    update mb_favorites set user_id = new.id where user_id is null;
    update mb_spotify_auth set user_id = new.id where user_id is null;
  end if;

  return new;
end;
$$ language plpgsql security definer;

-- Drop trigger if it exists (idempotent)
drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
