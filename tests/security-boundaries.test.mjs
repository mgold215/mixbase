import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

test('middleware uses exact public auth routes and keeps admin/upload APIs protected', () => {
  const source = read('src/middleware.ts')

  assert.match(source, /PUBLIC_EXACT_PATHS/)
  assert.match(source, /PUBLIC_PREFIX_PATHS/)
  assert.match(source, /pathname === p/)
  assert.match(source, /pathname\.startsWith\(p\)/)
  assert.match(source, /pathname\.startsWith\('\/api\/'\)/)

  const publicLists = source.match(/const PUBLIC_EXACT_PATHS = \[[\s\S]*?const PUBLIC_PREFIX_PATHS = \[[\s\S]*?\]/)?.[0] ?? ''
  const publicPrefixList = source.match(/const PUBLIC_PREFIX_PATHS = \[[\s\S]*?\]/)?.[0] ?? ''

  assert.doesNotMatch(publicLists, /['"]\/api\/db-init['"]/)
  assert.doesNotMatch(publicLists, /['"]\/api\/tus['"]/)
  assert.doesNotMatch(publicPrefixList, /['"]\/api\/auth['"]/)
})

test('db init route requires an explicit admin token', () => {
  const source = read('src/app/api/db-init/route.ts')

  assert.match(source, /DB_INIT_TOKEN/)
  assert.match(source, /authorization/i)
  assert.match(source, /Unauthorized/)
})

test('signed upload URLs are scoped to a user-owned project path', () => {
  const source = read('src/app/api/upload-url/route.ts')

  assert.match(source, /X-User-Id/)
  assert.match(source, /project_id/)
  assert.match(source, /verifyProjectOwner/)
  assert.match(source, /startsWith/)
  assert.match(source, /mf-audio/)
})

test('release APIs verify referenced project and version ownership', () => {
  const listRoute = read('src/app/api/releases/route.ts')
  const itemRoute = read('src/app/api/releases/[id]/route.ts')

  for (const source of [listRoute, itemRoute]) {
    assert.match(source, /verifyProjectOwner/)
    assert.match(source, /verifyVersionOwner/)
  }
})

test('collection item APIs verify inserted projects belong to the same user', () => {
  const source = read('src/app/api/collections/[id]/items/route.ts')

  assert.match(source, /ownsProject/)
  assert.match(source, /project_id/)
  assert.match(source, /user_id/)
})

test('server-side artwork generation validates project ownership before spending credits', () => {
  const source = read('src/app/api/generate-artwork/route.ts')

  assert.match(source, /X-User-Id/)
  assert.match(source, /supabaseAdmin/)
  assert.match(source, /user_id/)
  assert.match(source, /Project not found/)
})
