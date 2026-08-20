#!/usr/bin/env node
// Contract + behaviour test: /api/tracks carries duration_seconds, and the
// engine turns that into a heal for EVERY project.
//
// The self-healing backfill (see duration-backfill-test.mjs for the write path)
// only ever fired on the project page, because that was the only surface
// holding a stored duration next to a mix. /api/tracks — which feeds the mini
// player and /player — did not return the column at all, so those surfaces
// could not tell a healed row from an unhealed one and healed nothing. Adding
// it there reaches the latest mix of every project the user has.
//
// That makes this suite about three things, in the order they can break:
//
//   1. THE COLUMN REALLY TRAVELS. Section B drives the REAL exported GET with
//      an in-memory store that HONOURS THE SELECT LIST, the way PostgREST does.
//      Dropping `duration_seconds` from the select therefore changes the
//      payload rather than being invisible to a stub that returns whole rows —
//      which is the only way a test here can fail for the right reason.
//   2. THE HEAL TARGETS THE RIGHT ROW. `Track.id` must be the mb_versions row
//      id, since that is what PATCH /api/versions/[id] addresses; the project
//      id would 404 every single write. Checked on real data, not by reading.
//   3. THE ENGINE ACTS ON IT ONCE, AND ONLY WHERE IT CAN. Section C is a source
//      contract over PlayerContext — no Node test can render it — covering the
//      NULL-only filter, the single writer, and the fact that no public
//      (unauthenticated) surface registers anything, because a PATCH from one
//      could only 401 in a loop.
//
// Comments are stripped before any text is matched: a rule that survives only
// in a comment must not keep a check green.
//
// Run: node scripts/tracks-duration-heal-test.mjs
// Requires Node >= 22.15 for module.registerHooks and >= 22.18 for native
// TypeScript type-stripping, same as the neighbouring suites.

import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

import { stripComments, bracketedBlock } from './source-contract.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const USER_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const USER_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const PROJ_HEALED = 'aaaa1111-0000-4000-8000-00000000000a' // user A, latest mix measured
const PROJ_NULL = 'aaaa2222-0000-4000-8000-00000000000b'   // user A, never measured
const PROJ_B = 'bbbb3333-0000-4000-8000-00000000000c'      // user B
const V_HEALED = '11111111-1111-4111-8111-111111111111'    // PROJ_HEALED v2, 268s
const V_HEALED_OLD = '11111111-1111-4111-8111-111111111112' // PROJ_HEALED v1, 100s
const V_NULL = '22222222-2222-4222-8222-222222222222'      // PROJ_NULL v3, NULL
const V_B = '33333333-3333-4333-8333-333333333333'         // PROJ_B v1, NULL

function freshDb() {
  return {
    mb_projects: [
      { id: PROJ_HEALED, user_id: USER_A, title: 'Healed', artwork_url: null, finalized_artwork_url: null, visualizer_url: null, key_signature: null, bpm: null, share_token: 'tok-healed' },
      { id: PROJ_NULL, user_id: USER_A, title: 'Unmeasured', artwork_url: null, finalized_artwork_url: null, visualizer_url: null, key_signature: null, bpm: null, share_token: 'tok-null' },
      { id: PROJ_B, user_id: USER_B, title: 'Not yours', artwork_url: null, finalized_artwork_url: null, visualizer_url: null, key_signature: null, bpm: null, share_token: 'tok-b' },
    ],
    mb_versions: [
      { id: V_HEALED, project_id: PROJ_HEALED, label: '', version_number: 2, audio_url: 'https://x.supabase.co/storage/v1/object/public/mf-audio/a/2.mp3', duration_seconds: 268, status: 'WIP', created_at: '2026-08-01T00:00:00Z' },
      { id: V_HEALED_OLD, project_id: PROJ_HEALED, label: '', version_number: 1, audio_url: 'https://x.supabase.co/storage/v1/object/public/mf-audio/a/1.mp3', duration_seconds: 100, status: 'WIP', created_at: '2026-07-01T00:00:00Z' },
      { id: V_NULL, project_id: PROJ_NULL, label: '', version_number: 3, audio_url: 'https://x.supabase.co/storage/v1/object/public/mf-audio/b/3.mp3', duration_seconds: null, status: 'WIP', created_at: '2026-08-02T00:00:00Z' },
      { id: V_B, project_id: PROJ_B, label: '', version_number: 1, audio_url: 'https://x.supabase.co/storage/v1/object/public/mf-audio/c/1.mp3', duration_seconds: null, status: 'WIP', created_at: '2026-08-03T00:00:00Z' },
    ],
    profiles: [{ id: USER_A, artist_name: 'Test Artist' }, { id: USER_B, artist_name: 'Other' }],
  }
}
globalThis.__MB_DB = freshDb()

