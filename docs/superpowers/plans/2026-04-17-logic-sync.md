# logic-sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a macOS background agent that watches `/Users/moodmixformat/Library/Mobile Documents/com~apple~CloudDocs/moodmixformat/PROD/2025/PRC/` for new `* - PRC*.wav` files and automatically uploads them as new versions in mixbase under the matching project.

**Architecture:** A single Python script using `watchdog` to monitor the bounce folder. When a matching file appears and finishes writing, it parses the song name + PRC label from the filename, fuzzy-matches to a mixbase project via the REST API, uploads the WAV via TUS chunked upload through the mixbase proxy, then POSTs a new version record. A JSON file persists SHA-256 hashes of already-processed files to prevent duplicates across restarts. A LaunchAgent plist keeps the script running at all times.

**Tech Stack:** Python 3, watchdog, requests, python-dotenv, difflib (stdlib), hashlib (stdlib), macOS LaunchAgent

---

## File Map

| File | Purpose |
|---|---|
| `~/logic-sync/logic_sync.py` | Main script: watcher, parser, uploader, version creator |
| `~/logic-sync/test_logic_sync.py` | Unit tests for pure functions (parse, match) |
| `~/logic-sync/uploaded.json` | Persisted set of SHA-256 hashes of uploaded files |
| `~/logic-sync/requirements.txt` | Python dependencies |
| `~/logic-sync/.env` | Symlink → `~/.env.secrets` |
| `~/logic-sync/.gitignore` | Ignore `.env`, `uploaded.json`, `*.log` |
| `~/logic-sync/com.moodmixformat.logic-sync.plist` | LaunchAgent definition |

---

### Task 1: Repo scaffold + env setup

**Files:**
- Create: `~/logic-sync/requirements.txt`
- Create: `~/logic-sync/.gitignore`
- Create: `~/logic-sync/uploaded.json`
- Create: `~/logic-sync/.env` (symlink)

- [ ] **Step 1: Create the repo directory and init git**

```bash
mkdir ~/logic-sync && cd ~/logic-sync
git init
gh repo create logic-sync --private --source=. --remote=origin --push
```

- [ ] **Step 2: Create requirements.txt**

```
watchdog==4.0.1
requests==2.31.0
python-dotenv==1.0.1
```

- [ ] **Step 3: Create .gitignore**

```
.env
uploaded.json
*.log
__pycache__/
*.pyc
```

- [ ] **Step 4: Create empty uploaded.json**

```json
[]
```

- [ ] **Step 5: Symlink .env to master secrets**

```bash
cd ~/logic-sync
ln -sf ~/.env.secrets .env
```

- [ ] **Step 6: Add MIXBASE_URL to ~/.env.secrets**

Open `~/.env.secrets` and add this line if it isn't already there:

```
MIXBASE_URL=https://mixbase-production.up.railway.app
```

- [ ] **Step 7: Install dependencies**

```bash
cd ~/logic-sync
pip3 install -r requirements.txt
```

Expected: all packages install without error.

- [ ] **Step 8: Commit scaffold**

```bash
cd ~/logic-sync
git add requirements.txt .gitignore uploaded.json
git commit -m "chore: initial scaffold"
git push origin main
```

---

### Task 2: Filename parser (with tests)

**Files:**
- Create: `~/logic-sync/test_logic_sync.py`
- Create: `~/logic-sync/logic_sync.py` (parse_filename function only)

- [ ] **Step 1: Create test file with failing tests**

