import * as Sentry from '@sentry/nextjs'
import { supabaseAdmin } from '@/lib/supabase'
import { isMissingVisualizerColumn } from '@/lib/schema-heal'
import { VIDEO_BUCKET, videoStoragePath } from '@/lib/visualizer-store'
import { removeStorageObjects } from '@/lib/storage-remove'
import { webmOriginalPath } from '@/lib/visualizer-encode'
import {
  REAP_MIN_AGE_MS,
  listVideoObjects,
  planReap,
  type StorageEntry,
} from '@/lib/video-orphan-plan'

// Boot sweep for mf-video objects that no mb_visualizers row will ever claim.
//
// WHY THIS EXISTS
// The full-resolution save path is: /api/upload-url signs a key → the browser
// PUTs the bytes DIRECTLY to the PUBLIC mf-video bucket (they never traverse
// Railway; see upload-audio-architecture) → the browser POSTs a small JSON
// claim to /api/visualizer/finalize, and only that claim writes the row.
//
// /api/visualizer/finalize closes every SERVER-side way that sequence can leave
// bytes behind: each of its failure exits either deletes the object or is a 503
// the client retries, and the claim reports keys it signed but abandoned
// mid-upload so they are swept too. What it cannot close is the case where the
// claim is never sent at all — the tab is closed, the browser crashes, the
// network dies between the PUT and the POST. Those bytes are then permanently
// invisible: nothing lists them in Media, DELETE /api/visualizer/[id] derives
// its storage key from a row's video_url so it cannot name them, and
// /api/auth/delete-account starts from rows too — which makes this a
// data-deletion (GDPR) hole, not merely a quota one.
//
// Nothing inside a request can fix that, because the request that would have
// fixed it is the one that never arrived. Hence a sweeper.
//
// SAFETY MODEL — the only interesting property here is "never delete a live
// video", and every rule below exists to serve it:
//   1. Age. Only objects older than REAP_MIN_AGE_MS (24 h) are candidates, so
//      an upload whose claim is merely slow — or frozen in a suspended mobile
//      tab — is never in scope.
//   2. Shape. Only `<projectId>/viz-<stamp>.<ext>` keys (VIZ_KEY_RE, the same
//      shape /api/upload-url will sign) are ever considered.
//   3. Reference. The referenced-key set is derived with videoStoragePath() and
//      webmOriginalPath() — the EXACT pair DELETE /api/visualizer/[id] and
//      /api/auth/delete-account use. This file must never grow its own URL
//      parser: two derivations that disagree is precisely how a reaper deletes
//      live videos.
//   4. Fail closed. Any listing page that errors, any reference query that
//      errors, any pager that hits its page cap — the whole sweep aborts and
//      deletes NOTHING. Acting on incomplete knowledge is worse than not
//      sweeping at all.
//   5. Re-check. Each candidate is confirmed unreferenced one more time,
//      immediately before it is deleted, by the same query
//      /api/visualizer/finalize's removeIfUnreferenced runs. The bulk set makes
//      the sweep cheap; this makes a bug in the bulk set survivable.
//   6. Verified removal. Deletion counts come from the keys storage ECHOES
//      BACK, never from the batch we asked it to delete. `remove()` answers 200
//      with an empty list and no error when the caller's role matches no DELETE
//      policy on storage.objects — the exact failure that let these orphans
//      pile up unnoticed while every cleanup path logged success. A sweeper
//      that reports "removed 32" while the bucket never shrinks is worse than
//      no sweeper, because it also retires the suspicion.

// Rows per page when reading the reference set out of Postgres, and the ceiling
// on pages — same "a pager that never advances must fail, not spin" rule the
// storage walk uses.
const REF_PAGE_SIZE = 1000
const REF_MAX_PAGES = 200

// Most deletes one boot will perform. A first run against a bucket that has
// been leaking for months should not turn into an unbounded delete loop
// competing with live traffic; the sweep is idempotent, so the remainder goes
// on the next boot.
const REAP_MAX_DELETES = 500

// Objects per storage remove() call.
const REMOVE_BATCH = 100

let reapRunning = false

/**
 * Add the storage keys one stored URL accounts for.
 *
 * Derivation is deliberately not local to this file: videoStoragePath() turns a
 * row's public video_url into a key, and webmOriginalPath() names the
 * pre-conversion WebM the boot transcode heal leaves in place as a rollback
 * path — the same two functions DELETE /api/visualizer/[id] passes to
 * storage.remove(). If this set were built any other way, the two could drift
 * and the sweep would delete bytes a live row depends on.
 */
function addReferenced(keys: Set<string>, url: string | null | undefined) {
  if (!url) return
  const path = videoStoragePath(url)
  if (!path) return
  keys.add(path)
  const original = webmOriginalPath(path)
  if (original) keys.add(original)
}

/**
 * Every mf-video storage key that something still points at.
 *
 * Returns null when ANY query failed or a pager ran past its cap, which the
 * caller reads as "abort the sweep".
 */
