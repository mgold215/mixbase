// Bounded, length-aware planning for the survivor scan in
// DELETE /api/projects/[id].
//
// WHAT THE SCAN IS
// After a project row is deleted, the route asks "does any row that SURVIVED
// still point at one of this project's storage objects?" across seven
// (table, column) pairs. Anything still referenced is subtracted from the
// delete set, because a storage object can legitimately back two projects and
// removing a shared one destroys a LIVE project's media.
//
// WHY THIS MODULE EXISTS
// Both dimensions of how that question was asked were unbounded:
//
//   1. FAN-OUT. Every column × every chunk went into one array handed to
//      Promise.all, so a project at the route's own limit(1000) fired ~147
//      simultaneous PostgREST GETs. Any single rejection failed the whole scan,
//      and a failed scan skips storage cleanup ENTIRELY — so the feature did
//      nothing for exactly the large projects it matters most for, leaving one
//      console.error as the only trace.
//
//   2. REQUEST LENGTH. `.in(column, chunk)` travels in the query string, and
//      the chunk size was a flat 50 no matter how long the URLs were. Measured
//      against the real @supabase/postgrest-js with real production rows: 50 of
//      the mf-audio URLs that carry raw spaces and parentheses (110 such rows
//      today — "… - ALONE (moodmixformat REMIX) - MIX 2.1.wav") serialize to an
//      8,244-character URL / 8,217-byte request line. The usual nginx / Kong
//      `large_client_header_buffers` ceiling is 8,192, so that chunk is a 414
//      before it leaves the building. The plain machine-generated URLs reach
//      7,917 — 275 bytes of headroom. Neither needed 1,000 versions to break;
//      50 is enough, and the route already allows 1,000.
//
// PURE BY DESIGN: no imports, so scripts/survivor-scan-bound-test.mjs can load
// it under Node type stripping and drive it with a fake query function. The
// route keeps every Supabase call; only the planning lives here.

/**
 * How many survivor-scan queries may be in flight at once.
 *
 * Deliberately small. The pooler sees this on top of whatever else the request
 * is doing, and the scan is not latency-critical — the row is already gone and
 * the client is told `{ ok: true }` regardless of how storage goes. Six keeps
 * the common case (seven columns × one chunk, plus seven prefix queries = 14
 * queries) down to three waves.
 */
export const SCAN_CONCURRENCY = 6

/**
 * Budget, in ENCODED characters, for one `.in()` filter's value list.
 *
 * The ceiling being respected is the ~8,192-byte HTTP request line. The base
 * path, the `select=` parameter and the `in.(…)` wrapper cost about 100
 * characters together, so 4,000 leaves better than 2× headroom. Generous on
 * purpose: an extra round trip is cheap, while the failure it prevents — a 414
 * that silently cancels all storage cleanup — is not.
 */
export const CHUNK_ENCODED_BUDGET = 4000

/**
 * Hard cap on values per chunk, independent of length. Keeps behaviour for
 * short URLs no worse than the flat-50 chunking this replaced, and bounds the
 * IN list PostgREST has to parse.
 */
export const CHUNK_MAX_VALUES = 50

/**
 * Encoded cost of the comma that joins two values: `%2C`, not `,`.
 *
 * This is the detail that made the old flat-50 chunking wrong by more than it
 * looked. postgrest-js appends the joined list through `url.searchParams`, so
 * the separators are percent-encoded along with everything else.
 */
const SEPARATOR_COST = 3

/**
 * What one value costs, in encoded characters, inside an `.in()` filter —
 * including the separator that follows it.
 *
 * Mirrors @supabase/postgrest-js's PostgrestFilterBuilder.in(): a value matching
 * /[,()]/ is wrapped in double quotes, values are joined with commas, and the
 * result is appended via `url.searchParams`, which serializes as
 * application/x-www-form-urlencoded (space becomes `+`, not `%20`).
 *
 * Verified against that library: a 129-character plain audio URL costs 152, and
 * a 127-character one with spaces and parentheses costs 158 — the parentheses
 * add 12 for 2 raw characters, because they cost 2 each AND trip the quoting
 * that adds two `%22`.
 *
 * The separator is charged on every value including a chunk's last, so the
 * estimate errs high. Overestimating only makes chunks smaller; underestimating
 * is what puts a request over the wire limit.
 */
export function encodedFilterCost(value: string): number {
  const quoted = /[,()]/.test(value) ? `"${value}"` : value
  // `v=` is 2 characters of the serialized pair; the remainder is the value.
  return new URLSearchParams([['v', quoted]]).toString().length - 2 + SEPARATOR_COST
}

/**
 * Split `urls` into chunks that each fit the request-line budget.
 *
 * SAFETY — every input URL lands in exactly one chunk. A dropped URL is not a
 * cheaper query: it is a reference the scan never asks about, and an
 * unasked-about reference reads as "nothing points at this object", which is
 * precisely how a shared object gets deleted. So a URL longer than the entire
 * budget still gets a chunk of its own rather than being skipped — nothing here
 * can shorten it, and failing loudly at the transport is far better than
 * silently omitting it from the question.
 */
export function chunkByEncodedLength(
  urls: readonly string[],
  budget: number = CHUNK_ENCODED_BUDGET,
  maxValues: number = CHUNK_MAX_VALUES,
): string[][] {
  const chunks: string[][] = []
  let current: string[] = []
  let cost = 0

  for (const url of urls) {
    const urlCost = encodedFilterCost(url)
    // The `current.length > 0` guard is what guarantees progress: an oversized
    // lone URL cannot open an infinite loop and cannot be discarded.
    if (current.length > 0 && (current.length >= maxValues || cost + urlCost > budget)) {
      chunks.push(current)
      current = []
      cost = 0
    }
    current.push(url)
    cost += urlCost
  }

  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * Run `tasks` with at most `limit` in flight, preserving result order.
 *
 * Tasks MUST NOT reject. The survivor scan's `run()` turns every failure —
 * including a thrown transport fault — into a recorded outcome, because a
 * rejection here would abandon the remaining workers mid-flight and leave the
 * scan's bookkeeping half-written, which is the one state that cannot be
 * distinguished from "nothing references these objects".
 */
export async function runBounded<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit: number = SCAN_CONCURRENCY,
): Promise<T[]> {
  const results = new Array<T>(tasks.length)
  let next = 0

  const workers = Math.max(1, Math.min(limit, tasks.length))
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const i = next++
      if (i >= tasks.length) return
      results[i] = await tasks[i]()
    }
  }))

  return results
}

/**
 * Synthetic rows that make every one of `urls` look like a surviving reference.
 *
 * Used when a chunk of the scan could not be answered: the safe reading of "we
 * do not know" is "something still points at this", so those URLs are folded
 * into the survivor set and their objects are left alone.
 *
 * Each URL is offered as an audio, an artwork AND a video field on purpose.
 * storagePathFromUrl matches at most one bucket per URL, so the extra fields
 * cost nothing and cannot mis-file a key — and routing them back through the
 * SHARED collectAssetKeys (rather than parsing keys here) is what keeps this
 * agreeing with the real derivation, including the WebM twin an mf-video URL
 * implies. Two places that derive keys differently is the bug class that
 * project-assets.ts exists to prevent.
 */
export function assumedSurvivorRows(urls: readonly string[]): {
  versions: { audio_url: string }[]
  projects: { artwork_url: string }[]
  visualizers: { video_url: string }[]
} {
  return {
    versions: urls.map(u => ({ audio_url: u })),
    projects: urls.map(u => ({ artwork_url: u })),
    visualizers: urls.map(u => ({ video_url: u })),
  }
}
