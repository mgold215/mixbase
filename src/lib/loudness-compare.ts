// ─── Cross-version loudness comparison ───────────────────────────────────────
// src/lib/loudness.ts answers "how loud is this bounce". This module answers the
// question that only a version-history app can ask: "what did the last render
// actually change?" — and separates the two things a louder master can mean.
//
// A mix that comes back 3 dB louder either had its FADER moved (everything rose
// together, the peaks included) or had its DYNAMICS spent (the average rose but
// the loudest 3 s barely did, because a limiter ate the difference). Those look
// identical on a single LUFS readout and identical in a DAW, which only ever has
// one bounce in front of it. Subtracting the short-term delta from the
// integrated delta separates them exactly:
//
//   crestSpentDb = integratedDeltaDb − shortTermDeltaDb
//
// 3.0 dB louder overall while the loudest 3 s moved 0.4 dB ⇒ 2.6 dB of that
// came out of the crest factor, not the fader.
//
// TWO RULES GOVERN EVERYTHING BELOW:
//
//  1. THE MESSAGES ARE DELTA-ONLY. No rule may read an absolute LUFS band. The
//     user's canon is that −8 to −5 LUFS is the NORM for EDM/techno and must
//     never be scolded, not even by implication, and masterVerdict() already
//     honours it. A rule that fires on "you are now above −6" would smuggle
//     that judgement back in through the comparison. scripts/loudness-compare-test.mjs
//     enforces this mechanically: shifting BOTH measurements by −8 dB must
//     produce a byte-identical `lines` array, which is only possible if every
//     rule reads differences. The single legitimate exception is the peak
//     ceiling, which is a lossy-transcode fact, not a taste call — see below.
//
//  2. IT IS PURE. No DOM, no fetch, no storage — the API route, the React
//     component and the node test all load this same module. Relative imports
//     carry their `.ts` extension because an extensionless one blocks Node's
//     type-stripping, which is what lets the test suite import the real thing
//     instead of a copy.

import type { LoudnessIssue, LoudnessMeasurement } from './loudness.ts'

/**
 * A measurement that has passed validation, with every field that could not be
 * trusted (or that was genuinely absent) collapsed to null.
 *
 * Null is not an error state: `measureLoudness` returns -Infinity for silence,
 * which JSON-serializes to null, and that is a truthful "there is no number
 * here" rather than a corrupt payload.
 */
export type LoudnessInput = {
  integratedLufs: number | null
  shortTermMaxLufs: number | null
  samplePeakDb: number | null
  gatedBlockCount: number | null
}

/** The mb_versions columns added by migration 032, as PostgREST returns them. */
export type VersionLoudnessRow = {
  loudness_lufs?: number | null
  loudness_short_term_lufs?: number | null
  sample_peak_db?: number | null
  loudness_measured_at?: string | null
  loudness_algo?: string | null
}

/**
 * Which implementation produced a stored row. Bump this if the K-weighting, the
 * gating, or the short-term window ever changes, so old and new numbers can be
 * told apart instead of being silently subtracted from each other.
 */
export const LOUDNESS_ALGO = 'bs1770-4-v1'

// Ranges a real measurement can occupy. Integrated and short-term loudness are
// bounded below by BS.1770's own absolute gate (−70 LUFS — below it nothing is
// measured at all) and above by full scale.
const MIN_LUFS = -70
const MAX_LUFS = 0
// Sample peak gets a much wider window on purpose: float PCM legitimately
// exceeds 0 dBFS (a bounce can overshoot without clipping the file), so a hard
// 0 ceiling would reject honest measurements from real 32-bit float masters.
const MIN_PEAK_DB = -100
const MAX_PEAK_DB = 6

// Below this the two mixes are the same level. 0.3 dB is under the threshold at
// which anyone hears a difference and is comfortably inside the variation two
// exports of the same session can show, so claiming a change here would be
// inventing signal out of noise.
const SAME_LEVEL_DB = 0.3

// How much crest factor has to move before it is worth naming. Under 1 dB the
// peaks and the average effectively moved together, and calling that "limiting"
// would make the readout cry wolf on every ordinary gain change.
const CREST_MOVED_DB = 1.0

// The ONE absolute number in this module, and it is not a taste judgement:
// lossy encoders overshoot on transcode, so peaks above −0.1 dBFS can clip on
// Spotify/Apple regardless of genre or intended level. Same constant
// masterVerdict() already uses.
const PEAK_CEILING_DB = -0.1

