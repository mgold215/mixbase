// The mastering engineer's rules — the second pass over a mix the intern has
// handed on, working on the OUTPUT channel only. Pure, no AI. It takes the
// whole-mix notes that are not a single track's fault, makes small moves, each
// a plug-in added last on the output strip of the intern's copy, and Mix Check
// judges the bounce again. A move that does not hold is taken back and the
// intern's own bounce is what is uploaded: the mastering engineer can only
// leave a mix as good as it found it, or better.
// No '@/…' imports: scripts/mastering-rules-test.mjs loads this through Node.

import { MIX_BANDS, type MixBandKey } from './mix-check.ts'
import { bellFor, LOW_WIDTH_HZ, type InternMove } from './intern-rules.ts'

// ── The numbers the rules turn on ────────────────────────────────────────────

/** No mastering move is larger than this: past it, it is a mix decision. */
export const MASTER_MAX_DB = 2
/** Mix Check writes `balance.<band>` at this distance from the catalog average. */
const BALANCE_NOTE_DB = 3
/** A balance move aims this far inside the note. */
const BALANCE_AIM_DB = 2.5
/** A wide bell moves its own band by about this much of its gain. */
const BELL_REACH = 0.7
/** A master's true peak is brought down to this (the ceiling Mix Check recommends). */
export const CEILING_DBTP = -1
/** The most the output is trimmed to get there. */
const MAX_TRIM_DB = 3
/** Mix Check writes `changed.loudness` at this much; a move aims this close to the earlier mix. */
const LOUDNESS_NOTE_LU = 1.5
const LOUDNESS_AIM_LU = 1.0
/** Two timed notes of a kind this many seconds apart are the same note. */
const SAME_PLACE_S = 40

/** Which notes the mastering engineer has a rule for. */
export function masteringHasRule(code: string | null | undefined): boolean {
  if (!code) return false
  return MIX_BANDS.some(b => code === `balance.${b.key}`) || /^mono\.low@\d+$/.test(code) || OUTPUT_NOTES.includes(code)
}

/** Whole-file notes answered on the output channel or in the bounce itself. */
const OUTPUT_NOTES = ['peak.over', 'peak.clip', 'changed.loudness', 'balance.lr', 'dc.offset', 'tail.cut']

/** The notes it can tell cleared from a bounce alone (the catalog comparison needs the server). */
export const masteringJudgedLocally = (code: string) => OUTPUT_NOTES.includes(code) || /^mono\.low@\d+$/.test(code)

type Note = { id?: string | null; code?: string | null }
type Band = { key: string; vsPrevious?: number | null; vsCatalog?: number | null }

export type MasteringPlan = {
  /** Moves for the output strip; `track` is filled in by the caller with the strip's name. */
  moves: InternMove[]
  /** Notes answered by one of the moves without a move of their own (one trim serves a peak and a loudness note). */
  alsoAnswers: string[]
  /** How the bounce itself must be made: with the audio tail, for an ending that was cut off. */
  bounce: { tail?: boolean }
  /** Notes it has a rule for and made no move on, and why. */
  skipped: { note_id: string | null; code: string; why: string }[]
}

const round1 = (x: number) => Math.round(x * 10) / 10
const second = (code: string) => { const m = /@(\d+)$/.exec(code); return m ? Number(m[1]) : null }

/**
 * Chooses the output-channel moves.
 *
 *   notes         the job's notes (id, code)
 *   handedBands   the handed mix's Mix Check bands (vsPrevious, vsCatalog)
 *   bounce        the bounce it is working on (the intern's, or the project's own):
 *                 each band against the same earlier mix, its findings, its true peak
 *   answered      codes the intern already made a move for
 *
 * - `balance.<band>` heavy against the artist's catalog: one wide bell cut on
 *   the band, sized from where the band is NOW (the intern's moves may have
 *   shifted it), never over MASTER_MAX_DB. A band that is LIGHT is left: a
 *   boost after the limiter would push the peaks over.
 * - `mono.low@<sec>` still in the bounce and not answered on a track: the low
 *   end of the whole mix is narrowed to mono below 120 Hz. One move covers
 *   every such note.
 * - `peak.over`: the output is trimmed to a true peak of CEILING_DBTP.
 */
