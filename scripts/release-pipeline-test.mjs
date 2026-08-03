#!/usr/bin/env node
// Contract test: the release pipeline's pure logic — DistroKid prep, waterfall
// sequencing, and release-date formatting.
//
// Why this suite exists: `src/lib/distrokid.ts` and `src/lib/release-plan.ts`
// carry ~400 lines of pure logic that drives what a musician actually submits
// to a distributor — tracklists, ISRC reuse, drop dates — and shipped with ZERO
// test coverage. The runner enforces "every suite on disk is listed", but
// nothing enforced "every pure lib has a suite", so the newest and most
// consequential logic in the app was the least guarded.
//
// It locks three real defects found on 2026-08-02, each with a fail-first
// witness proving the assertion catches the pre-fix behaviour:
//   1. Release dates rendered one day EARLY for every viewer at a negative UTC
//      offset — `new Date('2026-08-07').toLocaleDateString()` parses UTC
//      midnight then formats locally, so a Friday drop displayed as Thursday,
//      contradicting the planner's own "drop dates snap to Fridays" promise.
//   2. Clearing the Language field PATCHed an explicit null at a NOT NULL
//      column (migration 026) → 23502 → a hard 500, every time.
//   3. Waterfall tracklists must re-release earlier drops under their ORIGINAL
//      ISRC — getting this wrong resets a track's streams to zero on the DSPs,
//      which is the entire point of a waterfall.
//
// Pure — no DB, no network, no clock (today is always injected).
// Run: node scripts/release-pipeline-test.mjs  (also part of `npm run test:renderers`)

import {
  formatReleaseDate,
  releaseDatePresets,
  getReleaseStatus,
  releaseCompletionPercent,
  buildReleasePlan,
  PRE_LAUNCH_ITEMS,
  LAUNCH_CAMPAIGN_ITEMS,
  ymdUtc,
  daysUntilDate,
  isUpcomingRelease,
  compareReleaseDates,
} from '../src/lib/release-plan.ts'
import {
  coerceReleaseNulls,
  RELEASE_COLUMN_DEFAULTS,
  distroKidTracklist,
  waterfallSiblings,
  waterfallDates,
  releaseTypeForTrackCount,
  validateForDistroKid,
} from '../src/lib/distrokid.ts'

let failures = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

// Minimal Release shape — only the fields the pure helpers read.
const rel = (over = {}) => ({
  id: 'r1', title: 'Track', release_date: null, genre: null, label: null, isrc: null,
  notes: null, project_id: null, final_version_id: null, artist_name: null,
  release_type: 'single', featured_artists: null, songwriters: null, producers: null,
  explicit: false, instrumental: false, language: 'English', secondary_genre: null,
  version_info: null, upc: null, waterfall_group_id: null, waterfall_position: null,
  mixing_done: false, mastering_done: false, artwork_ready: false, dsp_submitted: false,
  social_posts_done: false, press_release_done: false,
  ...over,
})

// ── 1. Release-date formatting is timezone-stable ────────────────────────────
// The bug only manifests at a negative UTC offset, so pin the process TZ. This
// is the exact reproduction: 2026-08-07 is a Friday.
console.log('release dates render on the stored (UTC) calendar, in every timezone\n')

const FRIDAY = '2026-08-07'
check('a Friday formats as Friday (UTC basis)',
  formatReleaseDate(FRIDAY, { weekday: 'short', month: 'short', day: 'numeric' }) === 'Fri, Aug 7',
  formatReleaseDate(FRIDAY, { weekday: 'short', month: 'short', day: 'numeric' }))

check('default format keeps the stored day', formatReleaseDate(FRIDAY) === 'Aug 7, 2026',
  formatReleaseDate(FRIDAY))
check('blank date formats to empty string, not "Invalid Date"', formatReleaseDate(null) === '')
check('malformed date formats to empty string', formatReleaseDate('not-a-date') === '')

