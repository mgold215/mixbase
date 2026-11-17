// Mix Check — the server side: decode a mix, measure it, compare it, store the
// report on the version and write the findings into its mix notes.
//
// The measuring (src/lib/mix-check.ts) and the judging
// (src/lib/mix-check-findings.ts) are pure; everything that touches ffmpeg,
// Storage or the database is here, shared by POST|GET
// /api/versions/<id>/mix-check and POST /api/mix-check/references.
//
// Like the waveform decode and the video renders, a run is an in-process job
// (POST starts it, GET polls) and is lost on deploy by design. Unlike them, its
// RESULT is not: the report is stored on the version row, so a finished check
// is there after a reload, a deploy, or on another device.
//
// One run at a time per process. A check is several seconds of CPU on the
// container that also serves the site; two side by side would be felt.

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { supabaseAdmin } from '@/lib/supabase'
import { armDeadline } from '@/lib/proc-deadline.ts'
import { versionDisplayLabel } from '@/lib/mix-status.ts'
import {
  ANALYSIS_RATE, MIX_CHECK_ALGO, createMixAnalyzer, isMixSummary,
  type MixDetail, type MixMeasurement, type MixSummary,
} from '@/lib/mix-check.ts'
import {
  MIN_CATALOG, MIN_INDUSTRY, MIX_CHECK_AUTHOR, buildFindings, genreFamily, genreFamilyLabel,
  type BandComparison, type MixFinding, type MixVerdict,
} from '@/lib/mix-check-findings.ts'

const FFMPEG = ffmpegInstaller.path
const DOWNLOAD_IDLE_MS = 60_000
const DECODE_DEADLINE_MS = 10 * 60_000
const DECODE_IDLE_MS = 60_000

/** What is stored in mb_versions.mix_check and returned to the clients. */
export type MixCheckReport = {
  algo: string
  at: string
  summary: MixSummary
  /** Absent on a version that was only measured as someone else's comparison. */
  detail?: MixDetail
  findings?: (MixFinding & { note_id?: string | null })[]
  bands?: BandComparison[]
  compared?: MixVerdict['compared'] & {
    /** True when the song has no genre and the artist's usual one was used. */
    genreAssumed?: boolean
    references?: { artist: string; title: string; source: 'preview' | 'full' }[]
    /** Genre family the references belong to — what an added reference is filed under. */
    family?: string | null
  }
  /** Third-octave spectra (THIRD_OCTAVE_HZ) at matched loudness, for the chart. */
  curves?: { mix: number[]; previous: number[] | null; catalog: number[] | null; industry: number[] | null }
}

export function isMixCheckReport(v: unknown): v is MixCheckReport {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return r.algo === MIX_CHECK_ALGO && isMixSummary(r.summary)
}

// ── Decode + measure ─────────────────────────────────────────────────────────

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
    const heartbeat = new Transform({ transform(chunk, _enc, cb) { bump(); cb(null, chunk) } })
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), heartbeat, createWriteStream(dest))
  } finally {
    clearTimeout(timer)
  }
}

/** Decode a local audio file with ffmpeg and stream it through the analyser. */
export function measureFile(path: string, source: 'full' | 'preview' = 'full'): Promise<MixMeasurement> {
  return new Promise((resolve, reject) => {
    const analyzer = createMixAnalyzer(ANALYSIS_RATE)
    const proc = spawn(FFMPEG, ['-v', 'error', '-i', path, '-vn', '-f', 'f32le', '-ac', '2', '-ar', String(ANALYSIS_RATE), '-'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const touch = armDeadline(proc, DECODE_DEADLINE_MS, DECODE_IDLE_MS, 'Mix check decode', reject)
    let carry: Buffer = Buffer.alloc(0)
    let stderr = ''
    let samples = 0
    proc.stderr.on('data', (d: Buffer) => { if (stderr.length < 2000) stderr += d.toString() })
    proc.stdout.on('data', (chunk: Buffer) => {
      touch()
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk
      const n = Math.floor(buf.length / 8)
      const left = new Float32Array(n), right = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        left[i] = buf.readFloatLE(i * 8)
        right[i] = buf.readFloatLE(i * 8 + 4)
      }
      try { analyzer.push(left, right) } catch (err) { reject(err as Error); proc.kill('SIGKILL'); return }
      samples += n
      carry = buf.subarray(n * 8)
    })
    proc.on('error', reject)
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`Could not read the audio${stderr ? `: ${stderr.trim().split('\n')[0]}` : ''}`))
      if (samples < ANALYSIS_RATE * 5) return reject(new Error('The audio is too short to check (under 5 seconds)'))
      try { resolve(analyzer.finish(source)) } catch (err) { reject(err as Error) }
    })
  })
}

