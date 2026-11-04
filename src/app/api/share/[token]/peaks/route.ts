import { NextRequest, NextResponse } from 'next/server'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { supabaseAdmin } from '@/lib/supabase'
import { rateLimiter, ipKey, rateLimitHeaders } from '@/lib/rate-limit'
import { ensureVersionWaveformPeaksColumn, isMissingWaveformPeaksColumn } from '@/lib/schema-heal'
import { BARS, isPeakList, peaksFromPcm16 } from '@/lib/waveform-peaks'
import { armDeadline } from '@/lib/proc-deadline.ts'

// GET /api/share/[token]/peaks — the waveform behind the public share player.
//
// A share token is a bearer capability for one mix: whoever holds it can
// stream the audio, so the SHAPE of that audio is a fact the token already
// grants (anyone who can play the file can measure it). This route measures it
// once on the server — ffmpeg decodes the mix to mono PCM at a low sample
// rate, src/lib/waveform-peaks.ts folds it into 200 peaks — and keeps the
// result on the version row (migration 043, write-once), so every later
// listener gets it in one small read and a 2 GB WAV is never decoded on a
// phone, or twice.
//
// Responses:
//   200 { peaks: number[], bars }  the waveform (0–100 per bar)
//   202 { pending: true }          still decoding — the client retries shortly
//   404                            no such share
// The decode runs on in-process state (an in-flight map), lost on deploy by
// design, exactly like finalize-video's jobs: the next request simply starts
// it again.
//
// Mirrors the token forms the single-track page serves (project-level → latest
// mix; legacy version-level → that row). Never the album form — the album
// player has no waveform.

export const dynamic = 'force-dynamic'

const FFMPEG = ffmpegInstaller.path
const PCM_RATE = 4000             // Hz — 200 bars of a 10-minute song need nothing finer
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/
const RESPOND_WITHIN_MS = 20_000  // past this, answer 202 and keep decoding
const DECODE_DEADLINE_MS = 10 * 60_000
const DECODE_IDLE_MS = 60_000
const DOWNLOAD_IDLE_MS = 60_000

// Anonymous listeners poll this while a long mix decodes (every ~8 s for up to
// a couple of minutes), so the budget is wider than feedback's 20/h.
const peaksLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 240 })

type Target = { versionId: string; audioUrl: string; peaks: number[] | null; columnMissing: boolean }

type Row = { id: string; audio_url: string; waveform_peaks?: unknown }
type RowResult = { data: Row | null; error: { message?: string } | null }

// One select, with the migration-043 column healed on first miss. If the heal
// cannot run (no management token) the waveform is still computed — it just
// is not persisted, and the in-process cache below carries it for this deploy.
async function selectVersion(run: (cols: string) => PromiseLike<RowResult>): Promise<Target | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await run('id, audio_url, waveform_peaks')
    if (!error) {
      if (!data) return null
      return { versionId: data.id, audioUrl: data.audio_url, peaks: isPeakList(data.waveform_peaks) ? data.waveform_peaks : null, columnMissing: false }
    }
    if (!isMissingWaveformPeaksColumn(error)) return null
    if (attempt === 0 && await ensureVersionWaveformPeaksColumn()) continue
    const fallback = await run('id, audio_url')
    if (!fallback.data) return null
    return { versionId: fallback.data.id, audioUrl: fallback.data.audio_url, peaks: null, columnMissing: true }
  }
  return null
}

async function resolveTarget(token: string): Promise<Target | null> {
  const { data: project } = await supabaseAdmin.from('mb_projects').select('id').eq('share_token', token).maybeSingle()
  if (project) {
    return selectVersion(cols => supabaseAdmin.from('mb_versions').select(cols)
      .eq('project_id', project.id as string).order('version_number', { ascending: false }).limit(1).maybeSingle())
  }
  return selectVersion(cols => supabaseAdmin.from('mb_versions').select(cols).eq('share_token', token).maybeSingle())
}

// ── Decode ───────────────────────────────────────────────────────────────────

