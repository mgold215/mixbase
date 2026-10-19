// Visualizer source picture — loops animate the cover the artist sees.
//
// Run: node scripts/visualizer-source-test.mjs
//
// WHY THIS EXISTS
// A project has two images: artwork_url (the clean source) and
// finalized_artwork_url (the finished cover — title lettering, a Cassette
// Studio cover, a look). Every visualizer generator animated the clean source,
// so the moment a loop was pinned the player showed a different picture from
// the cover everywhere else — reported 2026-10-19 as "wrong album art right
// after I made a visualizer". Now (web and app alike):
//   - the generators animate the finished cover by default, with "Clean
//     artwork" one tap away when the two differ;
//   - GET /api/finalize-video suggests "No text" when a pinned loop was made
//     from the finished cover (it usually already shows the title, and the
//     renderer's title flash would print it twice), and both clients start
//     from that suggestion until the artist picks a text option.
//
// A. the pure helpers (src/lib/visualizer-source.ts), imported for real;
// B. source contracts on the route and both clients (Swift can't run here).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments, bracketedBlock } from './source-contract.mjs'
import { isFinishedCoverUrl, pinForFormat } from '../src/lib/visualizer-source.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = (p) => stripComments(readFileSync(join(repoRoot, p), 'utf8'))

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const PID = '0b4e6c7a-1f2d-4e3b-9a8c-7d6e5f4a3b2c'
const OTHER = '9f8e7d6c-5b4a-4392-8a1b-0c9d8e7f6a5b'
const base = 'https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/mf-artwork/'

console.log('A. helpers')
check('finalized cover is a finished cover', isFinishedCoverUrl(`${base}${PID}/finalized-1760000000000.jpg`, PID))
check('a filtered (look) cover is a finished cover', isFinishedCoverUrl(`${base}${PID}/finalized-1760000000000-f0a1b2c3.jpg`, PID))
check('query string ignored', isFinishedCoverUrl(`${base}${PID}/finalized-1.jpg?t=2`, PID))
check('project id case-insensitive', isFinishedCoverUrl(`${base}${PID}/finalized-1.jpg`, PID.toUpperCase()))
check('clean artwork is not', !isFinishedCoverUrl(`${base}${PID}/ai-1760000000000.png`, PID))
check('a Cassette Studio clean composite is not', !isFinishedCoverUrl(`${base}${PID}/cassette-1760000000000.jpg`, PID))
check("another project's finished cover is not", !isFinishedCoverUrl(`${base}${OTHER}/finalized-1.jpg`, PID))
check('a non-artwork bucket is not', !isFinishedCoverUrl(`https://x.supabase.co/storage/v1/object/public/mf-video/${PID}/finalized-1.jpg`, PID))
check('null / empty are not', !isFinishedCoverUrl(null, PID) && !isFinishedCoverUrl('', PID) && !isFinishedCoverUrl(`${base}${PID}/finalized-1.jpg`, ''))
check('YouTube renders from the wide pin first', pinForFormat('youtube', 'v', 'w') === 'w' && pinForFormat('youtube', 'v', null) === 'v')
check('Shorts render from the vertical pin first', pinForFormat('shorts', 'v', 'w') === 'v' && pinForFormat('shorts', null, 'w') === 'w')
check('no pins → no loop', pinForFormat('youtube', null, null) === null && pinForFormat('shorts', null, null) === null)

