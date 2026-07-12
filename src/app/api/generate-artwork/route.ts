import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { supabaseAdmin } from '@/lib/supabase'
import { checkAndIncrementUsage, refundUsage } from '@/lib/tier'
import { artworkLimiter, rateLimitHeaders } from '@/lib/rate-limit'
import { isUuid } from '@/lib/validators'

// Allow up to 2 minutes — Flux 2 Pro can take 30-60s
export const maxDuration = 120

const MODEL_ENDPOINTS: Record<string, string> = {
  // Photorealism-first lineup. flux-ultra runs FLUX 1.1 Pro Ultra in raw mode,
  // which is specifically tuned to avoid the over-processed "AI art" look.
  'flux-ultra':   'https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro-ultra/predictions',
  seedream:       'https://api.replicate.com/v1/models/bytedance/seedream-4/predictions',
  'imagen-ultra': 'https://api.replicate.com/v1/models/google/imagen-4-ultra/predictions',
  recraft:        'https://api.replicate.com/v1/models/recraft-ai/recraft-v3/predictions',
  flux:           'https://api.replicate.com/v1/models/black-forest-labs/flux-2-pro/predictions',
  imagen:         'https://api.replicate.com/v1/models/google/imagen-4/predictions',
}

const MODEL_INPUTS: Record<string, (prompt: string) => Record<string, unknown>> = {
  'flux-ultra':   (prompt) => ({ prompt, aspect_ratio: '1:1', raw: true }),
  seedream:       (prompt) => ({ prompt, aspect_ratio: '1:1', size: '2K' }),
  'imagen-ultra': (prompt) => ({ prompt, aspect_ratio: '1:1', safety_filter_level: 'block_only_high' }),
  recraft:        (prompt) => ({ prompt, size: '1024x1024', style: 'realistic_image' }),
  flux:           (prompt) => ({ prompt, aspect_ratio: '1:1', output_format: 'webp', output_quality: 95 }),
  imagen:         (prompt) => ({ prompt, aspect_ratio: '1:1', safety_filter_level: 'block_only_high' }),
}

// Randomized photographic treatment, appended when the client asks to vary the
// look. One pick per axis — vantage × light × weather × mood — so consecutive
// generations of the same subject land on visibly different photographs instead
// of the model's single house style.
const LOOK_VANTAGE = [
  'shot on 35mm film, Kodak Portra 400, subtle grain',
  'medium format Hasselblad capture, razor-sharp 8k architectural photography',
  'aerial drone photograph from 120 meters',
  'low-angle street-level shot on a 24mm wide lens, dramatic perspective',
  'telephoto compression from a distant rooftop, layered against the skyline',
  'tilt-shift photograph with selective focus',
]
const LOOK_LIGHT = [
  'golden hour, long shadows and warm sun flare',
  'overcast flat daylight, muted tones',
  'blue hour, sodium streetlights glowing',
  'harsh midday sun, deep black shadows',
  'night scene, neon signage reflecting on wet asphalt',
  'dawn light breaking through low clouds',
]
const LOOK_WEATHER = [
  'dense fog rolling between structures',
  'light rain, wet reflective surfaces',
  'dust haze in the air',
  'crystal clear air, extreme detail',
  'low storm clouds gathering overhead',
]
const LOOK_MOOD = [
  'ominous looming scale, tiny human figures dwarfed below',
  'dystopian corporate megastructure, uncanny emptiness',
  'abandoned and partially overgrown, nature reclaiming the facade',
  'pristine futuristic campus, sterile and unsettling',
  'brutalist monolith against an empty sky',
]

function composeLook(): string {
  const pick = (pool: string[]) => pool[Math.floor(Math.random() * pool.length)]
  return [pick(LOOK_VANTAGE), pick(LOOK_LIGHT), pick(LOOK_WEATHER), pick(LOOK_MOOD)].join(', ')
}