async function referencedVideoKeys(): Promise<Set<string> | null> {
  const keys = new Set<string>()

  let done = false
  for (let page = 0; page < REF_MAX_PAGES && !done; page++) {
    const from = page * REF_PAGE_SIZE
    const { data, error } = await supabaseAdmin
      .from('mb_visualizers')
      .select('video_url')
      .order('id', { ascending: true })
      .range(from, from + REF_PAGE_SIZE - 1)
    if (error) {
      console.error('[viz-reap] library scan failed:', error.message)
      return null
    }
    for (const row of data ?? []) addReferenced(keys, row.video_url as string | null)
    done = (data?.length ?? 0) < REF_PAGE_SIZE
  }
  if (!done) {
    console.error(`[viz-reap] library scan exceeded ${REF_MAX_PAGES} pages — aborting`)
    return null
  }

  return (await addProjectPins(keys)) ? keys : null
}

/**
 * Fold project pins into the referenced set. Belt-and-braces: PATCH
 * /api/projects/[id] only accepts a pin whose URL already has an
 * mb_visualizers row, so the library scan should already cover every pin. It is
 * one extra query, and it means a drift in that invariant costs storage rather
 * than a user's pinned loop.
 *
 * Returns false when a query failed for any reason other than the pin columns
 * being absent (pre-015/020 schemas have no pins to protect).
 */
async function addProjectPins(keys: Set<string>): Promise<boolean> {
  // Same two-step probe healWebmVisualizers uses: PostgREST rejects the WHOLE
  // select when one referenced column is missing, and visualizer_wide_url
  // (migration 020) can be absent while visualizer_url (015) is present.
  const probe = await supabaseAdmin.from('mb_projects').select('visualizer_wide_url').limit(1)
  if (probe.error && !isMissingVisualizerColumn(probe.error)) {
    console.error('[viz-reap] pin probe failed (not a missing column):', probe.error.message)
    return false
  }
  const withWide = !probe.error
  const columns = withWide ? 'visualizer_url, visualizer_wide_url' : 'visualizer_url'

  for (let page = 0; page < REF_MAX_PAGES; page++) {
    const from = page * REF_PAGE_SIZE
    const { data, error } = await supabaseAdmin
      .from('mb_projects')
      .select(columns)
      .order('id', { ascending: true })
      .range(from, from + REF_PAGE_SIZE - 1)
    if (error) {
      // No pin columns at all — nothing to protect, and nothing wrong.
      if (!withWide && isMissingVisualizerColumn(error)) return true
      console.error('[viz-reap] pin scan failed:', error.message)
      return false
    }
    const rows = (data ?? []) as unknown as {
      visualizer_url?: string | null
      visualizer_wide_url?: string | null
    }[]
    for (const row of rows) {
      addReferenced(keys, row.visualizer_url)
      addReferenced(keys, row.visualizer_wide_url)
    }
    if (rows.length < REF_PAGE_SIZE) return true
  }
  console.error(`[viz-reap] pin scan exceeded ${REF_MAX_PAGES} pages — aborting`)
  return false
}

/**
 * True when NOTHING in mb_visualizers points at this exact key — the same
 * question /api/visualizer/finalize's removeIfUnreferenced asks before it
 * deletes an object. A failed query answers false: on an unanswered question
 * the object stays.
 */
async function confirmUnreferenced(key: string): Promise<boolean> {
  const { data: keyPub } = supabaseAdmin.storage.from(VIDEO_BUCKET).getPublicUrl(key)
  const { data, error } = await supabaseAdmin
    .from('mb_visualizers')
    .select('id')
    .eq('video_url', keyPub.publicUrl)
    .limit(1)
    .maybeSingle()
  return !error && !data
}

/**
 * One-shot boot sweep: delete mf-video objects older than REAP_MIN_AGE_MS that
 * no mb_visualizers row and no project pin references. Idempotent — a boot that
 * finds nothing abandoned does three queries and stops.
 *
 * Never throws, and never deletes on incomplete knowledge.
 *
 * Modes, via VIDEO_ORPHAN_REAPER:
 *   unset / 'dry-run' — DEFAULT. Does every scan and logs exactly what it WOULD
 *                       remove, without removing anything.
 *   'on'              — actually deletes.
 *   'off'             — skips the sweep entirely.
 *
 * DELETION IS OPT-IN ON PURPOSE. This code has never run against real Supabase
 * storage: two of its assumptions (that `list()` marks folder placeholders with
 * `id === null`, and that a removed object's `name` echoes the full key rather
 * than the basename) are read from type declarations, not observed. Railway
 * boots the new build the moment the PR merges, so a live-by-default sweep
 * would make its first-ever execution an unattended destructive one against
 * production. The costs are wildly asymmetric — a leaked object costs storage
 * until the next boot; a wrongly reaped one destroys a render the user believes
 * is saved — so the default is the harmless half. Read one boot's "would
 * remove" list, then set VIDEO_ORPHAN_REAPER=on.
 */