export function planMastering(input: {
  notes: Note[]
  handedBands: Band[]
  bounce: {
    bands: { key: string; after: number | null }[]; findings: { code: string }[]; truePeakDb: number | null
    /** Its loudness, and how much louder the left is than the right (dB), when measured. */
    integratedLufs?: number | null; balanceDb?: number | null
  }
  /** The loudness of the earlier mix the notes compare with. */
  previousLufs?: number | null
  answered?: string[]
}): MasteringPlan {
  const moves: InternMove[] = []
  const skipped: MasteringPlan['skipped'] = []
  const alsoAnswers: string[] = []
  const bounceOptions: MasteringPlan['bounce'] = {}
  // Everything that asks for the output to come down is answered by ONE trim, the largest asked for.
  const trims: { code: string; note_id: string | null; db: number }[] = []
  const answered = new Set(input.answered ?? [])
  const stillThere = (code: string) => (input.bounce.findings ?? []).some(f => {
    if (f.code === code) return true
    const a = second(code), b = second(f.code)
    return a != null && b != null && f.code.split('@')[0] === code.split('@')[0] && Math.abs(a - b) <= SAME_PLACE_S
  })
  let narrowed = false
  for (const note of input.notes ?? []) {
    const code = typeof note?.code === 'string' ? note.code : ''
    if (!masteringHasRule(code)) continue
    const note_id = note.id ?? null
    const skip = (why: string) => skipped.push({ note_id, code, why })

    if (code.startsWith('balance.') && code !== 'balance.lr') {
      if (answered.has(code)) continue // the intern moved the tracks that carry it
      const key = code.slice('balance.'.length) as MixBandKey
      const handed = (input.handedBands ?? []).find(b => b.key === key)
      const now = (input.bounce.bands ?? []).find(b => b.key === key)?.after
      if (!handed || typeof handed.vsCatalog !== 'number') { skip('The comparison with your catalog is missing for this band.'); continue }
      // Where the band sits against the catalog in THIS bounce: the handed figure, moved by what changed since.
      const shift = typeof now === 'number' && typeof handed.vsPrevious === 'number' ? now - handed.vsPrevious : 0
      const vs = handed.vsCatalog + shift
      if (Math.abs(vs) < BALANCE_NOTE_DB) { skip(`Already back inside your usual range (${vs > 0 ? '+' : ''}${round1(vs).toFixed(1)} dB against your catalog) after the moves before this.`); continue }
      if (vs < 0) { skip('It is LIGHT against your catalog: a boost on the output, after the limiter, would push the peaks over. Raise it in the mix.'); continue }
      const gainDb = -round1(Math.min(MASTER_MAX_DB, (vs - BALANCE_AIM_DB) / BELL_REACH))
      moves.push({ kind: 'eq', track: '', gainDb, ...bellFor(key), band: key, code, note_id })
      continue
    }
    if (code === 'peak.over' || code === 'peak.clip') {
      const tp = input.bounce.truePeakDb
      if (typeof tp !== 'number' || !Number.isFinite(tp) || tp <= CEILING_DBTP) { skip('The true peak is already at or under −1 dBTP in this bounce.'); continue }
      trims.push({ code, note_id, db: Math.min(MAX_TRIM_DB, tp - CEILING_DBTP) })
      continue
    }
    if (code === 'changed.loudness') {
      const now = input.bounce.integratedLufs, was = input.previousLufs
      if (typeof now !== 'number' || typeof was !== 'number' || !Number.isFinite(now) || !Number.isFinite(was)) { skip('The loudness of the earlier mix is not known here.'); continue }
      const dl = now - was
      if (Math.abs(dl) < LOUDNESS_NOTE_LU) { skip(`Already within ${LOUDNESS_NOTE_LU} LU of the earlier mix in this bounce.`); continue }
      if (dl > 0) { trims.push({ code, note_id, db: Math.min(MAX_TRIM_DB, dl - LOUDNESS_AIM_LU) }); continue }
      // Quieter: it can only come up as far as the peaks allow.
      const room = typeof input.bounce.truePeakDb === 'number' ? CEILING_DBTP - input.bounce.truePeakDb : 0
      const up = Math.min(-dl - LOUDNESS_AIM_LU, room, MAX_TRIM_DB)
      if (up < 0.5) { skip(`It is ${Math.abs(dl).toFixed(1)} LU quieter than the earlier mix, and the peaks leave no room to bring the output up: that takes more limiting, which is your call.`); continue }
      moves.push({ kind: 'level', track: '', gainDb: round1(up), band: 'sub', code, note_id })
      continue
    }
    if (code === 'balance.lr') {
      const d = input.bounce.balanceDb
      if (typeof d !== 'number' || !Number.isFinite(d) || Math.abs(d) < 1) { skip('Left and right are within 1 dB in this bounce.'); continue }
      // The louder side comes down to meet the other: that much of it, as a balance setting.
      const pct = Math.min(50, Math.round((1 - Math.pow(10, -Math.abs(d) / 20)) * 100))
      moves.push({ kind: 'level', track: '', gainDb: 0, balancePct: d > 0 ? pct : -pct, band: 'sub', code, note_id })
      continue
    }
    if (code === 'dc.offset') {
      moves.push({ kind: 'lowcut', track: '', gainDb: 0, hz: 20, band: 'sub', code, note_id })
      continue
    }
    if (code === 'tail.cut') {
      bounceOptions.tail = true
      alsoAnswers.push(code)
      continue
    }
    // mono.low@<sec>
    if (answered.has(code)) continue
    if (!stillThere(code)) { skip('No longer in the bounce after the moves before this.'); continue }
    if (!narrowed) {
      narrowed = true
      moves.push({ kind: 'mono', track: '', gainDb: 0, hz: LOW_WIDTH_HZ.hi, band: 'sub', code, note_id })
    }
  }
  if (trims.length) {
    trims.sort((a, b) => b.db - a.db)
    const lift = moves.find(m => m.kind === 'level' && m.gainDb > 0)
    if (lift) { skipped.push({ note_id: lift.note_id, code: lift.code, why: 'The output has to come DOWN for another note, so it cannot also come up.' }); moves.splice(moves.indexOf(lift), 1) }
    moves.push({ kind: 'level', track: '', gainDb: -round1(trims[0].db), band: 'sub', code: trims[0].code, note_id: trims[0].note_id })
    alsoAnswers.push(...trims.slice(1).map(t => t.code))
  }
  // One Gain plug-in on the output: a trim and a balance move are the same plug-in, so they are one move.
  const levels = moves.filter(m => m.kind === 'level')
  if (levels.length > 1) {
    const [keep, ...rest] = levels
    for (const m of rest) { keep.gainDb = keep.gainDb || m.gainDb; keep.balancePct = keep.balancePct ?? m.balancePct; alsoAnswers.push(m.code); moves.splice(moves.indexOf(m), 1) }
  }
  return { moves, skipped, alsoAnswers, bounce: bounceOptions }
}

