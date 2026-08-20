// Storage-key canonicalisation contract — the whole uppercase-UUID class, not
// one door.
//
// Run: node scripts/uuid-storage-key-test.mjs
//
// WHY THIS EXISTS
// Three facts, each correct on its own, compose into an unreapable object:
//
//   1. isUuid() (src/lib/validators.ts) carries `/i`, so `ABCDEF01-…` is a
//      valid UUID as far as every route is concerned. That is DELIBERATE and
//      must stay — Swift's UUID.uuidString is uppercase and the shipped iOS app
//      calls these routes; a case-sensitive isUuid() turns every missed
//      `.lowercased()` in MixbaseAPI.swift into a hard 400.
//   2. Every ownership gate resolves against a Postgres `uuid` COLUMN, and
//      Postgres compares uuids by VALUE:
//      `'ABCDEF01-…'::uuid = 'abcdef01-…'::uuid` is true (re-verified against
//      production 2026-08-19). So the uppercase spelling passes ownsProject and
//      every `.eq('id', …)` exactly like the lowercase one.
//   3. Supabase Storage keys are plain text, stored VERBATIM. Postgres
//      normalises; the bucket does not.
//
// Compose them and an authenticated owner, posting their OWN project id in
// uppercase, mints `<UPPERCASE-UUID>/<file>` — a real, billed object that NO
// cleanup path can name. Every reaper, survivor scan and orphan census starts
// from a project id read back OUT of Postgres, which always renders lowercase,
// and then matches it as TEXT: listProjectPrefix walks `${projectId}/`,
// planReap's shape filter is VIZ_KEY_RE's lowercase `[0-9a-f-]{36}`,
// keyProjectId attributes a key by its first segment. None of them sees an
// uppercase prefix. Section C proves that blindness against the REAL functions
// rather than asserting it.
//
// The fix is canonicalUuid(): validate and lowercase in ONE step, applied where
// an id crosses from the case-insensitive world (Postgres) into the
// case-sensitive one (a storage key). isUuid stays untouched, so reads still
// accept either spelling.
//
// The subtle half is /api/upload-url and /api/tus, where the CLIENT supplies
// the whole key. Canonicalising the variable you validate is not enough there:
// upload-url signs a key, and tus FORWARDS the client's Upload-Metadata header
// verbatim — so both would authorise one key and write another. Sections E and
// F pin the rebuilt key to the thing that actually reaches Supabase.
//
// Routes reach for the `@/` alias and a live Supabase client, so they cannot be
// imported under plain Node type-stripping — those checks are contract
// assertions over the SOURCE, with comments stripped first so a guard that
// survives only in prose cannot pass.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

import { stripComments } from './source-contract.mjs'
import { isUuid, canonicalUuid } from '../src/lib/validators.ts'
import { VIZ_KEY_RE } from '../src/lib/visualizer-finalize.ts'
import { keyProjectId, listProjectPrefix } from '../src/lib/project-assets.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(repoRoot, p), 'utf8')
const source = (p) => stripComments(read(p))

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// One project, spelled both ways. `LOWER` is what Postgres hands back for it;
// `UPPER` is what Swift's UUID.uuidString produces for the same project.
const LOWER = '3f1a2b4c-5d6e-4f70-8123-9a0b1c2d3e4f'
const UPPER = LOWER.toUpperCase()
const MIXED = '3F1a2B4c-5d6E-4f70-8123-9a0B1c2D3e4F'

// ── A. canonicalUuid — the real function ────────────────────────────────────
console.log('\n— canonicalUuid —')

check('accepts a canonical id and returns it unchanged', canonicalUuid(LOWER) === LOWER)
// THE property. A "fix" that merely validated (`isUuid(v) ? v : null`) passes
// every other check in this file and closes nothing.
check('accepts an UPPERCASE id and returns it LOWERCASED', canonicalUuid(UPPER) === LOWER,
  String(canonicalUuid(UPPER)))
check('accepts a MIXED-case id and returns it LOWERCASED', canonicalUuid(MIXED) === LOWER,
  String(canonicalUuid(MIXED)))
check('is idempotent — its own output is a fixed point',
  canonicalUuid(canonicalUuid(UPPER)) === canonicalUuid(UPPER))
check('every accepted value has exactly one canonical form',
  new Set([LOWER, UPPER, MIXED].map(canonicalUuid)).size === 1)

