---
name: mixing-intern
description: The mixing intern - the owner-only agent that takes a mix's Mix Check notes, fixes them in the actual Logic Pro project on the owner's Mac, bounces and uploads a new version, started from the mixBASE app. Use before changing or answering anything about the intern, driving Logic Pro, the Mac app's Accessibility permission, or /api/intern routes.
---

# The mixing intern

Working since 2026-11-19: a job handed over for CATALYST MASTER 5 went end to end on the owner's Mac with nobody at it (see "Proved on CATALYST"). The button is on the Mix Check card, app and web. It fixes one kind of note so far: a band that changed since the previous version.

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
- **The project is not always the handed mix.** So the copy is bounced untouched first and judged, and that bounce is the "before" for everything after: the moves are sized on its bands, and a note it already had is not counted as one the fix brought. A project that no longer shows the notes fails with a sentence saying so. CATALYST showed why: its masters were not made by this project's bounce (the project bounces 2.7 LU quieter than MASTER 4, with 3 dB more low end than MASTER 5). The intern still fixes the note in the project, and the change list says the bounce "is not MASTER 5 exactly" with the bands that differ.
- **One helper at a time.** A second copy exits at once: two would each run a worker and both reach for Logic (it happened during development, through repeated installs).
- **Leftovers.** Every folder a job makes beside the owner's files is written to `leftovers.json` first and removed at the end of the job, or at the next start if the job died. Only names the intern gave (`mixBASE Intern …`) are ever removed.

## What exists

- **The button** on the Mix Check card: `src/components/InternPanel.tsx` (inside `MixCheck.tsx`) and `InternPanel` in `ios/mixBase/Views/Projects/MixCheckCard.swift`. "Hand to the intern" when the check has a note other than the genre one; then "Waiting for your Mac" (queued, or a job gone quiet), the stage the Mac reports, the change list, Stop; "Try again" after a failure. When the job finishes the page or the song screen reloads so the new version shows. On a version the intern made, the panel shows the change list that made it (`made_by` in GET). The app shows the card on the LATEST version only, so after a job the card is on the intern's upload.
- **Jobs** (migration 046, `mb_intern_jobs`, applied to production 2026-11-18; one job in flight per mix). `src/lib/intern-jobs.ts` holds the rules: which notes a job is handed (`notesForJob`: every open note, never the genre note) and what the Mac app may report (`sanitizeReport`). Routes, all owner-only:
  - `POST|GET|DELETE /api/versions/<id>/intern`: hand a mix over, read the newest job (and `made_by`, the finished job whose upload this version is), cancel.
  - `POST /api/intern/jobs/claim`: the helper asks for work (the answer's `song.filenames` are every filename the song's mixes were uploaded under); one conditional UPDATE, and a job gone quiet for 4 minutes is handed out again.
  - `PATCH /api/intern/jobs/<id>`: stage, changes, then `done` with the uploaded version or `failed` with why. Every report is the heartbeat; a 409 with `status: cancelled` tells the app to stop.
- The earlier probe sent through the Mac's auto-deploy helper (`scripts/mac-probe.*`) never reported and was removed: that helper is not running on the owner's Mac.
- **The rules for a measured note** (`src/lib/intern-rules.ts`, pure, no AI; `scripts/intern-rules-test.mjs`). Only `changed.<band>` has a rule so far; every other note is skipped with a sentence saying why.
  - Each exported track is measured over the mix's kick sections (`coreWindows` of the job's `sections`) into an absolute power spectrum (`createTrackMeter`). `planFixes` tries moves on those spectra and solves the size: the band is aimed 1 dB from where the earlier mix had it, not at zero (some of the change may have been meant).
  - A **level** move wins on any track where it shifts no other band by 0.5 dB; otherwise one **bell** centred on the band (`bellFor`) on the track carrying most of it; otherwise a bell on up to three tracks. Never more than 6 dB a move. A plan that would push a fine band towards a note of its own, or move loudness by 1 dB, is refused.
  - The test is a closed loop: synthetic tracks, a real gain and a real EQ filter applied to the audio, and the real Mix Check finding both notes gone. The prediction was within 0.1 dB there; real projects have bus and output processing, which is what `sumVsMix` and `refine` are for.