/** A move with nothing left of it: how a mastering move that did not hold is taken back. */
export function neutral(move: InternMove): InternMove & { off?: boolean } {
  return move.kind === 'mono' || move.kind === 'lowcut' ? { ...move, off: true } : { ...move, gainDb: 0, ...(move.balancePct ? { balancePct: 0 } : {}) }
}

/**
 * The last look before anything is uploaded: is the bounce still the same
 * piece of audio, only better? Compared with the bounce it was made from.
 * Answers the reasons it is not, in words; none means it passes.
 */
export function deliverableProblems(
  from: { seconds: number; integratedLufs: number; truePeakDb: number },
  to: { seconds: number; integratedLufs: number; truePeakDb: number },
  /** What was done on purpose: the audio tail added (it gets longer), the output moved by `level` dB. */
  meant: { tail?: boolean; level?: number } = {},
): string[] {
  const out: string[] = []
  const longer = to.seconds - from.seconds
  if (meant.tail ? longer < -1 || longer > 30 : Math.abs(longer) > 1) out.push(`its length changed (${from.seconds.toFixed(0)} s to ${to.seconds.toFixed(0)} s)`)
  const moved = to.integratedLufs - from.integratedLufs - (meant.level ?? 0)
  if (Math.abs(moved) > 1.5) out.push(`its loudness moved ${Math.abs(moved).toFixed(1)} LU more than the move made should`)
  if (to.truePeakDb > Math.max(from.truePeakDb, CEILING_DBTP) + 0.2) out.push(`its true peak rose to ${to.truePeakDb.toFixed(1)} dBTP`)
  return out
}
