// Duration probing at upload time — src/lib/audio-duration.ts
//
// This suite exists because `duration_seconds` is written ONCE and nothing in
// the app can correct it afterwards, so every way the probe can return a wrong
// or absent number is a permanent data defect. 157 of 406 production rows are
// already null.
//
// It imports the REAL module rather than re-deriving its rules, so a change to
// the shipped predicate is what fails here — not a copy of it agreeing with
// itself. (Exactly the trap the UGC heal fell into: a guard tested only against
// a payload the test author invented.)

import { readAudioDuration, normalizeDuration, DURATION_PROBE_TIMEOUT_MS } from '../src/lib/audio-duration.ts'

let pass = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass++; return }
  failures.push(detail ? `${name} — ${detail}` : name)
}

// ── normalizeDuration ───────────────────────────────────────────────────────
// The two values an <audio> element actually produces on failure. Both must
// become an explicit null: NaN before metadata parses, Infinity for a source
// whose length the browser cannot determine.
check('NaN → null', normalizeDuration(NaN) === null)
check('Infinity → null', normalizeDuration(Infinity) === null)
check('-Infinity → null', normalizeDuration(-Infinity) === null)
check('0 → null (a zero-length mix is a failed probe, not an empty song)',
  normalizeDuration(0) === null)
check('negative → null', normalizeDuration(-5) === null)

check('rounds to whole seconds', normalizeDuration(201.4) === 201)
check('rounds half up', normalizeDuration(201.5) === 202)
check('sub-second but positive still rounds to 1, not 0',
  normalizeDuration(0.6) === 1)
// 0.4 rounds to 0, which the > 0 rule then rejects. Correct: a mix that rounds
// to zero seconds is not a length worth storing forever.
check('0.4 → null (rounds to 0, which is not a storable length)',
  normalizeDuration(0.4) === null)
check('a real mix length survives unchanged', normalizeDuration(203) === 203)

// Rounding must happen BEFORE the finite test, or a value that rounds into
// non-finiteness could slip through. Guard the ordering explicitly.
check('normalizeDuration returns a number or null, never NaN',
  [NaN, Infinity, 0, 1.2, 300].every(v => {
    const r = normalizeDuration(v)
    return r === null || (Number.isInteger(r) && r > 0)
  }))

// ── readAudioDuration ───────────────────────────────────────────────────────
// The probe needs a DOM (Audio, URL.createObjectURL). Under plain node there is
// none, and the contract is that it degrades to null rather than throwing — a
// mix whose length could not be read must still upload.
// Node has URL.createObjectURL but no Audio — the probe needs BOTH.
const hasDom = typeof Audio === 'function' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
check('the timeout is exported so callers cannot invent their own',
  DURATION_PROBE_TIMEOUT_MS === 8000)

if (!hasDom) {
  const result = await readAudioDuration(new Blob([new Uint8Array([0, 1, 2])]))
  check('outside a browser it resolves null instead of throwing', result === null)
} else {
  // A blob that is not decodable audio must resolve null via the error path,
  // and must not hang past the timeout.
  const started = Date.now()
  const result = await readAudioDuration(new Blob([new Uint8Array([0, 1, 2])]), 1500)
  check('undecodable blob → null', result === null)
  check('undecodable blob does not hang past its timeout',
    Date.now() - started < 4000, `took ${Date.now() - started}ms`)
}

// ── the regression this fix is for ──────────────────────────────────────────
// Both web upload paths used to point an <audio> at the object they had just
// uploaded, read back through /api/audio. Assert the source no longer does, so
// nobody reintroduces the network dependency while "cleaning up".
import { readFileSync } from 'node:fs'
for (const file of [
  'src/app/projects/[id]/ProjectClient.tsx',
  'src/app/projects/new/NewProjectForm.tsx',
]) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  check(`${file} probes duration from the local file`,
    src.includes('readAudioDuration('),
    'the shared local-file probe is what keeps web and iOS agreeing')
  check(`${file} no longer probes the uploaded URL for duration`,
    !/new Audio\(audioProxyUrl\(/.test(src),
    'probing the just-uploaded object depends on read-back, Content-Length and a timeout race — all of which mint permanent nulls')
}

console.log(`audio-duration-test: ${pass} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
