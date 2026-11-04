#!/usr/bin/env node
// The links people actually paste (src/lib/share-url.ts): pretty, canonical,
// and never a bare token when the caller knows the song.
// Run: node scripts/share-url-test.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { trackShareUrl, albumShareUrl, slugify } from '../src/lib/share-url.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}

console.log('share-url: single-track links\n')
const tok = 'abc123abc123abc123abc123abc123ab'
check('with artist + title → /listen/<artist>/<title>/<token>',
  trackShareUrl(tok, { artistName: 'Nova Lee', title: 'Midnight Run (Mix 3)' }) === `https://mixbase.app/listen/nova-lee/midnight-run-mix-3/${tok}`)
check('title alone still gets the pretty form',
  trackShareUrl(tok, { title: 'Midnight Run' }) === `https://mixbase.app/listen/artist/midnight-run/${tok}`)
check('nothing known → legacy /share/<token> (the server redirects it)',
  trackShareUrl(tok) === `https://mixbase.app/share/${tok}` && trackShareUrl(tok, {}) === `https://mixbase.app/share/${tok}`)
check('diacritics and symbols are slugged', slugify('Beyoncé & Jay', 'x') === 'beyonce-and-jay')
check('album links unchanged', albumShareUrl('Nova', 'EP', tok) === `https://mixbase.app/album/nova/ep/${tok}`)

console.log('\nsource contracts\n')
const proxy = read('src/proxy.ts')
check("proxy.ts PUBLIC_PATHS contains '/listen/' (the player is anonymous)", /'\/listen\/'/.test(proxy))
const robots = read('src/app/robots.ts')
check("robots.ts disallows '/listen/' (private token links)", /'\/listen\/'/.test(robots))
const legacy = read('src/app/share/[token]/page.tsx')
check('/share/<token> permanently redirects to the canonical address', /permanentRedirect\(\s*trackShareUrl\(/.test(legacy))
const listen = read('src/app/listen/[artist]/[title]/[token]/page.tsx')
check('/listen page declares the canonical URL', /alternates:\s*\{\s*canonical:\s*trackShareUrl\(/.test(listen))
check('/listen page advertises the drawn link card as og:image', /\/api\/share\/\$\{encodeURIComponent\(token\)\}\/card/.test(listen))
check('/listen page uses the large Twitter card for it', /summary_large_image/.test(listen))
const cfg = read('next.config.ts')
check('card route traces the bundled fonts', /'\/api\/share\/\[token\]\/card':\s*\[\s*'\.\/src\/fonts\/\*\*\/\*\.ttf'/.test(cfg))
check('peaks route traces the ffmpeg binary', /'\/api\/share\/\[token\]\/peaks':\s*\[\s*'\.\/node_modules\/@ffmpeg-installer\/\*\*'/.test(cfg))

if (failures) { console.error(`\nshare-url: ${failures} check(s) failed`); process.exit(1) }
console.log('\nshare-url: all checks passed')
