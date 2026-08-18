import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import * as Sentry from '@sentry/nextjs'
import { supabaseAdmin } from '@/lib/supabase'
import { isMissingVisualizerColumn } from '@/lib/schema-heal'
import { removeStorageObjects } from '@/lib/storage-remove'
import {
  AUDIO_BUCKET,
  ARTWORK_BUCKET,
  VIDEO_BUCKET,
  collectAllRows,
  collectAssetKeys,
  collectAssetUrls,
  filterToOwnedPrefixes,
  keysSafeToDelete,
  scanSurvivingKeys,
  totalKeyCount,
  type AssetKeys,
  type AssetUrlSelect,
  type VersionAssetRow,
  type VisualizerAssetRow,
} from '@/lib/project-assets'

// Named rather than inlined into the signature — see the same type in
// src/app/api/projects/[id]/route.ts.
type RowQuery = PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>

/**
 * Await one page of a PostgREST enumeration, mapping any failure to null.
 *
 * Null and `[]` must stay distinguishable: collectAllRows() stops on an empty
 * page and gives up on a null one, so collapsing an error into `[]` here would
 * end the enumeration early and pass the truncated result off as complete.
 */
async function fetchRowPage<T>(query: RowQuery, label: string): Promise<T[] | null> {
  const { data, error } = await query
  if (error) {
    console.error(`[delete-account] enumerating ${label} failed: ${error.message}`)
    return null
  }
  return (data ?? []) as T[]
}