// Rejection must be null, never a throw and never a wrong id — callers refuse
// with the 400 they already had.
for (const bad of [
  '', 'abc', '../../etc', `${LOWER}/x.wav`, `${LOWER} `, ` ${LOWER}`,
  '3f1a2b4c5d6e4f7081239a0b1c2d3e4f', 'zzzzzzzz-5d6e-4f70-8123-9a0b1c2d3e4f',
]) {
  check(`returns null for ${JSON.stringify(bad)}`, canonicalUuid(bad) === null)
}
for (const bad of [null, undefined, 42, {}, [], true]) {
  check(`returns null for non-string ${String(bad)}`, canonicalUuid(bad) === null)
}

// ── B. isUuid must NOT have been narrowed ───────────────────────────────────
// The obvious "fix" is to drop the `/i` from UUID_RE. That would close this
// class by breaking a shipped iOS app: MixbaseAPI.swift mitigates per call
// site with .lowercased(), so any site that was missed becomes a hard 400 on a
// build already in users' hands. The bound belongs at the key, not at the gate.
console.log('\n— isUuid stays case-insensitive (iOS back-compat) —')

check('isUuid still accepts a canonical id', isUuid(LOWER) === true)
check('isUuid STILL accepts an UPPERCASE id', isUuid(UPPER) === true)
check('isUuid STILL accepts a MIXED-case id', isUuid(MIXED) === true)
check('UUID_RE is still declared case-insensitive',
  /const UUID_RE = \/\^\[0-9a-f\]\{8\}[^\n]*\/i$/m.test(source('src/lib/validators.ts')))

// ── C. Why an uppercase key is unreapable — against the REAL reapers ────────
// Not asserted, demonstrated. Postgres hands the sweep LOWER; the object sits
// under UPPER; every recognizer in the cleanup path is text-matching.
console.log('\n— the reapers are blind to an uppercase prefix —')

const UPPER_KEY = `${UPPER}/1712345678.wav`
const LOWER_KEY = `${LOWER}/1712345678.wav`

// 1. keyProjectId — who a key attributes itself to. This one already
//    normalises (project-assets.ts), which is exactly why it must keep doing
//    so: it is the only recognizer that can see such a key at all.
check('keyProjectId attributes the uppercase key to the canonical project',
  keyProjectId(UPPER_KEY) === LOWER, String(keyProjectId(UPPER_KEY)))

// 2. VIZ_KEY_RE — planReap's shape filter. Anything it does not match is
//    counted keptForeignShape and NEVER deleted.
check('VIZ_KEY_RE matches a canonical viz key', VIZ_KEY_RE.test(`${LOWER}/viz-1712345678.mp4`))
check('VIZ_KEY_RE does NOT match an uppercase viz key — the sweep would skip it forever',
  VIZ_KEY_RE.test(`${UPPER}/viz-1712345678.mp4`) === false)

// 3. listProjectPrefix — the per-project enumeration used by DELETE
//    /api/projects/[id] and /api/auth/delete-account. Driven here by a fake
//    bucket holding BOTH keys, listed by the real prefix walk.
{
  const bucket = [UPPER_KEY, LOWER_KEY]
  // Emulate the Storage list API: entries directly under `prefix`, objects only
  // (no nested folders in this fixture, so every entry gets a non-null id).
  const listPage = async (prefix, offset, limit) => {
    const names = bucket
      .filter(k => k.startsWith(prefix))
      .map(k => k.slice(prefix.length))
      .filter(n => n.length > 0 && !n.includes('/'))
    return names.slice(offset, offset + limit).map(name => ({ name, id: 'obj' }))
  }

  // What a reaper actually does: it reads the project id out of Postgres, which
  // renders uuids lowercase, and walks that prefix.
  const found = await listProjectPrefix(listPage, LOWER)
  check('the prefix walk is anchored (it finds the canonical key)',
    Array.isArray(found) && found.includes(LOWER_KEY), JSON.stringify(found))
  check('…and CANNOT see the uppercase twin — this is the unreapable object',
    Array.isArray(found) && !found.includes(UPPER_KEY), JSON.stringify(found))

  // The reason it is permanent rather than merely missed: nothing else can name
  // it either. Every delete path starts from a row's URL, and a row written by
  // the same request carries the lowercase id Postgres stored.
  const rowDerivedKeyPrefix = `${LOWER}/`
  check('witness: a row-derived key prefix does not match the uppercase object',
    UPPER_KEY.startsWith(rowDerivedKeyPrefix) === false)
  check('witness: it DOES match once the key is canonicalised',
    canonicalUuid(UPPER) !== null && `${canonicalUuid(UPPER)}/1712345678.wav`.startsWith(rowDerivedKeyPrefix))
}

