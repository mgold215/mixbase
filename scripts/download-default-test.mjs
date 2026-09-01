#!/usr/bin/env node
// Contract + behavior test: a new mix must never become PUBLICLY DOWNLOADABLE
// unless the artist actually asked for it.
//
// Background — why this is a test and not a code comment:
//
// /share/[token] is an anonymous page, and it always serves the project's LATEST
// version (share/[token]/page.tsx orders version_number desc, limit 1). So the
// `allow_download` value written at UPLOAD time is the one the public sees.
//
// Scope it honestly: allow_download is a CONSENT SIGNAL, not an access control.
// mf-audio is a public-read bucket and audio_url must be in the anonymous payload
// for playback to work, so a link-holder can already fetch the bytes. The flag
// decides whether mixBASE presents the master as something the artist offered.
//
// The tempting default is `true`, reasoned as "a share token is a private link
// the artist handed out deliberately". That premise is false here:
// mb_projects.share_token is minted by a DB column default
// (replace(gen_random_uuid()::text,'-','')) when the project row is created, so a
// token exists whether or not the artist ever shared anything — all 78 projects
// in production have one, and /api/tracks backfills any that are missing. So the
// existence of a token says nothing about intent, and a `true` default asserts a
// consent nobody gave, while the checkbox and the support page both describe the
// setting as something you tick to turn ON.
//
// The opposite constant, a flat `false`, is safe but silently throws the artist's
// decision away on every upload: the "Let people with the share link download
// this file" checkbox is rendered only on the CURRENT-mix card, so turning
// downloads on would quietly undo itself the next time they upload (and again
// whenever an archived mix is restored, which re-inserts it as a new row).
//
// The rule that satisfies both is to INHERIT the previous mix's value and fall
// back to false only for a project's first mix. This test locks that rule down
// as behavior (importing the real function) and locks the wiring as a source
// contract, so neither half can regress silently.
//
// Pure — no DB, no network. Run: node scripts/download-default-test.mjs
// (also part of `npm run test:renderers`)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    console.error(`  ✗ ${name}`)
    failures++
  }
}

console.log('download-default: a new mix must not be published without an explicit opt-in')

// ── 1. Behavior of the real resolver ─────────────────────────────────────────
const { resolveAllowDownload } = await import('../src/lib/version-defaults.ts')

// The safety property: absent an explicit choice, a project whose previous mix
// was not downloadable must not produce a downloadable mix.
check('first mix in a project is NOT downloadable', resolveAllowDownload(undefined, undefined) === false)
check('previous mix off → new mix off', resolveAllowDownload(undefined, false) === false)
check('previous mix null → new mix off', resolveAllowDownload(undefined, null) === false)

// The intent-carrying property: one tick keeps applying.
check('previous mix on → new mix on', resolveAllowDownload(undefined, true) === true)

// An explicit caller choice always wins, in both directions.
check('explicit true wins over previous false', resolveAllowDownload(true, false) === true)
check('explicit false wins over previous true', resolveAllowDownload(false, true) === false)

// Untrusted body values must not be coerced into publishing a master. These come
// straight off `await request.json()`, so a client (or an attacker probing the
// route) can send anything at all.
for (const bogus of ['true', 'yes', 1, {}, [], 'false', 0, '']) {
  check(
    `non-boolean ${JSON.stringify(bogus)} does not force a download-on mix`,
    resolveAllowDownload(bogus, false) === false
  )
}
check('non-boolean still inherits an ON previous mix', resolveAllowDownload('nonsense', true) === true)
check('always returns a real boolean', typeof resolveAllowDownload(undefined, undefined) === 'boolean')

// ── 2. The create route must actually use it ─────────────────────────────────
const createRoute = read('src/app/api/versions/route.ts')

