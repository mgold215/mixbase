#!/usr/bin/env node
// The mixing intern's job loop. The helper on the owner's Mac
// (macos/MixbaseIntern) starts this and keeps it running; it is not started by
// hand. No AI and nothing billed per use: measured notes are fixed by the
// rules in src/lib/intern-rules.ts, and Mix Check is the judge.
//
// One job, start to finish:
//   claim → find the song's Logic project → COPY it → open the copy in Logic →
//   bounce it as it is and measure (the project may have moved on since the
//   handed mix) → export every track → plan the moves → make them → bounce →
//   judge → resize and re-bounce while that helps → upload the bounce as a new
//   version marked as the intern's → tell the server which version it is →
//   Mix Check there → done, or take the version back and say why.
//
// The owner's own project is only ever read: copied, never opened, never saved.
//
// It talks to the helper over its stdout/stdin, one JSON object per line: the
// helper lends it the access token and its hands on Logic (AX.swift). Its own
// log goes to stderr, which the helper writes to ~/Library/Logs/MixbaseIntern.

import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { basename, extname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { judge, plan, refine } from './intern-plan.mjs'
import { internNames, listProjects, pickProject } from './intern-find.mjs'
import { LogicProblem, createLogic } from './intern-logic.mjs'
import { judgeFix } from '../src/lib/intern-rules.ts'
import { MIX_BANDS } from '../src/lib/mix-check.ts'

const SUPPORT = process.env.INTERN_SUPPORT ?? join(os.homedir(), 'Library/Application Support/MixbaseIntern')
const JOBS = join(SUPPORT, 'jobs')
const FFMPEG = join(SUPPORT, 'runtime/bin/ffmpeg')
const DEVICE = process.env.INTERN_DEVICE ?? 'Mac'
const POLL_MS = 10_000
/** How many times a bounce that missed is resized and tried again. */
const MAX_REFINES = 3
/** Working folders kept for the owner to look at; older ones are removed. */
const KEEP_JOBS = 5

const log = (...a) => process.stderr.write(`${a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`)
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── The helper: token and hands ──────────────────────────────────────────────

let rpcId = 0
const waiting = new Map()
createInterface({ input: process.stdin }).on('line', line => {
  let reply
  try { reply = JSON.parse(line) } catch { return }
  const w = waiting.get(reply.rpc)
  if (!w) return
  waiting.delete(reply.rpc)
  if (reply.ok) w.resolve(reply.result); else w.reject(new Error(reply.error ?? 'The helper refused'))
}).on('close', () => process.exit(0)) // the helper quit: so do we

export function helper(cmd, args = {}, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId
    const started = Date.now()
    const what = () => `${cmd} ${JSON.stringify(args).slice(0, 160)}`
    const timer = setTimeout(() => { waiting.delete(id); log('no answer:', what()); reject(new Error(`${cmd}: Logic did not answer in ${timeoutMs / 1000}s`)) }, timeoutMs)
    // A slow answer is worth a line: it is how a stuck step is found afterwards.
    const done = () => { clearTimeout(timer); if (Date.now() - started > 20_000 && cmd !== 'auth.token') log(`slow (${Math.round((Date.now() - started) / 1000)}s):`, what()) }
    waiting.set(id, { resolve: v => { done(); resolve(v) }, reject: e => { done(); reject(e) } })
    // The message's own number is `rpc`, never `id`: a search can ask for an element by its id.
    process.stdout.write(`${JSON.stringify({ ...args, rpc: id, cmd })}\n`)
  })
}

// ── mixBASE ──────────────────────────────────────────────────────────────────

class Cancelled extends Error {}
/** A failure the owner should read as it is (not a crash). */
class Giveup extends Error {}

