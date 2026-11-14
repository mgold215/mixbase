#!/usr/bin/env node
// Contract test: every pop-up (sheet) in the app can be closed on the Mac.
//
// The Mac app is the iPhone app's own source (ios/mixBase). On iPhone a sheet
// closes with a swipe and may keep its Done button in the navigation bar. A
// Mac sheet has neither: no swipe, no navigation bar. It draws ONLY toolbar
// items placed as .cancellationAction / .confirmationAction (at its foot);
// one placed .navigationBarTrailing is silently not drawn, and the sheet
// cannot be left. The owner, 2026-11-14: "i cant x out of the image editor on
// macos app" (the cover viewer's Done sat in .navigationBarTrailing; the
// Visualizer opened from the Artwork library and the Terms page on sign-up
// had no close control at all).
//
// So: for every .sheet(…) / .fullScreenCover(…) (a sheet on the Mac, see
// macos/MixbaseApp/PlatformCompat.swift), either the presenting closure or
// the view it presents must carry a .cancellationAction or .confirmationAction
// toolbar item, or be listed below with the reason it closes another way.
//
// Fail-first witness (RUN and confirmed): putting CoverViewerView's Done back
// in .navigationBarTrailing fails this suite.
//
// Run: node scripts/macos-sheet-close-test.mjs  (also part of `npm test`)

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('../ios/mixBase/', import.meta.url).pathname

/** Sheets that close some other way, each with why that way also works on the Mac. */
const CLOSES_ANOTHER_WAY = {
  SignUpView: 'its own "Sign in" button dismisses it, and it dismisses itself on success',
}

function swiftFiles(dir) {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? swiftFiles(p) : name.endsWith('.swift') ? [p] : []
  })
}

const files = swiftFiles(ROOT).map(path => ({ path, rel: relative(ROOT, path), text: readFileSync(path, 'utf8') }))

// struct name → its source, up to the next top-level declaration.
const structs = new Map()
for (const f of files) {
  const starts = [...f.text.matchAll(/^(?:(?:private|fileprivate|public|final) )*(?:struct|class|enum|extension) (\w+)/gm)]
  starts.forEach((m, i) => {
    const body = f.text.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : f.text.length)
    if (!structs.has(m[1])) structs.set(m[1], body)
  })
}

const CLOSABLE = /placement:\s*\.(cancellationAction|confirmationAction)\b/

/** The trailing closure of the call that starts at `from`: the text between its braces. */
function closureAt(text, from) {
  // Past the call's own argument list first.
  let i = text.indexOf('(', from), depth = 0
  for (; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) break
  }
  const open = text.indexOf('{', i)
  if (open < 0) return ''
  depth = 0
  for (let j = open; j < text.length; j++) {
    if (text[j] === '{') depth++
    else if (text[j] === '}' && --depth === 0) return text.slice(open + 1, j)
  }
  return text.slice(open + 1)
}

let failures = 0, seen = 0
const used = new Set()
for (const f of files) {
  for (const m of f.text.matchAll(/\.(sheet|fullScreenCover)\(/g)) {
    seen++
    const line = f.text.slice(0, m.index).split('\n').length
    const closure = closureAt(f.text, m.index)
    if (CLOSABLE.test(closure)) continue
    // Every app view the closure builds; one that can close the sheet is enough.
    // Built with arguments, `Name(…)`, or with a trailing closure alone, `Name { … }`.
    const views = [...closure.matchAll(/\b([A-Z]\w+)\s*[({]/g)].map(v => v[1]).filter(n => structs.has(n))
    const exempt = views.find(n => Object.hasOwn(CLOSES_ANOTHER_WAY, n))
    if (exempt) { used.add(exempt); continue }
    if (views.some(n => CLOSABLE.test(structs.get(n)))) continue
    console.error(`  ✗ ${f.rel}:${line} — this ${m[1]} cannot be closed on the Mac: ${views[0] ?? 'its content'} has no .cancellationAction / .confirmationAction toolbar item`)
    failures++
  }
}

console.log(`  ${seen} sheets checked`)
if (seen < 15) { console.error(`  ✗ only ${seen} sheets found: the scan is not reading the app`); failures++ }
for (const name of Object.keys(CLOSES_ANOTHER_WAY)) {
  if (!used.has(name)) { console.error(`  ✗ ${name} is listed as closing another way but no sheet presents it any more: remove it from the list`); failures++ }
}

if (failures) { console.error(`\n${failures} macos-sheet-close check(s) failed`); process.exit(1) }
console.log('  ✓ every sheet has a close control the Mac draws')
console.log('\nall macos-sheet-close checks passed')
