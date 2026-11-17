#!/usr/bin/env node
// Unit tests for Mix Check: the measuring engine (src/lib/mix-check.ts) and the
// rules that turn measurements into notes (src/lib/mix-check-findings.ts).
// Pure — synthetic mixes built here, no DB, no ffmpeg.
// Run: node scripts/mix-check-test.mjs

import { createMixAnalyzer, isMixSummary, MIX_BANDS, THIRD_OCTAVE_HZ, SIXTH_OCTAVE_HZ, MATCH_LUFS } from '../src/lib/mix-check.ts'
import { buildFindings, baselineOf, genreFamily, MIN_CATALOG, MIX_CHECK_AUTHOR } from '../src/lib/mix-check-findings.ts'
import { measureLoudness } from '../src/lib/loudness.ts'

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}

const SR = 44100

// A deterministic noise source (the suite must not flake).
function rng(seed) {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5 }
}

// A small dance mix: 8 s of pad-only breakdown, 24 s with a four-on-the-floor
// kick, an off-beat sub note and hats, then a 3 s fade.
//   sub        level of the sub note under the kick (0 = no sub at all)
//   breakSub   level of a sustained sub in the breakdown
//   wideBreak  breakdown sub in opposite polarity left/right
//   gain       overall gain (push it into clipping)
//   hole       seconds at which 80 ms of silence is cut in
//   cut        end abruptly instead of fading
function mix({ sub = 0.16, breakSub = 0, wideBreak = false, gain = 1, hole = null, cut = false } = {}) {
  const seconds = 35
  const n = seconds * SR
  const L = new Float32Array(n), R = new Float32Array(n)
  const noise = rng(7)
  let hp = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const inDrop = t >= 8 && t < 32
    let l = 0, r = 0
    // pad: a few mid partials, slightly different left and right
    const pad = 0.05 * (Math.sin(2 * Math.PI * 311 * t) + Math.sin(2 * Math.PI * 466 * t) + 0.6 * Math.sin(2 * Math.PI * 932 * t))
    l += pad; r += 0.05 * (Math.sin(2 * Math.PI * 311.7 * t) + Math.sin(2 * Math.PI * 466 * t) + 0.6 * Math.sin(2 * Math.PI * 933 * t))
    if (!inDrop && t < 8 && breakSub > 0) {
      const s = breakSub * Math.sin(2 * Math.PI * 46 * t)
      l += s; r += wideBreak ? -s : s
    }
    if (inDrop) {
      const beat = (t - 8) % 0.5
      // kick: 150 → 62 Hz sweep, 110 ms
      if (beat < 0.14) {
        const f = 62 + 88 * Math.exp(-beat / 0.02)
        const phase = 2 * Math.PI * (62 * beat + 88 * 0.02 * (1 - Math.exp(-beat / 0.02)))
        const k = 0.5 * Math.exp(-beat / 0.045) * Math.sin(phase + 0 * f)
        l += k; r += k
      }
      // sub note on the off-beat, 52 Hz
      if (sub > 0 && beat >= 0.2 && beat < 0.46) {
        const e = Math.min(1, (beat - 0.2) / 0.02) * Math.min(1, (0.46 - beat) / 0.03)
        const s = sub * e * Math.sin(2 * Math.PI * 52 * t)
        l += s; r += s
      }
      // hats: high-passed noise on the off-beat
      const w = noise()
      const hat = w - hp; hp = w
      if (beat >= 0.25 && beat < 0.29) { l += 0.08 * hat; r += 0.08 * hat }
    }
    let fade = 1
    if (!cut && t >= 32) fade = Math.max(0, 1 - (t - 32) / 3)
    if (hole != null && t >= hole && t < hole + 0.08) fade = 0
    L[i] = Math.max(-1, Math.min(1, l * gain * fade))
    R[i] = Math.max(-1, Math.min(1, r * gain * fade))
  }
  return { L, R }
}

function measure({ L, R }, source = 'full') {
  const a = createMixAnalyzer(SR)
  // Feed it the way the server does: in uneven chunks.
  for (let i = 0; i < L.length;) {
    const len = Math.min(L.length - i, 4096 + ((i * 7) % 5000))
    a.push(L.subarray(i, i + len), R.subarray(i, i + len))
    i += len
  }
  return a.finish(source)
}

console.log('mix-check: the measurement\n')

const base = mix()
const m = measure(base)
check('summary has the stored shape', isMixSummary(m.summary))
check('band and spectrum lengths', m.summary.b.length === MIX_BANDS.length && m.summary.s3.length === THIRD_OCTAVE_HZ.length && m.detail.core.length === SIXTH_OCTAVE_HZ.length)

