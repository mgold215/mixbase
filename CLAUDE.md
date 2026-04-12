@AGENTS.md

# Deployment
- Railway production URL: https://mixbase-production.up.railway.app
- Supabase project: mdefkqaawrusoaojstpq (mmf-agents, us-east-1)
- Supabase URL: https://mdefkqaawrusoaojstpq.supabase.co

# Architecture: Critical Constraints — READ BEFORE TOUCHING UPLOADS OR AUDIO

## Railway HTTP Proxy Truncation — NEVER upload files through Railway
Railway's reverse proxy silently truncates HTTP request bodies above ~1-2 MB.
A 3-minute MP3 (e.g. MOOD) gets cut to ~59 seconds because only the first ~1 MB
of audio data reaches the server. **This is NOT a code bug — it is Railway infrastructure.**

**The fix (already implemented, do not revert):**
- `POST /api/upload-url` — server generates a Supabase signed upload URL (service-role key, no size limit)
- Browser PUTs the file **directly to Supabase** using the signed URL — Railway is never in the data path
- Implementation: `src/app/api/upload-url/route.ts` + `ProjectClient.tsx` `handleUploadSubmit()`
- DO NOT switch back to routing file uploads through `/api/upload` or any Railway endpoint

## Upload Architecture — server-side TUS proxy
**Never go back to single-request uploads through Railway.** The permanent architecture:

- `POST /api/tus` — creates TUS session at Supabase using service-role key (bypasses anon file size limit)
- `PATCH /api/tus/<uploadId>` — proxies one 8 MB chunk to Supabase (under Railway's 10 MB body wall)
- `HEAD /api/tus/<uploadId>` — checks resume offset
- Client uses `tus-js-client` with `endpoint: '/api/tus'`, `chunkSize: 8 * 1024 * 1024`
- Each chunk: browser → Railway (8 MB, allowed) → Next.js proxy → Supabase (service-role key, no size limit)
- Files of any size work. Uploads are resumable on failure.
- Middleware: `/api/tus` is in PUBLIC_PATHS

**Root causes documented:**
- Railway truncates HTTP request bodies at exactly 10 MB (10,485,760 bytes). Confirmed by 3 uploads in storage all showing exactly 10 MB.
- Supabase free tier enforces ~50 MB per-file limit for anon-key uploads. Confirmed by TUS 413 on session creation.
- Service-role key on server bypasses the 50 MB limit.
- 8 MB chunks bypass the Railway 10 MB wall.

## Audio Range Requests — always use audioProxyUrl()
Supabase public audio URLs do not reliably return `Accept-Ranges` headers.
Without Range support the browser cannot determine audio duration or seek.

**The fix (already implemented, do not revert):**
- `src/app/api/audio/[...path]/route.ts` — proxy that forwards Range headers to Supabase and returns proper 206 responses
- `audioProxyUrl(supabaseUrl)` in `src/lib/supabase.ts` converts any Supabase mf-audio URL to `/api/audio/...`
- Every `<audio>` element or `WaveformPlayer` in the app MUST use `audioProxyUrl(version.audio_url)`, not the raw URL
- Already applied in: `ProjectClient.tsx`, `ShareClient.tsx`, `player/page.tsx`
- Middleware public path `/api/audio` is already whitelisted — do not remove it

## Testing
Run after every deploy that touches upload or audio playback:
```
SUPABASE_SERVICE_ROLE_KEY=<key> node scripts/test-upload.mjs https://mixbase-production.up.railway.app
```
The script uploads a 20 MB synthetic WAV in 8 MB TUS chunks, verifies it's stored at full size in Supabase, and tests the audio proxy Range requests. All tests must pass before telling the user a fix is done.

## Supabase Storage Buckets
- `mf-audio` — audio files, public read
- `mf-artwork` — artwork images, public read
