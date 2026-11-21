// The mixing intern's rules — which move answers a measured Mix Check note.
// Pure, no AI: the tracks exported from the Logic project are measured, the
// move is tried on those measurements, and its size is solved so the note's
// band lands back inside what Mix Check accepts without pushing another band
// out. The helper on the owner's Mac makes the move in Logic; Mix Check on the
// new bounce is still the judge (judgeFix), this only chooses what to try.
// No '@/…' imports: scripts/intern-rules-test.mjs loads this through Node.

import { MIX_BANDS, makeFft, type MixBandKey } from './mix-check.ts'
import { kWeighting, type Biquad } from './loudness.ts'

// ── The numbers the rules turn on ────────────────────────────────────────────

/** Mix Check writes `changed.<band>` at this much change since the last version. */
export const NOTE_AT_DB = 2.5
/** A fix undoes the change down to this much of it: Mix Check itself calls a
 *  band within 1 dB "still", and some of the change may have been meant. */
export const AIM_DB = 1.0
/** A plan is only offered when it predicts the band this far inside. */
export const CLEAR_DB = 2.0
/** No single move is larger than this. A note that needs more is not a
 *  cleanup, it is a mix decision, and is left for the owner. */
export const MAX_MOVE_DB = 6
/** A note is answered on at most this many tracks. */
export const MAX_TRACKS_PER_NOTE = 3
/** A level move is preferred over EQ when it moves no other band this much. */
const LEVEL_SIDE_DB = 0.5
/** A band that was fine may not be pushed this close to a note of its own. */
const SIDE_LIMIT_DB = 2.2
/** A plan may not move the mix's loudness by more than this. */
const LOUDNESS_LIMIT_DB = 1.0

// ── The spectrum a track is measured into ────────────────────────────────────

const T12_LO = -67 // 1000·2^(-67/12) ≈ 20.9 Hz — Mix Check's own twelfth-octave grid
const T12_HI = 51  // ≈ 19.0 kHz
/** Centres of the twelfth-octave bins a track's spectrum is given in. */
export const INTERN_SPEC_HZ: number[] = Array.from({ length: T12_HI - T12_LO + 1 }, (_, i) => 1000 * Math.pow(2, (i + T12_LO) / 12))
const N = INTERN_SPEC_HZ.length
const BAND_BINS: number[][] = MIX_BANDS.map(band => INTERN_SPEC_HZ.flatMap((f, i) => (f >= band.lo && f < band.hi ? [i] : [])))

const NFFT = 16384
const HOP = NFFT / 2

export type TimeWindow = { start: number; end: number }

/**
 * The stretches of the song a track is measured over: what Mix Check's core is
 * made of, the kick sections within 4 LU of the loudest one (every section,
 * when the song has no kick). Takes the `sections` of a claimed job.
 */
export function coreWindows(sections: unknown): TimeWindow[] {
  const rows = (Array.isArray(sections) ? sections : []).flatMap((s): { kind: string; start: number; end: number; lufs: number }[] => {
    if (!s || typeof s !== 'object') return []
    const x = s as Record<string, unknown>
    const start = Number(x.start), end = Number(x.end), lufs = Number(x.lufs)
    return Number.isFinite(start) && Number.isFinite(end) && end > start && Number.isFinite(lufs)
      ? [{ kind: String(x.kind), start, end, lufs }] : []
  })
  const rhythm = rows.filter(r => r.kind === 'rhythm')
  const pool = rhythm.length ? rhythm : rows
  if (!pool.length) return []
  const top = Math.max(...pool.map(r => r.lufs))
  return pool.filter(r => r.lufs >= top - 4).map(r => ({ start: r.start, end: r.end }))
}

export type TrackMeter = {
  /** Feed the next stretch of the file. Both arrays the same length; a mono file is passed twice. */
  push(left: Float32Array, right: Float32Array): void
  /** Mean power per bin (INTERN_SPEC_HZ) over the windows, and how many frames that is. */
  finish(): { spec: number[]; frames: number }
}

/**
 * Measures one exported track: its power spectrum inside the given windows.
 * Power is absolute (not loudness-matched), so tracks compare with one
 * another and add up to the mix. `offsetSec` is where in the MIX the file's
 * first sample sits, for an export that does not start where the bounce does.
 * No windows means the whole file.
 */
