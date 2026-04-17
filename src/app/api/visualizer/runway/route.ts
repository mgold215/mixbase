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

  if (!imageUrl.startsWith('https://mdefkqaawrusoaojstpq.supabase.co/')) {
    return NextResponse.json({ error: 'imageUrl must be a Supabase storage URL' }, { status: 400 })
  }

  const motionPrompts: Record<string, string> = {
    canvas:  'Slow cinematic drift, subtle atmospheric shimmer, ambient light play, looping, no text, no faces',
    youtube: 'Cinematic slow pan, ethereal light waves, ambient motion, no text, no faces',
    square:  'Gentle pulse, soft light bloom, subtle motion, looping, no text, no faces',
    story:   'Slow vertical drift, dreamy light shimmer, looping, no text, no faces',
  }
  const promptText = motionPrompts[format] ?? motionPrompts.canvas

  // gen4_turbo: valid durations are 5 or 10; valid ratios are 1280:720 (landscape) and 720:1280 (portrait)
  const runwayDuration = (duration && duration >= 8) ? 10 : 5
  const runwayRatio = format === 'youtube' ? '1280:720' : '720:1280'

  // Create Runway task
  const createRes = await fetch('https://api.runwayml.com/v1/image_to_video', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RUNWAY_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Runway-Version': '2024-11-06',
    },
    body: JSON.stringify({
      model: 'gen4_turbo',
      promptImage: imageUrl,
      promptText,
      duration: runwayDuration,
      ratio: runwayRatio,
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

    const pollRes = await fetch(`https://api.runwayml.com/v1/tasks/${taskId}`, {
      headers: {
        'Authorization': `Bearer ${RUNWAY_API_KEY}`,
        'X-Runway-Version': '2024-11-06',
      },
    })

    if (!pollRes.ok) {
      console.warn(`Runway poll attempt ${i + 1} failed: ${pollRes.status}`)
      continue
    }

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
