#!/usr/bin/env node
// Artwork realism bench — runs on Railway (service `artwork-bench`), where the
// production Replicate token is available, because the authoring sandbox
// cannot reach Replicate. One deliberate pass, then exit: every model in the
// registry with the NEW composed prompt, plus the OLD house prompt on the two
// strongest models as a baseline, plus one vary-look sample each. Results are
// emitted to stdout as log lines (BENCH-META json, BENCH-IMG base64 chunks)
// and read back through Railway's log API, then reassembled and viewed.
//
// Guard: BENCH_GO must equal BENCH_EXPECTED_GO or the script exits without
// spending anything — a Railway redeploy (variable change, restart) must never
// re-run a paid pass by accident.

import sharp from 'sharp'
import { MODEL_ENDPOINTS, MODEL_INPUTS, MODEL_INPUTS_MINIMAL, composePrompt } from '../src/lib/artwork-models.ts'

const log = (...a) => console.log(...a)

if (!process.env.BENCH_GO || process.env.BENCH_GO !== process.env.BENCH_EXPECTED_GO) {
  log('BENCH-SKIP go token mismatch; not running a paid pass')
  process.exit(0)
}
const token = (process.env.REPLICATE_API_TOKEN ?? '').trim()
if (!token) { log('BENCH-FATAL no Replicate token in the environment'); process.exit(0) }

const OLD_HOUSE = 'a colossal futuristic building shaped like a giant retro cassette tape, its two tape reels forming vast circular glass atriums, weathered board-formed concrete and steel, hyper-realistic materials with natural imperfections, surreal ominous megastructure, photorealistic architectural photograph, looks like a real photo, no text, no watermark, no text, no lettering, no typography, no logos, no watermarks, no people, no human figures'
const NEW_HOUSE = 'a huge weathered concrete building whose long facade is shaped like a cassette tape, two enormous circular windows where the reels would be, streaked board-formed concrete, rust-stained steel, dirt and water marks, a cracked car park and an ordinary road in front of it, architectural photograph'
const LOOK = 'shot on 35mm film, Kodak Portra 400, soft natural grain, overcast afternoon, flat soft daylight, no hard shadows, light drizzle, wet asphalt, puddles, an ordinary quiet industrial estate, chain-link fence, a parked delivery van, weeds along the kerb'

const cases = []
for (const model of Object.keys(MODEL_ENDPOINTS)) {
  cases.push({ id: `new-${model}`, model, prompt: composePrompt({ userPrompt: NEW_HOUSE, modelKey: model, look: null }) })
}
for (const model of ['flux-ultra', 'nano-pro']) {
  cases.push({ id: `old-${model}`, model, prompt: OLD_HOUSE })
  cases.push({ id: `vary-${model}`, model, prompt: composePrompt({ userPrompt: NEW_HOUSE, modelKey: model, look: LOOK }) })
}
log(`BENCH-START ${cases.length} cases`)

async function predict(endpoint, input) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'wait' },
    body: JSON.stringify({ input }),
    signal: AbortSignal.timeout(90_000),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* keep text */ }
  return { status: res.status, json, text }
}

async function poll(url) {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 4000))
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) })
    const p = await res.json()
    if (p.status === 'succeeded') return Array.isArray(p.output) ? p.output[0] : p.output
    if (p.status === 'failed' || p.status === 'canceled') throw new Error(String(p.error ?? 'failed'))
  }
  throw new Error('poll timeout')
}

async function runCase(c) {
  const t0 = Date.now()
  const meta = { id: c.id, model: c.model, prompt: c.prompt, tunedInput: MODEL_INPUTS[c.model](c.prompt) }
  try {
    let r = await predict(MODEL_ENDPOINTS[c.model], meta.tunedInput)
    if (r.status === 422) {
      meta.fallback422 = r.text.slice(0, 600)
      r = await predict(MODEL_ENDPOINTS[c.model], MODEL_INPUTS_MINIMAL[c.model](c.prompt))
    }
    if (r.status >= 300 || !r.json || r.json.error) throw new Error(`create ${r.status}: ${r.text.slice(0, 600)}`)
    let out = Array.isArray(r.json.output) ? r.json.output[0] : r.json.output
    if (!out && r.json.urls?.get) out = await poll(r.json.urls.get)
    if (!out) throw new Error(`no output, status=${r.json.status}`)
    const img = await fetch(out, { signal: AbortSignal.timeout(60_000) })
    const bytes = Buffer.from(await img.arrayBuffer())
    const m = await sharp(bytes).metadata()
    meta.width = m.width; meta.height = m.height; meta.format = m.format; meta.bytes = bytes.length
    meta.ms = Date.now() - t0
    const thumb = await sharp(bytes).resize(1024, 1024, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer()
    const b64 = thumb.toString('base64')
    const CH = 6000
    const total = Math.ceil(b64.length / CH)
    log(`BENCH-META ${JSON.stringify(meta)}`)
    for (let i = 0; i < total; i++) log(`BENCH-IMG ${c.id} ${i + 1}/${total} ${b64.slice(i * CH, (i + 1) * CH)}`)
  } catch (err) {
    meta.error = err instanceof Error ? err.message : String(err)
    meta.ms = Date.now() - t0
    log(`BENCH-META ${JSON.stringify(meta)}`)
  }
}

// Three at a time keeps the pass to a few minutes without tripping rate limits.
const queue = [...cases]
await Promise.all(Array.from({ length: 3 }, async () => {
  while (queue.length) await runCase(queue.shift())
}))
log('BENCH-DONE')

// Trigger: redeploy the bench service from this branch (exits with BENCH-SKIP until a run token is set).
