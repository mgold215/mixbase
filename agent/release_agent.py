#!/usr/bin/env python3
"""
Mixfolio Release Agent
Automates DistroKid upload + Spotify pitch using Claude computer use.

Usage:
  python release_agent.py <release_id>

Setup:
  pip install -r requirements.txt
  cp .env.example .env
  # Fill in your credentials in .env
"""

import os
import sys
import json
import time
import base64
import subprocess
import tempfile
import urllib.request
from pathlib import Path

import anthropic
from dotenv import load_dotenv

load_dotenv()

ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
MIXFOLIO_URL      = os.environ.get("MIXFOLIO_URL", "https://mixfolio-production.up.railway.app")
DK_EMAIL          = os.environ["DISTROKID_EMAIL"]
DK_PASSWORD       = os.environ["DISTROKID_PASSWORD"]

client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

# ── Screen helpers ────────────────────────────────────────────────────────────

def screenshot_b64() -> str:
    """Take a screenshot and return base64-encoded PNG."""
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        path = f.name
    subprocess.run(["screencapture", "-x", path], check=True)
    with open(path, "rb") as f:
        data = base64.standard_b64encode(f.read()).decode()
    os.unlink(path)
    return data


def run_applescript(script: str):
    subprocess.run(["osascript", "-e", script], check=True)


def open_url(url: str):
    run_applescript(f'tell application "Google Chrome" to open location "{url}"')
    time.sleep(2)


def execute_computer_action(action: dict):
    """Execute a Claude computer_use tool action on the Mac."""
    act = action["action"]

    if act == "screenshot":
        return screenshot_b64()

    elif act == "left_click":
        x, y = action["coordinate"]
        subprocess.run(["cliclick", f"c:{x},{y}"], check=True)
        time.sleep(0.3)

    elif act == "double_click":
        x, y = action["coordinate"]
        subprocess.run(["cliclick", f"dc:{x},{y}"], check=True)
        time.sleep(0.3)

    elif act == "right_click":
        x, y = action["coordinate"]
        subprocess.run(["cliclick", f"rc:{x},{y}"], check=True)
        time.sleep(0.3)

    elif act == "type":
        text = action["text"]
        # Use pbpaste trick: write to clipboard then paste — handles special chars
        proc = subprocess.Popen(["pbcopy"], stdin=subprocess.PIPE)
        proc.communicate(text.encode("utf-8"))
        run_applescript('tell application "System Events" to keystroke "v" using command down')
        time.sleep(0.2)

    elif act == "key":
        key_map = {
            "Return": "return", "Tab": "tab", "Escape": "escape",
            "BackSpace": "delete", "Delete": "forwarddelete",
        }
        key = key_map.get(action["key"], action["key"])
        run_applescript(f'tell application "System Events" to key code "{key}"')
        time.sleep(0.2)

    elif act == "scroll":
        x, y = action["coordinate"]
        direction = action.get("direction", "down")
        amount = action.get("amount", 3)
        flag = "d" if direction == "down" else "u"
        subprocess.run(["cliclick", f"s{flag}:{x},{y}:{amount}"], check=True)
        time.sleep(0.3)

    elif act == "mouse_move":
        x, y = action["coordinate"]
        subprocess.run(["cliclick", f"m:{x},{y}"], check=True)

    return None


# ── Agent loop ────────────────────────────────────────────────────────────────

def run_agent(task: str, log_fn=print) -> str:
    """Run a computer-use agent loop until done. Returns final status message."""
    messages = [{"role": "user", "content": task}]

    tools = [{
        "type": "computer_20241022",
        "name": "computer",
        "display_width_px": 1920,
        "display_height_px": 1080,
    }]

    while True:
        response = client.beta.messages.create(
            model="claude-opus-4-5",
            max_tokens=4096,
            tools=tools,
            messages=messages,
            betas=["computer-use-2024-10-22"],
        )

        # Collect assistant content
        assistant_content = []
        tool_calls = []

        for block in response.content:
            assistant_content.append(block)
            if block.type == "text":
                log_fn(f"[agent] {block.text}")
            elif block.type == "tool_use" and block.name == "computer":
                tool_calls.append(block)

        messages.append({"role": "assistant", "content": assistant_content})

        if response.stop_reason == "end_turn" or not tool_calls:
            # Extract final text
            for block in response.content:
                if hasattr(block, "text"):
                    return block.text
            return "done"

        # Execute tool calls and build tool_result messages
        tool_results = []
        for tc in tool_calls:
            action = tc.input
            log_fn(f"[action] {action.get('action')} {action.get('coordinate', action.get('text', ''))[:60]}")
            result = execute_computer_action(action)

            if action.get("action") == "screenshot" and result:
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tc.id,
                    "content": [{
                        "type": "image",
                        "source": {"type": "base64", "media_type": "image/png", "data": result},
                    }],
                })
            else:
                # Take a fresh screenshot after every non-screenshot action
                time.sleep(0.5)
                img = screenshot_b64()
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tc.id,
                    "content": [{
                        "type": "image",
                        "source": {"type": "base64", "media_type": "image/png", "data": img},
                    }],
                })

        messages.append({"role": "user", "content": tool_results})


# ── Mixfolio API ──────────────────────────────────────────────────────────────

def fetch_release(release_id: str) -> dict:
    url = f"{MIXFOLIO_URL}/api/releases/{release_id}"
    with urllib.request.urlopen(url) as r:
        return json.loads(r.read())


def patch_release(release_id: str, fields: dict):
    url = f"{MIXFOLIO_URL}/api/releases/{release_id}"
    data = json.dumps(fields).encode()
    req = urllib.request.Request(url, data=data, method="PATCH",
                                  headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req):
        pass


