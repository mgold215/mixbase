#!/usr/bin/env node
// Smart mix status test — exercises the REAL production module
// (src/lib/mix-status.ts via Node type stripping) plus a source-contract pass
// over the routes and surfaces that must speak the new status set. No DB, no
// network. Run: node scripts/mix-status-test.mjs   (also in `npm test`)
//
// The convention under test: the artist uploads "MIX #" while a song is a
// work in progress and "MASTER #" once they're mastering. The filename is the
// source of truth — the server stamps status and label from it, and the
// retired 'WIP' / 'Mix/Master' statuses must be unable to re-enter the
// catalog through any write path.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  MIX_STATUSES,
  parseVersionName,
  normalizeStatus,
  statusForUpload,
  versionKind,
  versionDisplayLabel,
  nextKindLabel,
} from '../src/lib/mix-status.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

console.log('mix-status: filenames drive status + labels; WIP is retired\n')

// ── 1. The status set itself ─────────────────────────────────────────────────
check('the status set is Mix / Master / Finished / Released',
  JSON.stringify(MIX_STATUSES) === '["Mix","Master","Finished","Released"]')

// ── 2. Filename parsing — the artist's convention ────────────────────────────
const parses = [
  // [filename, kind, number, label]
  ['MIX 3.wav', 'Mix', '3', 'MIX 3'],
  ['mix 3.wav', 'Mix', '3', 'MIX 3'],
  ['Song MIX 12.aiff', 'Mix', '12', 'MIX 12'],
  ['MIX 3.1.wav', 'Mix', '3.1', 'MIX 3.1'],
  ['MIX3.wav', 'Mix', '3', 'MIX 3'],
  ['mix_4.flac', 'Mix', '4', 'MIX 4'],
  ['mix #5.wav', 'Mix', '5', 'MIX 5'],
  ['MASTER 2.wav', 'Master', '2', 'MASTER 2'],
  ['master2.mp3', 'Master', '2', 'MASTER 2'],
  ['Song Title MASTER 1.wav', 'Master', '1', 'MASTER 1'],
  ['Master_3.aiff', 'Master', '3', 'MASTER 3'],
  // Bare tokens: kind is known, the number is not — label stays null so the
  // upload route synthesizes the next one in sequence.
  ['master.wav', 'Master', null, null],
  ['Final Mix.wav', 'Mix', null, null],
  // Master outranks mix when a name carries both.
  ['mix master 2.wav', 'Master', '2', 'MASTER 2'],
]
for (const [name, kind, number, label] of parses) {
  const p = parseVersionName(name)
  check(`"${name}" → ${kind} ${number ?? '(bare)'}`,
    p !== null && p.kind === kind && p.number === number && p.label === label,
    p ? `got ${p.kind}/${p.number}/${p.label}` : 'got null')
}

// Words that merely contain the tokens must NOT match — "remix 2" is not
// "MIX 2", and a remaster/mixdown is not a claim about workflow stage.
for (const name of ['remix 2.wav', 'mixdown.wav', 'remaster.wav', 'mastering notes.txt', 'grandmaster.wav', 'song.wav']) {
  check(`"${name}" does not parse as a mix/master name`, parseVersionName(name) === null)
}
check('null filename parses to null', parseVersionName(null) === null)
check('empty filename parses to null', parseVersionName('') === null)

// The extension must be stripped BEFORE matching, or "final.mix" style
// extensions would invent a kind. (A file literally named "mix.wav" is a bare
// Mix token — that one is intended.)
check('"song.mix" (mix only in the extension) does not parse', parseVersionName('song.mix') === null)

// ── 3. Upload status detection ───────────────────────────────────────────────
check('"MIX 3.wav" uploads as Mix', statusForUpload('MIX 3.wav') === 'Mix')
check('"MASTER 2.wav" uploads as Master', statusForUpload('MASTER 2.wav') === 'Master')
check('an unnamed bounce uploads as Mix (the workflow floor)', statusForUpload('bounce-final-v7.wav') === 'Mix')
check('a missing filename uploads as Mix', statusForUpload(null) === 'Mix')

// ── 4. Legacy statuses fold onto the current set ─────────────────────────────
check("'WIP' normalizes to Mix", normalizeStatus('WIP') === 'Mix')
check("'Mix/Master' normalizes to Master", normalizeStatus('Mix/Master') === 'Master')
for (const s of MIX_STATUSES) check(`'${s}' normalizes to itself`, normalizeStatus(s) === s)
check('an unknown status normalizes to Mix', normalizeStatus('APPROVED') === 'Mix')
check('null normalizes to Mix', normalizeStatus(null) === 'Mix')

// ── 5. Version kind — what side of the history a row belongs to ──────────────
check('a row labeled "MASTER 2" is a Master even once Released',
  versionKind({ label: 'MASTER 2', audio_filename: null, status: 'Released' }) === 'Master')
check('an unnamed Finished row reads as master-stage work',
  versionKind({ label: null, audio_filename: 'bounce.wav', status: 'Finished' }) === 'Master')
check('an unnamed Mix row is a Mix',
  versionKind({ label: null, audio_filename: 'bounce.wav', status: 'Mix' }) === 'Mix')