/**
 * Validate one number out of an untrusted payload.
 *
 * Deliberately NOT `Number.isFinite` alone. The values that must be rejected
 * here are the ones that survive a finiteness check: a numeric STRING (`'-9.2'`
 * — which would then be *concatenated* rather than subtracted downstream), and a
 * number outside anything a measurement can produce (−200, +40 — a client that
 * sent a percentage, a byte count, or a flipped sign). A junk value stored once
 * is permanent: every later delta reads it, and the UI has no way to hint that
 * the nonsense came from the payload rather than from the mix.
 */
function inRange(raw: unknown, min: number, max: number): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  if (raw < min || raw > max) return null
  return raw
}

function nonNegativeInt(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return null
  return raw
}

/**
 * Turn an untrusted payload (an API request body, a localStorage blob, a DB row)
 * into a LoudnessInput, or null when there is no measurement in it at all.
 *
 * Field-level degradation is the point: one unusable number must not discard the
 * others. Silence is the case that proves it — `measureLoudness` reports
 * -Infinity for the integrated loudness of a silent bounce, JSON turns that into
 * null, and the result is still a valid measurement of a real file.
 */
export function sanitizeLoudness(raw: unknown): LoudnessInput | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const m: LoudnessInput = {
    integratedLufs: inRange(r.integratedLufs, MIN_LUFS, MAX_LUFS),
    shortTermMaxLufs: inRange(r.shortTermMaxLufs, MIN_LUFS, MAX_LUFS),
    samplePeakDb: inRange(r.samplePeakDb, MIN_PEAK_DB, MAX_PEAK_DB),
    gatedBlockCount: nonNegativeInt(r.gatedBlockCount),
  }
  // Nothing at all survived — this is a shape, not a measurement. (A silent
  // bounce still lands here with gatedBlockCount 0, so it is kept.)
  if (
    m.integratedLufs === null && m.shortTermMaxLufs === null &&
    m.samplePeakDb === null && m.gatedBlockCount === null
  ) return null
  return m
}

/**
 * Widen a validated measurement back into the LoudnessMeasurement shape that
 * formatLufs/masterVerdict/dspDeltas expect, where "no number" means silence and
 * silence is -Infinity. This is the restore-by-hand step MasterCheck used to do
 * inline against localStorage; sharing it keeps the DB path and the cache path
 * from drifting.
 */
export function toMeasurement(m: LoudnessInput): LoudnessMeasurement {
  return {
    integratedLufs: m.integratedLufs ?? -Infinity,
    shortTermMaxLufs: m.shortTermMaxLufs ?? -Infinity,
    samplePeakDb: m.samplePeakDb ?? -Infinity,
    gatedBlockCount: m.gatedBlockCount ?? 0,
  }
}

/**
 * Read a stored measurement off a mb_versions row, re-validating on the way in.
 *
 * `loudness_measured_at` is the authoritative "this was measured" marker — a row
 * carrying numbers but no timestamp predates or bypassed the API and is treated
 * as unmeasured. Re-sanitizing on read means a row written by an older or
 * buggier client can never feed a nonsense delta.
 *
 * Takes `unknown` rather than VersionLoudnessRow deliberately. Callers pass a
 * whole `Version` object, whose declared type does not (and should not) list the
 * migration-032 columns — TypeScript's weak-type check rejects that against an
 * all-optional shape, and widening the Version type here would put five columns
 * that only this module reads into every consumer of it. Same idiom as
 * sanitizeLoudness: untrusted shape in, validated value out.
 */
export function loudnessFromRow(row: unknown): LoudnessInput | null {
  if (typeof row !== 'object' || row === null) return null
  const r = row as VersionLoudnessRow
  if (r.loudness_measured_at == null) return null
  const clean = sanitizeLoudness({
    integratedLufs: r.loudness_lufs,
    shortTermMaxLufs: r.loudness_short_term_lufs,
    samplePeakDb: r.sample_peak_db,
    // Not a stored column: the gated block count is a sanity signal at measure
    // time, and the comparison never reads it.
    gatedBlockCount: null,
  })
  // A silent bounce measures -Infinity on every field and stores as all-nulls,
  // which sanitizeLoudness rejects (an all-null PAYLOAD is a client sending
  // nothing). Here the timestamp already proves the measurement happened, so the
  // row must still read back as measured — otherwise callers that ask "does this
  // version have a reading?" get `null` forever and re-post the same backfill on
  // every mount.
  return clean ?? { integratedLufs: null, shortTermMaxLufs: null, samplePeakDb: null, gatedBlockCount: null }
}

/**
 * The five persisted columns for a validated measurement.
 *
 * `measuredAt` must be the SERVER clock. A client timestamp is worth nothing
 * here: a wrong device clock (or a forged one) reorders the measurement history
 * that every later comparison is read from.
 */