// POST /api/auth/delete-account — permanently delete user and all their data
// Deletes storage files first (GDPR), then DB rows, then the auth user.
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // Cancel any active Stripe subscription FIRST — once profiles is deleted the
  // stripe_subscription_id is gone and the webhook can never reconcile, so a
  // deleted account would keep getting billed. Cancellation must never block the
  // deletion: log and continue on any error, and treat an already-cancelled sub
  // (resource_missing) as success.
  const { data: billing } = await supabaseAdmin
    .from('profiles')
    .select('stripe_subscription_id')
    .eq('id', userId)
    .single()
  const subscriptionId = billing?.stripe_subscription_id
  if (subscriptionId && process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
      await stripe.subscriptions.cancel(subscriptionId)
    } catch (err) {
      const code = (err as { code?: string })?.code
      if (code !== 'resource_missing') {
        console.error('[delete-account] Stripe cancel failed for', userId, err instanceof Error ? err.message : err)
        Sentry.captureMessage('delete-account: Stripe subscription cancel failed', {
          level: 'warning',
          extra: { userId, subscriptionId, error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
  }

  // Gather projects (with both artwork URLs) and version IDs before deleting
  // anything. Folding the URLs into this select avoids a second full scan.
  const { data: projects } = await supabaseAdmin
    .from('mb_projects')
    .select('id, artwork_url, finalized_artwork_url')
    .eq('user_id', userId)

  const projectIds = (projects ?? []).map(p => p.id)

  let versionIds: string[] = []
  let versions: VersionAssetRow[] = []

  if (projectIds.length > 0) {
    // PAGED. This select carried no `.limit()` at all, which is not "unbounded"
    // — it silently inherits PostgREST's server-side `max-rows` ceiling, and a
    // truncation you cannot see in the code is worse than one you can. It is
    // also the REACHABLE instance of that bug: this fans out over every project
    // a user owns, and the largest account today holds 271 versions against a
    // per-project maximum of 20. Rows past the cut would have their audio left
    // in a PUBLIC bucket after a GDPR erasure, in the one bucket with no sweeper.
    const rows = await collectAllRows<{ id: string; audio_url: string | null }>(
      (offset, limit) => fetchRowPage(
        supabaseAdmin.from('mb_versions').select('id, audio_url').in('project_id', projectIds)
          .order('id', { ascending: true }).range(offset, offset + limit - 1),
        `versions for ${userId}`,
      ))
    if (rows === null) {
      // Logged, NOT fatal. Checked against the live schema (2026-08-18) before
      // choosing this: every dependent of mb_versions that matters here —
      // mb_feedback, mb_feed_comments, mb_collab_requests — is ON DELETE
      // CASCADE, and the mb_versions delete below is keyed by project rather
      // than by this list, so the account still empties completely and no PII
      // survives. What an incomplete read costs is only the byte cleanup for the
      // rows it could not see. Blocking a GDPR erasure over a leak is the wrong
      // trade and the wrong direction: this route must never trap a user in an
      // undeletable account, so storage trouble is logged for a sweep, never
      // returned. Same call the project-delete path makes.
      console.error(
        `[delete-account] could not enumerate versions for ${userId} — their audio will not be ` +
        `cleaned up and needs a sweep. Row deletion continues.`,
      )
      Sentry.captureMessage('delete-account: version enumeration incomplete, audio may be orphaned', {
        level: 'warning',
        extra: { userId, projectCount: projectIds.length },
      })
    }
    versionIds = (rows ?? []).map(v => v.id)
    versions = (rows ?? []) as VersionAssetRow[]
  }

  // Visualizers (free canvas + AI + finished YouTube/Shorts) are keyed by
  // user_id and stored in mf-video. They were previously never cleaned up,
  // leaving orphaned rows and bytes after a GDPR delete.
  //
  // Selected by user_id, NOT by project — that is deliberately broader than
  // DELETE /api/projects/[id]'s project-scoped lookup, because project_id is
  // nullable and a row without one would otherwise be missed here. Row
  // SELECTION is what legitimately differs between the two delete paths; the
  // URL→key derivation below must not.
  //
  // Paged for the same reason as the versions enumeration above: no `.limit()`
  // is not "no ceiling", it is PostgREST's own `max-rows` applied invisibly.
  // Unlike versions this list feeds ONLY the byte cleanup — the row delete below
  // is keyed by user_id — so an incomplete read is logged and the deletion
  // proceeds rather than blocking the user's erasure over a leak.
  const visualizers = await collectAllRows<VisualizerAssetRow>((offset, limit) => fetchRowPage(
    supabaseAdmin.from('mb_visualizers').select('id, video_url, source_image_url').eq('user_id', userId)
      .order('id', { ascending: true }).range(offset, offset + limit - 1),
    `visualizers for ${userId}`,
  ))
  if (visualizers === null) {
    console.error(
      `[delete-account] could not enumerate visualizers for ${userId} — their video and source-image ` +
      `bytes will not be cleaned up and need a sweep.`,
    )
  }

  // One shared derivation for both delete paths (src/lib/project-assets.ts):
  // source + finalized artwork, audio, visualizer videos AND the pre-conversion
  // WebM twin the MP4 heal leaves behind, all deduped per bucket. Anything this
  // route derived by hand instead was free to drift from the project-delete
  // path — and did: source_image_url was missed entirely here.
  const assetRows = {
    projects: (projects ?? []),
    versions,
    visualizers: visualizers ?? [],
  }
  const collected = collectAssetKeys(assetRows)
  const candidateUrls = collectAssetUrls(assetRows)

  // FILTER 1 (pure, cannot fail): a candidate whose key attributes itself to a
  // project this user does not own is not ours to delete.
  //
  // Storage objects are NOT privately owned by the row that names them.
  // isSupabaseStorageUrl() — the only guard on PATCH /api/projects/[id]'s
  // artwork_url and POST /api/visualizer/finalize's sourceImageUrl — checks the
  // protocol and hostname and nothing else, so a crafted request can make one
  // of THIS user's rows point at ANOTHER user's live artwork. Without this
  // filter, deleting the crafting account destroys the victim's cover and
  // leaves a 404 on their live project.
  //
  // Only keys that name a project id in their first segment are judged here.
  // Bucket-root keys carry no owner at all (116 of 390 mf-audio objects, of
  // which only 5 are the iOS `<UUID>-v<n>-<ts>.wav` shape — the rest are plain
  // filenames like `HALFWAY - MIX 1.wav`), so demanding a prefix would refuse
  // to erase a user's OWN audio and defeat the GDPR wipe in the one bucket with
  // no sweeper. Those fall through to the reference check below instead.
  const assetKeys = filterToOwnedPrefixes(collected, projectIds)
  const foreign = totalKeyCount(collected) - totalKeyCount(assetKeys)
  if (foreign > 0) {
    // Not fatal, but it means rows of this user named objects under someone
    // else's project prefix — worth seeing, since nothing legitimate does that.
    console.warn(
      `[delete-account] ${foreign} candidate object(s) for ${userId} sit under a project prefix this ` +
      `user does not own — left in place rather than deleting another account's media.`,
    )
  }

  // Delete DB rows in dependency order, capturing every error. If ANY row
  // deletion fails we abort before auth.admin.deleteUser — otherwise the auth
  // user would be destroyed while PII rows keyed to that id linger as zombies.
  const dbErrors: string[] = []
  const del = async (p: PromiseLike<{ error: { message: string } | null }>, label: string) => {
    const { error } = await p
    if (error) dbErrors.push(`${label}: ${error.message}`)
  }

  if (versionIds.length > 0) {
    await del(supabaseAdmin.from('mb_feedback').delete().in('version_id', versionIds), 'mb_feedback')
  }
  if (projectIds.length > 0) {
    await del(supabaseAdmin.from('mb_activity').delete().in('project_id', projectIds), 'mb_activity')
    await del(supabaseAdmin.from('mb_versions').delete().in('project_id', projectIds), 'mb_versions')
  }
  // Visualizers are keyed by user_id (not project) — delete by owner.
  await del(supabaseAdmin.from('mb_visualizers').delete().eq('user_id', userId), 'mb_visualizers')

  const { data: collections } = await supabaseAdmin
    .from('mb_collections')
    .select('id')
    .eq('user_id', userId)
  const collectionIds = (collections ?? []).map(c => c.id)

  if (collectionIds.length > 0) {
    await del(supabaseAdmin.from('mb_collection_items').delete().in('collection_id', collectionIds), 'mb_collection_items')
  }

  await del(supabaseAdmin.from('mb_collections').delete().eq('user_id', userId), 'mb_collections')
  await del(supabaseAdmin.from('mb_releases').delete().eq('user_id', userId), 'mb_releases')
  await del(supabaseAdmin.from('mb_projects').delete().eq('user_id', userId), 'mb_projects')

  // Submitbase rows (migration 013) reference auth.users WITHOUT on delete
  // cascade, so leaving them makes auth.admin.deleteUser below fail with an FK
  // violation — the account becomes undeletable (a Guideline 5.1.1(v) bug, not
  // just a 500). Deleting the user's own curators leaves the shared starter
  // directory (user_id IS NULL) untouched.
  await del(supabaseAdmin.from('sb_submissions').delete().eq('user_id', userId), 'sb_submissions')
  await del(supabaseAdmin.from('sb_curators').delete().eq('user_id', userId), 'sb_curators')

  if (dbErrors.length > 0) {
    // Leave the account intact and retryable rather than half-deleting it.
    console.error('[delete-account] aborting before auth deletion for', userId, dbErrors)
    Sentry.captureMessage('delete-account: aborted before auth deletion (partial DB delete)', {
      level: 'error',
      extra: { userId, dbErrors },
    })
    return NextResponse.json(
      { error: 'Failed to delete account data — no changes were finalized. Please try again.' },
      { status: 500 }
    )
  }

  // Remove the bytes ONLY now, once every row of this user's is confirmed gone.
  //
  // The order is deliberate and must not be swapped back. Deleting bytes first
  // (as this route used to) means the abort branch above returns "no changes
  // were finalized" over an account whose every mix and cover has already been
  // destroyed — live rows pointing at 404s, unrecoverable. Doing it here makes
  // that message true, and it is what lets the survivor scan work at all: this
  // user's own rows are gone, so anything still naming a candidate object is by
  // definition a different, live owner. Same reasoning as the survivor scan in
  // DELETE /api/projects/[id]. A storage failure still must NOT trap the user in
  // an undeletable account, so it is logged for a later sweep, never returned.
  await removeAccountAssets(userId, assetKeys, candidateUrls)

  // Delete the auth user last (cascades to profiles via FK). Log + Sentry the
  // failure like every branch above — this was the one 500 path that returned
  // silently, which made a real deletion failure (e.g. an invalid service-role
  // key downgrading admin calls to anon) invisible in the logs.
  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId)
  if (error) {
    console.error('[delete-account] auth.admin.deleteUser failed for', userId, error.message)
    Sentry.captureMessage('delete-account: auth.admin.deleteUser failed', {
      level: 'error',
      extra: { userId, error: error.message },
    })
    return NextResponse.json({ error: 'Failed to delete account' }, { status: 500 })
  }

  const response = NextResponse.json({ ok: true })
  response.cookies.delete('sb-access-token')
  response.cookies.delete('sb-refresh-token')
  response.cookies.delete('sb-authed')
  response.cookies.delete('sb-expires-at')
  return response
}

// The pin columns are the only ones that can legitimately be absent (migrations
// 015 / 020). A missing column means there are no pins to protect, not a broken
// scan — everything else failing means we cannot trust the answer.
const OPTIONAL_SCAN_COLUMNS = new Set(['visualizer_url', 'visualizer_wide_url'])

/**
 * FILTER 2 (reference check): drop the user's storage objects, minus anything a
 * row that SURVIVED the account deletion still points at.
 *
 * This is the filter that covers the key shapes filterToOwnedPrefixes cannot
 * judge — above all the 116 bucket-root mf-audio objects, whose names carry no
 * project id at all. For those, "is anybody else still using this?" is the only
 * question that can be asked, and it has to be asked of the DB.
 */
async function removeAccountAssets(userId: string, candidates: AssetKeys, candidateUrls: string[]) {
  if (totalKeyCount(candidates) === 0) return

  const select: AssetUrlSelect = async (table, column, urls) => {
    const { data, error } = await supabaseAdmin.from(table).select(column).in(column, [...urls])
    if (error) {
      if (OPTIONAL_SCAN_COLUMNS.has(column) && isMissingVisualizerColumn(error)) return []
      console.error(`[delete-account] survivor scan failed on ${table}.${column}: ${error.message}`)
      return null
    }
    return data ?? []
  }

  const scan = await scanSurvivingKeys(select, candidateUrls)
  if (!scan) {
    // Without the scan we cannot prove a key is unshared, and deleting a shared
    // object destroys another account's live media — strictly worse than the
    // leak. Fail towards leaking bytes, and make the sweep visible.
    console.error(
      `[delete-account] survivor scan failed for ${userId} — skipping storage cleanup to avoid deleting ` +
      `objects another account still references. ${totalKeyCount(candidates)} object(s) may be orphaned.`,
    )
    Sentry.captureMessage('delete-account: survivor scan failed, storage cleanup skipped', {
      level: 'warning',
      extra: { userId, objectCount: totalKeyCount(candidates) },
    })
    return
  }

  // Same coverage-aware helper DELETE /api/projects/[id] uses. This path has no
  // prefix pass, so scanSurvivingKeys always reports coverage 'all' and the
  // helper reduces to the subtraction it always did — but routing through it is
  // what keeps the two delete paths deciding "may I delete this?" identically,
  // which is the whole reason project-assets.ts exists.
  const doomed = keysSafeToDelete(candidates, scan)

  // Removal is VERIFIED per key, not inferred from the absence of an error. A
  // storage delete that RLS refuses returns 200 with `[]`, so an `if (error)`
  // check would be unreachable: this route reported a clean GDPR wipe while
  // every byte stayed in a PUBLIC bucket, and the Sentry warnings that were
  // supposed to feed a later sweep never fired once. Unconfirmed keys are
  // reported individually so a sweep has something to act on.
  for (const bucket of [AUDIO_BUCKET, ARTWORK_BUCKET, VIDEO_BUCKET] as const) {
    const paths = doomed[bucket]
    if (paths.length === 0) continue
    const outcome = await removeStorageObjects(bucket, paths)
    if (outcome.ok) continue
    console.error(
      `[delete-account] ${bucket} cleanup incomplete for`, userId,
      `— removed ${outcome.removed.length}/${paths.length}`,
      outcome.error ?? '(no error reported; the delete was refused or the objects were already gone)',
    )
    Sentry.captureMessage(`delete-account: ${bucket} cleanup incomplete`, {
      level: 'warning',
      extra: {
        userId,
        objectCount: paths.length,
        removedCount: outcome.removed.length,
        unconfirmed: outcome.unconfirmed,
        error: outcome.error,
      },
    })
  }
}
