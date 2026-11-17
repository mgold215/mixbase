---
name: share-pages
description: The public share pages - a song at /listen/... or /share/<token>, an album at /album/... - with their link card, waveform, colours taken from the cover, and the music-driven "alive" layer. Use before changing or answering anything about share links, share tokens or a token-scoped route, the link preview card, waveform peaks, the page's colours or backdrop, the title or cover effects, or listener feedback on a share page.
---

# Public share pages

Shipped 2026-11-04. These pages are public: anything exposed here is exposed to anyone with the link.

## Addresses

- **Song:** `mixbase.app/listen/<artist>/<title>/<token>` (canonical; a stale slug 308s to the current spelling) and the original `mixbase.app/share/<token>`.
- BOTH serve `TrackShareScreen` directly, with no redirect: links already in chats must keep working byte-for-byte.
- **Album:** `/album/<artist>/<title>/<token>`.
- `trackShareUrl(token, { artistName, title })` builds the pretty form. The web callers get the name from `useArtistName()` (`/api/auth/me`). The iOS app still mints `/share/<token>`, which is fine.
- Loaders: `src/lib/track-share.ts` (the public projection; `scripts/share-projection-test.mjs` locks the column lists) and `src/lib/album-share.ts`.

## One token resolver

`src/lib/share-target.ts` (`resolveShareTarget(token, projectId?)`) is the only place that decides what a token exposes: project → latest mix, legacy version token, collection + project id checked against its items.

- Used by `POST /api/share/<token>/duration`, `GET /api/share/<token>/peaks`, and `POST /api/feedback` (which accepts `share_token` + `project_id` for album pages, or `version_id`).
- Never add a token-scoped route with its own resolver.
- `/api/share/` is a public prefix in `src/proxy.ts`: anything added under it is public and must gate on the token itself.

## Link card

`GET /api/share/<token>/card` → 1200×630 PNG (`src/lib/share-card.ts`, sharp + Pango with the bundled Futura files, traced in `next.config.ts`), for songs AND albums. Advertised as og:image / twitter `summary_large_image` with a `?v=<stamp>` cache-buster.

## Waveform

`GET /api/share/<token>/peaks[?project=]` decodes the mix once (ffmpeg → mono PCM → 200 peaks, `src/lib/waveform-peaks.ts`), persists write-once in `mb_versions.waveform_peaks` (migration 043; db-init + `ensureVersionWaveformPeaksColumn` heal), and answers 202 while decoding (`fetchPeaks` polls). Drawn by `ShareWaveform` (canvas, pointer + keyboard seek).

The `/player` screen and the iOS player draw the same peaks (real since 2026-11-04; before that `/player` drew decoration seeded by the project id). A shimmer means the peaks are still loading. Even bars mean the mix could not be read.

## Public-only extras

- Public-only extras on the album page are gated on the token from `useParams`: the feedback drawer, "Note at m:ss", end-of-album reactions. The signed-in collection view shares the component but gets none of them.
- Other listeners' feedback is never shown on a share page.

## The alive layer

2026-11-15, the owner: "add some immersiveness to the private share… some effects on the title text and more vibrant background/artwork".

| File | Role |
|---|---|
| `src/lib/share-fx.ts` | The signals |
| `src/components/ShareStage.tsx` | What is drawn with them |
| The `.share-…` block of `globals.css` | The motion |
| `src/lib/share-palette.ts` | The colours (pure, tested on the real covers' colours) |

All shared by `ShareClient` and `AlbumPlayer`, so the two pages cannot drift apart. `usePortrait` picks the 9:16 vs 16:9 loop.

### Rules to keep

- Anything driven per frame by `--energy` / `--beat` changes only opacity or transform. A blur is drawn once, then faded or moved. The test fails on a filter/shadow/mask that reads those variables.
- The big soft layers are laid out small and scaled up with `will-change: transform` (three full-size lights are ~45 MB of texture on a phone).
- `prefers-reduced-motion` stops everything, and the two entrances that start invisible (letters, the write-in mask) are explicitly put back.
- The owner's handwriting ink is never recoloured (`scripts/share-palette-test.mjs` locks that).
- NEVER route the audio element through an AudioContext on iOS: Safari silences it when the screen locks.
- A share page is `.share-screen`, not `.min-h-screen`. On a phone that class reserves the app's tab-bar height at the foot of every page; the share pages have no tab bar, and it left a black strip under the picture.

### Colours (`share-palette.ts`)

The page used ONE colour, the average of the cover multiplied up, which on the owner's earth/amber/cream covers was always a dim brown.

- `paletteFromPixels` votes by hue (weighted by saturation, with a minimum share of the picture so three stripes on a cassette label do not repaint the page).
- It returns an `accent` (controls; lifted until a black play icon reads on it), three `glow` lights, an `ink` tint and `tone` (how bright the cover is: the blurred backdrop is dimmed for a pale cover and opened up for a dark one).
- A one-colour cover gets that colour's neighbours 18° either side (30° from orange is an acid lime). A colourless cover gets tinted neutrals.
- Until the cover is read the page wears `PENDING_PALETTE` (lights down), so the colours come UP once instead of starting violet and jumping.

### Backdrop

- The loop, else the cover as a wash (drawn at a quarter size and scaled up, blur growing with the screen).
- Under three drifting lights in the palette: added with `screen` over a loop so the picture survives; laid over the blurred cover as plain colour, which stays saturated where they meet instead of adding up to white.
- Then a vignette, an accent bloom and film grain.
- The header floats over it (no bar). A pool of shade sits behind title + controls (`.share-pool`, stronger over a loop) so they read on a bright loop.

### Cover

Floats and turns a few degrees on its own (so a phone, with no pointer, still shows an object), leans toward the pointer on desktop (`--px` / `--py` from `useParallax`), a glint crosses it, and a blurred copy of itself glows behind it.

### Title

- Type arrives letter by letter out of a blur, then a band of light crosses it. Behind it a blurred copy in the cover's colour follows the music, and a red and a blue copy part for an instant on the kick.
- The owner's HANDWRITING gets the same glow and kick cut to the shape of the ink (the lettering PNG is the CSS mask) and is written in from the left.

### Music

- `--energy` (loudness): from an AnalyserNode on desktop, from the waveform peaks on iOS.
- `--beat` (the kick) exists on desktop only: a second branch off the same source, low-passed twice at 140 Hz, read as a waveform level against its own recent average, into a gain of zero.
- Two spectrum-based tries failed: the byte spectrum stops at −30 dB so a mastered low end reads "full" all the time, and with a few bands two steady notes beating look like hits.
- On iOS `--beat` stays 0. A tempo-locked pulse would need the song's BPM in the public payload, which `share-projection-test.mjs` deliberately keeps out. That is the owner's decision to make, not a bug.
- Verified on synthetic tracks only: a four-on-the-floor kick lands ~50 ms after the hit, a drumless pad gives nothing, a limited rolling-bass mix catches about half the kicks. No real master could be played in a remote session.
