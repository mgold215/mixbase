---
name: mixing-intern
description: The mixing intern - the owner-only agent that takes a mix's Mix Check notes, fixes them in the actual Logic Pro project on the owner's Mac, bounces and uploads a new version, started from the mixBASE app. Use before changing or answering anything about the intern, driving Logic Pro, the Mac app's Accessibility permission, or /api/intern routes.
---

# The mixing intern

In progress. Nothing the owner can use yet: the helper is installed on the Mac, the Logic steps are not proven.

## What the owner asked for (2026-11-18)

- "hand these mix notes off to the 'mixing intern' agent who then goes into the actual logic project, fixes the issues, and uploads a version to mixbase? Completely automated with no action required from me. I enjoy making the song 98% of the way but hate all the cleanup."
- "I should be able to initiate it all from mix base app."
- "No API usage." Nothing in this feature may be billed per use. The Claude subscription is fine.
- "Would need to be able to manipulate plugins which is just screen control. And knowing how logic works."
- "WHEN it's done", and "I'm also not gonna sit here all today responding to permission requests so I approve your access to do what you need to do." Reading: no progress notes; one message when it works end to end. Their approval covers this work's own tools; it cannot answer a macOS system prompt.
- On how to work with them here: "You just seem to be presenting me with all these problems and variables and I just want you to let me know what it's done. I'm very clear about the end result I'm looking for." Reading: decide, build, and report what is finished. Do not bring them option lists or risk lists; ask only for something only they can do, once, in one line.

## Decisions

- **The hands are a small helper on the owner's Mac that is NOT sandboxed.** Logic only exists there. The first plan was the mixBASE Mac app itself; the owner's Mac proved that cannot work (2026-11-19): the app is sandboxed (TestFlight requires it), and with the Accessibility permission switched on it reported `ax_trusted=true` and still could not read Logic's menu bar or a single window. A sandboxed app is not allowed to talk to another app's interface, whatever the permission says. So the helper is built and run on the Mac itself, signed with the owner's Apple Development certificate (a stable signature, so the Accessibility permission survives rebuilds), started at login. It signs in to mixBASE as the owner and drives Logic through the Accessibility API.
- **The helper is developed in a Claude session ON the Mac**, where Logic can be driven and looked at for real. A cloud session cannot see Logic (see "Where it must be built"), and a loop through TestFlight costs a build, an update and the owner reopening an app for every try.
- **Plug-ins are set through Logic's Controls view** (every plug-in window: View > Controls), which lists each parameter by name with a value. That is readable and settable without looking at pixels. The graphic editor is the fallback.
- **The judge is Mix Check.** A fix is kept only if the note it answers clears on the next bounce and no new note appears.
- **Measurable notes are fixed by rules, with no AI.** Judgment (listener notes, taste) goes to a Claude task on the subscription, never the API.
- **The intern never saves over the owner's project**: it works on a copy and uploads its bounce as a new version marked as its own.
- **The genre-reference note is never chased automatically.** It appears on nearly every song of the owner's; following it would reshape their sound.

## The helper (`macos/MixbaseIntern`)

