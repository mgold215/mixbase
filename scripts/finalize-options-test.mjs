// Finalize Artwork option-set contract — ONE list, every client.
//
// Run: node scripts/finalize-options-test.mjs
//
// WHY THIS EXISTS
// Finalize Artwork shipped on the web and never reached the native app — the
// owner found the gap by hand (2026-10-19). Its options also lived in two
// copies: the renderer's validation arrays (finalize-render.ts) and a hand copy
// in the web Artwork tab (ArtworkGenerator.tsx); the app would have needed a
// third, in Swift. Copies drift — add a filter to one and the others never
// learn of it — so the option set is now defined ONCE:
//
//   src/lib/finalize-options.ts       the only definition
//   finalize-render.ts + the route    validate against it
//   ArtworkGenerator.tsx (web)        imports it
//   the app (iOS + macOS)             fetches it: GET /api/finalize-artwork
//
// This suite fails the build if any of those links breaks, or if the app stops
// sending what the route reads.
//
// Swift cannot run under Node, so the app half is SOURCE assertions with
// comments stripped first (a rule that survives only in prose cannot pass).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments, bracketedBlock } from './source-contract.mjs'
import {
  finalizeOptionsPayload, POSITIONS, SIZES, FILTERS, FILTER_OPTIONS, SIZE_OPTIONS, FINALIZE_DEFAULTS,
} from '../src/lib/finalize-options.ts'
import * as renderer from '../src/lib/finalize-render.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(repoRoot, p), 'utf8')
const source = (p) => stripComments(read(p))

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

// ── A. The payload the app builds its controls from ─────────────────────────
console.log('A. GET /api/finalize-artwork payload')
const payload = finalizeOptionsPayload()
check('payload has exactly positions/sizes/filters/colors/defaults',
  same(Object.keys(payload), ['positions', 'sizes', 'filters', 'colors', 'defaults']), Object.keys(payload).join(','))

const expectedGrid = ['top', 'middle', 'bottom'].flatMap(v => ['left', 'center', 'right'].map(h => `${v}-${h}`))
check('positions are the 3×3 grid in reading order', JSON.stringify(payload.positions) === JSON.stringify(expectedGrid),
  JSON.stringify(payload.positions))

