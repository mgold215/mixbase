// Mix Session — the open notes on each song's current mix, ticked off as you
// work, plus the AI session assistant (web /session + the app's Mix Session).
//
// Run: node scripts/mix-session-test.mjs
//
// A. THE LOGIC (src/lib/mix-session.ts, imported for real via type stripping):
//    which mix is "current", which notes make the list and in what order, the
//    shareable text, and the assistant's input + answer validation. This is the
//    one definition both clients render, so it is tested here and nowhere else.
// B. THE ROUTES: every read is scoped to the caller's own projects, a tick can
//    only touch a note on the caller's own mix and only writes resolved_at, a
//    failed read is never shown as an empty list, the migration-041 heal is
//    wired, and no error says "plan" (the app replaces purchase-shaped words —
//    "plan" among them — with generic copy, which would garble these).
// C. BOTH CLIENTS call the same three routes (the app has no copy of the logic).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments, bracketedBlock } from './source-contract.mjs'
import {
  buildMixSession, currentVersionByProject, mixSessionText, buildPlanInput, resolvePlan,
  clock, PLAN_OUTPUT_SCHEMA, PLAN_AREAS, PLAN_MAX_NOTES,
} from '../src/lib/mix-session.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(repoRoot, p), 'utf8')
const source = (p) => stripComments(read(p))

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const OWN = 'My notes'
const P1 = '11111111-1111-4111-8111-111111111111'
const P2 = '22222222-2222-4222-8222-222222222222'
const P3 = '33333333-3333-4333-8333-333333333333'
const version = (id, project_id, version_number, created_at, extra = {}) => ({
  id, project_id, version_number, label: null, audio_url: `https://x.supabase.co/storage/v1/object/public/mf-audio/${id}.wav`,
  audio_filename: null, duration_seconds: 200, status: 'Mix', allow_download: false, share_token: null, created_at, ...extra,
})
const note = (id, version_id, extra = {}) => ({
  id, version_id, reviewer_name: 'Alex', rating: null, comment: `note ${id}`, timestamp_seconds: null,
  created_at: '2026-10-01T00:00:00Z', resolved_at: null, ...extra,
})

const projects = [
  { id: P1, title: 'First', artwork_url: 'a1', finalized_artwork_url: 'f1', visualizer_url: null },
  { id: P2, title: 'Second', artwork_url: null, visualizer_url: 'v2' },
  { id: P3, title: 'Third (no notes)', artwork_url: null },
]
const versions = [
  version('v1a', P1, 1, '2026-09-01T00:00:00Z'),
  version('v1b', P1, 2, '2026-10-01T00:00:00Z', { audio_filename: 'MASTER 2.wav' }),
  version('v2a', P2, 3, '2026-10-05T00:00:00Z'),
  version('v2b', P2, 3, '2026-10-06T00:00:00Z'), // same number, newer upload wins
  version('v3a', P3, 1, '2026-10-07T00:00:00Z'),
]
const notes = [
  note('old', 'v1a', { comment: 'on the old mix' }),
  note('n-late', 'v1b', { timestamp_seconds: 120 }),
  note('n-early', 'v1b', { timestamp_seconds: 30.9, reviewer_name: OWN }),
  note('n-whole-new', 'v1b', { created_at: '2026-10-03T00:00:00Z' }),
  note('n-whole-old', 'v1b', { created_at: '2026-10-02T00:00:00Z', rating: 4 }),
  note('n-blank', 'v1b', { comment: '   ' }),
  note('n-done', 'v2b', { resolved_at: '2026-10-08T00:00:00Z' }),
  note('n-superseded', 'v2a', { comment: 'tie-loser mix' }),
]

