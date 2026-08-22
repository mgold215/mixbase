#!/usr/bin/env node
// Contract test: inline playback for ARCHIVED versions in the "Version History"
// modal of src/app/projects/[id]/ProjectClient.tsx (grouped into Masters and
// Mixes sections since the smart-mix-status change; the per-row contract is
// identical for both sections because they share one render callback).
//
// The whole feature is JSX plus a four-line handler — there is no pure module to
// unit-test, so every check here reads the REAL component source. That is
// deliberate and it is the lesson of loudness-auto-test.mjs, which shipped with
// no source contract over this same file at all and stayed green through four
// separate mutations of the component it claimed to cover.
//
// Four things must stay true, and each of them is a way the feature silently
// stops working rather than visibly breaking:
//
//   1. THE PROXY. Playback must use audioProxyUrl(). Supabase's public object
//      URLs do not reliably return Accept-Ranges, so a raw URL still plays —
//      it just cannot seek and reports no duration. It also would never equal
//      the engine's `currentUrl`, so the row would never light up as playing
//      and the stop-on-close below would never fire. Nothing throws.
//
//   2. THE SHARED ELEMENT. There is exactly ONE <audio> in this app, owned by
//      PlayerContext. Archived rows drive it through playUrl/togglePlay, which
//      is what makes "only one mix at a time" structural instead of bookkeeping.
//      A second element (or per-row playing state) would let two mixes overlap
//      and let a stale row claim to be playing.
//
//   3. WEB AUDIO STAYS SHUT. PlayerContext exports ensureAudioChain, which calls
//      createMediaElementSource on that shared element. It is dead code, and it
//      is irreversible for the page session: routing the element into a Web
//      Audio graph that fails leaves the whole app silent. This page must never
//      touch it — including via the usePlayer() destructure.
//
//   4. CLOSING STOPS IT. Dismissing the modal must stop a mix the modal started,
//      and must NOT stop the current mix the user was already playing. Every
//      close path has to route through that stop, which is why setArchivedOpen
//      (false) is asserted to exist exactly once in the file.
//
// Regions are sliced with source-contract.mjs (real syntactic blocks, not
// character windows) and comments are stripped first — a guard deleted from the
// code but still described in the comment above it must not keep a check green.
//
// Run: node scripts/archived-playback-test.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { stripComments, functionBody, bracketedBlock } from './source-contract.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

const SRC_PATH = 'src/app/projects/[id]/ProjectClient.tsx'
const src = stripComments(read(SRC_PATH))

// The JSX expression container for the whole modal, the arrow body that renders
// one archived row, and the two handlers that own the close path.
const modal = bracketedBlock(src, '{archivedOpen && (')
const row = bracketedBlock(src, 'list.map(av')
const closeFn = functionBody(src, 'function closeArchived()')
const restoreFn = functionBody(src, 'async function restoreVersion(')
// The single usePlayer() destructure — everything this page is allowed to take
// from the shared engine, and (just as importantly) everything it is not.
const playerHook = src.split('\n').find(l => l.includes('= usePlayer()')) ?? ''

// ── A. The regions exist ─────────────────────────────────────────────────────
// Every extractor returns '' when it cannot balance its region, which would make
// each "does NOT contain" check below vacuously true. Nothing else runs honestly
// until these pass.
console.log('regions located\n')

check(
  'the version-history modal block was located',
  modal.length > 0 && modal.includes('Version History'),
  `${modal.length} chars`,
)
check(
  'the per-archived-row render block was located',
  row.length > 0 && row.includes('<MasterCheck'),
  `${row.length} chars`,
)
check(
  'closeArchived() was located',
  closeFn.length > 0,
  `${closeFn.length} chars`,
)
check(
  'restoreVersion() was located',
  restoreFn.length > 0 && restoreFn.includes("fetch('/api/versions'"),
  `${restoreFn.length} chars`,
)
check(
  'the usePlayer() destructure was located',
  playerHook.includes('usePlayer()') && playerHook.includes('playUrl'),
  playerHook.trim().slice(0, 60),
)

// ── B. Each archived row can actually be played ──────────────────────────────
// The gap this feature closes: before it, hearing an old mix meant restoring it
// (which rewrites the version history) or downloading the file.
console.log('\nper-row playback\n')

