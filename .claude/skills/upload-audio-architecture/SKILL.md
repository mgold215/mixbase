---
name: upload-audio-architecture
description: Non-negotiable constraints for the upload, storage, and audio-playback pipeline. Consult BEFORE editing anything touching uploads, TUS, signed URLs, Supabase Storage buckets, <audio> elements, WaveformPlayer, the audio proxy, or middleware public paths — even for seemingly unrelated refactors that brush these files. Violations here break production silently.
---

# Upload & Audio Architecture

These constraints exist because of infrastructure limits, not code preference. Breaking them produces failures that pass local testing and only show up in production.

## 1. Never route file bytes through Railway

Railway's proxy truncates request bodies above exactly 10,485,760 bytes (10 MB). This is infrastructure — no code change fixes it.

Valid upload paths only:
- **≤ 50 MB** → `POST /api/upload-url` returns a short-lived Supabase signed URL; the browser PUTs **directly to Supabase**. Railway never sees the bytes.
- **> 50 MB** → TUS chunked via `tus-js-client` with `endpoint: '/api/tus'` and `chunkSize: 8 * 1024 * 1024`. Each 8 MB chunk fits under the 10 MB wall.
- Signed-URL 413 → auto-retry via TUS (already implemented in `ProjectClient.tsx`).

**The 8 MB chunk size is not arbitrary.** Raising it above ~10 MB breaks large uploads with truncated chunks. Flag any change to this value.

## 2. Auth status of the routes (this changed — old docs are wrong)

- `/api/tus` and `/api/tus/[uploadId]` are **authenticated** — deliberately NOT in `PUBLIC_PATHS`. They proxy to Supabase with the service-role key; when they were public, anyone could upload/overwrite anonymously. The POST validates session + project ownership + bucket allow-list. Do not re-add them to `PUBLIC_PATHS`.
- `/api/audio` **must stay** in `PUBLIC_PATHS` — share pages and the iOS lock screen fetch it cookie-less.
- The middleware lives in **`src/proxy.ts`** (not `src/middleware.ts`). `PUBLIC_PATHS` is defined there.
- The iOS app uploads directly to Supabase and does not use `/api/tus` at all.

## 3. Always use audioProxyUrl()

Supabase public URLs don't reliably return `Accept-Ranges`, so browsers can't seek or read duration. Every `<audio src=...>` and every `WaveformPlayer` audio URL must go through `audioProxyUrl(version.audio_url)` (from `src/lib/supabase.ts`), which routes playback through `/api/audio/[...path]` — a proxy that forwards Range headers and returns proper 206s. Applies to any NEW page that plays audio, not just the existing ones.

## 4. Bucket limits: SQL only, never the Storage API

- `mf-audio` is 2 GB, set **via direct SQL**. The Storage API (`updateBucket`) caps at the project's 500 MB global limit and will **silently downgrade** the bucket to 500 MB. Never use it to touch bucket limits.
- `mf-video` is 500 MB via migration 016 + the `ensureVideoBucketLimit` heal.
- `mf-artwork` is 50 MB, public read.

## 5. Service-role key is server-only

`SUPABASE_SERVICE_ROLE_KEY` may only appear in server-side code (API routes, `src/lib/`). Never in `'use client'` components, never sent to the browser.

## Review checklist when touching this area

1. Are any file bytes PUT/POSTed to a Railway endpoint outside the two valid paths? 
2. Did `chunkSize` change from `8 * 1024 * 1024`?
3. Any raw Supabase audio URL reaching an `<audio>`/`WaveformPlayer`?
4. Did `PUBLIC_PATHS` in `src/proxy.ts` gain `/api/tus` or lose `/api/audio`?
5. Any bucket-limit change going through the Storage API instead of SQL?

After changes, run `SUPABASE_SERVICE_ROLE_KEY=... node scripts/test-upload.mjs https://mixbase-staging.up.railway.app` — all test groups must pass.