A menu-bar app, built and installed on the Mac itself: `cd macos/MixbaseIntern && ./install.sh` (re-run after any change; `./install.sh runtime` refreshes only the worker's files). Not in `project.yml`, not on TestFlight.

- **Swift is the hands, node is the head.** The app (`Sources/`) signs in, holds the two privacy switches, and answers commands against Logic (`AX.swift`: read the interface, press, set a value, pick a menu item, send a key). The job loop is `scripts/intern-worker.mjs`, which the app starts and restarts; it asks the app for the access token and for every touch of Logic over its stdout/stdin. So a change to how a job runs needs no rebuild.
- **Installed copy.** `install.sh` copies the worker, the rules it imports (`src/lib/intern-*.ts`, `mix-check*.ts`, `loudness.ts`) and ffmpeg into `~/Library/Application Support/MixbaseIntern/runtime/`, so the helper does not depend on a checkout. After changing any of those files, run `./install.sh runtime`; the helper restarts the worker when it exits.
- **Starts at login** through a LaunchAgent (`app.mixbase.intern`), restarted if it crashes; a normal Quit stays quit.
- **Signed with the Mac's Apple Development certificate** (`build.sh`), so the Accessibility and Full Disk Access switches survive a rebuild. `codesign` needed no password prompt.
- **What a person must do, once** (the setup window shows all three and their state): sign in to mixBASE (only the refresh token is kept, in the login Keychain), switch on Accessibility, switch on Full Disk Access. Full Disk Access is what lets it look for projects and copy them wherever they are without a folder prompt nobody is there to answer.
- **Trying a command by hand:** `node scripts/intern-ax.mjs ping`, `app.windows`, `ax.dump '{"el":"e12","depth":2}'`, `ax.menu '{"path":["File","Save"],"press":false}'`. This goes through a socket in the helper's folder that only the owner's account can open; it reaches Logic only and never gets the access token.
- **Trying a job without the app:** write `{"version_id":"…"}` to `~/Library/Application Support/MixbaseIntern/handoff.json`; the worker files the hand-off as the owner on its next pass.
- **Logs:** `~/Library/Logs/MixbaseIntern/` (`helper.log`, `worker.log`). Each job's working folder (the project copy, exported tracks, bounces, `plan.json`, `judge-N.json`) is `…/MixbaseIntern/jobs/<job id>/`; the newest five are kept.
- **Finding the project** (`scripts/intern-find.mjs`): Spotlight, and a walk of the home folder and other drives when Spotlight has nothing (on 2026-11-19 its index was rebuilding and answered zero). Matched by name against the song's title AND every filename its mixes were uploaded under (`song.filenames` in the claim): EVERGREEN was CORRIDOR for its first two mixes. No match is an `error` on the job, never a guess.
- **The project may be ahead of the handed mix.** So the copy is bounced untouched first and judged; the plan is made from THAT measurement, and a project that no longer shows the notes fails with a sentence saying so.

## What exists

- **Jobs** (migration 046, `mb_intern_jobs`, applied to production 2026-11-18; one job in flight per mix). `src/lib/intern-jobs.ts` holds the rules: which notes a job is handed (`notesForJob`: every open note, never the genre note) and what the Mac app may report (`sanitizeReport`). Routes, all owner-only:
  - `POST|GET|DELETE /api/versions/<id>/intern`: hand a mix over, read the newest job, cancel.
  - `POST /api/intern/jobs/claim`: the Mac app asks for work; one conditional UPDATE, and a job gone quiet for 4 minutes is handed out again.
  - `PATCH /api/intern/jobs/<id>`: stage, changes, then `done` with the uploaded version or `failed` with why. Every report is the heartbeat; a 409 with `status: cancelled` tells the app to stop.
- The earlier probe sent through the Mac's auto-deploy helper (`scripts/mac-probe.*`) never reported and was removed: that helper is not running on the owner's Mac.
- **The rules for a measured note** (`src/lib/intern-rules.ts`, pure, no AI; `scripts/intern-rules-test.mjs`). Only `changed.<band>` has a rule so far; every other note is skipped with a sentence saying why.
  - Each exported track is measured over the mix's kick sections (`coreWindows` of the job's `sections`) into an absolute power spectrum (`createTrackMeter`). `planFixes` tries moves on those spectra and solves the size: the band is aimed 1 dB from where the earlier mix had it, not at zero (some of the change may have been meant).
  - A **level** move wins on any track where it shifts no other band by 0.5 dB; otherwise one **bell** centred on the band (`bellFor`) on the track carrying most of it; otherwise a bell on up to three tracks. Never more than 6 dB a move. A plan that would push a fine band towards a note of its own, or move loudness by 1 dB, is refused.
  - The test is a closed loop: synthetic tracks, a real gain and a real EQ filter applied to the audio, and the real Mix Check finding both notes gone. The prediction was within 0.1 dB there; real projects have bus and output processing, which is what `sumVsMix` and `refine` are for.