// ── Fake Supabase ────────────────────────────────────────────────────────────
// Deliberately PROJECTS to the selected columns rather than handing back whole
// rows. A stub that ignores the select list cannot tell the difference between
// a route that asks for duration_seconds and one that doesn't, which would make
// every assertion below pass on a reverted route.
const SUPABASE_STUB = `
const db = () => globalThis.__MB_DB

/** Split a PostgREST column list on its TOP-LEVEL commas, so the embedded
 *  resource 'mb_projects!inner(a, b)' stays in one piece. */
function splitTop(list) {
  const out = []
  let depth = 0
  let cur = ''
  for (const c of list) {
    if (c === '(') depth++
    else if (c === ')') depth--
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue }
    cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** Narrow a row to the requested columns, resolving an embedded parent the way
 *  PostgREST resolves mb_versions -> mb_projects. */
function project(row, cols) {
  if (!cols || cols === '*') return { ...row }
  const out = {}
  for (const tok of splitTop(cols)) {
    const paren = tok.indexOf('(')
    if (paren === -1) {
      if (tok in row) out[tok] = row[tok]
      continue
    }
    const name = tok.slice(0, paren).split('!')[0].trim()
    const inner = tok.slice(paren + 1, tok.lastIndexOf(')'))
    const parent = (db().mb_projects ?? []).find(p => p.id === row.project_id)
    out[name] = parent ? project(parent, inner) : null
  }
  return out
}

function matches(table, filters) {
  let rows = db()[table] ?? []
  for (const [op, col, val] of filters) {
    if (op === 'eq' && col === 'mb_projects.user_id') {
      rows = rows.filter(r => {
        const parent = (db().mb_projects ?? []).find(p => p.id === r.project_id)
        return parent?.user_id === val
      })
    } else if (op === 'eq') {
      rows = rows.filter(r => r[col] === val)
    } else if (op === 'is' && val === null) {
      rows = rows.filter(r => r[col] === null || r[col] === undefined)
    } else {
      throw new Error('fake supabase: unsupported filter ' + op + ' ' + col)
    }
  }
  return rows
}

function query(table) {
  const filters = []
  let op = 'select'
  let cols = '*'
  let payload = null
  let sort = null
  const run = (arity) => {
    let rows = matches(table, filters)
    if (op === 'update') { for (const r of rows) Object.assign(r, payload); }
    if (sort) {
      rows = rows.slice().sort((a, b) => sort.asc
        ? (a[sort.col] > b[sort.col] ? 1 : a[sort.col] < b[sort.col] ? -1 : 0)
        : (a[sort.col] < b[sort.col] ? 1 : a[sort.col] > b[sort.col] ? -1 : 0))
    }
    const copies = rows.map(r => project(r, cols))
    if (arity === 'single') {
      return copies.length === 1
        ? Promise.resolve({ data: copies[0], error: null })
        : Promise.resolve({ data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } })
    }
    return Promise.resolve({ data: copies, error: null })
  }
  const q = {
    select(c) { if (c) cols = c; return q },
    update(p) { op = 'update'; payload = p; return q },
    eq(col, val) { filters.push(['eq', col, val]); return q },
    is(col, val) { filters.push(['is', col, val]); return q },
    limit() { return q },
    order(col, opts) { sort = { col, asc: opts?.ascending !== false }; return q },
    single() { return run('single') },
    maybeSingle() { return run('maybeSingle') },
    then(res, rej) { return run('many').then(res, rej) },
  }
  return q
}

export const supabaseAdmin = { from: (table) => query(table) }
export const SUPABASE_URL = 'https://x.supabase.co'
export const supabase = supabaseAdmin
`

// The visualizer self-heal reaches for Sentry and the Supabase Management API.
// Neither is under test here and the healthy path never calls them — stub the
// module so importing the route stays a pure, offline operation.
const SCHEMA_HEAL_STUB = `
export function isMissingVisualizerColumn() { return false }
export async function ensureProjectVisualizerColumn() { return true }
`

