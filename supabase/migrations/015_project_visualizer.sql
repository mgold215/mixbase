-- Project visualizer (Spotify-Canvas style): a project can pin one of its
-- generated visualizer videos (mb_visualizers / mf-video) as THE visualizer.
-- The full player loops it behind the track while it plays, and the project
-- page shows it in the Visualizer tab.
--
-- Mirrors the artwork pattern: mb_visualizers rows are the library,
-- mb_projects.visualizer_url is the chosen "final" one.

alter table mb_projects add column if not exists visualizer_url text;