async function download(url: string, dest: string): Promise<void> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const bump = () => {
    clearTimeout(timer)
    timer = setTimeout(() => controller.abort(new Error('Download stalled')), DOWNLOAD_IDLE_MS)
    timer.unref?.()
  }
  bump()
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)
    const source = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
    source.on('data', bump)
    await pipeline(source, createWriteStream(dest))
  } finally {
    clearTimeout(timer)
  }
}

function decodeToPcm(file: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, [
      '-v', 'error', '-nostdin', '-i', file,
      '-vn', '-ac', '1', '-ar', String(PCM_RATE), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    // The shared watchdog: a hard ceiling plus an idle budget reset by every
    // PCM chunk, SIGKILL + reject on either, so a wedged decode cannot pin the
    // in-flight slot for this version forever.
    const touch = armDeadline(proc, DECODE_DEADLINE_MS, DECODE_IDLE_MS, 'share waveform decode', reject)
    proc.stdout.on('data', (d: Buffer) => { touch(); chunks.push(d) })
    proc.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000) })
    proc.on('error', reject)
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`))
      resolve(Buffer.concat(chunks))
    })
  })
}

async function computePeaks(audioUrl: string): Promise<number[]> {
  const dir = await mkdtemp(join(tmpdir(), 'mb-peaks-'))
  try {
    const ext = (audioUrl.split('?')[0].split('.').pop() ?? 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin'
    const file = join(dir, `mix.${ext}`)
    await download(audioUrl, file)
    const pcm = await decodeToPcm(file)
    const peaks = peaksFromPcm16(pcm, BARS)
    if (!isPeakList(peaks)) throw new Error('Decoded nothing')
    return peaks
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// In-flight decodes, keyed by version, so a room full of listeners opening the
// same link decode it once; and the last few results, for a deploy whose
// column is still missing (or whose write lost the write-once race).
const inflight = new Map<string, Promise<number[]>>()
const recent = new Map<string, number[]>()
const RECENT_MAX = 200

function remember(versionId: string, peaks: number[]) {
  recent.delete(versionId)
  recent.set(versionId, peaks)
  if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value as string)
}

function startDecode(target: Target): Promise<number[]> {
  const existing = inflight.get(target.versionId)
  if (existing) return existing
  const job = computePeaks(target.audioUrl)
    .then(async peaks => {
      remember(target.versionId, peaks)
      if (!target.columnMissing) {
        // Write-once, on the UPDATE itself — a second listener who finished
        // first simply wins and this write matches no row.
        const { error } = await supabaseAdmin
          .from('mb_versions')
          .update({ waveform_peaks: peaks })
          .eq('id', target.versionId)
          .is('waveform_peaks', null)
        if (error) console.error('[share-peaks] persist failed:', error.message)
      }
      return peaks
    })
    .finally(() => inflight.delete(target.versionId))
  inflight.set(target.versionId, job)
  return job
}

const CACHE_OK = { 'Cache-Control': 'public, max-age=86400, s-maxage=86400' }
const CACHE_NO = { 'Cache-Control': 'no-store' }

export async function GET(request: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limit = peaksLimiter.check(ipKey(request))
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  const { token } = await ctx.params
  if (!TOKEN_RE.test(token)) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: CACHE_NO })

  const target = await resolveTarget(token)
  if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: CACHE_NO })

  if (target.peaks) return NextResponse.json({ peaks: target.peaks, bars: target.peaks.length }, { headers: CACHE_OK })
  const cached = recent.get(target.versionId)
  if (cached) return NextResponse.json({ peaks: cached, bars: cached.length }, { headers: CACHE_OK })

  const job = startDecode(target)
  const outcome = await Promise.race<number[] | 'pending'>([
    job.catch(err => { throw err }),
    new Promise<'pending'>(resolve => { const t = setTimeout(() => resolve('pending'), RESPOND_WITHIN_MS); t.unref?.() }),
  ]).catch((err: unknown) => {
    console.error('[share-peaks] decode failed:', err instanceof Error ? err.message : err)
    return null
  })

  if (outcome === 'pending') return NextResponse.json({ pending: true }, { status: 202, headers: CACHE_NO })
  if (!outcome) return NextResponse.json({ error: 'Could not read this mix' }, { status: 500, headers: CACHE_NO })
  return NextResponse.json({ peaks: outcome, bars: outcome.length }, { headers: CACHE_OK })
}
