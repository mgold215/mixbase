// iOS storage-key canonicalisation contract — the Swift half of the
// uppercase-UUID class that scripts/uuid-storage-key-test.mjs closed in src/.
//
// Run: node scripts/ios-storage-key-test.mjs
//
// WHY THIS EXISTS
// uuid-storage-key-test.mjs bounds every mint site in src/. It cannot see the
// iOS app, and the iOS app was the last live producer of un-reapable keys:
//
//   1. Swift's `UUID.uuidString` is UPPERCASE. Always.
//   2. Postgres compares `uuid` columns by VALUE, so an uppercase id passes
//      every ownership gate and every `?id=eq.…` filter identically to the
//      lowercase one. It is never rejected and never normalised on the way in.
//   3. Supabase Storage keys are plain text, stored VERBATIM.
//
// Compose them and the phone mints a real, billed object under a name no
// cleanup path can produce — every reaper, prefix census and orphan scan starts
// from an id read back OUT of Postgres, which always renders lowercase, and
// then matches it as TEXT. Measured against production 2026-08-20: five such
// objects in mf-audio, all the `<UPPERCASE-UUID>-v<n>-<ts>.wav` shape, newest
// 2026-08-16 — so this was live, not historical.
//
// THE FIX THIS FILE POLICES
// `UUID.storageKeyComponent` (SupabaseService.swift) — ONE spelling of the rule,
// applied where an id crosses from the case-insensitive world into the
// case-sensitive one. Sections C and D exist so a NEW uppercase mint site in
// Swift fails CI instead of silently reopening the class.
//
// AND THE FIX IT RULES OUT
// The obvious alternative is a blanket `.lowercased()` on `filename` inside
// `uploadRequest` — the single choke point every upload passes through. That is
// the WRONG fix and section E fails the build if anyone applies it: filenames
// are not guaranteed to be UUID-only forever, and lowercasing the whole string
// there would silently corrupt any future caller that puts user text or a
// case-sensitive token in a key. Canonicalise the UUID COMPONENT, not the
// filename.
//
// Swift is not executable under the Node runner, so every check here is a
// SOURCE assertion — with comments stripped first, so a rule that survives only
// in prose cannot pass. The stripper is Swift-aware (nested block comments,
// `"""` literals, `\(…)` interpolation) and is itself tested in section A.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

import { keyProjectId } from '../src/lib/project-assets.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(repoRoot, p), 'utf8')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── The Swift comment stripper ──────────────────────────────────────────────
// Cannot reuse source-contract.mjs's stripComments: it treats `'` and a
// backtick as string delimiters (correct for TS, wrong for Swift, where `'` is
// an apostrophe in prose and a backtick escapes an identifier), and it does not
// know `"""` or Swift's NESTED block comments. Getting this wrong is not
// cosmetic — a mis-tracked quote turns a literal `https://…` into a line
// comment and silently deletes the rest of the line from every assertion below.
function stripSwiftComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  // Contexts nest: a string may contain `\(…)` interpolation, which may contain
  // another string, which may contain another interpolation.
  const stack = []
  let block = 0 // nested /* */ depth

  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    const top = stack[stack.length - 1]

    if (block > 0) {
      if (c === '/' && d === '*') { block++; i += 2; continue }
      if (c === '*' && d === '/') { block--; i += 2; continue }
      i++
      continue
    }

    if (top && top.kind === 'string') {
      if (c === '\\') {
        // `\(` opens an interpolation; every other backslash escapes one char.
        if (d === '(') { stack.push({ kind: 'interp', depth: 1 }); out += '\\('; i += 2; continue }
        out += c + (d ?? '')
        i += 2
        continue
      }
      if (top.triple && c === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
        stack.pop(); out += '"""'; i += 3; continue
      }
      if (!top.triple && c === '"') { stack.pop(); out += c; i++; continue }
      out += c
      i++
      continue
    }

    // Code context (top of stack is nothing, or an open interpolation).
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '/' && d === '*') { block = 1; i += 2; continue }
    if (c === '"') {
      if (src[i + 1] === '"' && src[i + 2] === '"') {
        stack.push({ kind: 'string', triple: true }); out += '"""'; i += 3; continue
      }
      stack.push({ kind: 'string', triple: false }); out += c; i++; continue
    }
    if (top && top.kind === 'interp') {
      if (c === '(') { top.depth++; out += c; i++; continue }
      if (c === ')') {
        top.depth--
        if (top.depth === 0) stack.pop()
        out += c; i++; continue
      }
    }
    out += c
    i++
  }
  return out
}