```python
# ~/logic-sync/test_logic_sync.py
import pytest
from logic_sync import parse_filename

def test_simple_prc():
    assert parse_filename("BURN IT DOWN - PRC8.wav") == ("BURN IT DOWN", "PRC8")

def test_prc_with_parenthetical():
    assert parse_filename("TIME & SPACE (Edit) - PRC4.wav") == ("TIME & SPACE (Edit)", "PRC4")

def test_ampersand_in_name():
    assert parse_filename("RIGHT & WRONG - PRC5.wav") == ("RIGHT & WRONG", "PRC5")

def test_apostrophe_in_name():
    assert parse_filename("I'M GONNA LET GO - PRC2.wav") == ("I'M GONNA LET GO", "PRC2")

def test_artist_prefix():
    # Split on LAST occurrence of " - PRC"
    result = parse_filename("twenty one pilots - Routines in the Night (moodmixformat Remix) - PRC3.wav")
    assert result == ("twenty one pilots - Routines in the Night (moodmixformat Remix)", "PRC3")

def test_non_prc_returns_none():
    assert parse_filename("BURN IT DOWN - SBX1.wav") is None

def test_non_prc_mix_returns_none():
    assert parse_filename("BURN IT DOWN - MIX 7.wav") is None

def test_non_wav_returns_none():
    assert parse_filename("BURN IT DOWN - PRC8.mp3") is None

def test_prc_double_digit():
    assert parse_filename("BREATHE EASIER - PRC12.wav") == ("BREATHE EASIER", "PRC12")
```

- [ ] **Step 2: Run tests — confirm they all fail**

```bash
cd ~/logic-sync
python3 -m pytest test_logic_sync.py -v
```

Expected: `ImportError: No module named 'logic_sync'` or similar — all fail.

- [ ] **Step 3: Create logic_sync.py with parse_filename**

```python
# ~/logic-sync/logic_sync.py
import re

def parse_filename(filename: str) -> tuple[str, str] | None:
    """
    Parse a Logic bounce filename into (song_name, prc_label).
    Returns None if the file doesn't match the PRC pattern.

    Examples:
      "BURN IT DOWN - PRC8.wav" -> ("BURN IT DOWN", "PRC8")
      "BURN IT DOWN - SBX1.wav" -> None
    """
    if not filename.lower().endswith('.wav'):
        return None
    stem = filename[:-4]  # strip .wav
    # Match last occurrence of " - PRC" followed by digits
    match = re.search(r'^(.*) - (PRC\d+)$', stem)
    if not match:
        return None
    return match.group(1), match.group(2)
```

- [ ] **Step 4: Run tests — confirm they all pass**

```bash
cd ~/logic-sync
python3 -m pytest test_logic_sync.py -v
```

Expected: 9 tests pass, 0 failures.

- [ ] **Step 5: Commit**

```bash
cd ~/logic-sync
git add logic_sync.py test_logic_sync.py
git commit -m "feat: filename parser with tests"
git push origin main
```

---

### Task 3: Project matcher (with tests)

**Files:**
- Modify: `~/logic-sync/logic_sync.py` — add `match_project`
- Modify: `~/logic-sync/test_logic_sync.py` — add matcher tests

- [ ] **Step 1: Add matcher tests to test_logic_sync.py**

Append these tests to the existing test file:

```python
from logic_sync import match_project

PROJECTS = [
    {"id": "aaa", "title": "BURN IT DOWN"},
    {"id": "bbb", "title": "KNEE DEEP"},
    {"id": "ccc", "title": "RIGHT & WRONG"},
    {"id": "ddd", "title": "I'M GONNA LET GO"},
    {"id": "eee", "title": "TIME & SPACE"},
]

def test_exact_match():
    assert match_project("BURN IT DOWN", PROJECTS) == "aaa"

def test_case_insensitive():
    assert match_project("burn it down", PROJECTS) == "aaa"

def test_fuzzy_match_minor_typo():
    # "KNEE DEEEP" is close enough
    assert match_project("KNEE DEEEP", PROJECTS) == "bbb"

def test_ampersand_match():
    assert match_project("RIGHT & WRONG", PROJECTS) == "ccc"

def test_no_match_returns_none():
    assert match_project("COMPLETELY DIFFERENT SONG", PROJECTS) is None

def test_apostrophe_match():
    assert match_project("I'M GONNA LET GO", PROJECTS) == "ddd"
```

- [ ] **Step 2: Run tests — confirm new tests fail**

