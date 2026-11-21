#!/usr/bin/env node
// The mixing intern's rules, as a command the helper on the owner's Mac runs.
// No AI and no network: it reads audio files and a claimed job, and prints JSON.
//
//   node scripts/intern-plan.mjs plan  --job <claim.json> --tracks <folder> [--mix <file>] [--offset <sec>] [--skip <regex>]
//       Measures every exported track in the folder and chooses the moves for
//       the job's notes. --mix (the handed mix's audio) adds how well the
//       tracks add up to it, band by band. --offset is where in the mix the
//       exported files start. --skip leaves out files by name (a bounce of the
//       output, say).
//
//   node scripts/intern-plan.mjs judge --job <claim.json> --bounce <file> [--handled <code,code>]
//       Runs Mix Check on a new bounce against the same earlier mix the notes
//       were written about, and says whether the fix is worth uploading. Not
//       the last word: the catalog and genre comparisons only exist on the
//       server, so Mix Check there still judges what is uploaded.
//
//   node scripts/intern-plan.mjs refine --plan <plan.json> --judge <judge.json>
//       The next sizes to try when a bounce did not move the bands as predicted.
//
// <claim.json> is the body POST /api/intern/jobs/claim answered with.
// Audio is decoded exactly as the server's Mix Check decodes it (ffmpeg,
// 44.1 kHz stereo float), so any format Logic exports is fine.
// The rules themselves are src/lib/intern-rules.ts.

import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ANALYSIS_RATE, MIX_BANDS, createMixAnalyzer, isMixSummary } from '../src/lib/mix-check.ts'
import { buildFindings } from '../src/lib/mix-check-findings.ts'
import {
  INTERN_SPEC_HZ, coreWindows, createLowWidthMeter, createTrackMeter, describeMove, internHasRule, judgeFix, locallyJudged, lowWidthWindows, planFixes, refineMove,
} from '../src/lib/intern-rules.ts'

const AUDIO = new Set(['.wav', '.wave', '.aif', '.aiff', '.caf', '.flac', '.mp3', '.m4a'])

function ffmpegPath(flag) {
  if (flag) return flag
  if (process.env.FFMPEG) return process.env.FFMPEG
  try { return createRequire(import.meta.url)('@ffmpeg-installer/ffmpeg').path } catch { return 'ffmpeg' }
}

/** Decode a file the way Mix Check does and hand the samples to `sink.push(left, right)`. */
export function decode(file, sink, ffmpeg = ffmpegPath()) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-f', 'f32le', '-ac', '2', '-ar', String(ANALYSIS_RATE), '-'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let carry = Buffer.alloc(0), stderr = '', samples = 0
    proc.stderr.on('data', d => { if (stderr.length < 2000) stderr += d.toString() })
    proc.stdout.on('data', chunk => {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk
      const n = Math.floor(buf.length / 8)
      const left = new Float32Array(n), right = new Float32Array(n)
      for (let i = 0; i < n; i++) { left[i] = buf.readFloatLE(i * 8); right[i] = buf.readFloatLE(i * 8 + 4) }
      sink.push(left, right)
      samples += n
      carry = buf.subarray(n * 8)
    })
    proc.on('error', err => reject(new Error(`Could not start ffmpeg (${ffmpeg}): ${err.message}`)))
    proc.on('close', code => (code === 0 ? resolve(samples / ANALYSIS_RATE) : reject(new Error(`Could not read ${basename(file)}${stderr ? `: ${stderr.trim().split('\n')[0]}` : ''}`))))
  })
}

const bandsOf = spec => MIX_BANDS.map(b => spec.reduce((s, v, i) => (INTERN_SPEC_HZ[i] >= b.lo && INTERN_SPEC_HZ[i] < b.hi ? s + v : s), 0))
const round1 = x => Math.round(x * 10) / 10

export async function plan({ job, tracksDir, mix = null, offset = 0, skip = null, ffmpeg }) {
  const song = job.song ?? {}
  const windows = coreWindows(song.sections)
  const leaveOut = skip ? new RegExp(skip, 'i') : null
  const files = readdirSync(tracksDir)
    .filter(f => AUDIO.has(extname(f).toLowerCase()) && !f.startsWith('.') && statSync(join(tracksDir, f)).isFile())
    .filter(f => !leaveOut || !leaveOut.test(basename(f, extname(f))))
    .sort()
  // The stretches each "low end is stereo" note is about: every track's low end is
  // measured there too (mid against side), in the same pass over the file.
  const lowNotes = lowWidthWindows(job.job?.notes ?? [], song.sections)
  const lowWindows = lowNotes.flatMap(n => n.windows.length ? [{ start: Math.min(...n.windows.map(w => w.start)), end: Math.max(...n.windows.map(w => w.end)) }] : [{ start: 0, end: 0 }])
  const tracks = [], unreadable = []
  for (const f of files) {
    const meter = createTrackMeter(ANALYSIS_RATE, windows, offset)
    const width = lowNotes.length ? createLowWidthMeter(ANALYSIS_RATE, lowWindows, offset) : null
    const both = { push(l, r) { meter.push(l, r); width?.push(l, r) } }
    try {
      const seconds = await decode(join(tracksDir, f), both, ffmpeg)
      tracks.push({ name: basename(f, extname(f)), file: f, seconds: round1(seconds), ...meter.finish(), ...(width ? { low: width.finish() } : {}) })
    } catch (err) { unreadable.push({ file: f, error: err.message }) }
  }
  const result = planFixes({ notes: job.job?.notes ?? [], bands: song.bands ?? [], tracks, lowNotes: lowNotes.map(n => n.code), resonances: song.resonances ?? [] })

  // Which track carries how much of each band, for the log and for a person reading it.
  const totals = MIX_BANDS.map((_, i) => tracks.reduce((s, t) => s + bandsOf(t.spec)[i], 0))
  const carriers = tracks.map(t => ({
    name: t.name, seconds: t.seconds, frames: t.frames,
    share: Object.fromEntries(MIX_BANDS.map((b, i) => [b.key, totals[i] > 0 ? Math.round((bandsOf(t.spec)[i] / totals[i]) * 100) / 100 : 0])),
    // How much of the low end's SIDE energy this track holds, for each low-width note.
    ...(t.low ? { lowSide: Object.fromEntries(lowNotes.map((n, k) => { const all = tracks.reduce((s, x) => s + (x.low?.[k]?.side ?? 0), 0); return [n.code, all > 0 ? Math.round(((t.low[k]?.side ?? 0) / all) * 100) / 100 : 0] })) } : {}),
  }))

  // Do the tracks add up to the mix? A band far off means the export missed
  // something (a bus, the output's own processing) and the prediction is weaker there.
  let sumVsMix = null
  if (mix) {
    const meter = createTrackMeter(ANALYSIS_RATE, windows, 0)
    await decode(mix, meter, ffmpeg)
    const m = bandsOf(meter.finish().spec)
    sumVsMix = MIX_BANDS.map((b, i) => ({ key: b.key, db: totals[i] > 0 && m[i] > 0 ? round1(10 * Math.log10(totals[i] / m[i])) : null }))
  }
  return { windows, tracks: carriers, unreadable, sumVsMix, ...result, changes: result.moves.map(describeMove) }
}

