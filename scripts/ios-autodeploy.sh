#!/bin/bash
# ios-autodeploy.sh — hands-free iOS deploys to Matt's iPhone.
#
# Run by a launchd agent every few minutes (see ios-autodeploy-install.sh).
# Each tick: fetch origin/main; if an ios/ change landed that hasn't been
# deployed yet, fast-forward the repo, build, and install to the phone.
# The phone must be reachable — USB, or Wi-Fi after enabling "Connect via
# network" for it once in Xcode ▸ Window ▸ Devices and Simulators.
#
# Never fights the human: skips (silently, until the next tick) when the repo
# has uncommitted changes or is on a branch other than main.
set -uo pipefail

REPO_DIR="${MIXBASE_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
STATE_FILE="$HOME/.mixbase-ios-autodeploy-sha"
DEVICE_UDID="00008130-0014091600FA8D3A"
COREDEVICE_UUID="E11A7247-ACED-5D35-94E0-B1F8641BD71C"
APP_PATH="$HOME/Library/Developer/Xcode/DerivedData/mixBase-hcgiqutykhfnaxbbguzimycwxkfo/Build/Products/Debug-iphoneos/mixBase.app"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

notify() {
  # Best-effort banner on the Mac so deploys are visible without tailing logs.
  #
  # The message is passed as an ARGUMENT, never interpolated into the script
  # text. This function is called with a git commit subject
  # (`notify "Installed: $SUMMARY"`), and a subject containing a double quote
  # would otherwise close the AppleScript string literal and let the remainder
  # parse as code — `do shell script "..."` is arbitrary command execution on
  # this Mac, silenced by the `2>&1 || true` below. Anyone who can land a commit
  # on main can choose that subject.
  osascript \
    -e 'on run {msg}' \
    -e 'display notification msg with title "mixBase iOS auto-deploy"' \
    -e 'end run' \
    -- "$1" >/dev/null 2>&1 || true
}

cd "$REPO_DIR" || { log "repo not found at $REPO_DIR"; exit 1; }

git fetch origin main --quiet || { log "fetch failed (offline?)"; exit 0; }
REMOTE_SHA=$(git rev-parse origin/main)
LAST_SHA=$(cat "$STATE_FILE" 2>/dev/null || echo "")

# Nothing new since the last successful deploy.
[ "$REMOTE_SHA" = "$LAST_SHA" ] && exit 0

# Web-only change? Mark it handled without touching Xcode.
if [ -n "$LAST_SHA" ] && git cat-file -e "$LAST_SHA" 2>/dev/null; then
  if git diff --quiet "$LAST_SHA" "$REMOTE_SHA" -- ios/; then
    echo "$REMOTE_SHA" > "$STATE_FILE"
    exit 0
  fi
fi

# Don't stomp on manual work: require a clean tree on main.
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  log "repo is on '$BRANCH', not main — skipping this tick"
  exit 0
fi
if [ -n "$(git status --porcelain)" ]; then
  log "repo has uncommitted changes — skipping this tick"
  exit 0
fi

# Phone reachable? (USB or Wi-Fi-paired.) If not, retry next tick.
if ! xcrun devicectl list devices 2>/dev/null | grep -i "$COREDEVICE_UUID" | grep -qiE "connected|available"; then
  log "iPhone not reachable — will retry next tick"
  exit 0
fi

log "deploying $REMOTE_SHA (ios/ changed)"
git merge --ff-only origin/main --quiet || { log "fast-forward failed — skipping"; exit 0; }

if ! xcodebuild -project ios/mixBase.xcodeproj -scheme mixBase \
    -destination "id=$DEVICE_UDID" -allowProvisioningUpdates build \
    > /tmp/mixbase-ios-autodeploy-build.log 2>&1; then
  log "BUILD FAILED — see /tmp/mixbase-ios-autodeploy-build.log"
  tail -30 /tmp/mixbase-ios-autodeploy-build.log
  notify "Build failed — check the log"
  exit 1
fi

# Install, with one retry: the first attempt sometimes drops with a spurious
# "device disconnected" and immediately succeeds on the second.
if ! xcrun devicectl device install app -d "$COREDEVICE_UUID" "$APP_PATH"; then
  log "install attempt 1 failed — retrying"
  if ! xcrun devicectl device install app -d "$COREDEVICE_UUID" "$APP_PATH"; then
    log "INSTALL FAILED after retry"
    notify "Install failed — is the iPhone unlocked and nearby?"
    exit 1
  fi
fi

echo "$REMOTE_SHA" > "$STATE_FILE"
SUMMARY=$(git log -1 --format='%s' "$REMOTE_SHA")
log "deployed $REMOTE_SHA — $SUMMARY"
notify "Installed: $SUMMARY"
