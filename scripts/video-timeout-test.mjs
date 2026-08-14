// Video render watchdog test — exercises the REAL production modules
// (src/lib/video-render.ts + src/lib/video-job-policy.ts via Node type
// stripping), no inline copies.
//
// Run: node scripts/video-timeout-test.mjs
//
// Before this, every ffmpeg/ffprobe child in the render pipeline was spawned
// with no deadline. A wedged child meant the render promise NEVER settled, so
// buildFinalVideo's `finally` never ran (temp dir leaked, child leaked) and the
// job held one of only MAX_CONCURRENT=2 GLOBAL slots — two stuck renders 503'd
// video export for every user on the box. This asserts:
//
//  1. the stage budget + idle calculators are sane, bounded and ordered
//  2. shouldReapJob never reaps an in-flight job early (doing so frees the slot
//     while ffmpeg is still running, which lets real renders exceed the cap)
//  3. truncation markers are recognised, and a healthy file produces none
//  4. REAL: a truncated recording is REJECTED instead of silently yielding a
//     full-length video built from a fragment, and the temp dir is cleaned up
//  5. REAL: a genuinely wedged ffprobe (a FIFO with no writer, which blocks in
//     open() forever and only dies to SIGKILL) makes probeDuration REJECT in
//     bounded time rather than hang, and leaves no surviving child process

import { spawn } from 'child_process'
import { mkdtemp, rm, readFile, writeFile, readdir } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join, relative } from 'path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'http'
import { createRequire } from 'module'
import {
  videoStageTimeoutMs,
  videoStageIdleMs,
  hasTruncationMarker,
  probeDuration,
  buildFinalVideo,
  MAX_SONG_SECONDS,
} from '../src/lib/video-render.ts'
import { shouldReapJob, JOB_TTL_MS, STUCK_JOB_MS, UPLOAD_PHASE_MS } from '../src/lib/video-job-policy.ts'

const require = createRequire(import.meta.url)
const FFMPEG = require('@ffmpeg-installer/ffmpeg').path
// Repo root, derived from this file rather than cwd — the spawn-site walk below
// must find the same source tree whether run by hand or by run-renderer-tests.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function runToFile(bin, args, dest) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    let err = ''
    p.stdout.on('data', d => chunks.push(d))
    p.stderr.on('data', d => { err = (err + d).slice(-3000) })
    p.on('close', async c => {
      if (c !== 0) return reject(new Error(err.slice(-500)))
      await writeFile(dest, Buffer.concat(chunks))
      resolve()
    })
  })
}

const STAGES = ['probe', 'measure', 'loop', 'final']

// ── 1. Stage budgets ────────────────────────────────────────────────────────
console.log('\n— stage budgets —')

for (const stage of STAGES) {
  const at0 = videoStageTimeoutMs(stage, 0)
  check(`${stage}: positive & finite at zero work`, Number.isFinite(at0) && at0 > 0, `${at0}ms`)
  // Hostile inputs must never produce NaN/Infinity — a NaN setTimeout delay
  // fires immediately, which would kill every render instantly.
  for (const bad of [NaN, -1, -Infinity, Infinity, undefined]) {
    const v = videoStageTimeoutMs(stage, bad)
    check(`${stage}: bounded for ${String(bad)}`, Number.isFinite(v) && v > 0, `${v}ms`)
  }
  // Monotonic non-decreasing in work.
  let prev = 0
  let mono = true
  for (const w of [0, 1, 10, 60, 300, 720, 5000, 1e9]) {
    const v = videoStageTimeoutMs(stage, w)
    if (v < prev) mono = false
    prev = v
  }
  check(`${stage}: non-decreasing in work seconds`, mono)
}