const source = (p) => stripSwiftComments(read(p))

// ── A. The stripper is trustworthy ──────────────────────────────────────────
// Every assertion below is only as good as this. Each case is a shape that
// actually occurs in ios/.
console.log('\n— the Swift comment stripper —')

// Whitespace is preserved as-is (only the comment span is removed), so assert
// the property rather than an exact byte-for-byte respacing.
{
  const stripped = stripSwiftComments('let a = 1 // note\nlet b = 2')
  check('strips a line comment, keeping the code either side',
    !stripped.includes('note') && /let a = 1\s*\n\s*let b = 2/.test(stripped), JSON.stringify(stripped))
}
check('strips a doc comment', stripSwiftComments('/// note\nlet a = 1').trim() === 'let a = 1')
check('strips a block comment', stripSwiftComments('let /* mid */ a = 1') === 'let  a = 1')
check('handles NESTED block comments (Swift allows them; C does not)',
  stripSwiftComments('let /* a /* b */ c */ x = 1') === 'let  x = 1')
check('keeps a // inside a string literal — the mis-tracked-quote failure mode',
  stripSwiftComments('let u = "https://x.dev/a"') === 'let u = "https://x.dev/a"')
check('keeps an apostrophe from turning prose into a string',
  stripSwiftComments("// don't\nlet u = \"https://x.dev\"").trim() === 'let u = "https://x.dev"')
check('handles \\( interpolation containing its own string literal',
  stripSwiftComments('let p = "a=\\(x ?? "")&b" // tail') === 'let p = "a=\\(x ?? "")&b" ')
check('handles a """ literal', stripSwiftComments('let s = """\na // not a comment\n"""') === 'let s = """\na // not a comment\n"""')
check('does not treat a backtick as a quote',
  stripSwiftComments('let `class` = 1 // tail').trim() === 'let `class` = 1')

// ── B. The canonical helper — one spelling, and it really lowercases ────────
console.log('\n— UUID.storageKeyComponent —')
{
  const svc = source('ios/mixBase/Services/SupabaseService.swift')
  check('SupabaseService declares `extension UUID`', /extension UUID \{/.test(svc))
  // THE property. A helper that merely renamed `uuidString` would satisfy every
  // census check in sections C and D and close nothing at all.
  check('storageKeyComponent is defined as uuidString.lowercased()',
    /var storageKeyComponent: String \{ uuidString\.lowercased\(\) \}/.test(svc))

  // One spelling of the rule, repo-wide — the point of a helper.
  const defs = swiftFiles().filter(f => /var storageKeyComponent/.test(source(f)))
  check('exactly ONE definition exists in ios/', defs.length === 1, defs.join(', ') || 'none')
}

// ── C. Census: every storage-key MINT in ios/ is canonical ─────────────────
// A mint is a string literal that becomes a Supabase Storage object key. In
// this app they all arrive the same way — bound to `filename`, then handed to
// an upload entry point — so both halves are enumerated: the literals, and the
// call sites that consume them. A new mint fails whichever half it lands in.
console.log('\n— every storage-key mint site in ios/ uses the helper —')

function swiftFiles(dir = join(repoRoot, 'ios'), out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) swiftFiles(full, out)
    else if (entry.endsWith('.swift')) out.push(relative(repoRoot, full))
  }
  return out
}