console.log('A. logic')
{
  const cur = currentVersionByProject(versions)
  check('current mix = highest version_number', cur.get(P1).id === 'v1b')
  check('tie on version_number → newest upload', cur.get(P2).id === 'v2b')

  const s = buildMixSession(projects, versions, notes, OWN)
  const first = s.songs.find(x => x.project_id === P1)
  const second = s.songs.find(x => x.project_id === P2)
  check('songs with no notes on their current mix are left out', !s.songs.some(x => x.project_id === P3))
  check('notes on older mixes are left out', !first.notes.some(n => n.id === 'old') && !second.notes.some(n => n.id === 'n-superseded'))
  check('blank notes are left out', !first.notes.some(n => n.id === 'n-blank'))
  check('pinned notes first in track order, then whole-mix notes oldest first',
    JSON.stringify(first.notes.map(n => n.id)) === JSON.stringify(['n-early', 'n-late', 'n-whole-old', 'n-whole-new']),
    first.notes.map(n => n.id).join(','))
  check('timestamps floored to whole seconds', first.notes[0].at_seconds === 30)
  check('own notes flagged by the fixed author label', first.notes[0].own === true && first.notes[1].own === false)
  check('done = resolved_at set', second.notes[0].done === true && second.notes[0].done_at === '2026-10-08T00:00:00Z')
  check('counts per song and overall', first.open_count === 4 && first.done_count === 0 && second.open_count === 0 &&
    second.done_count === 1 && s.open_count === 4 && s.done_count === 1)
  check('songs with open notes come first', s.songs[0].project_id === P1)
  check('mix name uses the shared display label ("MASTER 2" from the filename)', first.version.display_label === 'MASTER 2',
    first.version.display_label)
  check('song carries the full version row (the app decodes its Version from it)',
    ['id', 'project_id', 'version_number', 'audio_url', 'status', 'allow_download', 'created_at'].every(k => k in first.version))
  check('artwork prefers the finalized cover', first.artwork_url === 'f1')

  const text = mixSessionText(s)
  check('text lists open notes only', text.includes('note n-late') && !text.includes('n-done'))
  check('text shows m:ss or "whole mix"', text.includes('0:30') && text.includes('2:00') && text.includes('whole mix'))
  check('text names listeners, not you', text.includes('(Alex)') && !text.includes(`(${OWN})`))
  check('text with nothing open says so', mixSessionText(buildMixSession(projects, versions, [notes[6]], OWN)).includes('no open notes'))
  check('clock()', clock(0) === '0:00' && clock(61) === '1:01' && clock(600) === '10:00')
}