async function api(path, { method = 'GET', body } = {}) {
  const auth = await helper('auth.token')
  const res = await fetch(`${auth.api}${path}`, {
    method,
    headers: { Authorization: `Bearer ${auth.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

/** One job's line to the server: every report is also its heartbeat. */
function reporter(jobId) {
  let stage = 'Starting', cancelled = false, timer = null, sending = Promise.resolve()
  const send = body => {
    sending = sending.then(async () => {
      try {
        const r = await api(`/api/intern/jobs/${jobId}`, { method: 'PATCH', body })
        if (r.status === 409 && r.json?.job?.status === 'cancelled') cancelled = true
        if (r.status === 409 && r.json?.job && r.json.job.status !== 'working') cancelled = true
        return r
      } catch (err) { log('report failed:', err.message); return null }
    })
    return sending
  }
  return {
    start() { timer = setInterval(() => send({ stage }), 45_000) },
    stop() { clearInterval(timer) },
    /** Say where the job is, and stop here if the owner cancelled it. */
    async stage(text) {
      stage = text
      log(`[${jobId.slice(0, 8)}] ${text}`)
      await send({ stage })
      if (cancelled) throw new Cancelled('The job was stopped')
    },
    /** A line of the step log inside the current stage: what was found or set. */
    async note(text) { log(`[${jobId.slice(0, 8)}]   ${text}`); await send({ step: String(text).slice(0, 300) }) },
    check() { if (cancelled) throw new Cancelled('The job was stopped') },
    report: send,
  }
}

// ── Files ────────────────────────────────────────────────────────────────────

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', d => { if (err.length < 2000) err += d })
    p.on('error', reject)
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(`${basename(cmd)} failed: ${err.trim().split('\n')[0]}`))))
  })
}

async function pruneJobs(keepId) {
  let dirs = []
  try { dirs = await readdir(JOBS) } catch { return }
  const aged = []
  for (const d of dirs) { try { aged.push({ d, t: (await stat(join(JOBS, d))).mtimeMs }) } catch { /* gone */ } }
  aged.sort((a, b) => b.t - a.t)
  for (const { d } of aged.slice(KEEP_JOBS)) if (d !== keepId) await rm(join(JOBS, d), { recursive: true, force: true })
}

// ── What a job leaves beside the owner's files ──────────────────────────────
// Logic can only write where its own save dialog is, so a job makes a folder
// there ("mixBASE Intern <job>.nosync") and removes it when it ends. Each one
// is written down first, so a job that died (the Mac shut down) is cleaned up
// by the next start. Only things the intern itself named are ever removed.

const LEFTOVERS = join(SUPPORT, 'leftovers.json')
const isOurs = path => /^mixBASE Intern .+/.test(basename(path)) || /:MixbaseIntern:jobs:/.test(basename(path))

async function rememberLeftover(path) {
  let list = []
  try { list = JSON.parse(await readFile(LEFTOVERS, 'utf8')) } catch { /* none yet */ }
  if (!list.includes(path)) await writeFile(LEFTOVERS, JSON.stringify([...list, path]))
}

async function clearLeftovers() {
  let list = []
  try { list = JSON.parse(await readFile(LEFTOVERS, 'utf8')) } catch { return }
  for (const path of Array.isArray(list) ? list : []) {
    if (typeof path !== 'string' || !isOurs(path)) continue
    await rm(path, { recursive: true, force: true }).then(() => log('removed', basename(path)), err => log('could not remove', basename(path), err.message))
  }
  await unlink(LEFTOVERS).catch(() => null)
}

// ── The upload ───────────────────────────────────────────────────────────────

async function upload(song, file) {
  const auth = await helper('auth.token')
  // The app's own path for a mix: straight to Storage with the owner's token,
  // so the file never passes through the web server (10 MB limit there).
  const key = `${String(song.project_id).toLowerCase()}/${Date.now()}.wav`
  const size = (await stat(file)).size
  const res = await fetch(`${auth.supabase}/storage/v1/object/mf-audio/${key}`, {
    method: 'POST',
    headers: { apikey: auth.key, Authorization: `Bearer ${auth.token}`, 'Content-Type': 'audio/wav', 'Content-Length': String(size) },
    body: Readable.toWeb(createReadStream(file)),
    duplex: 'half',
    signal: AbortSignal.timeout(900_000),
  })
  if (!res.ok) throw new Giveup(`The upload was refused (${res.status})`)
  return { url: `${auth.supabase}/storage/v1/object/public/mf-audio/${key}`, key, size }
}

async function removeUpload(key) {
  try {
    const auth = await helper('auth.token')
    await fetch(`${auth.supabase}/storage/v1/object/mf-audio/${key}`, { method: 'DELETE', headers: { apikey: auth.key, Authorization: `Bearer ${auth.token}` } })
  } catch { /* an orphan is found by the usual cleanup */ }
}

/** Runs Mix Check on a version and waits for its report. */
async function serverCheck(versionId, report) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = await api(`/api/versions/${versionId}/mix-check`, { method: 'POST' })
    if (started.status >= 400 && started.status !== 409) { await sleep(5000); continue }
    for (let i = 0; i < 90; i++) {
      await sleep(4000)
      report.check()
      const r = await api(`/api/versions/${versionId}/mix-check`)
      if (r.json?.status === 'done' && r.json.report) return r.json.report
      // 'none' mid-run means the server restarted under it: start it again.
      if (r.json?.status === 'error' || r.json?.status === 'none') break
    }
  }
  throw new Giveup('Mix Check on the new version did not finish')
}

/**
 * Logic's windows cannot be read while the display sleeps. The helper can wake
 * the display, and holds it awake for the job; what it cannot do is type the
 * password once the Mac has locked. Then the job waits, saying so, until
 * someone unlocks the Mac (or stops the job).
 */
async function awake(report) {
  for (let i = 0; ; i++) {
    await helper('sys.wake').catch(() => null)
    await helper('sys.awake', { on: true })
    await sleep(2500)
    const state = await helper('ping')
    if (!state.screen_locked && !state.display_asleep) return
    if (i === 0) log('the Mac is locked: waiting')
    await report.stage('Waiting for your Mac to be unlocked')
    await sleep(15_000)
  }
}

// ── One job ──────────────────────────────────────────────────────────────────

const bandLabel = key => MIX_BANDS.find(b => b.key === key)?.label ?? key
const signedDb = x => (typeof x === 'number' && Number.isFinite(x) ? `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(1)} dB` : '?')

/** A band this far from the handed mix means the bounce is not that mix (Mix Check itself writes a note at 2.5 dB). */
const DRIFT_DB = 2.5
/** The furthest any band of a bounce is from the handed mix, in dB. */
const driftDb = bands => Math.max(0, ...(bands ?? []).filter(b => b.before != null && b.after != null).map(b => Math.abs(b.after - b.before)))

/** How the project's bounce differs from the handed mix, in words, or null when it is that mix. */
export function projectDrift(bands) {
  const off = (bands ?? []).filter(b => b.before != null && b.after != null && Math.abs(b.after - b.before) >= DRIFT_DB)
    .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before))
  if (!off.length) return null
  return off.slice(0, 3).map(b => `${bandLabel(b.key).toLowerCase()} ${b.after > b.before ? '+' : '−'}${Math.abs(b.after - b.before).toFixed(1)} dB`).join(', ')
}
const handledCodes = notes => notes.map(n => n.code).filter(c => typeof c === 'string' && MIX_BANDS.some(b => c === `changed.${b.key}`))

async function runJob(claim) {
  const { job, song } = claim
  const report = reporter(job.id)
  const dir = join(JOBS, job.id)
  const logic = createLogic(helper, { log, tag: job.id.slice(0, 8), onFolder: rememberLeftover, ownDir: JOBS })
  let opened = false, uploaded = null, versionId = null
  report.start()
  try {
    if (!song) throw new Giveup('The mix this job was for is gone')
    const handled = handledCodes(job.notes ?? [])
    if (!handled.length) throw new Giveup('None of these notes is one the intern has a rule for yet (it fixes a band that changed since the last version)')
    await mkdir(dir, { recursive: true })
    await pruneJobs(job.id)
    // What the server handed over, kept beside the job's files: `intern-plan.mjs` can be re-run on it by hand.
    await writeFile(join(dir, 'claim.json'), JSON.stringify(claim, null, 1))
    await awake(report)

    await report.stage('Finding the Logic project')
    const projects = await listProjects({ exclude: [JOBS] })
    const found = pickProject([song.title, song.audio_filename, ...(song.filenames ?? [])].filter(Boolean), projects)
    if (found.error) throw new Giveup(found.error)
    log('project:', basename(found.path), found.others?.length ? `(also matched: ${found.others.map(p => basename(p)).join(', ')})` : '')
    await report.note(`Found ${basename(found.path)} among ${projects.length} projects`)

    await report.stage('Copying the project')
    const copy = join(dir, `${basename(found.path, '.logicx')} (intern).logicx`)
    await rm(copy, { recursive: true, force: true })
    // -c clones on APFS: instant, and takes no space until something changes.
    await run('/bin/cp', ['-Rc', found.path, copy])
    const before = (await stat(found.path)).mtimeMs

    await report.stage('Opening the copy in Logic Pro')
    await logic.open(copy)
    opened = true

    // The project as it is now, measured the way Mix Check measures: it may
    // have moved on since the handed mix was bounced.
    await report.stage('Bouncing the project as it is')
    let bounce0 = join(dir, 'bounce-0.wav')
    await logic.bounce(bounce0)
    let judge0 = await judge({ job: claim, bounce: bounce0, handled, ffmpeg: FFMPEG })
    await writeFile(join(dir, 'judge-0.json'), JSON.stringify(judge0, null, 2))

    // Is this bounce the handed mix? A project is saved as it was last left: a
    // muted vocal stack from an instrumental bounce, say. If it is not the
    // mix, and tracks are muted, the bounce is tried with them on, and the
    // state that reproduces the handed mix is the one worked on.
    const unmuted = []
    await report.note(driftDb(judge0.bands) >= DRIFT_DB
      ? `Measured it: not ${song.version_label} (${projectDrift(judge0.bands)})`
      : `Measured it: it is ${song.version_label} (every band within ${driftDb(judge0.bands).toFixed(1)} dB)`)
    if (driftDb(judge0.bands) >= DRIFT_DB) {
      const { muted, soloed } = await logic.silenced()
      log('not the handed mix:', projectDrift(judge0.bands), '| muted:', muted.map(m => m.name).join(', ') || 'none', '| soloed:', soloed.map(m => m.name).join(', ') || 'none')
      if (muted.length) {
        await report.stage(`Trying the bounce with ${muted.length === 1 ? muted[0].name : `${muted.length} muted tracks`} unmuted`)
        await logic.setMuted(muted, false)
        const again = join(dir, 'bounce-0-unmuted.wav')
        await logic.bounce(again)
        const judged = await judge({ job: claim, bounce: again, handled, ffmpeg: FFMPEG })
        await writeFile(join(dir, 'judge-0-unmuted.json'), JSON.stringify(judged, null, 2))
        if (driftDb(judged.bands) < driftDb(judge0.bands) - 0.5) {
          bounce0 = again; judge0 = judged; unmuted.push(...muted.map(m => m.name))
          await report.note(driftDb(judged.bands) >= DRIFT_DB
            ? `Closer with ${unmuted.join(', ')} on, but still not ${song.version_label}`
            : `With ${unmuted.join(', ')} on it is ${song.version_label} (every band within ${driftDb(judged.bands).toFixed(1)} dB)`)
        } else {
          await logic.setMuted(muted, true)
          await report.note('No closer with them on: muted again')
        }
      }
    }
    // Still not the mix: fixing it would upload something the owner did not make.
    const drift = projectDrift(judge0.bands)
    if (drift) {
      throw new Giveup(`Nothing was uploaded: the Logic project does not bounce to ${song.version_label} (${drift}). It has changed since that mix, or the mix was finished somewhere else. Upload the project's own bounce, check it, and hand that over.`)
    }

    const open = judge0.remaining
    if (!open.length) throw new Giveup('The Logic project no longer shows these notes: its bounce is already inside what Mix Check accepts')
    // From here the project's own bounce is the "before": its bands are what the
    // moves are sized on, and a note it already had is not one a fix brought.
    const had = [...(song.findings ?? []), ...judge0.findings.filter(f => !(song.findings ?? []).some(x => x.code === f.code))]
    const now = { ...claim, song: { ...song, findings: had, bands: judge0.bands.map(b => ({ key: b.key, vsPrevious: b.after })) }, job: { ...job, notes: (job.notes ?? []).filter(n => !n.code || !handled.includes(n.code) || open.includes(n.code)) } }

    await report.stage('Exporting the tracks')
    const tracksDir = join(dir, 'tracks')
    await rm(tracksDir, { recursive: true, force: true })
    await mkdir(tracksDir, { recursive: true })
    await logic.exportTracks(tracksDir)
    // A track stack's own export is its tracks added up: set it aside, or they count twice.
    const sums = new Set(await logic.sumTracks())
    await mkdir(join(dir, 'sums'), { recursive: true })
    let exported = 0
    for (const f of await readdir(tracksDir)) {
      exported++
      if (sums.has(basename(f, extname(f)))) await rename(join(tracksDir, f), join(dir, 'sums', f))
    }
    await report.note(`${exported} tracks exported${sums.size ? `; ${sums.size} are track stacks, the sum of their tracks, and were set aside` : ''}`)

    await report.stage('Choosing the moves')
    let planned = await plan({ job: now, tracksDir, mix: bounce0, ffmpeg: FFMPEG })
    await writeFile(join(dir, 'plan.json'), JSON.stringify(planned, null, 2))
    log('tracks vs mix:', planned.sumVsMix?.map(b => `${b.key} ${b.db}`).join(', ') ?? 'n/a')
    // Who carries each band the notes are about, and what the moves are predicted to do.
    for (const key of [...new Set(planned.moves.map(m => m.band))]) {
      const carriers = planned.tracks.filter(t => t.share[key] >= 0.05).sort((a, b) => b.share[key] - a.share[key]).slice(0, 4)
      await report.note(`${bandLabel(key)} is carried by ${carriers.map(t => `${t.name} ${Math.round(t.share[key] * 100)}%`).join(', ')}`)
      const p = planned.predicted.find(x => x.key === key)
      if (p?.before != null && p.after != null) await report.note(`Predicted: ${bandLabel(key).toLowerCase()} ${signedDb(p.before)} → ${signedDb(p.after)} against ${song.baseline?.label ?? 'the earlier mix'}`)
    }
    if (!planned.moves.length) {
      const why = planned.skipped.filter(s => s.code && open.includes(s.code)).map(s => s.why)[0] ?? 'no move within its limits answers these notes'
      throw new Giveup(`Nothing changed: ${why}`)
    }

    let verdict = null, bounce = null, changes = []
    for (let round = 0; round <= MAX_REFINES; round++) {
      await report.stage(round === 0 ? 'Making the moves in Logic' : `Resizing the moves (try ${round + 1})`)
      const set = await logic.applyMoves(planned.moves)
      for (const m of set) {
        await report.note(m.kind === 'level'
          ? `${m.track}: Gain added last in the strip, set to ${signedDb(m.gain)}`
          : `${m.track}: Channel EQ added last in the strip, Peak 1 at ${m.hz} Hz, Q ${m.q}, ${signedDb(m.gain)}`)
      }
      changes = planned.changes
      await report.report({ changes })
      await report.stage(round === 0 ? 'Bouncing' : `Bouncing again (try ${round + 1})`)
      bounce = join(dir, `bounce-${round + 1}.wav`)
      await logic.bounce(bounce)
      await report.stage('Checking the bounce')
      verdict = await judge({ job: now, bounce, handled: open, ffmpeg: FFMPEG })
      await writeFile(join(dir, `judge-${round + 1}.json`), JSON.stringify(verdict, null, 2))
      log('judge:', { keep: verdict.keep, cleared: verdict.cleared, remaining: verdict.remaining, appeared: verdict.appeared })
      const moved = verdict.bands.filter(b => open.includes(`changed.${b.key}`)).map(b => `${bandLabel(b.key).toLowerCase()} ${signedDb(judge0.bands.find(x => x.key === b.key)?.after)} → ${signedDb(b.after)}`)
      await report.note(`Measured: ${moved.join(', ')}; ${verdict.remaining.length ? 'still a note' : 'the note is gone'}${verdict.appeared.length ? `; new: ${verdict.appeared.join(', ')}` : '; nothing new'}`)
      if (verdict.keep) break
      if (verdict.appeared.length) break // resizing does not un-make a new note
      const next = refine({ plan: planned, judge: verdict })
      if (!next.changed) break
      planned = { ...planned, moves: next.moves, changes: next.changes }
    }
    if (!verdict.keep) {
      const what = verdict.appeared.length ? `it brought a new note (${verdict.appeared.join(', ')})`
        : `${verdict.remaining.map(c => bandLabel(c.split('.')[1])).join(' and ')} still reads as changed`
      throw new Giveup(`Nothing was uploaded: the fix was tried and bounced, but ${what}`)
    }

    if (dryRuns.delete(job.id)) throw new Giveup('Dry run: every step on the Mac worked and the fix was kept; nothing was uploaded')

    await report.stage('Saving the copy')
    await logic.save()
    if ((await stat(found.path)).mtimeMs !== before) log('WARNING: the original project changed during the job (the owner may have saved it)')

    await report.stage('Uploading the new version')
    const names = internNames(song)
    const up = await upload(song, bounce)
    uploaded = up.key
    if (unmuted.length) changes = [...changes, ...unmuted.map(name => ({ track: name, what: `Unmuted for the bounce: the project was saved with it muted, and with it on the bounce matches ${song.version_label}` }))]
    const list = changes.map(c => `${c.track}: ${c.what} ${c.to ?? ''}`.trim()).join('; ')
    const created = await api('/api/versions', {
      method: 'POST',
      body: {
        project_id: song.project_id, audio_url: up.url, audio_filename: names.filename, label: names.label,
        duration_seconds: Math.round(verdict.loudness.seconds), file_size_bytes: up.size,
        change_log: `Mixing intern, from ${song.version_label}: ${list}`.slice(0, 1000),
        // The owner decides what the feed sees; an intern's bounce is not announced.
        share_to_feed: false,
      },
    })
    versionId = created.json?.id ?? created.json?.version?.id
    if (!versionId) throw new Giveup(`The new version could not be filed (${created.status})`)
    // BEFORE Mix Check: this is how the server knows to compare the bounce
    // with the mix the notes were written against, not with the mix it fixes.
    await report.report({ result_version_id: versionId, changes })

    await report.note(`Filed as ${names.label}`)
    await report.stage('Running Mix Check on the new version')
    const checked = await serverCheck(versionId, report)
    const final = judgeFix(had, checked.findings ?? [], open)
    await writeFile(join(dir, 'server-check.json'), JSON.stringify({ final, findings: checked.findings }, null, 2))
    if (!final.keep) {
      const what = final.appeared.length ? `Mix Check found a new note on it (${final.appeared.join(', ')})` : `${final.remaining.join(', ')} did not clear`
      throw new Giveup(`The new version was taken back: ${what}`)
    }
    await report.note(`Mix Check kept it: ${final.cleared.length} note${final.cleared.length === 1 ? '' : 's'} cleared, nothing new`)
    await report.report({ status: 'done', stage: 'Done', changes })
    log(`[${job.id.slice(0, 8)}] done: version ${versionId}`)
    uploaded = null; versionId = null
  } catch (err) {
    // Whatever was uploaded for a fix that did not hold is taken back.
    if (versionId) await api(`/api/versions/${versionId}`, { method: 'DELETE' }).catch(() => null)
    if (uploaded) await removeUpload(uploaded)
    if (err instanceof Cancelled) {
      log(`[${job.id.slice(0, 8)}] stopped by the owner`)
    } else {
      const plain = err instanceof Giveup || err instanceof LogicProblem
      const text = plain ? err.message : `Something went wrong on the Mac: ${err.message}`
      log(`[${job.id.slice(0, 8)}] failed: ${text}`, plain ? '' : String(err.stack ?? ''))
      await report.report({ status: 'failed', error: text.slice(0, 500) })
    }
  } finally {
    report.stop()
    if (opened) await logic.close().catch(e => log('close failed:', e.message))
    // The folders Logic wrote into, beside the owner's own files, go with the job.
    await logic.cleanup().catch(e => log('cleanup failed:', e.message))
    await clearLeftovers()
    // The exported tracks are gigabytes (32-bit float, one file a track) and have done their job;
    // the bounces, the plan and the verdicts stay for the owner to look at.
    for (const sub of ['tracks', 'sums']) await rm(join(dir, sub), { recursive: true, force: true }).catch(() => null)
    await helper('sys.awake', { on: false }).catch(() => null)
  }
}

