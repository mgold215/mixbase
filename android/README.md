# mixBase for Android

The native Android app for mixBase — Kotlin + Jetpack Compose (Material 3),
talking to the same backend as the iOS app and the web: Supabase Auth and
PostgREST directly, Supabase Storage for uploads, and the authenticated
`mixbase.app` API routes for anything that needs server judgement (AI
artwork, creating a version, the community feed, moderation, account
deletion). No paid plans anywhere, matching the rest of the product.

## Layout

```
android/
├── core/   Pure Kotlin/JVM — models, MixStatus name parser, Supabase Auth
│           session manager, PostgREST + Storage client, mixbase.app API
│           client. No Android imports; 29 unit tests (MockWebServer).
├── app/    The Compose application: tabs (Home · Projects · Player · Artwork
│           · Pipeline), community feed, settings, Media3 background playback.
├── settings.gradle.kts        full build (:core + :app)
└── settings.core.gradle.kts   core-only build — no Android SDK needed
```

`applicationId` is `com.moodmixformat.mixbase` (debug builds add `.debug`),
min SDK 26, target/compile SDK 35.

## Building

Full build (needs the Android SDK, e.g. Android Studio or the GitHub runner):

```sh
cd android
./gradlew :app:assembleDebug      # → app/build/outputs/apk/debug/app-debug.apk
adb install app/build/outputs/apk/debug/app-debug.apk
```

Core-only (any JDK 17+, no Android SDK — this is what the remote Claude
sandbox can run, since `dl.google.com` is blocked there):

```sh
cd android
gradle -c settings.core.gradle.kts :core:test
```

CI: `.github/workflows/android-app.yml` runs the core tests, assembles the
debug APK, runs Android Lint, and uploads `mixBase-debug-apk` as a workflow
artifact on every PR/push to `main` that touches `android/`.

## How it maps to iOS

| iOS (`ios/mixBase`) | Android |
| --- | --- |
| `Utilities/Config.swift` | `core/…/Config.kt` |
| `Models/*.swift` | `core/…/model/Models.kt`, `MixStatus.kt` |
| `Services/AuthService.swift` + Keychain | `core/…/auth/SessionManager.kt` + `app/…/auth/EncryptedTokenStore.kt` |
| `Services/SupabaseService.swift` | `core/…/supabase/SupabaseClient.kt` |
| `Services/MixbaseAPI.swift` | `core/…/api/MixbaseApi.kt` |
| `Services/AudioService.swift` (AVPlayer, Now Playing, remote commands) | `app/…/playback/PlaybackService.kt` (Media3 MediaSessionService) + `PlayerController.kt` |
| `Views/*` | `app/…/ui/*` (one Compose file per screen) |

Contracts that MUST stay identical across platforms (all enforced by core
tests):

- **Uploads never touch Railway.** Audio streams from the device straight to
  Supabase Storage (`/storage/v1/object/mf-audio/<key>`), then the
  `mb_versions` row is created via `POST /api/versions`. The body never
  carries `allow_download`, `status` or `label` — the server decides those.
- **Storage keys use lowercase project ids** (`StorageKeys.kt`), same layout
  as iOS (`<id>-v1.wav`, `<id>-v<n>-<epoch>.wav`, `<id>-<epoch>.jpg`).
- **Version display names** come from `MixStatus` (stored label → filename
  "MASTER 2" → "Mix N"/"Master N"), a display-only mirror of
  `src/lib/mix-status.ts`.
- **Session policy:** restore optimistically, refresh coalesced, sign out only
  on a 400/401 from the refresh endpoint.
- **Quota copy is purchase-free**; any server message mentioning
  upgrade/plan/pricing is replaced with neutral text.

## Not yet ported from iOS

Curator submissions (SubmitBase), the Released Library (`/api/library`),
Master Check loudness analysis, the instrumental slot, collection editing
(collections are read-only here), visualizer pinning UI, home-screen widgets,
and Sign in with Google (email/password only for now — `AuthClient`
already supports the id-token grant when a Google client id is configured
in Supabase).
