---
name: app-store-connect
description: App Store Connect work for mixBASE without a Mac - the store listing (copy, screenshots), creating and submitting a version, resubmitting to App Review, territory availability, and what got the app approved. Use before any App Store submission, listing or screenshot change, a "not available in your country or region" report, a reply to App Review, or after a version is approved (the version number must be bumped). For building and installing the app use the ios-build-deploy skill.
---

# App Store Connect

## Where things stand

- The Apple Developer Program is ACTIVE (paid; team `AP8UC39D4D`). The app has an App Store Connect record and API key. Never suggest joining the program.
- **1.0 went LIVE 2026-09-15**: https://apps.apple.com/app/mixbase/id6763808906 (submission 902f9887, build 202609081333).
- **1.0.1** was submitted 2026-09-25 and approved; its train is closed. The project is on 1.0.2.
- Bundle id `com.moodmixformat.mixbase`, shared by iOS and macOS (one universal app record).

## What finally passed review

1.0 was approved after 7 submissions (findings: 3.1.1 paid content, 1.2 UGC, 5.1.1 deletion, 2.1 info requests). What passed:

- Native in-app Terms / Privacy / Support, with no links to the website.
- UGC report/block backed by real tables.
- NO paid plans anywhere (see AGENTS.md → No paid plans).

Do not undo any of these.

## After every App Store release: bump the version

Apple closes the released train. Bump `MARKETING_VERSION` in `ios/mixBase.xcodeproj/project.pbxproj` (all four build configurations, app + widget) before the next iOS merge.

- 2026-09-15 → 09-16: every TestFlight upload failed with "The train version '1.0.0' is closed for new build submissions" until 1.0.0 → 1.0.1 (PR #163).
- It happened AGAIN after 1.0.1's approval: iOS TestFlight runs #43–#49 (2026-09-26 → 10-03) all failed with "The train version '1.0.1' is closed", and nothing reached the phone until 1.0.1 → 1.0.2.
- The macOS lane kept working only because the Mac has no released version yet.
- `macos-app.yml` (the PR compile gate) cannot catch this. Check the version whenever an App Store submission has been approved.

## How remote sessions drive App Store Connect

Remote sessions cannot dispatch workflows (`workflow_dispatch` is 403). The lanes are driven by pushing to TEMP branches, and the runner holds the ASC key (`ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_API_KEY_P8_BASE64`).

| Branch | Workflow | What a push does |
|---|---|---|
| `asc5-inspect` | `.github/workflows/asc-resubmit.yml` (that branch's copy carries the push trigger; on `main` it is dispatch-only) | Read-only state dump |
| `asc6-submit` | `.github/workflows/asc-resubmit.yml` (same) | Attach the newest post-fix build + notes + submit |
| `asc7-listing` | `.github/workflows/app-store-listing.yml` | The listing lane below |

Apple's Resolution Center has NO API: replies to App Review must be typed in App Store Connect. This is one of the few things the owner has to do by hand.

## The listing lane

`.github/workflows/app-store-listing.yml`. Orders in `.github/asc-maintenance/listing-request.json`, copy in `listing-copy.json`.

1. Builds the app for an iPhone 17 Pro Max simulator on a macOS runner.
2. Signs in as the App Review demo account. The login is read from the version's review detail via the ASC API, so no repo secret.
3. Walks the app with the XCUITest tour in `ios/screenshots/` (XcodeGen bundle, no host app).
4. Commits the 1320x2868 PNGs to `ios/metadata/screenshots/` on the branch.
5. `asc-listing.mjs` creates/edits the version (copy, subtitle, copyright, review details), replaces the iPhone screenshot sets (6.5" derived by resize), attaches the newest processed build, and submits only with `submit: true`.

- `"capture": false` skips the simulator and publishes from the committed PNGs.
- Promotional text is the only listing field editable on a live version. Subtitle, description, keywords and screenshots need a new version.
- This lane never runs on `main`.

### The demo account

review@mixbase.app was seeded 2026-09-16 with the developer's three released singles (3–4 mixes each, feedback, releases, library, a collection, real cover art from the released catalog) so every screen has content. Keep it that way; the seed job refreshes only the artwork.

## Territory availability is API-managed

- The app record shipped with NO availability at all. Every read of `GET /v1/apps/{id}/appAvailabilityV2` was 404, so the store said "not available in your country or region" even though 1.0 was Ready for Distribution.
- Created 2026-09-15 via `POST /v2/appAvailabilities` (all 175 territories, `availableInNewTerritories: true`, run 27 on `asc6-submit`).
- If that store message ever recurs, read that endpoint first.

## Metadata addresses

If App Store metadata references privacy@ / support@ / dmca@ / legal@ / review@ mixbase.app, verify those aliases exist. Don't frame them as pre-submission blockers.

## Certificates

Both TestFlight lanes mint runner dev certificates. `asc-cert-audit.yml` prunes them monthly (keeps the newest 4 'Created via API') so the 2026-08-29 certificate-cap outage can't recur.
