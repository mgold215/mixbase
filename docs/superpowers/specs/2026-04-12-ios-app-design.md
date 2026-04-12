# mixBase iOS App — Design Spec

## Overview

Native iOS app (Swift + SwiftUI) for mixBase — a music-mix versioning tool and release pipeline. Connects to the existing Supabase backend shared with the web app. Starts as a personal tool, eventually opens to collaborators and the App Store.

## Architecture

- **Language/Framework:** Swift + SwiftUI (native iOS)
- **Backend:** Existing Supabase project (ref: `mdefkqaawrusoaojstpq`)
  - Database tables: `mb_projects`, `mb_versions`, `mb_releases`, `mb_feedback`, `mb_activity`
  - Storage buckets: `mf-audio` (audio files), `mf-artwork` (artwork images)
- **Audio engine:** AVFoundation — background playback, lock screen controls, waveform rendering
- **AI artwork:** Replicate API (FLUX model) — same as web app
- **AI prompts:** Anthropic Claude API — auto-generates artwork prompts from track metadata
- **Auth (v1):** Password gate (same as web app). Future: proper user accounts.

The web app and iOS app share the same Supabase database. Changes in one appear in the other.

## Navigation

### Tab Bar (4 tabs, always visible at bottom)

1. **Home** — Dashboard hub screen
2. **Projects** — Project grid
3. **Player** — Full player screen
4. **Pipeline** — Release pipeline

Settings accessible via gear icon in the Home screen nav bar (top right).

### Persistent Mini Player

Sits above the tab bar on all screens. Shows: artwork thumbnail, track name, version number, play/pause button. Tapping expands to full player.

## Screens

### Home (Dashboard Hub)

- Stats row: total projects, mixing count, pipeline count
- Now Playing card: artwork, track name, version, progress bar, play/pause
- Recent Activity feed: version uploads, status changes, feedback received, releases created
- Each card/item tappable to navigate to the relevant detail screen

### Projects

- Grid of project cards (2 columns) with artwork thumbnails
- Each card shows: artwork, title, genre, BPM, version count, status badge, workflow stage badge
- "New Project" button (top right)
- Tapping a project opens Project Detail

### Project Detail

- Project artwork (large, top)
- Title, genre, BPM, key signature
- Version list: each version shows version number, label, status badge, date, duration
- Tap a version to play it
- "Upload Version" button — pick audio file from phone, upload to `mf-audio` via chunked upload
- "Generate Artwork" button — opens AI Artwork Generator flow
- "Share" button — generates shareable link for a version
- Status editing: tap a version's status to change (WIP → Mix/Master → Finished → Released)
- Private notes and change log editable per version

### Player (Full Screen — Tab)

- Large album artwork (fills upper portion of screen, rounded corners)
- Track title + version label
- Waveform visualization (interactive — tap to seek)
- Playback controls: previous version / play-pause / next version
- Time scrubber with elapsed and remaining time
- Version switcher: horizontal pills (v1, v2, v3) for instant switching between mixes
- A/B Compare toggle: quick-switch between two selected versions
- Lock screen + Control Center integration: artwork, title, play/pause/skip

### Pipeline

- List of releases, each showing: title, release date, linked project artwork
- Tap a release to open Release Detail

### Release Detail

- Linked project (tappable)
- Release date (editable)
- Genre, label, ISRC fields
- Checklist (tap to toggle):
  - Mixing done
  - Mastering done
  - Artwork ready
  - DSP submitted
  - Social posts done
  - Press release done
- DSP platform toggles: Spotify, Apple Music, Tidal, Bandcamp, SoundCloud, YouTube, Amazon
- Notes field

### AI Artwork Generator

Flow triggered from Project Detail:

1. **Describe** — Text field for prompt. "Auto" button uses Claude to generate prompt from track name, genre, BPM.
2. **Style** — Preset options: Photographic, Abstract, Illustration, Minimal, Cinematic. Modifies prompt.
3. **Generate** — Calls Replicate API (FLUX). Loading animation while processing.
4. **Review** — 2-4 variations displayed. Swipe through, tap to select.
5. **Apply** — Selected image uploaded to `mf-artwork` bucket, set as project artwork.

Artwork appears in: project grid, full player, mini player, lock screen, share links, pipeline cards.

### Settings

- Password management
- API key configuration (Replicate, Anthropic)
- Future: account management, integration connections

## Audio Playback

- AVFoundation-based audio engine
- Background playback: music continues when app is backgrounded or phone is locked
- Lock screen controls: artwork, title, play/pause, skip (via MPNowPlayingInfoCenter)
- Chunked upload for large audio files (adapted from web app's TUS approach)
- Audio proxy not needed on iOS — AVFoundation handles range requests natively

## Data Flow

All data reads/writes go through Supabase Swift SDK:

- **Projects:** CRUD on `mb_projects`
- **Versions:** CRUD on `mb_versions`, audio file upload to `mf-audio`
- **Releases:** CRUD on `mb_releases`
- **Feedback:** Read from `mb_feedback` (displayed on version detail)
- **Activity:** Read from `mb_activity` (displayed on home dashboard)
- **Artwork:** Upload to `mf-artwork`, URL stored in `mb_projects.artwork_url`

## Future Integrations (not in v1)

- **DistroKid API** — auto-submit releases to distribution
- **Spotify API** — pull stream counts, check release status
- **Playlist services** — automated playlist pitching
- **Runway API** — generate short animated videos from artwork (Spotify Canvas, YouTube visualizers)
- **Push notifications** — alerts for new feedback, release going live
- **Multi-user auth** — user accounts, team collaboration
- **Social media scheduling** — auto-post announcements

## Visual Design

- Dark theme: black background (#080808), white text (#f0f0f0)
- Accent color: teal (#2dd4bf)
- Font: system San Francisco (iOS default) — clean, professional
- Rounded corners on cards and artwork (consistent with current web app aesthetic)
- Minimal chrome — content-forward, artwork-prominent