- **The command the helper runs**: `node scripts/intern-plan.mjs plan|judge|refine` (usage at the top of the file). It takes the claim's JSON and audio files and prints JSON; audio is decoded by the same ffmpeg call as the server (`npm ci` installs an Apple-silicon ffmpeg). `plan --mix` reports whether the tracks add up to the mix band by band. `judge` runs Mix Check on a bounce locally, so a bounce that did not clear its notes is never uploaded; it cannot see the catalog and genre comparisons, so the server's check after upload is the last word.
- **What an intern's bounce is compared with**: see the `mix-check` skill, "What it compares with". The helper must report `{ result_version_id }` in a PATCH BEFORE it starts Mix Check on the upload, or the check compares the fix with the mix it fixes. `claim` returns that earlier mix as `song.baseline` (label + summary).

## Driving Logic Pro 12.4 (found by trying, 2026-11-19)

All of it through the Accessibility API from the helper, on a copy of CATALYST (43 strips). The code is `scripts/intern-logic.mjs`; `node scripts/intern-ax.mjs -t ax.dump …` shows any of it as an outline.

**What works**

- **The mixer reads completely.** Main window > group `Mixer` > layout area `Mixer` > one `AXLayoutItem` per channel strip, described by the strip's name. Inside: name field, `volume fader` (value description "-9.2 dB"), pan, output slot ("Bus 2"), each insert as a group named after the plug-in ("Pro-Q 4") holding `bypass` / `open` / `list`, and empty slots as buttons described `audio plug-in`. Everything reads as disabled; it works anyway.
- **Inserting a plug-in:** press the empty slot with the smallest y (the one right after the last insert). A menu opens (`AXMenu`, first under the application); walk `Utility > Gain > Stereo` or `EQ > Channel EQ > Stereo` by pressing the last item. The plug-in's window opens, titled with the strip's name.
- **Controls view lists every parameter, stock or third-party.** The window's `view` menu button > `Controls`. Each row is a label ("Gain:", "Peak 1 Frequency:", "Band 1 Gain:"), a readout ("-2.4 dB") and a slider. Setting the row's slider value sets the parameter exactly and the readout confirms it (Gain: 936 = -2.4 dB; Pro-Q 4 Band 1 Gain: 30500 = +0.50 dB). The slider's scale is the plug-in's own and not linear, so `setNumber` closes in on the readout. In the EDITOR view of Gain, setting the slider only moves it one step.
- **Bounce:** `File > Bounce > Project or Section…` > a dialog with the destinations table, file type, bit depth, normalize, range > `OK` > a save panel > `Bounce`. A progress window titled "Logic Pro" shows until it is done (15 to 90 s for a 4.5-minute song).
- **Export:** `File > Export > All Tracks as Audio Files…` is an open panel with the options in it: range, file type, bit depth, `Bypass Effect Plug-ins`, `Include Volume/Pan Automation`, normalize. 36 tracks took about 3.5 minutes. Files are named `<project> - <track>.wav`; a repeated track name gets `_1`, `_2` in mixer order. Empty tracks are not exported.
- **A track stack's own strip is exported too**, and it is the sum of its tracks. It is an aux (an input slot, no `record` button) fed by the bus its tracks output to: `sumTracks()` sets those exports aside or everything inside a stack counts twice.
- **Close without saving:** `File > Close Project`, then `Don't Save` if asked.

**What does not, and what is done instead**

