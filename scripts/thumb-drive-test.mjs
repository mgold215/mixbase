#!/usr/bin/env node
// THUMB DRIVE test — every account's built-in "all my songs" playlist.
//
// Exercises the REAL pure module (src/lib/thumb-drive-plan.ts via Node type
// stripping) plus a source-contract pass over the routes, pages, migration and
// app code that make the feature work. No DB, no network.
// Run: node scripts/thumb-drive-test.mjs   (also in `npm test`)
//
// The feature, in one breath: every account has exactly one THUMB DRIVE; a
// song joins it (at the top) when its FIRST mix is uploaded; it always plays
// each song's NEWEST mix; it can't be deleted, renamed or retyped; and a
// failure in any of this must never fail an upload or blank a page.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { stripComments, functionBody } from './source-contract.mjs'

import {
  THUMB_DRIVE_TITLE,
  THUMB_DRIVE_LOCKED_FIELDS,
  isThumbDrive,
  thumbDriveFillOrder,
  positionForNewSong,
  pinThumbDriveFirst,
} from '../src/lib/thumb-drive-plan.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const code = (p) => stripComments(read(p))

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// A route handler's text: from its `export async function NAME` to the next
// top-level export (route handlers take `ctx: { params … }`, whose braces would
// fool a brace matcher into returning just the type).
function handler(src, name) {
  const start = src.indexOf(`export async function ${name}`)
  if (start === -1) return ''
  const next = src.indexOf('\nexport ', start + 1)
  return src.slice(start, next === -1 ? undefined : next)
}

console.log('thumb-drive: one auto-filled "all my songs" playlist per account\n')

// ── 1. Pure rules ─────────────────────────────────────────────────────────────
console.log('pure rules')
check('the playlist is called THUMB DRIVE', THUMB_DRIVE_TITLE === 'THUMB DRIVE')

check('isThumbDrive is strict: only a literal true counts',
  isThumbDrive({ is_thumb_drive: true }) &&
  !isThumbDrive({ is_thumb_drive: false }) &&
  !isThumbDrive({ is_thumb_drive: 'true' }) &&
  !isThumbDrive({ is_thumb_drive: 1 }) &&
  !isThumbDrive({}) && !isThumbDrive(null) && !isThumbDrive(undefined))

{
  const order = thumbDriveFillOrder([
    { id: 'old', created_at: '2026-01-01T00:00:00Z', mixCount: 3 },
    { id: 'new', created_at: '2026-10-01T00:00:00Z', mixCount: 1 },
    { id: 'silent', created_at: '2026-11-01T00:00:00Z', mixCount: 0 },
    { id: 'mid', created_at: '2026-05-01T00:00:00Z', mixCount: 2 },
  ])
  check('a new THUMB DRIVE is filled newest song first', JSON.stringify(order) === '["new","mid","old"]', JSON.stringify(order))
  check('songs with no mix yet are left out (nothing to play)', !order.includes('silent'))
}
{
  const order = thumbDriveFillOrder([
    { id: 'b', created_at: '2026-05-01T00:00:00Z', mixCount: 1 },
    { id: 'a', created_at: '2026-05-01T00:00:00Z', mixCount: 1 },
    { id: 'undated', created_at: null, mixCount: 1 },
    { id: 'garbage', created_at: 'not a date', mixCount: 1 },
  ])
  check('same-time songs break ties on id; undated songs sink to the bottom',
    order[0] === 'a' && order[1] === 'b' && order.slice(2).sort().join() === 'garbage,undated', JSON.stringify(order))
}
check('the fill input is not mutated', (() => {
  const songs = [{ id: 'x', created_at: '2026-01-01T00:00:00Z', mixCount: 1 }, { id: 'y', created_at: '2026-02-01T00:00:00Z', mixCount: 1 }]
  thumbDriveFillOrder(songs)
  return songs[0].id === 'x'
})())
check('an empty account fills nothing', thumbDriveFillOrder([]).length === 0)

check('a new song goes on top: one above the current first item', positionForNewSong(0) === -1 && positionForNewSong(-4) === -5 && positionForNewSong(7) === 6)
check('an empty THUMB DRIVE starts at position 0', positionForNewSong(undefined) === 0 && positionForNewSong(null) === 0 && positionForNewSong(NaN) === 0)

