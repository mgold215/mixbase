// ─── Auto-measure gate: is measuring THIS mix cheap enough to do unasked? ─────
//
// MasterCheck's "Measure loudness" button is an explicit request: the user taps
// it, sees "Measuring…", and accepts the wait. Measuring automatically after an
// upload has no such permission — nobody asked, nothing is on screen to explain
// a stalled page, and the tab has just finished handling a file. So the auto
// path is gated STRICTLY harder than the manual one, and this module holds the
// arithmetic behind that gate.
//
// WHAT THE AUTO PATH ACTUALLY BUYS. Not "a free measurement" — the measurement
// costs exactly what it always did. What it saves is the RE-DOWNLOAD: the manual
// path fetches the whole track back out of Supabase storage purely to measure
// it, while at the end of an upload the browser is still holding the local
// `File`. That is a whole track's worth of cellular data and latency removed.
// It is not a reason to treat the CPU or the memory as free.
//
// EXPLICITLY NOT REUSING analyzeFile's DECODE. `analyzeFile` (src/lib/
// audio-analysis.ts) decodes `file.slice(0, 4_000_000)` — roughly the first 25
// seconds — which is fine for BPM and key but is NOT the track's loudness. A
// mix with a quiet intro would measure quiet and then be displayed as an
// authoritative integrated LUFS. Auto-measure therefore does its own FULL
// decode, and pays the full price, and is gated accordingly.
//
// PURE ON PURPOSE. No DOM, no Web Audio, no fetch — every decision here is
// arithmetic over numbers the caller already has, so scripts/loudness-auto-test.mjs
// exercises the real gate rather than a copy of it. Relative imports carry their
// `.ts` extension for the same reason the rest of the loudness modules do:
// an extensionless one blocks Node's type-stripping.

/**
 * How long an unannounced main-thread block is allowed to last.
 *
 * `measureLoudness` is a straight-line loop over every sample — it blocks
 * whichever thread runs it, and it runs on the main one. (The decode does not:
 * `decodeAudioData` is asynchronous and does its work off-thread. The filtering
 * and gating afterwards are the freeze.)
 *
 * 750 ms is chosen against the standard interaction budget: past ~100 ms a page
 * feels laggy and past ~1 s the user believes something has broken. This block
 * lands after the upload UI has already said "Done!", so a sub-second hitch is
 * absorbed by a moment the user is not mid-gesture — but a multi-second freeze
 * with no explanation would be a WORSE bug than the missing number it bought.
 */
export const AUTO_MEASURE_BUDGET_MS = 750

/**
 * How much audio to time before committing to the whole thing.
 *
 * The alternative was a fixed duration cap ("auto-measure anything under N
 * minutes"), which requires guessing how slow the slowest phone is. Measured
 * against the real catalog that guess is unusually punishing: production mixes
 * run to a median of 4:28 and a p90 of 5:06, so a cap set for a slow phone
 * (~3:40) would have excluded about 90 % of the library, and a cap set for a
 * fast one would freeze the slow phone it was not chosen for.
 *
 * So the device is MEASURED rather than assumed: time a short prefix, scale by
 * the sample count, and let a fast machine measure long mixes while a slow one
 * declines early. The gate self-calibrates and no device multiplier is invented.
 *
 * 8 seconds specifically. The extrapolation must err toward SKIPPING, and it
 * does — a warm-up-dominated probe over-estimates the per-sample cost. Measured
 * against a 5-minute stereo 44.1 kHz mix (predicted ÷ actual): a 2 s probe
 * predicts 2.4×, a 4 s probe 2.1×, an 8 s probe 1.1–1.25×. All are safe; 8 s is
 * the first that is not so pessimistic it defeats the feature, and it costs
 * ~8 ms to run. Shorter probes are also fighting the clock: browsers coarsen
 * `performance.now()` (1 ms in Safari/Firefox without cross-origin isolation),
 * and an 8 ms probe is comfortably above that quantum where a 1.5 ms one is not.
 */
export const AUTO_MEASURE_PROBE_SECONDS = 8

