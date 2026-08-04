// Upload authorization test.
//
// Run: node scripts/upload-ownership-test.mjs
//
// Guards two real holes found on 2026-07-30:
//
//  1. POST /api/upload-url read X-User-Id ONLY to rate-limit, then signed an
//     upload URL for whatever object key the body asked for — with
//     `upsert: true`, which storage-js stamps into the token at SIGN time. Since
//     GET /api/feed hands every signed-in user the `audio_url`/`artwork_url` of
//     every other user's uploads, and both buckets are public-read, any account
//     could overwrite a stranger's mix or cover art. Rejecting `..` never helped:
//     the keys are ordinary `<projectId>/<ts>.<ext>` paths, so no traversal was
//     needed — you just ask for someone else's key.
//
//  2. /api/tus/[uploadId] interpolated the id into a URL it authenticates with
//     the SERVICE-ROLE key. URL parsing collapses `..`, so a decoded
//     `../../rest/v1/<table>` re-aims an authenticated PATCH/HEAD at another
//     Supabase API root.
//
// `ownsProject` reaches for the `@/` alias and a live Supabase client, so the
// route itself can't be imported under plain Node type-stripping — those checks
// are contract assertions over the SOURCE. Comments are stripped first: a guard
// that survives only inside a comment must not be able to pass this test.

import { readFile } from 'fs/promises'
import { isSafeUploadId, projectIdFromUploadId } from '../src/lib/validators.ts'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// Strip comments while respecting string/template literals, so a `//` inside
// 'https://...' doesn't swallow the rest of a real line of code.
function stripComments(src) {
  let out = ''
  let i = 0
  let quote = null
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (quote) {
      if (c === '\\') { out += c + (next ?? ''); i += 2; continue }
      if (c === quote) quote = null
      out += c; i++; continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue }
    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === '/' && next === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue }
    out += c; i++
  }
  return out
}

// ── 1. isSafeUploadId (real function, real assertions) ──────────────────────
console.log('\n— isSafeUploadId —')

// Must block anything that can climb out of the resumable-upload namespace.
for (const bad of [
  '../../../../rest/v1/profiles',
  '..',
  'a/../../b',
  'abc/def',
  'abc\\def',
  '../auth/v1/admin/users',
  '',
]) {
  check(`rejects ${JSON.stringify(bad)}`, isSafeUploadId(bad) === false)
}
for (const bad of [null, undefined, 42, {}, []]) {
  check(`rejects non-string ${String(bad)}`, isSafeUploadId(bad) === false)
}

// Must not break real Supabase resumable ids (base64 / base64url shapes).
for (const good of [
  'bWYtYXVkaW8vMTIzNDU2Nzg5',
  'abc123',
  'YWJjZGVm-_ZGVmZ2hp',
  'Zm9vL2Jhcg==',
  'a.b.c',
]) {
  check(`accepts ${JSON.stringify(good)}`, isSafeUploadId(good) === true)
}
// The property that actually matters, stated so it can FAIL: for every candidate
// id, if the guard accepts it then interpolating it must not escape the upload
// namespace. Percent-encoded dot segments count — the WHATWG URL parser decodes
// and collapses `%2e%2e` just like `..`.
const BASE = 'https://ref.supabase.co/storage/v1/upload/resumable'
const escapes = []
for (const id of [
  '../../../../rest/v1/profiles', '../../auth/v1/admin/users', 'a/../../../b', '..', '../',
  '%2e%2e', '%2E%2E', '.%2e', '%2e.', '%2e%2e%2f%2e%2e', 'a/%2e%2e/b',
  'abc123', 'bWYtYXVkaW8vMTIzNDU2Nzg5', 'a.b.c',
]) {
  if (!isSafeUploadId(id)) continue           // rejected — can never be used
  const resolved = new URL(`${BASE}/${id}`).href
  if (!resolved.startsWith(`${BASE}/`)) escapes.push(`${id} -> ${resolved}`)
}
check('no ACCEPTED id can URL-resolve outside the upload namespace',
  escapes.length === 0, escapes.length ? escapes.join(' | ') : 'none escape')

// ── 2. /api/upload-url ownership contract ───────────────────────────────────
console.log('\n— /api/upload-url —')

const uploadUrlSrc = stripComments(await readFile('src/app/api/upload-url/route.ts', 'utf8'))

