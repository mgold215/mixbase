#!/usr/bin/env node
// backfill-wav-durations.mjs — one-shot repair for mb_versions.duration_seconds.
//
// WHY A SWEEP AT ALL
// Duration is normally measured at upload from the local File, and there is a
// lazy heal in PlayerContext that PATCHes a null when a mix is played. Neither
// can finish the job: /api/tracks is latest-version-only, so of the 157 null
// rows in production 126 are ARCHIVED mixes, reachable only if someone happens
// to replay that exact old version. Those rows would stay null forever.
//
// WHY THIS IS CHEAP
// All 157 are WAV and 154 already carry file_size_bytes. A WAV states its own
// duration in its header, so this needs a few KB per row over HTTP Range —
// about 630 KB total — not a re-download of 25 GB.
//
// ⚠️ THE 44-BYTE HEADER ASSUMPTION IS WRONG FOR THIS BUCKET. Every tutorial
// says fmt is at offset 12 and data at 36. Eight real production objects were
// sampled and ALL EIGHT are laid out JUNK@12 (64 bytes), fmt@84, data@108 —
// the DAW writes a JUNK padding chunk first. A blind 44-byte read parses JUNK
// as fmt and yields garbage. Because duration_seconds is write-once (the API
// only accepts a value while the column is null), garbage here is PERMANENT
// and would silently poison every row it touched. So: walk the chunk list.
//
// SAFETY POSTURE
// - Dry run by default. --apply is required to write anything.
// - Skips rather than guessing. A row left null is honest and still fixable;
//   a wrong number is forever. There is no "unknown" sentinel to write —
//   duration_seconds is an integer and 0 is rejected by the API validator.
// - Writes with .is('duration_seconds', null) so a concurrent player heal is
//   never clobbered.
//
// Usage:
//   node scripts/backfill-wav-durations.mjs                 # dry run, all rows
//   node scripts/backfill-wav-durations.mjs --limit 5       # dry run, 5 rows
//   node scripts/backfill-wav-durations.mjs --id <uuid>     # one row
//   node scripts/backfill-wav-durations.mjs --apply         # actually write

import { createClient } from '@supabase/supabase-js'

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const val = (f) => { const i = args.indexOf(f); return i === -1 ? null : args[i + 1] }

const APPLY = has('--apply')
const LIMIT = val('--limit') ? Number(val('--limit')) : null
const ONE_ID = val('--id')
const CONCURRENCY = 5
const HEADER_BYTES = 4096

const URL_BASE = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://mdefkqaawrusoaojstpq.supabase.co'
const KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
if (!KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY is not set'); process.exit(1) }
const db = createClient(URL_BASE, KEY, { auth: { persistSession: false } })

const fourcc = (buf, off) => String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3])

// Walk the RIFF chunk list. Returns { seconds, ... } or { skip: reason }.
function parseWav(buf, fileSize) {
  if (buf.length < 44) return { skip: `header too short (${buf.length}B)` }
  if (fourcc(buf, 0) !== 'RIFF' || fourcc(buf, 8) !== 'WAVE') {
    return { skip: `not RIFF/WAVE (magic "${fourcc(buf, 0)}"/"${fourcc(buf, 8)}")` }
  }
  const riffSize = buf.readUInt32LE(4)

  let off = 12, fmt = null, dataSize = null, dataOff = null
  while (off + 8 <= buf.length) {
    const id = fourcc(buf, off)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ' && off + 8 + 16 <= buf.length) {
      fmt = {
        audioFormat: buf.readUInt16LE(off + 8),
        channels:    buf.readUInt16LE(off + 10),
        sampleRate:  buf.readUInt32LE(off + 12),
        byteRate:    buf.readUInt32LE(off + 16),
        bits:        buf.readUInt16LE(off + 22),
      }
    }
    if (id === 'data') { dataSize = size; dataOff = off + 8; break }
    // Chunks are word-aligned: an odd size carries one pad byte.
    off += 8 + size + (size & 1)
  }

  if (!fmt) return { skip: 'no fmt chunk within the first 4 KB' }
  if (dataSize === null) return { skip: 'no data chunk within the first 4 KB' }
  // 1 = PCM, 0xFFFE = extensible. Anything else may be VBR, where
  // dataSize/byteRate is not the duration.
  if (fmt.audioFormat !== 1 && fmt.audioFormat !== 0xfffe) {
    return { skip: `non-PCM audioFormat ${fmt.audioFormat}` }
  }
  if (!fmt.byteRate) return { skip: 'byteRate is 0' }
  if (!dataSize) return { skip: 'data chunk is empty' }

  // A data size larger than the file can hold means the file is truncated —
  // trust the file, not the header, and only when we know the file's size.
  let effective = dataSize, truncated = false
  if (fileSize && dataOff + dataSize > fileSize) {
    effective = fileSize - dataOff
    truncated = true
    if (effective <= 0) return { skip: `data offset ${dataOff} past EOF ${fileSize}` }
  }

  const seconds = Math.round(effective / fmt.byteRate)
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 12 * 3600) {
    return { skip: `implausible duration ${seconds}s` }
  }
  return { seconds, fmt, dataOff, dataSize, truncated, riffMatchesFile: fileSize ? riffSize + 8 === fileSize : null }
}