export function toLoudnessColumns(m: LoudnessInput, measuredAt: string): Required<VersionLoudnessRow> {
  return {
    loudness_lufs: m.integratedLufs,
    loudness_short_term_lufs: m.shortTermMaxLufs,
    sample_peak_db: m.samplePeakDb,
    loudness_measured_at: measuredAt,
    loudness_algo: LOUDNESS_ALGO,
  }
}

export type LoudnessComparison = {
  /** next − prev, in dB. Positive means the newer mix is louder. */
  integratedDeltaDb: number
  /** Same subtraction over the loudest 3 s window. */
  shortTermDeltaDb: number
  /** integratedDeltaDb − shortTermDeltaDb. Positive = the average climbed more
   *  than the peaks did, i.e. crest factor was spent on limiting. */
  crestSpentDb: number
  /** Same {level, message} shape as masterVerdict(), so MasterCheck renders
   *  these through the exact renderer it already has. */
  lines: LoudnessIssue[]
}

/**
 * Compare two measured mixes, oldest first.
 *
 * Returns null unless BOTH sides carry an integrated AND a short-term number.
 * A half-measurement is not shown at all rather than shown with a hole in it:
 * the crest-factor line is the entire reason this exists, and an integrated
 * delta on its own is the ambiguous number the feature was built to disambiguate.
 */
export function compareLoudness(
  prev: LoudnessInput | null | undefined,
  next: LoudnessInput | null | undefined,
): LoudnessComparison | null {
  if (!prev || !next) return null
  if (prev.integratedLufs === null || next.integratedLufs === null) return null
  if (prev.shortTermMaxLufs === null || next.shortTermMaxLufs === null) return null

  const integratedDeltaDb = next.integratedLufs - prev.integratedLufs
  const shortTermDeltaDb = next.shortTermMaxLufs - prev.shortTermMaxLufs
  const crestSpentDb = integratedDeltaDb - shortTermDeltaDb

  // Every figure is rendered from a MAGNITUDE with the direction carried by the
  // words, so no message ever shows a bare signed number the reader has to
  // interpret ("−0.4 dB louder" is a puzzle, "0.4 dB quieter" is a fact).
  const db = (x: number) => Math.abs(x).toFixed(1)
  const moved = (x: number) => (x >= 0 ? `up ${db(x)} dB` : `down ${db(x)} dB`)

  const lines: LoudnessIssue[] = []

  if (Math.abs(integratedDeltaDb) < SAME_LEVEL_DB) {
    lines.push({
      level: 'info',
      message: `Same level as the previous mix — ${db(integratedDeltaDb)} dB apart, which is inside the margin of a re-export.`,
    })
  } else if (integratedDeltaDb > 0) {
    lines.push({ level: 'info', message: `${db(integratedDeltaDb)} dB louder than the previous mix.` })
    if (crestSpentDb > CREST_MOVED_DB) {
      lines.push({
        level: 'warning',
        message: `The loudest 3 s only moved ${moved(shortTermDeltaDb)}, so ${db(crestSpentDb)} dB of the change came out of the dynamics — that is limiting, not level.`,
      })
    } else {
      lines.push({ level: 'info', message: 'The peaks moved with it — a level change, not extra limiting.' })
    }
  } else {
    lines.push({ level: 'info', message: `${db(integratedDeltaDb)} dB quieter than the previous mix.` })
    if (crestSpentDb < -CREST_MOVED_DB) {
      lines.push({
        level: 'info',
        message: `The loudest 3 s only moved ${moved(shortTermDeltaDb)}, so ${db(crestSpentDb)} dB of the change went back into the dynamics — the peaks have room again.`,
      })
    } else {
      lines.push({ level: 'info', message: 'The peaks moved with it — a level change, not less limiting.' })
    }
  }

  // Peak headroom, reported only as a CROSSING: the previous mix sat under the
  // ceiling and this one does not. The standing state is masterVerdict's job and
  // is already rendered directly beneath this block — repeating it here would be
  // noise, while the crossing is genuinely new information about the change.
  // Both sides must be known; an unknown previous peak cannot evidence a
  // crossing, so it stays quiet rather than guessing.
  if (
    next.samplePeakDb !== null && prev.samplePeakDb !== null &&
    next.samplePeakDb > PEAK_CEILING_DB && prev.samplePeakDb <= PEAK_CEILING_DB
  ) {
    lines.push({
      level: 'warning',
      message: `Headroom went with it — peaks now reach ${next.samplePeakDb.toFixed(1)} dBFS where the previous mix stayed clear of the ceiling; lossy transcodes can clip that.`,
    })
  }

  return { integratedDeltaDb, shortTermDeltaDb, crestSpentDb, lines }
}
