# mixBASE — macOS apps

One XcodeGen project (`project.yml` → `Mixbase.xcodeproj`, generated, never
committed) containing two native SwiftUI desktop apps:

| Scheme | What it is |
|---|---|
| `mixBase` | The consumer mixBASE app — projects, player, artwork, visualizers, pipeline, feed. Shares its entire Swift source tree with the native iOS app (`../ios/mixBase`). |
| `MixbaseInfra` | The admin infra control panel (read-only architecture diagram + query bar). |

## Build & run (on a Mac with Xcode)

```bash
cd macos
./build.sh                  # installs xcodegen if needed, generates the project, builds the infra panel
./build.sh run mixBase      # build + launch the mixBASE consumer app
./build.sh build mixBase    # just build it
./build.sh open             # open Mixbase.xcodeproj in Xcode
```

CI (`.github/workflows/macos-app.yml`) compiles both the macOS app and the iOS
app on every PR/push to `main` that touches `macos/` or `ios/mixBase/`, and
uploads an ad-hoc-signed `mixBase-macOS.zip` artifact (right-click → Open to get
past Gatekeeper; for a properly signed build, use `./build.sh` locally — it
signs automatically with team `AP8UC39D4D`).

# mixBase (consumer app)

## How the code is shared with iOS

`project.yml` includes `../ios/mixBase` as the target's sources, minus the
iOS-shaped resources (`Info.plist`, entitlements, privacy manifest, asset
catalog), which this target carries itself under `MixbaseApp/`:

- **`MixbaseApp/PlatformCompat.swift`** — compiled only into the macOS target.
  Bridges iOS-only names so shared views compile unchanged: no-op
  `keyboardType` / `autocapitalization` / `navigationBarTitleDisplayMode`,
  `UIPasteboard` → NSPasteboard, `typealias UIImage = NSImage` (+ `jpegData`),
  `fullScreenCover` → sheet, iOS toolbar placements → macOS ones,
  `.insetGrouped` → `.inset`, `EditButton` → hidden.
- **`#if os(iOS)` / `#if os(macOS)` guards** in the shared tree where behavior
  genuinely diverges: AVAudioSession (iOS-only), AVPlayerLayer views
  (UIView/NSView twins), Sign in with Apple presentation anchor, cover-image
  resizing, save-video destination (Photos on iOS, `~/Downloads` on macOS).

When adding shared code, keep it platform-neutral SwiftUI; if you reach for a
UIKit-only API, either guard it or extend `PlatformCompat.swift`.

## Configuration

Same as iOS (`ios/mixBase/Utilities/Config.swift`): Supabase URL + anon key,
`https://mixbase.app` for the authenticated AI/API routes. Sandboxed with
network-client, user-selected-files (audio upload picker), and Downloads
read-write (video saves) entitlements.

**Sign in with Apple caveat:** the Mac app's bundle id is
`com.moodmixformat.mixbase.mac` (deliberately not the iOS id). Apple issues its
identity tokens with that id as audience, so it must be added to the Supabase
Apple provider's **Authorized Client IDs** before Apple sign-in works from this
app. Email/password sign-in works with no extra setup. If local automatic
provisioning ever balks at the `applesignin` entitlement, remove that block
from `MixbaseApp/mixBase.entitlements` and build on — Apple sign-in is the only
thing it gates.

# MixbaseInfra (admin control panel)

A native SwiftUI desktop app that renders your mixBase architecture as an
interactive, queryable network diagram. It talks to admin-gated `/api/infra/*`
endpoints in the deployed Next.js backend, so **no provider secrets ever live on
your Mac** — Railway/Supabase tokens stay on Railway.

Phase 1 is **read-only**: visualize + query. Status badges, metrics, row counts,
storage/DB scaling signals, deploy health, and a natural-language query bar. No
write/scaling actions yet (that's phase 2).

## Using it

1. Launch the app, pick **Production** or **Staging**, and sign in with your
   **admin** mixBase account (an account whose `profiles.subscription_tier` is
   `admin`). Auth uses the same cookie session as the web app.
2. The diagram loads: columns are layers (client → edge → app → data → external),
   boxes are services, lines are data-flow. Green = healthy, amber = degraded,
   red = down, gray/slate = not probed in phase 1.
3. Click any node to open the inspector: live health, deploy status, row counts,
   storage usage, and scaling-signal bars (used vs limit).
4. Use the query bar (e.g. *"how full is mf-audio?"*, *"which tables are
   biggest?"*) — powered by Claude with read-only infra tools.

## What lights up

| Integration | Needs | Without it |
|---|---|---|
| App liveness (prod/staging) | nothing | always works (hits `/api/health`) |
| Railway deploy status / project | `RAILWAY_API_TOKEN` on Railway | health-only, badge still shows up/down |
| Supabase row counts + bucket list | `SUPABASE_SERVICE_ROLE_KEY` (already set) | always works |
| DB size, per-bucket bytes, migrations, ad-hoc SQL | `SUPABASE_MANAGEMENT_TOKEN` | those fields show "—" |
| Query bar (NL) | `ANTHROPIC_API_KEY` (already set) | bar returns a "disabled" message |

Set `RAILWAY_API_TOKEN` (create at railway.app → Account → Tokens) in the Railway
env vars for both services to unlock deploy status. See `.env.example`.

# Structure

```
macos/
  project.yml            XcodeGen spec (both targets, sandbox, signing)
  build.sh               generate + build + run (scheme as 2nd arg)
  MixbaseApp/            macOS-only side of the consumer app
    PlatformCompat.swift   iOS-API shims (this target only)
    mixBase.entitlements   sandbox + network + files + Sign in with Apple
    Assets.xcassets/       mac icon set + accent color
  MixbaseInfra/
    App/                 @main app + RootView (login gate)
    Config.swift         prod/staging base URLs
    Services/            InfraAPIClient (cookie session), KeychainService
    ViewModels/          AuthViewModel, TopologyViewModel
    Models/              Codable mirrors of /api/infra/* JSON
    Views/               Graph canvas, node, inspector, query bar, login
    Utilities/           Color(hex:), byte/date formatting
```

The `.xcodeproj` is **generated** from `project.yml` by [XcodeGen]; it is not
committed (see `.gitignore`). Edit `project.yml` to change build settings, and
just drop new `.swift` files under `MixbaseApp/` or `MixbaseInfra/` — they're
picked up by directory globbing, no manual project surgery. (Shared app code
belongs in `../ios/mixBase/`, where both platforms build it.)

[XcodeGen]: https://github.com/yonyz/XcodeGen

> Note: signing uses the team `AP8UC39D4D` (same as the iOS app) with automatic
> signing. Change `DEVELOPMENT_TEAM` in `project.yml` if you build under a
> different Apple account.