async function fetchHeader(url) {
  const res = await fetch(url, { headers: { Range: `bytes=0-${HEADER_BYTES - 1}` } })
  if (res.status !== 206) return { err: `HTTP ${res.status} (expected 206)` }
  return { buf: Buffer.from(await res.arrayBuffer()) }
}

async function main() {
  let q = db.from('mb_versions').select('id, audio_url, file_size_bytes')
    .is('duration_seconds', null).order('id')
  if (ONE_ID) q = q.eq('id', ONE_ID)
  if (LIMIT) q = q.limit(LIMIT)
  const { data: rows, error } = await q
  if (error) { console.error('query failed:', error.message); process.exit(1) }

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${rows.length} row(s) with a null duration_seconds\n`)

  const out = { healed: 0, wrote: 0, skipped: 0, failed: 0 }
  const notes = []

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    await Promise.all(rows.slice(i, i + CONCURRENCY).map(async (r) => {
      if (!r.audio_url) { out.skipped++; notes.push(`${r.id}  SKIP  no audio_url`); return }
      let got = await fetchHeader(r.audio_url)
      if (got.err) got = await fetchHeader(r.audio_url) // one retry
      if (got.err) { out.failed++; notes.push(`${r.id}  FAIL  ${got.err}`); return }

      const p = parseWav(got.buf, r.file_size_bytes)
      if (p.skip) { out.skipped++; notes.push(`${r.id}  SKIP  ${p.skip}`); return }

      out.healed++
      const flags = [
        `${p.fmt.sampleRate}Hz/${p.fmt.channels}ch/${p.fmt.bits}bit`,
        `data@${p.dataOff}`,
        p.truncated ? 'TRUNCATED-file-size-used' : null,
        p.riffMatchesFile === false ? 'riff-size!=file-size' : null,
      ].filter(Boolean).join(' ')
      notes.push(`${r.id}  ${String(p.seconds).padStart(5)}s  ${flags}`)

      if (APPLY) {
        const { error: uErr, count } = await db.from('mb_versions')
          .update({ duration_seconds: p.seconds }, { count: 'exact' })
          .eq('id', r.id).is('duration_seconds', null)
        if (uErr) { out.failed++; notes.push(`${r.id}  WRITE-FAIL  ${uErr.message}`) }
        else if (count) out.wrote++
        else notes.push(`${r.id}  NO-OP  filled by the player heal first`)
      }
    }))
  }

  notes.sort().forEach(n => console.log('  ' + n))
  console.log(`\nresolved ${out.healed} · skipped ${out.skipped} · failed ${out.failed}` +
    (APPLY ? ` · WROTE ${out.wrote}` : '  (dry run — nothing written; pass --apply)'))
}

main().catch(e => { console.error(e); process.exit(1) })
