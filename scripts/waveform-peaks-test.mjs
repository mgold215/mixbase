#!/usr/bin/env node
// Unit tests for the waveform math behind GET /api/share/<token>/peaks
// (src/lib/waveform-peaks.ts). Pure — no DB, no ffmpeg.
// Run: node scripts/waveform-peaks-test.mjs

import { BARS, PEAK_SCALE, peaksFromPcm16, normalisePeaks, isPeakList, resamplePeaks } from '../src/lib/waveform-peaks.ts'

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}

// Little-endian 16-bit PCM from an array of sample values.
function pcm(samples) {
  const buf = new Uint8Array(samples.length * 2)
  const view = new DataView(buf.buffer)
  samples.forEach((v, i) => view.setInt16(i * 2, v, true))
  return buf
}

console.log('waveform-peaks: folding PCM into bars\n')

check('empty input → no bars', peaksFromPcm16(new Uint8Array(0)).length === 0)
check('silence → all zeros', peaksFromPcm16(pcm(new Array(4000).fill(0)), 10).every(v => v === 0))

// 10 bars of 100 samples each; bar k holds one spike of height (k+1)*1000.
const spiky = []
for (let k = 0; k < 10; k++) for (let i = 0; i < 100; i++) spiky.push(i === 50 ? (k + 1) * 1000 : 0)
const out = peaksFromPcm16(pcm(spiky), 10)
check('bar count honours the request', out.length === 10, String(out.length))
check('loudest bar normalises to PEAK_SCALE', out[9] === PEAK_SCALE, String(out[9]))
check('bars scale linearly with their loudest sample', out[4] === 50 && out[0] === 10, out.join(','))
check('negative samples count by magnitude', peaksFromPcm16(pcm([0, -32768, 0, 100]), 2)[0] === PEAK_SCALE)
check('default bar count is BARS', peaksFromPcm16(pcm(new Array(BARS * 7).fill(1000))).length === BARS)
check('fewer samples than bars still returns a full-length list', peaksFromPcm16(pcm([5, 9, 3]), 8).length === 8)
check('odd trailing byte is ignored', peaksFromPcm16(new Uint8Array([0xff, 0x7f, 0x01]), 1)[0] === PEAK_SCALE)

console.log('\nnormalise / validate / resample\n')
check('normalisePeaks is a no-op shape on zeros', normalisePeaks([0, 0]).join() === '0,0')
check('normalisePeaks rounds to integers', normalisePeaks([1, 3]).join() === '33,100')
check('isPeakList accepts the column shape', isPeakList([0, 50, 100]))
check('isPeakList rejects floats', !isPeakList([0.5, 1]))
check('isPeakList rejects out-of-range', !isPeakList([0, 101]) && !isPeakList([-1]))
check('isPeakList rejects empty / non-array / oversized', !isPeakList([]) && !isPeakList('x') && !isPeakList(new Array(BARS * 2 + 1).fill(1)))
check('resample down keeps the max of each window', resamplePeaks([10, 90, 20, 30], 2).join() === '90,30')
check('resample up repeats', resamplePeaks([10, 90], 4).join() === '10,10,90,90')
check('resample same length copies', resamplePeaks([1, 2, 3], 3).join() === '1,2,3')
check('resample to 0 → empty', resamplePeaks([1, 2], 0).length === 0)

if (failures) { console.error(`\nwaveform-peaks: ${failures} check(s) failed`); process.exit(1) }
console.log('\nwaveform-peaks: all checks passed')