export function createTrackMeter(sampleRate: number, windows: TimeWindow[] = [], offsetSec = 0): TrackMeter {
  if (!Number.isFinite(sampleRate) || sampleRate < 22050) throw new Error(`Unsupported sample rate: ${sampleRate}`)
  const fft = makeFft(NFFT)
  const win = new Float64Array(NFFT)
  let winSq = 0
  for (let i = 0; i < NFFT; i++) { win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFFT); winSq += win[i] * win[i] }
  const powerScale = 2 / (NFFT * winSq)
  const bins = NFFT / 2
  const df = sampleRate / NFFT
  // Each FFT bin is shared among the twelfth-octave bins it overlaps (as in mix-check.ts).
  const binBand: number[][] = [], binWeight: number[][] = []
  for (let k = 1; k < bins; k++) {
    const lo = (k - 0.5) * df, hi = (k + 0.5) * df
    const bands: number[] = [], weights: number[] = []
    const first = Math.max(0, Math.floor(12 * Math.log2(lo / 1000) + 0.5) - T12_LO)
    for (let i = first; i < N; i++) {
      const bl = INTERN_SPEC_HZ[i] * Math.pow(2, -1 / 24), bh = INTERN_SPEC_HZ[i] * Math.pow(2, 1 / 24)
      if (bl >= hi) break
      const overlap = Math.min(hi, bh) - Math.max(lo, bl)
      if (overlap > 0) { bands.push(i); weights.push(overlap / df) }
    }
    binBand.push(bands); binWeight.push(weights)
  }
  const bufL = new Float32Array(NFFT), bufR = new Float32Array(NFFT)
  const reL = new Float64Array(NFFT), imL = new Float64Array(NFFT)
  const reR = new Float64Array(NFFT), imR = new Float64Array(NFFT)
  const sum = new Float64Array(N)
  let fill = 0, frame = 0, counted = 0
  const wanted = (t: number) => !windows.length || windows.some(w => t >= w.start && t < w.end)

  function analyse() {
    const centre = (frame * HOP + NFFT / 2) / sampleRate + offsetSec
    frame++
    if (!wanted(centre)) return
    for (let i = 0; i < NFFT; i++) { reL[i] = bufL[i] * win[i]; imL[i] = 0; reR[i] = bufR[i] * win[i]; imR[i] = 0 }
    fft(reL, imL); fft(reR, imR)
    for (let b = 1; b < bins; b++) {
      const mean = ((reL[b] * reL[b] + imL[b] * imL[b]) + (reR[b] * reR[b] + imR[b] * imR[b])) * powerScale / 2
      const bands = binBand[b - 1], weights = binWeight[b - 1]
      for (let j = 0; j < bands.length; j++) sum[bands[j]] += mean * weights[j]
    }
    counted++
  }

  return {
    push(left, right) {
      const n = Math.min(left.length, right.length)
      for (let i = 0; i < n; i++) {
        bufL[fill] = left[i]; bufR[fill] = right[i]
        if (++fill === NFFT) {
          analyse()
          bufL.copyWithin(0, HOP); bufR.copyWithin(0, HOP)
          fill = NFFT - HOP
        }
      }
    },
    finish() {
      return { spec: Array.from(sum, x => (counted ? x / counted : 0)), frames: counted }
    },
  }
}

// ── How wide a track's low end is ────────────────────────────────────────────

/** Mix Check's "low end": the stereo-correlation notes are about 30–120 Hz. */
export const LOW_WIDTH_HZ = { lo: 30, hi: 120 }

export type LowWidthMeter = {
  push(left: Float32Array, right: Float32Array): void
  /** For each window, the low end's power in the middle (L+R) and at the sides (L−R). */
  finish(): { mid: number; side: number }[]
}

/**
 * Measures how much of a track's low end is mid and how much is side, inside
 * each window (the stretches a "low end is stereo" note names). A track whose
 * lows are mono has no side; the tracks with the most side are the ones a
 * mono.low note is about. `offsetSec` as in createTrackMeter.
 */
