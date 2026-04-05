#!/usr/bin/env node
/**
 * Integration test for the audio upload + playback pipeline.
 *
 * Tests:
 *   1. TUS proxy creates upload session  (POST /api/tus)
 *   2. TUS proxy accepts a chunk         (PATCH /api/tus/<id>)
 *   3. Full file stored at correct size  (query Supabase storage)
 *   4. Audio proxy Range requests        (GET /api/audio/... with Range header)
 *
 * Usage:
 *   node scripts/test-upload.mjs [base-url]
 *   e.g. node scripts/test-upload.mjs https://mixfolio-production.up.railway.app
 *        node scripts/test-upload.mjs http://localhost:3000
 */

import { createClient } from '@supabase/supabase-js'

const BASE = process.argv[2] ?? 'http://localhost:3000'
const SUPABASE_URL = 'https://mdefkqaawrusoaojstpq.supabase.co'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SERVICE_KEY) {
  console.error('❌ SUPABASE_SERVICE_ROLE_KEY env var required to verify storage')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

let passed = 0
let failed = 0

function ok(name, detail = '') {
  console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`)
  passed++
}
function fail(name, detail = '') {
  console.error(`  ❌ ${name}${detail ? ' — ' + detail : ''}`)
  failed++
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTestAudio(bytes = 20 * 1024 * 1024) {
  // Synthetic WAV header + silence — enough to test chunked upload
  const buf = Buffer.alloc(bytes)
  // RIFF header
  buf.write('RIFF', 0)
  buf.writeUInt32LE(bytes - 8, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)     // chunk size
  buf.writeUInt16LE(1, 20)      // PCM
  buf.writeUInt16LE(2, 22)      // stereo
  buf.writeUInt32LE(44100, 24)  // sample rate
  buf.writeUInt32LE(176400, 28) // byte rate
  buf.writeUInt16LE(4, 32)      // block align
  buf.writeUInt16LE(16, 34)     // bits per sample
  buf.write('data', 36)
  buf.writeUInt32LE(bytes - 44, 40)
  return buf
}

// ─── Test 1: TUS session creation ────────────────────────────────────────────

async function testTusCreate(filename, fileSize) {
  const res = await fetch(`${BASE}/api/tus`, {
    method: 'POST',
    headers: {
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(fileSize),
      'Upload-Metadata': [
        `bucketName ${Buffer.from('mf-audio').toString('base64')}`,
        `objectName ${Buffer.from(filename).toString('base64')}`,
        `contentType ${Buffer.from('audio/wav').toString('base64')}`,
      ].join(','),
    },
  })

  if (res.status !== 201) {
    fail('TUS session creation', `HTTP ${res.status}: ${await res.text()}`)
    return null
  }

  const location = res.headers.get('location')
  if (!location || !location.startsWith('/api/tus/')) {
    fail('TUS session location header', `got: ${location}`)
    return null
  }

  ok('TUS session creation', `location=${location}`)
  return location
}

// ─── Test 2: TUS chunk upload ─────────────────────────────────────────────────

async function testTusChunks(location, fileBuffer) {
  const chunkSize = 8 * 1024 * 1024
  let offset = 0
  let chunkIdx = 0

  while (offset < fileBuffer.length) {
    const chunk = fileBuffer.subarray(offset, offset + chunkSize)
    const res = await fetch(`${BASE}${location}`, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': String(offset),
        'Content-Length': String(chunk.length),
      },
      body: chunk,
    })

    if (res.status !== 204) {
      fail(`TUS chunk ${chunkIdx} upload`, `HTTP ${res.status}: ${await res.text()}`)
      return false
    }

    const newOffset = Number(res.headers.get('upload-offset'))
    ok(`TUS chunk ${chunkIdx}`, `${offset}→${newOffset} bytes`)
    offset = newOffset
    chunkIdx++
  }
  return true
}

// ─── Test 3: Verify full file stored in Supabase ─────────────────────────────

async function testStorageSize(filename, expectedBytes) {
  const { data, error } = await supabase
    .storage.from('mf-audio')
    .list(filename.split('/')[0], { search: filename.split('/')[1] })

  if (error || !data?.length) {
    fail('File found in Supabase storage', error?.message ?? 'not found')
    return false
  }

  const stored = data[0].metadata?.size
  if (stored !== expectedBytes) {
    fail('File size correct', `stored=${stored}, expected=${expectedBytes}`)
    return false
  }

  ok('File stored at full size', `${stored} bytes`)
  return true
}

// ─── Test 4: Audio proxy Range requests ──────────────────────────────────────

async function testAudioProxy(filename) {
  const proxyPath = `/api/audio/${filename}`
  const url = `${BASE}${proxyPath}`

  // HEAD request
  const head = await fetch(url, { method: 'HEAD' })
  if (!head.ok) {
    fail('Audio proxy HEAD', `HTTP ${head.status}`)
    return false
  }
  const acceptRanges = head.headers.get('accept-ranges')
  const contentLength = head.headers.get('content-length')
  if (acceptRanges !== 'bytes') {
    fail('Audio proxy Accept-Ranges header', `got: ${acceptRanges}`)
  } else {
    ok('Audio proxy Accept-Ranges', `Content-Length=${contentLength}`)
  }

  // Range request (first 1 MB)
  const range = await fetch(url, { headers: { Range: 'bytes=0-1048575' } })
  if (range.status !== 206) {
    fail('Audio proxy Range request', `HTTP ${range.status} (expected 206)`)
    return false
  }
  const contentRange = range.headers.get('content-range')
  ok('Audio proxy 206 Partial Content', `Content-Range: ${contentRange}`)
  return true
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

async function cleanup(filename) {
  await supabase.storage.from('mf-audio').remove([filename])
  console.log(`  🗑  Cleaned up test file: ${filename}`)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🎵 Mixfolio upload + playback tests → ${BASE}\n`)

  const filename = `test/${Date.now()}.wav`
  const fileSize = 20 * 1024 * 1024 // 20 MB — large enough to require multiple 8 MB chunks
  const fileBuffer = makeTestAudio(fileSize)

  console.log('── Upload pipeline ──────────────────────────────────────────')
  const location = await testTusCreate(filename, fileSize)
  if (!location) {
    console.log('\nCannot continue without a TUS session.')
    process.exit(1)
  }

  const chunksOk = await testTusChunks(location, fileBuffer)
  if (!chunksOk) {
    console.log('\nChunk upload failed — skipping storage verification.')
    process.exit(1)
  }

  console.log('\n── Storage verification ─────────────────────────────────────')
  await testStorageSize(filename, fileSize)

  console.log('\n── Audio proxy ──────────────────────────────────────────────')
  await testAudioProxy(filename)

  console.log('\n── Cleanup ──────────────────────────────────────────────────')
  await cleanup(filename)

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.error('❌ Some tests failed.')
    process.exit(1)
  } else {
    console.log('✅ All tests passed.')
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