const SUPABASE_STUB_URL = 'mbstub:supabase'
const SCHEMA_STUB_URL = 'mbstub:schema-heal'
registerHooks({
  resolve(spec, ctx, next) {
    // next/server has no bare-subpath export map entry Node can resolve.
    if (spec === 'next/server') return next('next/server.js', ctx)
    if (spec === '@/lib/supabase') return { url: SUPABASE_STUB_URL, shortCircuit: true, format: 'module' }
    if (spec === '@/lib/schema-heal') return { url: SCHEMA_STUB_URL, shortCircuit: true, format: 'module' }
    if (spec.startsWith('@/')) {
      return { url: pathToFileURL(join(root, 'src', spec.slice(2) + '.ts')).href, shortCircuit: true, format: 'module-typescript' }
    }
    return next(spec, ctx)
  },
  load(url, ctx, next) {
    if (url === SUPABASE_STUB_URL) return { format: 'module', shortCircuit: true, source: SUPABASE_STUB }
    if (url === SCHEMA_STUB_URL) return { format: 'module', shortCircuit: true, source: SCHEMA_HEAL_STUB }
    return next(url, ctx)
  },
})

const TRACKS_PATH = 'src/app/api/tracks/route.ts'
const { GET } = await import(pathToFileURL(join(root, TRACKS_PATH)).href)
const { NextRequest } = await import('next/server.js')

/** Drive the real handler the way the middleware does: identity in X-User-Id. */
async function getTracks(userId) {
  const headers = {}
  if (userId) headers['X-User-Id'] = userId
  const req = new NextRequest('http://localhost/api/tracks', { method: 'GET', headers })
  const res = await GET(req)
  return { status: res.status, body: await res.json() }
}

// ── A. Anchors ───────────────────────────────────────────────────────────────
// Nothing below means anything unless the real handler is running and the fake
// store is answering it, so prove both before trusting a single assertion.
console.log('\nanchors\n')

check('the real route module exported a GET handler', typeof GET === 'function')

let tracks = []
{
  const res = await getTracks(USER_A)
  tracks = Array.isArray(res.body) ? res.body : []
  check('a signed-in request returns the caller\'s tracks',
    res.status === 200 && tracks.length === 2, `status ${res.status}, ${tracks.length} tracks`)
  check('one track per project — only the latest mix of each',
    new Set(tracks.map(t => t.project_id)).size === tracks.length &&
    !tracks.some(t => t.id === V_HEALED_OLD),
    tracks.map(t => t.version).join(', '))
  check('another user\'s project is not in the payload',
    !tracks.some(t => t.project_id === PROJ_B))
}
{
  const res = await getTracks(null)
  check('an unauthenticated request is refused (public surfaces get no rows to heal)',
    res.status === 401, `status ${res.status}`)
}

// ── B. duration_seconds actually travels ─────────────────────────────────────
// The gap this change closes. Each check is written so that removing the column
// from the select, or dropping the field from the mapped Track, fails it.
console.log('\nthe payload carries the stored duration\n')

const healed = tracks.find(t => t.project_id === PROJ_HEALED)
const unhealed = tracks.find(t => t.project_id === PROJ_NULL)

check('both fixture projects came back', !!healed && !!unhealed)
check('every track has a duration_seconds field',
  tracks.length > 0 && tracks.every(t => Object.prototype.hasOwnProperty.call(t, 'duration_seconds')),
  JSON.stringify(tracks.map(t => Object.keys(t).includes('duration_seconds'))))
check('a measured row reports its stored length as a number',
  healed?.duration_seconds === 268, `got ${JSON.stringify(healed?.duration_seconds)}`)
check('the length reported is the LATEST mix\'s, not an older sibling\'s',
  healed?.duration_seconds !== 100, `got ${JSON.stringify(healed?.duration_seconds)}`)
check('an unmeasured row reports exactly null — the signal the engine heals on',
  unhealed?.duration_seconds === null, `got ${JSON.stringify(unhealed?.duration_seconds)}`)
check('"unmeasured" is never confused with a real zero',
  unhealed?.duration_seconds !== 0)

