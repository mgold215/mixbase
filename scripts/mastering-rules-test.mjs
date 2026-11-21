#!/usr/bin/env node
// The mastering engineer's rules (src/lib/mastering-rules.ts): which
// output-channel move answers a whole-mix note, and the last look before an
// upload. Pure checks: no Mac, no Logic, no network.
//
// Run: node scripts/mastering-rules-test.mjs  (part of `npm test`)
import { MASTER_MAX_DB, CEILING_DBTP, deliverableProblems, masteringHasRule, masteringJudgedLocally, neutral, planMastering } from '../src/lib/mastering-rules.ts'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const note = (code, id = code) => ({ id, kind: 'mix-check', code })
const bounce = (over = {}) => ({ bands: [{ key: 'presence', after: 0 }, { key: 'sub', after: -1 }], findings: [], truePeakDb: -1.7, ...over })

console.log('mastering engineer: which notes are its own\n')
check('whole-mix notes: a band against the catalog, a stereo low end, peaks, loudness, left/right, DC, a cut-off ending',
  ['balance.presence', 'balance.sub', 'mono.low@95', 'peak.over', 'peak.clip', 'changed.loudness', 'balance.lr', 'dc.offset', 'tail.cut'].every(masteringHasRule)
  && !['genre.balance', 'changed.sub', 'drop.quieter@46', 'dynamics.crushed', 'dropout@12', null].some(masteringHasRule))
check('the catalog comparison cannot be judged from a bounce alone', !masteringJudgedLocally('balance.presence') && masteringJudgedLocally('peak.over') && masteringJudgedLocally('mono.low@95'))

console.log('\nmastering engineer: a band heavy against the catalog\n')
const heavy = planMastering({ notes: [note('balance.presence')], handedBands: [{ key: 'presence', vsPrevious: 0, vsCatalog: 3.8 }], bounce: bounce() })
check('one wide bell cut on the band, on no particular track yet', heavy.moves.length === 1 && heavy.moves[0].kind === 'eq' && heavy.moves[0].track === '' && heavy.moves[0].band === 'presence' && heavy.moves[0].gainDb < 0, JSON.stringify(heavy.moves[0]))
check('sized to bring it just inside the note, and never past the limit', heavy.moves[0].gainDb === -1.9 && planMastering({ notes: [note('balance.presence')], handedBands: [{ key: 'presence', vsPrevious: 0, vsCatalog: 9 }], bounce: bounce() }).moves[0].gainDb === -MASTER_MAX_DB)
const shifted = planMastering({ notes: [note('balance.presence')], handedBands: [{ key: 'presence', vsPrevious: 0, vsCatalog: 3.8 }], bounce: bounce({ bands: [{ key: 'presence', after: -1.2 }] }) })
check('it works from where the band is NOW: one the intern already brought back is left', shifted.moves.length === 0 && /Already back inside your usual range/.test(shifted.skipped[0].why))
const light = planMastering({ notes: [note('balance.sub')], handedBands: [{ key: 'sub', vsPrevious: -1, vsCatalog: -8 }], bounce: bounce() })
check('a band that is LIGHT is never boosted after the limiter', light.moves.length === 0 && /boost on the output/.test(light.skipped[0].why))

