---
name: mixing-intern
description: The mixing intern - the owner-only agent that takes a mix's Mix Check notes, fixes them in the actual Logic Pro project on the owner's Mac, bounces and uploads a new version, started from the mixBASE app. Use before changing or answering anything about the intern, driving Logic Pro, the Mac app's Accessibility permission, or /api/intern routes.
---

# The mixing intern

In progress. Nothing the owner can use yet.

## What the owner asked for (2026-11-18)

- "hand these mix notes off to the 'mixing intern' agent who then goes into the actual logic project, fixes the issues, and uploads a version to mixbase? Completely automated with no action required from me. I enjoy making the song 98% of the way but hate all the cleanup."
- "I should be able to initiate it all from mix base app."
- "No API usage." Nothing in this feature may be billed per use. The Claude subscription is fine.
- "Would need to be able to manipulate plugins which is just screen control. And knowing how logic works."
- "WHEN it's done", and "I'm also not gonna sit here all today responding to permission requests so I approve your access to do what you need to do." Reading: no progress notes; one message when it works end to end. Their approval covers this work's own tools; it cannot answer a macOS system prompt.
- On how to work with them here: "You just seem to be presenting me with all these problems and variables and I just want you to let me know what it's done. I'm very clear about the end result I'm looking for." Reading: decide, build, and report what is finished. Do not bring them option lists or risk lists; ask only for something only they can do, once, in one line.

## Decisions

- **The hands are a small helper on the owner's Mac that is NOT sandboxed.** Logic only exists there. The first plan was the mixBASE Mac app itself; the owner's Mac proved that cannot work (2026-11-19): the app is sandboxed (TestFlight requires it), and with the Accessibility permission switched on it reported `ax_trusted=true` and still could not read Logic's menu bar or a single window. A sandboxed app is not allowed to talk to another app's interface, whatever the permission says. So the helper is built and run on the Mac itself, signed with the owner's Apple Development certificate (a stable signature, so the Accessibility permission survives rebuilds), started at login. It signs in to mixBASE as the owner and drives Logic through the Accessibility API.
- **The helper is developed in a Claude session ON the Mac**, where Logic can be driven and looked at for real. A cloud session cannot see Logic, and a loop through TestFlight costs a build, an update and the owner reopening an app for every try.
- **Plug-ins are set through Logic's Controls view** (every plug-in window: View > Controls), which lists each parameter by name with a value. That is readable and settable without looking at pixels. The graphic editor is the fallback.
- **The judge is Mix Check.** A fix is kept only if the note it answers clears on the next bounce and no new note appears.
- **Measurable notes are fixed by rules, with no AI.** Judgment (listener notes, taste) goes to a Claude task on the subscription, never the API.
- **The intern never saves over the owner's project**: it works on a copy and uploads its bounce as a new version marked as its own.
- **The genre-reference note is never chased automatically.** It appears on nearly every song of the owner's; following it would reshape their sound.

## What exists

- `POST /api/intern/diagnostics` (owner-only): the Mac app reports what it can read of Logic. Rows land in `mb_mac_probe` (created by hand 2026-11-18, write-only for the public key, no migration file: it is temporary).
- `macos/MixbaseApp/InternDiagnostics.swift`: started by `AuthService` on the Mac when `ownerTools` is true. Read-only. It did its job (see "What the owner's Mac showed") and can be removed once the helper exists; its Accessibility prompt never appears, because macOS does not show that prompt for a sandboxed app.
- **Jobs** (migration 046, `mb_intern_jobs`, applied to production 2026-11-18; one job in flight per mix). `src/lib/intern-jobs.ts` holds the rules: which notes a job is handed (`notesForJob`: every open note, never the genre note) and what the Mac app may report (`sanitizeReport`). Routes, all owner-only:
  - `POST|GET|DELETE /api/versions/<id>/intern`: hand a mix over, read the newest job, cancel.
  - `POST /api/intern/jobs/claim`: the Mac app asks for work; one conditional UPDATE, and a job gone quiet for 4 minutes is handed out again.
  - `PATCH /api/intern/jobs/<id>`: stage, changes, then `done` with the uploaded version or `failed` with why. Every report is the heartbeat; a 409 with `status: cancelled` tells the app to stop.
  - No screen calls these yet: a button with no hands behind it would be a dead control.
- The earlier probe sent through the Mac's auto-deploy helper (`scripts/mac-probe.*`) never reported and was removed: that helper is not running on the owner's Mac.

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

## Next

All of it happens in a Claude session on the owner's Mac.

1. With Logic open, find out by trying: read the mixer and a plug-in's Controls view through Accessibility, set one value and read it back, export all tracks, bounce. Write down what works on Logic 12.4.
2. Build the helper (a new folder under macos, named MixbaseIntern; a command-line tool or a menu-bar app, not sandboxed): sign in as the owner, poll `POST /api/intern/jobs/claim`, work on a COPY of the project, report each stage with `PATCH /api/intern/jobs/<id>`, upload the bounce as a new version, finish the job. Install it to start at login.
3. The rules that choose a fix for a measured note (start with `changed.<band>`: find the track that carries the band from the exported tracks, correct it with a gain or EQ move, bounce, and keep the move only if Mix Check's next run clears the note).
4. The button on the Mix Check card (app and web) with progress, the result and Stop. Only once a real job has gone end to end.