// ── D. Source contract: every request UUID that becomes a key is canonical ──
// One row per minting route: where the id enters, and the key expression it
// ends up in. Both halves are asserted, and they are bound to each other by
// the identifier name — gating on one variable while keying off another is the
// confused-deputy shape this table exists to make impossible.
console.log('\n— routes canonicalise the id BEFORE it becomes a storage key —')

const KEY_MINTS = [
  {
    file: 'src/app/api/upload-audio/route.ts',
    id: 'projectId',
    // `<projectId>/<ts>.<ext>` in mf-audio / mf-artwork.
    key: /const filename = `\$\{projectId\}\//,
  },
  {
    file: 'src/app/api/finalize-artwork/route.ts',
    id: 'project_id',
    // `<project_id>/finalized-<ts>.jpg` in mf-artwork.
    key: /const filename = `\$\{project_id\}\/finalized-/,
  },
  {
    file: 'src/app/api/generate-artwork/route.ts',
    id: 'targetId',
    // `<targetId>/ai-…` or `covers/<targetId>/ai-…` in mf-artwork. Both arms of
    // the ternary must carry the canonical id — the collection arm mints a key
    // under `covers/`, which listProjectPrefix explicitly does not walk.
    key: /const filename = `\$\{isCollection \? `covers\/\$\{targetId\}` : targetId\}\/ai-/,
  },
  {
    file: 'src/app/api/finalize-video/route.ts',
    id: 'project_id',
    // Delegates the mint to storeVisualizer, which builds
    // `<projectId>/viz-<ts>.<ext>`; the id travels there through the job args.
    key: /projectId: project_id,/,
  },
]

for (const { file, id, key } of KEY_MINTS) {
  const src = source(file)
  const short = file.split('/api/')[1]
  check(`${short} imports canonicalUuid`, /canonicalUuid/.test(src))
  // The id must be PRODUCED by canonicalUuid, not merely passed through it —
  // `canonicalUuid(x)` evaluated for its truthiness while `x` keeps flowing
  // would satisfy a looser regex and canonicalise nothing.
  check(`${short} binds ${id} to canonicalUuid's RESULT`,
    new RegExp(`const ${id}(?::[^=]+)? = canonicalUuid\\(`).test(src))
  // …and refuses on null. `!${id}` is the only correct test now that the
  // validator and the canonicaliser are the same call.
  check(`${short} refuses when canonicalUuid returns null`,
    new RegExp(`if \\(!${id}\\) \\{?\\s*\\n?\\s*return NextResponse`).test(src))
  check(`${short} is anchored — the storage key really is built from ${id}`, key.test(src),
    key.source)
  // The pre-fix shape must be gone: a bare isUuid gate on the SAME identifier
  // would mean the id reaching the key was never canonicalised.
  check(`${short} no longer gates ${id} with a bare isUuid`,
    new RegExp(`isUuid\\(\\s*${id}\\s*\\)`).test(src) === false)
}