{
  const rows = [
    { id: 'p1', is_thumb_drive: false },
    { id: 'p2' },
    { id: 'td', is_thumb_drive: true },
    { id: 'p3', is_thumb_drive: false },
  ]
  const pinned = pinThumbDriveFirst(rows)
  check('THUMB DRIVE is pinned first; the rest keep their order',
    pinned.map(r => r.id).join() === 'td,p1,p2,p3', pinned.map(r => r.id).join())
  check('pinning copies — the caller\'s array is untouched', rows[0].id === 'p1' && pinned !== rows)
}
check('name and type are the locked fields (cover stays editable)',
  JSON.stringify([...THUMB_DRIVE_LOCKED_FIELDS]) === '["title","type"]')

// ── 2. Migration 042 ──────────────────────────────────────────────────────────
console.log('\nmigration 042')
const migPath = 'supabase/migrations/042_thumb_drive.sql'
check('migration 042_thumb_drive.sql exists', existsSync(join(root, migPath)))
const mig = stripComments(read(migPath)).replace(/\s+/g, ' ').toLowerCase()
check('adds is_thumb_drive (not null, default false — every existing playlist stays ordinary)',
  mig.includes('add column if not exists is_thumb_drive boolean not null default false'))
check('one THUMB DRIVE per account is a database fact (partial unique index on user_id)',
  /create unique index if not exists \w+ on public\.mb_collections\s*\(user_id\) where is_thumb_drive/.test(mig))
check('backfill creates one for every existing account that lacks one',
  mig.includes("insert into public.mb_collections (user_id, title, type, is_thumb_drive)") &&
  mig.includes("'thumb drive', 'playlist', true") &&
  /not exists \( select 1 from public\.mb_collections c where c\.user_id = p\.id and c\.is_thumb_drive \)/.test(mig))
check('backfill fills only songs that have a mix, newest first',
  mig.includes('exists (select 1 from public.mb_versions v where v.project_id = pr.id)') &&
  mig.includes('order by pr.created_at desc'))
check('backfill is re-runnable: it only fills a THUMB DRIVE that is still empty',
  mig.includes('not exists (select 1 from public.mb_collection_items i where i.collection_id = c.id)'))
check('PostgREST is told to reload its schema', mig.includes("notify pgrst, 'reload schema'"))

