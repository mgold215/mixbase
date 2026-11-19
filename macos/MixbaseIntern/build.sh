#!/usr/bin/env bash
# Build mixBASE Intern, the helper that works on the owner's Mac.
#
#   cd macos/MixbaseIntern && ./build.sh        # -> build/MixbaseIntern.app, signed
#
# It is NOT sandboxed (a sandboxed app cannot operate another app's interface,
# whatever the Accessibility switch says) and it is signed with the Mac's Apple
# Development certificate: the same signature on every rebuild, so the
# Accessibility and Full Disk Access switches stay on.
set -euo pipefail
cd "$(dirname "$0")"

APP="build/MixbaseIntern.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"

echo "→ Compiling…"
swiftc -O -swift-version 5 -o "$APP/Contents/MacOS/MixbaseIntern" Sources/*.swift \
  -framework AppKit -framework ApplicationServices -framework IOKit -framework Security

# The first Apple Development identity in the keychain; SIGN_IDENTITY overrides it.
IDENTITY="${SIGN_IDENTITY:-Apple Development}"
echo "→ Signing…"
codesign --force --sign "$IDENTITY" --identifier app.mixbase.intern "$APP"
codesign --verify --strict "$APP"
echo "✅ Built $APP"
