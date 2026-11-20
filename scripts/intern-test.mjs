#!/usr/bin/env node
// The mixing intern (owner-only): its jobs, its routes and the two clients'
// hand-off control. Source checks only: no database, no network, no Mac.
//
// Run: node scripts/intern-test.mjs  (part of `npm test`)
import { readFileSync } from 'node:fs'

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

console.log('intern: the routes\n')
const proxy = read('src/proxy.ts')
const api = read('ios/mixBase/Services/MixbaseAPI.swift')
const card = read('ios/mixBase/Views/Projects/MixCheckCard.swift')
const panel = read('src/components/InternPanel.tsx')
const handoff = read('src/app/api/versions/[id]/intern/route.ts')

check('nothing under /api/intern is public', !/['"]\/api\/intern/.test(proxy))
check('every hand-off handler 404s anyone but the owner, before anything else is read',
  /if \(!\(await isAdminIdentity\(userId\)\)\) return \{ error: NextResponse\.json\(\{ error: 'Not found' \}, \{ status: 404 \}\) \}/.test(handoff)
  && (handoff.match(/const g = await gate\(request, ctx\)/g) ?? []).length === 3)
check('the diagnostics probe is gone (the helper replaced it)',
  !api.includes('/api/intern/diagnostics') && !/InternDiagnostics/.test(read('ios/mixBase/Services/AuthService.swift')))
check('the app hands over, reads and stops through the same route as the web',
  /func handToIntern/.test(api) && /func stopIntern/.test(api) && api.includes('/api/versions/\\(versionId.postgresString)/intern')
  && (panel.match(/\/api\/versions\/\$\{versionId\}\/intern/g) ?? []).length === 2)
check('both clients say "waiting for your Mac" when no helper has taken the job',
  /Waiting for your Mac/.test(panel) && /Waiting for your Mac/.test(card))
check('both clients have Stop, the stage and the change list',
  /Stop/.test(panel) && /job\.stage/.test(panel) && /job\.changes\.map/.test(panel) && /Button\("Stop", action: onStop\)/.test(card) && /job\.stage/.test(card) && /ForEach\(changes\)/.test(card))
const webCard = read('src/components/MixCheck.tsx')
check('both clients lay the card out in the same tabs: Notes, Balance, Intern, Compare',
  ["'notes'", "'balance'", "'intern'", "'compare'"].every(k => webCard.includes(k)) && /role="tablist"/.test(webCard)
  && /case notes, balance, intern, compare/.test(card) && /\.pickerStyle\(\.segmented\)/.test(card))
check('the Intern and Compare tabs only appear when there is something in them',
  /\.\.\.\(internJob \? \[\{ key: 'intern'/.test(webCard) && /\.\.\.\(intern\.comparison \? \[\{ key: 'compare'/.test(webCard)
  && /if internJob != nil \{ out\.append\(\.intern\) \}/.test(card) && /if intern\?\.comparison != nil \{ out\.append\(\.compare\) \}/.test(card))
check('neither client works the comparison out: it is drawn from what the server sends',
  !/vsPrevious/.test(panel) && /let comparison: InternComparison\?/.test(api) && /internComparison\(/.test(handoff))
check('the genre note is never offered to the intern', !/genre\.balance/.test(panel) && /NEVER_HANDED = \(code: string\) => code === 'genre\.balance'/.test(read('src/lib/intern-jobs.ts')))

console.log('\nintern: the step log and the comparison\n')
{
  const { withSteps, internComparison, sanitizeReport, INTERN_MAX_STEPS } = await import('../src/lib/intern-jobs.ts')
  let steps = withSteps([], { stage: 'Bouncing' }, 't1')
  steps = withSteps(steps, { stage: 'Bouncing' }, 't2')           // a heartbeat repeats the stage
  steps = withSteps(steps, { step: 'Measured it' }, 't3')
  steps = withSteps(steps, { stage: 'Bouncing' }, 't4')           // …still the same stage, after a detail
  steps = withSteps(steps, { stage: 'Uploading', step: 'Filed' }, 't5')
  check('a stage is logged once however often it is reported, details every time',
    JSON.stringify(steps.map(s => [s.text, !!s.detail])) === JSON.stringify([['Bouncing', false], ['Measured it', true], ['Uploading', false], ['Filed', true]]), JSON.stringify(steps))
  check('junk already in the log is dropped, and the log is capped',
    withSteps([{ text: 5 }, null, 'x'], { step: 'ok' }, 't').length === 1
    && withSteps(Array.from({ length: 200 }, (_, i) => ({ at: 't', text: `s${i}`, detail: true })), { step: 'last' }, 't').length === INTERN_MAX_STEPS)
  check('a report may carry a step line, cut to length', sanitizeReport({ step: 'x'.repeat(900) })?.step?.length === 300 && sanitizeReport({ step: '  ' }) === null)
  check('the step log has its own column, healed if a deploy beats the migration',
    /add column if not exists steps jsonb/.test(read('supabase/migrations/048_intern_job_steps.sql')) && /ensureInternStepsColumn/.test(read('src/app/api/intern/jobs/[id]/route.ts')) && /ensureInternStepsColumn/.test(handoff))
  check('a failed write of the log never fails the report itself', /if \(report\.stage \|\| report\.step\) await appendSteps/.test(read('src/app/api/intern/jobs/[id]/route.ts')) && /console\.error\('\[intern\] steps not written/.test(read('src/app/api/intern/jobs/[id]/route.ts')))

  const band = (key, v) => ({ key, label: key, range: '', vsPrevious: v })
  const from = { label: 'MASTER 5', report: { summary: { i: -9.6, tp: -1.7 }, compared: { previous: 'MASTER 4' }, bands: [band('sub', -5.8), band('mid', 0.1)],
    findings: [{ code: 'changed.sub', severity: 'high', title: 'Sub dropped' }, { code: 'mono.low@95', severity: 'medium', title: 'Stereo 1:35' }, { code: 'mono.low@143', severity: 'medium', title: 'Stereo 2:23' }] } }
  const to = { label: 'MASTER 5 (intern)', report: { summary: { i: -9.5, tp: -1.8 }, compared: { previous: 'MASTER 4' }, bands: [band('sub', -1.9), band('mid', 0.1)],
    findings: [{ code: 'mono.low@96', severity: 'low', title: 'Stereo 1:36' }, { code: 'drop.quieter@46', severity: 'low', title: 'Quieter at 0:46' }] } }
  const c = internComparison(from, to)
  check('the comparison sets each band of the two mixes side by side, against the same earlier mix',
    c?.against === 'MASTER 4' && c.bands[0].from === -5.8 && c.bands[0].to === -1.9 && c.loudness.from === -9.6 && c.loudness.to === -9.5 && c.truePeak.to === -1.8)
  check('a note is cleared, still there (whatever second it moved to), or new',
    JSON.stringify(c.notes.map(n => [n.state, n.before, n.after])) === JSON.stringify([['cleared', 'Sub dropped', null], ['cleared', 'Stereo 2:23', null], ['still', 'Stereo 1:35', 'Stereo 1:36'], ['new', null, 'Quieter at 0:46']]), JSON.stringify(c.notes))
  const timed = (codes) => ({ label: 'x', report: { bands: [band('sub', 0)], findings: codes.map(code => ({ code, title: code })) } })
  check('a timed note is the same note only near the same moment, matched to the nearest',
    JSON.stringify(internComparison(timed(['mono.low@95', 'mono.low@143', 'drop.quieter@112']), timed(['mono.low@175', 'drop.quieter@46', 'mono.low@96'])).notes.map(n => [n.state, n.before, n.after]))
    === JSON.stringify([['cleared', 'drop.quieter@112', null], ['still', 'mono.low@95', 'mono.low@96'], ['still', 'mono.low@143', 'mono.low@175'], ['new', null, 'drop.quieter@46']]))
  const { internCanFix } = await import('../src/lib/intern-jobs.ts')
  check('the button is offered only for a note the intern has a rule for',
    internCanFix([{ code: 'mono.low@95' }, { code: 'changed.sub' }]) && !internCanFix([{ code: 'changed.loudness' }, { code: 'genre.balance' }, { code: 'balance.presence' }]) && !internCanFix(null)
    && /can_hand: internCanFix/.test(handoff) && /canHand: answer\?\.can_hand === true/.test(panel) && /hasNotes: intern\.canHand == true/.test(card))
  check('no comparison is made up when either mix has no full report', internComparison(from, { label: 'x', report: null }) === null && internComparison({ label: 'x', report: { bands: [] } }, to) === null)
  check('"against" is only named when both were measured against the same mix',
    internComparison(from, { ...to, report: { ...to.report, compared: { previous: 'MASTER 3' } } })?.against === null)
}

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

console.log('\nintern: what a bounce the intern uploaded is compared with\n')
{
  const { comparedBefore } = await import('../src/lib/intern-jobs.ts')
  const versions = [{ id: 'm1', version_number: 1 }, { id: 'm4', version_number: 4 }, { id: 'fix', version_number: 5 }, { id: 'fix2', version_number: 6 }, { id: 'm7', version_number: 7 }]
  const jobs = [{ version_id: 'fix', result_version_id: 'fix2' }, { version_id: 'm4', result_version_id: 'fix' }, { version_id: 'm4', result_version_id: null }]
  check('a mix the owner made is compared with the one before it', comparedBefore('m4', versions, jobs) === 4 && comparedBefore('m7', versions, jobs) === 7)
  check('the intern\'s bounce is compared as the mix it fixes was', comparedBefore('fix', versions, jobs) === 4)
  check('…and a fix of a fix goes back to the mix the owner made', comparedBefore('fix2', versions, jobs) === 4)
  check('a job never moves the comparison forwards, and cannot loop', comparedBefore('m4', versions, [{ version_id: 'm7', result_version_id: 'm4' }]) === 4 &&
    comparedBefore('fix', versions, [{ version_id: 'fix', result_version_id: 'fix' }]) === 5)
  check('a version that is not the song\'s has no comparison', comparedBefore('other', versions, jobs) === null)

  const server = read('src/lib/mix-check-server.ts')
  const claim = read('src/app/api/intern/jobs/claim/route.ts')
  check('Mix Check picks the earlier mix through that rule, within the song',
    /const older = await previousVersionOf\(row\)/.test(server) && /comparedBefore\(row\.id, all,/.test(server) &&
    /from\('mb_intern_jobs'\)\.select\('version_id, result_version_id'\)\.eq\('project_id', row\.project_id\)/.test(server) &&
    /v\.version_number < before && v\.audio_url && v\.audio_url !== row\.audio_url/.test(server))
  check('a claimed job carries that earlier mix as measured, so the Mac can judge a bounce before uploading it',
    /previousVersionOf\(\{ id: v\.id, project_id: v\.mb_projects\.id, audio_url: v\.audio_url \}\)/.test(claim) && /summary: earlier\.mix_check\.summary/.test(claim) && /\n        baseline,\n/.test(claim))
  check('…and only after the caller is known to be the owner', claim.indexOf('isAdminIdentity(userId)') < claim.indexOf('previousVersionOf('))
}

if (failures) { console.error(`\nintern: ${failures} check(s) FAILED`); process.exit(1) }
console.log('\nintern: all checks passed')
