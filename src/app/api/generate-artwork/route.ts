import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import sharp from 'sharp'

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

async function stampArtwork(imageBuffer: ArrayBuffer, title: string): Promise<Buffer> {
  const img = sharp(Buffer.from(imageBuffer))
  const { width = 1024, height = 1024 } = await img.metadata()

  const label = 'moodmixformat'
  const titleText = title.toUpperCase()

  const fontSize = Math.round(width * 0.055)
  const smallSize = Math.round(width * 0.032)
  const pad = Math.round(width * 0.045)

  // SVG overlay: title top-left, label bottom-left
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="shadow">
          <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000" flood-opacity="0.7"/>
        </filter>
      </defs>
      <text
        x="${pad}" y="${pad + fontSize}"
        font-family="'Futura', 'Century Gothic', 'Trebuchet MS', sans-serif"
        font-size="${fontSize}"
        font-weight="bold"
        fill="white"
        filter="url(#shadow)"
        letter-spacing="2"
      >${titleText}</text>
      <text
        x="${pad}" y="${height - pad}"
        font-family="'Futura', 'Century Gothic', 'Trebuchet MS', sans-serif"
        font-size="${smallSize}"
        font-weight="bold"
        fill="white"
        fill-opacity="0.85"
        filter="url(#shadow)"
        letter-spacing="1"
      >${label}</text>
    </svg>
  `

  return img
    .composite([{ input: Buffer.from(svg), blend: 'over' }])
    .jpeg({ quality: 92 })
    .toBuffer()
}

// POST /api/generate-artwork
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { project_id, prompt, model = 'flux', title = '' } = await request.json()

  if (!prompt?.trim()) {
    return NextResponse.json({ error: 'Prompt is required' }, { status: 400 })
  }

  const replicateToken = process.env.REPLICATE_API_TOKEN?.trim().replace(/^["']|["']$/g, '')
  if (!replicateToken) {
    return NextResponse.json({ error: 'REPLICATE_API_TOKEN not set in environment' }, { status: 500 })
  }
  if (!replicateToken.startsWith('r8_')) {
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
    console.error('[generate-artwork] Replicate error:', replicateRes.status, JSON.stringify(prediction))
    return NextResponse.json({ error: prediction.detail ?? prediction.error ?? 'Image generation failed' }, { status: 500 })
  }

  let outputUrl: string | null = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output ?? null

  // Poll if still processing
  if (!outputUrl && prediction.urls?.get) {
    try {
      outputUrl = await pollPrediction(prediction.urls.get, replicateToken)
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Generation failed' }, { status: 500 })
    }
  }

  if (!outputUrl) {
    console.error('[generate-artwork] No output. Status:', prediction.status, 'Full:', JSON.stringify(prediction))
    return NextResponse.json({ error: `No image returned (status: ${prediction.status ?? 'unknown'})` }, { status: 500 })
  }

  // Download generated image
  const imageRes = await fetch(outputUrl)
  if (!imageRes.ok) {
    return NextResponse.json({ error: 'Failed to download generated image' }, { status: 500 })
  }
  const imageBuffer = await imageRes.arrayBuffer()

  // Stamp with title + moodmixformat branding
  const stamped = await stampArtwork(imageBuffer, title || prompt.split(',')[0].trim())

  const filename = `${project_id}/ai-${Date.now()}.jpg`
  const { data: uploadData, error: uploadError } = await supabase.storage
    .from('mf-artwork')
    .upload(filename, stamped, { contentType: 'image/jpeg', upsert: false })

  if (uploadError) {
    console.error('[generate-artwork] Supabase upload error:', uploadError.message)
    return NextResponse.json({ artwork_url: outputUrl })
  }

  const { data: urlData } = supabase.storage.from('mf-artwork').getPublicUrl(uploadData.path)
  const artworkUrl = urlData.publicUrl

  if (project_id) {
    await supabase
      .from('mb_projects')
      .update({ artwork_url: artworkUrl, updated_at: new Date().toISOString() })
      .eq('id', project_id)
  }

  return NextResponse.json({ artwork_url: artworkUrl })
}
