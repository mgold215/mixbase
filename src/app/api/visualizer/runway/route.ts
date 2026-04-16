import { NextResponse } from 'next/server'

const RUNWAY_API_KEY = process.env.RUNWAY_API_KEY

export async function POST(req: Request) {
  if (!RUNWAY_API_KEY) {
    return NextResponse.json({ error: 'RUNWAY_API_KEY not configured' }, { status: 501 })
  }

  const { imageUrl, format, duration } = await req.json()

  if (!imageUrl || !format) {
    return NextResponse.json({ error: 'imageUrl and format are required' }, { status: 400 })
  }

  const motionPrompts: Record<string, string> = {
    canvas:  'Slow cinematic drift, subtle atmospheric shimmer, ambient light play, looping, no text, no faces',
    youtube: 'Cinematic slow pan, ethereal light waves, ambient motion, no text, no faces',
    square:  'Gentle pulse, soft light bloom, subtle motion, looping, no text, no faces',
    story:   'Slow vertical drift, dreamy light shimmer, looping, no text, no faces',
  }
  const promptText = motionPrompts[format] ?? motionPrompts.canvas

  // Create Runway task
  const createRes = await fetch('https://api.dev.runwayml.com/v1/image_to_video', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RUNWAY_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Runway-Version': '2024-11-06',
    },
    body: JSON.stringify({
      model: 'gen3a_turbo',
      promptImage: imageUrl,
      promptText,
      duration: Math.min(duration ?? 6, 10), // Runway max is 10s
      ratio: format === 'youtube' ? '1280:768' : '768:1280',
    }),
  })

  if (!createRes.ok) {
    const err = await createRes.text()
    console.error('Runway create error:', err)
    return NextResponse.json({ error: 'Runway generation failed' }, { status: 502 })
  }

  const task = await createRes.json()
  const taskId = task.id

  // Poll for completion (max 3 minutes, every 3 seconds)
  const maxAttempts = 60
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 3000))

    const pollRes = await fetch(`https://api.dev.runwayml.com/v1/tasks/${taskId}`, {
      headers: {
        'Authorization': `Bearer ${RUNWAY_API_KEY}`,
        'X-Runway-Version': '2024-11-06',
      },
    })

    if (!pollRes.ok) continue

    const pollData = await pollRes.json()

    if (pollData.status === 'SUCCEEDED') {
      const videoUrl = pollData.output?.[0]
      if (!videoUrl) return NextResponse.json({ error: 'No video in Runway response' }, { status: 502 })
      return NextResponse.json({ videoUrl })
    }

    if (pollData.status === 'FAILED') {
      return NextResponse.json({ error: 'Runway task failed' }, { status: 502 })
    }
    // PENDING or RUNNING — keep polling
  }

  return NextResponse.json({ error: 'Runway generation timed out' }, { status: 504 })
}
