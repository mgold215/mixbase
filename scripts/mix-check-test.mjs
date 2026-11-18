#!/usr/bin/env node
// Unit tests for Mix Check: the measuring engine (src/lib/mix-check.ts) and the
// rules that turn measurements into notes (src/lib/mix-check-findings.ts).
// Pure — synthetic mixes built here, no DB, no ffmpeg.
// Run: node scripts/mix-check-test.mjs

import { createMixAnalyzer, isMixSummary, MIX_BANDS, THIRD_OCTAVE_HZ, SIXTH_OCTAVE_HZ, MATCH_LUFS } from '../src/lib/mix-check.ts'
import { loudnessOf } from '../src/lib/mix-check.ts'
import { sanitizeLoudness } from '../src/lib/loudness-compare.ts'
import { mainDropStart, buildFindings, baselineOf, genreFamily, mixCheckMarker, withMarker, MARKER_TTL_MS, MIN_CATALOG, MIX_CHECK_AUTHOR } from '../src/lib/mix-check-findings.ts'
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
// One card, one button: a check's own numbers are the loudness readout.
{
  const reading = loudnessOf(m)
  check('a check gives the loudness readout: integrated, loudest 3 s and sample peak agree with Master Check',
    Math.abs(reading.integratedLufs - ref.integratedLufs) < 0.3 && Math.abs(reading.shortTermMaxLufs - ref.shortTermMaxLufs) < 0.5 && Math.abs(reading.samplePeakDb - ref.samplePeakDb) < 0.1,
    `${reading.integratedLufs}/${reading.shortTermMaxLufs}/${reading.samplePeakDb} vs ${ref.integratedLufs.toFixed(2)}/${ref.shortTermMaxLufs.toFixed(2)}/${ref.samplePeakDb.toFixed(2)}`)
  check('…in the shape the loudness columns are written from', sanitizeLoudness(reading)?.integratedLufs === reading.integratedLufs)
  const silent = loudnessOf({ summary: { ...m.summary, i: -120, st: -120 }, detail: { samplePeakDb: -120 } })
  check('silence is "no number", not −120', silent.integratedLufs === null && silent.shortTermMaxLufs === null && silent.samplePeakDb === null)
}
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

console.log('\nmix-check: where a whole-mix note is pinned\n')
{
  const sec = (kind, start, end, lufs) => ({ kind, start, end, lufs, sub: -30, punch: -30, lowCorr: 1 })
  // EVERGREEN MIX 2, as its report stored it: every balance note sat at 0:00.
  const evergreen = [sec('rhythm', 0, 29, -17.1), sec('break', 29, 157, -15.6), sec('rhythm', 157, 190, -15.6), sec('break', 190, 226, -14.5)]
  check('a quiet intro kick does not pin the notes to 0:00: they go to the drop', mainDropStart(evergreen) === 157, String(mainDropStart(evergreen)))
  check('two drops as loud as each other: the longer one',
    mainDropStart([sec('rhythm', 30, 60, -9), sec('break', 60, 90, -14), sec('rhythm', 90, 180, -9.3)]) === 90)
  check('…and the same length: the earlier one',
    mainDropStart([sec('rhythm', 30, 60, -9), sec('break', 60, 90, -14), sec('rhythm', 90, 120, -9.2)]) === 30)
  check('a loud fill under 8 s is not the drop',
    mainDropStart([sec('rhythm', 10, 14, -7), sec('break', 14, 40, -12), sec('rhythm', 40, 100, -9)]) === 40)
  check('a kick from start to finish: its start', mainDropStart([sec('rhythm', 0, 300, -9)]) === 0)
  check('no kick at all: no time', mainDropStart([sec('break', 0, 200, -12)]) === null)
}

