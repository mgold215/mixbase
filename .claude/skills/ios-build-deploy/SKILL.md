---
name: ios-build-deploy
description: Build, ship and install the native iOS and macOS apps entirely from the CLI. Use for ANY work in ios/ or macos/ - shipping to TestFlight, building and installing on Matt's iPhone, the Mac build, adding a Swift file, sheets on the Mac, "developer disk image" or provisioning errors. Never tell the user to open Xcode; everything here is scriptable. For App Store submissions and the store listing use the app-store-connect skill.
---

# iOS and macOS: build, ship, install (CLI only)

## Shipping (no Mac needed)

**Merge to `main`.** That is the primary ship path:

- Any `ios/` change on `main` triggers `.github/workflows/ios-testflight.yml`: a cloud-signed archive on a GitHub macOS runner, uploaded to TestFlight (secrets `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_API_KEY_P8_BASE64`). Matt's phone auto-updates via TestFlight.
- Any `macos/` or `ios/mixBase/` change triggers `.github/workflows/macos-testflight.yml` (same cloud-signed pattern). Matt's Mac auto-updates via the TestFlight app.
- `.github/workflows/macos-app.yml` compiles BOTH platforms on PRs and pushes to `main` touching `macos/` or `ios/mixBase/`, and uploads an ad-hoc-signed `mixBase-macOS.zip` artifact.
- If every TestFlight upload starts failing with "train version … is closed", the marketing version needs a bump: see the `app-store-connect` skill.

Backup: the launchd auto-deploy on the Mac (`scripts/ios-autodeploy-install.sh`). A manual cable build is only for tight iteration.

## What the app is

The `ios/` directory is a fully native SwiftUI app (not a WebView wrapper): it reads Supabase PostgREST directly, has its own AVPlayer audio engine (`ios/mixBase/Services/`), and calls the web API with `Authorization: Bearer <supabase-access-token>`. Feature logic lives in server routes; the app does not re-implement it (AGENTS.md → One stack, both clients).

## Adding a Swift file

A new Swift file must ALSO be registered in `ios/mixBase.xcodeproj/project.pbxproj`. The iOS target is not a synchronized group, so a file that is only on disk is not part of the app.

## The macOS app shares the iOS source tree

- Target `mixBase` in `macos/project.yml` (XcodeGen → `Mixbase.xcodeproj`, generated, never committed), sharing the full iOS source tree `ios/mixBase/`.
- Platform gaps are bridged by `#if os()` guards in shared files plus `macos/MixbaseApp/PlatformCompat.swift` (macOS-target-only shims: UIPasteboard→NSPasteboard, UIImage=NSImage, no-op keyboard/nav-bar modifiers, iOS toolbar placements).
- Keep shared code platform-neutral: a UIKit-only API in `ios/mixBase/` breaks the Mac build unless guarded or shimmed.
- The Mac bundle id is `com.moodmixformat.mixbase`, the SAME as iOS (universal app record; the macOS platform of the existing mixBASE ASC app). Sign in with Apple therefore uses the already-authorized audience; nothing to add in Supabase. Don't "fix" the shared id: it is what makes one TestFlight app serve both platforms.
- The infra control panel client is a second scheme, `MixbaseInfra`, in the same `macos/project.yml`.

### A sheet must be closable on the Mac

2026-11-14, the owner: "i cant x out of the image editor on macos app".

- A Mac sheet has no swipe-to-close and no navigation bar. It draws ONLY toolbar items placed `.cancellationAction` / `.confirmationAction` (at its foot). One placed `.navigationBarTrailing` (→ `.primaryAction` in PlatformCompat) is silently not drawn.
- What was wrong: the cover viewer's Done sat there; the Visualizer opened from the Artwork library and the Terms page on sign-up had no close control at all.
- `scripts/macos-sheet-close-test.mjs` fails the build for any `.sheet` / `.fullScreenCover` whose closure or presented view has neither placement (exceptions are listed in the script with their reason).
- A view that is both pushed and presented gets its Done at the presenting site, not in the view.

## Building on a Mac

```bash
cd macos && ./build.sh run mixBase     # the consumer Mac app
cd macos && ./build.sh                 # the infra control panel (scheme MixbaseInfra)
```

### iPhone build and install (Matt's iPhone 15 Pro Max)

- UDID (for `xcodebuild`): `00008130-0014091600FA8D3A`
- CoreDevice UUID (for `devicectl`): `E11A7247-ACED-5D35-94E0-B1F8641BD71C`
- DerivedData: `~/Library/Developer/Xcode/DerivedData/mixBase-hcgiqutykhfnaxbbguzimycwxkfo/`

```bash
xcodebuild -project ios/mixBase.xcodeproj -scheme mixBase \
  -destination 'id=00008130-0014091600FA8D3A' -allowProvisioningUpdates build

xcrun devicectl device install app -d E11A7247-ACED-5D35-94E0-B1F8641BD71C \
  ~/Library/Developer/Xcode/DerivedData/mixBase-hcgiqutykhfnaxbbguzimycwxkfo/Build/Products/Debug-iphoneos/mixBase.app
```

### Error recovery

- **"developer disk image" errors**: `xcrun devicectl device info ddiServices -d E11A7247-ACED-5D35-94E0-B1F8641BD71C`
- **Install fails "device disconnected"**: retry the install immediately. It usually succeeds on the second attempt.
- Signing is Apple Development (the owner's Apple ID) with auto-provisioning; bundle ID `com.moodmixformat.mixbase`. `-allowProvisioningUpdates` handles cert refresh. Don't send the user into Xcode for signing issues.

## After success

Commit the iOS changes once build + install both succeed. Web-side lint/build doesn't cover `ios/`-only commits, but the commit still ships to `main` via the normal `ship-to-prod` flow.