// Witness: the pre-fix expression, evaluated under the same process TZ. When
// the runner's TZ is negative-offset this proves the old code was wrong; under
// UTC both agree, so assert the RELATIONSHIP rather than a hard-coded string.
const preFix = new Date(FRIDAY).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
const offsetMin = new Date(`${FRIDAY}T00:00:00Z`).getTimezoneOffset()
if (offsetMin > 0) {
  check('witness: pre-fix expression drifts a day west of UTC', preFix !== 'Fri, Aug 7',
    `pre-fix rendered "${preFix}" at UTC offset -${offsetMin / 60}h`)
} else {
  check('witness: skipped — runner TZ is at/east of UTC, where the bug is invisible', true,
    `TZ offset ${-offsetMin / 60}h, pre-fix rendered "${preFix}"`)
}

// Presets are Friday-anchored; formatting them must not shift the day.
const presets = releaseDatePresets('2026-08-02') // a Sunday
check('every Friday preset still formats as a Friday',
  presets.every(p => formatReleaseDate(p.date, { weekday: 'short' }) === 'Fri'),
  presets.map(p => `${p.label}=${formatReleaseDate(p.date, { weekday: 'short' })}`).join(' '))

// ── 2. Clearing a NOT NULL column resets to its default, never writes null ───
console.log('\nclearing a NOT NULL release column falls back to its default')

check('language null → English', coerceReleaseNulls({ language: null }).language === 'English')
check('release_type null → single', coerceReleaseNulls({ release_type: null }).release_type === 'single')
check('explicit null → false', coerceReleaseNulls({ explicit: null }).explicit === false)
check('instrumental null → false', coerceReleaseNulls({ instrumental: null }).instrumental === false)

// The columns whose null IS meaningful must survive untouched — detaching a
// release from a waterfall run is exactly a null write.
const detach = coerceReleaseNulls({ waterfall_group_id: null, waterfall_position: null, notes: null })
check('waterfall_group_id null is preserved (detach must still work)', detach.waterfall_group_id === null)
check('waterfall_position null is preserved', detach.waterfall_position === null)
check('nullable text (notes) null is preserved', detach.notes === null)

// Real values and absent keys are never rewritten.
check('a real value passes through', coerceReleaseNulls({ language: 'Spanish' }).language === 'Spanish')
check('explicit:true is not coerced to the default', coerceReleaseNulls({ explicit: true }).explicit === true)
check('absent keys stay absent (no accidental full-row write)',
  !('language' in coerceReleaseNulls({ title: 'x' })))
check('input is not mutated', (() => {
  const input = { language: null }
  coerceReleaseNulls(input)
  return input.language === null
})())

// Guard the map against drift: every NOT NULL column in migration 026 must be
// covered, or a cleared field 500s again.
check('every NOT NULL column from migration 026 is covered',
  ['release_type', 'explicit', 'instrumental', 'language'].every(c => c in RELEASE_COLUMN_DEFAULTS),
  Object.keys(RELEASE_COLUMN_DEFAULTS).join(', '))

// Witness: the pre-fix route copied body[key] straight through.
const preCoerce = (patch) => ({ ...patch })
check('witness: pre-fix passthrough wrote a null at a NOT NULL column',
  preCoerce({ language: null }).language === null)

// ── 3. Waterfall sequencing + ISRC reuse ─────────────────────────────────────
console.log('\nwaterfall drops carry earlier tracks forward under their original ISRC')

const G = 'group-1'
const run = [
  rel({ id: 'a', title: 'First', waterfall_group_id: G, waterfall_position: 1, isrc: 'ISRC-A' }),
  rel({ id: 'b', title: 'Second', waterfall_group_id: G, waterfall_position: 2, isrc: 'ISRC-B' }),
  rel({ id: 'c', title: 'Third', waterfall_group_id: G, waterfall_position: 3, isrc: 'ISRC-C' }),
]

