#!/usr/bin/env node
// The mixing intern's rules (src/lib/intern-rules.ts): which move answers a
// measured Mix Check note. Pure: synthetic tracks built here, no Logic, no
// database, no network.
//
// The main test is a closed loop with the real Mix Check: a song's tracks are
// mixed twice (the second with the sub up and the low mids down, as EVERGREEN
// MIX 4 was against MIX 1), Mix Check writes its notes, the rules plan from
// the measured tracks, the plan is carried out on the AUDIO (a real gain, a
// real EQ filter), and Mix Check must then find the notes gone and no new one.
//
// Run: node scripts/intern-rules-test.mjs  (part of `npm test`)
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMixAnalyzer, MIX_BANDS } from '../src/lib/mix-check.ts'
import { buildFindings } from '../src/lib/mix-check-findings.ts'
import {
  INTERN_SPEC_HZ, NOTE_AT_DB, CLEAR_DB, MAX_MOVE_DB, MAX_TRACKS_PER_NOTE,
  coreWindows, createTrackMeter, planFixes, refineMove, describeMove, judgeFix, locallyJudged, bellFor,
} from '../src/lib/intern-rules.ts'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const SR = 44100
const SECONDS = 35
const LEN = SECONDS * SR

function rng(seed) {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5 }
}

// The tracks of a small dance song: 8 s of pad, 24 s with kick, sub and hats, a 3 s fade.
//   sub      level of the sub track
//   padLow   level of the pad's low-mid partials (its 932 Hz partial is left alone)
function tracks({ sub = 0.16, padLow = 1 } = {}) {
  const make = () => ({ L: new Float32Array(LEN), R: new Float32Array(LEN) })
  const out = { Kick: make(), Sub: make(), Pad: make(), Hats: make() }
  const noise = rng(7)
  let hp = 0
  for (let i = 0; i < LEN; i++) {
    const t = i / SR
    const fade = t >= 32 ? Math.max(0, 1 - (t - 32) / 3) : 1
    const inDrop = t >= 8 && t < 32
    out.Pad.L[i] = fade * 0.05 * (padLow * (Math.sin(2 * Math.PI * 311 * t) + Math.sin(2 * Math.PI * 466 * t)) + 0.6 * Math.sin(2 * Math.PI * 932 * t))
    out.Pad.R[i] = fade * 0.05 * (padLow * (Math.sin(2 * Math.PI * 311.7 * t) + Math.sin(2 * Math.PI * 466 * t)) + 0.6 * Math.sin(2 * Math.PI * 933 * t))
    const w = noise()
    const hat = w - hp; hp = w
    if (!inDrop) continue
    const beat = (t - 8) % 0.5
    if (beat < 0.14) {
      const phase = 2 * Math.PI * (62 * beat + 88 * 0.02 * (1 - Math.exp(-beat / 0.02)))
      out.Kick.L[i] = out.Kick.R[i] = fade * 0.5 * Math.exp(-beat / 0.045) * Math.sin(phase)
    }
    if (beat >= 0.2 && beat < 0.46) {
      const e = Math.min(1, (beat - 0.2) / 0.02) * Math.min(1, (0.46 - beat) / 0.03)
      out.Sub.L[i] = out.Sub.R[i] = fade * sub * e * Math.sin(2 * Math.PI * 52 * t)
    }
    if (beat >= 0.25 && beat < 0.29) out.Hats.L[i] = out.Hats.R[i] = fade * 0.08 * hat
  }
  return out
}

const sumOf = set => {
  const L = new Float32Array(LEN), R = new Float32Array(LEN)
  for (const t of Object.values(set)) for (let i = 0; i < LEN; i++) { L[i] += t.L[i]; R[i] += t.R[i] }
  return { L, R }
}

function mixCheck({ L, R }) {
  const a = createMixAnalyzer(SR)
  for (let i = 0; i < L.length; i += 8192) a.push(L.subarray(i, i + 8192), R.subarray(i, i + 8192))
  return a.finish('full')
}

