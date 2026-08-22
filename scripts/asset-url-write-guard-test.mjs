#!/usr/bin/env node
// Write-site guards on the columns the delete scan reads.
//
// Run: node scripts/asset-url-write-guard-test.mjs
//
// THE BUG THIS EXISTS FOR
// PATCH /api/collections/[id] wrote `cover_url` straight from the request body:
//
//     if ('cover_url' in body) updates.cover_url = body.cover_url
//
// No host check, no protocol check, no bucket check, not even a type check —
// while every sibling column (artwork_url, audio_url, source_image_url) went
// through isSupabaseStorageUrl at its write site.
//
// That is not merely a broken-image bug. cover_url is in ASSET_URL_COLUMNS, so
// both delete paths PARSE it to answer "which storage objects are still in
// use?". A crafted value there corrupts the answer to a question whose wrong
// answer deletes another account's bytes.
//
// TWO HALVES, BOTH REQUIRED, AND NEITHER SUFFICIENT ALONE
//
//   1. The write-site guard (this file, Part B) stops bad values landing
//      through the route.
//   2. The DERIVATION anchor (storagePathFromUrl, Part A) stops a bad value
//      that lands ANOTHER way from doing damage.
//
// Half 2 is what actually closes it, because the route is not the only writer:
// SupabaseService.updateCollectionFields PATCHes /rest/v1/mb_collections
// straight against PostgREST from the iOS app, bypassing every route-level
// check. RLS confines that to the user's own rows, but the VALUE is arbitrary.
// So the guard is defence in depth and the anchor is the control.
//
// Pure — no DB, no network.

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { stripComments } from './source-contract.mjs'
import { isSupabaseStorageUrl, isJsonObject } from '../src/lib/validators.ts'
import { ASSET_URL_COLUMNS, storagePathFromUrl, ARTWORK_BUCKET } from '../src/lib/project-assets.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const HOST = 'https://mdefkqaawrusoaojstpq.supabase.co'
const VICTIM = 'fcbf028c-1111-2222-3333-444444444444/ai-1783622744357.webp'

// ── A) The derivation anchor — the control, not the guard ───────────────────
console.log('— storagePathFromUrl is ANCHORED, not searched —')

const injections = [
  ['marker smuggled mid-path', `https://evil.example/x${'/storage/v1/object/public/mf-artwork/'}${VICTIM}`],
  ['marker at the root of a foreign host', `https://evil.example/storage/v1/object/public/mf-artwork/${VICTIM}`],
  ['relative path, no host to check', `/storage/v1/object/public/mf-artwork/${VICTIM}`],
  ['http downgrade', `http://mdefkqaawrusoaojstpq.supabase.co/storage/v1/object/public/mf-artwork/${VICTIM}`],
  ['a lookalike host', `https://mdefkqaawrusoaojstpq.supabase.co.evil.example/storage/v1/object/public/mf-artwork/${VICTIM}`],
  ['wrong bucket for the asked-about bucket', `${HOST}/storage/v1/object/public/mf-audio/${VICTIM}`],
]
for (const [label, url] of injections) {
  check(`no key derived — ${label}`, storagePathFromUrl(url, ARTWORK_BUCKET) === null,
    String(storagePathFromUrl(url, ARTWORK_BUCKET)))
}

check('the canonical shape still derives its key exactly',
  storagePathFromUrl(`${HOST}/storage/v1/object/public/mf-artwork/${VICTIM}`, ARTWORK_BUCKET) === VICTIM)

// The regression that a naive `new URL()` rewrite would have caused: 110
// production audio URLs carry literal spaces because that IS the object name.
check('a literal-space key is returned byte-for-byte, never re-encoded',
  storagePathFromUrl(`${HOST}/storage/v1/object/public/mf-artwork/5 AM IN ARLINGTON (Mix).jpg`, ARTWORK_BUCKET)
    === '5 AM IN ARLINGTON (Mix).jpg')

// ── B) isSupabaseStorageUrl actually checks the path, not just the host ─────
console.log('\n— isSupabaseStorageUrl —')