- **The command the helper runs**: `node scripts/intern-plan.mjs plan|judge|refine` (usage at the top of the file). It takes the claim's JSON and audio files and prints JSON; audio is decoded by the same ffmpeg call as the server (`npm ci` installs an Apple-silicon ffmpeg). `plan --mix` reports whether the tracks add up to the mix band by band. `judge` runs Mix Check on a bounce locally, so a bounce that did not clear its notes is never uploaded; it cannot see the catalog and genre comparisons, so the server's check after upload is the last word.
- **What an intern's bounce is compared with**: see the `mix-check` skill, "What it compares with". The helper must report `{ result_version_id }` in a PATCH BEFORE it starts Mix Check on the upload, or the check compares the fix with the mix it fixes. `claim` returns that earlier mix as `song.baseline` (label + summary).

## What the owner's Mac showed (2026-11-19)

- macOS 15.6.1, Apple silicon. **Logic Pro 12.4** (`com.apple.logic10`), not 13: Logic's own Assistant is not there.
- 386 Audio Unit effects and instruments, Universal Audio (UAD) among them.
- The mixBASE Mac app (build 202611181857) is signed in as the owner and reaches `/api/intern/diagnostics`.
- Sandboxed + Accessibility on = `ax_trusted=true`, menu bar unreadable, 0 windows. See Decisions.
- Finding the right switch took the owner three tries: it is System Settings > Privacy & Security > Accessibility (a list of apps), NOT Keyboard > Keyboard Shortcuts > Accessibility. A sandboxed app must be added with the + button by hand.

## What was researched (2026-11-18)

- Claude's own screen control cannot be started unattended on a subscription: the CLI refuses it outside an interactive session, the desktop app asks a person to approve each app per session, and cloud tasks cannot reach the Mac.
- An open-source Logic controller (MongLong0214/logic-pro-mcp, MIT) drives Logic through Accessibility, MIDI and control-surface channels; only 17 of its 138 operations were verified on Logic 13.0. Useful as a reference for what Logic exposes.
- Logic Pro 13's own Assistant needs Creator Studio and macOS 27, has no way for another program to call it, and nothing confirms it adjusts a mix.

## Where it must be built

A cloud session cannot do the Mac half (tried 2026-11-19): the Mac's folders are in the owner's Remote Control list but are not offered to cloud sessions, and every tool a cloud session has runs in its own Linux container. Steps 1 to 3 below need Claude Code started ON the Mac, in the repository folder.

## Next

1. With a COPY of a project open in Logic, find out by trying: read the mixer and a plug-in's Controls view through Accessibility, set one value and read it back, export all tracks, bounce, Save As. Write down what works on Logic 12.4. For the export: WAVE, volume and pan automation included, effects not bypassed, or the tracks will not add up to the mix (`plan --mix` shows it).
2. Build the helper (a new folder under macos, named MixbaseIntern; not sandboxed): sign in as the owner, poll `POST /api/intern/jobs/claim`, work on a COPY of the project, report each stage with `PATCH /api/intern/jobs/<id>`. Per job: export tracks, `plan`, make the moves (a level move as a Gain plug-in or the fader, a bell as a new Channel EQ band), bounce, `judge`, `refine` and re-bounce while it says `changed`, upload only a bounce `judge` keeps, report `result_version_id`, run Mix Check on it, finish `done` or take the version back and finish `failed`. Install it to start at login.
3. Prove it on EVERGREEN (sub up 3.4 dB and low mids down 2.6 dB since MIX 1).
4. The button on the Mix Check card (app and web) with progress, the result and Stop. Only once a real job has gone end to end.
5. Remove `InternDiagnostics.swift`, its call in `AuthService.swift`, `/api/intern/diagnostics` and the `mb_mac_probe` table.
