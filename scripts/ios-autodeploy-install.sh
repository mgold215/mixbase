#!/bin/bash
# One-time setup for hands-free iOS deploys. Run from the repo root on the Mac:
#
#   bash scripts/ios-autodeploy-install.sh
#
# Installs a launchd agent that runs scripts/ios-autodeploy.sh every 5 minutes
# (and at login). From then on, any merged ios/ change builds and installs to
# the iPhone automatically whenever the Mac is awake and the phone is reachable
# (USB, or Wi-Fi once "Connect via network" is enabled in Xcode's Devices
# window). Logs: ~/Library/Logs/mixbase-ios-autodeploy.log
#
# Uninstall:  launchctl unload ~/Library/LaunchAgents/com.moodmixformat.mixbase-ios-autodeploy.plist
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.moodmixformat.mixbase-ios-autodeploy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/mixbase-ios-autodeploy.log"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
chmod +x "$REPO_DIR/scripts/ios-autodeploy.sh"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$REPO_DIR/scripts/ios-autodeploy.sh</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>MIXBASE_REPO</key>
        <string>$REPO_DIR</string>
        <key>PATH</key>
        <string>/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin</string>
    </dict>
    <key>StartInterval</key>
    <integer>300</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
</dict>
</plist>
PLIST

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "✓ Auto-deploy installed. It just ran its first check; from now on it checks every 5 minutes."
echo "  Watch it:      tail -f $LOG"
echo "  Uninstall:     launchctl unload $PLIST"
echo "  Tip: enable 'Connect via network' for the iPhone in Xcode ▸ Window ▸ Devices"
echo "       and Simulators once, and the cable stops being required."
