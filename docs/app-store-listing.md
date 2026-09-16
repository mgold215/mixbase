# mixBase — App Store Listing Copy

All text ready to paste directly into App Store Connect.

---

## App Name (30 chars max)
```
mixBase
```

## Subtitle (30 chars max)
```
Mix Versions, Rough to Release
```

## Promotional Text (170 chars max — appears at top, can be updated without a new review)
```
Every bounce, mix and master in one place. Track every version, share private links for timestamped feedback, and run your release checklist from rough to release.
```

## Description (4000 chars max)

```
mixBase is version control for your music. Every time you bounce a mix, upload it: mixBase keeps every version of every track, from the first rough to the final master, so you can hear how far a song has come and never lose a good take again.

TRACK EVERY VERSION
Each upload becomes the next numbered mix of its project. Label it (rough mix, mix 2, final master), move it from Mix to Master to Released, add private notes and a change log, and jump back to any earlier version at any time.

LISTEN ANYWHERE
A full-screen player with artwork, scrubbing, a queue, shuffle and repeat, lock-screen and Control Center controls, AirPlay, and a Now Playing widget for your home screen.

SHARE FOR FEEDBACK
Send a private listening link for any mix. Collaborators open it in a browser, no account required, and leave comments pinned to the exact moment they mean. Their notes show up on that mix in the app.

MASTER CHECK
Measure the loudness of your latest mix (LUFS and peak) right on your phone and get limiter and chain recommendations before you send it off.

RUN YOUR RELEASE PIPELINE
Add a release and check off every milestone: mixing done, mastering done, artwork ready, submitted to DSPs, social posts out, press release sent. Keep your released catalog, with ISRC, UPC and release dates, in one library synced from your streaming profile.

AI COVER ART
Describe the vibe and generate cover-art concepts for a track, then apply the one that fits. Every account includes a monthly allowance.

HEAR WHAT OTHERS ARE MAKING
The community feed shows what other artists on mixBase are working on, with comments on every upload. Report or block anything you don't want to see.

BUILT FOR THE STUDIO
- Genre, BPM and key on every project
- Albums, EPs and playlists to group your tracks
- A dark interface that won't blind you in a dim room

mixBase is free. There are no subscriptions, paid plans or in-app purchases.
```

---

## Keywords (100 chars max — comma-separated, no spaces after commas)
```
music production,mix versions,version control,producer,mastering,release pipeline,feedback,daw
```

## Support URL
```
https://mixbase.app/support
```

## Privacy Policy URL
```
https://mixbase.app/privacy
```

## Primary Category
```
Music
```

## Secondary Category
```
Productivity
```

## Age Rating
- No objectionable content
- No user-generated content visible to other users (feedback is private to the project owner)
- Rating: **4+**

## Copyright
```
© 2026 mixBase
```

---

## App Review Information

### Demo Account for Review Team
Create a dedicated review account before submission:
- **Email:** `review@mixbase.app` (or a real mailbox you control)
- **Password:** (set when you create it via the sign-up flow)

Upload at least one project with two versions and a share link so reviewers can exercise all major features.

### Notes for App Review
```
mixBase is a music version-control and release-management tool for music producers.

To test the app:
1. Sign in with the provided demo credentials.
2. The demo account includes a sample project "Demo Track" with two uploaded versions.
3. Tap a project to see version history, playback, and notes.
4. Tap "Share" on any version to open a public share link (no sign-in required for the listener).
5. The Pipeline tab shows a sample release with checklist items.

The app requires an internet connection to load audio files. No special hardware or external services are required for basic testing.
```

### Export Compliance
- Does the app use encryption beyond what is built into iOS? **No**
- The app uses HTTPS (standard ATS) for all network communication. No custom encryption algorithms are implemented.
- Select **"No"** on the export compliance question in App Store Connect.

---

## In-App Purchases
None. mixBase is free on every platform — there are no subscriptions or paid plans on the website or in the apps (decision 2026-09-12, after App Review's 2.1(b) business-model questions). If the app ever charges for anything, it will be offered only through Apple's In-App Purchase; nothing is planned.

---

## What's New (Version 1.0.1)
```
A refreshed App Store listing with new screenshots, plus:
- Project cards show each track's real mix status.
- The Home dashboard's Mixing count reflects tracks still in progress.
- The community feed shows the upload date and time.
- Now Playing shows the song title on its own line.
- Settings shows the installed version.
```

## What's New (Version 1.0)
```
First release. Build your music version history, share tracks for feedback, and manage your release pipeline — all in one place.
```

---

## Screenshots (automated)

Store screenshots are captured on a GitHub macOS runner, not by hand: the
`App Store Listing` workflow (`.github/workflows/app-store-listing.yml`,
push-driven TEMP branch `asc7-listing`) builds the app for an iPhone 17 Pro Max
simulator, signs in as the App Review demo account (login read from the
version's review detail in App Store Connect, so no extra secret exists) and
runs the XCUITest tour in `ios/screenshots/` — Home, Projects, Project detail,
Now Playing, Pipeline, Artwork, Feed. The PNGs land in `ios/metadata/screenshots/`
(6.9", 1320x2868); the 6.5" set is derived by resizing. `listing-request.json`
chooses inspect vs publish, which shots to upload and whether to submit;
`listing-copy.json` is the source of truth for the copy above.

The demo account (review@mixbase.app) was seeded 2026-09-16 with the
developer's three released singles, three mixes each, listener feedback, a
release pipeline at three stages, the released-track library and a collection,
so every screen has real content. Its cover art is refreshed from the released
catalog by the workflow's seed job.