export async function judge({ job, bounce, handled = null, ffmpeg }) {
  const song = job.song ?? {}
  const baseline = song.baseline
  if (!baseline || !isMixSummary(baseline.summary)) throw new Error('The job has no earlier mix to judge against (song.baseline)')
  const analyzer = createMixAnalyzer(ANALYSIS_RATE)
  const seconds = await decode(bounce, analyzer, ffmpeg)
  if (seconds < 5) throw new Error('The bounce is too short to check (under 5 seconds)')
  const measured = analyzer.finish('full')
  const verdict = buildFindings(measured, { previous: { label: String(baseline.label ?? 'the earlier mix'), summary: baseline.summary } })
  const codes = handled ?? (job.job?.notes ?? []).map(n => n.code).filter(c => internHasRule(c))
  const was = new Map((song.bands ?? []).map(b => [b.key, b.vsPrevious]))
  return {
    ...judgeFix(locallyJudged(song.findings ?? []), locallyJudged(verdict.findings), codes),
    // Not the last word: the server's Mix Check also has the catalog and the genre.
    final: false,
    comparedWith: baseline.label ?? null,
    bands: verdict.bands.map(b => ({ key: b.key, before: was.get(b.key) ?? null, after: b.vsPrevious })),
    findings: verdict.findings.map(f => ({ code: f.code, severity: f.severity, title: f.title })),
    loudness: { integratedLufs: measured.summary.i, truePeakDb: measured.summary.tp, seconds: round1(seconds) },
    // How much louder the left is than the right (dB), for the left/right note.
    balanceDb: measured.detail?.balanceDb ?? null,
  }
}

/** Resize a plan's moves from what a bounce actually did. Moves whose band is settled are kept as they are. */
export function refine({ plan: p, judge: j }) {
  const predicted = new Map((p.predicted ?? []).map(x => [x.key, x]))
  const observed = new Map((j.bands ?? []).map(x => [x.key, x]))
  const remaining = new Set(j.remaining ?? [])
  let changed = false
  const stuck = []
  const moves = (p.moves ?? []).map(move => {
    if (!remaining.has(move.code)) return move
    const want = predicted.get(move.band), got = observed.get(move.band)
    const next = want && got && want.before != null && got.after != null
      ? refineMove(move, want.after - want.before, got.after - want.before) : null
    if (!next) { stuck.push(move.code); return move }
    changed = true
    return next
  })
  return { moves, changes: moves.map(describeMove), changed, stuck: [...new Set(stuck)] }
}

function args(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] == null ? true : argv[++i]
    else out._.push(argv[i])
  }
  return out
}

async function main() {
  const a = args(process.argv.slice(2))
  const json = p => JSON.parse(readFileSync(p, 'utf8'))
  const need = (...names) => { for (const n of names) if (typeof a[n] !== 'string') throw new Error(`Missing --${n}`) }
  let out
  if (a._[0] === 'plan') {
    need('job', 'tracks')
    out = await plan({ job: json(a.job), tracksDir: a.tracks, mix: typeof a.mix === 'string' ? a.mix : null, offset: Number(a.offset) || 0, skip: typeof a.skip === 'string' ? a.skip : null, ffmpeg: ffmpegPath(typeof a.ffmpeg === 'string' ? a.ffmpeg : null) })
  } else if (a._[0] === 'judge') {
    need('job', 'bounce')
    out = await judge({ job: json(a.job), bounce: a.bounce, handled: typeof a.handled === 'string' ? a.handled.split(',').map(s => s.trim()).filter(Boolean) : null, ffmpeg: ffmpegPath(typeof a.ffmpeg === 'string' ? a.ffmpeg : null) })
  } else if (a._[0] === 'refine') {
    need('plan', 'judge')
    out = refine({ plan: json(a.plan), judge: json(a.judge) })
  } else {
    throw new Error('Usage: node scripts/intern-plan.mjs plan|judge|refine … (see the top of this file)')
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { process.stderr.write(`${err.message}\n`); process.exit(2) })
}