/**
 * Refuse to even read the file into memory above this size.
 *
 * DERIVED, not picked: this only has to be loose enough to admit every file
 * that could still pass the decoded-memory gate downstream. That gate
 * (`canMeasureInBrowser`, 600 MB peak) gives out at ~7.4 minutes of 44.1 kHz
 * stereo, and the heaviest encoding a master realistically arrives in — 48 kHz
 * 32-bit float stereo, ~23 MB per minute — reaches only ~171 MB in 7.4 minutes.
 * 200 MB therefore rejects nothing the real gate would have accepted, while
 * capping the `arrayBuffer()` allocation so a 2 GB upload (the app's ceiling)
 * can never be pulled into memory by a background task nobody asked for.
 */
export const AUTO_MEASURE_MAX_FILE_BYTES = 200 * 1024 * 1024

/**
 * The two gates that can be answered BEFORE spending anything on a timing probe:
 * the file's byte size, and what the decoded signal will cost in memory.
 *
 * Composed here rather than inline at the call site because the interesting case
 * is the one neither gate catches alone. File bytes say very little about
 * decoded cost — a 40 MB FLAC and a 400 MB WAV of the same 6-minute mix decode
 * to exactly the same working set — so a compressed file sails through the byte
 * cap and must still be stopped by the memory ceiling. Keeping the conjunction
 * in one tested function is what stops a later edit from "simplifying" it down
 * to the byte check, which would look correct and silently admit anything lossy.
 *
 * `fileBytes` may be null/undefined when the size is unknown; unknown is treated
 * as TOO BIG, not as small. The gate this pattern replaced elsewhere in the app
 * read `size != null && size > limit`, so an unknown size fell open — and the
 * riskiest uploads were exactly the ones that skipped the check.
 */
export function canAttemptAutoMeasure(
  fileBytes: number | null | undefined,
  samplesPerChannel: number,
  channelCount: number,
  decodedFits: (samplesPerChannel: number, channelCount: number) => boolean,
): boolean {
  if (typeof fileBytes !== 'number' || !Number.isFinite(fileBytes)) return false
  if (fileBytes <= 0 || fileBytes > AUTO_MEASURE_MAX_FILE_BYTES) return false
  return decodedFits(samplesPerChannel, channelCount)
}

/**
 * Frames (samples per channel) to hand the timing probe.
 *
 * Clamped to the signal: a mix shorter than the probe window is simply measured
 * whole, and the ratio below collapses to 1 — no special case needed, the
 * arithmetic already says "this costs what it cost".
 */
export function autoMeasureProbeFrames(sampleRate: number, totalFrames: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return 0
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) return 0
  return Math.min(totalFrames, Math.round(AUTO_MEASURE_PROBE_SECONDS * sampleRate))
}

/**
 * Scale a probe's measured duration up to the whole signal.
 *
 * Channel count cancels — the probe covers every channel, so only the frame
 * ratio matters. Returns Infinity for any input that cannot support an honest
 * estimate, so an unusable probe fails the gate below instead of sneaking past
 * it as a suspiciously cheap zero.
 */
export function extrapolateMeasureMs(probeMs: number, probeFrames: number, totalFrames: number): number {
  if (!Number.isFinite(probeMs) || probeMs <= 0) return Infinity
  if (!Number.isFinite(probeFrames) || probeFrames <= 0) return Infinity
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) return Infinity
  return probeMs * (totalFrames / probeFrames)
}

/**
 * The gate: on THIS device, would measuring the whole signal fit the budget?
 *
 * A probe that returned 0 ms (a clock too coarse to have timed it, or a
 * stopwatch bug) is treated as unknown and refused — the auto path's failure
 * mode must be "no number", never "a frozen page".
 */
export function fitsAutoMeasureBudget(
  probeMs: number,
  probeFrames: number,
  totalFrames: number,
  budgetMs: number = AUTO_MEASURE_BUDGET_MS,
): boolean {
  return extrapolateMeasureMs(probeMs, probeFrames, totalFrames) <= budgetMs
}