// The id the engine will PATCH. mb_versions row id, never the project id — the
// project id would 404 every write and the heal would silently never land.
check('Track.id is the mb_versions row id, which is what PATCH addresses',
  healed?.id === V_HEALED && unhealed?.id === V_NULL,
  `${healed?.id} / ${unhealed?.id}`)
check('Track.id is not the project id',
  healed?.id !== healed?.project_id && unhealed?.id !== unhealed?.project_id)

// ── C. The engine turns a null into a registration ───────────────────────────
// Source contract: no Node test can render PlayerContext, and this half is
// where a wrong rule would cost real requests.
console.log('\nclient: PlayerContext\n')

const PLAYER_PATH = 'src/contexts/PlayerContext.tsx'
const playerSrc = stripComments(read(PLAYER_PATH))

/** The whole useEffect containing `needle` — sliced syntactically, not with a
 *  character window, so edits inside it cannot move it out of range. */
function effectContaining(src, needle) {
  const at = src.indexOf(needle)
  if (at === -1) return ''
  const start = src.lastIndexOf('useEffect(() =>', at)
  if (start === -1) return ''
  return bracketedBlock(src.slice(start), 'useEffect(() =>')
}

const registerEffect = effectContaining(playerSrc, 'registerUnmeasuredVersions(unmeasured)')
check('the registration effect was located',
  registerEffect.includes('registerUnmeasuredVersions') && registerEffect.includes('tracks'),
  `${registerEffect.length} chars`)
check('it reads the engine\'s own /api/tracks list — i.e. every project, not one',
  /const unmeasured = tracks\b/.test(registerEffect))
check('only rows with no stored duration are registered',
  /duration_seconds\s*==\s*null/.test(registerEffect))
// `=== null` would miss a column absent from an older deploy's payload, which
// is exactly the "we don't know" case worth healing.
check('the null test is loose (== null), so a missing column counts as unmeasured',
  !/duration_seconds\s*===\s*null/.test(registerEffect))
check('the id registered is the version row id',
  /versionId:\s*t\.id\b/.test(registerEffect) && !/versionId:\s*t\.project_id/.test(registerEffect))
check('the url registered is the audio PROXY url (a raw Supabase url reports no duration)',
  /audioProxyUrl\(t\.audio_url\)/.test(registerEffect))
check('an already-healed catalog registers nothing at all',
  /unmeasured\.length\s*>\s*0/.test(registerEffect))
check('the effect re-runs when the track list changes',
  /\[tracks,\s*registerUnmeasuredVersions\]/.test(registerEffect + playerSrc))

