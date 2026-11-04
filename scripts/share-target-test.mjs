#!/usr/bin/env node
// Source contracts for the public share surfaces added with the share-page
// rebuild: one token resolver behind every token-scoped route, the album page's
// feedback naming a track only through its token, and the "alive" layer
// keeping the native audio path on iOS.
// Run: node scripts/share-target-test.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}

console.log('share-target: one resolver for every token-scoped public route\n')
const target = stripComments(read('src/lib/share-target.ts'))
check('the resolver refuses a malformed token before any lookup', /SHARE_TOKEN_RE\.test\(token\)\)\s*return null/.test(target))
check('an album token needs a project id', /if \(!wantProjectId\) return null/.test(target))
check('…checked against the collection\'s own items', /from\('mb_collection_items'\)[\s\S]{0,200}\.eq\('project_id', wantProjectId\)/.test(target))

for (const [label, path] of [
  ['duration route', 'src/app/api/share/[token]/duration/route.ts'],
  ['peaks route', 'src/app/api/share/[token]/peaks/route.ts'],
  ['feedback route', 'src/app/api/feedback/route.ts'],
]) {
  const src = stripComments(read(path))
  check(`${label} imports resolveShareTarget from the shared module`, /import\s*\{[^}]*resolveShareTarget[^}]*\}\s*from\s*'@\/lib\/share-target'/.test(src))
  check(`${label} declares no resolver of its own`, !/async function resolveShareTarget/.test(src))
}

console.log('\nfeedback route: the album page names a track only through its token\n')
const fb = stripComments(read('src/app/api/feedback/route.ts'))
check('version_id path is unchanged (isUuid-guarded)', /namesVersion && !isUuid\(version_id\)/.test(fb))
check('share path needs BOTH share_token and project_id', /typeof share_token === 'string' && typeof project_id === 'string'/.test(fb))
check('project_id is isUuid-guarded before any lookup', /namesShare && !isUuid\(project_id\)/.test(fb))
check('a project the token does not cover is refused', /target\.projectId !== project_id/.test(fb))
check('the insert uses the RESOLVED version, never the raw body', /version_id: versionId,/.test(fb) && !/version_id: version_id/.test(fb))

console.log('\npeaks route\n')
const peaks = stripComments(read('src/app/api/share/[token]/peaks/route.ts'))
check('?project is isUuid-guarded', /isUuid\(wantProject\)/.test(peaks))
check('a project id may only narrow the token', /wantProjectId !== target\.projectId\) return null/.test(peaks))
check('the persisted write is write-once on the UPDATE itself', /\.update\(\{ waveform_peaks: peaks \}\)[\s\S]{0,120}\.is\('waveform_peaks', null\)/.test(peaks))
check('the ffmpeg child is armed with the shared watchdog', /armDeadline\(proc,/.test(peaks))
check('the download heartbeat lives inside the pipeline (Transform)', /new Transform\(/.test(peaks))

console.log('\nthe alive layer\n')
const fx = stripComments(read('src/lib/share-fx.ts'))
check('no AudioContext on iOS (the native element must stay the audio path)', /if \(!audio \|\| ctxRef\.current \|\| isIOS\(\)\) return/.test(fx))
{
  // Exactly one AudioContext construction, and it sits inside the
  // ensureAnalyser callback (which the players call from the play tap).
  const starts = fx.indexOf('const ensureAnalyser = useCallback')
  const ends = fx.indexOf('}, [audioRef])', starts)
  const first = fx.indexOf('new Ctx()')
  check('the analyser is created only inside ensureAnalyser (a user gesture)',
    starts !== -1 && ends !== -1 && first !== -1 && first > starts && first < ends && fx.indexOf('new Ctx()', first + 1) === -1)
}
check('a failed analyser re-connects the source to the destination', /source\.connect\(ctx\.destination\)/.test(fx))
check('fetchPeaks gives up to [] after bounded polling', /PEAKS_POLL_MAX/.test(fx) && /return \[\]/.test(fx))

const wave = stripComments(read('src/components/ShareWaveform.tsx'))
check('the waveform is keyboard-seekable (slider role honoured)', /role="slider"/.test(wave) && /tabIndex=\{0\}/.test(wave) && /onKeyDown=/.test(wave))

console.log('\nalbum player: public-only extras stay off the signed-in view\n')
const album = stripComments(read('src/components/AlbumPlayer.tsx'))
check('the waveform uses the album token on the public page, the song\'s own token on the artist\'s view, else plain bars',
  /albumToken \? `\/api\/share\/\$\{encodeURIComponent\(albumToken\)\}\/peaks\?project=/.test(album)
  && /track\.shareToken \? `\/api\/share\/\$\{encodeURIComponent\(track\.shareToken\)\}\/peaks`/.test(album)
  && /if \(!peaksUrl\) \{ setPeaks\(\[\]\); return \}/.test(album))
check('the note offer is gated on the album token', /if \(!albumToken \|\| !\(duration > 0\)\) return/.test(album))
check('the feedback drawer is gated on the album token', /\{albumToken && \(\s*<div ref=\{drawerRef\}/.test(album))
check('the end-of-album card is gated on the album token', /\{albumToken && albumEnded &&/.test(album))
check('feedback names the track by token + project id, never a version id', /shareToken=\{albumToken\}\s*projectId=\{current\.id\}/.test(album) && !/versionId=/.test(album))
check('reactions post share_token + project_id', /share_token: albumToken,\s*project_id: track\.id/.test(album))
for (const [label, path] of [['ShareClient', 'src/app/share/[token]/ShareClient.tsx'], ['AlbumPlayer', 'src/components/AlbumPlayer.tsx']]) {
  const src = stripComments(read(path))
  check(`${label} uses the shared alive layer`, /useAudioEnergy\(/.test(src) && /useParallax\(/.test(src) && /usePortrait\(/.test(src))
  check(`${label} has no AudioContext of its own`, !/new AudioContext|createMediaElementSource/.test(src))
}
const loader = read('src/lib/album-share.ts')
check('album loader selects the wide loop alongside the Canvas one', /visualizer_url, visualizer_wide_url/.test(loader))

if (failures) { console.error(`\nshare-target: ${failures} check(s) failed`); process.exit(1) }
console.log('\nshare-target: all checks passed')