def append_log(release_id: str, existing_log: str | None, msg: str):
    ts = time.strftime("%H:%M:%S")
    entry = f"[{ts}] {msg}"
    log = (existing_log or "") + entry + "\n"
    patch_release(release_id, {"agent_log": log})
    return log


# ── DistroKid task ────────────────────────────────────────────────────────────

def build_distrokid_task(release: dict, versions: list) -> str:
    # Find the final version
    final_version = None
    if release.get("final_version_id"):
        final_version = next((v for v in versions if v["id"] == release["final_version_id"]), None)
    if not final_version and versions:
        final_version = versions[0]

    audio_url   = final_version["audio_url"] if final_version else ""
    artwork_url = (release.get("mf_projects") or {}).get("artwork_url", "")

    return f"""You are automating a DistroKid music upload on behalf of a music producer.

CREDENTIALS (do not share or log these):
- Email: {DK_EMAIL}
- Password: {DK_PASSWORD}

RELEASE METADATA:
- Song title: {release['title']}
- Artist name: {release.get('artist_name') or 'Use the logged-in account name'}
- Featured artists: {release.get('featured_artists') or 'None'}
- Release type: {release.get('release_type', 'single')}
- Genre: {release.get('genre') or 'Pop'}
- Explicit: {'Yes' if release.get('explicit') else 'No'}
- Release date: {release.get('release_date') or 'Today'}
- ISRC: {release.get('isrc') or 'Let DistroKid assign one'}
- UPC: {release.get('upc') or 'Let DistroKid assign one'}
- Songwriter: {release.get('songwriter_name') or 'Same as artist'}
- Producer: {release.get('producer_name') or ''}
- Label: {release.get('label') or ''}
- Notes: {release.get('notes') or ''}

AUDIO FILE URL: {audio_url}
ARTWORK URL: {artwork_url}

INSTRUCTIONS:
1. Open https://distrokid.com/vip/ in Chrome and log in with the credentials above.
2. Click "Distribute Music" or navigate to the upload page.
3. Select '{release.get('release_type', 'single').capitalize()}' as the release type.
4. Download the audio file from the URL above to ~/Downloads/ first using Terminal if needed.
5. Download the artwork from the URL above to ~/Downloads/ if needed.
6. Fill in every field with the metadata above.
7. Upload the audio file and artwork.
8. Select the correct platforms (Spotify, Apple Music, Tidal, Amazon Music, YouTube Music, etc).
9. Set the release date.
10. Review everything on the final page to confirm it's correct.
11. Submit the release.
12. Once submitted, take a screenshot and confirm success.

If you encounter 2FA or a CAPTCHA, pause and describe what you see so the user can intervene.
If any field is ambiguous, make the best choice and continue.
Report 'SUBMITTED' when the upload is complete, or 'ERROR: <reason>' if something failed.
"""


# ── Spotify pitch task ────────────────────────────────────────────────────────

def build_spotify_pitch_task(release: dict) -> str:
    pitch_copy = release.get("spotify_pitch_copy") or f"""
{release['title']} is a {release.get('genre', 'contemporary')} track with a fresh sound.
Key features: energetic production, strong melody, radio-ready mix.
"""
    return f"""You are submitting a Spotify editorial pitch for an upcoming release.

RELEASE:
- Song: {release['title']}
- Artist: {release.get('artist_name', '')}
- Release date: {release.get('release_date', '')}
- Genre: {release.get('genre', '')}

PITCH COPY TO USE:
{pitch_copy}

INSTRUCTIONS:
1. Open https://artists.spotify.com in Chrome (you may already be logged in).
2. Navigate to Music → Upcoming → find '{release['title']}' (it may take 1-3 days after DistroKid to appear).
3. Click 'Pitch to Editors'.
4. Fill in the pitch form using the copy above, selecting the correct mood/genre tags.
5. Submit the pitch.
6. Report 'PITCHED' on success, or 'NOT_AVAILABLE: <reason>' if the song isn't in Spotify yet.
"""


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("Usage: python release_agent.py <release_id> [distrokid|spotify|all]")
        sys.exit(1)

    release_id = sys.argv[1]
    mode = sys.argv[2] if len(sys.argv) > 2 else "all"

    print(f"Fetching release {release_id}...")
    release = fetch_release(release_id)
    versions = release.get("mf_versions", [])
    log = release.get("agent_log")

    def log_fn(msg):
        nonlocal log
        print(msg)
        log = append_log(release_id, log, msg)

    log_fn(f"Starting release agent for: {release['title']}")

    # ── DistroKid ──
    if mode in ("distrokid", "all"):
        log_fn("=== Starting DistroKid upload ===")
        patch_release(release_id, {"distrokid_status": "uploading"})

        task = build_distrokid_task(release, versions)
        result = run_agent(task, log_fn)

        if "SUBMITTED" in result.upper():
            patch_release(release_id, {"distrokid_status": "submitted", "dsp_submitted": True})
            log_fn("DistroKid upload SUBMITTED successfully.")
        else:
            patch_release(release_id, {"distrokid_status": "error"})
            log_fn(f"DistroKid upload result: {result}")

    # ── Spotify pitch ──
    if mode in ("spotify", "all"):
        log_fn("=== Starting Spotify pitch ===")
        task = build_spotify_pitch_task(release)
        result = run_agent(task, log_fn)
        log_fn(f"Spotify pitch result: {result}")

    log_fn("Agent finished.")


if __name__ == "__main__":
    main()