```bash
cd ~/logic-sync
python3 -m pytest test_logic_sync.py::test_exact_match -v
```

Expected: `ImportError` or `NameError` — fails.

- [ ] **Step 3: Add match_project to logic_sync.py**

Append to `logic_sync.py`:

```python
import difflib

def match_project(song_name: str, projects: list[dict]) -> str | None:
    """
    Match a song name to a mixbase project ID.
    Returns the project ID string, or None if no confident match found.

    Tries exact match (case-insensitive) first, then fuzzy match with
    difflib at 0.7 cutoff.
    """
    normalized = song_name.strip().upper()
    titles_upper = [p['title'].strip().upper() for p in projects]

    # Exact match
    for i, title in enumerate(titles_upper):
        if title == normalized:
            return projects[i]['id']

    # Fuzzy match
    matches = difflib.get_close_matches(normalized, titles_upper, n=1, cutoff=0.7)
    if matches:
        idx = titles_upper.index(matches[0])
        return projects[idx]['id']

    return None
```

- [ ] **Step 4: Run all tests — confirm all pass**

```bash
cd ~/logic-sync
python3 -m pytest test_logic_sync.py -v
```

Expected: all 15 tests pass.

- [ ] **Step 5: Commit**

```bash
cd ~/logic-sync
git add logic_sync.py test_logic_sync.py
git commit -m "feat: project fuzzy matcher with tests"
git push origin main
```

---

### Task 4: TUS uploader

**Files:**
- Modify: `~/logic-sync/logic_sync.py` — add `upload_wav` function

- [ ] **Step 1: Add upload_wav to logic_sync.py**

Append to `logic_sync.py`:

```python
import base64
import os
import requests

CHUNK_SIZE = 8 * 1024 * 1024  # 8 MB — stays under Railway's 10 MB proxy limit
SUPABASE_PROJECT_REF = "mdefkqaawrusoaojstpq"

def upload_wav(filepath: str, mixbase_url: str) -> str:
    """
    Upload a WAV file to Supabase mf-audio bucket via mixbase TUS proxy.
    Returns the public Supabase storage URL for the uploaded file.

    Raises requests.HTTPError on any non-2xx response.
    """
    filename = os.path.basename(filepath)
    file_size = os.path.getsize(filepath)

    def b64(s: str) -> str:
        return base64.b64encode(s.encode()).decode()

    # Step 1: Create TUS upload session
    create_resp = requests.post(
        f"{mixbase_url}/api/tus",
        headers={
            "Tus-Resumable": "1.0.0",
            "Upload-Length": str(file_size),
            "Upload-Metadata": (
                f"filename {b64(filename)},"
                f"contentType {b64('audio/wav')},"
                f"bucketName {b64('mf-audio')}"
            ),
        },
        timeout=30,
    )
    create_resp.raise_for_status()

    # Location is like /api/tus/<uploadId>
    location_path = create_resp.headers["Location"]
    upload_id = location_path.split("/api/tus/")[-1]

    # Step 2: Upload chunks
    offset = 0
    with open(filepath, "rb") as f:
        while offset < file_size:
            chunk = f.read(CHUNK_SIZE)
            patch_resp = requests.patch(
                f"{mixbase_url}/api/tus/{upload_id}",
                headers={
                    "Tus-Resumable": "1.0.0",
                    "Content-Type": "application/offset+octet-stream",
                    "Upload-Offset": str(offset),
                    "Content-Length": str(len(chunk)),
                },
                data=chunk,
                timeout=120,
            )
            patch_resp.raise_for_status()
            offset = int(patch_resp.headers["Upload-Offset"])

    # Step 3: Construct public URL
    public_url = (
        f"https://{SUPABASE_PROJECT_REF}.supabase.co"
        f"/storage/v1/object/public/mf-audio/{upload_id}"
    )
    return public_url
```

- [ ] **Step 2: Smoke-test upload manually**

Run this one-off test from the terminal (replace path with any small WAV file you have):