const files = swiftFiles()
check('the census found the Swift sources at all (test is anchored)', files.length >= 10,
  `${files.length} file(s)`)

// A Swift string literal: `\(` is an escape, so interpolation containing
// parentheses is consumed without ending the literal early.
const SWIFT_STRING = String.raw`"(?:[^"\\]|\\.)*"`
const FILENAME_BINDING = new RegExp(String.raw`let\s+filename\s*=\s*(${SWIFT_STRING})`, 'g')

// Half 1 — every `let filename = "…"` literal in ios/.
const mints = []
for (const f of files) {
  for (const m of source(f).matchAll(FILENAME_BINDING)) mints.push({ file: f, literal: m[1] })
}
check('the filename-binding census is anchored (it found the known mints)', mints.length >= 4,
  `${mints.length} binding(s)`)

for (const { file, literal } of mints) {
  const short = file.split('/').pop()
  // The whole point: an id reaching a key must have gone through the helper…
  check(`${short}: ${literal} interpolates a canonical id`,
    !/\.uuidString/.test(literal),
    /\.uuidString/.test(literal) ? 'RAW uuidString reaches a storage key' : '')
  // …and if the literal names a UUID at all, it must name it via the helper.
  // (A literal with no id in it — a static key — is legitimately exempt.)
  const namesAnId = /\bid\b|\.id\b|Id\b|UUID/i.test(literal)
  if (namesAnId) {
    check(`${short}: …and does so through storageKeyComponent`,
      /storageKeyComponent/.test(literal), literal)
  }
}