check(
  'each row renders a play/pause control driven by the engine state',
  /\{avPlaying \? <Pause[^>]*\/> : <Play[^>]*\/>\}/.test(row),
)
check(
  'tapping an idle row starts THAT mix on the shared engine',
  /else playUrl\(avUrl,/.test(row),
)
check(
  'tapping the playing row toggles the shared engine, not a second source',
  /if \(avActive\) togglePlay\(\)/.test(row),
)
check(
  'the control is a comfortable phone tap target (≥36px)',
  /className="flex-shrink-0 w-(9|10|11|12|14) h-(9|10|11|12|14) /.test(row),
  (row.match(/className="flex-shrink-0 w-\d+ h-\d+/) ?? ['none'])[0],
)
check(
  'the control is labelled, and the label follows the play state',
  row.includes('aria-label={avPlaying ?'),
)

// ── C. audioProxyUrl(), never a raw Supabase URL ─────────────────────────────
// AGENTS.md: every <audio> source in this app goes through /api/audio. A raw
// Supabase URL is the silent failure — it plays, but seeking and duration break,
// and it can never match `currentUrl`.
console.log('\nproxied audio URLs\n')

check(
  'the row derives its audio URL through audioProxyUrl()',
  /const avUrl = audioProxyUrl\(av\.audio_url\)/.test(row),
)
check(
  'and that is the URL handed to playUrl()',
  /playUrl\(avUrl,/.test(row),
)
{
  // Every mention of the stored column in the row must sit directly inside an
  // audioProxyUrl( call — covers playback, the download link and MasterCheck at
  // once, so none of them can quietly regress to the raw URL.
  const before = row.split('av.audio_url').slice(0, -1)
  check(
    'no raw av.audio_url escapes unwrapped anywhere in the row',
    before.length > 0 && before.every(s => s.endsWith('audioProxyUrl(')),
    `${before.length} use(s)`,
  )
}
check(
  'no Supabase host is reached for directly anywhere in the modal',
  !/supabase/i.test(modal),
)
check(
  '"which row is playing" compares the PROXIED url against the engine',
  /const avActive = currentUrl === avUrl/.test(row),
)

// ── D. Web Audio is never touched from this page ─────────────────────────────
// ensureAudioChain()/createMediaElementSource() are dead code in PlayerContext
// and must stay that way: the call is irreversible for the page session and its
// failure mode is silence across the whole app.
console.log('\nweb audio stays shut\n')

check(
  'createMediaElementSource is never called from this page',
  !/createMediaElementSource/.test(src),
)
check(
  'ensureAudioChain is never called from this page',
  !/ensureAudioChain/.test(src),
)
check(
  '…and is not even pulled out of usePlayer(), where a later edit could reach it',
  !/ensureAudioChain|setEQGains/.test(playerHook),
  playerHook.trim().slice(0, 90),
)
check(
  'the modal builds no AudioContext of its own',
  !/new AudioContext/.test(modal),
)

// ── E. One shared element, one source of truth ───────────────────────────────
// A local <audio>, or per-row React state mirroring "playing", is how two mixes
// end up audible at once and how a row ends up lying about its state.
console.log('\none shared audio element\n')

check(
  'the modal constructs no Audio() of its own',
  !/new Audio\(/.test(modal),
)
check(
  'the modal renders no <audio> element of its own',
  !/<audio/i.test(modal),
)
check(
  'the modal keeps no local playing state that could drift from the engine',
  !/useState|useRef/.test(modal),
)
check(
  'nothing sets audio.volume (a documented no-op on iOS Safari)',
  !/\.volume\s*=/.test(modal),
)
check(
  'playUrl, togglePlay and pause all come from the shared engine',
  /playUrl/.test(playerHook) && /togglePlay/.test(playerHook) && /\bpause\b/.test(playerHook),
)

// ── F. Dismissing the modal stops what it started ────────────────────────────
console.log('\nclosing the modal stops playback\n')

check(
  'closeArchived() pauses the shared engine',
  /pause\(\)/.test(closeFn),
)
{
  const pauseLine = closeFn.split('\n').find(l => l.includes('pause()')) ?? ''
  check(
    '…only when an ARCHIVED mix is what is playing',
    pauseLine.includes('archivedVersions.some(') && pauseLine.includes('=== currentUrl'),
    pauseLine.trim().slice(0, 100),
  )
  check(
    '…so a user already playing the CURRENT mix is left alone',
    /audioProxyUrl\(av\.audio_url\) === currentUrl/.test(pauseLine),
  )
}
{
  // The structural half: if the modal could be closed without going through
  // closeArchived, the stop above would simply be skipped on that path.
  const closes = src.split('setArchivedOpen(false)').length - 1
  check(
    'setArchivedOpen(false) exists exactly once in the file',
    closes === 1,
    `${closes} occurrence(s)`,
  )
  check(
    '…and that one occurrence is inside closeArchived()',
    closeFn.includes('setArchivedOpen(false)'),
  )
}
check(
  'the backdrop closes through closeArchived()',
  /e\.target === e\.currentTarget\) closeArchived\(\)/.test(modal),
)
check(
  'the X button closes through closeArchived()',
  /onClick=\{\(\) => closeArchived\(\)\}/.test(modal),
)
check(
  'Restore closes through closeArchived()',
  /closeArchived\(\)/.test(restoreFn),
)

// ── G. The playing row is obvious ────────────────────────────────────────────
console.log('\nthe playing row is obvious\n')

{
  // The whole `style={avActive ? … : …}` expression, sliced as a balanced block
  // rather than a character window — the two branches are what distinguish the
  // playing row from the rest.
  const rowStyle = bracketedBlock(row, 'style={avActive')
  check(
    'the active row is marked with the teal accent, not only an icon swap',
    rowStyle.length > 0 && rowStyle.includes('#2dd4bf'),
    `${rowStyle.length} chars`,
  )
}
check(
  'the active row states whether it is playing or paused',
  /\{isPlaying \? 'Playing' : 'Paused'\}/.test(row),
)

console.log(failures === 0 ? '\nall archived-playback checks passed' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