const ref = measureLoudness([base.L, base.R], SR)
check('integrated loudness agrees with Master Check', Math.abs(m.summary.i - ref.integratedLufs) < 0.3, `${m.summary.i} vs ${ref.integratedLufs.toFixed(2)}`)
check('true peak is at or above the sample peak', m.summary.tp >= m.detail.samplePeakDb - 0.05, `${m.summary.tp} ≥ ${m.detail.samplePeakDb}`)

const rhythm = m.detail.sections.filter(s => s.kind === 'rhythm')
check('finds the kick section', m.detail.hasRhythm && rhythm.length === 1 && Math.abs(rhythm[0].start - 8) <= 2 && Math.abs(rhythm[0].end - 32) <= 2,
  rhythm.map(s => `${s.start}-${s.end}`).join(' '))
check('the breakdown is not a rhythm section', m.detail.timeline.rhythm.slice(1, 6).every(v => v === 0))

// Levels are reported at the matched loudness: the same mix 6 dB down measures the same.
const quiet = measure({ L: base.L.map(v => v * 0.5), R: base.R.map(v => v * 0.5) })
check('band levels do not depend on the file\'s level', m.summary.b.every((v, i) => Math.abs(v - quiet.summary.b[i]) < 0.15), `matched to ${MATCH_LUFS} LUFS`)
check('loudness does', Math.abs((m.summary.i - quiet.summary.i) - 6.02) < 0.2)

check('a mono low end reads as mono', m.summary.c[0] > 0.98, `corr ${m.summary.c[0]}`)

console.log('\nmix-check: the findings\n')

// The sub taken out: every band but one stays put.
const noSub = measure(mix({ sub: 0.03 }))
const v1 = buildFindings(noSub, { previous: { label: 'MIX 4', summary: m.summary } })
const changed = v1.findings.find(f => f.code === 'changed.sub')
check('a missing sub is found against the previous version', !!changed && changed.note.includes('MIX 4') && /lower/.test(changed.note), changed?.title)
check('…at the first full section, as a note that names the number', !!changed && changed.at != null && Math.abs(changed.at - 8) <= 2 && /\d+\.\d dB/.test(changed.note))
check('…and the sub is noted once, nothing else as changed', v1.findings.filter(f => f.code.startsWith('changed.')).length === 1 && v1.findings.filter(f => f.code.endsWith('.sub')).length === 1,
  v1.findings.map(f => f.code).join(', '))
check('an identical mix raises no change', buildFindings(m, { previous: { label: 'MIX 4', summary: m.summary } }).findings.every(f => !f.code.startsWith('changed.')))

// Catalog: only compared once there are enough songs, and only outliers are raised.
const few = buildFindings(noSub, { catalog: Array(MIN_CATALOG - 1).fill(m.summary) })
check('too small a catalog is not a baseline', few.compared.catalog === 0 && few.bands.every(b => b.vsCatalog == null))
const cat = buildFindings(noSub, { catalog: Array(MIN_CATALOG + 2).fill(m.summary) })
const balance = cat.findings.find(f => f.code === 'balance.sub')
check('a band far off the catalog is raised, and never as high on its own', !!balance && balance.severity !== 'high' && /catalog/.test(balance.note), balance?.title)
const both = buildFindings(noSub, {
  previous: { label: 'MIX 4', summary: m.summary },
  catalog: Array(8).fill(m.summary),
  industry: { label: 'house', summaries: Array(6).fill(m.summary) },
})
check('one band, one note: the change absorbs the catalog comparison',
  both.findings.filter(f => f.code.endsWith('.sub')).length === 1 && /catalog/.test(both.findings.find(f => f.code === 'changed.sub').note))
const genre = both.findings.filter(f => f.code === 'genre.balance')
check('the genre comparison is one note for the whole picture', genre.length === 1 && /6 house reference tracks/.test(genre[0].note) && /Sub −/.test(genre[0].note), genre[0]?.note)
check('…that says so when the references are mostly previews',
  /previews/.test(buildFindings(noSub, { industry: { label: 'house', summaries: Array(6).fill({ ...m.summary, src: 'preview' }) } }).findings.find(f => f.code === 'genre.balance').note))
check('…and is absent when the mix matches them', !buildFindings(m, { industry: { label: 'house', summaries: Array(6).fill(m.summary) } }).findings.some(f => f.code === 'genre.balance'))
check('previews are not trusted for the top octave',
  buildFindings(m, { industry: { label: 'house', summaries: Array(6).fill({ ...m.summary, src: 'preview' }) } }).bands.find(b => b.key === 'air').vsIndustry == null)
