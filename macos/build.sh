#!/usr/bin/env bash
# Generate the Xcode project from project.yml and build a macOS app.
# Run from a Mac with Xcode installed. Safe to re-run.
#
#   cd macos && ./build.sh                  # generate + debug build (infra panel)
#   cd macos && ./build.sh build mixBase    # generate + debug build (mixBASE app)
#   cd macos && ./build.sh run mixBase      # generate + build + launch the mixBASE app
#   cd macos && ./build.sh open             # generate + open in Xcode
set -euo pipefail
cd "$(dirname "$0")"

ACTION="${1:-build}"
SCHEME="${2:-MixbaseInfra}"

# 1. Ensure XcodeGen is available (installs via Homebrew if missing).
if ! command -v xcodegen >/dev/null 2>&1; then
  echo "→ xcodegen not found; installing via Homebrew…"
  if ! command -v brew >/dev/null 2>&1; then
    echo "✗ Homebrew is required. Install from https://brew.sh then re-run." >&2
    exit 1
  fi
  brew install xcodegen
fi

# 2. Generate Mixbase.xcodeproj from project.yml (deterministic; contains both
#    the mixBase consumer app and the MixbaseInfra panel).
echo "→ Generating Mixbase.xcodeproj…"
xcodegen generate

if [[ "$ACTION" == "open" ]]; then
  open Mixbase.xcodeproj
  exit 0
fi

# 3. Build.
echo "→ Building $SCHEME (Debug)…"
xcodebuild -project Mixbase.xcodeproj \
  -scheme "$SCHEME" \
  -configuration Debug \
  -destination 'platform=macOS' \
  build

if [[ "$ACTION" == "run" ]]; then
  APP_PATH=$(xcodebuild -project Mixbase.xcodeproj -scheme "$SCHEME" -configuration Debug -showBuildSettings \
    | awk '/ BUILT_PRODUCTS_DIR =/{d=$3} / FULL_PRODUCT_NAME =/{n=$3} END{print d"/"n}')
  echo "→ Launching $APP_PATH"
  open "$APP_PATH"
fi

echo "✅ Done."
