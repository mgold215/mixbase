// Reading a mix's length in the browser, at upload time.
//
// Dependency-free on purpose: scripts/audio-duration-test.mjs imports this
// directly, so the rules below are asserted as real behavior rather than being
// pattern-matched out of component source. Same reason version-defaults.ts and
// heal-errors.ts are import-free.

/** Give up on a probe that never fires an event at all. */
export const DURATION_PROBE_TIMEOUT_MS = 8000

/**
 * Turn whatever `HTMLMediaElement.duration` gave us into a value that is safe to
 * store, or null.
 *
 * `duration` is NaN before metadata parses and Infinity for a source whose
 * length the browser cannot determine. Both must become an explicit null:
 * `duration_seconds` is written ONCE and nothing in the app can correct it
 * later, so a stored lie is permanent. Today JSON.stringify happens to hide the
 * difference (neither NaN nor Infinity is representable in JSON, so both encode
 * to null) — which is exactly why it went unnoticed. Rounding FIRST and testing
 * the rounded value keeps that honest if this number ever travels any other way:
 * a query param, String(d), a display, a later read-back.
 */
export function normalizeDuration(raw: number): number | null {
  const seconds = Math.round(raw)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

/**
 * Duration in whole seconds for a file the user just picked, or null.
 *
 * PROBE THE LOCAL FILE, NOT THE UPLOADED URL.
 *
 * Both web upload paths used to measure by pointing an <audio> element at the
 * object they had just PUT to Supabase, read back through /api/audio. That made
 * a local, offline measurement depend on a network round trip that can lose
 * three different ways: the freshly written object may not read back
 * immediately, /api/audio forwards Content-Length only when Supabase sends one
 * (without it the browser reports Infinity for a source it cannot measure), and
 * a slow connection can simply miss the timeout below. Every one of those
 * resolves null and mints a permanently unmeasurable row.
 *
 * It showed up in production as a client split nobody expected. Historically the
 * nulls were iOS's (97.4% of flat-key rows), and a comment in ProjectClient
 * still blames iOS — but over the last 30 days 24 of 27 new nulls came from the
 * WEB uploader, because iOS probes its local temp file with AVURLAsset and web
 * did not. Reading the File the user already handed us removes the network from
 * the path entirely: it is instant, works offline, and a Blob always knows its
 * own length, so Infinity stops being reachable.
 *
 * Falling back to the remote URL would buy nothing — the same decoder that
 * cannot read the local blob cannot read the uploaded copy of it either.
 *
 * Best-effort by contract: returns null rather than throwing, because a mix
 * whose length could not be read must still upload.
 */
export async function readAudioDuration(
  file: Blob,
  timeoutMs: number = DURATION_PROBE_TIMEOUT_MS,
): Promise<number | null> {
  // Guard on BOTH halves. Node has URL.createObjectURL but no Audio, so
  // checking only the former passes the guard and then throws on construction —
  // which would turn a best-effort probe into a failed upload anywhere this
  // module is reached outside a browser (SSR, a test runner, a future worker).
  if (typeof Audio !== 'function') return null
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null

  const objectUrl = URL.createObjectURL(file)
  try {
    return await new Promise<number | null>((resolve) => {
      const audio = new Audio()
      let done = false
      // Revoke on the FIRST settle, not in a finally that a pending listener
      // could still outlive: an object URL kept alive pins the whole Blob in
      // memory, and these are audio masters.
      const settle = (value: number | null) => {
        if (done) return
        done = true
        clearTimeout(timer)
        audio.removeAttribute('src')
        resolve(value)
      }
      const timer = setTimeout(() => settle(null), timeoutMs)

      audio.addEventListener('loadedmetadata', () => settle(normalizeDuration(audio.duration)))
      audio.addEventListener('error', () => settle(null))
      // Metadata only — never pull the whole master through the decoder just to
      // read a number off its header.
      audio.preload = 'metadata'
      audio.src = objectUrl
    })
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
