# logic-sync Design Spec

## Goal

A macOS background agent that watches Logic Pro's bounce folder, detects new PRC WAV files, and automatically uploads them as new versions in mixbase under the correct project.

## Architecture

Single Python script (`logic_sync.py`) running as a macOS LaunchAgent. No server required — runs entirely on the local machine.

```
New file: "BURN IT DOWN - PRC8.wav" appears in ~/Music/Logic/Bounces/
     ↓ watchdog detects file creation event
     ↓ wait for file to finish writing (size stable for 3 seconds)
     ↓ parse → song="BURN IT DOWN", label="PRC8"
     ↓ check uploaded.json — skip if already processed
     ↓ GET https://mixbase-production.up.railway.app/api/projects → fuzzy match → project_id
     ↓ TUS chunked upload → /api/tus → Supabase mf-audio bucket → public URL
     ↓ POST /api/versions {project_id, audio_url, audio_filename, label, file_size_bytes, status="WIP"}
     ↓ write file hash to uploaded.json
     ↓ log to /tmp/logic-sync.log
```

## File Structure

```
~/logic-sync/
  logic_sync.py         # main watcher + uploader script
  uploaded.json         # persisted set of already-uploaded file hashes
  requirements.txt      # watchdog, requests, python-dotenv
  .env -> ~/.env.secrets
  com.moodmixformat.logic-sync.plist  # LaunchAgent definition
```

The plist is installed at `~/Library/LaunchAgents/com.moodmixformat.logic-sync.plist`.

## Components

### logic_sync.py

Responsibilities (in order):
1. Load env vars from `.env`
2. Start `watchdog` observer on `~/Music/Logic/Bounces/`
3. On `FileCreatedEvent` or `FileMovedEvent` for `*.wav`: debounce, wait for stable size, then process
4. Parse filename → song name + PRC label
5. Fetch project list, fuzzy match
6. TUS upload
7. Create version record
8. Record in `uploaded.json`

### File filtering

Only process files whose name matches: `* - PRC*.wav` (case-insensitive).

Ignore: `*SBX*.wav`, `*MIX*.wav`, `*PROD*.wav`, `*FINAL*.wav`, `*MASTER*.wav`, and any file that doesn't contain ` - PRC`.

### Filename parsing

```
"BURN IT DOWN - PRC8.wav"
  → strip .wav
  → split on " - PRC" → ["BURN IT DOWN", "8"]
  → song_name = "BURN IT DOWN"
  → label = "PRC8"
```

Edge cases:
- `"TIME & SPACE (Edit) - PRC4.wav"` → song_name = `"TIME & SPACE (Edit)"`, label = `"PRC4"`
- `"twenty one pilots - Routines in the Night (moodmixformat Remix) - PRC3.wav"` → split on last occurrence of ` - PRC`

### Project matching

1. GET `MIXBASE_URL/api/projects` → list of `{id, title}`
2. Normalize both sides: strip, uppercase
3. Exact match first
4. If no exact match: `difflib.get_close_matches(song_name_upper, titles_upper, n=1, cutoff=0.7)`
5. If still no match: log warning with filename, skip file (do not auto-create project)

### TUS upload (pure requests, no library)

```
CHUNK_SIZE = 8 * 1024 * 1024  # 8 MB — stays under Railway's 10 MB limit

1. POST MIXBASE_URL/api/tus
   Headers:
     Tus-Resumable: 1.0.0
     Upload-Length: <file_size>
     Upload-Metadata: filename <b64(filename)>,contentType <b64("audio/wav")>,bucketName <b64("mf-audio")>
   → 201, Location: /api/tus/<uploadId>

2. Read file in CHUNK_SIZE chunks:
   PATCH MIXBASE_URL/api/tus/<uploadId>
   Headers:
     Tus-Resumable: 1.0.0
     Content-Type: application/offset+octet-stream
     Upload-Offset: <current_offset>
   Body: chunk bytes
   → 204, Upload-Offset: <new_offset>

3. After final chunk: construct public URL:
   https://mdefkqaawrusoaojstpq.supabase.co/storage/v1/object/public/mf-audio/<uploadId>
```

### Version creation

```
POST MIXBASE_URL/api/versions
{
  "project_id": "<matched_id>",
  "audio_url": "<public_url>",
  "audio_filename": "<original_filename>",
  "file_size_bytes": <size>,
  "label": "PRC8",
  "status": "WIP"
}
```

### Deduplication

`uploaded.json` stores a set of SHA-256 hashes of already-processed files. On startup, load this set. Before processing, check hash. After success, append hash and rewrite file.

### Logging

All output goes to `/tmp/logic-sync.log` via Python `logging` (INFO level). Format: `[timestamp] LEVEL message`. Errors include filename and exception.

## Environment Variables

All already present in `~/.env.secrets` — no new secrets needed:

| Variable | Used for |
|---|---|
| `MIXBASE_URL` | mixbase API base (set to `https://mixbase-production.up.railway.app`) |
| `SUPABASE_URL` | Not needed — TUS goes through mixbase proxy |

Only `MIXBASE_URL` is needed. The TUS proxy handles Supabase auth server-side.

## LaunchAgent (plist)

```xml
Label: com.moodmixformat.logic-sync
ProgramArguments: [/usr/bin/python3, /Users/moodmixformat/logic-sync/logic_sync.py]
RunAtLoad: true
KeepAlive: true
StandardOutPath: /tmp/logic-sync.log
StandardErrorPath: /tmp/logic-sync-error.log
WorkingDirectory: /Users/moodmixformat/logic-sync
```

`KeepAlive: true` restarts the process if it crashes.

## Error Handling

- File not fully written: retry stable-size check up to 10 times (30s total), then skip with warning
- No project match: log warning, skip — never auto-create
- TUS upload failure: log error with chunk offset (resumption not implemented — re-upload from scratch on next run, dedup prevents double versions)
- Version creation failure: log error with response body
- Network error: log and skip — file stays out of `uploaded.json` so it will retry on next file event

## Testing

Manual test: copy a known WAV file into `~/Music/Logic/Bounces/` named `TEST - PRC99.wav` (after creating a "TEST" project in mixbase). Confirm log shows match found, upload progress, version created. Check mixbase dashboard for the new version.
