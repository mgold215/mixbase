// Pure half of the mf-video orphan sweep — the listing walk and the
// keep/delete decision, with every storage and database call injected. Kept
// DOM/IO-free (relative, extension-full imports only) so
// scripts/video-orphan-reaper-test.mjs can drive the real algorithm in Node,
// including the failure paths that matter most: a listing that errors halfway
// through, and a pager that never terminates.
//
// src/lib/video-orphan-reaper.ts holds the Supabase half.

// The shape filter below is the SAME regex /api/upload-url signs against and
// /api/visualizer/finalize claims against, and that is load-bearing in one
// direction only: every key the app can write must be inside it, because a key
// outside it is kept forever (keptForeignShape) with no other cleanup path in
// the codebase. The converse — widening it so the sweep recognizes more — is the
// dangerous direction, since recognizing a shape is what makes it deletable.
//
// So when the app grew a key it could write but not recognize (the mp4 twin of a
// long-stamped webm claim, whose derived basename overran the regex's 64-char
// stamp budget), the fix went into the GATE — VIZ_WEBM_STAMP_MAX bounds a webm
// claim so its twin still fits — and this regex was left exactly as it was.
// Keep it that way: prove any future key shape fits this filter, rather than
// stretching the filter to fit the key.
import { VIZ_KEY_RE } from './visualizer-finalize.ts'

// How old an object must be before it can be considered abandoned.
//
// The gap this has to clear is: /api/upload-url signs a key → the browser PUTs
// the bytes straight to Supabase → the browser POSTs the claim to
// /api/visualizer/finalize. Only the claim writes the mb_visualizers row, so
// between the PUT landing and the claim arriving the object is legitimately
// unreferenced. Bounding that gap:
//   * a Supabase signed upload URL is valid for 2 hours, so a PUT cannot even
//     begin later than that;
//   * a 200 MB 4K export (the MAX_FINALIZE_BYTES ceiling) on a 1 Mbps uplink is
//     ~27 min, and fx/upload.ts allows one full re-PUT on a network failure, so
//     ~55 min of uploading;
//   * the claim's own retry loop is bounded at three attempts ~30 s apart.
// That puts the honest worst case a bit over an hour. The case that actually
// argues for more is a phone: iOS suspends a backgrounded tab, so the claim
// can be frozen between the PUT and the fetch and only fire when the user comes
// back to it — plausibly the next morning.
//
// 24 hours covers the overnight-tab case and is ~24x the transfer-bound worst
// case. It is deliberately lopsided: a leaked object costs storage until the
// next boot sweeps it, while a wrongly reaped object destroys a finished render
// the user believes is saved. Raising this is cheap; lowering it is not.
export const REAP_MIN_AGE_MS = 24 * 60 * 60 * 1000

// One page of a Supabase storage listing. `list()` returns a bounded page and
// marks sub-prefixes ("folders") by handing back a row whose id is null.
export type StorageEntry = { name: string; id: string | null; created_at: string | null }

// Read one page of `prefix`. Resolves null on ANY failure — the caller turns
// that into "abort the whole sweep", because a partial listing cannot tell an
// absent object from an unlisted one.
export type ListPage = (prefix: string, offset: number, limit: number) => Promise<StorageEntry[] | null>

// An object found in the bucket: its full key and its creation timestamp as the
// storage API reported it (null when the API didn't say).
export type ReapCandidate = { key: string; createdAt: string | null }

export type ReapPlan = {
  reap: string[]
  scanned: number
  keptReferenced: number
  keptRecent: number
  keptUnknownAge: number
  keptForeignShape: number
}

// Objects per listing page. Supabase's list() defaults to 100; asking for 1000
// keeps a few-thousand-object bucket to a handful of round trips.
export const REAP_PAGE_SIZE = 1000

// Hard ceiling on pages per prefix. This is the "don't loop forever" guard: a
// storage API that ignores `offset` (or a mistake in the offset arithmetic)
// would otherwise hand back the same page indefinitely. Hitting the cap is
// treated as a failed listing, not as the end of the data — under-reaping is
// free, deleting on a listing we know is incomplete is not.
export const REAP_MAX_PAGES = 200

// Walk one prefix to exhaustion. Returns null if any page failed or the page
// cap was reached.
async function pageThrough(listPage: ListPage, prefix: string): Promise<StorageEntry[] | null> {
  const rows: StorageEntry[] = []
  for (let page = 0; page < REAP_MAX_PAGES; page++) {
    const batch = await listPage(prefix, page * REAP_PAGE_SIZE, REAP_PAGE_SIZE)
    if (batch === null) return null
    rows.push(...batch)
    // A short page is the last page. A server that ignores `limit` and returns
    // more just costs another iteration; a server that ignores `offset` runs
    // into REAP_MAX_PAGES above and fails the sweep, which is the safe end.
    if (batch.length < REAP_PAGE_SIZE) return rows
  }
  return null
}

/**
 * Every object in the bucket, as `<prefix>/<name>` keys.
 *
 * mf-video keys are exactly one level deep (`<projectId>/viz-<stamp>.<ext>` —
 * see VIZ_KEY_RE), so this lists the root, then each folder it finds. Returns
 * null if ANY page of ANY prefix failed: the caller must delete nothing rather
 * than act on a listing that may be missing rows.
 */
export async function listVideoObjects(listPage: ListPage): Promise<ReapCandidate[] | null> {
  const roots = await pageThrough(listPage, '')
  if (roots === null) return null

  const found: ReapCandidate[] = []
  for (const entry of roots) {
    // id !== null is a real object sitting at the bucket root. No viz key has
    // that shape, so it is left alone (and counted as foreign by planReap only
    // if it somehow reaches there — it can't, since it has no prefix).
    if (entry.id !== null) continue
    const objects = await pageThrough(listPage, entry.name)
    if (objects === null) return null
    for (const object of objects) {
      if (object.id === null) continue // a nested folder; viz keys are never nested
      found.push({ key: `${entry.name}/${object.name}`, createdAt: object.created_at })
    }
  }
  return found
}

/**
 * Decide what may be deleted. Four independent reasons to KEEP an object, each
 * counted so the log says why the sweep did nothing:
 *
 *  - foreign shape: not a `<projectId>/viz-<stamp>.<ext>` key, so not something
 *    this app writes (`.emptyFolderPlaceholder`, anything hand-uploaded).
 *  - referenced: some mb_visualizers row (or project pin) points at it.
 *  - recent: younger than REAP_MIN_AGE_MS — its claim may still be coming.
 *  - unknown age: the listing carried no usable timestamp. Unknown is not old;
 *    the same rule /api/visualizer/finalize applies to an unmeasurable object.
 */
export function planReap(
  objects: ReapCandidate[],
  referencedKeys: ReadonlySet<string>,
  nowMs: number,
): ReapPlan {
  const plan: ReapPlan = {
    reap: [],
    scanned: objects.length,
    keptReferenced: 0,
    keptRecent: 0,
    keptUnknownAge: 0,
    keptForeignShape: 0,
  }
  for (const object of objects) {
    if (!VIZ_KEY_RE.test(object.key)) { plan.keptForeignShape++; continue }
    if (referencedKeys.has(object.key)) { plan.keptReferenced++; continue }
    const createdMs = object.createdAt === null ? NaN : Date.parse(object.createdAt)
    // Written as !Number.isFinite so an unparseable timestamp keeps the object.
    if (!Number.isFinite(createdMs)) { plan.keptUnknownAge++; continue }
    if (nowMs - createdMs < REAP_MIN_AGE_MS) { plan.keptRecent++; continue }
    plan.reap.push(object.key)
  }
  return plan
}