function meter({ L, R }, windows, offset = 0, sr = SR) {
  const m = createTrackMeter(sr, windows, offset)
  for (let i = 0; i < L.length;) {
    const len = Math.min(L.length - i, 3000 + ((i * 7) % 5000)) // uneven chunks, as a file is read
    m.push(L.subarray(i, i + len), R.subarray(i, i + len))
    i += len
  }
  return m.finish()
}

// The textbook digital bell (RBJ), as a stand-in for the EQ in Logic.
function bell(x, hz, q, gainDb) {
  const A = Math.pow(10, gainDb / 40), w0 = (2 * Math.PI * hz) / SR, alpha = Math.sin(w0) / (2 * q), c = Math.cos(w0)
  const a0 = 1 + alpha / A
  const b0 = (1 + alpha * A) / a0, b1 = (-2 * c) / a0, b2 = (1 - alpha * A) / a0, a1 = (-2 * c) / a0, a2 = (1 - alpha / A) / a0
  const y = new Float32Array(x.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v
  }
  return y
}

// Carry a plan out on the audio itself.
function carryOut(set, moves) {
  const out = { ...set }
  for (const m of moves) {
    const t = out[m.track]
    if (m.kind === 'level') {
      const g = Math.pow(10, m.gainDb / 20)
      out[m.track] = { L: t.L.map(v => v * g), R: t.R.map(v => v * g) }
    } else {
      out[m.track] = { L: bell(t.L, m.hz, m.q, m.gainDb), R: bell(t.R, m.hz, m.q, m.gainDb) }
    }
  }
  return out
}

// A 32-bit float stereo WAV, as Logic can export.
function writeWav(path, { L, R }) {
  const data = Buffer.alloc(L.length * 8)
  for (let i = 0; i < L.length; i++) { data.writeFloatLE(L[i], i * 8); data.writeFloatLE(R[i], i * 8 + 4) }
  const head = Buffer.alloc(44)
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16); head.writeUInt16LE(3, 20); head.writeUInt16LE(2, 22)
  head.writeUInt32LE(SR, 24); head.writeUInt32LE(SR * 8, 28); head.writeUInt16LE(8, 32); head.writeUInt16LE(32, 34)
  head.write('data', 36); head.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([head, data]))
}

const bandPower = (spec, key) => {
  const b = MIX_BANDS.find(x => x.key === key)
  return spec.reduce((s, v, i) => (INTERN_SPEC_HZ[i] >= b.lo && INTERN_SPEC_HZ[i] < b.hi ? s + v : s), 0)
}
const total = spec => spec.reduce((s, v) => s + v, 0)

// ── Measuring a track ────────────────────────────────────────────────────────