check('imports the shared ownership helper', /from\s+['"]@\/lib\/ownership['"]/.test(uploadUrlSrc))
check('calls ownsProject', /ownsProject\s*\(/.test(uploadUrlSrc))
check('validates the project prefix is a uuid', /isUuid\s*\(/.test(uploadUrlSrc))
check('refuses with 403', /status:\s*403/.test(uploadUrlSrc))

const idxOwns = uploadUrlSrc.search(/ownsProject\s*\(/)
const idxSign = uploadUrlSrc.search(/createSignedUploadUrl\s*\(/)
check('signs an upload URL at all (test is anchored to real code)', idxSign > -1)
// Order matters: a check that runs after the URL is minted authorizes nothing.
check('the ownership check runs BEFORE the URL is signed',
  idxOwns > -1 && idxSign > -1 && idxOwns < idxSign, `owns@${idxOwns} sign@${idxSign}`)

// Overwrite authorization is baked into the token at sign time.
check('does not sign with upsert: true', !/upsert:\s*true/.test(uploadUrlSrc))
check('explicitly signs with upsert: false', /upsert:\s*false/.test(uploadUrlSrc))

// The project prefix actually derives from the requested key, not a constant.
const prefixDecl = uploadUrlSrc.match(/(?:const|let)\s+(\w+)\s*=\s*safeFilename\s*\.split\(\s*['"]\/['"]\s*\)\s*\[\s*0\s*\]/)
check('derives the project id from the requested filename', prefixDecl !== null)

// Confused-deputy guard: the id we AUTHORIZE must be the id we SIGN. Gating on a
// separate body field while signing the requested key would pass every check
// above while authorizing nothing.
if (prefixDecl) {
  const v = prefixDecl[1]
  check('ownership is checked against that derived id',
    new RegExp(`ownsProject\\s*\\(\\s*${v}\\s*,`).test(uploadUrlSrc), `ownsProject(${v}, …)`)
  check('the uuid check is applied to that same derived id',
    new RegExp(`isUuid\\s*\\(\\s*${v}\\s*\\)`).test(uploadUrlSrc))
  check('the key actually signed is the one that was validated',
    /createSignedUploadUrl\s*\(\s*safeFilename\s*,/.test(uploadUrlSrc))
  // Fail-closed composition: EITHER failure must refuse. `&&` would let any
  // well-formed uuid short-circuit straight past the ownership call.
  check('a uuid failure OR an ownership failure refuses (not AND)',
    new RegExp(`!\\s*isUuid\\s*\\(\\s*${v}\\s*\\)\\s*\\|\\|\\s*!\\s*\\(\\s*await\\s+ownsProject`).test(uploadUrlSrc))
}

// ── 3. Generalized invariant across every signing route ─────────────────────
console.log('\n— invariant: signing a storage upload requires an ownership check —')

const SIGNING_ROUTES = [
  'src/app/api/upload-url/route.ts',
  'src/app/api/tus/route.ts',
  'src/app/api/upload-audio/route.ts',
]
for (const file of SIGNING_ROUTES) {
  let src
  try { src = stripComments(await readFile(file, 'utf8')) } catch { continue }
  const mints = /createSignedUploadUrl\s*\(|createSignedUrl\s*\(|upload\/resumable|\.upload\s*\(/.test(src)
  if (!mints) continue
  // Ownership is established either via the shared helper or by an inline
  // user-scoped select on mb_projects — upload-audio legitimately does the
  // latter. What must never happen is minting write access with neither.
  const viaHelper = /ownsProject\s*\(/.test(src) || /userOwnsProject\s*\(/.test(src)
  const viaInlineScope = /from\(\s*['"]mb_projects['"]\s*\)/.test(src) &&
    /\.eq\(\s*['"]user_id['"]\s*,\s*userId\s*\)/.test(src)
  check(`${file.split('/api/')[1]} gates on project ownership`, viaHelper || viaInlineScope,
    viaHelper ? 'ownsProject helper' : viaInlineScope ? 'inline user_id scope' : 'NEITHER')
}

// ── 4. /api/tus/[uploadId] traversal guard on BOTH handlers ─────────────────
console.log('\n— /api/tus/[uploadId] —')

const tusSrc = stripComments(await readFile('src/app/api/tus/[uploadId]/route.ts', 'utf8'))
check('imports the shared id guard', /isSafeUploadId/.test(tusSrc))

// Both handlers forward with the service-role key, so both must validate.
for (const method of ['PATCH', 'HEAD']) {
  const start = tusSrc.indexOf(`export async function ${method}`)
  const rest = tusSrc.slice(start)
  const end = rest.indexOf('export async function', 1)
  const body = end === -1 ? rest : rest.slice(0, end)
  const guardAt = body.search(/isSafeUploadId\s*\(/)
  const urlAt = body.search(/SUPABASE_TUS_BASE\s*\}?\s*\/?\$?\{?\s*uploadId|`\$\{SUPABASE_TUS_BASE\}/)
  check(`${method} validates the upload id`, guardAt > -1)
  check(`${method} validates BEFORE building the upstream URL`,
    guardAt > -1 && urlAt > -1 && guardAt < urlAt, `guard@${guardAt} url@${urlAt}`)
  check(`${method} still attaches the service-role key (test is anchored)`,
    /serviceKey\s*\(/.test(body))

  // 2026-08-04: the traversal guard proved the id is SHAPED safely, never that
  // it belongs to the caller. Both handlers forward with the service-role key,
  // so an id belonging to another user's in-flight upload was writable by any
  // signed-in account.
  const ownsAt = body.search(/ownsUpload\s*\(/)
  check(`${method} checks upload ownership, not just "someone is signed in"`, ownsAt > -1)
  check(`${method} checks ownership BEFORE building the upstream URL`,
    ownsAt > -1 && urlAt > -1 && ownsAt < urlAt, `owns@${ownsAt} url@${urlAt}`)
  check(`${method} passes the header identity, never a body/param value`,
    /const userId = req\.headers\.get\('X-User-Id'\)/.test(body)
    && /ownsUpload\(uploadId, userId\)/.test(body))
}

// The helper must fall back to ALLOW on an id it cannot parse. Supabase's id
// encoding is not a documented contract; failing closed on a format guess would
// break every upload in the app.
check('ownsUpload falls back to allow when the id does not decode',
  /if \(!projectId\) \{[\s\S]{0,400}?return true/.test(tusSrc))
// The id is an unguessable capability credential: possessing it IS the
// authorization, so it must never reach a log sink. Deriving facts ABOUT it
// (length, charset) is fine — what must not appear is the id as a reported
// VALUE, i.e. any `<key>: uploadId` in the payload.
check('the unparseable-id report describes the id without logging it',
  /idLength: uploadId\.length/.test(tusSrc) && !/:\s*uploadId\s*[,}]/.test(tusSrc))
// Witness: the shape this must catch.
check('witness: a report that DID log the id would be caught',
  /:\s*uploadId\s*[,}]/.test('extra: { id: uploadId, n: 1 }'))

// ── 5. projectIdFromUploadId (real function, real assertions) ───────────────
console.log('\n— projectIdFromUploadId —')
{
  const proj = '3f1a2b4c-5d6e-4f70-8123-9a0b1c2d3e4f'
  const b64url = s => Buffer.from(s, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  check('recovers the project id from a base64url bucket/object key',
    projectIdFromUploadId(b64url(`mf-audio/${proj}/1712345678.wav`)) === proj)
  check('recovers it when the bucket segment is absent',
    projectIdFromUploadId(b64url(`${proj}/1712345678.wav`)) === proj)
  // Anything it cannot parse must be null so the caller falls back to allow —
  // NOT an exception and NOT a wrong id.
  for (const bad of ['', 'not-base64-at-all!!', b64url('mf-audio/no-uuid-here/file.wav'), b64url('nopathseparator')]) {
    check(`returns null for unparseable id ${JSON.stringify(bad).slice(0, 40)}`,
      projectIdFromUploadId(bad) === null)
  }
  for (const bad of [null, undefined, 42, {}]) {
    check(`returns null for non-string ${String(bad)}`, projectIdFromUploadId(bad) === null)
  }
  // Witness: a decoder that returned the FIRST segment rather than the first
  // UUID would hand `ownsProject` the bucket name and deny every real chunk.
  const firstSegment = Buffer.from(b64url(`mf-audio/${proj}/x.wav`).replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    .toString('utf8').split('/')[0]
  check('witness: naive first-segment decoding would yield the bucket, not the project',
    firstSegment === 'mf-audio' && projectIdFromUploadId(b64url(`mf-audio/${proj}/x.wav`)) !== firstSegment)
}

console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
