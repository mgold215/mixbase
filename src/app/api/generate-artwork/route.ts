import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

const MODEL_ENDPOINTS: Record<string, string> = {
  flux: 'https://api.replicate.com/v1/models/black-forest-labs/flux-2-pro/predictions',
  imagen: 'https://api.replicate.com/v1/models/google/imagen-4/predictions',
}

const MODEL_INPUTS = {
  flux: (prompt: string) => ({ prompt, aspect_ratio: '1:1', output_format: 'jpg', output_quality: 90 }),
  imagen: (prompt: string) => ({ prompt, aspect_ratio: '1:1', safety_filter_level: 'block_only_high' }),
}

// POST /api/generate-artwork — generate AI artwork using Replicate
export async function POST(request: NextRequest) {
  const { project_id, prompt, model = 'flux' } = await request.json()

  if (!prompt?.trim()) {
    return NextResponse.json({ error: 'Prompt is required' }, { status: 400 })
  }

  const replicateToken = process.env.REPLICATE_API_TOKEN
  if (!replicateToken) {
    return NextResponse.json({ error: 'Replicate API token not configured' }, { status: 500 })
  }

  const endpoint = MODEL_ENDPOINTS[model] ?? MODEL_ENDPOINTS.flux
  const inputFn = MODEL_INPUTS[model as keyof typeof MODEL_INPUTS] ?? MODEL_INPUTS.flux

  const replicateRes = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${replicateToken}`,
      'Content-Type': 'application/json',
      'Prefer': 'wait',
    },
    body: JSON.stringify({ input: inputFn(prompt.trim()) }),
  })

  const prediction = await replicateRes.json()

  if (!replicateRes.ok || prediction.error) {
    return NextResponse.json({ error: prediction.error ?? 'Image generation failed' }, { status: 500 })
  }

  // Replicate returns array for Flux, single string for Imagen
  const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output

  if (!outputUrl) {
    return NextResponse.json({ error: 'No image returned from generator' }, { status: 500 })
  }

  // Download the image and store it in Supabase Storage for permanence
  const imageRes = await fetch(outputUrl)
  const imageBuffer = await imageRes.arrayBuffer()

  const filename = `${project_id}/ai-${Date.now()}.jpg`
  const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
    .from('mf-artwork')
    .upload(filename, new Uint8Array(imageBuffer), {
      contentType: 'image/jpeg',
      upsert: false,
    })

  if (uploadError) {
    // Fall back to Replicate URL if upload fails (it may expire)
    return NextResponse.json({ artwork_url: outputUrl })
  }

  const { data: urlData } = supabaseAdmin.storage.from('mf-artwork').getPublicUrl(uploadData.path)
  const artworkUrl = urlData.publicUrl

  // Update the project artwork
  if (project_id) {
    await supabaseAdmin
      .from('mf_projects')
      .update({ artwork_url: artworkUrl, updated_at: new Date().toISOString() })
      .eq('id', project_id)
  }

  return NextResponse.json({ artwork_url: artworkUrl })
}