console.log('\nmix-check: the run marker (one answer from every process)\n')
{
  const now = Date.parse('2026-11-17T19:00:00Z')
  const iso = ms => new Date(ms).toISOString()
  const report = { algo: 'mix-check-v1', at: iso(now - 3600_000), summary: m.summary, findings: [] }
  check('no marker on a plain report, on null, on junk', mixCheckMarker(report, now) === null && mixCheckMarker(null, now) === null && mixCheckMarker({ job: 'x' }, now) === null && mixCheckMarker({ job: { state: 'done', at: iso(now) } }, now) === null)
  const running = withMarker(report, { state: 'running', at: iso(now - 20_000) })
  check('a run marks the row and keeps the report beside it', mixCheckMarker(running, now)?.state === 'running' && running.summary === report.summary && running.findings === report.findings)
  check('a first check marks a row that has nothing else', mixCheckMarker(withMarker(null, { state: 'running', at: iso(now) }), now)?.state === 'running')
  check('a run that died with its process stops counting', mixCheckMarker(withMarker(report, { state: 'running', at: iso(now - MARKER_TTL_MS - 1000) }), now) === null)
  check('a marker from the future is not believed', mixCheckMarker(withMarker(report, { state: 'running', at: iso(now + 10 * 60_000) }), now) === null)
  const failed = withMarker(report, { state: 'error', at: iso(now - 5000), error: 'The mix could not be read' })
  check('a failure is reported with its reason', mixCheckMarker(failed, now)?.state === 'error' && mixCheckMarker(failed, now)?.error === 'The mix could not be read')
  check('…until a newer report exists', mixCheckMarker({ ...failed, at: iso(now) }, now) === null)
  check('taking the marker off leaves the report as it was', JSON.stringify(withMarker(running, null)) === JSON.stringify(report))
  check('…and leaves nothing where there was only a marker', withMarker(withMarker(null, { state: 'running', at: iso(now) }), null) === null)
  check('withMarker does not edit what it was given', !('job' in report))
}

