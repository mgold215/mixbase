// /api/visualizer/save contract test — the LEGACY multipart lane.
//
// Run: node scripts/viz-save-test.mjs
//
// On 2026-08-14 the signed-URL lane (/api/visualizer/finalize) got real content
// validation: it probes the uploaded media with mediabunny and refuses to index
// a 0-byte or structurally-broken MediaRecorder blob. This route — the multipart
// entry point the browser still falls back to — did NOT get the same treatment.
// It accepted any Blob under the 10 MB cap, stored it, and answered `saved:true`.
//
// The two lanes are not independent: FreeStudio.saveRendered tries the signed
// lane FIRST and falls back here on any VizUploadError for a webm under 9.5 MB.
// So the hardened lane rejecting a 0-byte blob with a 400 handed that exact blob
// straight to the weak door, which stored it and told the user "Saved to Media"
// with a live pin button. Closing one lane without the other made the bug
// harder to see, not rarer.
//
// Layers, matching scripts/viz-finalize-test.mjs:
//   A) The REAL shared validator (src/lib/visualizer-finalize.ts under Node type
//      stripping) on the canonical 0-byte case, plus a fail-first witness that
//      reconstructs this route's old size-only gate.
//   B) A live mediabunny probe of an actually-empty buffer — proof the rejection
//      is reachable at runtime, not just expressible.
//   C) A source contract over the route: the ORDER of validation vs. the
//      irreversible steps, and the refund decision on every failure exit.
//
// Pure — no DB, no network. Every check is written so that deleting the guard
// it describes turns it red.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  MIN_CLIP_SECONDS,
  clipRejectionReason,
} from '../src/lib/visualizer-finalize.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── A) The shared validator on this lane's canonical failure ────────────────
// A browser MediaRecorder hands back an EMPTY Blob when 'dataavailable' never
// fires. That blob demuxes to no video track and an unreadable duration.

check('a 0-byte MediaRecorder blob is rejected as a webm',
  clipRejectionReason({ codec: null, duration: NaN }, 'webm') === 'no video track')
check('…and as an mp4',
  clipRejectionReason({ codec: null, duration: NaN }, 'mp4') === 'no video track')
check('a real browser webm loop still passes (vp8/vp9, no avc demand)',
  clipRejectionReason({ codec: 'vp9', duration: 6 }, 'webm') === null
  && clipRejectionReason({ codec: 'vp8', duration: MIN_CLIP_SECONDS }, 'webm') === null)
check('a truncated clip too short for finalize-video is rejected',
  clipRejectionReason({ codec: 'vp9', duration: 0.1 }, 'webm') === 'duration 0.1')

// Fail-first witness: the ONLY content gate this route shipped with was
// `file.size > 10 MB`. Reconstructed verbatim in spirit — it cannot tell a
// recorded loop from an empty blob, because it never looks at the bytes.
{
  const legacySaveAccepts = (sizeBytes) => !(sizeBytes > 10 * 1024 * 1024)
  check('witness: the old save gate accepted a 0-byte blob', legacySaveAccepts(0) === true)
  check('witness: …and 12 bytes of junk', legacySaveAccepts(12) === true)
  check('witness: it only ever rejected on SIZE', legacySaveAccepts(11 * 1024 * 1024) === false)
  check('the shared validator rejects what the size gate waved through',
    clipRejectionReason({ codec: null, duration: NaN }, 'webm') !== null)
}

// ── B) The rejection is reachable at runtime ────────────────────────────────
// Source contracts prove the guard is wired in the right place; this proves the
// guard actually fires on the real thing. An empty buffer is not a container,
// so the demux throws — and that throw IS the rejection both routes rely on.
{
  const { Input, BufferSource, ALL_FORMATS } = await import('mediabunny')
  const probe = async (bytes) => {
    const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS })
    const track = await input.getPrimaryVideoTrack()
    return { codec: track?.codec ?? null, duration: await input.computeDuration() }
  }
  let empty = null
  let threw = false
  try {
    empty = await probe(new Uint8Array(0))
  } catch {
    threw = true
  }
  check('mediabunny refuses an empty buffer (throw, or a probe with no track)',
    threw || clipRejectionReason(empty, 'webm') !== null,
    threw ? 'threw' : JSON.stringify(empty))

  let junkRejected = false
  try {
    const p = await probe(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]))
    junkRejected = clipRejectionReason(p, 'webm') !== null
  } catch {
    junkRejected = true
  }
  check('…and a short run of junk bytes', junkRejected)
}