// A probe reads a header; the full encode processes the whole song. If those
// ever invert, the cheap stage is the one being given minutes.
check(
  'probe budget is the tightest stage',
  videoStageTimeoutMs('probe', MAX_SONG_SECONDS) < videoStageTimeoutMs('measure', 0) &&
  videoStageTimeoutMs('probe', MAX_SONG_SECONDS) < videoStageTimeoutMs('final', 0),
  `${videoStageTimeoutMs('probe', MAX_SONG_SECONDS)}ms`,
)
check(
  'final budget for the longest allowed song exceeds the loop budget',
  videoStageTimeoutMs('final', MAX_SONG_SECONDS) > videoStageTimeoutMs('loop', 30),
  `${videoStageTimeoutMs('final', MAX_SONG_SECONDS)}ms vs ${videoStageTimeoutMs('loop', 30)}ms`,
)
// The whole point is bounding a hang: no budget may be effectively infinite.
const worstCase = videoStageTimeoutMs('final', 1e9)
check('every budget is capped well under an hour and a half', worstCase <= 90 * 60_000, `${worstCase}ms`)
// A 12-minute song at 1080p must not be killed mid-encode: the budget has to
// clear a pessimistic (10x realtime) Railway encode.
check(
  'longest allowed song gets >= 10x realtime to encode',
  videoStageTimeoutMs('final', MAX_SONG_SECONDS) >= MAX_SONG_SECONDS * 1000 * 5,
  `${(videoStageTimeoutMs('final', MAX_SONG_SECONDS) / 1000 / 60).toFixed(1)}min for a ${MAX_SONG_SECONDS / 60}min song`,
)

console.log('\n— idle budgets —')
check('probe has no idle budget (it streams no progress)', videoStageIdleMs('probe') === 0)
for (const stage of ['measure', 'loop', 'final']) {
  const idle = videoStageIdleMs(stage)
  check(`${stage}: idle budget positive & finite`, Number.isFinite(idle) && idle > 0, `${idle}ms`)
  // Idle is meant to be the PRIMARY detector, so it must never exceed the
  // wall-clock ceiling for a realistic workload (or it could never fire).
  check(
    `${stage}: idle <= wall-clock ceiling`,
    idle <= videoStageTimeoutMs(stage, MAX_SONG_SECONDS),
  )
  // Must tolerate a big slowdown between progress blocks (ffmpeg emits one per
  // ~1s of output) so a slow-but-advancing encode is never killed.
  check(`${stage}: idle tolerates a >=60x stall between progress blocks`, idle >= 60_000, `${idle / 1000}s`)
}

// ── 2. Reap policy ──────────────────────────────────────────────────────────
console.log('\n— reap policy —')

const at = (status, ageMs) => shouldReapJob({ status, createdAt: 0 }, ageMs)

check('finished job kept before its TTL', at('done', JOB_TTL_MS - 1) === false)
check('finished job reaped after its TTL', at('done', JOB_TTL_MS + 1) === true)
check('errored job reaped after its TTL', at('error', JOB_TTL_MS + 1) === true)

// The critical asymmetry: reaping a live job frees its GLOBAL concurrency slot
// and its per-user single-flight guard while ffmpeg is still running.
check('in-flight render NOT reaped at the finished TTL', at('rendering', JOB_TTL_MS + 1) === false)
check('uploading job NOT reaped at the finished TTL', at('uploading', JOB_TTL_MS + 1) === false)
check('in-flight render kept just before the stuck backstop', at('rendering', STUCK_JOB_MS - 1) === false)
check('in-flight render reaped after the stuck backstop', at('rendering', STUCK_JOB_MS + 1) === true)
check('uploading job reaped after the stuck backstop', at('uploading', STUCK_JOB_MS + 1) === true)
check('brand-new job is never reaped', at('rendering', 0) === false && at('done', 0) === false)
check('stuck backstop is longer than the finished TTL', STUCK_JOB_MS > JOB_TTL_MS)
// The backstop must sit above the slowest render the budgets permit, or it
// would reap jobs that are still legitimately working.
check(
  'stuck backstop exceeds the worst-case render budget',
  STUCK_JOB_MS > videoStageTimeoutMs('final', MAX_SONG_SECONDS) + videoStageTimeoutMs('loop', 60),
  `${STUCK_JOB_MS / 60000}min backstop`,
)