const b = baselineOf([m.summary, noSub.summary])
check('baselineOf: mean and spread per band', b.n === 2 && Math.abs(b.mean[0] - (m.summary.b[0] + noSub.summary.b[0]) / 2) < 1e-9 && b.sd[0] > 1)

// A drop that lands smaller than its breakdown.
const bigBreak = measure(mix({ sub: 0.03, breakSub: 0.22 }))
const drop = buildFindings(bigBreak).findings.find(f => f.code.startsWith('drop.smaller@'))
check('a drop with less sub than its breakdown is found at the drop', !!drop && Math.abs(drop.at - 8) <= 2, drop?.note)
check('a drop that steps up is not', !buildFindings(m).findings.some(f => f.code.startsWith('drop.')))

// Low end out of phase in the breakdown.
const wide = measure(mix({ breakSub: 0.22, wideBreak: true }))
const mono = buildFindings(wide).findings.find(f => f.code.startsWith('mono.low@'))
check('an out-of-phase low end is found where it happens', !!mono && mono.at <= 2 && /out of phase/.test(mono.title), mono?.title)
check('a mono low end is not', !buildFindings(measure(mix({ breakSub: 0.22 }))).findings.some(f => f.code.startsWith('mono.low@')))

// The file itself.
const hot = buildFindings(measure(mix({ gain: 2.6 })))
check('clipping is found, with where it starts', hot.findings.some(f => f.code === 'peak.clip' && f.at != null))
check('a clean file has none', !buildFindings(m).findings.some(f => f.code === 'peak.clip'))
const holed = buildFindings(measure(mix({ hole: 20.25 })))
check('a hole in the audio is found at its second', holed.findings.some(f => f.code === 'dropout@20'), holed.findings.map(f => f.code).join(', '))
check('a cut-off ending is found', buildFindings(measure(mix({ cut: true }))).findings.some(f => f.code === 'tail.cut'))
check('a faded ending is not', !buildFindings(m).findings.some(f => f.code === 'tail.cut'))
check('…and a preview clip is never called cut off', !buildFindings(measure(mix({ cut: true }), 'preview')).findings.some(f => f.code === 'tail.cut'))

// Robustness: silence, and something with no kick at all.
const silent = measure({ L: new Float32Array(SR * 8), R: new Float32Array(SR * 8) })
check('silence measures without throwing or NaN', isMixSummary(silent.summary) && silent.summary.b.every(Number.isFinite) && buildFindings(silent).findings.every(f => typeof f.note === 'string'))
const padOnly = (() => {
  const n = SR * 12, L = new Float32Array(n), R = new Float32Array(n)
  for (let i = 0; i < n; i++) { const t = i / SR; L[i] = 0.2 * Math.sin(2 * Math.PI * 220 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.3 * t)); R[i] = L[i] }
  return measure({ L, R })
})()
check('a mix with no kick falls back to its loudest part', !padOnly.detail.hasRhythm && padOnly.summary.rf === 0 && padOnly.summary.b.every(Number.isFinite))

check('every finding is a note with a stable code and a severity',
  [v1, cat, both, hot, holed].flatMap(v => v.findings).every(f => f.code && f.note.length > 20 && f.note.length < 600 && ['high', 'medium', 'low'].includes(f.severity)))
check('findings are ordered worst first', (() => { const r = { high: 0, medium: 1, low: 2 }; const l = both.findings.map(f => r[f.severity]); return l.every((v, i) => i === 0 || l[i - 1] <= v) })())

console.log('\nmix-check: genre families\n')
const fam = (g, want) => check(`${JSON.stringify(g)} → ${want}`, genreFamily(g) === want, String(genreFamily(g)))
fam('Melodic House', 'melodic_house')
fam('Melodic Techno', 'melodic_techno')
fam('Melodic House & Techno', 'melodic_techno')
fam('Trance / Melodic Techno', 'melodic_techno')
fam('Tech House', 'tech_house')
fam('House', 'house')
fam('Techno / Rap', 'techno')
fam('Trance', 'trance')
fam('Psytrance', 'trance')
fam('Liquid DnB', 'dnb')
fam('Riddim', 'dubstep')
fam('Lo-Fi', null)
fam(null, null)
check('the byline is fixed', MIX_CHECK_AUTHOR === 'Mix Check')

if (failures) { console.error(`\nmix-check: ${failures} check(s) FAILED`); process.exit(1) }
console.log('\nmix-check: all checks passed')