console.log('\nmix-check: the app reads the report the server writes\n')
{
  // ios-parity-test is path-level: it cannot see a field renamed on a shared
  // route. The app decodes the report by field name, so every name its model
  // reads must be one this engine (or the server, for the three it adds) writes.
  const { readFileSync } = await import('node:fs')
  const swift = readFileSync(new URL('../ios/mixBase/Services/MixbaseAPI.swift', import.meta.url), 'utf8')
  const server = readFileSync(new URL('../src/lib/mix-check-server.ts', import.meta.url), 'utf8')
  const route = readFileSync(new URL('../src/app/api/versions/[id]/mix-check/route.ts', import.meta.url), 'utf8')
  const fields = name => {
    const start = swift.indexOf(`struct ${name}: Decodable`)
    if (start < 0) return null
    let depth = 0, i = swift.indexOf('{', start), end = i
    for (; end < swift.length; end++) { if (swift[end] === '{') depth++; else if (swift[end] === '}' && --depth === 0) break }
    // Stored properties at the struct's own level only (nested types have their own check).
    const body = swift.slice(i + 1, end)
    const out = []; let d = 0
    for (const line of body.split('\n')) {
      const m = d === 0 && /^\s*let (\w+):/.exec(line)
      if (m) out.push(m[1])
      d += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
    }
    return out
  }
  const reads = (name, written, note = '') => {
    const f = fields(name)
    const missing = f ? f.filter(k => !written.includes(k)) : ['(struct not found)']
    check(`${name}: every field the app reads is written${note}`, !!f && f.length > 0 && missing.length === 0, missing.join(', '))
  }
  const full = buildFindings(noSub, {
    previous: { label: 'MIX 4', summary: m.summary },
    catalog: Array(MIN_CATALOG + 2).fill(m.summary),
    industry: { label: 'house', summaries: Array(6).fill(m.summary) },
  })
  reads('MixCheckFinding', Object.keys(full.findings[0]))
  reads('MixCheckBand', Object.keys(full.bands[0]))
  reads('Industry', Object.keys(full.compared.industry))
  reads('Compared', [...Object.keys(full.compared), ...['genreAssumed', 'references', 'family'].filter(k => server.includes(`${k}:`))], ' (three of them by the server)')
  reads('Section', Object.keys(noSub.detail.sections[0]))
  reads('Timeline', Object.keys(noSub.detail.timeline))
  reads('Detail', Object.keys(noSub.detail))
  reads('Curves', ['mix', 'previous', 'catalog', 'industry'].filter(k => server.includes(`      ${k}:`)))
  reads('MixCheckReport', ['at', 'findings', 'bands', 'compared', 'curves', 'detail'].filter(k => new RegExp(`\\b${k}[,:]`).test(server)))
  check('the option lists the app draws with are served, under the names it reads',
    /case thirdOctaveHz = "third_octave_hz"/.test(swift) && /third_octave_hz: THIRD_OCTAVE_HZ/.test(route) && /families: GENRE_FAMILIES/.test(route) && /options: OPTIONS/.test(route))
  // Master Check and Mix Check are ONE card on both clients.
  const page = readFileSync(new URL('../src/app/projects/[id]/ProjectClient.tsx', import.meta.url), 'utf8')
  const webCard = readFileSync(new URL('../src/components/MixCheck.tsx', import.meta.url), 'utf8')
  const loudnessCard = readFileSync(new URL('../src/components/MasterCheck.tsx', import.meta.url), 'utf8')
  const songScreen = readFileSync(new URL('../ios/mixBase/Views/Projects/ProjectDetailView.swift', import.meta.url), 'utf8')
  const appCard = readFileSync(new URL('../ios/mixBase/Views/Projects/MixCheckCard.swift', import.meta.url), 'utf8')
  check('a check fills the loudness in, and never replaces a reading already there',
    /await fillLoudness\(versionId, measured\)/.test(server) && /\.update\(columns\)\.eq\('id', versionId\)\.is\('loudness_measured_at', null\)/.test(server))
  check('a finished check is served with the loudness reading', /loudnessForReport\(g\.id, stored\)/.test(route) && /loudness, options: OPTIONS/.test(route))
  check('the app reads the reading under the column names the server sends',
    ['loudness_lufs', 'loudness_short_term_lufs', 'sample_peak_db'].every(c => swift.includes(`= "${c}"`) && server.includes(c)) && /case status, report, options, loudness, error/.test(swift))
  check('web: the owner gets one card, everyone else the loudness card', /ownerTools \? \(\s*<MixCheck[\s\S]{0,400}?\) : \(\s*<MasterCheck /.test(page) && (page.match(/<MixCheck\b/g) ?? []).length === 1)
  check('web: Mix Check draws the loudness readout inside its own card', /<MasterCheck[\s\S]{0,200}mixCheck=\{\{/.test(webCard) && /body\.loudness/.test(webCard) && /\{mixCheck\?\.body\}/.test(loudnessCard))
  check('app: the owner gets one card, everyone else the loudness card', /if authService\.ownerTools \{\s*MixCheckCard\([\s\S]{0,900}?\} else \{\s*MasterCheckCard\(/.test(songScreen))
  check('app: Mix Check draws the loudness readout inside its own card', /LoudnessReadout\(measurement: loudness\)/.test(appCard) && /struct LoudnessReadout: View/.test(songScreen))
  const everywhere = [loudnessCard, webCard, songScreen, appCard, readFileSync(new URL('../ios/mixBase/Services/LoudnessAnalyzer.swift', import.meta.url), 'utf8')].join('\n')
  check('no limiter or chain recommendations on either client', !/recommendations/i.test(everywhere) && !/Pro-L|Ozone/.test(everywhere))
  check('the app starts and polls the same route', swift.includes('/mix-check",') && swift.includes('"/api/mix-check/references"'))
}

if (failures) { console.error(`\nmix-check: ${failures} check(s) FAILED`); process.exit(1) }
console.log('\nmix-check: all checks passed')
