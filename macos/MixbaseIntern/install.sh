#!/usr/bin/env bash
# Install mixBASE Intern on this Mac and start it at login.
#
#   cd macos/MixbaseIntern && ./install.sh
#
# Safe to re-run: it rebuilds, replaces the app, refreshes the worker's files
# and restarts the helper. Sign-in and the two privacy switches are kept.
#
#   ./install.sh runtime    only refresh the worker's files (no rebuild, no restart of the app)
set -euo pipefail
cd "$(dirname "$0")"
REPO="$(cd ../.. && pwd)"
LABEL="app.mixbase.intern"
SUPPORT="$HOME/Library/Application Support/MixbaseIntern"
RUNTIME="$SUPPORT/runtime"
DEST="$HOME/Applications/MixbaseIntern.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# 1. The worker: the job loop and the rules it runs, copied out of the
#    repository so the helper does not depend on a checkout staying put.
echo "→ Installing the worker…"
mkdir -p "$RUNTIME/scripts" "$RUNTIME/src/lib" "$RUNTIME/bin"
rm -f "$RUNTIME"/scripts/intern-*.mjs
cp "$REPO"/scripts/intern-*.mjs "$RUNTIME/scripts/"
rm -f "$RUNTIME"/scripts/*-test.mjs
cp "$REPO"/src/lib/intern-*.ts "$REPO"/src/lib/mix-check.ts "$REPO"/src/lib/mix-check-findings.ts "$REPO"/src/lib/loudness.ts "$RUNTIME/src/lib/"
printf '{ "type": "module", "private": true }\n' > "$RUNTIME/package.json"
# ffmpeg, the same build the server decodes with (npm ci puts it in node_modules).
FFMPEG="$(cd "$REPO" && node --input-type=commonjs -e "process.stdout.write(require('@ffmpeg-installer/ffmpeg').path)" 2>/dev/null || true)"
if [[ -n "$FFMPEG" && -x "$FFMPEG" ]]; then cp "$FFMPEG" "$RUNTIME/bin/ffmpeg"; fi
if [[ ! -x "$RUNTIME/bin/ffmpeg" ]]; then echo "✗ ffmpeg is missing: run npm ci in the repository first" >&2; exit 1; fi
NODE="$(command -v node)"
printf '{ "node": "%s" }\n' "$NODE" > "$SUPPORT/config.json"

if [[ "${1:-}" == "runtime" ]]; then
  # The helper starts the worker again by itself when it exits. Not while a job is in flight.
  pkill -f "runtime/scripts/intern-worker.mjs" 2>/dev/null || true
  echo "✅ Worker files refreshed; the helper restarts the worker in a few seconds."
  exit 0
fi

# 2. The app.
./build.sh
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# Any copy still running (one started by hand, or one launchd had not finished stopping).
pkill -x MixbaseIntern 2>/dev/null || true
sleep 1
mkdir -p "$HOME/Applications" "$HOME/Library/LaunchAgents"
rm -rf "$DEST"
cp -R build/MixbaseIntern.app "$DEST"

# 3. Start at login, and again if it ever crashes (a normal Quit stays quit).
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$DEST/Contents/MacOS/MixbaseIntern</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
PLIST
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✅ Installed and started. Its icon is in the menu bar."
