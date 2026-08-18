// /api/visualizer/finalize contract test — exercises the REAL pure helpers
// (src/lib/visualizer-finalize.ts via Node type stripping), no inline copies,
// plus a source contract over the route itself.
//
// Run: node scripts/viz-finalize-test.mjs
//
// The finalize route indexes objects the browser PUT directly into mf-video
// via signed URLs. Its storage-path gate is the ownership boundary: the key's
// first segment must be the caller's own (already-verified) projectId, the
// basename must be the viz-<stamp> shape clients generate, and the extension
// dispatches mp4-validate vs webm-transcode. These checks lock that gate.
//
// The route half is a SOURCE contract (grep over the shipped file), not a
// mocked run: the handler's failure exits are all storage + Sentry side
// effects, and the property that matters — "no non-2xx exit leaves bytes in
// the PUBLIC bucket with no row pointing at them" — is a property of the exit
// table, which is exactly what source shape encodes. Every check below is
// written so that DELETING the guard turns it red.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  MAX_FINALIZE_BYTES,
  MAX_FINALIZE_WEBM_BYTES,
  MIN_CLIP_SECONDS,
  MP4_PROBE_BYTES,
  clipRejectionReason,
  maxFinalizeBytesFor,
  parseVizStoragePath,
  sanitizeSettings,
  totalBytesFromHeaders,
} from '../src/lib/visualizer-finalize.ts'
import { defaultRecipe } from '../src/lib/fx/recipe.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const PID = '123e4567-e89b-42d3-a456-426614174000'
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

// A minimal stand-in for the Headers of a storage response.
const headersOf = (obj) => ({ get: (name) => obj[name.toLowerCase()] ?? null })

// ── parseVizStoragePath ─────────────────────────────────────────────────────

check('accepts an owned mp4 key', parseVizStoragePath(PID, `${PID}/viz-1755100000000.mp4`)?.ext === 'mp4')
check('accepts an owned webm key', parseVizStoragePath(PID, `${PID}/viz-1755100000000.webm`)?.ext === 'webm')

check("rejects another project's prefix", parseVizStoragePath(PID, `${OTHER}/viz-1755100000000.mp4`) === null)
check('rejects traversal', parseVizStoragePath(PID, `${PID}/../${OTHER}/viz-1.mp4`) === null)
check('rejects nested paths', parseVizStoragePath(PID, `${PID}/sub/viz-1.mp4`) === null)
check('rejects non-viz basenames', parseVizStoragePath(PID, `${PID}/audio-1.mp4`) === null)
check('rejects other extensions', parseVizStoragePath(PID, `${PID}/viz-1.mov`) === null)
check('rejects double extensions', parseVizStoragePath(PID, `${PID}/viz-1.mp4.webm`) === null)
check('rejects an empty stamp', parseVizStoragePath(PID, `${PID}/viz-.mp4`) === null)
check('rejects overlong paths', parseVizStoragePath(PID, `${PID}/viz-${'a'.repeat(200)}.mp4`) === null)
check('rejects non-strings', parseVizStoragePath(PID, 42) === null && parseVizStoragePath(PID, null) === null)
check('rejects query-ish suffixes', parseVizStoragePath(PID, `${PID}/viz-1.mp4?x=1`) === null)

// ── sanitizeSettings ────────────────────────────────────────────────────────

{
  const recipe = defaultRecipe('pulse', 'youtube', 99)
  const out = sanitizeSettings(JSON.parse(JSON.stringify(recipe)))
  check('round-trips a valid recipe', JSON.stringify(out) === JSON.stringify(recipe))
  check('nulls garbage', sanitizeSettings({ v: 9 }) === null && sanitizeSettings('x') === null)
  check('nulls absent settings', sanitizeSettings(undefined) === null && sanitizeSettings(null) === null)
  const clamped = sanitizeSettings({ ...recipe, scene: { id: 'pulse', params: { punch: 999 } } })
  check('clamps recipe params on the way in', clamped?.scene.params.punch === 2.5, `got ${clamped?.scene.params.punch}`)
}

// ── constants sanity (route + client budgets agree) ─────────────────────────

check('mp4 cap covers 4K exports with headroom', MAX_FINALIZE_BYTES === 200 * 1024 * 1024)
check('webm cap bounds the transcoder input near its old assumptions', MAX_FINALIZE_WEBM_BYTES === 48 * 1024 * 1024)
check('minimum duration matches finalize-video', MIN_CLIP_SECONDS === 0.5)
check('probe window is faststart-sized', MP4_PROBE_BYTES === 2 * 1024 * 1024)

