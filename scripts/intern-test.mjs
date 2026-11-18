#!/usr/bin/env node
// The mixing intern (owner-only): the Mac app reports what it can read of
// Logic Pro. Source checks only: no database, no network, no Mac.
//
// Run: node scripts/intern-test.mjs  (part of `npm test`)
import { readFileSync } from 'node:fs'

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

console.log('intern: the Mac app\'s report\n')
const route = read('src/app/api/intern/diagnostics/route.ts')
const proxy = read('src/proxy.ts')
const auth = read('ios/mixBase/Services/AuthService.swift')
const api = read('ios/mixBase/Services/MixbaseAPI.swift')
const mac = read('macos/MixbaseApp/InternDiagnostics.swift')

check('the route takes the caller from the middleware header and 404s anyone but the owner',
  /request\.headers\.get\('X-User-Id'\)/.test(route) && /if \(!\(await isAdminIdentity\(userId\)\)\) return NextResponse\.json\(\{ error: 'Not found' \}, \{ status: 404 \}\)/.test(route))
check('…before it reads the body', route.indexOf('isAdminIdentity(userId)') < route.indexOf('request.json()'))
check('the route is rate limited and caps what it stores', /checkUserLimit\(mixCheckLimiter, userId\)/.test(route) && /\.slice\(0, MAX_REPORT\)/.test(route))
check('nothing under /api/intern is public', !/['"]\/api\/intern/.test(proxy))
check('only the Mac build starts it, and only for the owner',
  /#if os\(macOS\)[\s\S]{0,260}if self\.ownerTools \{ InternDiagnostics\.start\(\) \}[\s\S]{0,40}#endif/.test(auth))
check('the app sends it to that route', api.includes('"/api/intern/diagnostics"'))
// Read-only: it may read attributes and ask whether one CAN be set, nothing else.
check('the Mac code reads Logic and never acts on it',
  !/AXUIElementSetAttributeValue|AXUIElementPerformAction|CGEvent|NSAppleScript|Process\(\)/.test(mac))
check('it asks for the Accessibility permission once, not on every launch', /internAskedForAccessibility/.test(mac) && /UserDefaults\.standard\.set\(true/.test(mac))

console.log('\nintern: jobs\n')
{
  const { notesForJob, sanitizeReport, jobView, INTERN_STALL_MS } = await import('../src/lib/intern-jobs.ts')
  const findings = [
    { code: 'changed.sub', severity: 'low', note_id: 'n1' },
    { code: 'genre.balance', severity: 'low', note_id: 'n2' },
    { code: 'changed.loudness', severity: 'low', note_id: 'n3' },
  ]
  const feedback = [
    { id: 'n1', reviewer_name: 'Mix Check', comment: 'Sub rose 3.4 dB', timestamp_seconds: 157, resolved_at: null },
    { id: 'n2', reviewer_name: 'Mix Check', comment: 'Against references…', timestamp_seconds: 157, resolved_at: null },
    { id: 'n3', reviewer_name: 'Mix Check', comment: '4.2 LU quieter', timestamp_seconds: null, resolved_at: '2026-11-18T00:00:00Z' },
    { id: 'n4', reviewer_name: 'Mix Check', comment: 'from an older report', timestamp_seconds: 10, resolved_at: null },
    { id: 'n5', reviewer_name: 'Dana', comment: '  vocal buried here ', timestamp_seconds: 72, resolved_at: null },
    { id: 'n6', reviewer_name: 'Dana', comment: '   ', timestamp_seconds: 5, resolved_at: null },
  ]
  const notes = notesForJob(feedback, findings)
  check('a job is handed the open notes, measured ones with their finding code', notes.length === 2 && notes[0].id === 'n1' && notes[0].kind === 'mix-check' && notes[0].code === 'changed.sub' && notes[0].at === 157)
  check('a listener\'s note is handed over as written', notes[1].id === 'n5' && notes[1].kind === 'listener' && notes[1].code === null && notes[1].text === 'vocal buried here')
  check('never the genre-reference note, a ticked-off note, an empty note, or a note from an older report', !notes.some(n => ['n2', 'n3', 'n4', 'n6'].includes(n.id)))

  const ok = sanitizeReport({ stage: ' Bouncing ', status: 'done', result_version_id: '011AFD55-5934-477E-81E5-4CD82BBBE789', changes: [{ track: 'Bass', what: 'Low shelf at 60 Hz', from: '0.0 dB', to: '-3.0 dB', extra: 1 }, { track: '', what: 'x' }, 'junk'], user_id: 'someone-else' })
  check('a report keeps its stage, result and well-formed changes', ok.stage === 'Bouncing' && ok.status === 'done' && ok.result_version_id === '011afd55-5934-477e-81e5-4cd82bbbe789' && ok.changes.length === 1 && ok.changes[0].to === '-3.0 dB' && !('extra' in ok.changes[0]))
  check('…and nothing else it was sent', !('user_id' in ok))
  check('the Mac app cannot re-queue, re-open or cancel a job by report', ['queued', 'working', 'cancelled'].every(s => sanitizeReport({ status: s }) === null))
  check('junk is no report', [null, 5, 'x', [], {}, { stage: '   ' }, { result_version_id: 'not-a-uuid' }].every(v => sanitizeReport(v) === null))

  const now = Date.parse('2026-11-18T12:00:00Z')
  const at = ms => new Date(now - ms).toISOString()
  check('a working job that stopped reporting reads as stalled', jobView({ status: 'working', heartbeat_at: at(INTERN_STALL_MS + 1000) }, now).stalled === true)
  check('…one still reporting does not, and neither does a waiting or finished one',
    jobView({ status: 'working', heartbeat_at: at(5000) }, now).stalled === false && jobView({ status: 'queued', updated_at: at(INTERN_STALL_MS * 3) }, now).stalled === false && jobView({ status: 'done', heartbeat_at: at(INTERN_STALL_MS * 3) }, now).stalled === false)

  const routes = ['src/app/api/versions/[id]/intern/route.ts', 'src/app/api/intern/jobs/claim/route.ts', 'src/app/api/intern/jobs/[id]/route.ts'].map(read)
  check('every job route 404s anyone but the owner and is rate limited', routes.every(r => /isAdminIdentity\(userId\)/.test(r) && /status: 404/.test(r) && /checkUserLimit\(internLimiter, userId\)/.test(r)))
  check('every job query is scoped to the caller', routes.every(r => (r.match(/from\('mb_intern_jobs'\)/g) ?? []).length === (r.match(/\.eq\('user_id', (g\.)?userId\)|insert\(\{ user_id: g\.userId/g) ?? []).length), routes.map(r => `${(r.match(/from\('mb_intern_jobs'\)/g) ?? []).length}/${(r.match(/\.eq\('user_id', (g\.)?userId\)|insert\(\{ user_id: g\.userId/g) ?? []).length}`).join(' '))
  check('a claim only takes a job that is still waiting (or still stalled)', /\.eq\('status', candidate\.status\)/.test(routes[1]) && /claim = claim\.lt\('heartbeat_at', stalledBefore\)/.test(routes[1]))
  check('a report only lands on a job that is still working', /\.eq\('status', 'working'\)/.test(routes[2]) && /ownsVersion\(report\.result_version_id, userId\)/.test(routes[2]))
  const migration = read('supabase/migrations/046_intern_jobs.sql')
  check('one job in flight per mix, and the table is locked down', /unique index if not exists mb_intern_jobs_one_active[\s\S]{0,120}where status in \('queued', 'working'\)/.test(migration) && /enable row level security/.test(migration) && !/for (insert|update|delete|all)/.test(migration))
}

if (failures) { console.error(`\nintern: ${failures} check(s) FAILED`); process.exit(1) }
console.log('\nintern: all checks passed')
