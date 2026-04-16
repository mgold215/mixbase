# Visualizer Feature Design
**Date:** 2026-04-16
**Project:** mixbase
**Status:** Approved

## Overview

Add a Visualizer tab to the project detail page that turns generated album artwork into downloadable video loops. Supports four export formats. Free by default (in-browser Ken Burns animation), with an optional Runway AI upgrade.

## Tab Structure

The project detail page (`/projects/[id]`) gains a tab bar with three tabs:

- **Versions** — existing content (unchanged)
- **Artwork** — existing `ArtworkGenerator` component, moved here from its current inline position
- **Visualizer** — new tab described below

Active tab persists in URL hash (`#versions`, `#artwork`, `#visualizer`) so links and back-navigation work correctly.

## Visualizer Tab UI

1. **Artwork preview** — thumbnail of the project's current `artwork_url`. If no artwork exists, prompt to generate one first (link to Artwork tab).
2. **Format selector** — pill buttons, one active at a time: Canvas · YouTube · Square · Story
3. **Generate buttons:**
   - **"Generate Video (Free)"** — always enabled if artwork exists
   - **"Generate with AI ✨"** — enabled only if `RUNWAY_API_KEY` is configured server-side; otherwise shows a dimmed lock icon with tooltip "Add RUNWAY_API_KEY to enable"
4. **Progress bar** — shown during render with status text ("Recording…", "Processing…", "Done")
5. **Video preview** — `<video>` element with controls, shown once render completes
6. **Download button** — triggers download of the rendered file

## Export Formats

| Format | Dimensions | Duration | Use case |
|--------|-----------|----------|----------|
| Spotify Canvas | 1080×1920 (9:16) | 6s loop | Spotify track background |
| YouTube | 1920×1080 (16:9) | 30s loop | YouTube visualizer upload |
| Square | 1080×1080 (1:1) | 6s loop | Instagram feed post |
| Story | 1080×1920 (9:16) | 6s loop | Instagram / TikTok stories |

Canvas and Story share the same dimensions and duration — they render identically but are labelled separately for clarity when downloading.

## Free Generation (In-Browser Ken Burns)

All rendering happens client-side — no server involvement.

**Technique:**
- Draw artwork onto an HTML `<canvas>` element sized to the target format
- Each frame applies a slow zoom + gentle pan (Ken Burns effect) — start slightly zoomed in, drift across the image over the clip duration
- Use `requestAnimationFrame` loop to render each frame
- Record with `MediaRecorder` API targeting `video/webm;codecs=vp9`
- On stop, collect blobs into a single `Blob`, create an object URL, show in preview player

**Ken Burns parameters:**
- Start scale: 1.08, end scale: 1.0 (subtle zoom out) — randomise start pan offset slightly each render so repeated generations feel different
- Pan direction: random (top-left → center, center → bottom-right, etc.)
- Frame rate: 30fps

**Output:** WebM file. Filename pattern: `{project-title}-{format}-canvas.webm`

## AI Generation (Runway)

Only available when `RUNWAY_API_KEY` is set in Railway environment variables.

**Flow:**
1. Client calls `POST /api/visualizer/runway` with `{ imageUrl, format, projectId }`
2. Server fetches the artwork, sends to Runway Gen-3 Alpha Turbo with a motion prompt derived from the project's genre/title
3. Server polls Runway for completion (every 3s, timeout 3 minutes)
4. Returns the Runway video URL to the client
5. Client shows in preview player with download button

**Motion prompt template:**
`"Cinematic ambient motion, slow atmospheric drift, subtle light shimmer, no text, no faces, {genre} mood"`

**API route:** `src/app/api/visualizer/runway/route.ts`
**Auth:** Server-side only — `RUNWAY_API_KEY` never exposed to client

## New Files

- `src/components/Visualizer.tsx` — the full Visualizer tab component (client component)
- `src/app/api/visualizer/runway/route.ts` — server route for Runway calls

## Modified Files

- `src/app/projects/[id]/ProjectClient.tsx` — add tab bar, wire up tab state, render correct tab content; move `ArtworkGenerator` render into Artwork tab
- `src/app/api/generate-artwork/route.ts` — no changes needed
- `.env.example` — add `RUNWAY_API_KEY=`

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `RUNWAY_API_KEY` | No | Enables AI video generation via Runway Gen-3 |

Add to Railway environment variables to unlock AI generation. Leave unset to use free mode only.

## Git Workflow

Per CLAUDE.md:
1. Commit and push to `tst` branch
2. Verify staging deploy at `https://mixbase-staging.up.railway.app`
3. Run post-deploy test loop
4. Fast-forward merge to `main` and push
