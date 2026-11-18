#!/usr/bin/env node
// Contract test for src/lib/release-isrc.ts — when the release-day ISRC lookup
// runs, and how a pipeline release is matched to its library ISRC. No network.
//
// Why it matters: the owner asked for the lookup to happen on its own on the
// release date, "Daily is excessive" (2026-11-18). Too eager and it hammers the
// catalog every day; too lazy and a release silently never gets its ISRC, which
// a waterfall re-release needs to keep its streams.
//
// Run: node scripts/release-isrc-test.mjs   (also part of `npm test`)

import {
  isReleaseDue, matchLibraryCodes, titleKey, easternParts, daysBetween,
  RETRY_DAYS, BACKFILL_MAX_AGE_DAYS,
} from '../src/lib/release-isrc.ts'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS  ${name}`)
  else { failures++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ── dates ────────────────────────────────────────────────────────────────────
check('daysBetween same day', daysBetween('2026-11-20', '2026-11-20') === 0)
check('daysBetween across a month', daysBetween('2026-10-23', '2026-11-18') === 26)
check('eastern date before midnight ET is still the old day',
  easternParts(new Date('2026-11-21T04:30:00Z')).date === '2026-11-20')
check('eastern date after midnight ET', easternParts(new Date('2026-11-21T05:30:00Z')).date === '2026-11-21')
check('eastern hour', easternParts(new Date('2026-11-18T14:00:00Z')).hour === 9)
check('eastern hour in summer (EDT)', easternParts(new Date('2026-07-01T13:00:00Z')).hour === 9)

// ── schedule ─────────────────────────────────────────────────────────────────
const REL = '2026-11-20'
check('release day, never looked: due', isReleaseDue(REL, null, REL, '2026-11-01'))
check('release day, empty string ISRC: due', isReleaseDue(REL, '  ', REL, '2026-11-01'))
check('has an ISRC: never due', !isReleaseDue(REL, 'QT3EZ2600001', REL, null))
check('not out yet: not due', !isReleaseDue(REL, null, '2026-11-19', null))
check('no release date: not due', !isReleaseDue(null, null, REL, null))
check('bad release date: not due', !isReleaseDue('2026-11', null, REL, null))
check('looked on release day, next day: not due', !isReleaseDue(REL, null, '2026-11-21', REL))
check('retry 2 days later', isReleaseDue(REL, null, '2026-11-22', REL))
check('retry a week later', isReleaseDue(REL, null, '2026-11-27', '2026-11-22'))
check('already retried today: not again', !isReleaseDue(REL, null, '2026-11-22', '2026-11-22'))
check('after the last retry: left alone', !isReleaseDue(REL, null, '2026-11-28', '2026-11-27'))
check('a month later, still missing: left alone', !isReleaseDue(REL, null, '2026-12-20', '2026-11-27'))
check('missed release day (server down): looked next day', isReleaseDue(REL, null, '2026-11-21', '2026-11-19'))
check('retries are few', RETRY_DAYS.length <= 2, `got ${RETRY_DAYS.join(',')}`)

// The backlog this was built for: released while nothing was looking.
check('backlog: BLINKERS (Oct 9) after a Sep 10 sync', isReleaseDue('2026-10-09', null, '2026-11-18', '2026-09-10'))
check('backlog: REGARDLESS (Oct 23) after a Sep 10 sync', isReleaseDue('2026-10-23', null, '2026-11-18', '2026-09-10'))
check('backlog: looked once, then left alone', !isReleaseDue('2026-10-09', null, '2026-11-19', '2026-11-18'))
check('backlog: older than a sync that already ran is not retried', !isReleaseDue('2026-08-28', null, '2026-11-18', '2026-09-10'))
check('backlog bounded', !isReleaseDue('2026-01-01', null, '2026-11-18', null),
  `cap is ${BACKFILL_MAX_AGE_DAYS} days`)
check('never synced at all, recent release: due', isReleaseDue('2026-11-01', null, '2026-11-18', null))

// Over a whole month, a release that never shows up is looked up at most 3 times.
{
  let lastSync = '2026-11-01'
  let looks = 0
  for (let d = 0; d < 40; d++) {
    const today = new Date(Date.UTC(2026, 10, 20 + d)).toISOString().slice(0, 10)
    if (isReleaseDue(REL, null, today, lastSync)) { looks++; lastSync = today }
  }
  check('a release that never shows up is looked up 3 times in all', looks === 3, `got ${looks}`)
}

// ── matching ─────────────────────────────────────────────────────────────────
check('titleKey ignores case and punctuation', titleKey('Kick It W/U') === titleKey('KICK IT W/U'))
check('titleKey strips accents', titleKey('Batidão') === titleKey('batidao'))
check('titleKey keeps different words different', titleKey('SIDEWAYS') !== titleKey('SIDEWAYZ'))

const library = [
  { title: 'BLINKERS', isrc: 'QT3EZ2600010', upc: '198000000010', release_date: '2026-10-09' },
  { title: 'BLINKERS', isrc: 'QT3EZ2600010', upc: '198000000099', release_date: '2026-11-20' },
  { title: 'Regardless', isrc: 'QT3EZ2600011', upc: '198000000011', release_date: '2026-10-23' },
  { title: 'NO CODE', isrc: null, upc: '198000000012', release_date: '2026-10-30' },
]
const b = matchLibraryCodes({ title: 'BLINKERS', release_date: '2026-10-09' }, library)
check('match: ISRC found', b?.isrc === 'QT3EZ2600010')
check('match: UPC from the same-day release', b?.upc === '198000000010')
const r = matchLibraryCodes({ title: 'REGARDLESS', release_date: '2026-10-23' }, library)
check('match: case-insensitive title', r?.isrc === 'QT3EZ2600011')
const ep = matchLibraryCodes({ title: 'BLINKERS', release_date: '2026-12-01' }, library)
check('match: other drop keeps the ISRC', ep?.isrc === 'QT3EZ2600010')
check('match: other drop takes no UPC', ep?.upc === null)
check('match: library row without ISRC is no match', matchLibraryCodes({ title: 'NO CODE', release_date: '2026-10-30' }, library) === null)
check('match: unknown title', matchLibraryCodes({ title: 'BUGONIA', release_date: '2026-11-20' }, library) === null)
check('match: empty title', matchLibraryCodes({ title: '  ', release_date: null }, library) === null)

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nrelease-isrc: all checks passed')