export function createLowWidthMeter(sampleRate: number, windows: TimeWindow[], offsetSec = 0): LowWidthMeter {
  if (!Number.isFinite(sampleRate) || sampleRate < 22050) throw new Error(`Unsupported sample rate: ${sampleRate}`)
  const fft = makeFft(NFFT)
  const win = new Float64Array(NFFT)
  for (let i = 0; i < NFFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFFT)
  const df = sampleRate / NFFT
  const first = Math.max(1, Math.ceil(LOW_WIDTH_HZ.lo / df)), last = Math.min(NFFT / 2 - 1, Math.floor(LOW_WIDTH_HZ.hi / df))
  const bufL = new Float32Array(NFFT), bufR = new Float32Array(NFFT)
  const reM = new Float64Array(NFFT), imM = new Float64Array(NFFT)
  const reS = new Float64Array(NFFT), imS = new Float64Array(NFFT)
  const out = windows.map(() => ({ mid: 0, side: 0, frames: 0 }))
  let fill = 0, frame = 0

  function analyse() {
    const centre = (frame * HOP + NFFT / 2) / sampleRate + offsetSec
    frame++
    const hit = windows.flatMap((w, i) => (centre >= w.start && centre < w.end ? [i] : []))
    if (!hit.length) return
    for (let i = 0; i < NFFT; i++) {
      reM[i] = ((bufL[i] + bufR[i]) / 2) * win[i]; imM[i] = 0
      reS[i] = ((bufL[i] - bufR[i]) / 2) * win[i]; imS[i] = 0
    }
    fft(reM, imM); fft(reS, imS)
    let mid = 0, side = 0
    for (let b = first; b <= last; b++) { mid += reM[b] * reM[b] + imM[b] * imM[b]; side += reS[b] * reS[b] + imS[b] * imS[b] }
    for (const i of hit) { out[i].mid += mid; out[i].side += side; out[i].frames++ }
  }

  return {
    push(left, right) {
      const n = Math.min(left.length, right.length)
      for (let i = 0; i < n; i++) {
        bufL[fill] = left[i]; bufR[fill] = right[i]
        if (++fill === NFFT) {
          analyse()
          bufL.copyWithin(0, HOP); bufR.copyWithin(0, HOP)
          fill = NFFT - HOP
        }
      }
    },
    finish() {
      return out.map(o => ({ mid: o.frames ? o.mid / o.frames : 0, side: o.frames ? o.side / o.frames : 0 }))
    },
  }
}

/** Which notes the intern has a rule for: a band that changed or sits unusually against the catalog, a low end that is stereo, a narrow resonance. */
export function internHasRule(code: string | null | undefined): boolean {
  if (!code) return false
  return MIX_BANDS.some(b => code === `changed.${b.key}` || code === `balance.${b.key}`) || code === 'changed.lowwidth' || /^mono\.low@\d+$/.test(code) || /^resonance\.\d+$/.test(code)
}

/** The stretches of the song a low-width note is about: its own section, or the core for 'changed.lowwidth'. */
export function lowWidthWindows(notes: { code?: string | null }[], sections: unknown): { code: string; windows: TimeWindow[] }[] {
  const rows = (Array.isArray(sections) ? sections : []).flatMap((x): TimeWindow[] => {
    const start = Number((x as Record<string, unknown>)?.start), end = Number((x as Record<string, unknown>)?.end)
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? [{ start, end }] : []
  })
  const out: { code: string; windows: TimeWindow[] }[] = []
  for (const note of notes ?? []) {
    const code = typeof note?.code === 'string' ? note.code : ''
    const at = /^mono\.low@(\d+)$/.exec(code)
    if (at) {
      // The section the note starts in; a note whose section is not listed still gets its 16 seconds.
      const start = Number(at[1])
      const sec = rows.find(r => Math.abs(r.start - start) < 1) ?? { start, end: start + 16 }
      out.push({ code, windows: [sec] })
    } else if (code === 'changed.lowwidth') {
      out.push({ code, windows: coreWindows(sections) })
    }
  }
  return out
}

// ── Trying a move on the measurements ────────────────────────────────────────

export type InternMove = {
  /** 'level' = the whole track up or down; 'eq' = one bell on the track;
   *  'mono' = the track's low end narrowed to mono below `hz` (gainDb is 0);
   *  'lowcut' = everything below `hz` removed (gainDb is 0). */
  kind: 'level' | 'eq' | 'mono' | 'lowcut'
  track: string
  gainDb: number
  /** The bell's centre and Q, for an 'eq' move. */
  hz?: number
  q?: number
  /** For a 'level' move on the output: the left/right balance to set, in percent (+ is right). */
  balancePct?: number
  /** The note this answers. */
  band: MixBandKey
  code: string
  note_id: string | null
}

function biquadPower(c: Biquad, f: number, sr: number): number {
  const w = (2 * Math.PI * f) / sr
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w)
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2, ni = -(c.b1 * s1 + c.b2 * s2)
  const dr = 1 + c.a1 * c1 + c.a2 * c2, di = -(c.a1 * s1 + c.a2 * s2)
  return (nr * nr + ni * ni) / (dr * dr + di * di)
}

/** What the loudness meter hears of each bin (BS.1770 K-weighting). */
const K_WEIGHT: number[] = (() => {
  const kw = kWeighting(48000)
  return INTERN_SPEC_HZ.map(f => biquadPower(kw.shelf, f, 48000) * biquadPower(kw.highpass, f, 48000))
})()

/** The bell a band is corrected with: centred on the band, as wide as it. */
export function bellFor(band: MixBandKey): { hz: number; q: number } {
  const b = MIX_BANDS.find(x => x.key === band)!
  const hz = Math.sqrt(b.lo * b.hi)
  return { hz: Math.round(hz), q: Math.round((hz / (b.hi - b.lo)) * 100) / 100 }
}

