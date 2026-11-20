#!/usr/bin/env node
// The public sync catalog (/sync/<token>, migration 047).
//
// The page hands strangers downloads of full mixes AND instrumentals, so what
// it may expose is locked here:
//   A. the gate: only a collection with is_sync === true is served; the loader
//      returns null (→ 404) for every other share token, so an ordinary
//      /album/... link can't be rewritten into a download page;
//   B. the loader names its columns and never reaches owner-private ones;
//   C. the address is public in the middleware and kept out of search;
//   D. the pure helpers.
// Pure source/unit test, no DB or network. Run: node scripts/sync-catalog-test.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isSyncCatalog, formatDuration } from '../src/lib/sync-catalog.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, cond) {
  if (cond) console.log(`  ✓ ${name}`)
  else { console.error(`  ✗ ${name}`); failures++ }
}
const constValue = (src, name) => {
  const m = src.match(new RegExp(`${name}\\s*=\\s*(['"\`])([^'"\`]*)\\1`))
  return m ? m[2] : null
}
const cols = (v) => (v ?? '').split(',').map((c) => c.trim()).filter(Boolean)

console.log('sync-catalog: the public sync page exposes only marked collections\n')

console.log('A. the gate')
check('is_sync true is served', isSyncCatalog({ is_sync: true }) === true)
check('is_sync false is refused', isSyncCatalog({ is_sync: false }) === false)
check('missing flag is refused', isSyncCatalog({}) === false)
check('null row is refused', isSyncCatalog(null) === false)
check('truthy non-boolean is refused', isSyncCatalog({ is_sync: 'true' }) === false)

const loader = read('src/lib/sync-share.ts')
check('loader refuses a collection that is not marked', /if\s*\(\s*!collection\s*\|\|\s*!isSyncCatalog\(collection\)\s*\)\s*return null/.test(loader))
check('loader reads the share token, not an id', /\.eq\('share_token',\s*token\)/.test(loader))
check('a failed lookup is not read as an empty one', /if\s*\(\s*res\.error\s*\)/.test(loader) && /items\.error/.test(loader) && /versions\.error/.test(loader))
check('missing is_sync column heals and retries', /isMissingCollectionSyncColumn\(res\.error\)/.test(loader) && /await ensureCollectionSyncColumn\(\)/.test(loader))
const page = read('src/app/sync/[token]/page.tsx')
check('page 404s when the loader refuses', /if\s*\(\s*!data\s*\)\s*notFound\(\)/.test(page))

console.log('\nB. projection')
check('no select(\'*\')', !/\.select\(\s*['"`]\*/.test(loader))
check('no feedback join', !/mb_feedback/.test(loader))
const C = cols(constValue(loader, 'COLLECTION_SYNC_COLS'))
const P = cols(constValue(loader, 'PROJECT_SYNC_COLS'))
const V = cols(constValue(loader, 'VERSION_SYNC_COLS'))
for (const c of ['is_sync', 'title', 'cover_url']) check(`collection select includes "${c}"`, C.includes(c))
for (const c of ['share_token', 'notes', '*']) check(`collection select excludes "${c}"`, !C.includes(c))
for (const c of ['title', 'bpm', 'key_signature', 'instrumental_url']) check(`project select includes "${c}"`, P.includes(c))
for (const c of ['share_token', 'user_id', '*']) check(`project select excludes "${c}"`, !P.includes(c))
for (const c of ['audio_url', 'duration_seconds']) check(`version select includes "${c}"`, V.includes(c))
for (const c of ['private_notes', 'public_notes', 'change_log', 'share_token', 'mix_check', 'audio_filename', 'label', '*']) {
  check(`version select excludes "${c}"`, !V.includes(c))
}
check('client page does not import the server loader', !/sync-share/.test(read('src/components/SyncCatalog.tsx')))

console.log('\nC. address')
const proxy = read('src/proxy.ts')
check("'/sync/' is a public prefix", /PUBLIC_PATHS = \[[\s\S]*?'\/sync\/'/.test(proxy))
check("robots disallow '/sync/'", /'\/sync\/'/.test(read('src/app/robots.ts')))
check('page asks not to be indexed', /index:\s*false/.test(page))

console.log('\nD. helpers')
check('formatDuration 187.4 → 3:07', formatDuration(187.4) === '3:07')
check('formatDuration 60 → 1:00', formatDuration(60) === '1:00')
check('formatDuration null → empty', formatDuration(null) === '')
check('formatDuration 0 → empty', formatDuration(0) === '')

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall sync-catalog checks passed')