// Behaviour parity with the pre-refactor inline expression, swept across the
// whole state space — the extraction must not have changed any decision.
let parity = true
for (const status of ['rendering', 'uploading', 'done', 'error']) {
  for (const age of [0, 1, JOB_TTL_MS - 1, JOB_TTL_MS, JOB_TTL_MS + 1, 3 * JOB_TTL_MS,
    STUCK_JOB_MS - 1, STUCK_JOB_MS, STUCK_JOB_MS + 1, 99 * JOB_TTL_MS]) {
    const finished = status === 'done' || status === 'error'
    const legacy = (finished && age > JOB_TTL_MS) || age > 6 * JOB_TTL_MS
    if (shouldReapJob({ status, createdAt: 0 }, age) !== legacy) parity = false
  }
}
check('matches the original inline retention rule across the state space', parity)

// ── 3. Truncation markers ───────────────────────────────────────────────────
console.log('\n— truncation markers —')

check('detects the real ffmpeg webm truncation warning',
  hasTruncationMarker('[matroska,webm @ 0x13480e800] File ended prematurely') === true)
// A healthy decode prints NOTHING at -v error. If empty stderr ever matched,
// every render would fail.
check('empty stderr is not a truncation', hasTruncationMarker('') === false)
check('benign stderr is not a truncation',
  hasTruncationMarker('[libx264 @ 0x1] using cpu capabilities: ARMv8 NEON') === false)

// REGRESSION GUARD. These two are DECODE-level: ffmpeg logs them, keeps going,
// and exits 0. A healthy MP3 with a few trailing NUL bytes emits them while
// decoding identical audio, so matching them rejected WORKING renders — and only
// full-length ones, because Shorts stop before EOF. Do not re-add them.
check('decode-level "Invalid data found" is NOT treated as truncation',
  hasTruncationMarker('Error while decoding stream #0:0: Invalid data found when processing input') === false)
check('decode-level "Error while decoding stream" is NOT treated as truncation',
  hasTruncationMarker('Error while decoding stream #1:0: some codec grumble') === false)