check('mp4 claims get the 200 MB ceiling', maxFinalizeBytesFor('mp4') === MAX_FINALIZE_BYTES)
check('webm claims get the tighter transcoder-safe ceiling', maxFinalizeBytesFor('webm') === MAX_FINALIZE_WEBM_BYTES)

// ── totalBytesFromHeaders ───────────────────────────────────────────────────
// The size gate for BOTH lanes. Its whole job is to distinguish "measured and
// small enough" from "could not measure" — conflating those is the bug.

check('reads the total from a 206 Content-Range',
  totalBytesFromHeaders(headersOf({ 'content-range': 'bytes 0-2097151/524288000' })) === 524_288_000)
check('falls back to Content-Length when the server ignored Range',
  totalBytesFromHeaders(headersOf({ 'content-length': '1234' })) === 1234)
check('prefers Content-Range over the partial-body Content-Length',
  totalBytesFromHeaders(headersOf({ 'content-range': 'bytes 0-0/999', 'content-length': '1' })) === 999)
check('reads a zero-length object as 0, not as unknown',
  totalBytesFromHeaders(headersOf({ 'content-length': '0' })) === 0)
check('treats an unknown total ("bytes 0-0/*") as unknown',
  totalBytesFromHeaders(headersOf({ 'content-range': 'bytes 0-0/*' })) === null)
check('falls through a "*" total to Content-Length',
  totalBytesFromHeaders(headersOf({ 'content-range': 'bytes 0-0/*', 'content-length': '77' })) === 77)
check('treats a silent response as unknown',
  totalBytesFromHeaders(headersOf({})) === null)
check('treats junk as unknown, not as a number',
  totalBytesFromHeaders(headersOf({ 'content-length': '12abc' })) === null
  && totalBytesFromHeaders(headersOf({ 'content-length': '  ' })) === null
  && totalBytesFromHeaders(headersOf({ 'content-range': 'bytes */-5' })) === null)
check('is case-insensitive about header names',
  totalBytesFromHeaders({ get: (n) => (n.toLowerCase() === 'content-length' ? '42' : null) }) === 42)

// Fail-first witness: the expression this helper replaced, verbatim from the
// shipped mp4 lane. It could not represent "unknown", so a header-less
// response became 0 and 0 passed every cap.
{
  const legacyTotal = (h) => {
    const contentRange = h.get('content-range')
    return contentRange
      ? parseInt(contentRange.split('/')[1] ?? '0', 10)
      : parseInt(h.get('content-length') ?? '0', 10)
  }
  const silent = headersOf({})
  check('witness: the old inline parse turned "no size headers" into 0', legacyTotal(silent) === 0)
  check('witness: …so the 200 MB cap never fired on an unmeasurable object',
    !(legacyTotal(silent) > MAX_FINALIZE_BYTES))
  check('witness: the old parse also accepted a malformed total',
    parseInt('12abc', 10) === 12 && totalBytesFromHeaders(headersOf({ 'content-length': '12abc' })) === null)
  check('the helper refuses to call an unmeasurable object small enough',
    totalBytesFromHeaders(silent) === null)
}

// ── clipRejectionReason ─────────────────────────────────────────────────────
// Content validation, now shared by both lanes.

check('mp4 lane accepts H.264 with a sane duration',
  clipRejectionReason({ codec: 'avc', duration: 6 }, 'mp4') === null)
check('mp4 lane still rejects a non-H.264 mp4',
  clipRejectionReason({ codec: 'vp9', duration: 6 }, 'mp4') === 'codec vp9')
check('webm lane accepts vp8 and vp9 (it must NOT demand avc)',
  clipRejectionReason({ codec: 'vp8', duration: 6 }, 'webm') === null
  && clipRejectionReason({ codec: 'vp9', duration: 30 }, 'webm') === null)
check('rejects a blob with no video track — the 0-byte MediaRecorder case',
  clipRejectionReason({ codec: null, duration: 0 }, 'webm') === 'no video track'
  && clipRejectionReason({ codec: null, duration: 0 }, 'mp4') === 'no video track')
check('rejects a clip shorter than finalize-video accepts',
  clipRejectionReason({ codec: 'vp9', duration: 0.2 }, 'webm') === 'duration 0.2')
