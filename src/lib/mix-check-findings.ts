// ─── Mix Check — the judging half ────────────────────────────────────────────
// src/lib/mix-check.ts measures one mix. This module compares that measurement
// with three others and writes down what stands out:
//
//   • the PREVIOUS version of the same song — what changed since the last
//     bounce (the comparison that catches "the sub went missing in MASTER 5");
//   • the artist's own CATALOG — the newest measured version of every other
//     song, mixes and masters alike: "unusual for you";
//   • commercial REFERENCES in the song's genre — "unusual for the genre".
//
// plus things that are wrong whatever the comparison: a drop that lands smaller
// than the breakdown before it, a low end that cancels in mono, clipping, a
// hole in the audio, a cut-off tail.
//
// Every finding carries the numbers it was decided on and a place in the song
// where that makes sense, because each becomes a timestamped note on the mix
// (src/lib/mix-check-server.ts writes them into mb_feedback under
// MIX_CHECK_AUTHOR). Pure, no '@/…' imports: scripts/mix-check-test.mjs loads
// it through Node's type stripping, and both clients render what it returns.
//
// What it cannot do is hear. It finds what can be measured from the stereo
// bounce; taste stays with the artist, so comparisons with the catalog alone
// are never rated worse than "low", and every note says what it measured.

import { MIX_BANDS, type MixBandKey, type MixMeasurement, type MixSummary } from './mix-check.ts'

/** The byline on notes Mix Check writes, so they never pass for the artist's
 *  own (MIX_NOTE_AUTHOR) or a listener's. Reserved: POST /api/feedback refuses it. */
export const MIX_CHECK_AUTHOR = 'Mix Check'

export type MixSeverity = 'high' | 'medium' | 'low'

// ── The run marker ───────────────────────────────────────────────────────────
// A check is an in-process job, and production runs more than one process (two
// regions). Without something they both read, a poll answered by the OTHER one
// says "nothing here" halfway through a check, and a second tap there starts a
// second run whose notes land beside the first's. So a run writes this marker
// into the version's mix_check (beside the report it is about to replace, or
// alone) and every process reads it: running → wait, error → say so. A running
// marker older than MARKER_TTL_MS is a run that died with its process (a
// deploy): it counts for nothing, and the stored report shows again.
export type MixCheckMarker = { state: 'running' | 'error'; at: string; error?: string }
export const MARKER_TTL_MS = 4 * 60_000

/** The marker in a stored mix_check value, if it still means something. */
export function mixCheckMarker(stored: unknown, nowMs: number): MixCheckMarker | null {
  if (!stored || typeof stored !== 'object') return null
  const job = (stored as { job?: unknown }).job
  if (!job || typeof job !== 'object') return null
  const { state, at, error } = job as Record<string, unknown>
  if ((state !== 'running' && state !== 'error') || typeof at !== 'string') return null
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return null
  if (state === 'running' && (nowMs - t > MARKER_TTL_MS || t - nowMs > 60_000)) return null
  // A failure is worth showing only until a report newer than it exists.
  if (state === 'error') {
    const reportAt = Date.parse(String((stored as { at?: unknown }).at ?? ''))
    if (Number.isFinite(reportAt) && reportAt > t) return null
    return { state, at, error: typeof error === 'string' && error ? error : 'The check failed' }
  }
  return { state, at }
}

/** A stored value with a marker set (or, with null, taken off). Null when nothing is left. */
export function withMarker(stored: unknown, marker: MixCheckMarker | null): Record<string, unknown> | null {
  const base: Record<string, unknown> = stored && typeof stored === 'object' ? { ...(stored as Record<string, unknown>) } : {}
  delete base.job
  if (marker) base.job = marker
  return Object.keys(base).length ? base : null
}

export type MixFinding = {
  /** Stable identity within one mix — a re-run replaces the note with this code. */
  code: string
  severity: MixSeverity
  /** Where in the song, whole seconds; null for a finding about the whole mix. */
  at: number | null
  title: string
  /** The note as it is written into the mix notes. */
  note: string
}

export type BandComparison = {
  key: MixBandKey
  label: string
  range: string
  /** dBFS at the matched loudness, in the full sections. */
  level: number
  /** This mix minus the other, dB; null when there is nothing to compare with. */
  vsPrevious: number | null
  vsCatalog: number | null
  vsIndustry: number | null
}

