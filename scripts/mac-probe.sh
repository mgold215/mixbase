#!/bin/bash
# mac-probe.sh: a ONE-OFF, READ-ONLY look at the owner's Mac for the mixing
# intern (the owner, 2026-11-18: "send the probe through the auto-deploy
# helper"). Run by scripts/ios-autodeploy.sh at the start of a tick, once.
#
# It answers what could not be answered from a cloud session: which Logic Pro
# and macOS this Mac runs, which Audio Unit plug-ins are installed, where the
# Logic projects are, whether a background script here is allowed to read
# Logic's windows (Accessibility), and what Logic exposes when it is.
#
# What it does NOT do: open, change, click or delete anything; ask for a
# permission; read audio or the inside of a project. The report goes to a
# write-only table only the owner's database admin can read (this repository
# is public, so nothing is printed, committed or pushed).
#
# Delete this file, scripts/mac-probe.swift and the two lines that call it in
# ios-autodeploy.sh once the report has been read.

PROBE_VERSION="intern-probe-1"
STATE="$HOME/.mixbase-mac-probe-$PROBE_VERSION"
TRIES="$HOME/.mixbase-mac-probe-$PROBE_VERSION.tries"
HERE="$(cd "$(dirname "$0")" && pwd)"

[ -f "$STATE" ] && exit 0
N=$(cat "$TRIES" 2>/dev/null || echo 0)
[ "$N" -ge 5 ] && exit 0
echo $((N + 1)) > "$TRIES"

OUT="${TMPDIR:-/tmp}/mixbase-probe-$$-$RANDOM"
: > "$OUT" || exit 0
trap 'rm -f "$OUT" "$OUT.json"' EXIT

# Run a command for at most N seconds (macOS has no `timeout`).
limited() { perl -e 'alarm shift; exec @ARGV' "$@"; }
section() { printf '\n=== %s\n' "$1" >> "$OUT"; }

section "when / who / where"
{
  date -u '+%Y-%m-%dT%H:%M:%SZ'
  echo "probe=$PROBE_VERSION try=$((N + 1))"
  echo "launchd_session=$(launchctl managername 2>/dev/null)"
  sw_vers 2>/dev/null
  uname -m
  sysctl -n machdep.cpu.brand_string hw.memsize 2>/dev/null
} >> "$OUT" 2>&1

section "Logic Pro installed"
for app in /Applications/Logic*.app "$HOME"/Applications/Logic*.app; do
  [ -d "$app" ] || continue
  echo "$app  version=$(defaults read "$app/Contents/Info" CFBundleShortVersionString 2>/dev/null)  bundle=$(defaults read "$app/Contents/Info" CFBundleIdentifier 2>/dev/null)" >> "$OUT"
done

section "Claude on this Mac"
{
  for app in /Applications/Claude*.app; do
    [ -d "$app" ] && echo "$app  version=$(defaults read "$app/Contents/Info" CFBundleShortVersionString 2>/dev/null)"
  done
  for bin in "$HOME/.local/bin/claude" /opt/homebrew/bin/claude /usr/local/bin/claude "$HOME/.claude/local/claude"; do
    [ -x "$bin" ] && echo "$bin  $(limited 15 "$bin" --version 2>&1 | head -1)"
  done
  for bin in /opt/homebrew/bin/LogicProMCP /usr/local/bin/LogicProMCP "$HOME/.local/bin/LogicProMCP"; do
    [ -x "$bin" ] && echo "logic controller installed: $bin"
  done
} >> "$OUT" 2>&1

section "sleep settings"
pmset -g custom 2>/dev/null | grep -E 'Power|sleep|displaysleep|powernap|womp' | head -20 >> "$OUT"

section "Audio Unit plug-ins (effects, instruments)"
limited 60 auval -a 2>/dev/null | grep -E '^(aufx|aumf|aumu|aumi) ' | head -700 >> "$OUT"

section "Logic projects (Spotlight; names of the 12 newest, counts per folder)"
LIST="$(limited 30 mdfind "kMDItemFSName == '*.logicx'c" 2>/dev/null | head -4000)"
{
  echo "count=$(printf '%s\n' "$LIST" | grep -c .)"
  printf '%s\n' "$LIST" | grep . | sed -E 's|/[^/]+$||' | sort | uniq -c | sort -rn | head -10
  echo "--- newest"
  printf '%s\n' "$LIST" | grep . | while IFS= read -r p; do stat -f '%m %Sm %N' -t '%Y-%m-%d' "$p" 2>/dev/null; done | sort -rn | head -12 | cut -d' ' -f2-
  echo "--- EVERGREEN"
  printf '%s\n' "$LIST" | grep -i evergreen | head -10
} >> "$OUT" 2>&1

section "what a background script may see of Logic (Accessibility)"
if command -v swift >/dev/null 2>&1; then
  limited 150 swift "$HERE/mac-probe.swift" 2>&1 | head -1500 >> "$OUT"
else
  echo "swift not found" >> "$OUT"
fi

# ── Send it: one row in a write-only table (the public key cannot read it back).
CONFIG="$HERE/../ios/mixBase/Utilities/Config.swift"
URL="$(sed -n 's/.*supabaseURL: String = "\([^"]*\)".*/\1/p' "$CONFIG" | head -1)"
KEY="$(sed -n 's/.*supabasePublishableKey: String = "\([^"]*\)".*/\1/p' "$CONFIG" | head -1)"
[ -n "$URL" ] && [ -n "$KEY" ] || exit 0

PROBE_VERSION="$PROBE_VERSION" perl -MJSON::PP -e '
  local $/; open(my $f, "<:raw", $ARGV[0]) or exit 1; my $t = <$f>;
  utf8::decode($t); $t = substr($t, 0, 300000);
  print JSON::PP->new->utf8->encode({ probe_version => $ENV{PROBE_VERSION}, report => $t });
' "$OUT" > "$OUT.json" || exit 0

CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 40 \
  -X POST "$URL/rest/v1/mb_mac_probe" \
  -H "apikey: $KEY" -H 'Content-Type: application/json' -H 'Prefer: return=minimal' \
  --data-binary "@$OUT.json" 2>/dev/null)"

if [ "$CODE" = "201" ]; then
  date > "$STATE"
  osascript -e 'display notification "Read-only check of this Mac for the mixing intern: done, report sent." with title "mixBase"' >/dev/null 2>&1 || true
fi
exit 0