check('rejects an unreadable duration',
  clipRejectionReason({ codec: 'vp9', duration: NaN }, 'webm') === 'duration NaN')
check('accepts a clip exactly at the minimum',
  clipRejectionReason({ codec: 'vp8', duration: MIN_CLIP_SECONDS }, 'webm') === null)

// Fail-first witness: the shipped webm lane's ONLY gate was blob.size, so a
// 0-byte blob — which MediaRecorder really does produce when 'dataavailable'
// never fires — passed it and got indexed as a saved visualizer.
{
  const legacyWebmAccepts = (sizeBytes) => sizeBytes <= MAX_FINALIZE_WEBM_BYTES
  check('witness: the old webm lane accepted a 0-byte blob', legacyWebmAccepts(0) === true)
  check('witness: …and a buffer of junk of any small size', legacyWebmAccepts(10) === true)
  check('the shared probe rejects both',
    clipRejectionReason({ codec: null, duration: NaN }, 'webm') !== null)
}

// ── Route source contract ───────────────────────────────────────────────────
// Orphaned bytes in the PUBLIC mf-video bucket are the failure this section
// exists to prevent: an object with no mb_visualizers row is invisible in
// Media, undeletable through DELETE /api/visualizer/[id] (which derives its
// storage key from video_url), and missed by /api/auth/delete-account.

const route = read('src/app/api/visualizer/finalize/route.ts')

// 1. Ownership must be proven BEFORE anything else happens, for two reasons:
//    you cannot safely delete an object until you know the caller owns its
//    key, and a malformed claim must not burn one of the user's 20 saves/hr.
const iOwns = route.indexOf('userOwnsProject(')
const iPath = route.indexOf('parseVizStoragePath(')
const iLimit = route.indexOf('checkUserLimit(vizSaveLimiter')
check('route proves project ownership before spending a rate-limit credit',
  iOwns !== -1 && iLimit !== -1 && iOwns < iLimit, `owns@${iOwns} limit@${iLimit}`)
check('route validates the storage path before spending a rate-limit credit',
  iPath !== -1 && iLimit !== -1 && iPath < iLimit, `path@${iPath} limit@${iLimit}`)