// ── 3. Server module ──────────────────────────────────────────────────────────
console.log('\nsrc/lib/thumb-drive.ts')
const lib = code('src/lib/thumb-drive.ts')
const ensure = functionBody(lib, 'export async function ensureThumbDrive')
const add = functionBody(lib, 'export async function addSongToThumbDrive')
const fill = functionBody(lib, 'async function fillThumbDrive')
check('ensureThumbDrive, addSongToThumbDrive and fillThumbDrive were located', !!ensure && !!add && !!fill)
check('ensureThumbDrive never throws (whole body in try/catch, resolves null)',
  /^[^{]*\{\s*try\s*\{/.test(ensure) && /catch\s*\(err\)\s*\{[\s\S]*return null/.test(ensure))
check('addSongToThumbDrive never throws (whole body in try/catch)', /^[^{]*\{\s*try\s*\{/.test(add) && /catch\s*\(err\)/.test(add))
check('lookup is scoped to the account AND the flag',
  /\.eq\('user_id', userId\)\s*\.eq\('is_thumb_drive', true\)/.test(lib))
check('a missing column (deploy beat migration 042) is healed and retried',
  /isMissingThumbDriveColumn\(found\.error\) && await ensureThumbDriveColumn\(\)/.test(ensure))
check('creates it with the fixed title, as a playlist, flagged',
  /insert\(\{ user_id: userId, title: THUMB_DRIVE_TITLE, type: 'playlist', is_thumb_drive: true \}\)/.test(ensure))
check('a racing create (23505 on the one-per-account index) adopts the winner instead of failing',
  /code === '23505'[\s\S]*lookupThumbDrive\(userId\)/.test(ensure))
check('a fresh THUMB DRIVE is filled, and removed again if the fill fails (never left empty forever)',
  /await fillThumbDrive\(userId, id\)/.test(ensure) &&
  /catch \(fillError\)[\s\S]*\.delete\(\)\.eq\('id', id\)\.eq\('is_thumb_drive', true\)/.test(ensure))
check('the fill reads only this account\'s songs', /from\('mb_projects'\)[\s\S]*\.eq\('user_id', userId\)/.test(fill))
check('the fill uses the pure order and skips songs already present',
  fill.includes('thumbDriveFillOrder(') && /!have\.has\(item\.project_id\)/.test(fill))
check('adding skips a song that is already in it (no duplicates, keeps the artist\'s order)',
  /\.eq\('project_id', projectId\)[\s\S]*if \(already && already\.length > 0\) return/.test(add))
check('adding puts the song on top via positionForNewSong',
  /order\('position', \{ ascending: true \}\)/.test(add) && add.includes('positionForNewSong('))
check('adding returns early when ensure just ran a fill (the song is already in it)',
  /if \(!drive \|\| drive\.created\) return/.test(add))

// ── 4. Upload route: first mix → THUMB DRIVE ──────────────────────────────────
console.log('\nPOST /api/versions')
const versions = code('src/app/api/versions/route.ts')
const post = functionBody(versions, 'export async function POST')
const addAt = post.indexOf('addSongToThumbDrive(userId, project_id)')
check('the upload route calls addSongToThumbDrive with the authenticated user', addAt !== -1)
check('only for the song\'s FIRST mix (a hand-removed song is not forced back in)',
  /if \(nextVersion === 1\) await addSongToThumbDrive\(userId, project_id\)/.test(post))
check('only after the version insert succeeded (after the !data bail-out)',
  addAt > post.indexOf("if (!data) {") && post.indexOf("if (!data) {") !== -1)
check('userId comes from the X-User-Id header, never the body', /const userId = request\.headers\.get\('X-User-Id'\)/.test(post))

// ── 5. Collections routes ─────────────────────────────────────────────────────
console.log('\ncollections routes')
const list = code('src/app/api/collections/route.ts')
const listGet = functionBody(list, 'export async function GET')
check('GET /api/collections makes sure THUMB DRIVE exists before listing',
  listGet.indexOf('await ensureThumbDrive(userId)') !== -1 &&
  listGet.indexOf('await ensureThumbDrive(userId)') < listGet.indexOf(".from('mb_collections')"))
check('GET /api/collections returns THUMB DRIVE pinned first', listGet.includes('pinThumbDriveFirst('))

const tdRoute = 'src/app/api/collections/thumb-drive/route.ts'
check('GET /api/collections/thumb-drive exists (for the app)', existsSync(join(root, tdRoute)))
const td = code(tdRoute)
check('it reads the user from X-User-Id and 401s without one',
  td.includes("request.headers.get('X-User-Id')") && td.includes("status: 401"))
check('it runs the same ensureThumbDrive the web uses', td.includes('await ensureThumbDrive(userId)'))
check('it is not a public path', !code('src/proxy.ts').includes("'/api/collections"))

const one = code('src/app/api/collections/[id]/route.ts')
const del = handler(one, 'DELETE')
const patch = handler(one, 'PATCH')
check('DELETE and PATCH handlers were located', !!del && !!patch)
check('DELETE refuses the THUMB DRIVE before deleting anything',
  del.indexOf('await isUsersThumbDrive(id, userId)') !== -1 &&
  del.indexOf('await isUsersThumbDrive(id, userId)') < del.indexOf('.delete()'))
check('PATCH refuses a name/type change on the THUMB DRIVE before writing',
  /THUMB_DRIVE_LOCKED_FIELDS\.some\(field => field in updates\) && await isUsersThumbDrive\(id, userId\)/.test(patch) &&
  patch.indexOf('isUsersThumbDrive') < patch.indexOf('.update('))
check('the THUMB DRIVE check is owner-scoped and survives a pre-042 database (select *)',
  /async function isUsersThumbDrive[\s\S]*?\.select\('\*'\)\s*\.eq\('id', id\)\s*\.eq\('user_id', userId\)/.test(one))

// ── 6. Web pages ──────────────────────────────────────────────────────────────
console.log('\nweb pages')
const page = code('src/app/collections/page.tsx')
check('the Collections page makes sure THUMB DRIVE exists, then pins it first',
  page.indexOf('await ensureThumbDrive(userId)') !== -1 &&
  page.indexOf('await ensureThumbDrive(userId)') < page.indexOf(".from('mb_collections')") &&
  page.includes('pinThumbDriveFirst('))
check('the Collections page selects * so a pre-042 database still renders',
  /from\('mb_collections'\)\s*\.select\('\*, mb_collection_items/.test(page))
const client = code('src/app/collections/[id]/CollectionClient.tsx')
const deleteButtons = (client.match(/onClick=\{deleteCollection\}/g) ?? []).length
const guardedDeletes = (client.match(/\{!thumbDrive && \(\s*<button\s+onClick=\{deleteCollection\}/g) ?? []).length
check('every Delete button on the collection page is hidden for THUMB DRIVE',
  deleteButtons > 0 && deleteButtons === guardedDeletes, `${guardedDeletes}/${deleteButtons}`)
check('the type picker is hidden for THUMB DRIVE', /showTypePicker && !thumbDrive/.test(client) && /\{thumbDrive \? \(/.test(client))
check('the page tells the artist what THUMB DRIVE does', client.includes('THUMB_DRIVE_BLURB'))

// ── 7. Players play the NEWEST mix ────────────────────────────────────────────
console.log('\nnewest mix')
const share = code('src/lib/album-share.ts')
check('the public share player picks the highest version_number per song',
  /from\('mb_versions'\)[\s\S]*\.order\('version_number', \{ ascending: false \}\)[\s\S]*if \(!latestByProject\.has\(v\.project_id\)\)/.test(share))
const detail = code('src/app/collections/[id]/page.tsx')
check('the in-app collection player picks the highest version_number per song',
  /\.order\('version_number', \{ ascending: false \}\)[\s\S]*if \(!trackMeta\[v\.project_id\]\)/.test(detail))

// ── 8. App (iOS + macOS) ──────────────────────────────────────────────────────
console.log('\napp')
const model = code('ios/mixBase/Models/Collection.swift')
check('Collection decodes is_thumb_drive as an optional (pre-042 rows still decode)',
  /var isThumbDrive: Bool\?/.test(model) && /case isThumbDrive = "is_thumb_drive"/.test(model))
const api = code('ios/mixBase/Services/MixbaseAPI.swift')
check('the app asks the server to create THUMB DRIVE (never builds it itself)',
  /requestJSON\(path: "\/api\/collections\/thumb-drive", method: "GET"\)/.test(api))
const views = code('ios/mixBase/Views/Projects/ProjectsView.swift')
check('the app calls ensureThumbDrive only when the list lacks one, then reloads',
  /if !fetched\.contains\(where: \{ \$0\.isThumbDriveCollection \}\)[\s\S]*?MixbaseAPI\.shared\.ensureThumbDrive\(\)[\s\S]*?fetchCollections\(\)/.test(views))
check('the app pins THUMB DRIVE first',
  /fetched\.filter \{ \$0\.isThumbDriveCollection \} \+ fetched\.filter \{ !\$0\.isThumbDriveCollection \}/.test(views))
check('the app hides Delete Collection for THUMB DRIVE',
  /if !collection\.isThumbDriveCollection \{\s*Divider\(\)\s*Button\(role: \.destructive, action: \{ showDeleteConfirm = true \}\)/.test(views))
check('the app gives THUMB DRIVE a visible Send All Songs share button',
  /if collection\.isThumbDriveCollection && !items\.isEmpty \{[\s\S]*?ShareLink\(item: shareURL\) \{ sendAllSongsLabel \}[\s\S]*?mintShareLink\(\)/.test(views) &&
  /Label\("Send All Songs", systemImage: "square\.and\.arrow\.up"\)/.test(views))
check('the app hides Edit Details (name/type) for THUMB DRIVE',
  /if !collection\.isThumbDriveCollection \{\s*Button\(action: \{ showEditDetails = true \}\)/.test(views))

// ── 9. Bootstrap + self-heal keep up ──────────────────────────────────────────
console.log('\nbootstrap + heal')
const dbInit = read('src/app/api/db-init/route.ts')
const colAt = dbInit.indexOf('add column if not exists is_thumb_drive')
const userIdAt = dbInit.indexOf('alter table mb_collections add column if not exists user_id')
check('db-init carries the column and the one-per-account index',
  colAt !== -1 && dbInit.includes('create unique index if not exists idx_collections_one_thumb_drive'))
check('db-init creates the index AFTER mb_collections.user_id exists (fresh bootstrap)',
  userIdAt !== -1 && dbInit.indexOf('idx_collections_one_thumb_drive') > userIdAt)
const heal = code('src/lib/schema-heal.ts')
check('schema-heal can add the column + index at runtime',
  heal.includes('export function ensureThumbDriveColumn') && heal.includes('export function isMissingThumbDriveColumn') &&
  /add column if not exists is_thumb_drive boolean not null default false/.test(heal))

console.log(failures ? `\n${failures} check(s) failed` : '\nall THUMB DRIVE checks passed')
process.exit(failures ? 1 : 0)