/** Power gain of a peaking EQ (the textbook analogue bell) at frequency f. */
function bellPower(f: number, hz: number, q: number, gainDb: number): number {
  const a = Math.pow(10, gainDb / 40), w = f / hz
  const d = (1 - w * w) * (1 - w * w)
  return (d + (a * w / q) * (a * w / q)) / (d + (w / (a * q)) * (w / (a * q)))
}

function moved(spec: Float64Array, move: Pick<InternMove, 'kind' | 'gainDb' | 'hz' | 'q'>): Float64Array {
  const out = new Float64Array(N)
  const flat = Math.pow(10, move.gainDb / 10)
  for (let i = 0; i < N; i++) {
    out[i] = spec[i] * (move.kind === 'eq' ? bellPower(INTERN_SPEC_HZ[i], move.hz!, move.q!, move.gainDb) : flat)
  }
  return out
}

const db10 = (x: number) => (x > 1e-30 ? 10 * Math.log10(x) : -300)
const round1 = (x: number) => Math.round(x * 10) / 10

/** Band levels (dB) and K-weighted loudness (dB) of a set of tracks added up. */
function levels(tracks: Map<string, Float64Array>): { bands: number[]; loud: number } {
  const mix = new Float64Array(N)
  for (const spec of tracks.values()) for (let i = 0; i < N; i++) mix[i] += spec[i]
  let k = 0
  for (let i = 0; i < N; i++) k += mix[i] * K_WEIGHT[i]
  return { bands: BAND_BINS.map(idx => db10(idx.reduce((s, i) => s + mix[i], 0))), loud: db10(k) }
}

export type InternPlan = {
  moves: InternMove[]
  /** Notes no move was planned for, and why, in words the owner can read. */
  skipped: { note_id: string | null; code: string | null; why: string }[]
  /** Each band's change since the previous version (dB), now and as predicted after the moves. */
  predicted: { key: MixBandKey; before: number | null; after: number | null }[]
  /** How much the moves are predicted to change the mix's loudness (dB). */
  loudnessShift: number
}

type PlanNote = { id?: string | null; kind?: string | null; code?: string | null }
type PlanBand = { key: string; vsPrevious?: number | null; vsCatalog?: number | null }

/** Mix Check writes `balance.<band>` 3 dB from the catalog average; a fix aims this far from it, and counts as answered inside CATALOG_CLEAR_DB. */
const CATALOG_AIM_DB = 2.0
const CATALOG_CLEAR_DB = 2.6
/** A move made only because a band is unusual FOR THE ARTIST is kept this small on any one track:
 *  it is their sound being nudged, not a fault being undone. */
export const CATALOG_MAX_MOVE_DB = 3
type PlanTrack = { name: string; spec: number[]; low?: { mid: number; side: number }[] }

/** A low end counts as mono again at this stereo correlation (Mix Check writes the note under 0.7). */
const MONO_GOAL = 0.8
/** A low cut on the sides takes about this much of the side energy below it away. */
const MONO_REMOVES = 0.9

/**
 * Chooses the moves for a job's notes.
 *
 *   notes   the job's notes (InternNote: id, kind, code)
 *   bands   the handed mix's Mix Check bands (key, vsPrevious)
 *   tracks  every exported track, measured with createTrackMeter over coreWindows
 *
 * Only `changed.<band>` notes have a rule. For each, largest first: the tracks
 * that carry the band are tried in order, with a level move (kept when it
 * disturbs no other band) and a bell on the band; the size is solved so the
 * band is predicted AIM_DB from where the previous version had it. A move is
 * refused when it would push another band towards a note of its own or shift
 * the loudness. What cannot be answered within MAX_MOVE_DB on
 * MAX_TRACKS_PER_NOTE tracks is skipped with the reason.
 */
export function planFixes(input: { notes: PlanNote[]; bands: PlanBand[]; tracks: PlanTrack[]; lowNotes?: string[]; resonances?: { hz: number; db: number }[] }): InternPlan {
  const out = planBands(input)
  planMono(input, out)
  planResonances(input, out)
  return out
}

/** A resonance is cut down to this much above its surroundings (Mix Check writes the note at 6 dB). */
const RESONANCE_LEAVE_DB = 3
/** How narrow the cut is. */
const RESONANCE_Q = 8

/**
 * A narrow peak (`resonance.<hz>`): a narrow cut at that frequency on the
 * track that carries most of it, sized to leave the peak RESONANCE_LEAVE_DB
 * above the bands around it. `resonances` is the handed mix's own list (how
 * far each stands out). A peak no single track holds half of is left: it is
 * the sum of the arrangement, and a cut on one part would not answer it.
 */