// ── Invariant: the reap policy has ONE definition ───────────────────────────
// The checks above import video-job-policy.ts, but the code that actually runs
// lives in video-jobs.ts. If that file kept its own copy of the predicate, this
// suite would be green while the live rule silently diverged.
console.log('\n— invariant: reap policy is single-sourced —')
{
  const jobsSrc = await readFile('src/lib/video-jobs.ts', 'utf8')
  check('video-jobs.ts imports the shared policy',
    /import\s*\{[^}]*shouldReapJob[^}]*\}\s*from\s*['"]\.\/video-job-policy\.ts['"]/.test(jobsSrc))
  check('video-jobs.ts does NOT redefine the predicate',
    !/function\s+shouldReapJob/.test(jobsSrc))
  check('video-jobs.ts does NOT redefine the retention constants',
    !/const\s+(JOB_TTL_MS|STUCK_JOB_MS)\s*=/.test(jobsSrc))
  check('video-jobs.ts actually uses it to prune', /shouldReapJob\s*\(/.test(jobsSrc))
}

// ── Invariant: the UPLOAD phase is bounded too ──────────────────────────────
// Every ffmpeg stage settles under its own deadline, but the phase AFTER the
// render had none: ensureVideoBucketLimit() is a Management-API fetch with no
// signal and storeVisualizer() pushes up to ~380 MB to Supabase. A job parked
// in 'uploading' still counts toward activeCount() (a global MAX_CONCURRENT
// slot) AND activeJobForUser() (the per-user single-flight), so one hung socket
// 409s that user with `user_busy` and taxes everyone else until STUCK_JOB_MS
// reaps it SIX HOURS later. Bounding the render but not the upload just moves
// where the wedge happens.
console.log('\n— invariant: the post-render upload phase settles —')
{
  const jobsSrc = await readFile('src/lib/video-jobs.ts', 'utf8')
  const policySrc = await readFile('src/lib/video-job-policy.ts', 'utf8')

  check('the policy module defines an upload-phase budget',
    /export const UPLOAD_PHASE_MS\s*=/.test(policySrc))
  check('video-jobs.ts imports it rather than inlining a number',
    /import\s*\{[^}]*UPLOAD_PHASE_MS[^}]*\}\s*from\s*['"]\.\/video-job-policy\.ts['"]/.test(jobsSrc))
  check('the upload phase is wrapped in a deadline',
    /withDeadline\s*\(/.test(jobsSrc) && /UPLOAD_PHASE_MS/.test(jobsSrc))
  check('the deadline rejects rather than resolving a bogus success',
    /reject\(new Error\(message\)\)/.test(jobsSrc))
  check('the deadline timer is cleared so it cannot leak',
    /clearTimeout\(timer\)/.test(jobsSrc))
  check('the pending timer is unref\'d so it cannot hold the process open',
    /timer\.unref\?\.\(\)/.test(jobsSrc))

  // The budget must be generous enough for a real large upload but far inside
  // the 6-hour backstop, or it either kills good renders or fixes nothing.
  check('upload budget is longer than a minute and well under the stuck backstop',
    UPLOAD_PHASE_MS > 60_000 && UPLOAD_PHASE_MS < STUCK_JOB_MS / 4,
    `${UPLOAD_PHASE_MS / 60000}min vs ${STUCK_JOB_MS / 60000}min backstop`)

  // Witness: the pre-fix upload phase awaited storeVisualizer directly.
  const preFix = `
    if (built.bytes.length > 45 * 1024 * 1024) await ensureVideoBucketLimit()
    const stored = await storeVisualizer({ userId: args.userId })
  `
  check('witness: pre-fix upload phase had no deadline', !/withDeadline/.test(preFix))
}

// ── 4. Invariant: no unguarded spawn ────────────────────────────────────────
// A future fourth child process added without a deadline reintroduces the exact
// outage this change fixes, so assert on the real source. Comments are stripped
// first: a watchdog that survives only inside a comment must not pass.
console.log('\n— invariant: every spawn is armed —')

// Strip comments (outside string literals) so a watchdog that survives only
// inside a comment cannot pass.
function stripComments(raw) {
  let src = ''
  let i = 0
  let quote = null
  while (i < raw.length) {
    const c = raw[i], n = raw[i + 1]
    if (quote) {
      if (c === '\\') { src += c + (n ?? ''); i += 2; continue }
      if (c === quote) quote = null
      src += c; i++; continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; src += c; i++; continue }
    if (c === '/' && n === '/') { while (i < raw.length && raw[i] !== '\n') i++; continue }
    if (c === '/' && n === '*') { i += 2; while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++; i += 2; continue }
    src += c; i++
  }
  return src
}

// Extract each armDeadline call's argument list by balancing parentheses — the
// arguments span lines and contain nested calls, so a regex can't delimit them.
function armInvocations(src) {
  const out = []
  for (let at = src.indexOf('armDeadline('); at !== -1; at = src.indexOf('armDeadline(', at + 1)) {
    if (/function\s+$/.test(src.slice(Math.max(0, at - 12), at))) continue // the definition
    let depth = 0
    let i = src.indexOf('(', at)
    const from = i + 1
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')' && --depth === 0) break
    }
    out.push(src.slice(from, i))
  }
  return out
}

// EVERY module that spawns a child must be armed with a deadline — and the list
// of those modules is DERIVED, never enumerated.
//
// The enumeration is what kept failing. This invariant originally read one file
// (video-render.ts, where the watchdog then lived), so when the 2026-08-03
// WebM→MP4 transcode added a spawn site in a NEW module with a
// kill-but-never-reject timer, it shipped green. The fix at the time widened the
// list from one file to two — which closed that instance and left the mechanism
// intact: a fifth spawn in a sixth module would ship green today, for exactly
// the same reason. So walk src/ for spawn sites instead, and require the derived
// set to equal the set of modules that actually arm them. A new module cannot
// join the codebase unarmed without turning this red.

