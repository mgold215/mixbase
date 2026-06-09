#!/usr/bin/env bash
# Generate the Xcode project from project.yml and build the macOS infra app.
# Run from a Mac with Xcode installed. Safe to re-run.
#
#   cd macos && ./build.sh            # generate + debug build
#   cd macos && ./build.sh open       # generate + open in Xcode
#   cd macos && ./build.sh run        # generate + build + launch the .app
set -euo pipefail
cd "$(dirname "$0")"

# 1. Ensure XcodeGen is available (installs via Homebrew if missing).
if ! command -v xcodegen >/dev/null 2>&1; then
  echo "→ xcodegen not found; installing via Homebrew…"
  if ! command -v brew >/dev/null 2>&1; then
    echo "✗ Homebrew is required. Install from https://brew.sh then re-run." >&2
    exit 1
  fi
  brew install xcodegen
fi

# 2. Generate MixbaseInfra.xcodeproj from project.yml (deterministic).
echo "→ Generating MixbaseInfra.xcodeproj…"
xcodegen generate

ACTION="${1:-build}"
if [[ "$ACTION" == "open" ]]; then
  open MixbaseInfra.xcodeproj
  exit 0
fi

# 3. Build.
echo "→ Building (Debug)…"
xcodebuild -project MixbaseInfra.xcodeproj \
  -scheme MixbaseInfra \
  -configuration Debug \
  -destination 'platform=macOS' \
  build

if [[ "$ACTION" == "run" ]]; then
  APP_PATH=$(xcodebuild -project MixbaseInfra.xcodeproj -scheme MixbaseInfra -configuration Debug -showBuildSettings \
    | awk '/ BUILT_PRODUCTS_DIR =/{d=$3} / FULL_PRODUCT_NAME =/{n=$3} END{print d"/"n}')
  echo "→ Launching $APP_PATH"
  open "$APP_PATH"
fi

echo "✅ Done."
