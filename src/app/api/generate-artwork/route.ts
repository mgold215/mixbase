import { NextRequest, NextResponse } from 'next/server'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { updateProject } from '@/lib/localdb'

export async function POST(request: NextRequest) {
  const { project_id, prompt } = await request.json()

  if (!prompt?.trim()) {
    return NextResponse.json({ error: 'Prompt is required' }, { status: 400 })
  }

  const replicateToken = process.env.REPLICATE_API_TOKEN
  if (!replicateToken) {
    return NextResponse.json({ error: 'Replicate API token not configured' }, { status: 500 })
  }

  // Call Replicate FLUX.1-schnell model
  const replicateRes = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${replicateToken}`,
      'Content-Type': 'application/json',
      'Prefer': 'wait',
    },
    body: JSON.stringify({
      input: {
        prompt: prompt.trim(),
        aspect_ratio: '1:1',
        output_format: 'jpg',
        output_quality: 90,
        num_outputs: 1,
      },
    }),
  })

  const prediction = await replicateRes.json()

  if (!replicateRes.ok || prediction.error) {
    return NextResponse.json({ error: prediction.error ?? 'Image generation failed' }, { status: 500 })
  }

  const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output
  if (!outputUrl) {
    return NextResponse.json({ error: 'No image returned from generator' }, { status: 500 })
  }

  // Download and store locally
  try {
    const imageRes = await fetch(outputUrl)
    const imageBuffer = await imageRes.arrayBuffer()
    const filename = `ai-${Date.now()}.jpg`
    const uploadDir = join(process.cwd(), 'public', 'uploads', 'artwork', project_id)
    if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true })
    writeFileSync(join(uploadDir, filename), new Uint8Array(imageBuffer))
    const artworkUrl = `/uploads/artwork/${project_id}/${filename}`

    if (project_id) {
      updateProject(project_id, { artwork_url: artworkUrl })
    }

    return NextResponse.json({ artwork_url: artworkUrl })
  } catch {
    // Fall back to Replicate URL if local save fails
    if (project_id) {
      updateProject(project_id, { artwork_url: outputUrl })
    }
    return NextResponse.json({ artwork_url: outputUrl })
  }
}