// `spawn(` but not `spawnSync(` / `respawn(` — the word boundary rules both out.
const SPAWN_RE = /\bspawn\s*\(/g

// Every watchdog invocation must hand over the REAL `reject`. A swallowing
// callback keeps the kill but never settles the promise — the original bug, and
// it survives every count-based check.
const passesReject = a => /(?:^|,)\s*reject\s*,?\s*$/.test(a.replace(/\s+/g, ' ').trim())
  || /,\s*reject\s*,/.test(a.replace(/\s+/g, ' '))

// Why a module is NOT armed, or null when it is. Comment-stripped source in.
function armingProblem(src) {
  const spawns = (src.match(SPAWN_RE) ?? []).length
  if (!/from\s+['"][^'"]*proc-deadline\.ts['"]/.test(src)) return 'does not import the shared watchdog'
  const invocations = armInvocations(src)
  if (invocations.length < spawns) return `${spawns} spawn site(s) but only ${invocations.length} armDeadline call(s)`
  const bad = invocations.filter(a => !passesReject(a))
  if (bad.length) return `armDeadline call swallows the rejection: …${bad[0].replace(/\s+/g, ' ').slice(-40)}`
  return null
}

async function walkTsFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walkTsFiles(full))
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

// Every module under `dir` with at least one live spawn site, found by walking.
async function findSpawnModules(dir, base = ROOT) {
  const found = []
  for (const abs of await walkTsFiles(dir)) {
    // Comments stripped first: a spawn that exists only inside a comment is not
    // a spawn, and a watchdog that survives only inside one must not pass.
    const src = stripComments(await readFile(abs, 'utf8'))
    const spawns = (src.match(SPAWN_RE) ?? []).length
    if (spawns > 0) found.push({ file: relative(base, abs), src, spawns })
  }
  return found
}

