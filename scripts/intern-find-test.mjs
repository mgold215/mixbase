#!/usr/bin/env node
// The mixing intern's helper: which Logic project is a song's, and what its
// upload is called. Pure checks: no Mac, no Logic, no network.
//
// Run: node scripts/intern-find-test.mjs  (part of `npm test`)
import { readFileSync } from 'node:fs'
import { internNames, nameKey, pickProject } from './intern-find.mjs'
import { parseVersionName } from '../src/lib/mix-status.ts'
import { readNumber, stripIndexFor, trackOfFile } from './intern-logic.mjs'

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

console.log('intern: finding the Logic project\n')
check('a filename and a title come down to the same key', nameKey('EVERGREEN - MIX 2.wav') === 'evergreen' && nameKey('Evergreen') === 'evergreen', nameKey('EVERGREEN - MIX 2.wav'))
check('the take is dropped, the song is kept', nameKey('Night Drive master3 FINAL.aif') === 'night drive' && nameKey('Mixed Feelings v2.logicx') === 'mixed feelings')

const P = (path, mtimeMs = 1) => ({ path, mtimeMs })
const projects = [P('/m/Logic/Evergreen.logicx', 5), P('/m/Logic/Evergreen Fields.logicx', 9), P('/m/Logic/Catalyst.logicx', 7), P('/m/Old/EVERGREEN.logicx', 2)]
check('the exact name wins over a longer one, the newer save over the older',
  pickProject(['EVERGREEN'], projects).path === '/m/Logic/Evergreen.logicx')
check('a song renamed in mixBASE is found by its old filename',
  pickProject(['EVERGREEN', 'EVERGREEN - MIX 2.wav', 'CORRIDOR - MIX 1.wav'], [P('/m/Corridor.logicx'), P('/m/Catalyst.logicx')]).path === '/m/Corridor.logicx')
check('a project named with the take still matches', pickProject(['Evergreen'], [P('/m/EVERGREEN v3 mix.logicx')]).path === '/m/EVERGREEN v3 mix.logicx')
check('part of a word is not a match', !!pickProject(['Ever'], [P('/m/Evergreen.logicx')]).error)
const none = pickProject(['Evergreen'], [P('/m/Catalyst.logicx')])
check('no match is an error the owner can read, never a guess', /Could not find a Logic project for "Evergreen"/.test(none.error ?? '') && !none.path)

console.log('\nintern: the upload\'s name\n')
const names = internNames({ title: 'EVERGREEN', version_label: 'MIX 2', audio_filename: 'EVERGREEN - MIX 2.wav' })
check('the new version is marked as the intern\'s', names.label === 'MIX 2 (intern)' && names.filename === 'EVERGREEN - MIX 2 (intern).wav', JSON.stringify(names))
check('…and still reads as the mix it came from, so the owner\'s next mix keeps its number',
  parseVersionName(names.label)?.label === 'MIX 2' && parseVersionName(names.filename)?.label === 'MIX 2')
check('a fix of a fix is not marked twice', internNames({ version_label: names.label, audio_filename: names.filename }).label === 'MIX 2 (intern)')

console.log('\nintern: reading Logic\n')
check('a control\'s readout becomes a number', readNumber('-2.4 dB') === -2.4 && readNumber('+0.50 dB') === 0.5 && readNumber('−3.0 dB') === -3 && readNumber('1040 Hz') === 1040 && readNumber('0.60') === 0.6 && readNumber('Auto') === null)
check('an exported file names its track, with or without the project in front',
  trackOfFile('SUB.wav', 'CATALYST (intern)') === 'SUB' && trackOfFile('CATALYST (intern) - SYNTH BASS.wav', 'CATALYST (intern)') === 'SYNTH BASS')
const mixerNames = ['KICK', 'HOOK', 'SUB', 'HOOK', 'HOOK', 'Take_2']
check('a track finds its channel strip by name', stripIndexFor('SUB', mixerNames) === 2 && stripIndexFor('NOPE', mixerNames) === -1)
check('a repeated name is told apart by Logic\'s number, in mixer order', stripIndexFor('HOOK', mixerNames) === 1 && stripIndexFor('HOOK_1', mixerNames) === 3 && stripIndexFor('HOOK_2', mixerNames) === 4)
check('…and a track that is really called that is not mistaken for one', stripIndexFor('Take_2', mixerNames) === 5 && stripIndexFor('SUB_1', mixerNames) === -1)