- **Typed keys do not reach Logic's dialogs** (CGEvent to the process, the Accessibility key call, with Logic in front or not). So no Go to Folder, and a full path typed as the file name is taken as a NAME (it wrote a file literally called that into the owner's bounce folder).
- **Changing Logic's last-folder preference from outside does nothing while it runs**: Logic passes the bounce dialog its own remembered folder.
- **So each job makes its own folder with the dialog's New Folder button**, inside whatever folder the dialog opened in, named `mixBASE Intern <job>-N.nosync` (iCloud Drive leaves `.nosync` alone; the owner's bounce folder is in iCloud Drive). The files are moved out and the folder removed when the job ends. Logic then remembers a folder that no longer exists and opens the next dialog in its parent, which is the owner's own folder again. The folder's full path is read from Logic's `NSOSPLastRootDirectory` preference after the save (`logic.savedir`).
- **Reading inside a third-party plug-in's editor can hang for minutes.** A project opens with whatever plug-in windows it was saved with. A plug-in window is recognised from the window's direct children only (its `view` menu button) and closed first.
- **A dialog that has just appeared ignores a press** (New Folder needed a second press): wait 1.5 s after any window appears.
- **A menu item can read as greyed out when it is not.** Logic works out which items are enabled only when the menu is opened; after a project loads, `Bounce` still read as disabled from when nothing was open. The helper opens the menu to make Logic look again, then presses.
- **Logic closes the open project when another is opened** (no question when it is saved). The intern reopens it when the job ends. If the open project has unsaved changes Logic asks, and the intern never answers that: it cancels and fails the job with "Save or close it on the Mac".
- **With the display asleep, Logic's windows cannot be read** (the window list comes back as one nameless element). The helper wakes the display (`sys.wake`, a declared user activity) and holds it awake for the job. On the owner's Mac a password is only asked for after an hour of display sleep; past that the helper cannot unlock it, and the job waits at "Waiting for your Mac to be unlocked".
- **The export dialog keeps the options the intern sets** (32-bit float, normalize off, automation included) for the owner's next export. The bounce dialog's options are left as the owner had them, apart from making sure one uncompressed WAVE is chosen.
- **A Mac terminal cannot read the owner's iCloud, Desktop, Documents or Downloads folders** (macOS asks, and nobody is there). The helper can (Full Disk Access), which is why file moves are the worker's job.

## Proved on CATALYST (2026-11-19)

The owner asked for CATALYST instead of EVERGREEN. Its newest mix, MASTER 5, had only a summary measurement, so Mix Check was run on it first (through the worker's local hand-off, `check_first`).

- Mix Check on MASTER 5 against MASTER 4: sub 5.8 dB lower (`changed.sub`, high), plus six notes the intern has no rule for and the owner's own "Needs sub".
- The job, 8 minutes: found `CATALYST.logicx` among 241 projects, copied it, bounced the copy untouched (80 s), exported 36 tracks (3.5 min), set four stack sums aside, planned **SUB: level +3.6 dB**, added a Gain last on the SUB strip, bounced, judged (sub 2.9 dB under MASTER 4 before, 0.7 dB under after; nothing new), saved the copy, uploaded it as version 27 "MASTER 5 (intern)", told the server, ran Mix Check there (compared with MASTER 4, `changed.sub` gone), finished `done`.
- The original project's files were not modified (same modification time as before), Logic was left with nothing of the intern's open, and both `.nosync` folders were removed.
- **What that version is and is not.** CATALYST's masters were not made by this project's bounce: the untouched bounce is -12.2 LUFS against MASTER 5's -9.6, with about 3 dB more low end. So "MASTER 5 (intern)" is the Logic project with the sub fixed, not MASTER 5 with the sub fixed, and Mix Check on it still shows what the project itself differs by (`changed.punch`, `changed.upperBass`, `changed.loudness`). The change list says so.
- Also tried with real jobs: starting with the display asleep (the helper woke it and went on), and Stop (the job ended at its next step, closed the copy, removed its folder, uploaded nothing).
- Not tried: a tap on the button itself (the hand-offs were filed by the worker with the owner's token, through the same route the button calls), and a Mac that has been asleep for over an hour.

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

- Only `changed.<band>` has a rule. Every other measured note, and every note a person wrote ("Needs sub"), is handed over and skipped with a sentence saying why.
- A job needs the Mac awake and not password-locked. After an hour of display sleep the owner's Mac asks for a password; the job then sits at "Waiting for your Mac to be unlocked".
- Stop is noticed between steps, so a bounce or an export in progress finishes first (up to a few minutes).
- A project whose masters are made somewhere else gives a bounce that is not the master (CATALYST). The intern says so in the change list; it cannot master.
- Tracks that share a name are told apart by Logic's export numbering (`HOOK`, `HOOK_1`), assumed to follow mixer order.
- The owner's EVERGREEN project was open in Logic when the work began and was closed by the first copy that was opened (it had no unsaved changes). A job reopens what was open; the exploration by hand did not.