function planResonances(input: { notes: PlanNote[]; tracks: PlanTrack[]; resonances?: { hz: number; db: number }[] }, plan: InternPlan) {
  for (const note of input.notes ?? []) {
    const m = /^resonance\.(\d+)$/.exec(typeof note?.code === 'string' ? note.code : '')
    if (!m) continue
    const code = m[0], hz = Number(m[1])
    const skip = (why: string) => plan.skipped.push({ note_id: note.id ?? null, code, why })
    const found = (input.resonances ?? []).find(r => Math.abs(r.hz - hz) / hz < 0.06)
    if (!found) { skip('How far this peak stands out was not handed over with the note.'); continue }
    // The twelfth-octave bin the peak is in.
    let bin = 0
    INTERN_SPEC_HZ.forEach((f, i) => { if (Math.abs(Math.log2(f / hz)) < Math.abs(Math.log2(INTERN_SPEC_HZ[bin] / hz))) bin = i })
    const rows = (input.tracks ?? []).filter(t => Array.isArray(t.spec) && t.spec.length === N).map(t => ({ name: t.name, power: t.spec[bin] })).sort((a, b) => b.power - a.power)
    const total = rows.reduce((s, r) => s + r.power, 0)
    if (!rows.length || total <= 0) { skip('No exported track could be measured there.'); continue }
    if (rows[0].power < 0.5 * total) { skip(`No single track holds this peak (the most is ${rows[0].name} with ${Math.round((rows[0].power / total) * 100)}%): it is the sum of the arrangement.`); continue }
    const gainDb = -round1(Math.min(MAX_MOVE_DB, Math.max(1, found.db - RESONANCE_LEAVE_DB)))
    plan.moves.push({ kind: 'eq', track: rows[0].name, gainDb, hz, q: RESONANCE_Q, band: 'presence', code, note_id: note.id ?? null })
  }
}

/**
 * Low end that is stereo (`mono.low@<sec>`, `changed.lowwidth`): the tracks
 * with the most side energy below 120 Hz in the stretch the note names get
 * their low end narrowed to mono, most first, until the tracks together are
 * predicted mono enough. `tracks[i].low[k]` is the track's mid and side power
 * for `lowNotes[k]` (createLowWidthMeter over lowWidthWindows). When the
 * tracks are already mono and the mix is not, the width comes from a bus or
 * the output chain and no track move answers it: the note is skipped saying so.
 */
function planMono(input: { notes: PlanNote[]; tracks: PlanTrack[]; lowNotes?: string[] }, plan: InternPlan) {
  const codes = input.lowNotes ?? []
  const narrowed = new Set(plan.moves.filter(m => m.kind === 'mono').map(m => m.track))
  for (const note of input.notes ?? []) {
    const code = typeof note?.code === 'string' ? note.code : ''
    const k = codes.indexOf(code)
    if (!(code === 'changed.lowwidth' || /^mono\.low@\d+$/.test(code))) continue
    // planBands could not know this note: take back its "no rule" line.
    const at = plan.skipped.findIndex(x => x.code === code && x.note_id === (note.id ?? null))
    if (at >= 0) plan.skipped.splice(at, 1)
    const skip = (why: string) => plan.skipped.push({ note_id: note.id ?? null, code, why })
    const rows = (input.tracks ?? []).flatMap(t => {
      const low = k >= 0 ? t.low?.[k] : undefined
      return low && Number.isFinite(low.mid) && Number.isFinite(low.side) && low.mid + low.side > 0 ? [{ name: t.name, mid: low.mid, side: low.side }] : []
    })
    if (!rows.length) { skip('No exported track could be measured where this note is.'); continue }
    // Tracks add in power (they are not copies of one another): the mix's correlation is (mid − side) / (mid + side).
    const left = (name: string, side: number) => (narrowed.has(name) ? side * (1 - MONO_REMOVES) : side)
    const corr = () => {
      const mid = rows.reduce((s, r) => s + r.mid, 0), side = rows.reduce((s, r) => s + left(r.name, r.side), 0)
      return (mid - side) / (mid + side)
    }
    const before = corr()
    if (before >= MONO_GOAL) {
      if (!rows.some(r => narrowed.has(r.name))) skip(`The tracks themselves are mono down there (correlation ${before.toFixed(2)}): the width comes from a bus effect or the output chain, which the intern does not touch.`)
      continue
    }
    const sideTotal = rows.reduce((s, r) => s + r.side, 0)
    const wide = rows.filter(r => !narrowed.has(r.name) && r.side >= 0.05 * sideTotal).sort((a, b) => b.side - a.side).slice(0, MAX_TRACKS_PER_NOTE)
    const chosen: string[] = []
    for (const r of wide) {
      narrowed.add(r.name); chosen.push(r.name)
      if (corr() >= MONO_GOAL) break
    }
    if (corr() < MONO_GOAL) {
      for (const name of chosen) narrowed.delete(name)
      skip(`Narrowing the ${wide.length} widest track${wide.length === 1 ? '' : 's'} would only bring the low end to a correlation of ${corr().toFixed(2)}: it is wide across the arrangement, which is a mix decision.`)
      continue
    }
    for (const track of chosen) plan.moves.push({ kind: 'mono', track, gainDb: 0, hz: LOW_WIDTH_HZ.hi, band: 'sub', code, note_id: note.id ?? null })
  }
}