console.log('A2. session assistant input + answer')
{
  const s = buildMixSession(projects, versions, notes, OWN)
  const input = buildPlanInput(s.songs, new Map([[P1, { genre: 'House', bpm: 124, key_signature: 'Am' }]]))
  check('only open notes go to the model', input.noteCount === 4 && !input.text.includes('n-done'))
  // (fixture comments read "note <id>", so check the line prefix, not the text)
  check('notes get short refs, never raw ids',
    input.text.split('\n').filter(l => /^N\d/.test(l)).length === 4 && !input.text.includes(P1) && !input.text.includes('v1b'))
  check('song context included', input.text.includes('House, 124 BPM, key Am') && input.text.includes('MASTER 2'))
  check('pinned moments marked [@ m:ss]', input.text.includes('[@ 0:30]'))
  check('own notes read as the producer', /N1 \[@ 0:30\] Producer:/.test(input.text), input.text.split('\n')[1])

  const plan = resolvePlan({
    overview: ' Start with First. ',
    songs: [
      { song: 'S1', focus: 'Low end', conflicts: ['More reverb vs less', 7, ''], steps: [
        { action: 'Tighten the kick', area: 'low-end', priority: 'high', notes: ['N2', 'N1', 'N1', 'N99'] },
        { action: 'Bogus area', area: 'sparkle', priority: 'urgent', notes: ['N3'] },
        { action: '', area: 'vocals', priority: 'low', notes: ['N4'] },
      ] },
      { song: 'S9', focus: 'unknown song', steps: [], conflicts: [] },
      { song: 'S1', focus: 'duplicate song', steps: [], conflicts: [] },
    ],
  }, input.refs)
  const ps = plan.songs[0]
  check('overview trimmed', plan.overview === 'Start with First.')
  check('unknown and duplicate songs dropped', plan.songs.length === 1 && ps.project_id === P1)
  check('refs mapped to note ids, deduped, unknown refs dropped',
    JSON.stringify(ps.steps[0].note_ids) === JSON.stringify(['n-late', 'n-early']), ps.steps[0].note_ids.join(','))
  check('step starts at the earliest pinned moment', ps.steps[0].at_seconds === 30)
  check('labels sent with each step', ps.steps[0].area_label === 'Low end' && ps.steps[0].priority_label === 'High')
  check('bad area/priority fall back to other/medium', ps.steps[1].area === 'other' && ps.steps[1].priority === 'medium')
  check('steps with no action are dropped', !ps.steps.some(st => st.action === ''))
  const last = ps.steps[ps.steps.length - 1]
  check('notes the model skipped are never lost', last.note_ids.includes('n-whole-new') && last.action.startsWith('Remaining notes'))
  check('every open note appears exactly once',
    JSON.stringify(ps.steps.flatMap(st => st.note_ids).sort()) === JSON.stringify(['n-early', 'n-late', 'n-whole-new', 'n-whole-old']))
  check('conflicts keep only non-empty strings', JSON.stringify(ps.conflicts) === JSON.stringify(['More reverb vs less']))

  const empty = resolvePlan(null, input.refs)
  check('garbage answer still returns every note', empty.songs.length === 1 && empty.songs[0].steps[0].note_ids.length === 4)

  // Notes from another song can't be claimed.
  const two = buildPlanInput([
    { ...s.songs[0] },
    { ...s.songs[0], project_id: P2, title: 'Other', notes: [{ ...s.songs[0].notes[0], id: 'x1', done: false }] },
  ])
  const cross = resolvePlan({ overview: '', songs: [{ song: 'S1', focus: '', conflicts: [], steps: [
    { action: 'steal', area: 'other', priority: 'low', notes: ['N5'] },
  ] }] }, two.refs)
  check("a step can't claim another song's note", !cross.songs[0].steps[0].note_ids.includes('x1'))

  const objects = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'object') objects.push(node)
    for (const v of Object.values(node)) walk(v)
  }
  walk(PLAN_OUTPUT_SCHEMA)
  check('schema: every object closes additionalProperties and requires all its properties',
    objects.length === 3 && objects.every(o => o.additionalProperties === false &&
      JSON.stringify([...o.required].sort()) === JSON.stringify(Object.keys(o.properties).sort())))
  check('schema areas == PLAN_AREAS', JSON.stringify(PLAN_OUTPUT_SCHEMA.properties.songs.items.properties.steps.items.properties.area.enum) ===
    JSON.stringify(PLAN_AREAS.map(a => a.value)))
  check('note cap is set', PLAN_MAX_NOTES > 0 && PLAN_MAX_NOTES <= 500)
}

