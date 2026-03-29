#!/usr/bin/env bash
# Fetches shared CLAUDE.md defaults from mgold215/claude-config
# Requires: gh CLI authenticated with access to the private repo

set -euo pipefail

REPO="mgold215/claude-config"
FILE="CLAUDE.md"
OUTPUT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || dirname "$(cd "$(dirname "$0")/.." && pwd)")"
OUTPUT_FILE="$OUTPUT_DIR/.claude-defaults.md"

if ! command -v gh &>/dev/null; then
  echo "⚠ gh CLI not found — skipping claude-config sync" >&2
  exit 0
fi

# Fetch the raw file content from the private repo
content=$(gh api "repos/$REPO/contents/$FILE" --jq '.content' 2>/dev/null | base64 -d 2>/dev/null) || {
  echo "⚠ Could not fetch $FILE from $REPO — skipping sync" >&2
  exit 0
}

if [ -n "$content" ]; then
  echo "$content" > "$OUTPUT_FILE"
  echo "✓ Synced claude-config defaults to .claude-defaults.md"
else
  echo "⚠ Empty response from $REPO/$FILE — skipping" >&2
fi