function planBands(input: { notes: PlanNote[]; bands: PlanBand[]; tracks: PlanTrack[] }): InternPlan {
  const state = new Map<string, Float64Array>()
  for (const t of input.tracks ?? []) {
    if (!t || typeof t.name !== 'string' || !Array.isArray(t.spec) || t.spec.length !== N) continue
    const spec = Float64Array.from(t.spec, x => (Number.isFinite(x) && x > 0 ? x : 0))
    if (spec.some(x => x > 0) && !state.has(t.name)) state.set(t.name, spec)
  }
  const before: (number | null)[] = MIX_BANDS.map(band => {
    const v = (input.bands ?? []).find(b => b && b.key === band.key)?.vsPrevious
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  })
  const moves: InternMove[] = []
  const skipped: InternPlan['skipped'] = []
  const plan = (after: (number | null)[], loudnessShift: number): InternPlan => ({
    moves, skipped,
    predicted: MIX_BANDS.map((band, i) => ({ key: band.key, before: before[i], after: after[i] == null ? null : round1(after[i]!) })),
    loudnessShift: round1(loudnessShift),
  })

  // Each band against the artist's own catalog, as it is in this bounce (`balance.<band>` notes).
  const beforeCat: (number | null)[] = MIX_BANDS.map(band => {
    const v = (input.bands ?? []).find(b => b && b.key === band.key)?.vsCatalog
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  })
  const todo: { note: PlanNote; band: number; cat: boolean }[] = []
  for (const note of input.notes ?? []) {
    const code = typeof note?.code === 'string' ? note.code : null
    const band = code?.startsWith('changed.') ? MIX_BANDS.findIndex(b => `changed.${b.key}` === code) : -1
    if (band >= 0 && before[band] != null) { todo.push({ note, band, cat: false }); continue }
    const catBand = code?.startsWith('balance.') ? MIX_BANDS.findIndex(b => `balance.${b.key}` === code) : -1
    if (catBand >= 0 && beforeCat[catBand] != null) { todo.push({ note, band: catBand, cat: true }); continue }
    if (code && /^resonance\.\d+$/.test(code)) continue // planResonances
    skipped.push({
      note_id: note?.id ?? null, code,
      why: note?.kind === 'listener' ? 'A written note needs a person\'s judgment; the intern only fixes what Mix Check measured.'
        : 'There is no rule for this kind of note yet.',
    })
  }
  if (!todo.length) return plan(before, 0)
  if (!state.size) {
    for (const { note } of todo) skipped.push({ note_id: note.id ?? null, code: note.code ?? null, why: 'No exported track could be measured.' })
    return plan(before, 0)
  }
  const size = (t: { band: number; cat: boolean }) => Math.abs((t.cat ? beforeCat : before)[t.band]!)
  todo.sort((a, b) => Number(a.cat) - Number(b.cat) || size(b) - size(a)) // what changed first, then what is unusual

  const start = levels(state)
  // Each band's change since the previous version, were the tracks in `s`.
  const predict = (s: Map<string, Float64Array>) => {
    const now = levels(s)
    const shift = now.loud - start.loud
    const delta = (i: number) => (now.bands[i] - now.loud) - (start.bands[i] - start.loud)
    return { vs: before.map((v, i) => (v == null ? null : v + delta(i))), cat: beforeCat.map((v, i) => (v == null ? null : v + delta(i))), shift }
  }
  type Predicted = ReturnType<typeof predict>
  // The figure a note is about: the band against the previous version, or against the catalog.
  const read = (p: Predicted, band: number, cat: boolean) => (cat ? p.cat : p.vs)[band]!
  const withMove = (s: Map<string, Float64Array>, m: InternMove) => new Map(s).set(m.track, moved(s.get(m.track)!, m))
  // Fine = nothing that was fine is pushed towards a note, nothing flagged is made worse, loudness holds.
  const sideOk = (from: (number | null)[], to: { vs: (number | null)[]; shift: number }, band: number) =>
    Math.abs(to.shift) <= LOUDNESS_LIMIT_DB &&
    to.vs.every((v, i) => i === band || v == null || Math.abs(v) < SIDE_LIMIT_DB || Math.abs(v) <= Math.abs(from[i]!) + 0.05)
  // How far a move shifts the other bands themselves (before loudness matching): what it does besides its job.
  const side = (from: Map<string, Float64Array>, to: Map<string, Float64Array>, band: number) => {
    const a = levels(from).bands, b = levels(to).bands
    return Math.max(0, ...a.map((v, i) => (i === band ? 0 : Math.abs(b[i] - v))))
  }
  // The gain (within ±MAX_MOVE_DB) that puts the band nearest the goal. More gain always means more of the band.
  const solve = (s: Map<string, Float64Array>, m: InternMove, band: number, goal: number, cat = false): InternMove => {
    const limit = cat ? CATALOG_MAX_MOVE_DB : MAX_MOVE_DB
    let lo = -limit, hi = limit
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (read(predict(withMove(s, { ...m, gainDb: mid })), band, cat) < goal) lo = mid; else hi = mid
    }
    return { ...m, gainDb: round1((lo + hi) / 2) }
  }

  for (const { note, band, cat } of todo) {
    const key = MIX_BANDS[band].key
    const now = predict(state)
    const cur = read(now, band, cat)
    const clear = cat ? CATALOG_CLEAR_DB : CLEAR_DB
    if (Math.abs(cur) <= clear) continue // an earlier move already answered it
    const goal = Math.sign(cur) * (cat ? CATALOG_AIM_DB : AIM_DB)
    const share = (spec: Float64Array) => BAND_BINS[band].reduce((s, i) => s + spec[i], 0)
    const carriers = [...state.entries()].map(([name, spec]) => ({ name, power: share(spec) }))
      .filter(c => c.power > 0).sort((a, b) => b.power - a.power).slice(0, MAX_TRACKS_PER_NOTE)
    const base = { band: key, code: note.code!, note_id: note.id ?? null }

    // One move on one track. A level move that leaves the rest of the mix alone
    // is the plainest answer (one channel moved, move it back), so any carrier
    // that allows one wins; otherwise a bell on the track carrying most of the band.
    let best: { move: InternMove; rank: number } | null = null
    carriers.forEach((c, rank) => {
      for (const kind of ['level', 'eq'] as const) {
        const move = solve(state, { kind, track: c.name, gainDb: 0, ...(kind === 'eq' ? bellFor(key) : {}), ...base }, band, goal, cat)
        const tried = withMove(state, move)
        const after = predict(tried)
        if (Math.abs(read(after, band, cat)) > clear || !sideOk(now.vs, after, band)) continue
        if (kind === 'level' && side(state, tried, band) > LEVEL_SIDE_DB) continue
        const better = !best || (kind === 'level' && best.move.kind === 'eq') || (kind === best.move.kind && rank < best.rank)
        if (better) best = { move, rank }
      }
    })
    if (best) {
      const chosen = (best as { move: InternMove }).move
      moves.push(chosen)
      state.set(chosen.track, moved(state.get(chosen.track)!, chosen))
      continue
    }

    // No single track carries enough of it: a bell on each carrier in turn.
    let trial = state
    const set: InternMove[] = []
    let reached = false
    for (const c of carriers) {
      const move = solve(trial, { kind: 'eq', track: c.name, gainDb: 0, ...bellFor(key), ...base }, band, goal, cat)
      if (Math.abs(move.gainDb) < 0.3) continue
      trial = withMove(trial, move)
      set.push(move)
      const after = predict(trial)
      if (Math.abs(read(after, band, cat)) <= clear) { reached = sideOk(now.vs, after, band); break }
    }
    if (reached) {
      moves.push(...set)
      state.clear()
      for (const [name, spec] of trial) state.set(name, spec)
      continue
    }
    skipped.push({
      note_id: note.id ?? null, code: note.code ?? null,
      why: `No move of up to ${cat ? CATALOG_MAX_MOVE_DB : MAX_MOVE_DB} dB on the ${carriers.length === 1 ? 'track' : `${carriers.length} tracks`} carrying ${MIX_BANDS[band].label.toLowerCase()} clears this without disturbing the rest of the mix.`,
    })
  }

  const end = predict(state)
  return plan(end.vs, end.shift)
}