// Half 2 — every call that hands a filename to storage. A file that uploads at
// all must be listed here with WHY it is safe; a NEW uploader fails.
const UPLOAD_CALLS = /\b(?:uploadAudio|uploadArtwork|uploadCollectionCover|uploadFile)\s*\(/

const ACCOUNTED = {
  'ios/mixBase/Services/SupabaseService.swift':
    'defines the helper; mints the collection-cover key through it; uploadFile/uploadRequest only PASS filename through',
  'ios/mixBase/Views/Projects/NewProjectView.swift': 'mints `<id>-v1.<ext>` through the helper',
  'ios/mixBase/Views/Projects/ProjectDetailView.swift': 'mints the artwork and version keys through the helper',
  'ios/mixBase/Views/Projects/ProjectsView.swift': 'calls uploadCollectionCover(collectionId:) — names no key itself',
}

const uploaders = files.filter(f => UPLOAD_CALLS.test(source(f))).sort()
check('the uploader census is anchored', uploaders.length >= 4, `${uploaders.length} file(s)`)
const unaccounted = uploaders.filter(f => !(f in ACCOUNTED))
check('no storage uploader in ios/ is unaccounted for', unaccounted.length === 0,
  unaccounted.length ? unaccounted.join(', ') : 'all accounted')
const vanished = Object.keys(ACCOUNTED).filter(f => !uploaders.includes(f))
check('every accounted uploader still exists (the list has not gone stale)', vanished.length === 0,
  vanished.length ? vanished.join(', ') : 'none stale')

// ── D. The three fixed sites, pinned individually ──────────────────────────
// The census above would still pass if a site were deleted. These pin the
// actual key SHAPES that reach production, so a regression names itself.
console.log('\n— the four mint sites, individually ——')

const SITES = [
  { file: 'ios/mixBase/Views/Projects/NewProjectView.swift', bucket: 'mf-audio',
    re: /let filename = "\\\(project\.id\.storageKeyComponent\)-v1\.\\\(ext\)"/ },
  { file: 'ios/mixBase/Views/Projects/ProjectDetailView.swift', bucket: 'mf-artwork',
    re: /let filename = "\\\(projectId\.storageKeyComponent\)-\\\(Int\(Date\(\)\.timeIntervalSince1970\)\)\.jpg"/ },
  { file: 'ios/mixBase/Views/Projects/ProjectDetailView.swift', bucket: 'mf-audio',
    re: /let filename = "\\\(project\.id\.storageKeyComponent\)-v\\\(nextVersion\)-\\\(Int\(Date\(\)\.timeIntervalSince1970\)\)\.\\\(ext\)"/ },
  { file: 'ios/mixBase/Services/SupabaseService.swift', bucket: 'mf-artwork',
    re: /let filename = "collection-\\\(collectionId\.storageKeyComponent\)-\\\(Int\(Date\(\)\.timeIntervalSince1970\)\)\.jpg"/ },
]

for (const { file, bucket, re } of SITES) {
  check(`${file.split('/').pop()} → ${bucket}: key is minted from storageKeyComponent`,
    re.test(source(file)), re.source)
}

// ── E. The WRONG fix must not be present ───────────────────────────────────
// `uploadRequest` is the single choke point every upload passes through, which
// makes `filename.lowercased()` there look like the tidy one-line version of
// this change. It is not equivalent: it would lowercase user text and
// case-sensitive tokens in any future key shape. Fail the build if it appears.
console.log('\n— the filename is NOT blanket-lowercased at the choke point —')
{
  const svc = source('ios/mixBase/Services/SupabaseService.swift')
  const uploadRequest = svc.slice(svc.indexOf('private func uploadRequest'))
  check('uploadRequest was located (test is anchored)', uploadRequest.startsWith('private func uploadRequest'))
  check('uploadRequest does not lowercase the filename',
    !/filename\.lowercased\(\)/.test(uploadRequest))
  check('no upload path lowercases a whole filename anywhere in ios/',
    !files.some(f => /filename\.lowercased\(\)/.test(source(f))))
}

// ── F. The trace: the SAME string becomes the key AND the stored URL ────────
// The reason this fix is not a no-op — and the check that would have caught it
// if it were. An identical-looking server fix was very nearly pointless because
// the value that became the key came from a forwarded HTTP header, not the
// local variable being "fixed". Swift has no such indirection, and these
// assertions hold it that way: `filename` is interpolated verbatim into both
// the POST path and the returned public URL, so the row's URL keeps resolving
// to the object actually written.
console.log('\n— filename reaches the object path and the public URL unchanged —')
{
  const svc = source('ios/mixBase/Services/SupabaseService.swift')

  check('uploadRequest builds the object path from `filename` verbatim',
    /let path = "\/storage\/v1\/object\/\\\(bucket\)\/\\\(filename\)"/.test(svc))

  // Both overloads — the streaming one (audio) and the in-memory one (artwork).
  const publicUrl = svc.match(/"\\\(supabaseURL\)\/storage\/v1\/object\/public\/\\\(bucket\)\/\\\(filename\)"/g) ?? []
  check('both uploadFile overloads return a public URL built from the same `filename`',
    publicUrl.length === 2, `${publicUrl.length} occurrence(s)`)

  // The wrappers must pass the argument through untouched — a `.lowercased()`
  // or a rewrite here would re-open the divergence the trace rules out.
  check('uploadAudio passes filename straight through',
    /uploadFile\(fileURL: fileURL, filename: filename, bucket: "mf-audio"/.test(svc))
  check('uploadArtwork passes filename straight through',
    /uploadFile\(data: data, filename: filename, bucket: "mf-artwork"\)/.test(svc))
  check('neither wrapper mutates the filename',
    !/filename: filename\.[a-zA-Z]/.test(svc))
}

// ── G. What this fix does NOT close, stated rather than implied ─────────────
// These three sites write to the bucket ROOT (no `<projectId>/` prefix), unlike
// the web app. Canonicalising the case makes the key REPRODUCIBLE from a
// Postgres-derived id; it does not make it ATTRIBUTABLE, because attribution in
// src/lib/project-assets.ts reads the first PATH SEGMENT and a root key has
// none. Asserted against the real function so the residual cannot be mistaken
// for something this change fixed.
console.log('\n— residual: a canonical ROOT key is still unattributable —')
{
  const LOWER = '3f1a2b4c-5d6e-4f70-8123-9a0b1c2d3e4f'
  const UPPER = LOWER.toUpperCase()

  // The bug, in bytes: the two spellings are different object keys.
  check('witness: the uppercase and canonical keys are genuinely different keys',
    `${UPPER}-v1.wav` !== `${LOWER}-v1.wav`)
  // …and only the canonical one can be produced from what Postgres hands back.
  check('witness: only the canonical key is reproducible from a row-derived id',
    `${LOWER}-v1.wav`.startsWith(LOWER) && !`${UPPER}-v1.wav`.startsWith(LOWER))

  // The residual, against the REAL recogniser.
  check('keyProjectId attributes a PREFIXED canonical key to its project',
    keyProjectId(`${LOWER}/1712345678.wav`) === LOWER)
  check('keyProjectId still returns null for a ROOT key — prefix, not case, is why',
    keyProjectId(`${LOWER}-v1.wav`) === null)
  check('…and returned null for the uppercase root key too, before this change',
    keyProjectId(`${UPPER}-v1.wav`) === null)
}

// ── H. The OTHER direction: ids compared against, or written into, PostgREST ─
// Storage is the case-SENSITIVE hazard: the bucket keeps what you give it, so
// an uppercase id mints an object nobody can name. This section is its mirror —
// the case-INSENSITIVE hazard. A `uuid` COLUMN always renders lowercase, so any
// id that has round-tripped through PostgREST comes back lowercase, and
// comparing it as TEXT against Swift's uppercase `uuidString` is not
// occasionally wrong, it is ALWAYS FALSE.
//
// That shipped: SubmitView joined submissions to curators and projects with
// `$0.id.uuidString == submission.curatorId`, so every submission rendered a
// nil curator and a nil project and CuratorDetailSheet always got an empty
// list. It was latent only because sb_submissions is empty (0 rows against 75
// curators, production 2026-08-20) — it would have broken on the first pitch.
//
// The rule these checks enforce is the general one, not the two instances:
// an id crossing into a PostgREST comparison or id FIELD must carry the
// canonical spelling. `.postgresString` is the intended one; a bare
// `.uuidString` in either position is the bug.
console.log('\n— ids crossing into PostgREST carry the canonical spelling —')

// "Bare" = not already lowercased. `.uuidString.lowercased()` is the older
// ad-hoc spelling of the same rule (section J) and is compliant, just not
// canonical, so it must not trip these rules.
const BARE_UUID_STRING = /\.uuidString(?!\s*\.lowercased\(\))/

// Rule 1 — COMPARISONS. There is no legitimate reason to compare a raw
// uuidString for equality: either the other side came from Postgres (lowercase,
// so the compare is always false) or it came from Swift (in which case compare
// the UUIDs themselves, not their renderings). No exception list.
{
  const offenders = []
  for (const f of files) {
    source(f).split('\n').forEach((line, i) => {
      if (/[=!]==?/.test(line) && BARE_UUID_STRING.test(line)) offenders.push(`${f}:${i + 1}`)
    })
  }
  check('no bare .uuidString is compared for equality anywhere in ios/',
    offenders.length === 0, offenders.join(', ') || 'none')
}

// Rule 2 — ID FIELD WRITES. Writing uppercase into a `uuid` column is harmless
// on its own (Postgres normalises on write), but it is the exact habit that
// produced rule 1's bug — the same value later read back and compared. Both
// halves say the rule the same way, so they cannot drift apart again.
{
  const FIELD_WRITE = /"[a-zA-Z_]*_?[iI]d"\s*:|fields\[\s*"/
  const offenders = []
  for (const f of files) {
    source(f).split('\n').forEach((line, i) => {
      if (FIELD_WRITE.test(line) && BARE_UUID_STRING.test(line)) offenders.push(`${f}:${i + 1}`)
    })
  }
  check('no bare .uuidString is written into an id field anywhere in ios/',
    offenders.length === 0, offenders.join(', ') || 'none')
}

// The helper itself — same discrimination as section B. A rename would satisfy
// both rules above and fix nothing.
{
  const svc = source('ios/mixBase/Services/SupabaseService.swift')
  check('postgresString is defined as uuidString.lowercased()',
    /var postgresString: String \{ uuidString\.lowercased\(\) \}/.test(svc))
  const defs = files.filter(f => /var postgresString/.test(source(f)))
  check('exactly ONE definition exists in ios/', defs.length === 1, defs.join(', ') || 'none')
  // The two helpers must stay DISTINCT. Collapsing them (or aliasing one to the
  // other) would leave one of the two doc comments describing the wrong hazard,
  // which is how the next person learns the wrong rule.
  check('postgresString and storageKeyComponent are separate declarations',
    /var storageKeyComponent: String \{ uuidString\.lowercased\(\) \}/.test(svc)
    && !/var postgresString: String \{ storageKeyComponent \}/.test(svc)
    && !/var storageKeyComponent: String \{ postgresString \}/.test(svc))
}

// ── I. The SubmitView join, pinned ─────────────────────────────────────────
// The census would still pass if these lines were deleted. Pin the actual join
// so the fix cannot silently regress to a nil curator and a nil project.
console.log('\n— the SubmitView join compares canonical spellings —')
{
  const sub = source('ios/mixBase/Views/Submit/SubmitView.swift')
  check('curator lookup uses postgresString',
    /curators\.first\(where: \{ \$0\.id\.postgresString == submission\.curatorId \}\)/.test(sub))
  check('project lookup uses postgresString',
    /projects\.first\(where: \{ \$0\.id\.postgresString == submission\.projectId \}\)/.test(sub))
  check('CuratorDetailSheet filter uses postgresString',
    /submissions\.filter \{ \$0\.curatorId == curator\.id\.postgresString \}/.test(sub))
  check('the write side matches the read side (curator_id, project_id, version_id)',
    /"curator_id": curator\.id\.postgresString/.test(sub)
    && /"project_id": project\.id\.postgresString/.test(sub)
    && /latest\?\.id\.postgresString/.test(sub))
}

// ── J. Deliberate exemptions, stated rather than assumed ───────────────────
// Two shapes look like rule violations and are not. Asserted so each is a
// decision on record, not an oversight — and so the ad-hoc set cannot grow.
console.log('\n— the exemptions are deliberate —')
{
  // 1. `?id=eq.\(uuid)` REST filters. Postgres parses the value as a uuid
  //    literal, which is case-insensitive, so both spellings select the same
  //    row. Churning ~20 call sites would be noise, and narrowing them could
  //    only introduce bugs. They are NOT matched by rules 1 and 2 above.
  const svc = source('ios/mixBase/Services/SupabaseService.swift')
  check('REST eq. filters still use plain uuidString (safe: Postgres parses a uuid literal)',
    /\?id=eq\.\\\(id\.uuidString\)/.test(svc))

  // 2. The older `.uuidString.lowercased()` spelling. Compliant — same value,
  //    just said the long way — in files this change does not own. Pinned as a
  //    census so the ad-hoc form cannot SPREAD to new files while the canonical
  //    helper exists.
  const AD_HOC = {
    'ios/mixBase/Services/MixbaseAPI.swift': 'disciplined at all ~14 call sites; predates the helper',
    'ios/mixBase/Views/Feed/FeedView.swift': 'isOwnContent compares both sides lowercased',
  }
  const adHoc = files.filter(f => /\.uuidString\s*\.lowercased\(\)/.test(source(f))).sort()
  const unlisted = adHoc.filter(f => !(f in AD_HOC))
  check('the ad-hoc .lowercased() spelling has not spread to new files',
    unlisted.length === 0, unlisted.join(', ') || `confined to ${adHoc.length} known file(s)`)
  check('the ad-hoc census is anchored (those files still use it)',
    adHoc.length === Object.keys(AD_HOC).length, adHoc.join(', '))
}

// ── H. Fail-first witnesses ────────────────────────────────────────────────
// Reconstructions of the exact lines that shipped before this commit, proving
// the assertions above discriminate rather than pass vacuously.
console.log('\n— fail-first witnesses —')

const OLD_SITES = [
  'let filename = "\\(project.id.uuidString)-v1.\\(ext)"',
  'let filename = "\\(projectId.uuidString)-\\(Int(Date().timeIntervalSince1970)).jpg"',
  'let filename = "\\(project.id.uuidString)-v\\(nextVersion)-\\(Int(Date().timeIntervalSince1970)).\\(ext)"',
]
for (const old of OLD_SITES) {
  const literal = old.match(new RegExp(SWIFT_STRING))[0]
  check(`WITNESS: the pre-fix line would fail the census — ${old.slice(0, 46)}…`,
    /\.uuidString/.test(literal) && !/storageKeyComponent/.test(literal))
}

// The helper that would have closed nothing: a rename with no lowercasing.
const RENAME_ONLY = 'var storageKeyComponent: String { uuidString }'
check('WITNESS: a rename-only helper fails the lowercasing assertion',
  /var storageKeyComponent: String \{ uuidString\.lowercased\(\) \}/.test(RENAME_ONLY) === false)

// The PostgREST class, pre-fix. Each of these shipped and each must trip a rule.
const OLD_SUBMITVIEW = [
  'let curator = curators.first(where: { $0.id.uuidString == submission.curatorId })',
  'let project = projects.first(where: { $0.id.uuidString == submission.projectId })',
  'submissions.filter { $0.curatorId == curator.id.uuidString }',
]
for (const old of OLD_SUBMITVIEW) {
  check(`WITNESS: pre-fix comparison trips rule 1 — ${old.slice(0, 44)}…`,
    /[=!]==?/.test(old) && BARE_UUID_STRING.test(old))
}
const OLD_WRITES = [
  '                "curator_id": curator.id.uuidString,',
  'if let versionId = latest?.id.uuidString { fields["version_id"] = versionId }',
]
for (const old of OLD_WRITES) {
  check(`WITNESS: pre-fix field write trips rule 2 — ${old.trim().slice(0, 44)}…`,
    /"[a-zA-Z_]*_?[iI]d"\s*:|fields\[\s*"/.test(old) && BARE_UUID_STRING.test(old))
}
// …and the compliant spellings must NOT trip either rule, or the rules would
// fail the files this change deliberately leaves alone.
check('WITNESS: the ad-hoc .lowercased() spelling does not trip rule 1',
  !BARE_UUID_STRING.test('contentUserId.uuidString.lowercased() == AuthService.shared.userId?.lowercased()'))
check('WITNESS: a REST eq. filter does not trip either rule',
  !/[=!]==?/.test('path: "/rest/v1/mb_projects?id=eq.\\(id.uuidString)"')
  && !/"[a-zA-Z_]*_?[iI]d"\s*:|fields\[\s*"/.test('path: "/rest/v1/mb_projects?id=eq.\\(id.uuidString)"'))

// The wrong fix: the blanket lowercase at the choke point.
const CHOKE_POINT_FIX = 'let path = "/storage/v1/object/\\(bucket)/\\(filename.lowercased())"'
check('WITNESS: the blanket choke-point lowercase would fail section E',
  /filename\.lowercased\(\)/.test(CHOKE_POINT_FIX))

console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