/** Download a URL to a temp file, measure it, and always clean up. */
export async function measureUrl(url: string, source: 'full' | 'preview' = 'full'): Promise<MixMeasurement> {
  const dir = await mkdtemp(join(tmpdir(), 'mixcheck-'))
  try {
    const file = join(dir, 'audio')
    await download(url, file)
    return await measureFile(file, source)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// ── What a mix is compared with ──────────────────────────────────────────────

type VersionRow = {
  id: string
  project_id: string
  version_number: number
  label: string | null
  audio_url: string
  audio_filename: string | null
  status: string
  mix_check: unknown
}

const VERSION_COLUMNS = 'id, project_id, version_number, label, audio_url, audio_filename, status, mix_check'

/** The newest measured version of every OTHER song the artist has. */
async function catalogSummaries(userId: string, projectId: string): Promise<MixSummary[]> {
  const { data } = await supabaseAdmin
    .from('mb_versions')
    .select('project_id, version_number, mix_check, mb_projects!inner(user_id)')
    .eq('mb_projects.user_id', userId)
    .neq('project_id', projectId)
    .not('mix_check', 'is', null)
    .order('version_number', { ascending: false })
    .limit(2000)
  const newest = new Map<string, MixSummary>()
  for (const row of (data ?? []) as { project_id: string; mix_check: unknown }[]) {
    if (newest.has(row.project_id) || !isMixCheckReport(row.mix_check)) continue
    newest.set(row.project_id, row.mix_check.summary)
  }
  return [...newest.values()]
}

/** The genre family to judge a song by: its own, else the artist's usual one. */
async function familyFor(userId: string, genre: string | null): Promise<{ family: string | null; assumed: boolean }> {
  const own = genreFamily(genre)
  if (own) return { family: own, assumed: false }
  const { data } = await supabaseAdmin.from('mb_projects').select('genre').eq('user_id', userId).not('genre', 'is', null).limit(500)
  const counts = new Map<string, number>()
  for (const row of (data ?? []) as { genre: string | null }[]) {
    const f = genreFamily(row.genre)
    if (f) counts.set(f, (counts.get(f) ?? 0) + 1)
  }
  const usual = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  return { family: usual, assumed: usual != null }
}

type ReferenceRow = { user_id: string | null; artist: string; title: string; source: 'preview' | 'full'; summary: unknown }

/** The reference tracks of a family: the shared set plus the artist's own, a
 *  full-file measurement standing in for a preview of the same track. */
export async function referenceSet(userId: string, family: string) {
  const { data } = await supabaseAdmin
    .from('mb_mix_references')
    .select('user_id, artist, title, source, summary')
    .eq('family', family)
    .or(`user_id.is.null,user_id.eq.${userId}`)
    .limit(500)
  const byTrack = new Map<string, ReferenceRow>()
  for (const row of (data ?? []) as ReferenceRow[]) {
    if (!isMixSummary(row.summary)) continue
    const key = `${row.artist.toLowerCase()}|${row.title.toLowerCase()}`
    const held = byTrack.get(key)
    if (!held || (held.source === 'preview' && row.source === 'full')) byTrack.set(key, row)
  }
  const rows = [...byTrack.values()]
  return {
    summaries: rows.map(r => r.summary as MixSummary),
    tracks: rows.map(r => ({ artist: r.artist, title: r.title, source: r.source })),
  }
}

function meanCurve(summaries: MixSummary[]): number[] {
  return summaries[0].s3.map((_, i) => Math.round((summaries.reduce((sum, m) => sum + m.s3[i], 0) / summaries.length) * 10) / 10)
}

// ── A run ────────────────────────────────────────────────────────────────────

async function runMixCheck(versionId: string, userId: string): Promise<void> {
  const { data: version } = await supabaseAdmin
    .from('mb_versions')
    .select(`${VERSION_COLUMNS}, mb_projects!inner(user_id, genre)`)
    .eq('id', versionId)
    .eq('mb_projects.user_id', userId)
    .maybeSingle()
  if (!version) throw new Error('Mix not found')
  const row = version as unknown as VersionRow & { mb_projects: { genre: string | null } }

  const measured = await measureUrl(row.audio_url)

  // The previous version: the nearest older mix of this song with other audio.
  const { data: siblings } = await supabaseAdmin
    .from('mb_versions')
    .select(VERSION_COLUMNS)
    .eq('project_id', row.project_id)
    .lt('version_number', row.version_number)
    .order('version_number', { ascending: false })
    .limit(20)
  let previous: { label: string; summary: MixSummary } | null = null
  const older = ((siblings ?? []) as VersionRow[]).find(v => v.audio_url && v.audio_url !== row.audio_url)
  if (older) {
    let summary = isMixCheckReport(older.mix_check) ? older.mix_check.summary : null
    if (!summary) {
      // Never measured: measure it now and keep the summary on its row, so the
      // next comparison (and the catalog) has it. No notes are written on it.
      try {
        const m = await measureUrl(older.audio_url)
        summary = m.summary
        const stored: MixCheckReport = { algo: m.algo, at: new Date().toISOString(), summary }
        await supabaseAdmin.from('mb_versions').update({ mix_check: stored }).eq('id', older.id).is('mix_check', null)
      } catch (err) {
        console.error('[mix-check] previous version could not be measured:', (err as Error).message)
      }
    }
    if (summary) previous = { label: versionDisplayLabel(older), summary }
  }

  const [catalog, fam] = await Promise.all([
    catalogSummaries(userId, row.project_id),
    familyFor(userId, row.mb_projects.genre),
  ])
  const refs = fam.family ? await referenceSet(userId, fam.family) : null
  const verdict = buildFindings(measured, {
    previous,
    catalog,
    industry: refs && fam.family ? { label: genreFamilyLabel(fam.family), summaries: refs.summaries } : null,
  })

  // ── Notes: replace what the last run wrote, keep what the artist ticked off ──
  const old = isMixCheckReport(row.mix_check) ? row.mix_check.findings ?? [] : []
  const oldIds = old.map(f => f.note_id).filter((id): id is string => typeof id === 'string')
  const kept = new Map<string, string>() // finding code → note id of a note already resolved
  if (oldIds.length) {
    const { data: notes } = await supabaseAdmin
      .from('mb_feedback')
      .select('id, resolved_at')
      .in('id', oldIds)
      .eq('version_id', versionId)
      .eq('reviewer_name', MIX_CHECK_AUTHOR)
    const resolved = new Set(((notes ?? []) as { id: string; resolved_at: string | null }[]).filter(n => n.resolved_at).map(n => n.id))
    for (const f of old) if (f.note_id && resolved.has(f.note_id)) kept.set(f.code, f.note_id)
    const stale = ((notes ?? []) as { id: string }[]).map(n => n.id).filter(id => !resolved.has(id))
    if (stale.length) await supabaseAdmin.from('mb_feedback').delete().in('id', stale)
  }
  const findings: (MixFinding & { note_id?: string | null })[] = []
  for (const f of verdict.findings) {
    if (kept.has(f.code)) { findings.push({ ...f, note_id: kept.get(f.code) }); continue }
    const { data: note, error } = await supabaseAdmin
      .from('mb_feedback')
      .insert({
        version_id: versionId,
        reviewer_name: MIX_CHECK_AUTHOR,
        rating: null,
        comment: f.note,
        timestamp_seconds: f.at,
      })
      .select('id')
      .single()
    if (error) console.error('[mix-check] note not written:', error.message)
    findings.push({ ...f, note_id: (note as { id: string } | null)?.id ?? null })
  }

  const report: MixCheckReport = {
    algo: measured.algo,
    at: new Date().toISOString(),
    summary: measured.summary,
    detail: measured.detail,
    findings,
    bands: verdict.bands,
    compared: { ...verdict.compared, genreAssumed: fam.assumed, references: refs?.tracks ?? [], family: fam.family },
    curves: {
      mix: measured.summary.s3,
      previous: previous?.summary.s3 ?? null,
      catalog: catalog.length >= MIN_CATALOG ? meanCurve(catalog) : null,
      industry: refs && refs.summaries.length >= MIN_INDUSTRY ? meanCurve(refs.summaries) : null,
    },
  }
  const { error } = await supabaseAdmin.from('mb_versions').update({ mix_check: report }).eq('id', versionId)
  if (error) throw new Error(`The report could not be saved: ${error.message}`)
}

type Job = { state: 'running' | 'error'; startedAt: number; error?: string }
const jobs = new Map<string, Job>()
let queue: Promise<void> = Promise.resolve()

/** Start a check unless one is already running for this mix. */
export function startMixCheck(versionId: string, userId: string): 'started' | 'running' {
  if (jobs.get(versionId)?.state === 'running') return 'running'
  jobs.set(versionId, { state: 'running', startedAt: Date.now() })
  queue = queue
    .then(() => runMixCheck(versionId, userId))
    .then(() => { jobs.delete(versionId) })
    .catch((err: Error) => {
      console.error('[mix-check] run failed:', err.message)
      jobs.set(versionId, { state: 'error', startedAt: Date.now(), error: err.message })
    })
  return 'started'
}

export function mixCheckJob(versionId: string): Job | null {
  return jobs.get(versionId) ?? null
}