/**
 * The next size to try when the bounce did not move the band as predicted
 * (bus processing, a limiter, tracks the export did not include).
 * `wantedDb` is the change the move was meant to make in its band and
 * `observedDb` the change Mix Check measured. Null = stop: the move did
 * nothing, went the wrong way, is already right, or is at its limit.
 */
export function refineMove(move: InternMove, wantedDb: number, observedDb: number): InternMove | null {
  if (![wantedDb, observedDb, move.gainDb].every(Number.isFinite) || wantedDb === 0 || move.gainDb === 0) return null
  if (Math.sign(observedDb) !== Math.sign(wantedDb) || Math.abs(observedDb) < 0.25 * Math.abs(wantedDb)) return null
  const scale = Math.max(0.5, Math.min(2, wantedDb / observedDb))
  const gainDb = round1(Math.max(-MAX_MOVE_DB, Math.min(MAX_MOVE_DB, move.gainDb * scale)))
  return Math.abs(gainDb - move.gainDb) < 0.2 ? null : { ...move, gainDb }
}

/** A move as a line of the job's change list (PATCH /api/intern/jobs/<id> `changes`). */
export function describeMove(move: InternMove): { track: string; what: string; from: string; to: string; note_id?: string } {
  if (move.kind === 'lowcut') {
    return { track: move.track, what: `Low cut at ${move.hz} Hz`, from: 'off', to: 'on', ...(move.note_id ? { note_id: move.note_id } : {}) }
  }
  if (move.kind === 'level' && move.balancePct && !move.gainDb) {
    return { track: move.track, what: 'Balance', from: 'centre', to: `${Math.abs(move.balancePct).toFixed(0)}% ${move.balancePct > 0 ? 'right' : 'left'}`, ...(move.note_id ? { note_id: move.note_id } : {}) }
  }
  if (move.kind === 'mono') {
    return { track: move.track, what: `Low end made mono below ${move.hz} Hz`, from: 'stereo', to: 'mono', ...(move.note_id ? { note_id: move.note_id } : {}) }
  }
  const signed = `${move.gainDb > 0 ? '+' : move.gainDb < 0 ? '−' : ''}${Math.abs(move.gainDb).toFixed(1)} dB`
  return {
    track: move.track,
    what: move.kind === 'level' ? 'Level' : `EQ bell at ${move.hz} Hz (Q ${move.q})`,
    from: '0.0 dB',
    to: signed,
    ...(move.note_id ? { note_id: move.note_id } : {}),
  }
}