check('the filename decides when there is no label',
  versionKind({ label: null, audio_filename: 'MASTER 1.wav', status: 'Mix' }) === 'Master')
check("a legacy 'WIP' row is a Mix", versionKind({ label: null, audio_filename: null, status: 'WIP' }) === 'Mix')

// ── 6. Display labels ────────────────────────────────────────────────────────
check('stored label wins', versionDisplayLabel({ label: 'Radio Edit', audio_filename: 'MIX 9.wav', status: 'Mix', version_number: 4 }) === 'Radio Edit')
check('filename label is second', versionDisplayLabel({ label: null, audio_filename: 'MASTER 2.wav', status: 'Master', version_number: 4 }) === 'MASTER 2')
check('fallback names the kind, not just "Mix"',
  versionDisplayLabel({ label: null, audio_filename: 'bounce.wav', status: 'Master', version_number: 4 }) === 'Master 4')
check('fallback for a plain mix', versionDisplayLabel({ label: null, audio_filename: 'bounce.wav', status: 'Mix', version_number: 4 }) === 'Mix 4')

// ── 7. Sequence synthesis for bare tokens ────────────────────────────────────
const history = [
  { label: 'MIX 3', audio_filename: 'MIX 3.wav' },
  { label: null, audio_filename: 'MIX 4.wav' },
  { label: 'MASTER 1', audio_filename: 'master.wav' },
]
check('"master.wav" after MASTER 1 becomes MASTER 2', nextKindLabel('Master', history) === 'MASTER 2')
check('"mix.wav" after MIX 4 becomes MIX 5', nextKindLabel('Mix', history) === 'MIX 5')
check('first master in a project is MASTER 1', nextKindLabel('Master', [{ label: 'MIX 8', audio_filename: null }]) === 'MASTER 1')
check('empty history starts at 1', nextKindLabel('Mix', []) === 'MIX 1')
check('point numbers count by their integer part', nextKindLabel('Mix', [{ label: 'MIX 3.1', audio_filename: null }]) === 'MIX 4')

// ── 8. Source contracts — the writers actually use this module ───────────────
const createRoute = read('src/app/api/versions/route.ts')
check('POST /api/versions imports the parser',
  /from ['"]@\/lib\/mix-status['"]/.test(createRoute))
check('POST /api/versions stamps the detected status',
  /status:\s*resolvedStatus/.test(createRoute))
check('POST /api/versions stamps the resolved label',
  /label:\s*resolvedLabel/.test(createRoute))
// The old shape was `status: status ?? 'WIP'` — any ??-style constant default
// on the insert would bypass detection, whatever the constant.
check("POST /api/versions no longer defaults status to a constant",
  !/status:\s*status\s*\?\?/.test(createRoute))

const patchRoute = read('src/app/api/versions/[id]/route.ts')
check('PATCH /api/versions/[id] normalizes incoming statuses',
  /patch\.status\s*=\s*normalizeStatus\(/.test(patchRoute))

// iOS used to insert into PostgREST directly, so this suite required it to
// re-implement the filename convention client-side (MixStatus.forUpload). That
// requirement is GONE as of the switch to POST /api/versions: iOS now sends
// audio_filename and the SERVER parses it, so there is exactly one parser
// instead of two that have to be kept in step.
//
// Assert the property we actually care about — no phone upload can mint a
// status the server did not choose — rather than the old mechanism, which was
// only ever a means to it. Pinning the mechanism is what made this check go RED
// on a change that strictly improved the thing it was protecting.
const iosService = read('ios/mixBase/Services/SupabaseService.swift')
const iosApi = read('ios/mixBase/Services/MixbaseAPI.swift')
check('iOS creates versions through POST /api/versions, not a direct insert',
  /path:\s*"\/api\/versions"/.test(iosApi))
check('iOS no longer inserts into mb_versions directly',
  !/\/rest\/v1\/mb_versions[^?]/.test(iosService.replace(/\/rest\/v1\/mb_versions\?/g, '')),
  'a direct insert would put status, label, version_number and allow_download back in the client')
check('iOS sends no status of its own — the server parses the filename',
  !/"status":/.test(iosApi))
check('iOS no longer references the retired "WIP" status',
  !iosService.includes('"WIP"') && !iosApi.includes('"WIP"'))

// The bootstrap schema and the migration must agree on the new default.
const dbInit = read('src/app/api/db-init/route.ts')
check("db-init's mb_versions default is 'Mix'", /status text not null default 'Mix'/.test(dbInit))
const migration = read('supabase/migrations/034_mix_master_status.sql')
check("migration 034 sets the column default to 'Mix'",
  /alter column status set default 'Mix'/.test(migration))
check('migration 034 retires both legacy statuses',
  /where status in \('WIP', 'Mix\/Master'\)/.test(migration))

// The one place the UI offers statuses must offer exactly the module's set.
const supabaseLib = read('src/lib/supabase.ts')
check('STATUSES is the mix-status set', /export const STATUSES = MIX_STATUSES/.test(supabaseLib))

if (failures > 0) {
  console.error(`\nmix-status: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nmix-status: all checks passed')
