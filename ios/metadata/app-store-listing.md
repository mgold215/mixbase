# mixBase — App Store Listing

## App Name
mixBase

## Subtitle (30 chars max)
Track Your Music, Rough to Release

## Category
Primary: Music
Secondary: Productivity

## Keywords (100 chars max)
music production,mix versions,track manager,audio compare,release pipeline,demo feedback,daw

## Description
mixBase is the version tracker built for music producers. Upload mixes, listen back to every version, collect feedback, and manage your release pipeline — all in one place.

Whether you're bouncing rough demos or polishing a final master, mixBase keeps every version organized so nothing gets lost.

KEY FEATURES

- Upload and organize mix versions for every project
- Listen to any version of any track with a full-featured audio player
- Track project status from rough idea to released
- Share private listening links and collect feedback from collaborators
- Hear what other artists are working on in the community feed
- Manage your release pipeline with checklists for mastering, artwork, DSP submission, and more
- Organize tracks into albums, EPs, and playlists
- Generate AI-powered artwork concepts for your releases
- Dark interface designed for studio environments

mixBase is free to use. Create an account and start tracking your music today.

## Promotional Text (170 chars max)
The mix version tracker for music producers. Upload, compare, and manage your mixes from rough demo to final release.

## App Review Demo Account
Email: review@mixbase.app
Password: (paste MIXBASE_REVIEW_PASSWORD from ~/.env.secrets into App Store Connect → App Review Information; never commit it)

## App Review Notes
mixBase is a music production tool for managing mix versions and releases.

Getting started: sign in with the demo account above (or tap "Sign in with Apple"). The demo account is pre-loaded with 3 real released tracks by the developer (moodmixformat) — "KICK IT W/U", "LIVE IT UP", and "TAKE TIME" — each with cover art and playable audio. Tap a project to see its mix versions and play them; the Player tab has full playback with a queue.

Regarding Guideline 3.1.1 (previous rejection): this build removes all access to and references of paid functionality. Every feature in the app is available on a free account: uploads, playback, sharing, the community feed, the release pipeline, and AI artwork generation (which every free account includes, subject to a monthly quota that resets monthly). The app contains no purchase flows, no upgrade prompts, no pricing, and no links to external purchase pages. Visualizer video generation was removed from the app entirely. AI generation runs on our server — no paid keys ship in the binary.

Community feed (user-generated content): all cross-user content supports moderation per Guideline 1.2 — long-press any feed track or comment to Report it or Block its author; reported content is hidden for the reporter immediately, reviewed within 24 hours, and removed for everyone past a report threshold. Our Terms of Service prohibit objectionable content.

Account deletion: Settings tab → "Delete Account" (type DELETE to confirm) permanently deletes the account and all associated data, satisfying Guideline 5.1.1(v). You can create a throwaway account via "Create one" on the sign-in screen to test this without removing the demo data.

The app requires an internet connection (data is stored in Supabase). There are no in-app purchases; the app is free.

## Privacy Policy URL
https://mixbase.app/privacy

## Terms of Service URL
https://mixbase.app/terms

## Support URL
https://mixbase.app/support

## Marketing URL
https://mixbase.app

## Copyright
2026 moodmixformat, LLC

## Age Rating
4+ (no objectionable content)

## Screenshots Needed
App is iPhone-only (TARGETED_DEVICE_FAMILY = "1"), so only iPhone screenshots are required — no iPad set needed.
- 6.9" (iPhone 16 Pro Max): 1320 x 2868px  — REQUIRED
- 6.5" (iPhone 14 Plus / 11 Pro Max): 1284 x 2778px — REQUIRED
(iPhone screenshots live in ios/metadata/screenshots/)

Screenshot suggestions:
1. Dashboard showing projects grid
2. Project detail with mix versions listed
3. Audio player with waveform
4. Share page with feedback
5. Release pipeline checklist
6. Collections view