// ── The judge ────────────────────────────────────────────────────────────────

/** Never chased, so never counted for or against a fix (intern-jobs.ts NEVER_HANDED). */
const NOT_JUDGED = (code: string) => code === 'genre.balance'

/** Two timed notes of a kind this many seconds apart are the same note, moved. */
const SAME_PLACE_S = 40

/** A note's kind without its place: 'drop.smaller@157' and 'resonance.3175'
 *  name a second or a frequency that a new bounce can shift by one. */
const kindOf = (code: string) => (code.startsWith('resonance.') ? 'resonance' : code.split('@')[0])

/**
 * Mix Check's verdict on a fix: the findings of the handed mix, the findings
 * of the new bounce (measured against the SAME earlier version), and the codes
 * the moves were meant to clear. Keep the fix only when every one of them is
 * gone and no note appeared that was not there before (more notes of a kind
 * than before counts as one appearing).
 */
export function judgeFix(before: { code: string }[], after: { code: string }[], handled: string[]) {
  const count = (list: { code: string }[]) => {
    const m = new Map<string, number>()
    for (const f of list ?? []) if (!NOT_JUDGED(f.code)) m.set(kindOf(f.code), (m.get(kindOf(f.code)) ?? 0) + 1)
    return m
  }
  const was = count(before), is = count(after)
  // A note tied to a moment ('mono.low@95') is still there when one of its
  // kind sits within SAME_PLACE_S of it: a new bounce can shift it by a second.
  const second = (code: string) => { const m = /@(\d+)$/.exec(code); return m ? Number(m[1]) : null }
  const hzOf = (code: string) => { const m = /^resonance\.(\d+)$/.exec(code); return m ? Number(m[1]) : null }
  const stillThere = (code: string) => (after ?? []).some(f => {
    if (f.code === code) return true
    const ha = hzOf(code), hb = hzOf(f.code)
    if (ha != null && hb != null) return Math.abs(hb - ha) / ha < 0.06
    const a = second(code), b = second(f.code)
    return a != null && b != null && kindOf(f.code) === kindOf(code) && Math.abs(a - b) <= SAME_PLACE_S
  })
  const cleared = handled.filter(c => !stillThere(c))
  const remaining = handled.filter(c => stillThere(c))
  const appeared = [...is].filter(([kind, n]) => n > (was.get(kind) ?? 0)).map(([kind]) => kind)
  return { keep: handled.length > 0 && remaining.length === 0 && appeared.length === 0, cleared, remaining, appeared }
}

/**
 * The findings a Mac can judge by itself: everything Mix Check finds from the
 * bounce and the earlier mix alone. Comparisons with the catalog and the
 * genre need the server's data ('balance.lr', left against right, does not).
 */
export function locallyJudged<T extends { code: string }>(findings: T[]): T[] {
  return (findings ?? []).filter(f => f.code === 'balance.lr' || !(f.code.startsWith('balance.') || f.code === 'genre.balance'))
}
