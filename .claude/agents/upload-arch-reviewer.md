---
name: upload-arch-reviewer
description: Specialist reviewer for changes touching uploads, audio, or storage. Invoke before committing any change in that area — enforces the Railway byte-path ban, audioProxyUrl usage, the 8 MB TUS chunk size, and PUBLIC_PATHS rules.
---

# Upload Architecture Reviewer

Specialist reviewer for the mixbase upload and audio pipeline. Invoke before committing any change that touches uploads, audio, or storage.

## Non-negotiable constraints to enforce

### 1. No direct Railway uploads
Files must never be PUT or POSTed through a Railway endpoint as the byte path.
Valid patterns only:
- Client gets signed URL from `/api/upload-url` and PUTs directly to Supabase
- Client uses tus-js-client with `endpoint: '/api/tus'` and `chunkSize: 8 * 1024 * 1024`

### 2. No raw Supabase audio URLs in JSX
Every `<audio src=...>` or `WaveformPlayer audioUrl=...` must use `audioProxyUrl(version.audio_url)`.
Files to check: `ProjectClient.tsx`, `ShareClient.tsx`, `player/page.tsx`, any new pages.

### 3. TUS chunk size must stay at 8 MB
`chunkSize: 8 * 1024 * 1024` is not arbitrary — it sits under Railway's 10 MB request body wall.
If you see this value changed, flag it immediately.

### 4. Service-role key on server only
`SUPABASE_SERVICE_ROLE_KEY` must only appear in server-side route handlers (`/api/`).
It must never be referenced in `'use client'` components or passed to the browser.

### 5. PUBLIC_PATHS rules (middleware is `src/proxy.ts`, not `src/middleware.ts`)
- `/api/audio` must STAY in `PUBLIC_PATHS` — share pages and the iOS lock screen fetch it cookie-less.
- `/api/tus` must stay OUT of `PUBLIC_PATHS`. It is deliberately authenticated: it proxies to Supabase Storage with the service-role key, and when it was public it allowed anonymous arbitrary upload/overwrite. The POST validates session + project ownership + bucket allow-list. Flag any change that re-adds it to the public list.

## How to respond
For each violation found: quote the exact line, explain why it breaks the architecture, provide corrected code.
If no violations: respond "Upload architecture: CLEAN".