```bash
cd ~/logic-sync
source .env
python3 - <<'EOF'
from logic_sync import upload_wav
import os
url = upload_wav(
    "/Users/moodmixformat/Library/Mobile Documents/com~apple~CloudDocs/moodmixformat/PROD/2025/PRC/I'M GONNA LET GO - PRC2.wav",
    os.environ["MIXBASE_URL"]
)
print("Uploaded:", url)
EOF
```

Expected: prints a `https://mdefkqaawrusoaojstpq.supabase.co/storage/v1/object/public/mf-audio/...` URL. Paste the URL in a browser — the WAV should download.

- [ ] **Step 3: Commit**

```bash
cd ~/logic-sync
git add logic_sync.py
git commit -m "feat: TUS chunked WAV uploader"
git push origin main
```

---

### Task 5: Version creator + dedup

**Files:**
- Modify: `~/logic-sync/logic_sync.py` — add `create_version`, `file_hash`, `load_uploaded`, `save_uploaded`

- [ ] **Step 1: Add version creator and dedup helpers to logic_sync.py**

Append to `logic_sync.py`:

```python
import hashlib
import json

UPLOADED_PATH = os.path.join(os.path.dirname(__file__), "uploaded.json")

def file_hash(filepath: str) -> str:
    """Return SHA-256 hex digest of a file."""
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()

def load_uploaded() -> set[str]:
    """Load set of already-uploaded file hashes from uploaded.json."""
    try:
        with open(UPLOADED_PATH) as f:
            return set(json.load(f))
    except (FileNotFoundError, json.JSONDecodeError):
        return set()

def save_uploaded(hashes: set[str]) -> None:
    """Persist the set of uploaded file hashes to uploaded.json."""
    with open(UPLOADED_PATH, "w") as f:
        json.dump(list(hashes), f)

def create_version(
    project_id: str,
    audio_url: str,
    audio_filename: str,
    file_size_bytes: int,
    label: str,
    mixbase_url: str,
) -> dict:
    """
    POST a new version to mixbase. Returns the created version dict.
    Raises requests.HTTPError on failure.
    """
    resp = requests.post(
        f"{mixbase_url}/api/versions",
        json={
            "project_id": project_id,
            "audio_url": audio_url,
            "audio_filename": audio_filename,
            "file_size_bytes": file_size_bytes,
            "label": label,
            "status": "WIP",
        },
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()
```

- [ ] **Step 2: Add dedup + version tests to test_logic_sync.py**

Append to `test_logic_sync.py`:

```python
import json, os, tempfile
from logic_sync import file_hash, load_uploaded, save_uploaded

def test_file_hash_is_deterministic(tmp_path):
    f = tmp_path / "test.wav"
    f.write_bytes(b"hello world")
    h1 = file_hash(str(f))
    h2 = file_hash(str(f))
    assert h1 == h2
    assert len(h1) == 64  # SHA-256 hex

def test_load_uploaded_empty_file(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    path = tmp_path / "uploaded.json"
    path.write_text("[]")
    import logic_sync
    monkeypatch.setattr(logic_sync, "UPLOADED_PATH", str(path))
    assert load_uploaded() == set()

def test_save_and_reload(tmp_path, monkeypatch):
    import logic_sync
    path = tmp_path / "uploaded.json"
    monkeypatch.setattr(logic_sync, "UPLOADED_PATH", str(path))
    save_uploaded({"abc123", "def456"})
    assert load_uploaded() == {"abc123", "def456"}
```

- [ ] **Step 3: Run all tests**

```bash
cd ~/logic-sync
python3 -m pytest test_logic_sync.py -v
```

Expected: all 18 tests pass.

- [ ] **Step 4: Commit**

```bash
cd ~/logic-sync
git add logic_sync.py test_logic_sync.py
git commit -m "feat: version creator + dedup helpers"
git push origin main
```

---

### Task 6: Main watcher loop

**Files:**
- Modify: `~/logic-sync/logic_sync.py` — add `process_file`, `BounceHandler`, `main`