check(
  'create route imports resolveAllowDownload',
  /import\s*\{[^}]*resolveAllowDownload[^}]*\}\s*from\s*['"]@\/lib\/version-defaults['"]/.test(createRoute)
)
check(
  'create route sets allow_download via resolveAllowDownload()',
  /allow_download:\s*resolveAllowDownload\s*\(/.test(createRoute)
)
// The regression this test exists to prevent.
check(
  'create route does NOT default allow_download to a bare true',
  !/allow_download:\s*allow_download\s*\?\?\s*true/.test(createRoute)
)
check(
  'create route does not hardcode allow_download: true',
  !/allow_download:\s*true\b/.test(createRoute)
)
// Inheritance is only possible if the previous row's flag is actually read. This
// is the half a source-only reviewer is most likely to drop, since the query
// looks complete without it.
check(
  'previous-version query selects allow_download',
  /\.select\(\s*['"`][^'"`]*\ballow_download\b[^'"`]*['"`]\s*\)/.test(createRoute)
)
check(
  'previous-version query still selects version_number',
  /\.select\(\s*['"`][^'"`]*\bversion_number\b[^'"`]*['"`]\s*\)/.test(createRoute)
)

// ── 3. The public share page still gates on the flag ─────────────────────────
// If the button ever stops being gated, the resolver above becomes decoration.
const shareClient = read('src/app/share/[token]/ShareClient.tsx')
check(
  'share page renders the download button only when allow_download is set',
  /\{\s*version\.allow_download\s*&&/.test(shareClient)
)
const sharePage = read('src/app/share/[token]/page.tsx')
check(
  'share page serves the LATEST version (why the upload-time value is the public one)',
  /order\(\s*['"`]version_number['"`]\s*,\s*\{\s*ascending:\s*false\s*\}\s*\)/.test(sharePage)
)

// ── 4. The owner's toggle must not misreport what the public can see ─────────
// This switch states what the artist is offering strangers, so a UI that shows
// the opposite of the DB is the actual harm. Reverting to the negation of the
// in-flight value (rather than the captured previous value) inverts the switch
// whenever a failed request settles after a successful one, and with no
// server reconciliation nothing ever corrects it.
const projectClient = read('src/app/projects/[id]/ProjectClient.tsx')
const toggleFn = projectClient.match(
  /async function updateAllowDownload[\s\S]*?\n  \}/
)?.[0] ?? ''
check('updateAllowDownload() found in ProjectClient', toggleFn.length > 0)
check(
  'download toggle reconciles with the server on success',
  /syncAfterMutation\s*\(\s*\)/.test(toggleFn)
)
check(
  'download toggle does NOT revert to the negation of the in-flight value',
  !/allow_download:\s*!allow\b/.test(toggleFn)
)
check(
  'download toggle captures the previous value to revert to',
  /allow_download:\s*prevAllow\b/.test(toggleFn)
)

// ── The version-number uniqueness net must actually be strung up ────────────
//
// POST /api/versions computes version_number as max+1 from a fresh read, then
// inserts. Two concurrent uploads to the same project both read the same max
// and both write it; the ONLY thing that turns the loser into a retryable
// conflict instead of a silent duplicate "v2" is a unique index on
// (project_id, version_number).
//
// That index has never existed in production — migration 017 was applied
// without it. And the self-heal that would create it was called ONLY from
// inside the 23505 (unique_violation) handler, an error the index itself
// raises. So the heal fired only on the error its own absence made impossible,
// and the retry loop above it was dead code. Same shape as the two other
// findings this repo keeps hitting: a correct-looking safety mechanism sitting
// on a path nothing can reach.
//
// The fix is an ordering property, so that is what is asserted: the ensure must
// happen BEFORE the insert loop, unconditionally.
const iEnsure = createRoute.indexOf('ensureVersionUniqueIndex()')
const iLoop = createRoute.indexOf('for (let attempt = 0')
check('the unique-index heal is invoked at all', iEnsure !== -1)
check('...BEFORE the insert loop, not from inside the conflict handler',
  iEnsure !== -1 && iLoop !== -1 && iEnsure < iLoop)
check('...unconditionally — not gated on an attempt counter or an error code',
  !/if \s*\([^)]*attempt[^)]*\)\s*(void\s+)?ensureVersionUniqueIndex/.test(createRoute))
check('...and awaited, so the constraint is in place for THIS insert',
  /await ensureVersionUniqueIndex\(\)/.test(createRoute))
check('the 23505 retry loop it protects is still there',
  createRoute.includes("'23505'") && iLoop !== -1)

// ── 4. iOS can express the consent choice at all ─────────────────────────────
// Until 2026-09-01 the flag was write-only from the web: Version.swift decoded
// allowDownload and nothing anywhere set it, so an artist on a phone could not
// make the choice. These pin the write path, and — more importantly — pin the
// thing that must NOT come back with it.
const iosApi = readFileSync(join(root, 'ios/mixBase/Services/MixbaseAPI.swift'), 'utf8')
const iosView = readFileSync(join(root, 'ios/mixBase/Views/Projects/ProjectDetailView.swift'), 'utf8')

check('iOS has a setAllowDownload write path',
  /func\s+setAllowDownload\s*\(\s*versionId:\s*UUID\s*,\s*allow:\s*Bool/.test(iosApi))
check('...which PATCHes the versions route, not PostgREST directly',
  /setAllowDownload[\s\S]{0,400}?\/api\/versions\/[\s\S]{0,120}?method:\s*"PATCH"/.test(iosApi))
check('...sending allow_download and nothing else',
  /setAllowDownload[\s\S]{0,300}?\[\s*String:\s*Any\s*\]\s*=\s*\[\s*"allow_download":\s*allow\s*\]/.test(iosApi))

// The regression this half exists to prevent. A hardcoded false on the UPLOAD
// path once silently reset artists' consent; the upload body must stay clear of
// this field even now that a deliberate writer exists elsewhere in the file.
const uploadBody = iosApi.slice(iosApi.indexOf('func createVersion'), iosApi.indexOf('func createVersion') + 1800)
check('iOS version upload still does NOT send allow_download',
  iosApi.indexOf('func createVersion') === -1 || !/"allow_download"/.test(uploadBody))

check('the iOS row exposes a toggle', /toggleAllowDownload\s*\(/.test(iosView))
check('...gated on the version being shareable, mirroring the web checkbox',
  /shareToken\s*!=\s*nil[\s\S]{0,400}?toggleAllowDownload/.test(iosView))
check('...and reverts the optimistic flip when the PATCH fails',
  /catch[\s\S]{0,400}?allowDownload\s*=\s*previous/.test(iosView))

// Cross-platform: the macOS target compiles this same file. A UIKit-only API
// here breaks the Mac build, and this view already relies on the PlatformCompat
// shim for UIPasteboard rather than importing UIKit itself.
check('the iOS view does not import UIKit (macOS shares this source)',
  !/^\s*import\s+UIKit\s*$/m.test(iosView))

if (failures > 0) {
  console.error(`\ndownload-default: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\ndownload-default: all checks passed')
