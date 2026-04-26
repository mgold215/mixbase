-- Migration 007: remove permissive advanced-feature policies left from the
-- single-user era and replace them with per-user/per-project policies.

drop policy if exists "mb_spotify_auth_all" on mb_spotify_auth;
drop policy if exists "mb_spotify_links_all" on mb_spotify_links;
drop policy if exists "mb_spotify_stats_all" on mb_spotify_stats;
drop policy if exists "mb_favorites_all" on mb_favorites;
drop policy if exists "mb_press_kits_all" on mb_press_kits;
drop policy if exists "mb_social_posts_all" on mb_social_posts;
drop policy if exists "mb_curator_submissions_all" on mb_curator_submissions;

drop policy if exists "users_own_spotify_auth" on mb_spotify_auth;
drop policy if exists "users_own_spotify_links" on mb_spotify_links;
drop policy if exists "users_own_spotify_stats" on mb_spotify_stats;
drop policy if exists "users_own_favorites" on mb_favorites;
drop policy if exists "users_own_press_kits" on mb_press_kits;
drop policy if exists "users_own_social_posts" on mb_social_posts;
drop policy if exists "users_own_curator_submissions" on mb_curator_submissions;

create policy "users_own_spotify_auth" on mb_spotify_auth
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "users_own_spotify_links" on mb_spotify_links
  for all using (
    project_id in (select id from mb_projects where user_id = auth.uid())
  ) with check (
    project_id in (select id from mb_projects where user_id = auth.uid())
  );

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

create policy "users_own_favorites" on mb_favorites
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "users_own_press_kits" on mb_press_kits
  for all using (
    project_id in (select id from mb_projects where user_id = auth.uid())
  ) with check (
    project_id in (select id from mb_projects where user_id = auth.uid())
  );

create policy "users_own_social_posts" on mb_social_posts
  for all using (
    project_id in (select id from mb_projects where user_id = auth.uid())
  ) with check (
    project_id in (select id from mb_projects where user_id = auth.uid())
  );

create policy "users_own_curator_submissions" on mb_curator_submissions
  for all using (
    project_id in (select id from mb_projects where user_id = auth.uid())
  ) with check (
    project_id in (select id from mb_projects where user_id = auth.uid())
  );

drop policy if exists "authenticated_insert_own_mf_audio" on storage.objects;
drop policy if exists "authenticated_update_own_mf_audio" on storage.objects;
drop policy if exists "authenticated_delete_own_mf_audio" on storage.objects;
drop policy if exists "authenticated_insert_own_mf_artwork" on storage.objects;
drop policy if exists "authenticated_update_own_mf_artwork" on storage.objects;
drop policy if exists "authenticated_delete_own_mf_artwork" on storage.objects;

create policy "authenticated_insert_own_mf_audio" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'mf-audio'
    and split_part(name, '/', 1) in (select id::text from mb_projects where user_id = auth.uid())
  );

create policy "authenticated_update_own_mf_audio" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'mf-audio'
    and split_part(name, '/', 1) in (select id::text from mb_projects where user_id = auth.uid())
  ) with check (
    bucket_id = 'mf-audio'
    and split_part(name, '/', 1) in (select id::text from mb_projects where user_id = auth.uid())
  );

create policy "authenticated_delete_own_mf_audio" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'mf-audio'
    and split_part(name, '/', 1) in (select id::text from mb_projects where user_id = auth.uid())
  );

create policy "authenticated_insert_own_mf_artwork" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'mf-artwork'
    and split_part(name, '/', 1) in (select id::text from mb_projects where user_id = auth.uid())
  );

create policy "authenticated_update_own_mf_artwork" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'mf-artwork'
    and split_part(name, '/', 1) in (select id::text from mb_projects where user_id = auth.uid())
  ) with check (
    bucket_id = 'mf-artwork'
    and split_part(name, '/', 1) in (select id::text from mb_projects where user_id = auth.uid())
  );

create policy "authenticated_delete_own_mf_artwork" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'mf-artwork'
    and split_part(name, '/', 1) in (select id::text from mb_projects where user_id = auth.uid())
  );