- [ ] **Step 1: Add the watcher + orchestration to logic_sync.py**

Append to `logic_sync.py`:

```python
import time
import logging
from dotenv import load_dotenv
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler, FileCreatedEvent, FileMovedEvent

load_dotenv()

BOUNCE_DIR = "/Users/moodmixformat/Library/Mobile Documents/com~apple~CloudDocs/moodmixformat/PROD/2025/PRC"
MIXBASE_URL = os.environ["MIXBASE_URL"].rstrip("/")
STABLE_WAIT_SECS = 3   # seconds file size must be stable before processing
STABLE_CHECKS = 10     # max retries waiting for stable size

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.StreamHandler(),  # also prints to stdout → LaunchAgent log
    ],
)
log = logging.getLogger(__name__)


def wait_for_stable_size(filepath: str) -> bool:
    """
    Wait until the file size stops changing (file is fully written).
    Returns True if stable, False if timed out.
    """
    prev_size = -1
    for _ in range(STABLE_CHECKS):
        try:
            size = os.path.getsize(filepath)
        except FileNotFoundError:
            return False
        if size == prev_size and size > 0:
            return True
        prev_size = size
        time.sleep(STABLE_WAIT_SECS)
    return False


def fetch_projects() -> list[dict]:
    """Fetch all mixbase projects. Returns list of {id, title} dicts."""
    resp = requests.get(f"{MIXBASE_URL}/api/projects", timeout=15)
    resp.raise_for_status()
    return resp.json()


def process_file(filepath: str, uploaded: set[str]) -> bool:
    """
    Process a single bounce file. Returns True if successfully uploaded,
    False if skipped or errored.
    """
    filename = os.path.basename(filepath)

    parsed = parse_filename(filename)
    if parsed is None:
        log.debug("Skipping non-PRC file: %s", filename)
        return False

    song_name, label = parsed
    log.info("Detected bounce: %s (song=%r, label=%s)", filename, song_name, label)

    # Dedup check
    fhash = file_hash(filepath)
    if fhash in uploaded:
        log.info("Already uploaded, skipping: %s", filename)
        return False

    # Wait for file to finish writing
    if not wait_for_stable_size(filepath):
        log.warning("File never stabilised, skipping: %s", filename)
        return False

    # Match project
    try:
        projects = fetch_projects()
    except Exception as e:
        log.error("Failed to fetch projects: %s", e)
        return False

    project_id = match_project(song_name, projects)
    if project_id is None:
        log.warning("No matching project for %r — skipping %s", song_name, filename)
        return False

    log.info("Matched project_id=%s for %r", project_id, song_name)

    # Upload
    try:
        audio_url = upload_wav(filepath, MIXBASE_URL)
        log.info("Uploaded to %s", audio_url)
    except Exception as e:
        log.error("Upload failed for %s: %s", filename, e)
        return False

    # Create version
    try:
        version = create_version(
            project_id=project_id,
            audio_url=audio_url,
            audio_filename=filename,
            file_size_bytes=os.path.getsize(filepath),
            label=label,
            mixbase_url=MIXBASE_URL,
        )
        log.info("Created version v%s for %r (id=%s)", version.get("version_number"), song_name, version.get("id"))
    except Exception as e:
        log.error("Version creation failed for %s: %s", filename, e)
        return False

    # Mark as uploaded
    uploaded.add(fhash)
    save_uploaded(uploaded)
    return True


class BounceHandler(FileSystemEventHandler):
    def __init__(self, uploaded: set[str]):
        self.uploaded = uploaded

    def on_created(self, event):
        if not event.is_directory and event.src_path.lower().endswith('.wav'):
            process_file(event.src_path, self.uploaded)

    def on_moved(self, event):
        # Logic sometimes writes to a temp path then moves
        if not event.is_directory and event.dest_path.lower().endswith('.wav'):
            process_file(event.dest_path, self.uploaded)


def main():
    log.info("logic-sync starting — watching %s", BOUNCE_DIR)
    uploaded = load_uploaded()
    observer = Observer()
    observer.schedule(BounceHandler(uploaded), BOUNCE_DIR, recursive=False)
    observer.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        log.info("logic-sync stopping")
        observer.stop()
    observer.join()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run manually to verify the watcher works**

```bash
cd ~/logic-sync
source .env
python3 logic_sync.py
```

Expected output:
```
2026-04-17 12:00:00 INFO logic-sync starting — watching /Users/moodmixformat/Music/Logic/Bounces
```

Leave it running. In another terminal, copy a test file:

```bash
cp /Users/moodmixformat/Library/Mobile Documents/com~apple~CloudDocs/moodmixformat/PROD/2025/PRC/"I'M GONNA LET GO - PRC2.wav" /Users/moodmixformat/Library/Mobile Documents/com~apple~CloudDocs/moodmixformat/PROD/2025/PRC/"TEST SONG - PRC99.wav"
```

Expected: watcher logs `Detected bounce`, `Matched project_id`, `Uploaded`, `Created version`. (If no "TEST SONG" project exists in mixbase, it logs "No matching project" — that's correct.)

Press Ctrl-C to stop.

- [ ] **Step 3: Run full test suite**

```bash
cd ~/logic-sync
python3 -m pytest test_logic_sync.py -v
```

Expected: all 18 tests still pass.

- [ ] **Step 4: Commit**

```bash
cd ~/logic-sync
git add logic_sync.py
git commit -m "feat: file watcher + main orchestration loop"
git push origin main
```

---

### Task 7: LaunchAgent — runs at login, survives crashes

**Files:**
- Create: `~/logic-sync/com.moodmixformat.logic-sync.plist`

- [ ] **Step 1: Create the plist file**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.moodmixformat.logic-sync</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/python3</string>
        <string>/Users/moodmixformat/logic-sync/logic_sync.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/moodmixformat/logic-sync</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/logic-sync.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/logic-sync-error.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
```

