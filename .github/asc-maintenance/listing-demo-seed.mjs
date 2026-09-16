// Gives the App Review demo account real cover art before the screenshot tour.
//
// The demo projects are the developer's own released singles, but they were
// seeded sharing one cover image. This signs in AS THE DEMO USER (login from
// App Store Connect, see listing-asc.mjs), pulls each single's released
// artwork from Deezer's public catalog API, uploads it to the mf-artwork
// bucket (authenticated users may INSERT there) and points the project at it.
// Idempotent: a project whose artwork already carries the deezer-<album>
// marker is left alone, and an upload that already exists (409) is reused.

import { demoLogin, findApp } from "./listing-asc.mjs";

const SUPABASE = "https://mdefkqaawrusoaojstpq.supabase.co";
// Public anon key — the same one compiled into the iOS app (Config.swift).
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kZWZrcWFhd3J1c29hb2pzdHBxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MDc3OTUsImV4cCI6MjA4ODM4Mzc5NX0.NVv98cob57ldDHeND1gRUZs8IUt9-XmuTcdOwDSvteU";
// Project title -> Deezer album id of the released single/album.
const COVERS = { "KICK IT W/U": 631765241, "LIVE IT UP": 671410151, "TAKE TIME": 828993961 };

const app = await findApp();
const { email, password } = await demoLogin(app);
console.log(`::add-mask::${password}`);

const auth = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON, "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
if (!auth.ok) {
  console.error(`demo sign-in failed: HTTP ${auth.status} ${(await auth.text()).slice(0, 300)}`);
  process.exit(1);
}
const session = await auth.json();
const headers = {
  apikey: ANON,
  Authorization: `Bearer ${session.access_token}`,
  "Content-Type": "application/json",
};
console.log(`signed in as ${email} (user ${session.user?.id})`);

const projectsRes = await fetch(`${SUPABASE}/rest/v1/mb_projects?select=id,title,artwork_url&order=updated_at.desc`, { headers });
const projects = await projectsRes.json();
if (!Array.isArray(projects)) { console.error("could not list projects", projects); process.exit(1); }
console.log(`${projects.length} projects visible to the demo account`);

const finalUrls = {};
for (const project of projects) {
  const albumId = COVERS[project.title];
  if (!albumId) { console.log(`  ${project.title}: no catalog mapping, skipped`); continue; }
  const path = `${project.id}/deezer-${albumId}.jpg`;
  const publicUrl = `${SUPABASE}/storage/v1/object/public/mf-artwork/${path}`;
  if (project.artwork_url === publicUrl) {
    console.log(`  ${project.title}: already on the released cover`);
    finalUrls[project.title] = publicUrl;
    continue;
  }
  const album = await fetch(`https://api.deezer.com/album/${albumId}`, { headers: { "User-Agent": "mixbase-listing/1.0" } });
  const meta = album.ok ? await album.json() : null;
  const coverUrl = meta?.cover_xl || meta?.cover_big;
  if (!coverUrl) { console.log(`  ${project.title}: Deezer album ${albumId} has no cover (HTTP ${album.status}), skipped`); continue; }
  const img = await fetch(coverUrl);
  if (!img.ok) { console.log(`  ${project.title}: cover download failed HTTP ${img.status}, skipped`); continue; }
  const bytes = Buffer.from(await img.arrayBuffer());
  const up = await fetch(`${SUPABASE}/storage/v1/object/mf-artwork/${path}`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${session.access_token}`, "Content-Type": "image/jpeg", "x-upsert": "false" },
    body: bytes,
  });
  if (!up.ok && up.status !== 409) {
    console.log(`  ${project.title}: upload failed HTTP ${up.status} ${(await up.text()).slice(0, 200)}, skipped`);
    continue;
  }
  const patch = await fetch(`${SUPABASE}/rest/v1/mb_projects?id=eq.${project.id}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=representation" },
    body: JSON.stringify({ artwork_url: publicUrl }),
  });
  console.log(`  ${project.title}: ${bytes.length} bytes from Deezer album ${albumId} -> upload HTTP ${up.status}, project PATCH HTTP ${patch.status}`);
  if (patch.ok) finalUrls[project.title] = publicUrl;
}

// The "Singles" collection shows the lead single's cover.
const lead = finalUrls["KICK IT W/U"];
if (lead) {
  const cols = await (await fetch(`${SUPABASE}/rest/v1/mb_collections?select=id,title,cover_url`, { headers })).json();
  for (const c of Array.isArray(cols) ? cols : []) {
    if (c.cover_url === lead) continue;
    const r = await fetch(`${SUPABASE}/rest/v1/mb_collections?id=eq.${c.id}`, {
      method: "PATCH", headers: { ...headers, Prefer: "return=representation" }, body: JSON.stringify({ cover_url: lead }),
    });
    console.log(`  collection ${c.title}: cover -> lead single (HTTP ${r.status})`);
  }
}
console.log("demo artwork seed complete");