export type MixContext = {
  previous?: { label: string; summary: MixSummary } | null
  catalog?: MixSummary[] | null
  industry?: { label: string; summaries: MixSummary[] } | null
}

export type MixVerdict = {
  findings: MixFinding[]
  bands: BandComparison[]
  compared: { previous: string | null; catalog: number; industry: { label: string; count: number } | null }
}

/** Fewest other songs / reference tracks a comparison is worth making against. */
export const MIN_CATALOG = 6
export const MIN_INDUSTRY = 5
const MAX_FINDINGS = 12

const fmt = (x: number) => Math.abs(x).toFixed(1)
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`

type Baseline = { n: number; mean: number[]; sd: number[] }

/** Mean and spread of each band over a set of mixes. */
export function baselineOf(summaries: MixSummary[]): Baseline {
  const n = summaries.length
  const mean = MIX_BANDS.map((_, i) => summaries.reduce((s, m) => s + m.b[i], 0) / Math.max(1, n))
  const sd = MIX_BANDS.map((_, i) => Math.sqrt(summaries.reduce((s, m) => s + (m.b[i] - mean[i]) ** 2, 0) / Math.max(1, n)))
  return { n, mean, sd }
}

// What to do about a band that is short or heavy. Kept to one plain sentence.
const BAND_FIX: Record<MixBandKey, { low: string; high: string }> = {
  sub: {
    low: 'Bring the sub bass up, or check its level, its sidechain depth and any high-pass on the low end.',
    high: 'Pull the sub down, or high-pass whatever does not need to be down there.',
  },
  punch: {
    low: 'The kick body or the bass fundamental is light: check the kick level and any low cut on the bass.',
    high: 'Kick and bass body are heavy: ease the kick level or 80–100 Hz on the bass.',
  },
  upperBass: {
    low: 'The mix may sound thin: check what was cut around 150–200 Hz.',
    high: 'This is where boom builds: thin bass harmonics, toms and pads around 150–200 Hz.',
  },
  lowMid: {
    low: 'The mix may sound hollow: ease any broad cut around 300 Hz.',
    high: 'Mud builds here: cut 250–400 Hz on pads, bass harmonics and reverb returns.',
  },
  mid: {
    low: 'Mids are recessed: leads, vocals and chords around 1 kHz could come forward.',
    high: 'Mids are forward: check leads, vocals and stacked chords around 1 kHz.',
  },
  presence: {
    low: 'The mix may sound dull or distant: leads and vocals could use more 3 kHz.',
    high: 'This is where harshness lives: tame leads, hats and vocal edge around 3–4 kHz.',
  },
  air: {
    low: 'The top is dark: open the hats and cymbals, or add a gentle shelf above 8 kHz.',
    high: 'The top is bright: ease hats, shakers and any high shelf.',
  },
}

export function buildFindings(m: MixMeasurement, ctx: MixContext = {}): MixVerdict {
  const { summary: s, detail: d } = m
  const findings: MixFinding[] = []
  const firstFull = d.sections.find(x => x.kind === 'rhythm')?.start ?? null
  const where = d.hasRhythm ? 'where the kick plays' : 'in the loudest part'

  const previous = ctx.previous ?? null
  const catalog = (ctx.catalog ?? []).length >= MIN_CATALOG ? baselineOf(ctx.catalog!) : null
  const industrySet = ctx.industry && ctx.industry.summaries.length >= MIN_INDUSTRY ? ctx.industry : null
  const industry = industrySet ? baselineOf(industrySet.summaries) : null
  // A lossy preview has no trustworthy top octave; only compare the highs
  // against references measured from the full file.
  const industryAirOk = !!industrySet && industrySet.summaries.filter(x => x.src === 'full').length >= MIN_INDUSTRY

  const bands: BandComparison[] = MIX_BANDS.map((band, i) => ({
    key: band.key, label: band.label, range: band.range, level: s.b[i],
    vsPrevious: previous ? round1(s.b[i] - previous.summary.b[i]) : null,
    vsCatalog: catalog ? round1(s.b[i] - catalog.mean[i]) : null,
    vsIndustry: industry && (band.key !== 'air' || industryAirOk) ? round1(s.b[i] - industry.mean[i]) : null,
  }))

  // ── What changed since the last version ───────────────────────────────────
  if (previous) {
    const moved = bands
      .filter(b => b.vsPrevious != null && Math.abs(b.vsPrevious) >= 2.5)
      .sort((a, b) => Math.abs(b.vsPrevious!) - Math.abs(a.vsPrevious!))
      .slice(0, 3)
    const still = bands.filter(b => b.vsPrevious != null && Math.abs(b.vsPrevious) < 1).length
    for (const b of moved) {
      const delta = b.vsPrevious!
      const dir = delta < 0 ? 'low' : 'high'
      const only = moved.length === 1 && still >= 4
        ? ' Every other band is within 1 dB, so this is one channel moving, not the master.'
        : ''
      findings.push({
        code: `changed.${b.key}`,
        severity: Math.abs(delta) >= 5 ? 'high' : Math.abs(delta) >= 3.5 ? 'medium' : 'low',
        at: firstFull,
        title: `${b.label} ${delta < 0 ? 'dropped' : 'rose'} ${fmt(delta)} dB since ${previous.label}`,
        note: `${b.label} (${b.range}) is ${fmt(delta)} dB ${delta < 0 ? 'lower' : 'higher'} than in ${previous.label} ${where}, at matched loudness.${only} ${BAND_FIX[b.key][dir]}`,
      })
    }
    const dl = s.i - previous.summary.i
    if (Number.isFinite(dl) && Math.abs(dl) >= 1.5 && s.i > -70 && previous.summary.i > -70) {
      findings.push({
        code: 'changed.loudness', severity: 'low', at: null,
        title: `${fmt(dl)} LU ${dl < 0 ? 'quieter' : 'louder'} than ${previous.label}`,
        note: `Integrated loudness went from ${previous.summary.i.toFixed(1)} to ${s.i.toFixed(1)} LUFS since ${previous.label}. Compare the two at matched volume before judging which sounds better.`,
      })
    }
    const dc = s.c[0] - previous.summary.c[0]
    if (dc <= -0.15 && s.c[0] < 0.85) {
      findings.push({
        code: 'changed.lowwidth', severity: 'medium', at: firstFull,
        title: `Low end got wider since ${previous.label}`,
        note: `Below 120 Hz the stereo correlation fell from ${previous.summary.c[0].toFixed(2)} to ${s.c[0].toFixed(2)} since ${previous.label}. Something low was widened or panned; keep the kick and sub in mono.`,
      })
    }
  }

  // ── Balance against the artist's own catalog: one note per outlying band ───
  MIX_BANDS.forEach((band, i) => {
    const b = bands[i]
    if (!catalog || b.vsCatalog == null) return
    const z = b.vsCatalog / Math.max(1, catalog.sd[i])
    if (Math.abs(b.vsCatalog) < 3 || Math.abs(z) < 1.8) return
    const sign = Math.sign(b.vsCatalog)
    const part = `${fmt(b.vsCatalog)} dB ${sign < 0 ? 'under' : 'over'} your catalog average`
    // Already noted as a change since the last version: say it once, there.
    const changed = findings.find(f => f.code === `changed.${band.key}`)
    if (changed && Math.sign(b.vsPrevious ?? 0) === sign) {
      changed.note += ` It is also ${part}.`
      return
    }
    findings.push({
      code: `balance.${band.key}`,
      // "Unusual for you" is not "wrong": never high on its own.
      severity: Math.abs(b.vsCatalog) >= 6 ? 'medium' : 'low',
      at: firstFull,
      title: `${band.label} ${sign < 0 ? 'light' : 'heavy'}: ${part}`,
      note: `${band.label} (${band.range}) sits ${part} ${where}, at matched loudness. ${BAND_FIX[band.key][sign < 0 ? 'low' : 'high']}`,
    })
  })

  // ── Balance against the genre: ONE note for the whole picture ──────────────
  // A mix that differs from commercial references usually differs as a tilt
  // (light at the bottom AND forward in the mids), which is one fact, not four.
  if (industry && industrySet) {
    const off = bands
      .map((b, i) => ({ b, sd: industry.sd[i] }))
      .filter(({ b, sd }) => b.vsIndustry != null && Math.abs(b.vsIndustry) >= 3 && Math.abs(b.vsIndustry) >= 1.5 * Math.max(1.5, sd))
      .map(({ b }) => b)
    if (off.length) {
      const worst = off.reduce((a, b) => (Math.abs(b.vsIndustry!) > Math.abs(a.vsIndustry!) ? b : a))
      const previews = industrySet.summaries.filter(x => x.src === 'preview').length
      const list = off.map(b => `${b.label} ${signed(b.vsIndustry!)} dB`).join(', ')
      const lowLight = off.some(b => (b.key === 'sub' || b.key === 'punch') && b.vsIndustry! < 0)
      const topHeavy = off.some(b => (b.key === 'mid' || b.key === 'presence') && b.vsIndustry! > 0)
      const reading = lowLight && topHeavy
        ? 'This mix gets its loudness from the mids; the references carry more of theirs in the low end.'
        : BAND_FIX[worst.key][worst.vsIndustry! < 0 ? 'low' : 'high']
      findings.push({
        code: 'genre.balance',
        severity: Math.abs(worst.vsIndustry!) >= 6 ? 'medium' : 'low',
        at: firstFull,
        title: `Against ${industrySet.label} references: ${worst.label.toLowerCase()} ${signed(worst.vsIndustry!)} dB`,
        note: `Against ${industrySet.summaries.length} ${industrySet.label} reference tracks ${where}, at matched loudness: ${list}. ${reading}${previews > industrySet.summaries.length / 2 ? ' Most of these references were measured from short previews, so read this as a direction, not a target.' : ''}`,
      })
    }
  }
  if (!catalog && !industry && d.hasRhythm && s.b[0] < s.b[1] - 8 && !findings.some(f => f.code === 'changed.sub')) {
    findings.push({
      code: 'balance.sub', severity: 'low', at: firstFull,
      title: 'Sub sits far under the kick body',
      note: `Sub (30–65 Hz) is ${fmt(s.b[1] - s.b[0])} dB under the kick and bass body (65–120 Hz) where the kick plays. On a system with subs the low end may feel light. ${BAND_FIX.sub.low}`,
    })
  }

  // ── A drop that lands smaller than what came before it ────────────────────
  const tl = d.timeline
  const mean = (line: number[], a: number, b: number) => {
    let sum = 0, n = 0
    for (let i = Math.max(0, a); i < Math.min(line.length, b); i++) if (line[i] > -119) { sum += Math.pow(10, line[i] / 10); n++ }
    return n ? 10 * Math.log10(sum / n) : -120
  }
  let drops = 0
  let quietest: { at: number; fall: number } | null = null as { at: number; fall: number } | null
  d.sections.forEach((sec, i) => {
    const before = d.sections[i - 1]
    if (sec.kind !== 'rhythm' || !before || before.kind !== 'break') return
    if (sec.end - sec.start < 12 || before.end - before.start < 6 || drops >= 3) return
    const subBefore = mean(tl.sub, sec.start - 8, sec.start), subAfter = mean(tl.sub, sec.start, sec.start + 8)
    const loudBefore = mean(tl.lufs, sec.start - 8, sec.start), loudAfter = mean(tl.lufs, sec.start, sec.start + 8)
    const subFall = subBefore - subAfter, loudFall = loudBefore - loudAfter
    const subShort = subBefore > -35 && subFall >= 3
    const quiet = loudFall >= 2
    if (!subShort && !quiet) return
    // A quieter arrival on its own is noted once, at the worst of them.
    if (!subShort) {
      if (!quietest || loudFall > quietest.fall) quietest = { at: sec.start, fall: loudFall }
      return
    }
    drops++
    const bits: string[] = []
    if (subShort) bits.push(`${fmt(subFall)} dB less sub`)
    if (quiet) bits.push(`${fmt(loudFall)} LU less loudness`)
    findings.push({
      code: `drop.smaller@${sec.start}`,
      severity: subShort && subFall >= 5 ? 'high' : subShort ? 'medium' : 'low',
      at: sec.start,
      title: `The drop at ${clock(sec.start)} lands smaller than the section before it`,
      note: `The section starting at ${clock(sec.start)} has ${bits.join(' and ')} than the 8 seconds before it, so the drop lands smaller than the breakdown. ${subShort ? 'Bring the drop\'s sub up, or thin the breakdown\'s low end in its last bars.' : 'Pull the breakdown down a little or open the drop up so the arrival is a step up.'}`,
    })
  })

  if (quietest) {
    findings.push({
      code: `drop.quieter@${quietest.at}`,
      severity: quietest.fall >= 4 ? 'medium' : 'low',
      at: quietest.at,
      title: `The section at ${clock(quietest.at)} arrives ${fmt(quietest.fall)} LU quieter`,
      note: `The section starting at ${clock(quietest.at)} is ${fmt(quietest.fall)} LU quieter than the 8 seconds before it. A drop that is quieter than its breakdown reads as a step down: pull the breakdown back a little, or open the drop up.`,
    })
  }

  // ── Low end that is not mono ──────────────────────────────────────────────
  const wide = d.sections
    .filter(sec => sec.end - sec.start >= 8 && Math.max(sec.sub, sec.punch) > -30 && sec.lowCorr < 0.7)
    .sort((a, b) => a.lowCorr - b.lowCorr)
    .slice(0, 2)
  for (const sec of wide) {
    const cancels = sec.lowCorr < 0
    findings.push({
      code: `mono.low@${sec.start}`,
      severity: sec.kind === 'rhythm' ? (sec.lowCorr < 0.3 ? 'high' : 'medium') : sec.lowCorr < 0.3 ? 'medium' : 'low',
      at: sec.start,
      title: `Low end is ${cancels ? 'out of phase' : 'stereo'} from ${clock(sec.start)} to ${clock(sec.end)}`,
      note: `From ${clock(sec.start)} to ${clock(sec.end)} the low end (30–120 Hz) has a stereo correlation of ${sec.lowCorr.toFixed(2)}. ${cancels ? 'Left and right work against each other, so it thins out or disappears in mono.' : 'It loses level on a mono club system or a phone.'} Narrow whatever plays down there to mono below 120 Hz.`,
    })
  }

  // ── Wide-band phase trouble: three seconds or more below zero ─────────────
  for (let i = 0, flagged = 0; i < tl.wideCorr.length && flagged < 2;) {
    if (tl.wideCorr[i] >= -0.2 || tl.lufs[i] < -30) { i++; continue }
    let e = i
    while (e < tl.wideCorr.length && tl.wideCorr[e] < -0.2 && tl.lufs[e] >= -30) e++
    if (e - i >= 3) {
      flagged++
      findings.push({
        code: `phase.wide@${i}`, severity: 'medium', at: i,
        title: `Out of phase from ${clock(i)} to ${clock(e)}`,
        note: `From ${clock(i)} to ${clock(e)} left and right are out of phase across the mids (correlation ${Math.min(...tl.wideCorr.slice(i, e)).toFixed(2)}). That part collapses in mono. Check a widener, a flipped polarity or a Haas delay on what plays there.`,
      })
    }
    i = e
  }

  // ── Levels and the file itself ────────────────────────────────────────────
  if (d.clips.runs > 0) {
    findings.push({
      code: 'peak.clip',
      severity: d.clips.runs >= 20 ? 'high' : 'medium',
      at: d.clips.at.length ? Math.floor(d.clips.at[0]) : null,
      title: `${d.clips.runs} flat-topped passage${d.clips.runs === 1 ? '' : 's'} at full scale`,
      note: `${d.clips.runs} passage${d.clips.runs === 1 ? ' sits' : 's sit'} flat against full scale${d.clips.at.length ? `, the first at ${clock(d.clips.at[0])}` : ''} (true peak ${signed(s.tp)} dBTP). Unless a limiter is doing that on purpose, the bounce is clipping: pull the output down, or set a true-peak ceiling of −1 dB.`,
    })
  } else if (s.tp > -0.1) {
    findings.push({
      code: 'peak.over', severity: 'low', at: null,
      title: `True peak ${signed(s.tp)} dBTP`,
      note: `True peak reaches ${signed(s.tp)} dBTP. Streaming encoders overshoot from there. For a master, set the limiter ceiling to −1 dBTP with true-peak limiting on; for a mix, leave a few dB of headroom.`,
    })
  }
  const crest = s.tp - s.i
  if (s.i > -8 && crest < 6) {
    findings.push({
      code: 'dynamics.crushed', severity: 'low', at: null,
      title: `Only ${fmt(crest)} dB between loudness and peak`,
      note: `At ${s.i.toFixed(1)} LUFS with a true peak of ${signed(s.tp)} dBTP there are only ${fmt(crest)} dB between the average and the peaks: the limiter is working hard the whole way through. If the kick has lost its punch, back the drive off 1 to 2 dB.`,
    })
  }
  if (Math.abs(d.balanceDb) >= 1.5) {
    findings.push({
      code: 'balance.lr', severity: Math.abs(d.balanceDb) >= 3 ? 'medium' : 'low', at: null,
      title: `${d.balanceDb > 0 ? 'Left' : 'Right'} is ${fmt(d.balanceDb)} dB louder`,
      note: `Over the whole song the ${d.balanceDb > 0 ? 'left' : 'right'} channel is ${fmt(d.balanceDb)} dB louder than the ${d.balanceDb > 0 ? 'right' : 'left'}. If nothing is meant to sit off-centre, check the pan and width of the loudest parts.`,
    })
  }
  for (const r of d.resonances.slice(0, 2)) {
    findings.push({
      code: `resonance.${r.hz}`, severity: 'low', at: firstFull,
      title: `Narrow peak at ${hz(r.hz)}`,
      note: `A narrow peak at ${hz(r.hz)} stands ${r.db.toFixed(1)} dB above the bands around it ${where}. If something sounds harsh or whistles there, find the part and notch it.`,
    })
  }
  for (const t of d.dropouts.slice(0, 3)) {
    findings.push({
      code: `dropout@${Math.floor(t)}`, severity: 'medium', at: Math.floor(t),
      title: `Hole in the audio at ${clock(t)}`,
      note: `The audio falls to silence for an instant at ${clock(t)} and comes straight back. If that is not an edit you made, bounce again.`,
    })
  }
  if (d.cutOff) {
    findings.push({
      code: 'tail.cut', severity: 'medium', at: Math.max(0, s.dur - 1),
      title: 'The ending is cut off',
      note: 'The file ends while sound is still playing, so the tail is cut off. Extend the bounce range until the reverb and delay tails have finished.',
    })
  }
  const dcWorst = Math.max(d.dcDb[0], d.dcDb[1])
  if (dcWorst > -40) {
    findings.push({
      code: 'dc.offset', severity: 'low', at: null,
      title: `DC offset at ${dcWorst.toFixed(0)} dBFS`,
      note: `The waveform sits off centre (DC offset ${dcWorst.toFixed(0)} dBFS). It costs headroom and can click at edits. A 20 Hz high-pass on the master removes it.`,
    })
  }

  const rank = { high: 0, medium: 1, low: 2 } as const
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.at ?? 1e9) - (b.at ?? 1e9))
  return {
    findings: findings.slice(0, MAX_FINDINGS),
    bands,
    compared: {
      previous: previous?.label ?? null,
      catalog: catalog?.n ?? 0,
      industry: industrySet ? { label: industrySet.label, count: industrySet.summaries.length } : null,
    },
  }
}

const round1 = (x: number) => Math.round(x * 10) / 10
const signed = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}`
const hz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(1)} kHz` : `${Math.round(f)} Hz`)

// ── Genre families: which reference set a song is compared with ─────────────
// The genre on a song is free text ("Melodic House & Techno", "Trance / Melodic
// Techno"). A reference set is keyed by one of these families; the first
// pattern that matches wins, so the more specific families come first.
export const GENRE_FAMILIES = [
  { key: 'dnb', label: 'drum & bass', match: /drum\s*(&|and|n)\s*bass|\bdnb\b|\bd&b\b|jungle|liquid/i },
  { key: 'dubstep', label: 'dubstep', match: /dubstep|riddim|brostep|bass music/i },
  { key: 'melodic_techno', label: 'melodic techno', match: /melodic.*techno|techno.*melodic/i },
  { key: 'melodic_house', label: 'melodic house', match: /melodic|progressive|organic|deep house/i },
  { key: 'trance', label: 'trance', match: /trance/i },
  { key: 'tech_house', label: 'tech house', match: /tech\s*house|bass house|minimal/i },
  { key: 'techno', label: 'techno', match: /techno/i },
  { key: 'house', label: 'house', match: /house|disco|garage/i },
] as const

export type GenreFamily = (typeof GENRE_FAMILIES)[number]['key']

/** The reference family a song's genre text belongs to, or null. */
export function genreFamily(genre: string | null | undefined): GenreFamily | null {
  if (!genre) return null
  for (const f of GENRE_FAMILIES) if (f.match.test(genre)) return f.key
  return null
}

export function genreFamilyLabel(key: string): string {
  return GENRE_FAMILIES.find(f => f.key === key)?.label ?? key
}