console.log('B. finished-video route')
{
  const route = source('src/app/api/finalize-video/route.ts')
  const post = bracketedBlock(route, 'export async function POST(')
  const get = bracketedBlock(route, 'export async function GET(')
  check('POST and GET were located', post.length > 0 && get.length > 0)
  check('POST renders from the shared pin rule', /const sourceUrl = pinForFormat\(format,/.test(post))
  check('pins are loaded owner-scoped', /\.eq\('id', projectId\)\s*\.eq\('user_id', userId\)/.test(route))
  check('GET looks up the pinned loops by the same rule',
    get.includes("pinForFormat('youtube', vertical, wide)") && get.includes("pinForFormat('shorts', vertical, wide)"))
  check("GET reads only the caller's own visualizer rows",
    /\.select\('source_image_url'\)\s*\.eq\('user_id', userId\)\s*\.in\('video_url', loops\)/.test(get))
  check('GET suggests no text when a loop came from the finished cover',
    get.includes('isFinishedCoverUrl(s.source_image_url, projectId)') && get.includes('suggestShowText = false'))
  check('GET returns suggest_show_text', get.includes('suggest_show_text: suggestShowText'))
  const tryAt = get.indexOf('try {')
  const lookupAt = get.indexOf('loadProjectPins(projectId, userId)')
  check('a failed suggestion lookup cannot fail the GET', tryAt !== -1 && lookupAt > tryAt && get.includes('catch (err)'))
}

console.log('C. web')
{
  const client = source('src/app/projects/[id]/ProjectClient.tsx')
  check('project page passes the finished cover', client.includes('coverUrl={finalizedArtwork ?? artwork}'))
  const viz = source('src/components/Visualizer.tsx')
  check('cover is the default picture', viz.includes('useState(false)') && /const sourceUrl = hasChoice && animateClean \? artworkUrl : \(coverUrl \?\? artworkUrl\)/.test(viz))
  check('both generators animate the chosen picture',
    (viz.match(/artworkUrl=\{sourceUrl\}/g) ?? []).length === 2 && !viz.includes('artworkUrl={artworkUrl}'))
  check('preview shows the chosen picture', viz.includes('<Image src={sourceUrl}'))
  check('the picker only appears when the two differ', /const hasChoice = !!coverUrl && !!artworkUrl && coverUrl !== artworkUrl/.test(viz))
  const studio = source('src/components/visualizer/FreeStudio.tsx')
  check('the free studio records the picture it animated', studio.includes('sourceImageUrl: artworkUrl') && studio.includes("fd.append('sourceImageUrl', artworkUrl)"))
  const finalizer = source('src/components/VideoFinalizer.tsx')
  check('finished-video panel applies the suggestion until the artist chooses',
    finalizer.includes("data.suggest_show_text === false") && finalizer.includes('if (!textTouched.current) setShowText(!coverLoop)'))
  check('both text controls mark the choice as made', (finalizer.match(/chooseText\(/g) ?? []).length >= 3)
}

console.log('D. app')
{
  const detail = source('ios/mixBase/Views/Projects/ProjectDetailView.swift')
  check('project screen passes the finished cover', detail.includes('coverUrl: project.displayArtworkUrl'))
  const view = source('ios/mixBase/Views/Visualizer/VisualizerView.swift')
  check('cover is the default picture', view.includes('@State private var animateClean = false') &&
    view.includes('if hasSourceChoice && animateClean { return artworkUrl }') && view.includes('return coverUrl ?? artworkUrl'))
  const genFree = bracketedBlock(view, 'private func generateFree()')
  const genAI = bracketedBlock(view, 'private func generateAI()')
  check('generator functions were located', genFree.length > 0 && genAI.length > 0)
  check('free generator animates the chosen picture', genFree.includes('guard let imageUrl = sourceImageUrl') && !genFree.includes('artworkUrl'))
  check('AI video animates the chosen picture', genAI.includes('guard let imageUrl = sourceImageUrl') && !genAI.includes('artworkUrl'))
  check('applies the server text suggestion until the artist chooses',
    view.includes('if !finishTextTouched, let suggested = latest.suggestShowText'))
  check('re-reads the suggestion after pinning a different loop', bracketedBlock(view, 'private func pin(').includes('await loadLatestFinished()'))
  const api = source('ios/mixBase/Services/MixbaseAPI.swift')
  check('app decodes suggest_show_text', api.includes('case suggestShowText = "suggest_show_text"'))
}

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nvisualizer source contract holds')
