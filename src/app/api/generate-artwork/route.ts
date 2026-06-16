import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { supabaseAdmin } from '@/lib/supabase'
import { checkAndIncrementUsage, refundUsage } from '@/lib/tier'
import { artworkLimiter } from '@/lib/rate-limit'
import { isUuid } from '@/lib/validators'

// Allow up to 2 minutes — Flux 2 Pro can take 30-60s
export const maxDuration = 120

const MODEL_ENDPOINTS: Record<string, string> = {
  flux: 'https://api.replicate.com/v1/models/black-forest-labs/flux-2-pro/predictions',
  imagen: 'https://api.replicate.com/v1/models/google/imagen-4/predictions',
}

const MODEL_INPUTS = {
  flux:   (prompt: string) => ({ prompt, aspect_ratio: '1:1', output_format: 'webp', output_quality: 95 }),
  imagen: (prompt: string) => ({ prompt, aspect_ratio: '1:1', safety_filter_level: 'block_only_high' }),
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
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429 })
  }

  const supabase = await createClient()
  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const { project_id, prompt, model = 'flux' } = body

  if (!prompt?.trim()) {
    return NextResponse.json({ error: 'Prompt is required' }, { status: 400 })
  }

  // Reject malformed project ids before they reach a storage key or DB write.
  if (!isUuid(project_id)) {
    return NextResponse.json({ error: 'Valid project_id is required' }, { status: 400 })
  }

  // Ownership check: the artwork write below targets this project, so confirm
  // the caller actually owns it. Without this, an authenticated user could
  // overwrite another user's project artwork by passing their project_id (IDOR).
  const { data: ownerRow, error: ownerErr } = await supabaseAdmin
    .from('mb_projects')
    .select('id')
    .eq('id', project_id)
    .eq('user_id', userId)
    .single()
  if (ownerErr || !ownerRow) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  // Gate: check monthly artwork limit before hitting Replicate
  const gate = await checkAndIncrementUsage(userId, 'artwork')
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
    return NextResponse.json({ error: 'REPLICATE_API_TOKEN not set in environment' }, { status: 500 })
  }
  if (!replicateToken.startsWith('r8_')) {
    await refund()
    console.error('[generate-artwork] Token looks wrong, starts with:', replicateToken.slice(0, 4))
    return NextResponse.json({ error: `Token format invalid (starts with "${replicateToken.slice(0, 4)}", expected "r8_")` }, { status: 500 })
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
    body: JSON.stringify({ input: inputFn(prompt.trim()) }),
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

  const filename = `${project_id}/ai-${Date.now()}.${extension}`
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

  // New source artwork — drop any prior finalized render so the next Finalize
  // pass starts from this fresh source instead of stacking onto stale output.
  const { error: dbError } = await supabaseAdmin
    .from('mb_projects')
    .update({
      artwork_url: artworkUrl,
      finalized_artwork_url: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', project_id)
    .eq('user_id', userId) // defense-in-depth: scope the write to the owner
  if (dbError) {
    console.error('[generate-artwork] DB update error:', dbError.message)
  }

  return NextResponse.json({ artwork_url: artworkUrl })
}