const drop3 = distroKidTracklist(run[2], run)
check('drop 3 carries 3 tracks', drop3.length === 3, `got ${drop3.length}`)
check('the new track is first', drop3[0].title === 'Third' && drop3[0].isNew === true)
check('earlier drops follow, newest first', drop3[1].title === 'Second' && drop3[2].title === 'First')
check('carried-forward tracks are flagged as re-releases',
  drop3[1].isNew === false && drop3[2].isNew === false)
check('carried-forward tracks reuse their ORIGINAL ISRC (streams carry over)',
  drop3[1].isrc === 'ISRC-B' && drop3[2].isrc === 'ISRC-A',
  `${drop3[1].isrc}, ${drop3[2].isrc}`)
check('track numbers are 1..n in order',
  drop3.every((t, i) => t.trackNumber === i + 1))

const drop1 = distroKidTracklist(run[0], run)
check('drop 1 is a single track', drop1.length === 1 && drop1[0].isNew === true)

// A release outside any run is a standalone single.
const solo = rel({ id: 'z', title: 'Solo' })
check('a release with no group is its own tracklist', distroKidTracklist(solo, [solo]).length === 1)
check('waterfallSiblings falls back to just the release', waterfallSiblings(solo, [solo]).length === 1)

// DistroKid's own thresholds: ≤3 single, ≤6 EP, else album.
check('release type follows track count',
  releaseTypeForTrackCount(1) === 'single' && releaseTypeForTrackCount(3) === 'single'
  && releaseTypeForTrackCount(5) === 'ep' && releaseTypeForTrackCount(9) === 'album',
  `1→${releaseTypeForTrackCount(1)} 3→${releaseTypeForTrackCount(3)} 5→${releaseTypeForTrackCount(5)} 9→${releaseTypeForTrackCount(9)}`)

// Drop dates: every generated date must land on a Friday and move forward.
const dates = waterfallDates('2026-08-02', 3, 14)
check('waterfall generates one date per drop', dates.length === 3, dates.join(', '))
check('every drop date is a Friday',
  dates.every(d => new Date(ymdUtc(d)).getUTCDay() === 5), dates.join(', '))
check('drop dates strictly increase',
  dates.every((d, i) => i === 0 || ymdUtc(d) > ymdUtc(dates[i - 1])), dates.join(', '))

// ── 4. Readiness judgment ────────────────────────────────────────────────────
console.log('\nrelease readiness reflects the checklist and the date')

const today = '2026-08-02'
check('a past date with an incomplete checklist is at risk',
  getReleaseStatus(rel({ release_date: '2026-07-01' }), today)?.key === 'at-risk')
check('an undated release flags nothing', getReleaseStatus(rel(), today) === null)
check('completion is 0% on a fresh release', releaseCompletionPercent(rel()) === 0)

// Derive the ticked row from the exported item lists rather than hard-coding
// six keys — the launch-campaign half reuses the dsp_* columns as generic
// checkboxes, so the real checklist is 13 items and a hard-coded set silently
// drifts the moment an item is added.
const ALL_ITEMS = [...PRE_LAUNCH_ITEMS, ...LAUNCH_CAMPAIGN_ITEMS]
const allTicked = rel(Object.fromEntries(ALL_ITEMS.map(i => [i.key, true])))
check('completion is 100% when every checklist item is ticked',
  releaseCompletionPercent(allTicked) === 100,
  `${ALL_ITEMS.length} items → ${releaseCompletionPercent(allTicked)}%`)
check('ticking half the list lands between 0 and 100',
  (() => {
    const half = rel(Object.fromEntries(ALL_ITEMS.slice(0, 6).map(i => [i.key, true])))
    const pct = releaseCompletionPercent(half)
    return pct > 0 && pct < 100
  })())

// The exported Markdown plan and the on-screen date must agree. formatDate()
// inside buildReleasePlan was always string-parsed (timezone-safe), so before
// the fix the exported plan said "Aug 7, 2026" while the UI said "Aug 6" —
// the same release, two different dates depending on where you read it.
check('the exported plan and the UI now report the same day',
  buildReleasePlan(rel({ release_date: FRIDAY, title: 'Track' }), null).includes(formatReleaseDate(FRIDAY)),
  formatReleaseDate(FRIDAY))