check('rejects a non-storage path on the RIGHT host (the SSRF shape)',
  !isSupabaseStorageUrl(`${HOST}/rest/v1/profiles?select=*`))
check('rejects a bucket we do not own', !isSupabaseStorageUrl(`${HOST}/storage/v1/object/public/other-bucket/x.jpg`))
check('rejects a non-string', !isSupabaseStorageUrl(5) && !isSupabaseStorageUrl(null) && !isSupabaseStorageUrl({}))
check('accepts each of our three buckets', ['mf-audio', 'mf-artwork', 'mf-video']
  .every(b => isSupabaseStorageUrl(`${HOST}/storage/v1/object/public/${b}/k.bin`)))

// ── C) isJsonObject — the JSON.parse('5') class ─────────────────────────────
console.log('\n— isJsonObject —')

for (const bad of [5, 0, true, false, 'x', '', null, [], [1, 2]]) {
  check(`rejects ${JSON.stringify(bad)}`, !isJsonObject(bad))
}
check('accepts a plain object', isJsonObject({ cover_url: null }))

// ── D) Write sites: every survivor-scan URL column is guarded ───────────────
console.log('\n— write-site guards on ASSET_URL_COLUMNS —')

/** Every route.ts under src/app/api. */
function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name === 'route.ts') out.push(p)
  }
  return out
}

const routes = walk(join(root, 'src/app/api'))
check('route sweep found the API tree', routes.length > 20, `${routes.length} routes`)

// Columns whose values are storage URLs. mb_versions.audio_url etc. — take the
// column names from the SHARED list so a new scan column is swept automatically.
const urlColumns = [...new Set(ASSET_URL_COLUMNS.map(([, c]) => c))]
check('column list derived from ASSET_URL_COLUMNS', urlColumns.length > 0, urlColumns.join(', '))

// A route that assigns one of those columns FROM THE BODY must name a validator
// in the same file. This is a heuristic, deliberately: it cannot prove the guard
// is wired to that particular assignment, but it does make "wrote it with no
// validator anywhere in the file" — the exact state cover_url was in — impossible
// to reintroduce silently.
const VALIDATORS = ['isSupabaseStorageUrl', 'isRestorableArtworkKey', 'parseVizStoragePath', 'keyProjectId']
let swept = 0
for (const file of routes) {
  const src = stripComments(readFileSync(file, 'utf8'))
  const rel = file.slice(root.length + 1)
  for (const col of urlColumns) {
    // `updates.cover_url = body.x`, `cover_url: body.x`, `cover_url,` in an
    // object built from destructured body fields.
    const assignsFromBody =
      new RegExp(`\\.${col}\\s*=\\s*body\\b`).test(src) ||
      new RegExp(`\\b${col}\\s*:\\s*body\\.`).test(src)
    if (!assignsFromBody) continue
    swept++
    const guarded = VALIDATORS.some(v => src.includes(v))
    check(`${rel} guards ${col} before writing it`, guarded,
      guarded ? '' : 'NO validator named anywhere in this file')
  }
}
check('the sweep actually examined at least one body-assigned URL column',
  swept > 0, `${swept} assignment(s) — a zero here means the pattern stopped matching, not that all is well`)

// ── E) The specific route, stated concretely ───────────────────────────────
console.log('\n— PATCH /api/collections/[id] —')

const coll = stripComments(read('src/app/api/collections/[id]/route.ts'))
check('body shape is validated with the shared guard, not `if (!body)`',
  coll.includes('isJsonObject(body)') && !/if\s*\(!body\)/.test(coll))
check('cover_url is validated against isSupabaseStorageUrl',
  /isSupabaseStorageUrl\(body\.cover_url\)/.test(coll))
check('null is still accepted, so a cover can be cleared',
  /body\.cover_url\s*!==\s*null/.test(coll))
check('title is type-checked before .trim()',
  /typeof body\.title === 'string'/.test(coll))
check('the guard rejects with 400, not 500', /cover_url must be a Supabase storage URL/.test(coll))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
