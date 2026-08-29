#!/usr/bin/env node
// Branch coverage for src/lib/master-recommendations.ts — the limiter/chain
// advice the Master Check derives from a loudness measurement. Each case is a
// measurement shaped like a real mastering situation; assertions check which
// advice areas fire and that the numbers baked into the text are the measured
// ones, not stale copy. Runs on Node TS type-stripping like the other suites.
// Run: node scripts/master-recommendations-test.mjs  (part of `npm test`)

import { masterRecommendations } from '../src/lib/master-recommendations.ts'

let failures = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    console.error(`  ✗ ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
    failures++
  }
}

const measure = (integratedLufs, samplePeakDb, shortTermMaxLufs) =>
  ({ integratedLufs, samplePeakDb, shortTermMaxLufs, gatedBlockCount: 100 })

const areas = (recs) => recs.map(r => r.area)
const byArea = (recs, area) => recs.find(r => r.area === area)

// ── Unmeasurable audio gets no advice (the verdict already errors) ──────────
console.log('recs: unmeasurable input')
check('-Infinity integrated → no recommendations',
  masterRecommendations(measure(-Infinity, -1, -Infinity)).length === 0)

// ── Slammed club master: hot peak, tiny PLR, flat sections ──────────────────
console.log('\nrecs: slammed club master (−6 LUFS, −0.1 dBFS peak, flat)')
{
  const recs = masterRecommendations(measure(-6, -0.1, -5.2))
  check('ceiling advice fires for a hot peak', byArea(recs, 'Output ceiling') !== undefined, areas(recs).join(', '))
  check('ceiling advice recommends −1.0 dBTP', /−1\.0 dBTP/.test(byArea(recs, 'Output ceiling')?.advice ?? ''))
  check('drive advice fires for PLR < 6', byArea(recs, 'Limiter drive') !== undefined)
  check('drive advice carries the measured PLR', /5\.9 dB/.test(byArea(recs, 'Limiter drive')?.advice ?? ''),
    byArea(recs, 'Limiter drive')?.advice)
  check('flat-sections advice fires (wall-to-wall loud master)',
    /wall-to-wall/.test(byArea(recs, 'Before the limiter')?.advice ?? ''))
  check('release/style advice fires for a dense master', byArea(recs, 'Release & style') !== undefined)
  check('chain-order advice always present', byArea(recs, 'Chain order') !== undefined)
  check('every rec names Pro-L 2 or is DAW-side work',
    recs.every(r => !r.plugins || /Pro-L 2|Ozone 11|DAW/.test(r.plugins)))
}

// ── Quiet, dynamic master: big headroom, light limiting, big sections ──────
console.log('\nrecs: quiet dynamic master (−18 LUFS, −5.5 dBFS peak, +7 dB sections)')
{
  const recs = masterRecommendations(measure(-18, -5.5, -11))
  check('free-headroom advice fires', /unused headroom/.test(byArea(recs, 'Output ceiling')?.advice ?? ''),
    areas(recs).join(', '))
  check('headroom math is right (4.5 dB free below −1 dBTP)',
    /4\.5 dB/.test(byArea(recs, 'Output ceiling')?.advice ?? ''), byArea(recs, 'Output ceiling')?.advice)
  check('light-limiting drive advice fires (PLR 12.5, under −16)', /barely working/.test(byArea(recs, 'Limiter drive')?.advice ?? ''))
  check('section-leveling advice fires for +7 dB sections',
    /slams the drop/.test(byArea(recs, 'Before the limiter')?.advice ?? ''))
  check('no release/style advice for a quiet, uncompressed master',
    byArea(recs, 'Release & style') === undefined, areas(recs).join(', '))
}

// ── Healthy streaming master: nothing to scold, ceiling confirmation only ──
console.log('\nrecs: healthy streaming master (−12 LUFS, −1.0 dBFS peak)')
{
  const recs = masterRecommendations(measure(-12, -1.0, -9.5))
  check('ceiling confirmation fires at −1.0 dB', /right where it should be/.test(byArea(recs, 'Output ceiling')?.advice ?? ''),
    areas(recs).join(', '))
  check('no drive advice in the healthy PLR band', byArea(recs, 'Limiter drive') === undefined)
  check('chain-order advice still present', byArea(recs, 'Chain order') !== undefined)
}

// ── Structural invariants ───────────────────────────────────────────────────
console.log('\nrecs: structure')
{
  const all = [
    masterRecommendations(measure(-6, -0.1, -5.2)),
    masterRecommendations(measure(-18, -6, -11)),
    masterRecommendations(measure(-12, -1.0, -9.5)),
    masterRecommendations(measure(-14, -0.05, -8)),
  ]
  check('every rec has a non-empty area and advice',
    all.flat().every(r => r.area.length > 0 && r.advice.length > 10))
  check('advice stays scannable (≤ 6 recs per measurement)', all.every(recs => recs.length <= 6),
    all.map(r => r.length).join(', '))
}

console.log(failures === 0 ? '\nAll master-recommendations tests passed' : `\n${failures} master-recommendations test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
