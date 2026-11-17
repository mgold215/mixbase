---
name: uploads-and-audio
description: How files get into and out of mixBASE - the signed-URL and TUS chunked upload routes, the Railway 10 MB limit and the 8 MB chunk size, Supabase Storage buckets, object keys and storage policies, and playback through the /api/audio proxy. Use before changing any upload, storage or playback code on the web or in the app, a bucket limit, a storage policy or the public paths, and when an upload fails or audio will not seek or show its length.
---

# Uploads, storage and audio playback

These rules come from infrastructure limits, not preference. Breaking one passes local testing and fails only in production.

## The rule everything follows from

**No request carrying more than 10 MB may pass through Railway.** Its proxy truncates request bodies above exactly 10,485,760 bytes (10 MB). No code change fixes that. So a whole file never crosses Railway in one request: small files skip it entirely, and large ones cross it in 8 MB pieces.

## Which path a file takes

| File | Path | Why |
|---|---|---|
| ≤ 50 MB, web | `POST /api/upload-url` → the browser PUTs straight to Supabase | Railway never sees the bytes |
| > 50 MB, web (audio only) | TUS through `/api/tus` in 8 MB chunks | Each chunk fits under the 10 MB wall. It goes through our server because the session is opened with the service-role key, which is what lets a file past Supabase's size limit for ordinary users |
| Signed-URL PUT answers 413 | Retried through TUS automatically | Already implemented |
| App, a mix, instrumental or image | POSTed straight to Supabase Storage with the user's own token | The app never uses `/api/tus` |
| App, a video or a Mix Check reference | `POST /api/upload-url`, then PUT | Same route as the web |

The TUS client is `tus-js-client` with `endpoint: '/api/tus'` and `chunkSize: 8 * 1024 * 1024`. The chunk size is not arbitrary. Raising it to 10 MB or more truncates chunks. Flag any change to it.

Client code:

- `src/app/projects/[id]/ProjectClient.tsx`: `uploadAudioToStorage()` picks the path, `tusUpload()` does the chunked one (with resume), `handleUpload()` calls them.
- `src/app/projects/new/NewProjectForm.tsx`: its own inline copy of the same logic, without resume. A change to one needs making in the other.
- App: `ios/mixBase/Services/SupabaseService.swift`.

## The routes

**`POST /api/upload-url`** (`src/app/api/upload-url/route.ts`): returns a short-lived signed upload URL.

- Buckets allowed: `mf-audio`, `mf-artwork`, `mf-video`.
- The first path segment must be a project the caller owns (`ownsProject`). Keys are not secret: the feed hands every signed-in user other artists' URLs, so without this check anyone could write under someone else's project.
- Signed with `upsert: false`. Signing with upsert stamps overwrite permission into the token.
- An `mf-video` key must match `VIZ_KEY_RE` (`src/lib/visualizer-finalize.ts`), the same regex that decides what the orphan reaper may delete.

**`POST /api/tus`** (`src/app/api/tus/route.ts`): opens a TUS session at Supabase with the service-role key.

- `mf-audio` only, 2 GB cap, owned project only.
- The object name is re-written into the forwarded metadata after validation. Never forward the client's metadata header as it arrived: that authorizes one key and stores another.

**`PATCH` / `HEAD /api/tus/<uploadId>`**: forwards one chunk / reads the resume offset. Checks ownership from the project id inside the upload id. When the id cannot be parsed it lets the request through and reports the shape to Sentry, on purpose: guessing Supabase's id format wrong and failing closed would break every upload.

`/api/tus` and `/api/tus/[uploadId]` are authenticated and deliberately NOT in `PUBLIC_PATHS` (`src/proxy.ts`). When they were public, anyone could upload or overwrite anonymously.

## Object keys

| What | Key | Bucket |
|---|---|---|
| A mix, from the web | `<projectId>/<timestamp>.<ext>` | `mf-audio` |
| A mix, from the app | `<projectId>-v1.<ext>` for the first, then `<projectId>-v<n>-<timestamp>.<ext>` (flat, no folder) | `mf-audio` |
| An instrumental, from the app | `<projectId>/instrumental-<timestamp>.<ext>` | `mf-audio` |
| A Mix Check reference | `<projectId>/mixref-<stamp>.<ext>` (deleted after measuring) | `mf-audio` |
| Artwork, from the web or the server | `<projectId>/…` | `mf-artwork` |
| Artwork, from the app | `<projectId>-<timestamp>.jpg` (flat) | `mf-artwork` |
| A collection cover, generated | `covers/<collectionId>/…` | `mf-artwork` |
| A collection cover, from the app | `collection-<collectionId>-<timestamp>.jpg` (flat) | `mf-artwork` |
| Cassette Studio files | `studio/<userId>/…` | `mf-artwork` |
| A visualizer or uploaded video | `<projectId>/viz-<stamp>.<ext>` | `mf-video` |