// Validation surfaces real blockers rather than silently passing.
const issues = validateForDistroKid(rel({ release_date: '2026-08-07' }),
  { hasFinalVersion: false, hasArtwork: false, tracklist: [], todayStr: today })
check('validation flags a missing master and artwork',
  issues.some(i => i.level === 'error'), `${issues.length} issue(s)`)

// ── 5. No nested component definitions in PipelineClient ─────────────────────
// ReleaseCard/MetaInput used to be declared INSIDE PipelineClient. Every parent
// render then produced a new component TYPE, so React unmounted and remounted
// the whole card subtree — destroying the DOM inputs holding the user's
// in-flight typing: type in one field, Tab to the next, and the first field's
// PATCH resolving silently WIPED the characters just typed and stole focus.
// The fix hoisted both to module scope; this guard keeps them there. It scans
// only the default-export function's body so module-scope declarations pass.
console.log('\nno component is declared inside PipelineClient (remount = typing loss)')
{
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(join(root, 'src/app/pipeline/PipelineClient.tsx'), 'utf8')

  const bodyStart = src.indexOf('export default function PipelineClient')
  check('PipelineClient default export found', bodyStart !== -1)
  const body = src.slice(bodyStart)
  // A nested component = a capitalized function declaration at one indent level
  // inside the parent. Helpers (camelCase) are fine; components are not.
  const nested = [...body.matchAll(/^ {2}(?:async )?function ([A-Z]\w*)/gm)].map(m => m[1])
  check('no capitalized (component) function is declared inside the parent',
    nested.length === 0, nested.length ? `found: ${nested.join(', ')}` : 'clean')
  check('ReleaseCard is declared at module scope', /^function ReleaseCard\(/m.test(src))
  check('MetaInput is declared at module scope', /^function MetaInput\(/m.test(src))
  // The controlled draft must never be silently reverted mid-edit.
  check('MetaInput guards external adoption on the editing flag',
    /if \(!editing\) setDraft\(value\)/.test(src))

  // Witness: the pre-fix shape — a component function declared inside the parent.
  const preFix = `
export default function PipelineClient({ initialReleases }: Props) {
  function MetaInput({ release, field }: { release: Release; field: string }) {
    return <input defaultValue={value} />
  }
  function ReleaseCard({ release }: { release: ReleaseWithProject }) {
    return <div><MetaInput /></div>
  }
  return <div>{upcoming.map(r => <ReleaseCard key={r.id} release={r} />)}</div>
}`
  const preNested = [...preFix.slice(preFix.indexOf('export default')).matchAll(/^ {2}(?:async )?function ([A-Z]\w*)/gm)].map(m => m[1])
  check('witness: the pre-fix nested declarations would be caught',
    preNested.length === 2, preNested.join(', '))
}


// ── 2026-08-03: the pipeline board bucketed a release by MIXED calendars ─────
// `new Date('2026-08-03')` is UTC midnight; `now.setHours(0,0,0,0)` is LOCAL
// midnight. At any negative UTC offset the release instant is always smaller,
// so a release dated TODAY sorted as PAST and vanished into the collapsed,
// dimmed "Past" group — on drop day — while its own badge still read "Today".
console.log('\nUpcoming/past bucketing (single calendar basis)')
{
  check('a release dated today is UPCOMING',
    isUpcomingRelease('2026-08-03', '2026-08-03') === true)
  check('yesterday is PAST',
    isUpcomingRelease('2026-08-03', '2026-08-02') === false)
  check('tomorrow is UPCOMING',
    isUpcomingRelease('2026-08-03', '2026-08-04') === true)
  check('an undated release stays UPCOMING (a plan, not history)',
    isUpcomingRelease('2026-08-03', null) === true)
  check('a malformed date stays visible rather than hiding in Past',
    isUpcomingRelease('2026-08-03', 'not-a-date') === true)

  // Witness: reproduce the exact pre-fix expression and show it disagrees.
  // Pinned to a negative-offset zone so the assertion is deterministic in CI
  // regardless of the runner's TZ.
  const preFixIsUpcoming = (todayLocalMs, dateStr) =>
    new Date(dateStr).getTime() >= todayLocalMs
  const localMidnightNewYork = Date.UTC(2026, 7, 3, 4, 0, 0) // 2026-08-03 00:00 EDT
  check('witness: the pre-fix comparison filed TODAY as past in New York',
    preFixIsUpcoming(localMidnightNewYork, '2026-08-03') === false)
  check('witness: the fixed predicate disagrees with it',
    isUpcomingRelease('2026-08-03', '2026-08-03') === true)

  // Sorting must stay chronological and keep undated releases at the end.
  const dates = ['2026-09-01', null, '2026-08-10']
  const upcomingOrder = [...dates].sort((a, b) => compareReleaseDates(a, b))
  check('upcoming sorts nearest-first with undated last',
    JSON.stringify(upcomingOrder) === JSON.stringify(['2026-08-10', '2026-09-01', null]),
    JSON.stringify(upcomingOrder))
  const pastOrder = ['2026-01-01', '2026-07-01'].sort((a, b) => compareReleaseDates(b, a, { undatedLast: false }))
  check('past sorts newest-first',
    JSON.stringify(pastOrder) === JSON.stringify(['2026-07-01', '2026-01-01']),
    JSON.stringify(pastOrder))
}

// ── 2026-08-03: the countdown badge read a day short after ~7pm local ────────
console.log('\nCountdown is calendar-based, not clock-based')
{
  check('same day = 0', daysUntilDate('2026-08-03', '2026-08-03') === 0)
  check('next day = 1', daysUntilDate('2026-08-03', '2026-08-04') === 1)
  check('a past date is negative', daysUntilDate('2026-08-03', '2026-08-01') === -2)
  check('blank date = null', daysUntilDate('2026-08-03', null) === null)

  // Witness: the pre-fix math differenced a UTC-parsed date against a wall-clock
  // instant. The error appears once UTC has rolled past midnight while the
  // user's LOCAL date is still the previous day — i.e. from 20:00 EDT onward.
  // At 22:00 EDT on 08-03 (= 02:00 UTC on 08-04), a drop on 08-05 is 2 calendar
  // days away but the old expression reported 1.
  const preFixDaysUntil = (nowMs, dateStr) =>
    Math.ceil((new Date(dateStr).getTime() - nowMs) / 86_400_000)
  const lateEvening = Date.UTC(2026, 7, 4, 2, 0, 0) // 22:00 EDT on 2026-08-03
  check('witness: pre-fix said "1 day" for a drop 2 calendar days out',
    preFixDaysUntil(lateEvening, '2026-08-05') === 1,
    `pre-fix=${preFixDaysUntil(lateEvening, '2026-08-05')}`)
  check('the fixed helper says 2',
    daysUntilDate('2026-08-03', '2026-08-05') === 2)
}

// ── 2026-08-03: a non-multiple-of-7 cadence yields irregular gaps ────────────
// Reachable via POST /api/releases/waterfall (the web UI only offers multiples
// of 7). Each offset is snapped FORWARD to Friday independently, so the snap
// distance varies with i mod 7.
console.log('\nWaterfall cadence honesty')
{
  const gapsFor = (cadence) => {
    const ds = waterfallDates('2026-08-03', 6, cadence)
    return ds.slice(1).map((d, i) => (ymdUtc(d) - ymdUtc(ds[i])) / 86_400_000)
  }
  const clean = gapsFor(28)
  check('a multiple-of-7 cadence gives even gaps',
    new Set(clean).size === 1, clean.join(','))
  const ragged = gapsFor(10)
  check('witness: cadence 10 produces UNEVEN gaps (documented, UI-unreachable)',
    new Set(ragged).size > 1, ragged.join(','))
}

if (failures > 0) {
  console.error(`\nrelease-pipeline: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nrelease-pipeline: all checks passed')
