# SubmitBase

A **free, self-hosted, single-user** music submission hub — your own private
alternative to SubmitHub. It comes preloaded with **~75 researched curators**
(labels, blogs, radio, playlist editors) across house / melodic / deep /
progressive / tech / organic house, drum & bass (incl. liquid/melodic), and
riddim / dubstep / bass. You browse the directory, filter it to the curators
that fit a track, write one personalized pitch, and fire it off through **each
curator's own free channel** — their submission form, demo portal, social
profile, or a direct email.

It never spams: it only ever opens the channel a curator actually publishes,
and you review every message before anything goes out.

---

## What you get

- A searchable, filterable **curator directory** (preloaded — visible the
  moment you log in).
- Every curator is tagged **VERIFIED** (channel found on their own
  site/portal/socials) or **UNVERIFIED** (found on a forum/aggregator —
  double-check before sending). Unverified ones are flagged in amber and show a
  "confirm source" link.
- A **track manager** for your releases (title, genre, private listening link,
  pitch).
- A **submission flow**: pick a track → filter & multi-select curators →
  review/edit a personalized message for each → send.
- A **dashboard** tracking every submission's status and your response rate.
- **CSV import/export** so the directory grows with you and you always have a
  backup.

---

## How sending works (no spam, ever)

The app **cannot** auto-submit a web form or auto-DM anyone — and it doesn't try
to. Instead it branches by each curator's channel:

| Channel | What happens |
| --- | --- |
| **Email** | Opens a pre-filled message in your own mail app (Mode A). *Optionally* batch-sends via Resend if you set it up (Mode B). |
| **Form / portal** (LabelRadar, Label-Engine, Label-Worx, Demmo, etc.) | Copies your pitch to the clipboard and opens the form in a new tab — you paste and submit. |
| **SoundCloud / Instagram / X** | Copies your message and opens the profile. |
| **Spotify editorial** | Opens Spotify for Artists and reminds you to pitch one unreleased song 2–4 weeks early. |

Every action logs a submission so you can track it on the dashboard.

---

## Setup (start to finish, no coding experience needed)

### 1. Install Node.js

Download the **LTS** version (20 or newer) from <https://nodejs.org> and install
it. To check it worked, open a terminal and run:

```bash
node --version
```

You should see something like `v20.x.x`.

### 2. Get the code and install dependencies

In a terminal, go into this `submitbase` folder and run:

```bash
npm install
```

This downloads everything the app needs (takes a minute or two).

### 3. Create your `.env.local` file

Copy the example file to a real one:

```bash
cp .env.local.example .env.local
```

The Supabase URL and anon key are already filled in. That anon key is **public
by design** — your data is protected by database security rules (Row Level
Security), not by hiding the key. Leave the Resend lines blank for now (that's
optional Mode B).

### 4. Set up the database

1. Go to <https://supabase.com> and open your project's dashboard.
2. In the left sidebar click **SQL Editor** → **New query**.
3. Open the file **`schema.sql`** from this folder, copy **all** of it, paste it
   into the editor, and click **Run**.

This creates the tables, turns on security, and loads the ~75 curators. You only
do this once.

### 5. Turn on magic-link login in Supabase

1. In the Supabase dashboard go to **Authentication → Providers → Email** and
   make sure **Email** is enabled (magic links are on by default).
2. Go to **Authentication → URL Configuration** and add your app's address to
   **Redirect URLs**:
   - For local use: `http://localhost:3000/auth/callback`
   - For your deployed site: `https://YOUR-DOMAIN/auth/callback`

> Single-user note: this app has no public signup screen. The first time you log
> in with your email, Supabase creates your account automatically. If you'd
> rather lock it down completely, turn **off** "Allow new users to sign up" in
> Supabase Auth settings *after* your first login.

### 6. Run it

```bash
npm run dev
```

Open <http://localhost:3000>. Enter your email, click the magic link Supabase
emails you (open it on the same device), and you're in.

### 7. Use it

1. Go to **Tracks** → **Add track**. Paste a **private, download-enabled
   SoundCloud link** and write a short reusable pitch.
2. Go to **Submit**. Pick your track, filter the directory (try filtering by
   your genre and **Verified only**), select the curators you want, and click
   **Review**.
3. On the review screen, tweak any message, heed any amber **Unverified**
   warnings, then click the send button on each curator.
4. Track replies on the **Dashboard** by updating each submission's status.

---

## Growing the directory with CSV

On the Directory page:

- **Export CSV** downloads everything (your backup).
- **Example CSV** downloads a 2-row template showing the exact format.
- **Import CSV** bulk-adds curators to *your* private list.

Column format:

```
name,type,platform,genres,contact_method,contact_value,audience_size,accepts_submissions,guidelines,confidence,source_url
```

- `genres` — separate multiple with semicolons, e.g. `riddim;dubstep;bass`.
- `accepts_submissions` — `true`/`false` (defaults to `true`).
- `confidence` — `VERIFIED`/`UNVERIFIED` (defaults to `VERIFIED`).
- `confidence` and `source_url` are optional. Bad rows are skipped and reported
  rather than failing the whole import.

---

## Optional: Mode B (let the app send emails for you)

By default email curators open in your own mail app (Mode A — recommended, zero
setup). If you want the app to send batches of real emails itself:

1. Make a free account at <https://resend.com> and verify a sending domain.
2. Put your key and from-address in `.env.local`:
   ```
   RESEND_API_KEY=re_xxxxxxxx
   SUBMIT_FROM_EMAIL=you@yourdomain.com
   ```
3. Restart `npm run dev`. A **Batch-send emails** button now appears on the
   review screen. It sends at most **20 per run**, **3 seconds apart**.

---

## Deploying (so it's online, not just on your laptop)

You can host this for free on either platform:

- **Vercel** — import the repo at <https://vercel.com>, set the project root to
  `submitbase`, add the same `.env.local` values as Environment Variables, and
  deploy.
- **Railway** — create a project from the repo at <https://railway.app>, set the
  root/working directory to `submitbase`, add the env vars, deploy.

After deploying, add `https://YOUR-DOMAIN/auth/callback` to Supabase's
**Redirect URLs** (step 5 above).

---

## How to submit well (read this before you blast anyone)

- **Always send a private, download-enabled SoundCloud link** — not an email
  attachment, not an expiring file-transfer link.
- **One genre per submission.** Send your 1–3 best **finished, mastered** tracks
  only, and address the label by name.
- **Don't follow up within ~2 weeks.** Many labels reply only if they're
  interested — silence is normal.
- **Spotify editorial is your single best free Spotify lever** — pitch every
  release **2–4 weeks early** via Spotify for Artists (Music → Upcoming → Pitch
  a Song). Fill every field and the ~500-character story.
- **VERIFIED vs UNVERIFIED:** verified channels were found on the curator's own
  site/portal/socials. Unverified ones came from forums/aggregators — open the
  source link and confirm the address still works before sending.
- The big paid platforms have weak free tiers (SubmitHub gives limited free
  credits; Groover has no free contact). This app routes around them by using
  each curator's own free channel.

---

## Tech notes

- **Next.js (App Router) + TypeScript + Tailwind CSS**
- **Supabase** — Postgres + magic-link Auth + Row Level Security
- Your tracks and submissions are private to you. The preloaded directory is a
  shared starter set (`user_id = NULL`) that's read-only; curators you add are
  yours alone. All enforced by the RLS policies in `schema.sql`.
- The app name is a single constant in `src/lib/config.ts` (`APP_NAME`) — change
  it there.