The project id in a key is always the lowercase UUID (`canonicalUuid` in `src/lib/validators.ts`; `storageKeyComponent` in the app). An uppercase id makes an object no cleanup path can find.

## Buckets and limits

| Bucket | Limit | Notes |
|---|---|---|
| `mf-audio` | 2 GB | Public read. Set by direct SQL |
| `mf-video` | 500 MB | Migration 016 + the `ensureVideoBucketLimit` heal |
| `mf-artwork` | 50 MB | Public read |

**Change a bucket limit with SQL only.** The Storage API (`updateBucket`) caps at the project's 500 MB global limit and silently downgrades `mf-audio` from 2 GB.

## Storage policies

| Migration | State | What to know |
|---|---|---|
| 029 | Applied | Uploads need a signed-in user |
| 044 | Applied 2026-11-14 | A user can list only the files they uploaded. Public downloads are unchanged |
| 028 | **Never apply** | Dropping the read policies broke every upload on 2026-07-11: an upload reads its new row back, which needs a SELECT policy. Superseded by 044 |
| 038 | **Do not apply yet** | Scoping uploads to an owned project's folder would break every mix, artwork and collection cover uploaded from the app, because the app's keys are flat. The hole it describes is real (a signed-in user can write under another artist's project; they cannot overwrite or delete). The file is all comments: the policy text is inside them, with the steps that must come first |

Any storage policy change is rehearsed on throwaway buckets with a real signed-in user before it touches production (044's header shows how). If the owner asks for 028 or 038 to be applied, say what would break before doing anything: the request was made without knowing it.

## Playback

- **Every `<audio>` source goes through `audioProxyUrl(version.audio_url)`** (`src/lib/supabase.ts`), which turns a Supabase `mf-audio` URL into `/api/audio/...`. Supabase's public URLs don't reliably return `Accept-Ranges`, so a raw URL plays but cannot seek or report its length. This applies to any new page that plays audio.
- The proxy (`src/app/api/audio/[...path]/route.ts`) forwards `Range` and mirrors the upstream status. Keep these behaviours:
  - a 206 only when Supabase really returned partial content
  - the 30 s timeout covers waiting for headers only, never the body (a long mix streams for minutes)
  - `?download=1&filename=` streams the file as an attachment
- `/api/audio/` must stay in `PUBLIC_PATHS`, with its trailing slash: share pages and the app's lock screen fetch it without a cookie.
- `artworkProxyUrl()` serves `mf-artwork` images from `/api/artwork/...`, because the iOS lock screen refuses cross-origin artwork. `/api/artwork/` is public for the same reason.

## The service-role key

`SUPABASE_SERVICE_ROLE_KEY` appears only in server code (API routes, `src/lib/`). Never in a `'use client'` component, never sent to the browser.

## Checking a change

Unit suites (in `npm test`):

| Suite | Guards |
|---|---|
| `scripts/upload-ownership-test.mjs` | Both upload routes refuse a project the caller does not own; no upsert |
| `scripts/uuid-storage-key-test.mjs`, `scripts/ios-storage-key-test.mjs` | Lowercase ids in every key, web and app |
| `scripts/viz-key-shape-test.mjs` | The `mf-video` key shape |
| `scripts/archived-playback-test.mjs` | Archived mixes on the project page play through the proxy (it does not check other pages) |
| `scripts/audio-duration-test.mjs` | Reading a file's length |

**The live smoke test does not work.** `scripts/test-upload.mjs <base-url>` sends no sign-in, so `/api/tus` has answered it 401 ever since that route became authenticated. Until it is given a login, the only end-to-end check is a real upload by a signed-in user: one file under 50 MB and one over, from the web, and one mix from the app.

## Review checklist

1. Are any file bytes PUT or POSTed to a Railway route outside the two paths above?
2. Did `chunkSize` change from `8 * 1024 * 1024`?
3. Does any raw Supabase audio URL reach an `<audio>` element?
4. Did `PUBLIC_PATHS` gain `/api/tus` or lose `/api/audio/`?
5. Is a bucket limit changed through the Storage API instead of SQL?
6. Does a new upload path skip the ownership check, sign with upsert, or build a key with an id that is not lowercase?
7. Does a storage policy change assume every key starts with a project folder?
