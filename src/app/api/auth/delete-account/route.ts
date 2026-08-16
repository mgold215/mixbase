import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import * as Sentry from '@sentry/nextjs'
import { supabaseAdmin } from '@/lib/supabase'
import { removeStorageObjects } from '@/lib/storage-remove'
import {
  AUDIO_BUCKET,
  ARTWORK_BUCKET,
  VIDEO_BUCKET,
  collectAssetKeys,
  type VersionAssetRow,
  type VisualizerAssetRow,
} from '@/lib/project-assets'

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
    const { data } = await supabaseAdmin
      .from('mb_versions')
      .select('id, audio_url')
      .in('project_id', projectIds)

    versionIds = (data ?? []).map(v => v.id)
    versions = (data ?? []) as VersionAssetRow[]
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
  const { data: visualizers } = await supabaseAdmin
    .from('mb_visualizers')
    .select('id, video_url, source_image_url')
    .eq('user_id', userId)

  // One shared derivation for both delete paths (src/lib/project-assets.ts):
  // source + finalized artwork, audio, visualizer videos AND the pre-conversion
  // WebM twin the MP4 heal leaves behind, all deduped per bucket. Anything this
  // route derived by hand instead was free to drift from the project-delete
  // path — and did: source_image_url was missed entirely here.
  const assetKeys = collectAssetKeys({
    projects: (projects ?? []),
    versions,
    visualizers: (visualizers ?? []) as VisualizerAssetRow[],
  })

  // Delete storage objects. A storage failure must NOT trap the user in an
  // undeletable account, so we log loudly (for a later orphan sweep) and press
  // on — DB-row deletion below is what actually gates the irreversible step.
  //
  // Removal is VERIFIED per key, not inferred from the absence of an error. A
  // storage delete that RLS refuses returns 200 with `[]`, so the previous
  // `if (error)` check was unreachable: this route reported a clean GDPR wipe
  // while every byte stayed in a PUBLIC bucket, and the Sentry warnings that
  // were supposed to feed a later sweep never fired once. Unconfirmed keys are
  // now reported individually so a sweep has something to act on.
  for (const bucket of [AUDIO_BUCKET, ARTWORK_BUCKET, VIDEO_BUCKET] as const) {
    const paths = assetKeys[bucket]
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