console.log('intern rules: measuring a track\n')
{
  const tone = (hz, amp, from, to, sr = SR, seconds = 30) => {
    const x = new Float32Array(seconds * sr)
    for (let i = Math.round(from * sr); i < Math.round(to * sr); i++) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr)
    return { L: x, R: x }
  }
  const whole = meter(tone(1000, 0.5, 0, 30), [])
  check('power is absolute: a 1 kHz sine at half scale measures its mean square', Math.abs(total(whole.spec) - 0.125) < 0.002, total(whole.spec).toFixed(4))
  check('…and lands in the mids', bandPower(whole.spec, 'mid') / total(whole.spec) > 0.999)
  check('the spectrum is on Mix Check\'s twelfth-octave grid', whole.spec.length === INTERN_SPEC_HZ.length && INTERN_SPEC_HZ.length === 119 && Math.abs(INTERN_SPEC_HZ[67] - 1000) < 1e-9)
  const late = tone(100, 0.5, 10, 20)
  check('only the windows are measured', total(meter(late, [{ start: 11, end: 19 }]).spec) > 0.12 && total(meter(late, [{ start: 0, end: 8 }]).spec) < 1e-6)
  check('…shifted for an export that starts later than the bounce', total(meter(late, [{ start: 111, end: 119 }], 100).spec) > 0.12 && total(meter(late, [{ start: 11, end: 19 }], 100).spec) < 1e-9)
  const at48 = meter(tone(52, 0.5, 0, 30, 48000), [], 0, 48000)
  check('a 48 kHz export measures the same', Math.abs(total(at48.spec) - 0.125) < 0.002 && bandPower(at48.spec, 'sub') / total(at48.spec) > 0.99)
  check('a narrow band under 45 Hz keeps its power', Math.abs(total(meter(tone(36, 0.5, 0, 30), []).spec) - 0.125) < 0.003)

  const w = coreWindows([
    { kind: 'rhythm', start: 0, end: 30, lufs: -17 },
    { kind: 'break', start: 30, end: 60, lufs: -12 },
    { kind: 'rhythm', start: 60, end: 150, lufs: -11 },
    { kind: 'rhythm', start: 150, end: 200, lufs: -13.5 },
    { kind: 'rhythm', start: 5, end: 5, lufs: -11 }, 'junk', null,
  ])
  check('the windows are the kick sections within 4 LU of the loudest', w.length === 2 && w[0].start === 60 && w[1].end === 200, JSON.stringify(w))
  check('a song with no kick is measured over its loudest sections', coreWindows([{ kind: 'break', start: 0, end: 40, lufs: -14 }, { kind: 'break', start: 40, end: 50, lufs: -30 }]).length === 1)
  check('no sections, no windows (the whole file)', coreWindows(null).length === 0 && coreWindows([]).length === 0)
}

// ── The closed loop ──────────────────────────────────────────────────────────