for (const key of ['sizes', 'filters', 'colors']) {
  const list = payload[key]
  const shaped = Array.isArray(list) && list.length > 0 && list.every(o =>
    o && typeof o.value === 'string' && typeof o.label === 'string' && o.label.length > 0 && Object.keys(o).length === 2)
  check(`${key}: non-empty [{ value, label }]`, shaped)
  check(`${key}: values unique`, new Set(list.map(o => o.value)).size === list.length)
}
check('colors are #RRGGBB', payload.colors.every(c => /^#[0-9A-Fa-f]{6}$/.test(c.value)))

const d = payload.defaults
check('defaults carry exactly position/size/filter/color/showRule',
  same(Object.keys(d), ['position', 'size', 'filter', 'color', 'showRule']), Object.keys(d).join(','))
check('default position is offered', payload.positions.includes(d.position), d.position)
check('default size is offered', payload.sizes.some(s => s.value === d.size), d.size)
check('default filter is offered', payload.filters.some(f => f.value === d.filter), d.filter)
check('default color is #RRGGBB', /^#[0-9A-Fa-f]{6}$/.test(d.color), d.color)
check('default showRule is a boolean', typeof d.showRule === 'boolean')

check('payload values == validation arrays (positions)', same(payload.positions, POSITIONS))
check('payload values == validation arrays (sizes)', same(payload.sizes.map(s => s.value), SIZES))
check('payload values == validation arrays (filters)', same(payload.filters.map(f => f.value), FILTERS))
check('FILTERS derived from FILTER_OPTIONS', same(FILTERS, FILTER_OPTIONS.map(f => f.value)))
check('SIZES derived from SIZE_OPTIONS', same(SIZES, SIZE_OPTIONS.map(s => s.value)))

// A copy, not the live arrays — a caller mutating the JSON cannot reach the
// validation lists.
payload.positions.push('nowhere')
check('payload is a copy of the validation arrays', !POSITIONS.includes('nowhere'))

// ── B. The renderer validates against the same arrays ───────────────────────
console.log('B. renderer')
check('finalize-render re-exports the SAME POSITIONS', renderer.POSITIONS === POSITIONS)
check('finalize-render re-exports the SAME FILTERS', renderer.FILTERS === FILTERS)
check('finalize-render re-exports the SAME default colour', renderer.DEFAULT_TEXT_COLOR === FINALIZE_DEFAULTS.color)
{
  const render = source('src/lib/finalize-render.ts')
  const applyFilter = bracketedBlock(render, 'function applyFilter(')
  check('applyFilter was located', applyFilter.includes('switch'))
  const unhandled = FILTERS.filter(f => f !== 'none' && !applyFilter.includes(`case '${f}':`))
  check('every offered filter has a grade in applyFilter', unhandled.length === 0, `unhandled: ${unhandled.join(', ')}`)
  check('renderer declares no list of its own',
    !/export const (POSITIONS|FILTERS)\s*[:=]/.test(render) && !/export type (Filter|Position|Size)\s*=/.test(render))
}

// ── C. The route serves the list and validates POST against it ──────────────
console.log('C. /api/finalize-artwork route')
const route = source('src/app/api/finalize-artwork/route.ts')
const get = bracketedBlock(route, 'export async function GET(')
check('GET handler exists', get.length > 0)
check('GET returns finalizeOptionsPayload()', get.includes('finalizeOptionsPayload()'))
check('GET requires a signed-in user', get.includes("'X-User-Id'") && get.includes('401'))
check('route imports the shared option set', /from '@\/lib\/finalize-options'/.test(route))
check('POST validates position/size/filter against the shared arrays',
  route.includes('POSITIONS.includes(body.position)') && route.includes('SIZES.includes(body.size)') &&
  route.includes('FILTERS.includes(body.filter)'))
check('route has no inline option literals', !/\[\s*'small'\s*,/.test(route) && !route.includes("'golden'"))
const routeReads = new Set([...route.matchAll(/\bbody\.(\w+)/g)].map(m => m[1]))

// ── D. The web Artwork tab renders from the shared list ──────────────────────
console.log('D. web Artwork tab')
{
  const web = source('src/components/ArtworkGenerator.tsx')
  check('ArtworkGenerator imports @/lib/finalize-options', /from '@\/lib\/finalize-options'/.test(web))
  check('ArtworkGenerator renders FILTER_OPTIONS, POSITIONS and SIZE_OPTIONS',
    web.includes('FILTER_OPTIONS.map(') && web.includes('POSITIONS.map(') && web.includes('SIZE_OPTIONS.map('))
  check('ArtworkGenerator keeps no copy of its own', !web.includes("'golden'") && !web.includes("'middle-center'"))
}

// ── E. The native app (iOS + macOS share ios/mixBase) ────────────────────────
console.log('E. native app')
{
  const api = source('ios/mixBase/Services/MixbaseAPI.swift')
  const optionsFn = bracketedBlock(api, 'func finalizeOptions(')
  check('app fetches the option list (GET /api/finalize-artwork)',
    optionsFn.includes('"/api/finalize-artwork"') && optionsFn.includes('method: "GET"'))
  const finalizeFn = bracketedBlock(api, 'func finalizeArtwork(')
  check('app finalizes through the server (POST /api/finalize-artwork)',
    finalizeFn.includes('"/api/finalize-artwork"') && finalizeFn.includes('method: "POST"'))
  check('app reads finalized_artwork_url from the response', finalizeFn.includes('"finalized_artwork_url"'))

  const sent = new Set([...finalizeFn.matchAll(/"(\w+)":/g)].map(m => m[1]))
  check('app sends every field the route reads', same(sent, routeReads),
    `app sends {${[...sent].join(',')}}, route reads {${[...routeReads].join(',')}}`)
  check('app sends a lowercase project id', /"project_id":\s*projectId\.uuidString\.lowercased\(\)/.test(finalizeFn))

  // The Decodable must declare exactly the payload's keys, or a renamed key
  // fails to decode and the screen never loads.
  const optionsStruct = bracketedBlock(api, 'struct FinalizeOptions:')
  const defaultsStruct = bracketedBlock(optionsStruct, 'struct Defaults:')
  check('FinalizeOptions / Defaults structs were located', optionsStruct.length > 0 && defaultsStruct.length > 0)
  const lets = (src) => [...src.matchAll(/\blet (\w+)\s*:/g)].map(m => m[1])
  check('FinalizeOptions decodes exactly the payload keys',
    same(lets(optionsStruct.replace(defaultsStruct, '')), Object.keys(finalizeOptionsPayload())),
    lets(optionsStruct.replace(defaultsStruct, '')).join(','))
  check('FinalizeOptions.Defaults decodes exactly the defaults keys',
    same(lets(defaultsStruct), Object.keys(FINALIZE_DEFAULTS)), lets(defaultsStruct).join(','))

  const view = source('ios/mixBase/Views/Artwork/FinalizeArtworkView.swift')
  check('FinalizeArtworkView builds its controls from the fetched options',
    view.includes('MixbaseAPI.shared.finalizeOptions()') && view.includes('options.filters') &&
    view.includes('options.positions') && view.includes('options.sizes') && view.includes('options.colors'))
  check('FinalizeArtworkView keeps no copy of the list', !view.includes('"golden"') && !view.includes('"middle-center"'))
  check('FinalizeArtworkView renders through the server', view.includes('MixbaseAPI.shared.finalizeArtwork('))

  const pbx = read('ios/mixBase.xcodeproj/project.pbxproj')
  check('FinalizeArtworkView.swift is compiled into the iOS app',
    /\/\* FinalizeArtworkView\.swift in Sources \*\/ = \{isa = PBXBuildFile/.test(pbx) &&
    /\/\* FinalizeArtworkView\.swift in Sources \*\/,/.test(pbx))

  const detail = source('ios/mixBase/Views/Projects/ProjectDetailView.swift')
  check('the project screen links to FinalizeArtworkView', detail.includes('FinalizeArtworkView('))
}

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nfinalize options contract holds')
