---
name: artwork-and-video
description: The artwork and video features every artist gets - AI artwork generation, the artwork text overlay, the free visualizer generator, "your own video" uploads, Runway image-to-video, the finished YouTube and Shorts renders, the monthly allowance, and the AI mix-notes summary. Use before changing or answering anything about generate-artwork, finalize-artwork, visualizers, pinned loops (visualizer_url, visualizer_wide_url), finalize-video, ffmpeg or the render workers. For the owner's cassette covers use the cassette-studio skill instead.
---

# Artwork and video

Every route here is rate-limited per user (`src/lib/rate-limit.ts`). Only two count against the monthly allowance in `src/lib/tier.ts`: `generate-artwork` (3 a month) and `visualizer/runway` (0 a month, so owner-only). Everything else is free to use: the free generator, uploads, the text overlay, the finished renders.

## Route map

| Route | What it does |
|---|---|
| `POST /api/generate-artwork` | Replicate image models (FLUX 1.1 Ultra raw / Seedream 4 / Imagen 4 Ultra / Recraft V3 / Flux 2 Pro / Imagen 4). Optional `vary` flag appends a randomized photographic look (lens/light/weather/mood). Polls up to 2 min |
| `GET\|POST /api/finalize-artwork` | `sharp` + `opentype.js` text overlay. GET serves the option lists (`src/lib/finalize-options.ts`) |
| `GET\|POST /api/visualizer/free` | The apps' free generator |
| `POST /api/visualizer/finalize` | Checks a finished or uploaded clip and records it in `mb_visualizers`. It does not pin: the client pins with a PATCH to the project |
| `GET\|POST /api/visualizer/runway` | Runway Gen-4 Turbo / Gen-4.5 / Seedance 2 / Veo 3/3.1 image-to-video. Cloud video is owner-only |
| `POST\|GET /api/finalize-video` | Finished YouTube (1080p) / Shorts (9:16) renders |
| `POST /api/chat/summarize-feedback` | Claude (`claude-opus-4-7`) mix-notes summary |

## Traps

- **`/api/finalize-artwork` font.** The bundled font is traced via `outputFileTracingIncludes` in `next.config.ts`. Removing that config crashes the route on Railway only.
- **Free generator memory.** `/api/visualizer/free` runs the WEB effect engine (`src/lib/free-effects.ts`) server-side on `@napi-rs/canvas` in worker threads (`src/lib/free-render*.ts`, sliced across ≤4 workers, piped to ffmpeg), so the app's effect list always equals the web's. That library retains a snapshot of every canvas drawn into a context until `ctx.reset()`. The worker resets each frame; dropping it OOMs 30 s renders (`scripts/free-render-test.mjs` guards it).
- **ffmpeg has no `xfade`.** It comes from `@ffmpeg-installer` (npm-hosted, 2018 build). Crossfade is trim/concat/fade/overlay in `src/lib/video-render.ts`.
- **In-process jobs.** finalize-video is an in-process async job (POST starts, GET polls), lost on deploy by design: accepted behaviour, not a bug to fix with a queue. At most 2 renders run at a time per process. Production runs two processes, so a poll can land on the one that does not know the job (see the `mix-check` skill for how Mix Check solved it).
- **Refund a failed generation.** When a counted generation fails after its slot was reserved, refund the slot for the month it was reserved in (`src/lib/tier.ts`).

## Your own visualizer (2026-11-06)

Web: project page "Upload your own video". App: Visualizer screen "Your own video".

1. The client's file → `POST /api/upload-url` (bucket `mf-video`, key `<projectId>/viz-<stamp>.mp4`), bytes PUT straight to Storage.
2. `POST /api/visualizer/finalize` with `source: 'upload'`: stored kind `free`, settings `{ source: 'upload' }`. The server's probe still requires a playable H.264 MP4 or WebM ≤ 200 MB.
3. The client then pins it where the artist chose ("Use it for"): auto = the slot its shape fits (landscape → `visualizer_wide_url`, else `visualizer_url`); or vertical / wide / both.

- The finished Short and YouTube renders need nothing new: `/api/finalize-video` already takes the pin for its format (`pinForFormat`, the other pin centre-cropped) and maps only the song's audio. So an uploaded clip, any length and any shape, becomes the Short / full-length video the moment it is pinned.
- The app converts on the device first (`AVAssetExportSession` 1080p H.264, audio stripped, the recorded rotation kept) because phones record HEVC. The web sends MP4/WebM as-is.
- Both routes are app-called (removed from the parity register's `KNOWN`).

## Finished videos (`/api/finalize-video`)

- Loops the pinned visualizer seamlessly for the song, writes the title, and muxes the current mix.
- **Title in the artist's handwriting** when the song has a Cassette Studio lettering (`lettering-<pid>-*.png`, newest): tinted in the chosen colour, ~32% of the short edge, bottom-centre, faded in once and HELD like the cover. Decision 2026-11-06: the flashed Futura lockup read as a caption.
- `text_style: 'type'` forces the old flashed type lockup, and GET reports `handwriting_available`. Without a lettering, the flashed type lockup is used.
- Outputs → `mf-video` + `mb_visualizers` kind `youtube` / `shorts`.
- The bucket limit was raised to 500 MB via SQL (migration 016 + the `ensureVideoBucketLimit` heal).
