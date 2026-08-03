import { spawn } from 'child_process'
import { mkdtemp, readFile, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { supabaseAdmin } from '@/lib/supabase'
import { VIDEO_BUCKET, videoStoragePath } from '@/lib/visualizer-store'

// WebM visualizers play in every browser <video>, but iOS AVPlayer cannot
// decode WebM at all — the native app's canvas layer just renders nothing.
// So visualizers are normalized to H.264 MP4, the one format that plays in
// browsers, AVPlayer, AND the finalize-video pipeline:
//  - webmToMp4() converts a fresh browser-recorded blob at save time
//  - healWebmVisualizers() converts everything already in mf-video at boot,
//    rewriting library rows and project pins to the MP4 twin

const FFMPEG = ffmpegInstaller.path

// A visualizer loop is seconds long and under 10 MB; a minute of wall clock is
// generous. SIGKILL, not SIGTERM — ffmpeg catches SIGTERM (see video-render.ts).
const TRANSCODE_TIMEOUT_MS = 60_000

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr?.on('data', d => { stderr += String(d); if (stderr.length > 20_000) stderr = stderr.slice(-10_000) })
    const timer = setTimeout(() => { proc.kill('SIGKILL') }, TRANSCODE_TIMEOUT_MS)
    proc.on('error', err => { clearTimeout(timer); reject(err) })
    proc.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`))
    })
  })
}

/** Transcode a WebM (VP8/VP9) visualizer loop to a silent H.264 MP4. */
export async function webmToMp4(webm: Buffer | Uint8Array): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'viz-transcode-'))
  const src = join(dir, 'in.webm')
  const out = join(dir, 'out.mp4')
  try {
    await writeFile(src, webm)
    await runFfmpeg([
      '-y', '-v', 'error',
      '-i', src,
      '-an',                          // visualizers are silent; the mix is the audio
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',          // baseline decodability on Apple hardware
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', // libx264 requires even dimensions
      '-crf', '20',
      '-preset', 'veryfast',
      '-movflags', '+faststart',      // moov up front so playback starts mid-download
      out,
    ])
    return await readFile(out)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// The MP4 twin lives beside the original: <path>.webm → <path>-h264.mp4.
// Deterministic, so re-running the heal after a partial failure converges
// (upload is upsert) instead of piling up duplicates.
function mp4TwinPath(webmPath: string): string {
  return webmPath.replace(/\.webm$/, '') + '-h264.mp4'
}

// visualizer_wide_url arrived in migration 020; selecting a missing column
// fails the whole PostgREST query, so fall back without it (same two-step the
// other visualizer_url readers use).
async function projectsWithWebmPins(): Promise<{ withWide: boolean }> {
  const probe = await supabaseAdmin.from('mb_projects').select('id, visualizer_wide_url').limit(1)
  return { withWide: !probe.error }
}

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
    for (const url of urls) {
      try {
        const path = videoStoragePath(url)
        if (!path) continue

        const { data: blob, error: dlErr } = await supabaseAdmin.storage.from(VIDEO_BUCKET).download(path)
        if (dlErr || !blob) {
          console.error(`[viz-heal] download failed for ${path}:`, dlErr?.message)
          continue
        }

        const mp4 = await webmToMp4(Buffer.from(await blob.arrayBuffer()))
        const outPath = mp4TwinPath(path)
        const { error: upErr } = await supabaseAdmin.storage
          .from(VIDEO_BUCKET)
          .upload(outPath, mp4, { contentType: 'video/mp4', upsert: true })
        if (upErr) {
          console.error(`[viz-heal] upload failed for ${outPath}:`, upErr.message)
          continue
        }
        const mp4Url = supabaseAdmin.storage.from(VIDEO_BUCKET).getPublicUrl(outPath).data.publicUrl

        // Repoint every reference to this exact WebM URL.
        await supabaseAdmin.from('mb_visualizers').update({ video_url: mp4Url }).eq('video_url', url)
        await supabaseAdmin.from('mb_projects').update({ visualizer_url: mp4Url }).eq('visualizer_url', url)
        if (withWide) {
          await supabaseAdmin.from('mb_projects').update({ visualizer_wide_url: mp4Url }).eq('visualizer_wide_url', url)
        }
        converted++
      } catch (err) {
        console.error(`[viz-heal] convert failed for ${url}:`, err instanceof Error ? err.message : err)
      }
    }
    console.log(`[viz-heal] done — ${converted}/${urls.size} converted`)
  } finally {
    healRunning = false
  }
}
