import * as Sentry from '@sentry/nextjs'
import { supabaseAdmin } from '@/lib/supabase'
import { isMissingVisualizerColumn } from '@/lib/schema-heal'
import { VIDEO_BUCKET, videoStoragePath } from '@/lib/visualizer-store'
import { webmToMp4, mp4TwinPath } from '@/lib/visualizer-encode'

// WebM visualizers play in every browser <video>, but iOS AVPlayer cannot
// decode WebM at all — the native app's canvas layer just renders nothing.
// So visualizers are normalized to H.264 MP4, the one format that plays in
// browsers, AVPlayer, AND the finalize-video pipeline:
//  - webmToMp4() converts a fresh browser-recorded blob at save time
//  - healWebmVisualizers() converts everything already in mf-video at boot,
//    rewriting library rows and project pins to the MP4 twin
//
// The ffmpeg half lives in visualizer-encode.ts so it can be imported by
// scripts/visualizer-transcode-test.mjs without pulling in Supabase.

export { webmToMp4, mp4TwinPath }

// visualizer_wide_url arrived in migration 020; selecting a missing column
// fails the whole PostgREST query, so fall back without it (same two-step the
// other visualizer_url readers use).
//
// Test specifically for the missing-column error rather than ANY error: a
// transient network/PostgREST blip would otherwise silently downgrade this boot
// to vertical-only and skip every wide pin, with nothing in the log to say so.
async function projectsWithWebmPins(): Promise<{ withWide: boolean }> {
  const probe = await supabaseAdmin.from('mb_projects').select('id, visualizer_wide_url').limit(1)
  if (!probe.error) return { withWide: true }
  if (isMissingVisualizerColumn(probe.error)) return { withWide: false }
  console.error('[viz-heal] wide-pin probe failed (not a missing column):', probe.error.message)
  return { withWide: false }
}

// Ceiling for one boot's sweep. Measured: 22 conversions in 54s on prod, so 10
// minutes is ~10x the observed worst case while still guaranteeing the heal
// can't compete with live traffic indefinitely on a large backlog.
const HEAL_BUDGET_MS = 10 * 60 * 1000

let healRunning = false

/**
 * One-shot boot heal: find every WebM visualizer still referenced by the
 * library (mb_visualizers.video_url) or a project pin (visualizer_url /
 * visualizer_wide_url), transcode each to an MP4 twin in mf-video, and repoint
 * the rows. Originals are left in storage as a rollback path. Sequential on
 * purpose — one ffmpeg at a time keeps boot CPU/memory flat. Idempotent: once
 * rows point at MP4s, later boots find nothing to do.
 */
export async function healWebmVisualizers(): Promise<void> {
  if (healRunning) return
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return
  healRunning = true
  try {
    const urls = new Set<string>()

    const { data: vizRows, error: vizErr } = await supabaseAdmin
      .from('mb_visualizers')
      .select('video_url')
      .like('video_url', '%.webm')
    if (vizErr) {
      console.error('[viz-heal] library scan failed:', vizErr.message)
    }
    for (const r of vizRows ?? []) if (r.video_url) urls.add(r.video_url)

    const { withWide } = await projectsWithWebmPins()
    const pinFilter = withWide
      ? 'visualizer_url.like.%.webm,visualizer_wide_url.like.%.webm'
      : 'visualizer_url.like.%.webm'
    const { data: pinRows, error: pinErr } = await supabaseAdmin
      .from('mb_projects')
      .select(withWide ? 'visualizer_url, visualizer_wide_url' : 'visualizer_url')
      .or(pinFilter)
    if (pinErr) {
      console.error('[viz-heal] pin scan failed:', pinErr.message)
    }
    for (const r of (pinRows ?? []) as { visualizer_url?: string | null; visualizer_wide_url?: string | null }[]) {
      if (r.visualizer_url?.endsWith('.webm')) urls.add(r.visualizer_url)
      if (r.visualizer_wide_url?.endsWith('.webm')) urls.add(r.visualizer_wide_url)
    }

    if (urls.size === 0) return
    console.log(`[viz-heal] ${urls.size} WebM visualizer(s) to convert for iOS playback`)

    let converted = 0
    let failed = 0
    // Wall-clock ceiling for the whole sweep. The per-file timeout bounds one
    // encode; nothing bounded the loop, which scales linearly with row count
    // and clip length while competing with live traffic and any in-flight
    // render. Stopping early is safe: the heal is idempotent, so the next boot
    // picks up exactly where this one left off.
    const deadline = Date.now() + HEAL_BUDGET_MS
    for (const url of urls) {
      if (Date.now() > deadline) {
        console.log(`[viz-heal] budget reached — ${converted}/${urls.size} done, rest resumes next boot`)
        break
      }
      try {
        const path = videoStoragePath(url)
        if (!path) continue

        const { data: blob, error: dlErr } = await supabaseAdmin.storage.from(VIDEO_BUCKET).download(path)
        if (dlErr || !blob) {
          failed++
          console.error(`[viz-heal] download failed for ${path}:`, dlErr?.message)
          continue
        }

        const mp4 = await webmToMp4(Buffer.from(await blob.arrayBuffer()))
        const outPath = mp4TwinPath(path)
        const { error: upErr } = await supabaseAdmin.storage
          .from(VIDEO_BUCKET)
          .upload(outPath, mp4, { contentType: 'video/mp4', upsert: true })
        if (upErr) {
          failed++
          console.error(`[viz-heal] upload failed for ${outPath}:`, upErr.message)
          continue
        }
        const mp4Url = supabaseAdmin.storage.from(VIDEO_BUCKET).getPublicUrl(outPath).data.publicUrl

        // Repoint every reference to this exact WebM URL. Check each write:
        // counting a conversion whose repoint silently failed produced a log
        // reading "22/22 converted" while a row still pointed at WebM — the
        // bytes were converted but nothing used them.
        const repoints = [
          await supabaseAdmin.from('mb_visualizers').update({ video_url: mp4Url }).eq('video_url', url),
          await supabaseAdmin.from('mb_projects').update({ visualizer_url: mp4Url }).eq('visualizer_url', url),
          ...(withWide
            ? [await supabaseAdmin.from('mb_projects').update({ visualizer_wide_url: mp4Url }).eq('visualizer_wide_url', url)]
            : []),
        ]
        const repointErr = repoints.find(r => r.error)?.error
        if (repointErr) {
          // The MP4 is uploaded and the twin path is deterministic, so the next
          // boot retries this exact row rather than re-converting blindly.
          failed++
          console.error(`[viz-heal] repoint failed for ${url}:`, repointErr.message)
          continue
        }
        converted++
      } catch (err) {
        failed++
        console.error(`[viz-heal] convert failed for ${url}:`, err instanceof Error ? err.message : err)
      }
    }
    console.log(`[viz-heal] done — ${converted}/${urls.size} converted, ${failed} failed`)
    // A visualizer that stays WebM is invisible on iOS and nothing else reports
    // it — the heal only retries on the NEXT deploy, so a persistent failure
    // could sit unnoticed indefinitely.
    if (failed > 0) {
      Sentry.captureMessage(`viz-heal: ${failed} visualizer(s) failed WebM→MP4 conversion`, {
        level: 'warning',
        tags: { area: 'visualizer-transcode', phase: 'boot-heal' },
        extra: { total: urls.size, converted, failed },
      })
    }
  } finally {
    healRunning = false
  }
}