console.log('\nintern: the helper\'s promises\n')
const logic = read('scripts/intern-logic.mjs')
check('Logic is never sent a typed key or a click by position', !/sys\.(key|type|click)/.test(logic))
check('the intern only adds its own plug-ins, last in the strip, and never bypasses or removes one',
  /empty\[0\]/.test(logic) && !/desc === 'bypass'|Remove|No Plug-in/.test(logic))
check('the owner\'s open project is never answered for: unsaved changes stop the job', /unsaved changes\. Save or close it/.test(logic) && !/title: 'Save'/.test(logic))
check('what Logic wrote beside the owner\'s files is only removed if it is the intern\'s own folder', /startsWith\('mixBASE Intern '\) \|\| !dir\.endsWith\('\.nosync'\)/.test(logic))
const worker = read('scripts/intern-worker.mjs')
const logic0 = read('scripts/intern-logic.mjs')
const ax = read('macos/MixbaseIntern/Sources/AX.swift')
const server = read('macos/MixbaseIntern/Sources/Server.swift')
check('the worker opens the COPY, never the project it found', /await logic\.open\(copy\)/.test(worker) && !/logic\.open\(found\.path\)/.test(worker))
check('it tells the server which version it uploaded before Mix Check runs on it',
  worker.indexOf('result_version_id: versionId') > 0 && worker.indexOf('result_version_id: versionId') < worker.indexOf('await serverCheck(versionId'))
check('a fix that does not hold is taken back', /api\(`\/api\/versions\/\$\{versionId\}`, \{ method: 'DELETE' \}\)/.test(worker))
check('nothing is uploaded before the local judge keeps the bounce', worker.indexOf('if (!verdict.keep)') < worker.indexOf('await upload(song, bounce)'))
check('a fix is judged against the project\'s own untouched bounce: a note it already had is not one the fix brought',
  /const had = \[\.\.\.\(song\.findings \?\? \[\]\), \.\.\.judge0\.findings/.test(worker) && /judge\(\{ job: now, bounce, handled: open/.test(worker) && /judgeFix\(had, checked\.findings/.test(worker))
check('a project that no longer shows the notes is left alone', /no longer shows these notes/.test(worker))
check('a bounce that is not the handed mix is never uploaded as a fix of it', /does not bounce to \$\{song\.version_label\}/.test(worker) && worker.indexOf('does not bounce to') < worker.indexOf('await upload(song, bounce)'))
check('…but first it is tried with the muted tracks on, and the owner is told what was unmuted',
  /await logic\.setMuted\(muted, false\)/.test(worker) && /else await logic\.setMuted\(muted, true\)/.test(worker) && /Unmuted for the bounce/.test(worker))
check('a mute is confirmed by reading the mixer again after the press', /const after = \(await switches\(\)\)\[want\.index\]/.test(logic0) && /could not be \$\{on \? 'muted' : 'unmuted'\}/.test(logic0))
check('a locked Mac is waited for, in words, never worked around', /Waiting for your Mac to be unlocked/.test(worker) && !/password/i.test(worker.replace(/\/\*\*[\s\S]*?\*\//g, '')))
check('folders made beside the owner\'s files are written down first and only the intern\'s own are removed',
  /onFolder: rememberLeftover/.test(worker) && /const isOurs = path => \/\^mixBASE Intern/.test(worker) && /if \(typeof path !== 'string' \|\| !isOurs\(path\)\) continue/.test(worker))
check('no AI and nothing billed per use', !/anthropic|openai|replicate|runway/i.test(worker + read('scripts/intern-find.mjs') + read('scripts/intern-plan.mjs')))
check('the helper only ever addresses Logic Pro', /static let logicBundleId = "com\.apple\.logic10"/.test(ax) && (ax.match(/AXUIElementCreateSystemWide/g) ?? []).length === 1 && /AXUIElementSetMessagingTimeout\(AXUIElementCreateSystemWide\(\), 6\)/.test(ax) && !/runningApplications\(withBundleIdentifier: (?!Self\.logicBundleId)/.test(ax))
check('the local socket never hands out the access token', /answer\(line, allowAuth: false\)/.test(server) && /guard allowAuth else/.test(ax))
check('no personal paths or addresses in the helper', !/\/Users\/|@(gmail|icloud|me)\./.test(ax + server + worker + read('macos/MixbaseIntern/install.sh') + read('macos/MixbaseIntern/build.sh')))

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