// ── The loop ─────────────────────────────────────────────────────────────────

/** Jobs filed here as dry runs: they stop before anything is uploaded. */
const dryRuns = new Set()

/** A hand-off made on the Mac itself: a file naming a version, for trying a job without the app. */
async function localHandoff() {
  const file = join(SUPPORT, 'handoff.json')
  let raw
  try { raw = await readFile(file, 'utf8') } catch { return }
  await unlink(file).catch(() => null)
  try {
    const { version_id, check_first, take_back, dry_run } = JSON.parse(raw)
    // take_back: remove a version the intern uploaded that turned out wrong
    // ({ version_id, key }): the row through the app's own route, then its file.
    if (take_back?.version_id) {
      const r = await api(`/api/versions/${take_back.version_id}`, { method: 'DELETE' })
      if (r.status === 200 && typeof take_back.key === 'string') await removeUpload(take_back.key)
      log('local take-back:', r.status)
      return
    }
    // check_first: run Mix Check on the mix before handing it over, as the
    // owner would by tapping "Check this mix" and then "Hand to the intern".
    if (check_first) {
      const report = await serverCheck(version_id, { check() {} })
      log('local hand-off: Mix Check found', (report.findings ?? []).map(f => f.code).join(', ') || 'nothing')
    }
    const r = await api(`/api/versions/${version_id}/intern`, { method: 'POST' })
    // dry_run: do everything on the Mac up to the upload and stop there (a check that Logic can still be driven).
    if (dry_run && r.json?.job?.id) dryRuns.add(r.json.job.id)
    log('local hand-off:', r.status, r.json?.job?.id ?? r.json?.error ?? '')
  } catch (err) { log('local hand-off failed:', err.message) }
}

async function main() {
  log(`worker up on ${DEVICE}`)
  await mkdir(JOBS, { recursive: true })
  await clearLeftovers()
  for (;;) {
    try {
      await localHandoff()
      const state = await helper('ping')
      if (state.trusted && state.signed_in) {
        const r = await api('/api/intern/jobs/claim', { method: 'POST', body: { device: DEVICE } })
        if (r.status === 200 && r.json?.job) { await runJob(r.json); continue }
        if (r.status !== 200) log('claim answered', r.status)
      }
    } catch (err) { log('loop:', err.message) }
    await sleep(POLL_MS)
  }
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1])) && extname(process.argv[1]) === '.mjs') main()