- [ ] **Step 2: Install and load the LaunchAgent**

```bash
cp ~/logic-sync/com.moodmixformat.logic-sync.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.moodmixformat.logic-sync.plist
```

- [ ] **Step 3: Verify it's running**

```bash
launchctl list | grep logic-sync
```

Expected: a line like `12345  0  com.moodmixformat.logic-sync` (PID + exit code 0).

```bash
tail -f /tmp/logic-sync.log
```

Expected: `logic-sync starting — watching /Users/moodmixformat/Music/Logic/Bounces`

- [ ] **Step 4: Test end-to-end with a real bounce**

In Logic Pro, bounce any track as WAV to `/Users/moodmixformat/Library/Mobile Documents/com~apple~CloudDocs/moodmixformat/PROD/2025/PRC/` with a name matching an existing mixbase project (e.g. `BURN IT DOWN - PRC8.wav`). Watch the log:

```bash
tail -f /tmp/logic-sync.log
```

Expected log sequence:
```
INFO Detected bounce: BURN IT DOWN - PRC8.wav (song='BURN IT DOWN', label=PRC8)
INFO Matched project_id=<uuid> for 'BURN IT DOWN'
INFO Uploaded to https://mdefkqaawrusoaojstpq.supabase.co/...
INFO Created version v8 for 'BURN IT DOWN' (id=<uuid>)
```

Check mixbase dashboard — the new version should appear under the correct project.

- [ ] **Step 5: Commit and push**

```bash
cd ~/logic-sync
git add com.moodmixformat.logic-sync.plist
git commit -m "feat: LaunchAgent plist — runs at login, auto-restarts"
git push origin main
```

---

## Reload command (use whenever you update logic_sync.py)

```bash
launchctl unload ~/Library/LaunchAgents/com.moodmixformat.logic-sync.plist
launchctl load ~/Library/LaunchAgents/com.moodmixformat.logic-sync.plist
tail -f /tmp/logic-sync.log
```