// ── C) Route source contract ────────────────────────────────────────────────

const route = read('src/app/api/visualizer/save/route.ts')
const finalize = read('src/app/api/visualizer/finalize/route.ts')

// 1. One validator, shared. Two validators drift apart, and then one lane is
//    quietly weaker than the other — which is the bug this file exists for.
check('route imports the SHARED validator rather than rolling its own',
  /import\s*\{[^}]*clipRejectionReason[^}]*\}\s*from\s*'@\/lib\/visualizer-finalize'/s.test(route))
check('route runs the shared clip probe exactly once',
  [...route.matchAll(/clipRejectionReason\(/g)].length === 1,
  `${[...route.matchAll(/clipRejectionReason\(/g)].length} call(s)`)
check('route does not re-implement the codec rule inline',
  !/['"]avc['"]/.test(route))
check('route does not re-implement the duration rule inline',
  !/MIN_CLIP_SECONDS|duration\s*[<>]/.test(route))

// The demux adapter is duplicated between the two routes only because a Next
// route module may not export helpers. It must stay BYTE-identical until it is
// lifted into a lib — a silent divergence here reintroduces the weak lane.
const probeBody = (src) => {
  const i = src.indexOf('async function probeClip(')
  if (i === -1) return null
  const end = src.indexOf('\n}\n', i)
  return end === -1 ? null : src.slice(i, end + 2).replace(/\s+/g, ' ').trim()
}
const saveProbe = probeBody(route)
const finalizeProbe = probeBody(finalize)
check('route has a probeClip demux adapter', saveProbe !== null)
check('finalize still has one to compare against', finalizeProbe !== null)
check('the two lanes demux with IDENTICAL code (no drift)',
  saveProbe !== null && saveProbe === finalizeProbe)
check('the probe reads the primary video track and the container duration',
  !!saveProbe && /getPrimaryVideoTrack\(\)/.test(saveProbe) && /computeDuration\(\)/.test(saveProbe))
check('the probe uses mediabunny (pure JS — no ffprobe binary to trace on Railway)',
  !!saveProbe && /import\('mediabunny'\)/.test(saveProbe))

// 2. ORDER. Validation must precede everything expensive or irreversible:
//    the ownership gate first (never do work for a project the caller does not
//    own), then the size cap (it bounds what we demux), then the probe, and
//    only then the encoder slot and the write to storage.
const at = (needle) => route.indexOf(needle)
const iOwns = at('userOwnsProject(')
const iSize = at('file.size >')
const iProbe = at('clipRejectionReason(')
const iSlot = at('tryAcquireTranscodeSlot(')
const iTranscode = at('webmToMp4(')
const iStore = at('storeVisualizer({')

check('validation runs AFTER the ownership gate',
  iOwns !== -1 && iProbe !== -1 && iOwns < iProbe, `owns@${iOwns} probe@${iProbe}`)
check('validation runs AFTER the size cap that bounds what it demuxes',
  iSize !== -1 && iProbe !== -1 && iSize < iProbe, `size@${iSize} probe@${iProbe}`)
check('validation runs BEFORE a transcode slot is taken (junk never occupies an encoder)',
  iProbe !== -1 && iSlot !== -1 && iProbe < iSlot, `probe@${iProbe} slot@${iSlot}`)
check('validation runs BEFORE the transcode itself',
  iProbe !== -1 && iTranscode !== -1 && iProbe < iTranscode, `probe@${iProbe} transcode@${iTranscode}`)
check('validation runs BEFORE any byte reaches the bucket',
  iProbe !== -1 && iStore !== -1 && iProbe < iStore, `probe@${iProbe} store@${iStore}`)

// 3. The rejection itself: a definitively bad clip is a permanent 400, not a
//    503 the client would retry. Same message the finalize webm lane uses, so
//    the two doors answer a user the same way.
check('an unplayable clip is rejected with a 400',
  /clipRejectionReason\([\s\S]{0,600}?NextResponse\.json\(\s*\{\s*error:\s*'Uploaded file is not a playable video clip\.'\s*\}\s*,\s*\{\s*status:\s*400/.test(route))
check('the rejection is reported to Sentry (console.error alone is invisible here)',
  /Sentry\.captureException\([\s\S]{0,200}?area:\s*'visualizer-save'[\s\S]{0,80}?phase:\s*'validate'/.test(route))
check('the webm lane probes as a webm (it must NOT demand avc of a browser recording)',
  /clipRejectionReason\([\s\S]{0,80}?,\s*probeExt\)/.test(route)
  && /probeExt[\s\S]{0,120}?includes\('webm'\)\s*\?\s*'webm'\s*:\s*'mp4'/.test(route))

// 4. NO ORPHANED BYTES. This lane never writes to storage itself — the single
//    write is storeVisualizer(), which already removes the object when the row
//    insert fails. That is the whole no-orphan argument, so lock it: the moment
//    this route starts uploading on its own, the argument stops holding and
//    every failure exit below it needs its own cleanup.
check('route performs no storage write of its own (storeVisualizer owns the only one)',
  !/supabaseAdmin/.test(route) && !/\.storage\b/.test(route))
check('the single storage write is the LAST thing before the success response',
  iStore !== -1 && route.indexOf('saved: true') > iStore)

// 5. Rate-limit credits. The rule from the finalize audit: refund only when the
//    failure is OURS and no real work was performed. Refunding an expensive
//    path lets a client loop it for free.
const rollbacks = [...route.matchAll(/vizSaveLimiter\.rollback\(/g)].length
check('the server-fault 500 refunds the credit (the save the user paid for never happened)',
  /vizSaveLimiter\.rollback\(userId\)[\s\S]{0,240}?'Failed to save visualizer'[\s\S]{0,80}?status:\s*500/.test(route)
  || /'Failed to save visualizer'[\s\S]{0,240}?vizSaveLimiter\.rollback\(userId\)/.test(route))
check('nothing else refunds — exactly one rollback site', rollbacks === 1, `${rollbacks} site(s)`)
check('the content rejection does NOT refund (demuxing a 10 MB body is real work)',
  !/clipRejectionReason\([\s\S]{0,700}?vizSaveLimiter\.rollback/.test(route))
check('the busy-encoder 503 does NOT refund (it fires after the body was received)',
  !/tryAcquireTranscodeSlot\(\)[\s\S]{0,400}?vizSaveLimiter\.rollback/.test(route))

// 6. The rate-limit check stays FIRST in this lane — a deliberate divergence
//    from finalize, where ownership precedes it. Here the expensive thing is
//    RECEIVING the body: req.formData() buffers the whole multipart payload
//    before any field can be read, so moving the limiter after it would let a
//    signed-in client stream unbounded 10 MB bodies at the box uncapped.
const iLimit = at('checkUserLimit(vizSaveLimiter')
// The CALL, not the prose about it — the exit-table comment names formData too.
const iForm = at('await req.formData()')
check('the per-user cap is charged before the body is buffered',
  iLimit !== -1 && iForm !== -1 && iLimit < iForm, `limit@${iLimit} form@${iForm}`)

// 7. The transcode fallback must not become a back door. Storing the WebM when
//    ffmpeg fails is deliberate (web plays it; the boot heal retries) — but it
//    is only safe because the bytes were PROVEN to be a real clip first.
check('the transcode failure still falls back to storing the webm',
  /transcoded = false/.test(route))
check('…and that fallback now sits downstream of the content probe',
  iProbe !== -1 && route.indexOf('transcoded = false') > iProbe)

// ── D) Why this lane still matters: the client's fallback ───────────────────
// If nothing called this route the answer would be "delete it". FreeStudio
// does, and specifically for the blob shape the hardened lane just rejected.
const studio = read('src/components/visualizer/FreeStudio.tsx')
check('FreeStudio is the caller: it POSTs the multipart save',
  /fetch\('\/api\/visualizer\/save',\s*\{\s*method:\s*'POST'/.test(studio))
check('it reaches this lane only after the signed lane FAILED',
  /catch[\s\S]{0,400}?legacyEligible[\s\S]{0,300}?VizUploadError/.test(studio))
check('a 0-byte webm is legacy-eligible — the rejected blob really does arrive here',
  /contentType === 'video\/webm'/.test(studio) && /blob\.size <= 9\.5 \* 1024 \* 1024/.test(studio))

console.log(failures === 0 ? '\nAll viz-save tests passed' : `\n${failures} viz-save test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
