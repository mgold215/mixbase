-- ============================================================================
-- 013_submitbase_curators.sql
-- SubmitBase tab: submit a mixBASE song directly to a directory of curators.
--
-- ADDITIVE ONLY — creates two new tables (sb_curators, sb_submissions) and
-- touches NO existing tables. Songs come from mb_projects / mb_versions; the
-- listening link sent to curators is the existing /share/<token> link.
--
-- NOTE: the legacy public.curators table (int PK, used by the older outreach
-- automation) is intentionally left untouched. This researched directory lives
-- in its own sb_curators table so VERIFIED/UNVERIFIED + channel data survive.
-- ============================================================================

-- ===== TABLES =====
create table if not exists sb_curators (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),   -- NULL = shared starter directory
  name text not null,
  type text check (type in ('playlist','label','blog','radio','influencer','other')),
  platform text,
  genres text[],
  contact_method text check (contact_method in ('email','instagram','twitter','soundcloud','form','other')),
  contact_value text,            -- an email address OR a URL/handle
  audience_size int,
  accepts_submissions boolean default true,
  guidelines text,
  confidence text check (confidence in ('VERIFIED','UNVERIFIED')) default 'VERIFIED',
  source_url text,               -- where the channel was found (for the user to confirm)
  notes text,                    -- user's own private notes
  last_contacted timestamptz,
  created_at timestamptz default now()
);

create table if not exists sb_submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  project_id uuid references mb_projects(id) on delete cascade,   -- the mixBASE song
  version_id uuid references mb_versions(id) on delete set null,  -- optional specific mix
  curator_id uuid references sb_curators(id) on delete cascade,
  channel text check (channel in ('email','form','social','spotify')),
  message text,
  share_url text,                -- the /share/<token> link sent to the curator
  status text check (status in ('draft','sent','opened','responded','accepted','rejected','no_response')) default 'draft',
  response_notes text,
  sent_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists sb_submissions_user_idx on sb_submissions(user_id);
create index if not exists sb_submissions_project_idx on sb_submissions(project_id);
create index if not exists sb_submissions_curator_idx on sb_submissions(curator_id);