// 2. Past the ownership gate, EVERY failure exit must go through one of the
//    two named exits — discardAndFail (delete the bytes) or retryLater (keep
//    them, the client retries the claim). A bare NextResponse.json with a 4xx
//    or 5xx literal is precisely the shape that shipped the leak.
const gate = route.indexOf('const safeRemove')
check('route defines the owned-object delete helper', gate !== -1)
const owned = gate === -1 ? '' : route.slice(gate)
// `{ error: '…'` with a literal message is the hand-rolled exit shape; the two
// helpers forward an already-bound `{ error }`, so their own bodies are not
// mistaken for leaks.
const bareExits = [...owned.matchAll(/NextResponse\.json\(\s*\{\s*error:[^)]*status:\s*(4\d\d|5\d\d)/g)]
check('no failure exit past the ownership gate bypasses discardAndFail/retryLater',
  bareExits.length === 0, bareExits.map((m) => m[1]).join(', ') || 'none')

const iDiscard = owned.indexOf('const discardAndFail')
const iRetry = owned.indexOf('const retryLater')
const retryBody = iRetry === -1 ? '' : owned.slice(iRetry, iRetry + 400)
check('the delete helper is the one that removes the object',
  iDiscard !== -1 && /const discardAndFail[\s\S]{0,400}?await safeRemove\(\)/.test(owned))
check('the retry helper deliberately does NOT remove the object',
  iRetry !== -1 && !/safeRemove/.test(retryBody))

// 2b. Keys the client signed but abandoned mid-upload. fx/upload.ts retries a
//     failed PUT against a FRESH key (replaying a spent one hits upsert:false),
//     so a first PUT that delivered its bytes and lost only its response leaves
//     an object no other cleanup path can reach — no row is ever written for
//     it, and both DELETE /api/visualizer/[id] and account deletion start from
//     a row. The claim reports those keys; the sweep must re-validate each one
//     against THIS caller's project rather than trusting the list.
const iAband = route.indexOf('const abandonedPaths')
check('route accepts the abandoned-key list from the claim', iAband !== -1)
const abandBlock = iAband === -1 ? '' : route.slice(iAband, iAband + 900)
check('abandoned keys are re-validated against the caller-owned project',
  /parseVizStoragePath\(projectId, p\)/.test(abandBlock))
check('the abandoned list cannot name the object being claimed',
  /p !== storagePath/.test(abandBlock))
// A legitimate client abandons at most one key per save, so the cap is there to
// stop a hand-rolled claim turning one request into an unbounded delete loop —
// which a nominal `.slice(0, 100000)` would not do.
const cap = abandBlock.match(/\.slice\(0,\s*(\d+)\)/)
check('the abandoned list is capped near what a real client can produce',
  !!cap && Number(cap[1]) <= 8, cap ? `cap ${cap[1]}` : 'no cap')
check('abandoned keys are swept through the same reference-checked delete',
  /for \(const key of abandonedPaths\) await removeIfUnreferenced\(key\)/.test(route))
check('the reference check is shared, not duplicated per key',
  /const safeRemove = \(\) => removeIfUnreferenced\(storagePath\)/.test(route))

// 3. The specific exits the audit found leaking. Each names its own status so
//    deleting any single guard turns exactly one line red.
const exit = (message, status) =>
  new RegExp(`discardAndFail\\(\\s*'${message}'\\s*,\\s*${status}`).test(owned)
check('429 rate-limit exit deletes the just-uploaded object',
  exit('Too many visualizer saves\\. Try again shortly\\.', 429))
// Three oversize exits: the mp4 Range probe, the webm size probe, and the
// webm post-download cross-check.
check('every oversize exit deletes instead of orphaning',
  [...owned.matchAll(/discardAndFail\(\s*'Video too large'\s*,\s*413/g)].length === 3)
check('unplayable-mp4 exit deletes',
  exit('Uploaded file is not a playable H\\.264 MP4 clip\\.', 400))
check('unplayable-webm exit deletes',
  exit('Uploaded file is not a playable video clip\\.', 400))
check('all three index/store failures delete instead of orphaning',
  [...owned.matchAll(/discardAndFail\(\s*'Failed to save visualizer'\s*,\s*500/g)].length === 3)

// 4. The deliberate exception: an object we could not REACH is not a
//    proven-bad object, and fx/upload.ts retries the claim. 503s must keep the
//    bytes. This is a guard against "fixing" the leak too enthusiastically.
check('no 503 exit deletes the object (unreachable ≠ bad)',
  !/discardAndFail\([^)]*503/.test(owned))
// Three unreachable/unmeasurable exits: the mp4 Range probe, the webm size
// probe, and the webm download.
check('every unreachable-object exit keeps the bytes and its retry hint',
  [...owned.matchAll(/retryLater\(\s*'Could not verify the upload[^']*'\s*,\s*'10'/g)].length === 3)
check('the busy-transcoder 503 keeps the bytes for the client retry',
  /retryLater\(\s*'Server is busy converting another visualizer[^']*'\s*,\s*'20'/.test(owned))

// 5. Rate-limit credits: a request that performed no lasting work must give
//    its credit back, or the client's own 503 retry loop locks the user out.
check('the retry helper refunds the rate-limit credit',
  /const retryLater[\s\S]{0,900}?vizSaveLimiter\.rollback\(userId\)/.test(owned))

// …except on the ONE 503 that fires after real work. The busy-encoder rejection
// happens only once the webm has been measured, downloaded into memory and
// demuxed; refunding it would leave the route's most expensive path free, and
// fx/upload.ts auto-retries 503s — so a client could hold repeated 48 MB
// allocations in the shared container with the limiter never advancing.
check('the busy-encoder 503 keeps its credit because the work was already done',
  /retryLater\(\s*\n?\s*'Server is busy[^']*'\s*,\s*\n?\s*'20'\s*,\s*\n?\s*\{\s*refund:\s*false/.test(owned))
check('…and the unreachable/unmeasurable 503s still refund',
  [...owned.matchAll(/retryLater\(\s*'Could not verify the upload[^']*'\s*,\s*'10'\s*\)/g)].length === 3)
check('server-fault 500s refund the credit too',
  /discardAndFail\(\s*'Failed to save visualizer'\s*,\s*500\s*,\s*\{\s*refund:\s*true/.test(owned))

// 6. webm lane ordering — the two defects that only source order can express.
const iWebm = owned.indexOf('// webm:')
const webmLane = iWebm === -1 ? '' : owned.slice(iWebm)
const iSize = webmLane.indexOf('totalBytesFromHeaders')
// The call itself, not the prose about it — the lane's comment names
// `.download()` too.
const iDownload = webmLane.indexOf('.download(storagePath)')
const iProbe = webmLane.indexOf('clipRejectionReason')
const iSlot = webmLane.indexOf('tryAcquireTranscodeSlot')
check('webm lane MEASURES the object before downloading it',
  iSize !== -1 && iDownload !== -1 && iSize < iDownload, `size@${iSize} download@${iDownload}`)
check('webm lane validates content before taking a transcode slot',
  iProbe !== -1 && iSlot !== -1 && iProbe < iSlot, `probe@${iProbe} slot@${iSlot}`)
check('webm lane rejects an unmeasurable object rather than downloading it blind',
  /webmTotalBytes === null/.test(webmLane))

// 7. mp4 lane: an unmeasurable object is retryable, never a silent pass.
const iMp4 = owned.indexOf("parsed.ext === 'mp4'")
const mp4Lane = iMp4 === -1 ? '' : owned.slice(iMp4, owned.indexOf('// webm:'))
check('mp4 lane uses the shared header parser', /totalBytesFromHeaders\(res\.headers\)/.test(mp4Lane))
check('mp4 lane refuses to proceed on an unknown size', /measuredBytes === null/.test(mp4Lane))
check('mp4 lane no longer back-fills the size from the bytes it happened to read',
  iMp4 !== -1 && !/if \(!totalBytes\) totalBytes = got/.test(mp4Lane))

// 8. Both lanes share one content check — the webm lane must not re-invent a
//    weaker one, and must not demand avc (webm is vp8/vp9 by construction).
check('both lanes run the shared clip probe',
  [...owned.matchAll(/clipRejectionReason\(/g)].length === 2)
check('mp4 lane probes as the mp4 lane', /clipRejectionReason\([\s\S]{0,60}?'mp4'\)/.test(mp4Lane))
check('webm lane probes as the webm lane', /clipRejectionReason\([\s\S]{0,60}?'webm'\)/.test(webmLane))
check("webm lane does not require 'avc'", webmLane !== '' && !/'avc'/.test(webmLane))

// 9. A 0-byte object — the exact blob MediaRecorder produces when
//    'dataavailable' never fires — cannot satisfy a byte range and answers
//    416. Both lanes must read that as "empty, therefore unplayable" (delete +
//    400), not as "unreachable" (a 503 the client retries three times while
//    the empty object stays orphaned in the bucket).
check('mp4 lane treats a 416 as an empty, unplayable object',
  /res\.status === 416[\s\S]{0,400}?discardAndFail\(\s*'Uploaded file is not a playable H\.264 MP4 clip\.'\s*,\s*400/.test(mp4Lane))
check('webm lane treats a 416 as an empty, unplayable object',
  /res\.status === 416/.test(webmLane)
  && /webmIsEmpty[\s\S]{0,200}?discardAndFail\(\s*'Uploaded file is not a playable video clip\.'\s*,\s*400/.test(webmLane))

// ── FreeStudio client contract ──────────────────────────────────────────────
const studio = read('src/components/visualizer/FreeStudio.tsx')

check('FreeStudio keeps the server\'s transcoded flag instead of dropping it',
  /setFreeSaveTranscoded\(up\.transcoded\)/.test(studio))
check('the legacy multipart fallback reports the flag too',
  /setFreeSaveTranscoded\(\s*data\?\.transcoded !== false\s*\)/.test(studio))
check('a fresh render resets the flag optimistically',
  /setFreeSaveTranscoded\(true\)/.test(studio))
check('the saved label branches on it rather than always saying "Saved to Media"',
  /freeSaveTranscoded\s*$|freeSaveTranscoded\s*\?/m.test(studio)
  && /iPhone/.test(studio))

// recordFrames must stop the tracks captureStream() attached to the canvas —
// recorder.stop() does not, so a repeated-render session leaked one live
// capture track per render (normal path, cancel, and onerror alike).
const rec = studio.slice(studio.indexOf('async function recordFrames'), studio.indexOf('type Props'))
check('recordFrames stops its capture tracks on every exit',
  /\}\s*finally\s*\{[\s\S]*?stream\.getTracks\(\)[\s\S]{0,60}?\.stop\(\)/.test(rec))
check('recordFrames awaits the blob INSIDE the try so the finally cannot cut the recorder off',
  /return await blobReady/.test(rec))

console.log(failures === 0 ? '\nAll viz-finalize tests passed' : `\n${failures} viz-finalize test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
