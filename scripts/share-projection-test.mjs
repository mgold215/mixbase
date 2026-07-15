#!/usr/bin/env node
// Contract test: the PUBLIC share loaders must project columns explicitly and
// must NEVER `select('*')`.
//
// Why this matters: both /share/[token] and /album/.../[token] are unauthenticated
// pages. Whatever their loaders select is serialized into the payload that reaches
// the anonymous viewer's browser (Server Component props → Client Component). These
// loaders use the service-role client, which BYPASSES RLS — so a `select('*')` (or a
// `mb_feedback(*)` join) hands the anonymous viewer owner-private data that RLS was
// meant to protect:
//   • mb_versions.private_notes  — the artist's OWN private mix notes
//   • mb_feedback.*              — every OTHER reviewer's name / rating / comment
//                                  (RLS policy `users_read_feedback` = owner-only)
//   • mb_projects/mb_collections owner metadata (share_token, bpm, key, user ids…)
//
// This regressed silently once (the version select was `*, mb_feedback(*)` and the
// share page never even rendered the feedback). This test parses the loaders' actual
// select strings and fails CI if `*` returns, the feedback join returns, or a
// forbidden owner-private column sneaks into a public projection — while also
// asserting the columns the pages DO render are still selected (so we can't "fix"
// the leak by breaking rendering).
//
// Pure source-contract test — no DB / network. Run: node scripts/share-projection-test.mjs
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

// Pull the value of a `const NAME = '...'` / "..." string literal out of source.
function constValue(src, name) {
  const m = src.match(new RegExp(`${name}\\s*=\\s*(['"\`])([^'"\`]*)\\1`))
  return m ? m[2] : null
}
const cols = (v) => (v ?? '').split(',').map((c) => c.trim()).filter(Boolean)

console.log('share-projection: public share loaders must not leak owner-private columns')

// ── /share/[token] — single-track / version share page ───────────────────────
const sharePage = read('src/app/share/[token]/page.tsx')

// Structural guards (catch a regression that bypasses the column constants).
check('share page: no select(\'*\')', !/\.select\(\s*['"`]\*/.test(sharePage))
check('share page: no mb_feedback(...) join', !/mb_feedback\s*\(/.test(sharePage))

const VER = constValue(sharePage, 'VERSION_PUBLIC_COLS')
const PROJ = constValue(sharePage, 'PROJECT_PUBLIC_COLS')
check('share page: VERSION_PUBLIC_COLS defined', VER !== null)
check('share page: PROJECT_PUBLIC_COLS defined', PROJ !== null)

const verCols = cols(VER)
// Rendered by ShareClient / generateMetadata — must stay selected.
for (const c of ['id', 'audio_url', 'label', 'version_number', 'status', 'public_notes']) {
  check(`version select includes rendered column "${c}"`, verCols.includes(c))
}
// Owner-private — must NEVER reach the anonymous payload.
for (const c of ['private_notes', 'change_log', 'share_token', 'mb_feedback', '*']) {
  check(`version select excludes owner-private "${c}"`, !verCols.includes(c))
}

const projCols = cols(PROJ)
for (const c of ['title', 'artwork_url', 'finalized_artwork_url', 'visualizer_url']) {
  check(`project select includes rendered column "${c}"`, projCols.includes(c))
}
for (const c of ['share_token', 'bpm', 'key_signature', 'private_notes', '*']) {
  check(`project select excludes owner-private "${c}"`, !projCols.includes(c))
}

// ── /album/.../[token] — public album/collection share ───────────────────────
const albumLib = read('src/lib/album-share.ts')
check('album loader: mb_collections not select(\'*\')', !/from\(\s*['"`]mb_collections['"`]\s*\)\.select\(\s*['"`]\*/.test(albumLib))

const COLL = constValue(albumLib, 'COLLECTION_PUBLIC_COLS')
check('album loader: COLLECTION_PUBLIC_COLS defined', COLL !== null)
const collCols = cols(COLL)
for (const c of ['id', 'user_id', 'title', 'type', 'cover_url']) {
  check(`collection select includes used column "${c}"`, collCols.includes(c))
}
for (const c of ['notes', 'release_date', 'share_token', '*']) {
  check(`collection select excludes non-rendered "${c}"`, !collCols.includes(c))
}

if (failures > 0) {
  console.error(`\nshare-projection: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nshare-projection: all checks passed')