// One mechanism, not two. The whole point of routing this through the existing
// registerUnmeasuredVersions is that the once-per-session rule, the finiteness
// guard and the fire-and-forget request all stay in ONE place — a second
// fetch() to the versions API would be a parallel heal with none of them.
{
  const writers = playerSrc.match(/fetch\(`\/api\/versions\//g) ?? []
  check('there is still exactly ONE writer to /api/versions in the engine',
    writers.length === 1, `${writers.length} call site(s)`)
}
check('registration is not wired into playUrl (the unauthenticated feed/share path)',
  !/registerUnmeasuredVersions/.test(bracketedBlock(playerSrc, 'const playUrl = useCallback(')))
// The dead Web Audio chain: routing the singleton <audio> through
// createMediaElementSource is irreversible for the session. Nothing added here
// may wake it.
check('the backfill work never touches the Web Audio chain',
  !/ensureAudioChain|createMediaElementSource/.test(registerEffect))

// ── D. Public surfaces write duration ONLY through the token-scoped route ────
// This section used to assert the opposite: that ShareClient and AlbumPlayer
// contained no `duration_seconds` at all. That was right on 2026-08-19 and is
// wrong on 2026-08-20, so it is worth stating plainly why it changed rather
// than quietly relaxing it.
//
// The old rule existed for ONE reason, recorded in its own comment: every write
// these components could send "could only 401, forever", because the only write
// path was the owner-scoped PATCH /api/versions/[id] and these pages have no
// session. The rule was never "public surfaces must not heal" — it was "public
// surfaces must not spam a doomed request".
//
// POST /api/share/<token>/duration removes that premise: it authorises the
// write from the share token the visitor already holds, so these requests now
// succeed. 145 of 364 rows are NULL and the project-level share link only ever
// resolves the LATEST mix, so without this the 110 older versions could never
// be healed by anyone but the artist.
//
// What must still hold — and what these checks now pin — is the part that was
// actually load-bearing:
//   1. Neither component may reach the AUTHENTICATED route. A PATCH to
//      /api/versions/[id] from here is the doomed request the old rule banned,
//      and it is still doomed.
//   2. Neither may register into the /api/tracks heal (section A proved that
//      path 401s for an anonymous visitor, so it would register nothing and
//      retry forever).
//   3. A non-finite reading must never leave the client. `duration` is NaN
//      before metadata parses and Infinity for a stream of unknown length; the
//      write is write-once, so a persisted lie could never be corrected. The
//      server refuses both independently — this is the client-side half of that
//      defence, and it must not be removed on the grounds that the server
//      checks too.
console.log('\npublic surfaces\n')

for (const path of ['src/app/share/[token]/ShareClient.tsx', 'src/components/AlbumPlayer.tsx']) {
  const file = path.split('/').pop()
  const src = stripComments(read(path))
  check(`${file} registers nothing to heal`,
    !src.includes('registerUnmeasuredVersions'))
  // The ban is on the OWNER-scoped route specifically, not on the concept of a
  // duration write — matching '/api/versions' rather than 'duration_seconds'.
  check(`${file} never writes duration through the authenticated route`,
    !/\/api\/versions/.test(src))
  // If it heals at all, it must do so through the token-scoped route and must
  // gate the reading first. Guarded on the file actually sending one, so this
  // section keeps meaning something if a future player stops healing entirely.
  if (/duration_seconds/.test(src)) {
    check(`${file} heals only via POST /api/share/<token>/duration`,
      /\/api\/share\/\$\{encodeURIComponent\([A-Za-z]+\)\}\/duration/.test(src))
    // Bind the guard to the SAME identifier that is actually sent, rather than
    // just looking for `Number.isFinite(` anywhere in the file. Both components
    // use Number.isFinite several times for unrelated display formatting, so
    // the loose form passed even with the real guard deleted — a vacuous check
    // is worse than no check, because it reads as coverage.
    const sent = /duration_seconds:\s*Math\.round\(([A-Za-z_$][\w$]*)\)/.exec(src)
    check(`${file} — located the identifier it sends`, !!sent)
    if (sent) {
      const ident = sent[1]
      check(`${file} refuses a non-finite ${ident} before sending`,
        new RegExp(`!\\s*Number\\.isFinite\\(\\s*${ident}\\s*\\)`).test(src))
    }
  }
}

// ── E. The constraints this change had to honour ─────────────────────────────
// Widening the heal to a second surface is exactly the moment someone
// "simplifies" the write path by folding duration_seconds into the PATCH
// allowlist. That would drop the atomic write-once filter and let a duration
// ride along with — and silently swallow — a label edit.
console.log('\nthe write path is unchanged\n')

const versionsSrc = stripComments(read('src/app/api/versions/[id]/route.ts'))
{
  const allowedLine = versionsSrc.split('\n').find(l => l.includes('const allowed = [')) ?? ''
  check('the allowlist line was located', allowedLine.includes('status'), allowedLine.trim())
  check('duration_seconds is still NOT in the passthrough allowlist',
    !allowedLine.includes('duration_seconds'))
}
check('the backfill update still carries its own .is(duration_seconds, null) filter',
  /\.is\('duration_seconds',\s*null\)/.test(versionsSrc))
check('validation is still typeof-then-Number.isFinite, with no coercion',
  /typeof raw !== 'number'/.test(versionsSrc) &&
  /!Number\.isFinite\(raw\)/.test(versionsSrc) &&
  !/[^.\w]isFinite\(raw\)/.test(versionsSrc))

// ── F. The Track contract ────────────────────────────────────────────────────
// The type is what every consumer compiles against; a field present at runtime
// but absent from the type would not reach a single caller.
console.log('\nthe Track type\n')

const tracksSrc = stripComments(read(TRACKS_PATH))
const trackType = bracketedBlock(tracksSrc, 'export type Track =')
check('the Track type was located', trackType.includes('audio_url'), `${trackType.length} chars`)
check('Track declares duration_seconds as number | null',
  /duration_seconds:\s*number \| null/.test(trackType))

console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}\n`)
process.exit(failures === 0 ? 0 : 1)
