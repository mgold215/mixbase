# mixBase Infra — macOS control panel

A native SwiftUI desktop app that renders your mixBase architecture as an
interactive, queryable network diagram. It talks to admin-gated `/api/infra/*`
endpoints in the deployed Next.js backend, so **no provider secrets ever live on
your Mac** — Railway/Supabase tokens stay on Railway.

Phase 1 is **read-only**: visualize + query. Status badges, metrics, row counts,
storage/DB scaling signals, deploy health, and a natural-language query bar. No
write/scaling actions yet (that's phase 2).

## Build & run (on a Mac with Xcode)

```bash
cd macos
./build.sh          # installs xcodegen if needed, generates the project, builds
./build.sh run      # …and launches the app
./build.sh open     # …or open it in Xcode instead
```

The `.xcodeproj` is **generated** from `project.yml` by [XcodeGen]; it is not
committed (see `.gitignore`). Edit `project.yml` to change build settings, and
just drop new `.swift` files under `MixbaseInfra/` — they're picked up by
directory globbing, no manual project surgery.

[XcodeGen]: https://github.com/yonyz/XcodeGen

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

## Structure

```
macos/
  project.yml            XcodeGen spec (target, sandbox, signing)
  build.sh               generate + build + run
  MixbaseInfra/
    App/                 @main app + RootView (login gate)
    Config.swift         prod/staging base URLs
    Services/            InfraAPIClient (cookie session), KeychainService
    ViewModels/          AuthViewModel, TopologyViewModel
    Models/              Codable mirrors of /api/infra/* JSON
    Views/               Graph canvas, node, inspector, query bar, login
    Utilities/           Color(hex:), byte/date formatting
```

> Note: signing uses the team `AP8UC39D4D` (same as the iOS app) with automatic
> signing. Change `DEVELOPMENT_TEAM` in `project.yml` if you build under a
> different Apple account.
