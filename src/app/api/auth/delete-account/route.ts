import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import * as Sentry from '@sentry/nextjs'
import { supabaseAdmin } from '@/lib/supabase'
import { webmOriginalPath } from '@/lib/visualizer-encode'

// Pull the storage object path out of a Supabase public URL for a given bucket.
function storagePathFromUrl(url: string | null | undefined, bucket: string): string | null {
  if (!url) return null
  const marker = `/storage/v1/object/public/${bucket}/`
  const idx = url.indexOf(marker)
  return idx !== -1 ? url.slice(idx + marker.length) : null
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
  let audioPaths: string[] = []

  if (projectIds.length > 0) {
    const { data: versions } = await supabaseAdmin
      .from('mb_versions')
      .select('id, audio_url')
      .in('project_id', projectIds)

    versionIds = (versions ?? []).map(v => v.id)

    // Extract storage paths from audio URLs for deletion
    // URL format: https://<project>.supabase.co/storage/v1/object/public/mf-audio/<path>
    const marker = '/storage/v1/object/public/mf-audio/'
    audioPaths = (versions ?? [])
      .map(v => {
        const idx = v.audio_url?.indexOf(marker) ?? -1
        return idx !== -1 ? v.audio_url.slice(idx + marker.length) : null
      })
      .filter((p): p is string => !!p)
  }

  // Both the generated source artwork and the finalized (text lockup) render live
  // in mf-artwork — collect both so neither is orphaned.
  const artworkPaths = (projects ?? [])
    .flatMap(p => [
      storagePathFromUrl(p.artwork_url, 'mf-artwork'),
      storagePathFromUrl(p.finalized_artwork_url, 'mf-artwork'),
    ])
    .filter((p): p is string => !!p)

  // Visualizers (free canvas + AI + finished YouTube/Shorts) are keyed by
  // user_id and stored in mf-video. They were previously never cleaned up,
  // leaving orphaned rows and bytes after a GDPR delete.
  const { data: visualizers } = await supabaseAdmin
    .from('mb_visualizers')
    .select('id, video_url')
    .eq('user_id', userId)
  // Include the pre-conversion WebM for any row the WebM→MP4 heal repointed:
  // the row's video_url is now the MP4 twin, so deriving paths from it alone
  // leaves the original bytes behind — orphaned, and still publicly readable.
  const videoPaths = (visualizers ?? [])
    .flatMap(v => {
      const mp4 = storagePathFromUrl(v.video_url, 'mf-video')
      return mp4 ? [mp4, webmOriginalPath(mp4)] : []
    })
    .filter((p): p is string => !!p)

  // Delete storage objects. A storage failure must NOT trap the user in an
  // undeletable account, so we log loudly (for a later orphan sweep) and press
  // on — DB-row deletion below is what actually gates the irreversible step.
  if (audioPaths.length > 0) {
    const { error } = await supabaseAdmin.storage.from('mf-audio').remove(audioPaths)
    if (error) {
      console.error('[delete-account] mf-audio cleanup failed for', userId, error.message)
      // Surface orphaned-object candidates to Sentry so a future sweep can find them.
      Sentry.captureMessage('delete-account: mf-audio cleanup failed', {
        level: 'warning',
        extra: { userId, objectCount: audioPaths.length, error: error.message },
      })
    }
  }
  if (artworkPaths.length > 0) {
    const { error } = await supabaseAdmin.storage.from('mf-artwork').remove(artworkPaths)
    if (error) {
      console.error('[delete-account] mf-artwork cleanup failed for', userId, error.message)
      Sentry.captureMessage('delete-account: mf-artwork cleanup failed', {
        level: 'warning',
        extra: { userId, objectCount: artworkPaths.length, error: error.message },
      })
    }
  }
  if (videoPaths.length > 0) {
    const { error } = await supabaseAdmin.storage.from('mf-video').remove(videoPaths)
    if (error) {
      console.error('[delete-account] mf-video cleanup failed for', userId, error.message)
      Sentry.captureMessage('delete-account: mf-video cleanup failed', {
        level: 'warning',
        extra: { userId, objectCount: videoPaths.length, error: error.message },
      })
    }
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
