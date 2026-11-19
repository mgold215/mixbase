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

// ── Trying a move on the measurements ────────────────────────────────────────

export type InternMove = {
  /** 'level' = the whole track up or down; 'eq' = one bell on the track. */
  kind: 'level' | 'eq'
  track: string
  gainDb: number
  /** The bell's centre and Q, for an 'eq' move. */
  hz?: number
  q?: number
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
type PlanBand = { key: string; vsPrevious?: number | null }
type PlanTrack = { name: string; spec: number[] }

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
export function planFixes(input: { notes: PlanNote[]; bands: PlanBand[]; tracks: PlanTrack[] }): InternPlan {
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

  const todo: { note: PlanNote; band: number }[] = []
  for (const note of input.notes ?? []) {
    const code = typeof note?.code === 'string' ? note.code : null
    const band = code?.startsWith('changed.') ? MIX_BANDS.findIndex(b => `changed.${b.key}` === code) : -1
    if (band >= 0 && before[band] != null) { todo.push({ note, band }); continue }
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
  todo.sort((a, b) => Math.abs(before[b.band]!) - Math.abs(before[a.band]!))

  const start = levels(state)
  // Each band's change since the previous version, were the tracks in `s`.
  const predict = (s: Map<string, Float64Array>) => {
    const now = levels(s)
    const shift = now.loud - start.loud
    return { vs: before.map((v, i) => (v == null ? null : v + (now.bands[i] - now.loud) - (start.bands[i] - start.loud))), shift }
  }
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
  const solve = (s: Map<string, Float64Array>, m: InternMove, band: number, goal: number): InternMove => {
    let lo = -MAX_MOVE_DB, hi = MAX_MOVE_DB
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (predict(withMove(s, { ...m, gainDb: mid })).vs[band]! < goal) lo = mid; else hi = mid
    }
    return { ...m, gainDb: round1((lo + hi) / 2) }
  }

  for (const { note, band } of todo) {
    const key = MIX_BANDS[band].key
    const now = predict(state)
    const cur = now.vs[band]!
    if (Math.abs(cur) <= CLEAR_DB) continue // an earlier move already answered it
    const goal = Math.sign(cur) * AIM_DB
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
        const move = solve(state, { kind, track: c.name, gainDb: 0, ...(kind === 'eq' ? bellFor(key) : {}), ...base }, band, goal)
        const tried = withMove(state, move)
        const after = predict(tried)
        if (Math.abs(after.vs[band]!) > CLEAR_DB || !sideOk(now.vs, after, band)) continue
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
      const move = solve(trial, { kind: 'eq', track: c.name, gainDb: 0, ...bellFor(key), ...base }, band, goal)
      if (Math.abs(move.gainDb) < 0.3) continue
      trial = withMove(trial, move)
      set.push(move)
      const after = predict(trial)
      if (Math.abs(after.vs[band]!) <= CLEAR_DB) { reached = sideOk(now.vs, after, band); break }
    }
    if (reached) {
      moves.push(...set)
      state.clear()
      for (const [name, spec] of trial) state.set(name, spec)
      continue
    }
    skipped.push({
      note_id: note.id ?? null, code: note.code ?? null,
      why: `No move of up to ${MAX_MOVE_DB} dB on the ${carriers.length === 1 ? 'track' : `${carriers.length} tracks`} carrying ${MIX_BANDS[band].label.toLowerCase()} clears this without disturbing the rest of the mix.`,
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
  const still = new Set((after ?? []).map(f => f.code))
  const cleared = handled.filter(c => !still.has(c))
  const remaining = handled.filter(c => still.has(c))
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
