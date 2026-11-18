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
- On how to work with them here: "You just seem to be presenting me with all these problems and variables and I just want you to let me know what it's done. I'm very clear about the end result I'm looking for." Reading: decide, build, and report what is finished. Do not bring them option lists or risk lists; ask only for something only they can do, once, in one line.

## Decisions

- **The Mac app is the intern's hands.** Logic only exists on the owner's Mac, and the mixBASE Mac app is already there, signed in as the owner and updating itself through TestFlight. So there is no separate helper to install, pair or keep alive. It is sandboxed: it drives Logic through the Accessibility API (the owner grants the permission once in System Settings), not through scripts or key presses.
- **Plug-ins are set through Logic's Controls view** (every plug-in window: View > Controls), which lists each parameter by name with a value. That is readable and settable without looking at pixels. The graphic editor is the fallback.
- **The judge is Mix Check.** A fix is kept only if the note it answers clears on the next bounce and no new note appears.
- **Measurable notes are fixed by rules, with no AI.** Judgment (listener notes, taste) goes to a Claude task on the subscription, never the API.
- **The intern never saves over the owner's project**: it works on a copy and uploads its bounce as a new version marked as its own.
- **The genre-reference note is never chased automatically.** It appears on nearly every song of the owner's; following it would reshape their sound.

## What exists

- `POST /api/intern/diagnostics` (owner-only): the Mac app reports what it can read of Logic. Rows land in `mb_mac_probe` (created by hand 2026-11-18, write-only for the public key, no migration file: it is temporary).
- `macos/MixbaseApp/InternDiagnostics.swift`: started by `AuthService` on the Mac when `ownerTools` is true. Read-only (`scripts/intern-test.mjs` fails the build if it ever acts on Logic). It asks for the Accessibility permission once, then reports whenever there is more to see: permission granted, Logic opened, a plug-in window opened.
- `scripts/mac-probe.sh` + `.swift`, called from `scripts/ios-autodeploy.sh`: an earlier one-off probe sent through the Mac's auto-deploy helper. Temporary; delete all three pieces once a report has come back by either route.

## What was researched (2026-11-18)

- Claude's own screen control cannot be started unattended on a subscription: the CLI refuses it outside an interactive session, the desktop app asks a person to approve each app per session, and cloud tasks cannot reach the Mac.
- An open-source Logic controller (MongLong0214/logic-pro-mcp, MIT) drives Logic through Accessibility, MIDI and control-surface channels; only 17 of its 138 operations were verified on Logic 13.0. Useful as a reference for what Logic exposes.
- Logic Pro 13's own Assistant needs Creator Studio and macOS 27, has no way for another program to call it, and nothing confirms it adjusts a mix.

## Next

1. Read the first report from the owner's Mac: does a sandboxed app get Logic's windows, and what does a plug-in's Controls view expose on Logic 13?
2. Teach the Mac app the moves, each read back after it is made: open a copy, export tracks, set a plug-in value, bounce.
3. The job: a button on the Mix Check card (app and web), the Mac app picks the job up, progress on the card, the new version on the song.