console.log('\nintern rules: a fix, judged by Mix Check\n')
{
  const mix1 = mixCheck(sumOf(tracks()))
  // The mix that is handed over: the sub track up, the pad's low mids thinned.
  const handedTracks = tracks({ sub: 0.16 * Math.pow(10, 3.6 / 20), padLow: 0.68 })
  const handed = mixCheck(sumOf(handedTracks))
  const previous = { label: 'MIX 1', summary: mix1.summary }
  const before = buildFindings(handed, { previous })
  const codes = before.findings.map(f => f.code)
  check('Mix Check notes the sub up and the low mids down since MIX 1', codes.includes('changed.sub') && codes.includes('changed.lowMid') && codes.length === 2,
    before.findings.map(f => f.title).join(' | '))

  // What the helper has: the job's notes and bands, and the exported tracks.
  const notes = before.findings.map((f, i) => ({ id: `note-${i}`, kind: 'mix-check', code: f.code }))
  const windows = coreWindows(handed.detail.sections)
  const measured = Object.entries(handedTracks).map(([name, t]) => ({ name, spec: meter(t, windows).spec }))
  const plan = planFixes({ notes, bands: before.bands, tracks: measured })
  const line = plan.moves.map(m => `${m.track} ${m.kind}${m.hz ? ` ${m.hz} Hz` : ''} ${m.gainDb}`).join(' | ')
  check('the plan answers both notes', plan.moves.length === 2 && plan.skipped.length === 0, line)
  const subMove = plan.moves.find(m => m.code === 'changed.sub'), midMove = plan.moves.find(m => m.code === 'changed.lowMid')
  check('the sub is answered by turning the sub track down, the plain undo', subMove?.track === 'Sub' && subMove.kind === 'level' && subMove.gainDb < -1.5 && subMove.gainDb > -3.6, line)
  check('the low mids by a bell on the pad, not its fader (which would move the mids too)', midMove?.track === 'Pad' && midMove.kind === 'eq' && midMove.hz === 354 && midMove.gainDb > 1 && midMove.gainDb < MAX_MOVE_DB, line)
  check('each move carries the note it answers', subMove?.note_id === notes.find(n => n.code === 'changed.sub').id && midMove?.band === 'lowMid')
  check('it predicts every band inside the note threshold', plan.predicted.every(p => Math.abs(p.after) <= CLEAR_DB) && Math.abs(plan.loudnessShift) < 1,
    plan.predicted.map(p => `${p.key} ${p.before}→${p.after}`).join(', '))

  // Carry it out for real and let Mix Check judge.
  const fixed = mixCheck(sumOf(carryOut(handedTracks, plan.moves)))
  const after = buildFindings(fixed, { previous })
  const verdict = judgeFix(before.findings, after.findings, plan.moves.map(m => m.code))
  check('Mix Check on the new bounce: both notes gone, none new', verdict.keep && verdict.cleared.length === 2 && after.findings.length === 0,
    after.bands.map(b => `${b.key} ${b.vsPrevious}`).join(', '))
  const off = plan.predicted.map((p, i) => Math.abs(p.after - after.bands[i].vsPrevious))
  check('the prediction was within 0.6 dB of what Mix Check then measured, in every band', Math.max(...off) <= 0.6, `worst ${Math.max(...off).toFixed(2)} dB`)
  check('nothing is over-corrected: each fixed band keeps the direction of the change', after.bands.find(b => b.key === 'sub').vsPrevious > 0 && after.bands.find(b => b.key === 'lowMid').vsPrevious < 0)

  // The same through the command the helper runs: files on disk, decoded by ffmpeg.
  const dir = mkdtempSync(join(tmpdir(), 'intern-rules-'))
  try {
    const cli = fileURLToPath(new URL('./intern-plan.mjs', import.meta.url))
    const run = (...argv) => JSON.parse(execFileSync(process.execPath, [cli, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
    mkdirSync(join(dir, 'tracks'))
    for (const [name, t] of Object.entries(handedTracks)) writeWav(join(dir, 'tracks', `${name}.wav`), t)
    writeWav(join(dir, 'tracks', 'Stereo Out.wav'), sumOf(handedTracks))
    writeFileSync(join(dir, 'tracks', 'notes.txt'), 'not audio')
    writeWav(join(dir, 'handed.wav'), sumOf(handedTracks))
    writeWav(join(dir, 'fixed.wav'), sumOf(carryOut(handedTracks, plan.moves)))
    writeWav(join(dir, 'half.wav'), sumOf(carryOut(handedTracks, plan.moves.map(m => ({ ...m, gainDb: m.gainDb * 0.3 })))))
    // What POST /api/intern/jobs/claim answers with, as far as the rules read it.
    const claim = { job: { notes }, song: { findings: before.findings, bands: before.bands, sections: handed.detail.sections, baseline: { label: 'MIX 1', summary: mix1.summary } } }
    writeFileSync(join(dir, 'claim.json'), JSON.stringify(claim))

    const planned = run('plan', '--job', join(dir, 'claim.json'), '--tracks', join(dir, 'tracks'), '--mix', join(dir, 'handed.wav'), '--skip', '^stereo out$')
    writeFileSync(join(dir, 'plan.json'), JSON.stringify(planned))
    check('the command plans the same moves from the files', planned.moves.length === 2 && planned.moves.every(m => plan.moves.some(x => x.track === m.track && x.kind === m.kind && Math.abs(x.gainDb - m.gainDb) <= 0.1)),
      planned.moves.map(m => `${m.track} ${m.kind} ${m.gainDb}`).join(' | '))
    check('…from the tracks only: the skipped file and the text file are left out', planned.tracks.length === 4 && planned.tracks.every(t => t.frames > 0) && planned.unreadable.length === 0, planned.tracks.map(t => t.name).join(', '))
    check('…says which track carries which band', planned.tracks.find(t => t.name === 'Pad').share.lowMid > 0.95 && planned.tracks.find(t => t.name === 'Hats').share.air > 0.9)
    check('…and that the tracks add up to the mix, band by band', planned.sumVsMix.every(b => b.db != null && Math.abs(b.db) <= 0.3), planned.sumVsMix.map(b => `${b.key} ${b.db}`).join(', '))
    check('…with the change list ready to report', planned.changes.length === 2 && planned.changes.every(c => c.track && c.what && c.to && c.note_id))

    const good = run('judge', '--job', join(dir, 'claim.json'), '--bounce', join(dir, 'fixed.wav'))
    check('the command judges the fixed bounce: keep', good.keep && good.cleared.length === 2 && good.final === false && good.comparedWith === 'MIX 1' && good.loudness.integratedLufs < 0, JSON.stringify(good.bands.map(b => b.after)))
    const same = run('judge', '--job', join(dir, 'claim.json'), '--bounce', join(dir, 'handed.wav'))
    check('…and an unchanged bounce: both notes remain, nothing to upload', !same.keep && same.remaining.length === 2 && same.bands.every(b => Math.abs(b.after - b.before) <= 0.1))

    const half = run('judge', '--job', join(dir, 'claim.json'), '--bounce', join(dir, 'half.wav'))
    writeFileSync(join(dir, 'judge.json'), JSON.stringify(half))
    writeFileSync(join(dir, 'plan-tried.json'), JSON.stringify({ ...planned, moves: planned.moves.map(m => ({ ...m, gainDb: Math.round(m.gainDb * 3) / 10 })) }))
    const next = run('refine', '--plan', join(dir, 'plan-tried.json'), '--judge', join(dir, 'judge.json'))
    const tried = JSON.parse(readFileSync(join(dir, 'plan-tried.json'), 'utf8')).moves
    const grew = next.moves.every((m, i) => (half.remaining.includes(m.code)
      ? Math.abs(m.gainDb) >= Math.abs(tried[i].gainDb) * 1.5 && Math.abs(m.gainDb) <= MAX_MOVE_DB
      : m.gainDb === tried[i].gainDb))
    check('a bounce that fell short gets a larger move for the note that remains, and the settled one is left', !half.keep && half.remaining.length >= 1 && next.changed && grew,
      `remaining ${half.remaining.join(', ')}: ${tried.map((m, i) => `${m.track} ${m.gainDb} → ${next.moves[i].gainDb}`).join(' | ')}`)

    let usage = ''
    try { execFileSync(process.execPath, [cli, 'judge', '--job', join(dir, 'claim.json')], { stdio: ['ignore', 'pipe', 'pipe'] }) } catch (err) { usage = `${err.status}:${err.stderr}` }
    check('a missing argument is an error, not a guess', usage.startsWith('2:') && /Missing --bounce/.test(usage))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // The same plan when the export gives the tracks in another order.
  const again = planFixes({ notes: [...notes].reverse(), bands: before.bands, tracks: [...measured].reverse() })
  check('the plan does not depend on the order things arrive in', JSON.stringify(again.moves) === JSON.stringify(plan.moves))
}

// ── What it refuses ──────────────────────────────────────────────────────────

console.log('\nintern rules: what it leaves alone\n')
{
  const flat = hz => INTERN_SPEC_HZ.map(f => (f >= hz[0] && f < hz[1] ? 1 : 0))
  const bands = vs => MIX_BANDS.map(b => ({ key: b.key, vsPrevious: vs[b.key] ?? 0 }))
  const sub = { name: 'Sub', spec: flat([30, 65]) }
  const rest = { name: 'Music', spec: flat([65, 16000]) }

  const none = planFixes({ notes: [{ id: 'a', kind: 'listener', code: null }, { id: 'b', kind: 'mix-check', code: 'changed.loudness' }, { id: 'c', kind: 'mix-check', code: 'balance.sub' }], bands: bands({}), tracks: [sub, rest] })
  check('a written note, a loudness note and a catalog note have no rule: skipped, with why', none.moves.length === 0 && none.skipped.length === 3 && /judgment/.test(none.skipped[0].why) && /no rule/.test(none.skipped[1].why))
  check('the genre note is not something it knows how to chase', planFixes({ notes: [{ id: 'g', kind: 'mix-check', code: 'genre.balance' }], bands: bands({}), tracks: [sub] }).moves.length === 0)

  const noTracks = planFixes({ notes: [{ id: 'a', kind: 'mix-check', code: 'changed.sub' }], bands: bands({ sub: 3.4 }), tracks: [{ name: 'bad', spec: [1, 2, 3] }, { name: 'silent', spec: INTERN_SPEC_HZ.map(() => 0) }] })
  check('no measurable track: skipped, not guessed', noTracks.moves.length === 0 && /No exported track/.test(noTracks.skipped[0].why))

  const ok = planFixes({ notes: [{ id: 'a', kind: 'mix-check', code: 'changed.sub' }], bands: bands({ sub: 3.4 }), tracks: [sub, rest] })
  check('a sub 3.4 dB up on its own track: that track down by about 2.4 dB', ok.moves.length === 1 && ok.moves[0].kind === 'level' && Math.abs(ok.moves[0].gainDb + 2.4) <= 0.2, `${ok.moves[0]?.gainDb} dB`)

  const huge = planFixes({ notes: [{ id: 'a', kind: 'mix-check', code: 'changed.sub' }], bands: bands({ sub: -11 }), tracks: [sub, rest] })
  check(`a change no move of ${MAX_MOVE_DB} dB answers is a mix decision: skipped`, huge.moves.length === 0 && /clears this/.test(huge.skipped[0].why), huge.skipped[0]?.why)

  // The band is spread thin over many tracks: no three of them can carry the fix.
  const thin = Array.from({ length: 12 }, (_, i) => ({ name: `Layer ${i + 1}`, spec: flat([30, 16000]) }))
  const spread = planFixes({ notes: [{ id: 'a', kind: 'mix-check', code: 'changed.lowMid' }], bands: bands({ lowMid: -5.5 }), tracks: thin })
  check(`a band no ${MAX_TRACKS_PER_NOTE} tracks carry is not chased across the whole session`, spread.moves.length === 0 && spread.skipped.length === 1)

  // One track carries two bands and only one of them is off: its fader is the wrong tool.
  const lows = { name: 'Bass', spec: flat([30, 120]) }
  const two = planFixes({ notes: [{ id: 'a', kind: 'mix-check', code: 'changed.sub' }], bands: bands({ sub: 4, punch: -1.8 }), tracks: [lows, { name: 'Music', spec: flat([120, 16000]) }] })
  const after = Object.fromEntries(two.predicted.map(p => [p.key, p.after]))
  check('a fix never pushes a band that was fine into a note of its own', two.moves.every(m => m.kind === 'eq') && Math.abs(after.punch) < NOTE_AT_DB - 0.25 && (two.moves.length === 0 || Math.abs(after.sub) <= CLEAR_DB),
    `${two.moves.map(m => `${m.kind} ${m.gainDb}`).join(', ') || 'skipped'}; punch ${after.punch}, sub ${after.sub}`)

  const dup = planFixes({ notes: [{ id: 'a', kind: 'mix-check', code: 'changed.sub' }], bands: bands({ sub: 3.4 }), tracks: [sub, { name: 'Sub', spec: flat([30, 65]) }, rest] })
  check('two files with one name are one track, not double the sub', dup.moves.length === 1 && Math.abs(dup.moves[0].gainDb - ok.moves[0].gainDb) < 0.05)
}

// ── After the bounce ─────────────────────────────────────────────────────────

console.log('\nintern rules: after the bounce\n')
{
  const move = { kind: 'eq', track: 'Pad', gainDb: 3, ...bellFor('lowMid'), band: 'lowMid', code: 'changed.lowMid', note_id: 'n1' }
  check('a move that did half of what was wanted is tried again larger', refineMove(move, 1.6, 0.8)?.gainDb === 6)
  check('…never past the limit', refineMove({ ...move, gainDb: 5 }, 2, 1).gainDb === MAX_MOVE_DB)
  check('one that overshot is tried smaller', refineMove(move, 1.6, 2.4)?.gainDb === 2)
  check('one that did nothing, or went the wrong way, is given up', refineMove(move, 1.6, 0.1) === null && refineMove(move, 1.6, -0.5) === null && refineMove(move, 1.6, NaN) === null)
  check('one that is already right is left', refineMove(move, 1.6, 1.55) === null)

  const d = describeMove(move), l = describeMove({ kind: 'level', track: 'Sub', gainDb: -2.4, band: 'sub', code: 'changed.sub', note_id: null })
  check('a move reads as a line of the change list', d.track === 'Pad' && d.what === 'EQ bell at 354 Hz (Q 1.41)' && d.from === '0.0 dB' && d.to === '+3.0 dB' && d.note_id === 'n1', `${d.what}: ${d.from} → ${d.to}`)
  check('…a level move too, with no note id when there is none', l.what === 'Level' && l.to === '−2.4 dB' && !('note_id' in l))
  const { sanitizeReport } = await import('../src/lib/intern-jobs.ts')
  check('…and the server accepts it as written', sanitizeReport({ changes: [d, l] }).changes.length === 2)

  const was = [{ code: 'changed.sub' }, { code: 'changed.lowMid' }, { code: 'changed.loudness' }]
  check('kept: every handled note gone, nothing new', judgeFix(was, [{ code: 'changed.loudness' }], ['changed.sub', 'changed.lowMid']).keep)
  const half = judgeFix(was, [{ code: 'changed.lowMid' }], ['changed.sub', 'changed.lowMid'])
  check('not kept while a handled note remains', !half.keep && half.cleared[0] === 'changed.sub' && half.remaining[0] === 'changed.lowMid')
  const fresh = judgeFix(was, [{ code: 'changed.punch' }], ['changed.sub', 'changed.lowMid'])
  check('not kept when a new note appeared', !fresh.keep && fresh.appeared[0] === 'changed.punch')
  check('the genre note counts neither way', judgeFix(was, [{ code: 'genre.balance' }], ['changed.sub', 'changed.lowMid']).keep)
  check('nothing handled is nothing to keep', !judgeFix(was, [], []).keep)
  const placed = [...was, { code: 'drop.smaller@157' }, { code: 'resonance.3175' }]
  check('a note that only moved by a second or a few hertz is the same note', judgeFix(placed, [{ code: 'drop.smaller@158' }, { code: 'resonance.3364' }], ['changed.sub', 'changed.lowMid']).keep)
  check('…a second one of its kind is a new note', judgeFix(placed, [{ code: 'drop.smaller@158' }, { code: 'drop.smaller@201' }], ['changed.sub', 'changed.lowMid']).appeared[0] === 'drop.smaller')
  check('what the Mac can judge alone leaves out the catalog and genre comparisons, not left/right balance',
    locallyJudged([{ code: 'changed.sub' }, { code: 'balance.sub' }, { code: 'genre.balance' }, { code: 'balance.lr' }, { code: 'peak.clip' }]).map(f => f.code).join() === 'changed.sub,balance.lr,peak.clip')
}

// ── No AI, nothing billed ────────────────────────────────────────────────────

console.log('\nintern rules: measured notes are fixed by rules alone\n')
{
  const src = readFileSync(new URL('../src/lib/intern-rules.ts', import.meta.url), 'utf8')
  const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1])
  check('the rules import only the measuring code', imports.length === 2 && imports.includes('./mix-check.ts') && imports.includes('./loudness.ts'), imports.join(', '))
  check('no network, no model', !/fetch\(|anthropic|claude|openai|replicate/i.test(src))
  check('the threshold is Mix Check\'s own', new RegExp(`Math\\.abs\\(b\\.vsPrevious\\) >= ${NOTE_AT_DB}\\b`).test(readFileSync(new URL('../src/lib/mix-check-findings.ts', import.meta.url), 'utf8')))
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