export async function reapOrphanVideos(): Promise<void> {
  if (reapRunning) return
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return
  const mode = process.env.VIDEO_ORPHAN_REAPER ?? ''
  if (mode === 'off') return
  const dryRun = mode !== 'on'

  reapRunning = true
  try {
    // Listing first, references second: the reference set is then the FRESHER
    // of the two, so a row written while the walk was in progress still
    // protects its object.
    const listPage = async (prefix: string, offset: number, limit: number): Promise<StorageEntry[] | null> => {
      const { data, error } = await supabaseAdmin.storage
        .from(VIDEO_BUCKET)
        .list(prefix, { limit, offset, sortBy: { column: 'name', order: 'asc' } })
      if (error || !data) {
        console.error('[viz-reap] list failed:', error?.message ?? 'no data')
        return null
      }
      return data as StorageEntry[]
    }

    const objects = await listVideoObjects(listPage)
    if (objects === null) {
      console.error('[viz-reap] listing incomplete — nothing deleted')
      return
    }

    const referenced = await referencedVideoKeys()
    if (referenced === null) {
      console.error('[viz-reap] reference scan incomplete — nothing deleted')
      return
    }

    const plan = planReap(objects, referenced, Date.now())
    if (plan.reap.length === 0) {
      console.log(
        `[viz-reap] ${plan.scanned} object(s), none abandoned ` +
        `(${plan.keptReferenced} referenced, ${plan.keptRecent} recent, ` +
        `${plan.keptUnknownAge} undated, ${plan.keptForeignShape} not viz keys)`,
      )
      return
    }

    const capped = plan.reap.length > REAP_MAX_DELETES
    const candidates = capped ? plan.reap.slice(0, REAP_MAX_DELETES) : plan.reap
    console.log(
      `[viz-reap] ${candidates.length} abandoned object(s) older than ` +
      `${REAP_MIN_AGE_MS / 3_600_000}h out of ${plan.scanned} scanned` +
      (capped ? ` (capped at ${REAP_MAX_DELETES}; rest resumes next boot)` : ''),
    )

    // Per-key confirmation immediately before the delete. The bulk set narrows
    // the work; this is what makes a mistake in the bulk set survivable, and it
    // closes the window between reading the references and acting on them.
    const doomed: string[] = []
    for (const key of candidates) {
      if (await confirmUnreferenced(key)) doomed.push(key)
      else console.log(`[viz-reap] keeping ${key} — a row claimed it after the scan`)
    }

    if (dryRun) {
      console.log(`[viz-reap] dry-run — would remove ${doomed.length} object(s): ${doomed.join(', ')}`)
      return
    }

    // COUNT ONLY CONFIRMED REMOVALS, never the batch that was asked for.
    //
    // A remove refused by storage RLS is not an error: the policy matches no
    // rows and the API answers 200 with `[]`. A reaper that did
    // `removed += batch.length` on a non-error would print "removed 32" every
    // boot forever while the bucket never shrank — a sweeper that reports
    // success and deletes nothing is worse than no sweeper, because it also
    // retires the suspicion that anything is wrong. removeStorageObjects()
    // returns the keys storage confirmed, and everything else as `unconfirmed`.
    let removed = 0
    let unconfirmed = 0
    for (let i = 0; i < doomed.length; i += REMOVE_BATCH) {
      const batch = doomed.slice(i, i + REMOVE_BATCH)
      const outcome = await removeStorageObjects(VIDEO_BUCKET, batch)
      removed += outcome.removed.length
      unconfirmed += outcome.unconfirmed.length
      for (const key of outcome.removed) console.log(`[viz-reap] removed ${key}`)
      for (const key of outcome.unconfirmed) console.error(`[viz-reap] NOT confirmed removed: ${key}`)
      if (outcome.error) console.error('[viz-reap] remove failed:', outcome.error)
      // Not one key confirmed in a whole batch: that is the signature of a
      // systemic permission failure, not bad luck on individual keys. Stop —
      // the remaining batches would fail identically and only add noise.
      if (outcome.removed.length === 0) {
        console.error(
          '[viz-reap] aborting sweep — storage confirmed NOTHING removed; ' +
          'check that the admin client still has service_role',
        )
        break
      }
    }
    console.log(`[viz-reap] done — ${removed} confirmed removed, ${unconfirmed} unconfirmed`)

    // An orphan is a user's video that never became visible to them, or bytes
    // that survived an account deletion. A steady trickle here is a signal that
    // the claim path is failing for real users, so it is worth a breadcrumb
    // rather than living only in a deploy log nobody reads. `unconfirmed > 0`
    // is the louder case: the sweep identified abandoned bytes and could not
    // prove it removed them, which means the app cannot honour a deletion
    // request either.
    Sentry.captureMessage(
      `viz-reap: confirmed removal of ${removed} of ${doomed.length} orphaned mf-video object(s)`,
      {
        level: unconfirmed > 0 ? 'warning' : 'info',
        tags: { area: 'visualizer-storage', phase: 'boot-reap' },
        extra: { scanned: plan.scanned, candidates: doomed.length, removed, unconfirmed, capped },
      },
    )
  } catch (err) {
    // A sweep is never worth an unhandled rejection at boot.
    console.error('[viz-reap] sweep aborted:', err instanceof Error ? err.message : err)
  } finally {
    reapRunning = false
  }
}
