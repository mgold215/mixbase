---
name: mix-check
description: Mix Check, the owner-only whole-song mix analysis (no AI) on web and in the app - measures a mix, compares it with the previous version, the artist's catalog and genre references, and writes its findings into the mix notes. Use before changing or answering anything about mix analysis, loudness or balance findings, "Mix Check" notes, genre references (mb_mix_references), or a check that seems to vanish mid-run.
---

# Mix Check

Owner-only for now, web + app, no AI. Shipped 2026-11-17.

## Why it exists

The owner, after a by-hand analysis found CATALYST MASTER 5 had lost 6 dB of sub:

- "implement this functionality on mixbase… analyze a whole song and point out problems in the mix, and mark them in the mix notes"
- then: "all songs in catalog, and also referenced against industry standard in my genre"
- and: "I generally use the app in 95% of the time", so it is in the app too

## Routes and files

- `POST|GET /api/versions/<id>/mix-check`: 404 unless `isAdminIdentity`. An in-process job, ONE at a time, lost on deploy by design. The REPORT is stored on `mb_versions.mix_check` (migration 045), so it is there after a reload or a deploy.
- `POST /api/mix-check/references`: adds a genre reference track (see [References](#references)).

| File | Role |
|---|---|
| `src/lib/mix-check.ts` | Measures. Pure, streaming: ffmpeg's PCM is piped in chunk by chunk, ~7 s of CPU for a 4.5-minute WAV, a few MB of memory. BS.1770 loudness, true peak, twelfth-octave band powers and left/right cross power per frame, clipping, holes, a cut-off tail |
| `src/lib/mix-check-findings.ts` | Judges. Pure |
| `src/lib/mix-check-server.ts` | Decodes, loads the comparisons, stores the report and syncs the notes |
| `src/components/MixCheck.tsx` | Web: the card on the current mix, shown when `ownerTools`. It wraps `MasterCheck.tsx` (the loudness readout) through its `mixCheck` prop |
| `ios/mixBase/Views/Projects/MixCheckCard.swift` | App: the card on the song screen, shown when `authService.ownerTools`. It draws `LoudnessReadout` (ProjectDetailView.swift) at its top |
| `scripts/mix-check-test.mjs` | Builds synthetic mixes and checks every rule |

The app measures and judges nothing: it draws from the same routes. The frequency axis and the genre families come with the report as `options`, not copied into Swift. `scripts/ios-parity-test.mjs` no longer lists either route.

## One card with the loudness readout

The owner, 2026-11-17: "Remove the chain and limiter recommendations and combine the existing master check with Mix Check".

- The limiter and chain advice is gone from both clients. Do not bring plugin-settings advice back.
- For the owner the loudness readout (LUFS, peak, what each platform's normalizer does, the verdict, and on the web the change since the previous mix) is the TOP of the Mix Check card, under ONE button.
- A check also writes the loudness columns of migration 032 (`fillLoudness`, from its own measurement, `loudness_algo` `mix-check-v1`), only when the mix has no reading: a reading the browser or the app took is never replaced. GET returns them as `loudness`. A mix checked before this gets them from its stored report on the next GET. So the owner's phone does not download the mix to measure it.
- Everyone else (Mix Check is still owner-only) has the loudness card alone, titled Master check and measured on the device. So do archived mixes in the web's version history.
- The check's numbers agree with the browser's to within 0.1 dB on the test mix. On a 48 kHz file the sample peak is read after the 44.1 kHz decode and can differ by a tenth or two.

## How it measures

- **Sections.** "Where the kick plays" is found by matching every fast rise of the low band against a template of the song's most REPEATED hit. Not the strongest hit and not a tempo grid: a sub note entering out of silence rises harder than any kick, and two detuned subs beat like a rhythm. Both fooled the first two tries.
- **Core.** The core every comparison uses is those sections within 4 LU of their upper quartile. Every level is gained to −10 LUFS first, so a mix and a master compare.

## What it compares with

1. **The previous version of the song.** Measured on the spot if it never was; summary kept on its row, no notes written there.
2. **The artist's catalog** = the newest measured version of every other song, mixes and masters alike. Needs 6. All 71 of the owner's songs were measured from a remote session on 2026-11-17 and written as summary-only rows.
3. **The genre** = `mb_mix_references` rows of the song's family. `genreFamily()` maps the free-text genre. A song with no genre uses the artist's most common family and the report says so. Needs 5.

## References

References are measurements only, never audio.

- The shared set (`user_id` null) was measured from 30-second store previews of tracks picked per family, kept only when the clip is at least 70% kick section. A 30 s excerpt of a full section measures within about 2 dB of the whole track; an intro or a breakdown does not.
- Previews are trusted for balance only: never for loudness, and not for the top octave.
- `POST /api/mix-check/references` adds a track from a full-quality file: uploaded through `/api/upload-url` as `<projectId>/mixref-<stamp>.<ext>`, measured, then DELETED from Storage whether or not it measured. It replaces the preview of the same track.

## Findings become notes

- Each finding is one `mb_feedback` row under the byline `Mix Check` (`MIX_CHECK_AUTHOR`, refused to listeners by `POST /api/feedback`), timestamped where that makes sense. So it shows in the notes list, on the scrubber, in the Mix Session, the punch list and the AI summary with no other change, and in the app.
- A re-run deletes the notes the last run wrote and writes new ones, EXCEPT a note the owner ticked off: its finding is left alone. Ids live in the report's `findings[].note_id`.
- One fact, one note:
  - a band that changed since the last version absorbs its catalog comparison
  - the genre comparison is ONE note for the whole tilt
  - a comparison with the catalog alone is never rated "high" (unusual for you is not wrong)
- At most 12 notes.

What the first runs showed: the owner's catalog sits about 7 dB lighter in the sub and 4 to 5 dB more forward in the mids than the commercial melodic references at matched loudness. So nearly every song gets the genre note. That is the measurement, not a threshold set too tight.

## The run's state is on the row

Found by the first live test, 2026-11-17.

- Production is two processes (us-east4 + us-west2), and an in-process job is known only to the one running it. A poll or a second tap answered by the other one saw "nothing here" mid-check and could start a second run beside the first.
- A run now writes a marker into `mb_versions.mix_check`: `job: { state: 'running' | 'error', at, error? }`, beside the report it will replace (`mixCheckMarker` / `withMarker` in `mix-check-findings.ts`, pure and tested).
- GET and POST read it (`mixCheckState`). A finished report overwrites it. A running marker older than 4 minutes is a run that died with a deploy and counts for nothing.
- The other in-process jobs (finalize-video, the Studio's quick run) do NOT have this. If one of them ever "vanishes" mid-run, this is why.

## Tested live (2026-11-17)

With a throwaway admin account (`ADMIN_USER_IDS` + the `studio-qa` edge function, all removed afterwards; the method is in the `debugging-production` skill):

- A project whose two versions pointed at CATALYST MASTER 4 and 5 gave the same 7 notes as the offline run in about 13 s (7 s once the previous version is measured).
- A re-run kept the one note that had been ticked off and replaced the rest.
- Another account's version answered 404.