console.log('\nmastering engineer: low end and peaks\n')
const mono = planMastering({ notes: [note('mono.low@95'), note('mono.low@143')], handedBands: [], bounce: bounce({ findings: [{ code: 'mono.low@96' }, { code: 'mono.low@150' }] }) })
check('one move makes the whole low end mono, however many notes ask', mono.moves.length === 1 && mono.moves[0].kind === 'mono' && mono.moves[0].hz === 120 && mono.skipped.length === 0)
check('a note the intern answered on a track is not answered again', planMastering({ notes: [note('mono.low@95')], handedBands: [], bounce: bounce({ findings: [{ code: 'mono.low@95' }] }), answered: ['mono.low@95'] }).moves.length === 0)
check('a note no longer in the bounce is left', /No longer in the bounce/.test(planMastering({ notes: [note('mono.low@95')], handedBands: [], bounce: bounce() }).skipped[0].why))
const over = planMastering({ notes: [note('peak.over')], handedBands: [], bounce: bounce({ truePeakDb: 0.4 }) })
check('a true peak over is trimmed down to the ceiling', over.moves[0].kind === 'level' && Math.abs(over.moves[0].gainDb - (CEILING_DBTP - 0.4)) < 0.05, String(over.moves[0].gainDb))
check('…and never trimmed when it is already under', planMastering({ notes: [note('peak.over')], handedBands: [], bounce: bounce() }).moves.length === 0)
const both = planMastering({ notes: [note('peak.clip'), note('changed.loudness')], handedBands: [], previousLufs: -9.5, bounce: bounce({ truePeakDb: 0.2, integratedLufs: -7.0 }) })
check('a peak and a loudness note share ONE trim, the larger of the two', both.moves.length === 1 && both.moves[0].kind === 'level' && both.moves[0].gainDb === -1.5 && both.alsoAnswers.length === 1, JSON.stringify(both))
const quiet = planMastering({ notes: [note('changed.loudness')], handedBands: [], previousLufs: -9.5, bounce: bounce({ truePeakDb: -3.0, integratedLufs: -12.0 }) })
check('a mix that got quieter comes up only as far as the peaks allow', quiet.moves[0].gainDb === 1.5 && planMastering({ notes: [note('changed.loudness')], handedBands: [], previousLufs: -9.5, bounce: bounce({ truePeakDb: -1.0, integratedLufs: -12.0 }) }).moves.length === 0)
const lr = planMastering({ notes: [note('balance.lr')], handedBands: [], bounce: bounce({ balanceDb: 2 }) })
check('a louder left is met by a balance setting to the right, sized from the difference', lr.moves[0].kind === 'level' && lr.moves[0].gainDb === 0 && lr.moves[0].balancePct === 21, JSON.stringify(lr.moves[0]))
const dc = planMastering({ notes: [note('dc.offset'), note('tail.cut')], handedBands: [], bounce: bounce() })
check('a DC offset gets a 20 Hz low cut; a cut-off ending is a bounce with its tail', dc.moves.length === 1 && dc.moves[0].kind === 'lowcut' && dc.moves[0].hz === 20 && dc.bounce.tail === true && dc.alsoAnswers.includes('tail.cut'))
const merged = planMastering({ notes: [note('peak.over'), note('balance.lr')], handedBands: [], bounce: bounce({ truePeakDb: 0, balanceDb: -2 }) })
check('a trim and a balance move are one plug-in, so one move', merged.moves.length === 1 && merged.moves[0].gainDb === -1 && merged.moves[0].balancePct === -21 && [merged.moves[0].code, ...merged.alsoAnswers].sort().join() === 'balance.lr,peak.over', JSON.stringify(merged))
check('a note that is not its own is not mentioned', planMastering({ notes: [note('changed.sub'), { id: 'x', kind: 'listener', code: null }], handedBands: [], bounce: bounce() }).skipped.length === 0)

console.log('\nmastering engineer: taking a move back, and the last look\n')
check('a move taken back has nothing left of it', neutral(heavy.moves[0]).gainDb === 0 && neutral(mono.moves[0]).off === true && neutral(dc.moves[0]).off === true && neutral(merged.moves[0]).balancePct === 0)
const a = { seconds: 268, integratedLufs: -9.5, truePeakDb: -1.8 }
check('the same audio, only better, passes', deliverableProblems(a, { seconds: 268.2, integratedLufs: -9.8, truePeakDb: -1.9 }).length === 0)
check('a bounce that changed length, moved in loudness or gained peaks does not',
  deliverableProblems(a, { ...a, seconds: 240 }).length === 1 && deliverableProblems(a, { ...a, integratedLufs: -12 }).length === 1 && deliverableProblems(a, { ...a, truePeakDb: -0.2 }).length === 1)

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