-- ===== ROW LEVEL SECURITY =====
-- (The app talks to these via service-role API routes scoped by user_id, but we
--  enable RLS for defense-in-depth, matching migration 005's convention.)
alter table sb_curators enable row level security;
alter table sb_submissions enable row level security;

-- Owner sees their own curators PLUS the shared starter directory (user_id IS NULL).
drop policy if exists "sb read curators" on sb_curators;
create policy "sb read curators" on sb_curators for select
  using (user_id = auth.uid() or user_id is null);
drop policy if exists "sb insert own curators" on sb_curators;
create policy "sb insert own curators" on sb_curators for insert
  with check (user_id = auth.uid());
drop policy if exists "sb update own curators" on sb_curators;
create policy "sb update own curators" on sb_curators for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "sb delete own curators" on sb_curators;
create policy "sb delete own curators" on sb_curators for delete
  using (user_id = auth.uid());

drop policy if exists "sb own submissions" on sb_submissions;
create policy "sb own submissions" on sb_submissions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ===== PRELOADED CURATOR DIRECTORY (researched + verified — insert verbatim) =====
-- columns: user_id, name, type, platform, genres, contact_method, contact_value, accepts_submissions, guidelines, confidence, source_url
-- Idempotent: refresh only the shared starter directory (user_id IS NULL) on re-run.
delete from sb_curators where user_id is null;

-- ---- HOUSE / MELODIC / DEEP / PROGRESSIVE / TECH / ORGANIC HOUSE ----
insert into sb_curators (user_id, name, type, platform, genres, contact_method, contact_value, accepts_submissions, guidelines, confidence, source_url) values
(null,'Defected','label','LabelRadar',ARRAY['house','deep house','tech house'],'form','https://www.labelradar.com/labels/defected/portal',true,'Free via LabelRadar; covers all sub-labels (DFTD, Glitterbox, Classic, Nu Groove).','VERIFIED','https://www.labelradar.com/labels/defected/portal'),
(null,'Toolroom','label','web',ARRAY['tech house','house'],'form','https://toolroomrecords.com/demos/',true,'Upload via the demos page; they listen to everything and reply only if interested.','VERIFIED','https://toolroomrecords.com/demos/'),
(null,'Spinnin'' Records','label','web',ARRAY['house','tech house'],'form','https://spinninrecords.com/talentpool',true,'Free upload via Talent Pool; also has a LabelRadar portal.','VERIFIED','https://spinninrecords.com/talentpool'),
(null,'Armada Music','label','web',ARRAY['house','progressive house','trance'],'form','https://demodrop.armadamusic.com/',true,'Free Drop Your Demo route; a paid feedback option exists separately.','VERIFIED','https://demodrop.armadamusic.com/'),
(null,'Hot Creations','label','SoundCloud',ARRAY['tech house','house'],'soundcloud','https://soundcloud.com/hotcreationsdemos',true,'All demos must be uploaded PRIVATELY to SoundCloud with your contact details.','VERIFIED','https://soundcloud.com/hotcreationsdemos'),
(null,'Repopulate Mars','label','web',ARRAY['tech house','house'],'form','https://www.repopulatemars.com/demos',true,'Send private SoundCloud links only; non-private demos are not considered.','VERIFIED','https://www.repopulatemars.com/demos'),
(null,'Dirtybird','label','Label-Worx',ARRAY['tech house','house','bass house'],'form','https://www.label-worx.com/demo/dirtybird',true,'Upload via DemoBox; you are contacted only if they want to sign it.','VERIFIED','https://www.label-worx.com/demo/dirtybird'),
(null,'Glasgow Underground','label','web',ARRAY['house','deep house','tech house'],'email','music@glasgowunderground.com',true,'Private downloadable SoundCloud/Dropbox link; best tracks first; all listened, not all answered.','VERIFIED','https://www.glasgowunderground.com/contact'),
(null,'Cr2 Records','label','web',ARRAY['house','tech house','progressive house'],'form','https://cr2records.com/demos1/',true,'Email private SoundCloud links, no mp3 attachments, best tracks first.','VERIFIED','https://cr2records.com/demos1/'),
(null,'Realm Records','label','web',ARRAY['house','melodic house'],'form','https://tstack.app/realmrecords/send',true,'Gorgon City''s house label; portal listed in its own SoundCloud bio.','VERIFIED','https://soundcloud.com/realmrecs'),
(null,'Anjunadeep','label','web',ARRAY['deep house','melodic house','progressive house','organic house'],'form','https://anjunadeep.com/demo-submission',true,'Reviewed at Anjuna HQ; 320kbps mp3 or a SoundCloud download link.','VERIFIED','https://anjunadeep.com/demo-submission'),
(null,'Anjunabeats','label','LabelRadar',ARRAY['progressive house','trance'],'form','https://www.labelradar.com/labels/anjunabeats/portal',true,'Free via LabelRadar (official partner).','VERIFIED','https://www.labelradar.com/labels/anjunabeats/portal'),
(null,'Colorize (Enhanced)','label','web',ARRAY['melodic house','progressive house','deep house'],'form','https://labels.demmo.link/colorize/submit',true,'Submit via the Demmo portal; general contact info@colorizemusic.com.','VERIFIED','https://www.colorizemusic.com/'),
(null,'Last Night On Earth','label','SoundCloud',ARRAY['progressive house','melodic house'],'email','demos@lnoearth.com',true,'Sasha''s label; demos to this address per official bio.','VERIFIED','https://soundcloud.com/last-night-on-earth'),
(null,'Stil vor Talent','label','SoundCloud',ARRAY['melodic house','melodic techno'],'email','demo@stilvortalent.de',true,'Demos ONLY to this address; booking and general contacts are separate.','VERIFIED','https://soundcloud.com/stilvortalent'),
(null,'Get Physical Music','label','LabelRadar',ARRAY['house','melodic house'],'form','https://www.labelradar.com/labels/getphysical/portal',true,'Demo submissions ONLY via this LabelRadar link.','VERIFIED','https://soundcloud.com/get-physical-music'),
(null,'YHV Records','label','web',ARRAY['organic house','melodic house','progressive house','afro house'],'email','demos@yhvmusic.group',true,'Email or the Label-Engine form; high volume; general yhvrecords@yhvmusic.group.','VERIFIED','https://www.yhvmusic.group/demo-submission'),
(null,'Tanzgemeinschaft','label','LabelRadar',ARRAY['melodic house','deep house','organic house','afro house'],'form','https://www.labelradar.com/labels/Tanzgemeinschaft/portal',true,'Uses LabelRadar for demos; underground/emotive focus.','VERIFIED','https://www.tanzgemeinschaft.com/demo-submission'),
(null,'HMWL (House Music With Love)','playlist','web',ARRAY['afro house','organic house','deep house','melodic house'],'form','https://www.housemusicwithlove.com/submit-a-hmwl-premiere-or-upload/',true,'Premiere/blog review form; large follower reach.','VERIFIED','https://www.housemusicwithlove.com/submit-a-hmwl-premiere-or-upload/'),
(null,'MelodicDeep','influencer','YouTube',ARRAY['deep house','tech house','melodic house','afro house'],'email','promo@melodicdeep.com',true,'Deep house / tech house / techno only; other genres are not answered.','VERIFIED','https://www.youtube.com/@MelodicDeepAmsterdam'),
(null,'Deep House Amsterdam','blog','web',ARRAY['deep house','house'],'form','https://www.deephouseamsterdam.com/contact/',true,'Include a SoundCloud link (not Dropbox); know DHA AM vs FM channels.','VERIFIED','https://www.deephouseamsterdam.com/contact/'),
(null,'When We Dip','blog','Spotify',ARRAY['organic house','melodic house','deep house','tech house'],'form','https://sbmt.to/when-we-dip',true,'Submit link in the official Spotify playlist description; confirm the free tier on the landing page.','VERIFIED','https://open.spotify.com/playlist/0vg01XrTn6sQZErvZIzdEO'),
(null,'Droid9 Recordings','label','web',ARRAY['progressive house','deep house','melodic house','melodic techno'],'form','https://bit.ly/droid9demos',true,'Form linked from own socials; also a LabelRadar portal.','VERIFIED','https://soundcloud.com/droid9recordings'),
(null,'DeepClass Records','label','web',ARRAY['deep house','tech house','chillout'],'form','https://www.deepclassrecords.com/submit-your-demo/',true,'On-site form ONLY; feedback given to all; no EDM.','VERIFIED','https://www.deepclassrecords.com/submit-your-demo/'),
(null,'Atlantic Progression','label','web',ARRAY['progressive house','electronica','breaks'],'email','atlanticprogression.demos@gmail.com',true,'Progressive / electronica / underground dance.','VERIFIED','https://atlanticprogression.com/label/'),
(null,'Stripped Recordings','label','LabelRadar',ARRAY['house','deep house','tech house'],'form','https://www.labelradar.com/labels/strippedmusic/portal',true,'Free via LabelRadar.','VERIFIED','https://www.labelradar.com/labels/strippedmusic/portal'),
(null,'MK837','label','web',ARRAY['house','tech house','deep house','progressive house'],'form','https://mk837.com/demo-submission',true,'Unsigned/unreleased only; private SoundCloud links; compilation slots common.','VERIFIED','https://mk837.com/demo-submission'),
(null,'Solid Grooves','label','LabelRadar',ARRAY['tech house'],'form','https://www.labelradar.com/labels/solidgrooves/portal',true,'Free via LabelRadar; own-site demo page not confirmed.','UNVERIFIED','https://www.labelradar.com/labels/solidgrooves/portal'),
(null,'Saved Records','label','LabelRadar',ARRAY['tech house','house'],'form','https://www.labelradar.com/labels/SavedRecords/portal',true,'Free via LabelRadar; own-site demo page not confirmed.','UNVERIFIED','https://www.labelradar.com/labels/SavedRecords/portal'),
(null,'microcastle','label','web',ARRAY['progressive house','melodic house'],'email','microcastlemusic@gmail.com',true,'Found only on a third-party aggregator — confirm before sending.','UNVERIFIED','https://labelsbase.net/microcastle'),
(null,'Progressive House Worldwide','label','web',ARRAY['progressive house','trance'],'email','demos@progressivehouseworldwide.com',true,'Third-party listing only — confirm before sending.','UNVERIFIED','https://labelsbase.net/progressive-house-worldwide');

-- ---- DRUM & BASS / LIQUID / MELODIC DnB ----
insert into sb_curators (user_id, name, type, platform, genres, contact_method, contact_value, accepts_submissions, guidelines, confidence, source_url) values
(null,'Hospital Records','label','Label-Engine',ARRAY['drum and bass','liquid dnb'],'form','https://hospitalrecords.label-engine.com/demos',true,'Provide info and select up to 5 tracks; reviewed and contacted by email.','VERIFIED','https://hospitalrecords.label-engine.com/demos'),
(null,'Liquicity','label','web',ARRAY['liquid dnb','melodic dnb'],'form','https://liquicity.com/demo/',true,'Use the form for all submissions; every track is listened to, no guaranteed reply.','VERIFIED','https://liquicity.com/demo/'),
(null,'Viper Recordings','label','LabelRadar',ARRAY['drum and bass'],'form','https://viperrecordings.co.uk/demos/',true,'LabelRadar portal linked from own site.','VERIFIED','https://viperrecordings.co.uk/demos/'),
(null,'Spearhead Records','label','Label-Engine',ARRAY['liquid dnb','drum and bass'],'form','https://spearheadrecords.label-engine.com/demos',true,'Up to 5 tracks; contacted by email (BCee''s label).','VERIFIED','https://www.facebook.com/SpearheadRecords/'),
(null,'V Recordings','label','web',ARRAY['drum and bass'],'form','https://www.vrecordings.com/content/demos',true,'Covers V, Liquid V, Chronic, Philly Blunt; old email bounces — use the form.','VERIFIED','https://www.vrecordings.com/content/demos'),
(null,'RAM Records','label','SoundCloud',ARRAY['drum and bass'],'email','info@ramrecords.com',true,'Send secret/private tracks; 1-2 best tracks; per official SoundCloud bio.','VERIFIED','https://soundcloud.com/ramrecords'),
(null,'Soulvent Records','label','Label-Engine',ARRAY['liquid dnb','drum and bass'],'form','https://soulventrecords.label-engine.com/demos',true,'Up to 5 tracks.','VERIFIED','https://soundcloud.com/soulventrecords'),
(null,'UKF / Pilot Records','label','web',ARRAY['drum and bass','dubstep','bass'],'form','https://ukf.com/submit-your-demo/',true,'Single UKF/Pilot form; join the Discord first; don''t email support.','VERIFIED','https://ukf.com/submit-your-demo/'),
(null,'Fokuz Recordings','label','web',ARRAY['liquid dnb','soulful dnb'],'email','marco@triplevision.nl',true,'Powered by Triple Vision; also a contact form on site.','VERIFIED','https://fokuzrecordings.com/contact/'),
(null,'OX Recordings','label','web',ARRAY['liquid dnb','neurofunk'],'email','demos@oxrecordings.com',true,'Private full-song link (not a clip); brief intro; no attachments; DnB only.','VERIFIED','https://oxrecordings.com/contacts/'),
(null,'DivisionBass Digital','label','web',ARRAY['drum and bass','dubstep','house'],'email','demos@divisionbassdigital.com',true,'SoundCloud links plus profile and bio; subject Demo Submission; originals only.','VERIFIED','https://www.divisionbassdigital.com/demos.htm'),
(null,'Vandal Records','label','SoundCloud',ARRAY['liquid dnb','deep dnb'],'email','vandalrecordshq@gmail.com',true,'Contact/demo per official SoundCloud bio; active 2024.','VERIFIED','https://soundcloud.com/vandal-records'),
(null,'Rush Records','label','SoundCloud',ARRAY['drum and bass'],'email','Demos@rushrecordshq.uk',true,'All demos to this address per own bio.','VERIFIED','https://soundcloud.com/rush-records-dnb'),
(null,'Nex Gen Music Group','label','web',ARRAY['bass music','drum and bass','dubstep'],'form','https://nexgen.music/demos',true,'4+ best tracks; 320kbps/WAV; unreleased originals; no SoundCloud profile links.','VERIFIED','https://nexgen.music/demos'),
(null,'DNBB Records','label','web',ARRAY['drum and bass'],'form','https://www.dnbbrecords.com/demos',true,'Accepts all electronic music.','VERIFIED','https://www.dnbbrecords.com/demos'),
(null,'Shogun Audio','label','Label-Engine',ARRAY['drum and bass'],'email','shogunaudio@label-engine.com',true,'Forum-sourced; LabelRadar partner — confirm before sending.','UNVERIFIED','https://www.dogsonacid.com/threads/how-to-send-tunes-to-labels.793042/'),
(null,'Soul Deep Recordings','label','web',ARRAY['liquid dnb','jazzy dnb'],'email','souldeeprecordings@hotmail.com',true,'Forum-sourced — confirm before sending.','UNVERIFIED','https://www.dogsonacid.com/threads/how-to-send-tunes-to-labels.793042/'),
(null,'Inform Records','label','web',ARRAY['liquid dnb','drum and bass'],'email','demos@informrecords.co.uk',true,'Forum-sourced — confirm before sending.','UNVERIFIED','https://www.dogsonacid.com/threads/how-to-send-tunes-to-labels.793042/'),
(null,'Terabyte Records','label','web',ARRAY['drum and bass'],'email','general@terabyterecords.co.uk',true,'Forum-sourced — confirm before sending.','UNVERIFIED','https://www.dogsonacid.com/threads/how-to-send-tunes-to-labels.793042/'),
(null,'Atmomatix Records','label','web',ARRAY['drum and bass'],'email','demos@atmomatix-records.com',true,'Forum-sourced — confirm before sending.','UNVERIFIED','https://www.dogsonacid.com/threads/how-to-send-tunes-to-labels.793042/'),
(null,'Silent Audio','label','web',ARRAY['drum and bass'],'email','demos@silentaudio.uk',true,'Forum-sourced; label active — confirm before sending.','UNVERIFIED','https://www.dogsonacid.com/threads/how-to-send-tunes-to-labels.793042/'),
(null,'Intrigue Music','label','web',ARRAY['drum and bass'],'email','demobox@intrigue.org.uk',true,'Forum-sourced — confirm before sending.','UNVERIFIED','https://www.dogsonacid.com/threads/how-to-send-tunes-to-labels.793042/');

-- ---- RIDDIM / DUBSTEP / BASS MUSIC ----
insert into sb_curators (user_id, name, type, platform, genres, contact_method, contact_value, accepts_submissions, guidelines, confidence, source_url) values
(null,'Circus Records','label','LabelRadar',ARRAY['dubstep','bass'],'form','https://www.labelradar.com/labels/circusrecords/portal',true,'Demos via LabelRadar only; covers Circus Electric and DPMO.','VERIFIED','https://circus-records.co.uk/about/'),
(null,'Monstercat','label','web',ARRAY['bass','dubstep','electronic'],'form','https://www.monstercat.com/contact-us',true,'They listen to every demo; submit only your best original work; Uncaged is the heavy side.','VERIFIED','https://www.monstercat.com/contact-us'),
(null,'Wakaan','label','SoundCloud',ARRAY['bass','experimental bass'],'email','Chloe@wakaan.com',true,'Per official SoundCloud bio (Liquid Stranger''s label).','VERIFIED','https://soundcloud.com/wakaan'),
(null,'Deadbeats','label','SoundCloud',ARRAY['bass','dubstep'],'form','http://bit.ly/Demos4Deadbeats',true,'Zeds Dead''s label; portal per official bio.','VERIFIED','https://soundcloud.com/deadbeatsrecords'),
(null,'SubCarbon Records','label','Bandcamp',ARRAY['dubstep','bass'],'email','submissions@subcarbon.be',true,'No SoundCloud messages; email only; Ganja White Night''s label.','VERIFIED','https://subcarbonrecords.bandcamp.com/'),
(null,'Riddim Network','label','LabelRadar',ARRAY['riddim','dubstep'],'form','https://www.labelradar.com/labels/riddimnetwork/portal',true,'Free via LabelRadar.','VERIFIED','https://www.labelradar.com/labels/riddimnetwork/portal'),
(null,'ShiftAxis Records','label','web',ARRAY['dubstep','drum and bass','future bass'],'form','http://shiftaxisrecords.com/demo-submission/',true,'Private SoundCloud link, 320kbps full-length, download enabled, no WIPs.','VERIFIED','http://shiftaxisrecords.com/demo-submission/'),
(null,'Bassrush (Insomniac)','label','LabelRadar',ARRAY['dubstep','drum and bass','bass'],'form','https://www.labelradar.com/labels/insomniac/portal',true,'Via the Insomniac LabelRadar portal.','VERIFIED','https://www.labelradar.com/labels/insomniac/portal'),
(null,'Jadu Dala','label','LabelRadar',ARRAY['dubstep','drum and bass','trap'],'form','https://www.labelradar.com/labels/jadudala/portal',true,'Via LabelRadar.','VERIFIED','https://www.labelradar.com/labels/jadudala/portal'),
(null,'DPMO','label','LabelRadar',ARRAY['riddim','dubstep'],'form','https://www.labelradar.com/labels/circusrecords/portal',true,'Via the Circus family LabelRadar portal (FuntCase).','VERIFIED','https://circus-records.co.uk/about/'),
(null,'Disciple','label','web',ARRAY['dubstep','riddim','bass','trap'],'email','demos@disciplerecs.com',true,'Aggregator-sourced; also an ArtistEngine portal — confirm before sending.','UNVERIFIED','https://labelsbase.net/disciple-recordings'),
(null,'Kannibalen','label','web',ARRAY['bass','dubstep','electro'],'email','promo@kannibalenrecords.com',true,'Aggregator-sourced — confirm before sending.','UNVERIFIED','https://labelsbase.net/kannibalen-records'),
(null,'Cyclops Recordings','label','web',ARRAY['riddim','dubstep','experimental bass'],'form','https://cyclopsrecordings.net/contact/',true,'Contact page exists; exact email unconfirmed (Subtronics'' label) — confirm before sending.','UNVERIFIED','https://cyclopsrecordings.net/contact/');

-- ---- BLOGS / RADIO / PLAYLISTS (cross-genre) ----
insert into sb_curators (user_id, name, type, platform, genres, contact_method, contact_value, accepts_submissions, guidelines, confidence, source_url) values
(null,'Run The Trap','blog','web',ARRAY['trap','bass','dubstep','edm','house'],'email','rttsubmit@gmail.com',true,'Email a PRIVATE SoundCloud link, no attachments, no social DMs; reply within ~3 days only if interested.','VERIFIED','https://runthetrap.com/contact-us/'),
(null,'EARMILK','blog','web',ARRAY['electronic','edm','bass'],'form','https://earmilk.com/submit-music/',true,'SubmitHub or Pillargram only (SubmitHub has a free tier).','VERIFIED','https://earmilk.com/submit-music/'),
(null,'Magnetic Magazine','blog','web',ARRAY['electronic','house','techno'],'form','https://www.magneticmag.com/page/submissions/',true,'Use the submissions page; finished tracks only.','VERIFIED','https://www.magneticmag.com/page/submissions/'),
(null,'This Song Is Sick','blog','web',ARRAY['electronic','bass'],'form','https://www.submithub.com/blog/thissongissick-com',true,'Via SubmitHub (free tier available).','VERIFIED','https://www.submithub.com/blog/thissongissick-com'),
(null,'That Drop','blog','web',ARRAY['edm','electronic'],'email','info@thatdrop.com',true,'Submissions via email.','VERIFIED','https://thatdrop.com/submit/'),
(null,'EDM Sauce','blog','web',ARRAY['edm','dance'],'form','https://www.edmsauce.com/submit-your-track/',true,'On-site form; verify free vs paid before submitting.','VERIFIED','https://www.edmsauce.com/submit-your-track/'),
(null,'FUXWITHIT','blog','web',ARRAY['trap','bass','electronic'],'form','https://fuxwithit.com/',true,'On-site form; ~500 submissions/month; personalize it.','VERIFIED','https://fuxwithit.com/'),
(null,'Your EDM','blog','web',ARRAY['edm','electronic'],'form','https://www.youredm.com/contact-us/',true,'Music Review Submission Form on the contact page.','VERIFIED','https://www.youredm.com/contact-us/');

-- ---- SPOTIFY EDITORIAL (the one free way to reach Spotify's own editors) ----
insert into sb_curators (user_id, name, type, platform, genres, contact_method, contact_value, accepts_submissions, guidelines, confidence, source_url) values
(null,'Spotify Editorial (via Spotify for Artists)','playlist','Spotify for Artists',ARRAY['all'],'form','https://artists.spotify.com',true,'Pitch ONE unreleased song 7+ days (ideally 2-4 weeks) before release: Music > Upcoming > Pitch a Song. Fill every field and the ~500-character story. Free. No email/social back channel.','VERIFIED','https://support.spotify.com/us/artists/article/pitching-music-to-playlist-editors/');
