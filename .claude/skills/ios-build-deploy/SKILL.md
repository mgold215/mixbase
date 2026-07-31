---
name: ios-build-deploy
description: Build and install the native iOS app onto Matt's iPhone entirely from the CLI. Use for ANY iOS task — building, installing, fixing "developer disk image" or provisioning errors, or testing changes in ios/. Never tell the user to open Xcode; everything here is scriptable.
---

# iOS Build & Deploy (CLI only)

The `ios/` directory is a fully native SwiftUI app (not a WebView wrapper): it talks to Supabase PostgREST directly, has its own AVPlayer audio engine (`ios/mixBase/Services/`), and can call the web API with `Authorization: Bearer <supabase-access-token>`.

## Device identifiers (Matt's iPhone 15 Pro Max)

- UDID (for `xcodebuild`): `00008130-0014091600FA8D3A`
- CoreDevice UUID (for `devicectl`): `E11A7247-ACED-5D35-94E0-B1F8641BD71C`
- DerivedData: `~/Library/Developer/Xcode/DerivedData/mixBase-hcgiqutykhfnaxbbguzimycwxkfo/`

## Build & install

```bash
xcodebuild -project ios/mixBase.xcodeproj -scheme mixBase \
  -destination 'id=00008130-0014091600FA8D3A' -allowProvisioningUpdates build

xcrun devicectl device install app -d E11A7247-ACED-5D35-94E0-B1F8641BD71C \
  ~/Library/Developer/Xcode/DerivedData/mixBase-hcgiqutykhfnaxbbguzimycwxkfo/Build/Products/Debug-iphoneos/mixBase.app
```

## Error recovery

- **"developer disk image" errors**: `xcrun devicectl device info ddiServices -d E11A7247-ACED-5D35-94E0-B1F8641BD71C`
- **Install fails "device disconnected"**: retry the install immediately — it usually succeeds on the second attempt.
- Signing is Apple Development (m.goldman215@gmail.com) with auto-provisioning; bundle ID `com.moodmixformat.mixbase`. `-allowProvisioningUpdates` handles cert refresh — don't send the user into Xcode for signing issues.

## After success

Commit the iOS changes once build + install both succeed. Web-side rules (lint/build, ship-to-prod) don't apply to `ios/`-only commits, but the commit still ships to `main` via the normal `ship-to-prod` flow.

## macOS client

The infra control panel client lives in `macos/` — XcodeGen project (`macos/project.yml`); build with `cd macos && ./build.sh`. The `.xcodeproj` is generated, never committed.
