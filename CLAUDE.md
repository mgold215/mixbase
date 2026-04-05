@AGENTS.md

# Deployment
- Railway production URL: https://mixfolio-production.up.railway.app
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

## Audio Range Requests — always use audioProxyUrl()
Supabase public audio URLs do not reliably return `Accept-Ranges` headers.
Without Range support the browser cannot determine audio duration or seek.

**The fix (already implemented, do not revert):**
- `src/app/api/audio/[...path]/route.ts` — proxy that forwards Range headers to Supabase and returns proper 206 responses
- `audioProxyUrl(supabaseUrl)` in `src/lib/supabase.ts` converts any Supabase mf-audio URL to `/api/audio/...`
- Every `<audio>` element or `WaveformPlayer` in the app MUST use `audioProxyUrl(version.audio_url)`, not the raw URL
- Already applied in: `ProjectClient.tsx`, `ShareClient.tsx`, `player/page.tsx`
- Middleware public path `/api/audio` is already whitelisted — do not remove it

## Supabase Storage Buckets
- `mf-audio` — audio files, public read
- `mf-artwork` — artwork images, public read