// finalize-video's GET keeps isUuid deliberately: its project_id is used ONLY
// as a `.eq('project_id', …)` filter against a uuid column, which normalises.
// No key is minted there, so narrowing it would buy nothing and could 400 an
// iOS poll. Asserted so the asymmetry is a decision, not an oversight.
{
  const src = source('src/app/api/finalize-video/route.ts')
  const get = src.slice(src.indexOf('export async function GET'))
  check('finalize-video GET still accepts either spelling (pure read, no key minted)',
    /isUuid\(projectId\)/.test(get) && !/\.upload\(|createSignedUploadUrl\(/.test(get))
}

// ── E. /api/upload-url — the key that is SIGNED is the canonical one ────────
// The client supplies the whole key here, so the rebuild has to land in the
// variable that reaches Supabase. Signing `safeFilename` while canonicalising a
// side variable would authorise one object and create another.
console.log('\n— /api/upload-url signs the canonicalised key —')
{
  const src = source('src/app/api/upload-url/route.ts')
  check('canonicalises the leading segment of the requested key',
    /const canonicalFirst = canonicalUuid\(segments\[0\]\)/.test(src))
  check('writes it back INTO the key — not into a copy',
    /if \(canonicalFirst\) segments\[0\] = canonicalFirst/.test(src))
  check('safeFilename is rebuilt from the rewritten segments',
    /const safeFilename = segments\.join\('\/'\)/.test(src))
  // The three things that must all be the rebuilt key.
  check('the SIGNED key is the rebuilt key',
    /createSignedUploadUrl\(safeFilename, \{ upsert: false \}\)/.test(src))
  check('the PUBLIC url is derived from the rebuilt key',
    /getPublicUrl\(safeFilename\)/.test(src))
  check('the mf-video shape gate runs against the rebuilt key',
    /!VIZ_KEY_RE\.test\(safeFilename\)/.test(src))
  // The ownership gate must read the id back OUT of the rebuilt key, so the id
  // authorised and the id written cannot diverge.
  check('the ownership gate reads its id back out of the rebuilt key',
    /const projectId = safeFilename\.split\('\/'\)\[0\]/.test(src)
    && /!isUuid\(projectId\) \|\| !\(await ownsProject\(projectId, userId\)\)/.test(src))
  // Ordering: canonicalise → authorise → sign. A rebuild after the sign is
  // decoration.
  const iCanon = src.indexOf('canonicalUuid(segments[0])')
  const iOwns = src.search(/ownsProject\(/)
  const iSign = src.search(/createSignedUploadUrl\(/)
  check('canonicalisation happens BEFORE the ownership check and the signature',
    iCanon > -1 && iCanon < iOwns && iOwns < iSign, `canon@${iCanon} owns@${iOwns} sign@${iSign}`)
  // The traversal guard it sits behind must still be there and still run first.
  const iTraversal = src.indexOf("seg === '..'")
  check('the path-traversal guard still runs before the rebuild',
    iTraversal > -1 && iTraversal < iCanon, `traversal@${iTraversal} canon@${iCanon}`)
}

// ── F. /api/tus — the key that is FORWARDED is the canonical one ────────────
// This route's real key lives in a HEADER it used to pass upstream verbatim.
// Everything it validated was a local copy, so canonicalising the local copy
// would have been a complete no-op — the single most likely way to "fix" this
// route and change nothing at all.
console.log('\n— /api/tus forwards the canonicalised object name —')
{
  const src = source('src/app/api/tus/route.ts')
  check('canonicalises the id segment', /const projectId = canonicalUuid\(segments\[0\]\)/.test(src))
  check('refuses when it is not a uuid', /if \(!projectId\) \{/.test(src))
  check('writes the canonical id back into the path', /segments\[0\] = projectId/.test(src))
  check('builds the key it intends to store', /const storageKey = segments\.join\('\/'\)/.test(src))

  // THE assertion. The verbatim copy list must no longer carry the metadata
  // header — that list is what made the local canonicalisation pointless.
  const forwardList = src.match(/for \(const h of \[([^\]]*)\]\)/)
  check('the verbatim header copy-list was located (test is anchored)', forwardList !== null)
  check('…and no longer passes upload-metadata through untouched',
    forwardList !== null && !/upload-metadata/.test(forwardList[1]),
    forwardList ? forwardList[1].trim() : 'not found')

  check('the metadata header is re-emitted around the validated key',
    /forwardHeaders\['upload-metadata'\] = withObjectName\(req\.headers\.get\('upload-metadata'\), storageKey\)/.test(src))
  check('withObjectName base64-encodes the key it was given, not meta.objectName',
    /const encoded = Buffer\.from\(key, 'utf8'\)\.toString\('base64'\)/.test(src)
    && !/withObjectName\([^)]*meta\.objectName/.test(src))
  check('…and replaces the objectName pair rather than appending a duplicate',
    /pair\.split\(' '\)\[0\] !== 'objectName'/.test(src) && /replaced = true/.test(src))

  // Ordering: the header must be rebuilt before the upstream POST, and the
  // ownership gate before both.
  const iOwns = src.search(/ownsProject\(/)
  const iRebuild = src.indexOf("forwardHeaders['upload-metadata']")
  const iFetch = src.indexOf('await fetch(SUPABASE_TUS')
  check('ownership → rebuild → upstream POST, in that order',
    iOwns > -1 && iOwns < iRebuild && iRebuild < iFetch, `owns@${iOwns} rebuild@${iRebuild} fetch@${iFetch}`)

  // Behavioural witness for the encoding itself: the two headers a TUS client
  // could send are genuinely different bytes, so "forward the raw one" and
  // "forward the rebuilt one" are not the same upstream request.
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
  check('witness: the raw and canonical objectName encode to different headers',
    b64(`${UPPER}/x.wav`) !== b64(`${LOWER}/x.wav`))
  check('witness: only the canonical one decodes to a key the reapers can walk',
    keyProjectId(Buffer.from(b64(`${LOWER}/x.wav`), 'base64').toString('utf8')) === LOWER
    && Buffer.from(b64(`${UPPER}/x.wav`), 'base64').toString('utf8').startsWith(`${LOWER}/`) === false)
}

// ── G. Census: no minting site is left out of this file ─────────────────────
// The table above is only as good as its coverage. Enumerate every place in
// src/ that can create a storage object and require each to be accounted for,
// so a NEW mint site fails this test instead of quietly reopening the class.
console.log('\n— every storage-key mint site in src/ is accounted for —')

const MINTS_RE = /\.upload\s*\(|createSignedUploadUrl\s*\(|upload\/resumable|\.move\s*\(|\.copy\s*\(/

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

// Each known site, with WHY it is safe. Anything not listed fails below.
const ACCOUNTED = {
  'src/app/api/upload-audio/route.ts': 'canonicalUuid at the id (section D)',
  'src/app/api/finalize-artwork/route.ts': 'canonicalUuid at the id (section D)',
  'src/app/api/generate-artwork/route.ts': 'canonicalUuid at the id (section D)',
  'src/app/api/upload-url/route.ts': 'canonicalises the client-supplied key (section E)',
  'src/app/api/tus/route.ts': 'canonicalises the forwarded objectName (section F)',
  // Not owned by this change — asserted below rather than assumed.
  'src/app/api/tus/[uploadId]/route.ts': 'proxies chunks into an EXISTING session; names no key',
  'src/lib/visualizer-store.ts': 'lowercases at the mint itself (keyProjectId, 2026-08-18)',
  'src/lib/visualizer-transcode.ts': 'derives its key from an existing one (mp4TwinPath)',
}

const minting = walk(join(repoRoot, 'src'))
  .map(f => relative(repoRoot, f))
  .filter(f => MINTS_RE.test(stripComments(read(f))))
  .sort()

check('the census found the minting sites at all (test is anchored)', minting.length >= 8,
  `${minting.length} file(s)`)
const unaccounted = minting.filter(f => !(f in ACCOUNTED))
check('no storage-key mint site is unaccounted for', unaccounted.length === 0,
  unaccounted.length ? unaccounted.join(', ') : 'all accounted')
const vanished = Object.keys(ACCOUNTED).filter(f => !minting.includes(f))
check('every accounted site still exists (the list has not gone stale)', vanished.length === 0,
  vanished.length ? vanished.join(', ') : 'none stale')

// The two sites this change does not own must still hold their own end.
check('visualizer-store still lowercases the project segment at the mint',
  /const keyProjectId = projectId\.toLowerCase\(\)/.test(source('src/lib/visualizer-store.ts')))
check('tus/[uploadId] really does not name an object key',
  !/objectName|createSignedUploadUrl|\.upload\(/.test(source('src/app/api/tus/[uploadId]/route.ts')))

// ── H. Fail-first witnesses — the pre-fix code must FAIL these checks ───────
// Self-contained reconstructions of the shapes that shipped before this commit,
// proving the assertions above discriminate rather than pass vacuously.
console.log('\n— fail-first witnesses —')

const OLD_UPLOAD_AUDIO = `
  const projectId = formData.get('project_id') as string
  if (!isUuid(projectId)) {
    return NextResponse.json({ error: 'Valid project_id is required' }, { status: 400 })
  }
  const filename = \`\${projectId}/\${Date.now()}.\${ext}\`
`
check('WITNESS: the pre-fix id gate had no canonicalUuid binding',
  /const projectId(?::[^=]+)? = canonicalUuid\(/.test(OLD_UPLOAD_AUDIO) === false
  && /isUuid\(\s*projectId\s*\)/.test(OLD_UPLOAD_AUDIO) === true)

const OLD_TUS_FORWARD = `
  for (const h of ['upload-length', 'upload-metadata', 'upload-defer-length', 'content-type']) {
    const v = req.headers.get(h)
    if (v) forwardHeaders[h] = v
  }
`
const oldList = OLD_TUS_FORWARD.match(/for \(const h of \[([^\]]*)\]\)/)
check('WITNESS: the pre-fix tus route copied upload-metadata through verbatim',
  oldList !== null && /upload-metadata/.test(oldList[1]))

const OLD_UPLOAD_URL = `
  const safeFilename = normalized.replace(/^\\/+/, '')
  const projectId = safeFilename.split('/')[0]
`
check('WITNESS: the pre-fix upload-url built no canonicalised key',
  /const safeFilename = segments\.join\('\/'\)/.test(OLD_UPLOAD_URL) === false)

// And the one that matters most: a canonicaliser that only VALIDATED would
// leave every assertion in sections D–F green while closing nothing. Section A
// is the only thing standing between that and a merge.
const validateOnly = (v) => (isUuid(v) ? v : null)
check('WITNESS: a validate-only canonicaliser fails the lowercasing assertion',
  validateOnly(UPPER) === UPPER && canonicalUuid(UPPER) !== validateOnly(UPPER))

console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