async function pollPrediction(predictionUrl: string, token: string): Promise<string | null> {
  for (let i = 0; i < 24; i++) {  // 24 * 5s = 2 min
    await new Promise(r => setTimeout(r, 5000))
    const res = await fetch(predictionUrl, { headers: { Authorization: `Bearer ${token}` } })
    const p = await res.json()
    if (p.status === 'succeeded') return Array.isArray(p.output) ? p.output[0] : p.output
    if (p.status === 'failed' || p.status === 'canceled') throw new Error(p.error ?? 'Prediction failed')
  }
  return null
}

// POST /api/generate-artwork
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // Rate limit: 10/hour per user (defence-in-depth alongside the monthly tier gate)
  const limit = artworkLimiter.check(userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  const supabase = await createClient()
  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const { project_id, collection_id, prompt, model = 'flux', vary = false } = body

  if (!prompt?.trim()) {
    return NextResponse.json({ error: 'Prompt is required' }, { status: 400 })
  }

  // Vary layer: append a randomized photographic treatment so repeat runs of
  // the same subject produce visibly different shots. Composed before the paid
  // call; echoed back in the response so the UI can show what was applied.
  const look = vary ? composeLook() : null
  const finalPrompt = look ? `${prompt.trim()}, ${look}` : prompt.trim()

  // Two targets: a project's artwork, or a collection's cover. Exactly one id.
  const isCollection = !!collection_id
  const targetId: string = isCollection ? collection_id : project_id

  // Reject malformed ids before they reach a storage key or DB write.
  if (!isUuid(targetId)) {
    return NextResponse.json(
      { error: `Valid ${isCollection ? 'collection_id' : 'project_id'} is required` },
      { status: 400 }
    )
  }

  // Ownership check: the write below targets this row, so confirm the caller
  // owns it. Without this an authenticated user could overwrite another user's
  // artwork/cover by passing their id (IDOR).
  const ownerTable = isCollection ? 'mb_collections' : 'mb_projects'
  const { data: ownerRow, error: ownerErr } = await supabaseAdmin
    .from(ownerTable)
    .select('id')
    .eq('id', targetId)
    .eq('user_id', userId)
    .single()
  if (ownerErr || !ownerRow) {
    return NextResponse.json({ error: `${isCollection ? 'Collection' : 'Project'} not found` }, { status: 404 })
  }

  // Gate: check monthly artwork limit before hitting Replicate
  const gate = await checkAndIncrementUsage(userId, 'artwork')
  if (gate.error) {
    // Couldn't reserve a slot (usage RPC failed) — don't run the paid call.
    return NextResponse.json({ error: 'Could not reserve a generation slot. Please try again.' }, { status: 503 })
  }
  if (!gate.allowed) {
    return NextResponse.json(
      { error: `Monthly artwork limit reached (${gate.used}/${gate.limit}). Upgrade to generate more.`, upgrade: true },
      { status: 403 }
    )
  }

  // The artwork slot is now reserved (checkAndIncrementUsage incremented it).
  // Every failure path below must release it, or a provider/config hiccup would
  // permanently burn the user's monthly quota with nothing to show for it.
  const refund = () => refundUsage(userId, 'artwork')

  const replicateToken = process.env.REPLICATE_API_TOKEN?.trim().replace(/^["']|["']$/g, '')
  if (!replicateToken) {
    await refund()
    console.error('[generate-artwork] REPLICATE_API_TOKEN is not set')
    return NextResponse.json({ error: 'AI artwork generation is temporarily unavailable.' }, { status: 503 })
  }
  if (!replicateToken.startsWith('r8_')) {
    await refund()
    // Keep the diagnostic detail in the server log only — never echo token
    // characteristics back to the client.
    console.error('[generate-artwork] Token looks wrong, starts with:', replicateToken.slice(0, 4))
    return NextResponse.json({ error: 'AI artwork generation is temporarily unavailable.' }, { status: 503 })
  }

  const endpoint = MODEL_ENDPOINTS[model] ?? MODEL_ENDPOINTS.flux
  const inputFn   = MODEL_INPUTS[model as keyof typeof MODEL_INPUTS] ?? MODEL_INPUTS.flux

  const replicateRes = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${replicateToken}`,
      'Content-Type': 'application/json',
      Prefer: 'wait',
    },
    body: JSON.stringify({ input: inputFn(finalPrompt) }),
  })

  const prediction = await replicateRes.json()

  if (!replicateRes.ok || prediction.error) {
    await refund()
    console.error('[generate-artwork] Replicate error:', replicateRes.status, JSON.stringify(prediction))
    return NextResponse.json({ error: prediction.detail ?? prediction.error ?? 'Image generation failed' }, { status: 500 })
  }

  let outputUrl: string | null = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output ?? null

  // Poll if still processing
  if (!outputUrl && prediction.urls?.get) {
    try {
      outputUrl = await pollPrediction(prediction.urls.get, replicateToken)
    } catch (err) {
      await refund()
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Generation failed' }, { status: 500 })
    }
  }

  if (!outputUrl) {
    await refund()
    console.error('[generate-artwork] No output. Status:', prediction.status, 'Full:', JSON.stringify(prediction))
    return NextResponse.json({ error: `No image returned (status: ${prediction.status ?? 'unknown'})` }, { status: 500 })
  }

  // Download generated image — save raw bytes, no stamping. Replicate's
  // pixels are exactly what the user paid for; any text overlay belongs in
  // /api/finalize-artwork, not here. Preserving raw bytes also means Finalize
  // never has to deal with text already burned into the source.
  const imageRes = await fetch(outputUrl)
  if (!imageRes.ok) {
    await refund()
    return NextResponse.json({ error: 'Failed to download generated image' }, { status: 500 })
  }
  const imageBytes = Buffer.from(await imageRes.arrayBuffer())
  const contentType = imageRes.headers.get('content-type') ?? 'image/jpeg'
  const extension = contentType.includes('webp') ? 'webp'
    : contentType.includes('png') ? 'png'
    : 'jpg'

  const filename = `${isCollection ? `covers/${targetId}` : targetId}/ai-${Date.now()}.${extension}`
  const { data: uploadData, error: uploadError } = await supabase.storage
    .from('mf-artwork')
    .upload(filename, imageBytes, { contentType, upsert: false })

  if (uploadError) {
    // Don't hand back the raw Replicate URL as a fallback: it expires within
    // ~1 hour and is never persisted (the DB write below only runs on success),
    // so the client would show artwork that 404s on the next reload. Fail loudly
    // so the user retries instead of saving a dead link.
    await refund()
    console.error('[generate-artwork] Supabase upload error:', uploadError.message)
    return NextResponse.json({ error: 'Failed to save generated image. Please try again.' }, { status: 500 })
  }

  const { data: urlData } = supabase.storage.from('mf-artwork').getPublicUrl(uploadData.path)
  const artworkUrl = urlData.publicUrl

  // Persist the URL. For a collection we just set its cover; for a project we
  // set the new source artwork and drop any prior finalized render so the next
  // Finalize pass starts from this fresh source instead of stacking on stale output.
  const { error: dbError } = isCollection
    ? await supabaseAdmin
        .from('mb_collections')
        .update({ cover_url: artworkUrl, updated_at: new Date().toISOString() })
        .eq('id', targetId)
        .eq('user_id', userId)
    : await supabaseAdmin
        .from('mb_projects')
        .update({
          artwork_url: artworkUrl,
          finalized_artwork_url: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', targetId)
        .eq('user_id', userId) // defense-in-depth: scope the write to the owner
  if (dbError) {
    // The image uploaded fine but the URL didn't persist — the next page load
    // would show stale artwork. Hand the reserved slot back and fail loudly so
    // the user retries instead of silently losing a paid generation. Mirrors
    // every other failure path above and finalize-artwork's dbError handling.
    await refund()
    console.error('[generate-artwork] DB update error:', dbError.message)
    return NextResponse.json({ error: 'Saved image but failed to update project. Please retry.' }, { status: 500 })
  }

  return NextResponse.json({ artwork_url: artworkUrl, look })
}