console.log('B. routes')
const scrubbed = /upgrade|plan|tier|subscri|purchase|billing|pricing|credit|buy /i
const errorStrings = (src) => [...src.matchAll(/error: (['`])(.*?)\1/g)].map(m => m[2])
{
  const server = source('src/lib/mix-session-server.ts')
  check('projects scoped to the caller', /from\('mb_projects'\)[\s\S]*?\.eq\('user_id', userId\)/.test(server))
  check('versions read only for those projects', /selectIn<SessionVersionRow>\('mb_versions', VERSION_COLS, 'project_id', projects\.map/.test(server))
  check('notes read only for current mixes', /loadNotes\(currentIds\)/.test(server))
  const selectIn = bracketedBlock(server, 'async function selectIn')
  check('a failed read throws (never an empty list)', /if \(error\) throw/.test(selectIn))
  check('missing resolved_at heals, then degrades to "everything open"',
    server.includes('isMissingFeedbackResolvedColumn(cause)') && server.includes('await ensureFeedbackResolvedColumn()') &&
    server.includes('doneSupported: false'))

  const get = source('src/app/api/mix-session/route.ts')
  check('GET requires a user', get.includes("'X-User-Id'") && get.includes('401'))
  check('GET returns the session, done_supported and the shared text',
    get.includes('loadMixSession(userId)') && get.includes('done_supported') && get.includes('mixSessionText(session)'))

  const patch = source('src/app/api/mix-session/notes/[id]/route.ts')
  check('PATCH validates id and body shape', patch.includes('canonicalUuid(') && patch.includes('isJsonObject(body)') &&
    patch.includes("typeof body.done !== 'boolean'"))
  check('PATCH is rate limited', patch.includes('checkUserLimit(mixSessionLimiter, userId)'))
  const own = patch.indexOf(".eq('mb_versions.mb_projects.user_id', userId)")
  const upd = patch.indexOf(".update({ resolved_at: doneAt })")
  check('PATCH checks the note is on your own mix BEFORE writing', own !== -1 && upd !== -1 && own < upd)
  check('PATCH writes only resolved_at', (patch.match(/\.update\(/g) ?? []).length === 1)
  check('PATCH heals a missing column and retries', /isMissingFeedbackResolvedColumn\(error\) && await ensureFeedbackResolvedColumn\(\)/.test(patch))

  const plan = source('src/app/api/mix-session/plan/route.ts')
  check('assistant requires a user, a key and the hourly AI budget',
    plan.includes("'X-User-Id'") && plan.includes('ANTHROPIC_API_KEY') && plan.includes('checkUserLimit(chatLimiter, userId)'))
  check('assistant uses structured output with the shared schema',
    /format: \{ type: 'json_schema', schema: PLAN_OUTPUT_SCHEMA/.test(plan) && plan.includes('resolvePlan(raw, input.refs)'))
  check('assistant handles refusal and max_tokens', plan.includes("stop_reason === 'refusal'") && plan.includes("stop_reason === 'max_tokens'"))
  check('assistant enforces the note cap', plan.includes('input.noteCount > PLAN_MAX_NOTES'))

  for (const [file, src] of [['route', get], ['notes/[id]', patch], ['plan', plan]]) {
    const bad = errorStrings(src).filter(e => scrubbed.test(e))
    check(`${file}: no error message the app would scrub`, bad.length === 0, bad.join(' | '))
  }

  const proxy = read('src/proxy.ts')
  const publicBlock = proxy.slice(proxy.indexOf('const PUBLIC_PATHS'), proxy.indexOf(']', proxy.indexOf('const PUBLIC_PATHS')))
  check('/api/mix-session is not public', !/'\/api\/mix|'\/api\/m'|'\/api\/'[,\s]/.test(publicBlock))
}

console.log('C. both clients')
{
  const web = source('src/app/session/SessionClient.tsx')
  check('web reads GET /api/mix-session', web.includes("fetch('/api/mix-session')"))
  check('web ticks via PATCH /api/mix-session/notes/:id', web.includes('`/api/mix-session/notes/${id}`') && web.includes("method: 'PATCH'"))
  check('web organizes via POST /api/mix-session/plan', web.includes("fetch('/api/mix-session/plan'"))
  check('web nav links /session', source('src/components/Nav.tsx').includes("href: '/session'"))

  const api = source('ios/mixBase/Services/MixbaseAPI.swift')
  check('app reads GET /api/mix-session', /func mixSession\(\)[\s\S]*?"\/api\/mix-session", method: "GET"/.test(api))
  check('app ticks via PATCH', /func setNoteDone[\s\S]*?"\/api\/mix-session\/notes\/\\\(noteId\.uuidString\.lowercased\(\)\)"[\s\S]*?method: "PATCH"/.test(api))
  check('app organizes via POST', /func organizeSession[\s\S]*?"\/api\/mix-session\/plan", method: "POST"/.test(api))
  check('app decodes the current mix as its own Version', /version = try c\.decode\(Version\.self, forKey: \.version\)/.test(api))
  check('app takes the mix name from the server', api.includes('case displayLabel = "display_label"'))

  const view = source('ios/mixBase/Views/Session/MixSessionView.swift')
  check('app screen uses the three calls', view.includes('MixbaseAPI.shared.mixSession()') &&
    view.includes('MixbaseAPI.shared.setNoteDone(') && view.includes('MixbaseAPI.shared.organizeSession('))
  check('app screen keeps no copy of the area list', !PLAN_AREAS.some(a => view.includes(`"${a.label}"`)))
  check('app shares the server text, not its own', view.includes('ShareText(text: fresh.text)'))
  const pbx = read('ios/mixBase.xcodeproj/project.pbxproj')
  check('MixSessionView.swift is compiled into the app',
    /\/\* MixSessionView\.swift in Sources \*\/ = \{isa = PBXBuildFile/.test(pbx) && /\/\* MixSessionView\.swift in Sources \*\/,/.test(pbx))
  check('Home links to the Mix Session', source('ios/mixBase/Views/Home/HomeView.swift').includes('MixSessionView('))
}

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nmix session contract holds')