{
  const SPAWN_MODULES = await findSpawnModules(join(ROOT, 'src'))
  const unarmed = SPAWN_MODULES.filter(m => armingProblem(m.src) !== null)
  check('every src/ module that spawns a child arms it with a deadline',
    unarmed.length === 0,
    unarmed.length
      ? unarmed.map(m => `${m.file}: ${armingProblem(m.src)}`).join(' | ')
      : SPAWN_MODULES.map(m => m.file).join(', '))
  // The watchdog itself must REJECT, not merely kill: killing without settling
  // leaves the promise pending forever, which is the original bug.
  const arm = stripComments(await readFile('src/lib/proc-deadline.ts', 'utf8'))
  check('shared watchdog module defines armDeadline', /function armDeadline\s*\(/.test(arm))
  check('watchdog SIGKILLs the child', /kill\(\s*['"]SIGKILL['"]\s*\)/.test(arm))
  check('watchdog also rejects the promise (so cleanup can run)', /reject\(/.test(arm))
  check('watchdog handles exit separately from close', /on\(\s*['"]exit['"]/.test(arm))
  // `close` waits for the pipes to drain and a surviving descendant can withhold
  // it forever, so exiting must not leave the promise unguarded.
  check('exit path still bounds the wait for close', /drainTimer|never closed/.test(arm))

  let totalSpawns = 0
  for (const { file, src, spawns } of SPAWN_MODULES) {
    totalSpawns += spawns
    check(`${file}: imports the shared watchdog`,
      /from\s+['"][^'"]*proc-deadline\.ts['"]/.test(src))
    const invocations = armInvocations(src)
    check(`${file}: watchdog invoked at least once per spawn site`, invocations.length >= spawns,
      `${spawns} spawns, ${invocations.length} invocation(s)`)
    check(`${file}: every watchdog invocation passes the real reject callback`,
      invocations.length > 0 && invocations.every(passesReject),
      invocations.map(a => (passesReject(a) ? 'ok' : `BAD: ${a.replace(/\s+/g, ' ').slice(-40)}`)).join(' | '))
  }
  // Anti-tautology anchor, kept from the enumerated version: an empty walk (bad
  // path, renamed dir, a regex that stopped matching) would otherwise satisfy
  // "every spawning module is armed" with zero modules and pass silently.
  check('the walk is anchored to real code', totalSpawns >= 4,
    `${totalSpawns} spawn site(s) across ${SPAWN_MODULES.length} module(s)`)

  // ── Fail-first witness: point the SAME walker at unarmed fixtures ──────────
  // Both shapes that have actually shipped: a brand-new module that never heard
  // of the watchdog, and one that arms it with a callback that swallows the
  // rejection (kills the child, leaves the promise pending forever).
  const fixtureDir = await mkdtemp(join(tmpdir(), 'mb-spawn-fixture-'))
  try {
    await writeFile(join(fixtureDir, 'rogue.ts'),
      "import { spawn } from 'child_process'\n" +
      "export function encode() {\n" +
      "  return new Promise((resolve, reject) => {\n" +
      "    const proc = spawn('ffmpeg', ['-i', 'in.webm'])\n" +
      "    proc.on('close', () => resolve(null))\n" +
      "  })\n}\n")
    await writeFile(join(fixtureDir, 'swallower.ts'),
      "import { armDeadline } from './proc-deadline.ts'\n" +
      "import { spawn } from 'child_process'\n" +
      "export function encode() {\n" +
      "  return new Promise((resolve, reject) => {\n" +
      "    const proc = spawn('ffmpeg', ['-i', 'in.webm'])\n" +
      "    armDeadline(proc, 'final', 1000, () => {})\n" +
      "    proc.on('close', () => resolve(null))\n" +
      "  })\n}\n")
    const fixtures = await findSpawnModules(fixtureDir, fixtureDir)
    check('witness: the walker finds spawn sites in brand-new modules',
      fixtures.length === 2, fixtures.map(f => f.file).join(', '))
    const verdicts = Object.fromEntries(fixtures.map(f => [f.file, armingProblem(f.src)]))
    check('witness: an unarmed spawn is caught', !!verdicts['rogue.ts'], verdicts['rogue.ts'] ?? 'reported armed')
    check('witness: a watchdog that swallows the rejection is caught',
      !!verdicts['swallower.ts'], verdicts['swallower.ts'] ?? 'reported armed')
  } finally {
    await rm(fixtureDir, { recursive: true, force: true }).catch(() => {})
  }

  // The truncation guard must sit on the ENCODE path too, not only in the
  // duration-measure helper — the real-media checks below exercise `measure`,
  // so removing it from `run()` alone would otherwise go unnoticed.
  const renderSrc = stripComments(await readFile('src/lib/video-render.ts', 'utf8'))
  const runBody = renderSrc.slice(renderSrc.indexOf('function run('), renderSrc.indexOf('async function probeJson'))
  check('run() rejects truncated source media', /hasTruncationMarker\s*\(/.test(runBody))
  check('run() resets the idle timer on progress output', /touch\s*\(\s*\)/.test(runBody))
}

// ── Real-media checks ───────────────────────────────────────────────────────
const dir = await mkdtemp(join(tmpdir(), 'mb-timeout-test-'))
let server
try {
  // A MediaRecorder-shaped webm: muxed to a non-seekable pipe, so the container
  // carries no duration and probeDuration must fall back to decoding.
  const intact = join(dir, 'viz.webm')
  await runToFile(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=640x360:rate=30:duration=4', '-c:v', 'libvpx', '-f', 'webm', '-'], intact)
  const full = await readFile(intact)
  const truncated = join(dir, 'viz-truncated.webm')
  await writeFile(truncated, full.subarray(0, Math.floor(full.length / 5)))

  const audio = join(dir, 'audio.wav')
  await runToFile(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i',
    'sine=frequency=440:duration=20', '-f', 'wav', '-'], audio)

  console.log('\n— real media: truncation is rejected, healthy media still works —')

  // Regression guard: the duration-less-but-healthy webm the free visualizer
  // produces MUST still measure. If the truncation check were too broad, this
  // is what it would break.
  let intactDur = null
  try { intactDur = await probeDuration(intact, 'visualizer') } catch (e) { intactDur = e }
  check('healthy duration-less webm still measures',
    typeof intactDur === 'number' && Math.abs(intactDur - 4) < 0.5,
    typeof intactDur === 'number' ? `${intactDur.toFixed(2)}s` : String(intactDur))

  // HOW truncation is caught is build-dependent, so assert the OUTCOME and let
  // the mechanism vary. Newer demuxers print "File ended prematurely" on stderr
  // (ffmpeg 4.4); the older linux build @ffmpeg-installer ships for Railway is
  // silent for this fixture and the fragment simply measures too short for the
  // loop guard. Both are safe; asserting only the marker path made this test
  // pass on a Mac and fail on CI.
  const truncStderr = await new Promise(r => {
    const p = spawn(FFMPEG, ['-v', 'error', '-i', truncated, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] })
    let e = ''
    p.stderr.on('data', d => { e += d })
    p.on('close', () => r(e))
  })
  const buildReportsTruncation = hasTruncationMarker(truncStderr)

  let truncOutcome = null
  try {
    truncOutcome = { measured: await probeDuration(truncated, 'visualizer') }
  } catch (e) { truncOutcome = { error: e } }

  if (buildReportsTruncation) {
    check('truncated recording is rejected by the stderr marker',
      truncOutcome.error instanceof Error && /incomplete or corrupt/i.test(truncOutcome.error.message),
      truncOutcome.error ? truncOutcome.error.message.slice(0, 80) : `resolved ${truncOutcome.measured?.toFixed(2)}s`)
  } else {
    // No marker from this build — then it must be unusable by measurement, so the
    // loop guard rejects it. Either way it can never become a video.
    check('truncated recording is unusable even without a stderr marker (older ffmpeg build)',
      truncOutcome.error instanceof Error || truncOutcome.measured < 0.5,
      truncOutcome.error ? truncOutcome.error.message.slice(0, 60) : `measured ${truncOutcome.measured?.toFixed(2)}s < 0.5s guard`)
  }

  // The temp dir must be gone even on the failure path — that cleanup lives in a
  // `finally` that only runs if the render promise actually settles.
  const tmpBefore = (await readdir(tmpdir())).filter(n => n.startsWith('mb-video-')).length
  server = createServer((req, res) => {
    const map = { '/viz.webm': truncated, '/audio.wav': audio }
    const file = map[req.url ?? '']
    if (!file) { res.statusCode = 404; return res.end() }
    readFile(file).then(b => { res.setHeader('Content-Length', b.length); res.end(b) })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`

  let buildErr = null
  try {
    await buildFinalVideo({
      visualizerUrl: `${base}/viz.webm`,
      audioUrl: `${base}/audio.wav`,
      title: 'Truncated', artist: 'Test', format: 'shorts', clipSeconds: 15,
    })
    buildErr = 'resolved'
  } catch (e) { buildErr = e }
  check('a render on truncated input fails instead of shipping a fragment loop',
    buildErr instanceof Error, buildErr instanceof Error ? buildErr.message.slice(0, 90) : String(buildErr))

  const tmpAfter = (await readdir(tmpdir())).filter(n => n.startsWith('mb-video-')).length
  check('render temp dir is cleaned up on the failure path',
    tmpAfter <= tmpBefore, `${tmpBefore} -> ${tmpAfter}`)

  // ── The production case that a too-broad truncation check would break ─────
  // A healthy MP3 with trailing NUL padding (utterly common: encoders, tag
  // editors, DAW exports). ffmpeg exits 0 but prints a DECODE-level
  // "Invalid data found" while decoding the full, correct audio. Only the
  // full-length YouTube path decodes to EOF, so this is the render that broke.
  console.log('\n— real media: a healthy padded MP3 must still render —')
  const cleanMp3 = join(dir, 'clean.mp3')
  await runToFile(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i',
    'sine=frequency=440:duration=16', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', '-'], cleanMp3)
  const paddedMp3 = join(dir, 'padded.mp3')
  await writeFile(paddedMp3, Buffer.concat([await readFile(cleanMp3), Buffer.alloc(64, 0)]))

  // Confirm the fixture really does provoke the decode-level message, so this
  // test cannot silently stop covering the regression.
  const provoked = await new Promise(r => {
    const p = spawn(FFMPEG, ['-v', 'error', '-i', paddedMp3, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] })
    let e = ''
    p.stderr.on('data', d => { e += d })
    p.on('close', code => r({ code, e }))
  })
  check('fixture provokes a decode-level complaint at -v error (test stays meaningful)',
    provoked.code === 0 && /Invalid data found|Error while decoding/.test(provoked.e),
    `rc=${provoked.code} stderr=${provoked.e.trim().slice(0, 60)}`)

  const okServer = createServer((req, res) => {
    const map = { '/viz.webm': intact, '/padded.mp3': paddedMp3 }
    const file = map[req.url ?? '']
    if (!file) { res.statusCode = 404; return res.end() }
    readFile(file).then(b => { res.setHeader('Content-Length', b.length); res.end(b) })
  })
  await new Promise(r => okServer.listen(0, '127.0.0.1', r))
  const okBase = `http://127.0.0.1:${okServer.address().port}`
  let built = null
  try {
    built = await buildFinalVideo({
      visualizerUrl: `${okBase}/viz.webm`,
      audioUrl: `${okBase}/padded.mp3`,
      title: 'Padded', artist: 'Test', format: 'youtube',
    })
  } catch (e) { built = e } finally { await new Promise(r => okServer.close(r)) }
  check('full-length render succeeds on a healthy padded MP3',
    built && !(built instanceof Error) && built.width === 1920,
    built instanceof Error ? built.message.slice(0, 110) : `${built?.durationSec?.toFixed(1)}s ${built?.width}x${built?.height}`)

  // ── 5. A genuinely wedged child ──────────────────────────────────────────
  console.log('\n— real wedge: a writerless FIFO must not hang the render —')

  const fifo = join(dir, 'wedged.input')
  const mkfifoOk = await new Promise(r => {
    const p = spawn('mkfifo', [fifo], { stdio: 'ignore' })
    p.on('error', () => r(false))
    p.on('close', c => r(c === 0))
  })

  if (!mkfifoOk) {
    console.log('SKIP  mkfifo unavailable on this platform — wedge proof skipped')
  } else {
    // ffprobe blocks in open() on a FIFO that no one ever writes to. Nothing but
    // SIGKILL frees it, and `close` alone would never fire — so this is the real
    // "hangs forever" case the watchdog exists for.
    const budget = videoStageTimeoutMs('probe')
    const t0 = Date.now()
    const raced = await Promise.race([
      probeDuration(fifo, 'visualizer').then(v => ({ resolved: v }), e => ({ error: e })),
      // Generous: if the watchdog works this resolves in ~`budget`.
      new Promise(r => setTimeout(() => r({ hung: true }), budget + 30_000)),
    ])
    const elapsed = Date.now() - t0

    check('wedged ffprobe settles instead of hanging forever', !raced.hung,
      raced.hung ? `still pending after ${elapsed}ms` : `settled in ${(elapsed / 1000).toFixed(1)}s`)
    check('wedged ffprobe rejects (never resolves a bogus duration)',
      raced.error instanceof Error,
      raced.error instanceof Error ? raced.error.message.slice(0, 80) : `resolved ${raced.resolved}`)
    check('the failure names the timeout so it is diagnosable',
      raced.error instanceof Error && /timed out/i.test(raced.error.message))
    check('it settles at the stage budget, not by luck',
      !raced.hung && elapsed >= budget * 0.8 && elapsed <= budget + 15_000,
      `${(elapsed / 1000).toFixed(1)}s vs ${budget / 1000}s budget`)

    // The child must actually be dead, not merely detached — a survivor would
    // hold the temp dir and a CPU. The fifo path is unique to this run.
    const survivors = await new Promise(r => {
      const p = spawn('ps', ['-A', '-o', 'args='], { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      p.stdout.on('data', d => { out += d })
      p.on('error', () => r(null))
      p.on('close', () => r(out.split('\n').filter(l => l.includes(fifo) && l.includes('ffprobe')).length))
    })
    check('no ffprobe survived the kill', survivors === 0 || survivors === null,
      survivors === null ? 'ps unavailable' : `${survivors} survivor(s)`)
  }
} finally {
  if (server) await new Promise(r => server.close(r))
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
