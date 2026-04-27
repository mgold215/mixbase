import { NextRequest, NextResponse } from 'next/server'

const RUNWAY_API_KEY = process.env.RUNWAY_API_KEY
const RUNWAY_BASE = 'https://api.dev.runwayml.com/v1'

// All Runway image-to-video models with their valid parameters.
// Update this when Runway adds/removes models — the frontend reads it via GET.
const MODELS: Record<string, { label: string; durations: number[]; ratios: string[] }> = {
  gen4_turbo:  { label: 'Gen-4 Turbo',    durations: [5, 10],       ratios: ['1280:720', '720:1280', '1104:832', '832:1104', '960:960', '1584:672'] },
  'gen4.5':    { label: 'Gen-4.5',        durations: [5, 10],       ratios: ['1280:720', '720:1280', '1104:832', '960:960', '832:1104', '1584:672'] },
  seedance2:   { label: 'Seedance 2.0',   durations: [5, 10, 15],   ratios: ['720:1280', '1280:720', '960:960', '1112:834', '834:1112'] },
  veo3:        { label: 'Veo 3',          durations: [8],            ratios: ['1280:720', '720:1280', '1080:1920', '1920:1080'] },
  'veo3.1':    { label: 'Veo 3.1',       durations: [4, 6, 8],     ratios: ['1280:720', '720:1280', '1080:1920', '1920:1080'] },
  veo3_1_fast: { label: 'Veo 3.1 Fast',  durations: [4, 6, 8],     ratios: ['1280:720', '720:1280', '1080:1920', '1920:1080'] },
}

// Map friendly ratio names for the frontend
const RATIO_LABELS: Record<string, string> = {
  '720:1280':  '9:16 portrait',
  '1280:720':  '16:9 landscape',
  '960:960':   '1:1 square',
  '1080:1920': '9:16 full HD',
  '1920:1080': '16:9 full HD',
  '1104:832':  '4:3 landscape',
  '832:1104':  '3:4 portrait',
  '1584:672':  '21:9 ultrawide',
  '1112:834':  '4:3 landscape',
  '834:1112':  '3:4 portrait',
}

// GET /api/visualizer/runway — returns available models + their valid params
export async function GET() {
  const models = Object.entries(MODELS).map(([id, cfg]) => ({
    id,
    label: cfg.label,
    durations: cfg.durations,
    ratios: cfg.ratios.map(r => ({ value: r, label: RATIO_LABELS[r] || r })),
  }))
  return NextResponse.json({ models })
}

// POST /api/visualizer/runway — generate a video
export async function POST(req: NextRequest) {
  if (!RUNWAY_API_KEY) {
    return NextResponse.json({ error: 'RUNWAY_API_KEY not configured' }, { status: 501 })
  }

  const { imageUrl, promptText: customPrompt, model: requestedModel, duration, ratio } = await req.json()

  if (!imageUrl) {
    return NextResponse.json({ error: 'imageUrl is required' }, { status: 400 })
  }

  if (!imageUrl.startsWith('https://mdefkqaawrusoaojstpq.supabase.co/')) {
    return NextResponse.json({ error: 'imageUrl must be a Supabase storage URL' }, { status: 400 })
  }

  // Resolve model — default to gen4_turbo
  const modelId = requestedModel && MODELS[requestedModel] ? requestedModel : 'gen4_turbo'
  // veo3.1_fast uses "veo3.1_fast" in our config but the API expects "veo3.1_fast"
  const apiModelId = modelId === 'veo3_1_fast' ? 'veo3.1_fast' : modelId
  const modelCfg = MODELS[modelId]

  // Resolve duration — pick closest valid value for this model
  const targetDuration = duration ?? modelCfg.durations[0]
  const runwayDuration = modelCfg.durations.reduce((best, d) =>
    Math.abs(d - targetDuration) < Math.abs(best - targetDuration) ? d : best
  )

  // Resolve ratio — use requested if valid for this model, otherwise pick best match
  const runwayRatio = ratio && modelCfg.ratios.includes(ratio)
    ? ratio
    : modelCfg.ratios.includes('720:1280') ? '720:1280' : modelCfg.ratios[0]

  const promptText = customPrompt?.trim() || 'Slow cinematic drift, subtle atmospheric shimmer, ambient light play, looping, no text, no faces'

  // Create Runway task
  const createRes = await fetch(`${RUNWAY_BASE}/image_to_video`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RUNWAY_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Runway-Version': '2024-11-06',
    },
    body: JSON.stringify({
      model: apiModelId,
      promptImage: imageUrl,
      promptText,
      duration: runwayDuration,
      ratio: runwayRatio,
    }),
  })

  if (!createRes.ok) {
    const errText = await createRes.text()
    console.error('Runway create error:', createRes.status, errText)
    try {
      const errData = JSON.parse(errText)
      if (errData.error?.includes('credits')) {
        return NextResponse.json({ error: 'Runway account has no credits remaining. Add credits at dev.runwayml.com.' }, { status: 402 })
      }
      return NextResponse.json({ error: errData.error || 'Runway generation failed' }, { status: 502 })
    } catch {
      return NextResponse.json({ error: 'Runway generation failed' }, { status: 502 })
    }
  }

  const task = await createRes.json()
  const taskId = task.id

  // Poll for completion (max 5 minutes for slower models like Veo, every 3 seconds)
  const maxAttempts = 100
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 3000))

    const pollRes = await fetch(`${RUNWAY_BASE}/tasks/${taskId}`, {
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
      return NextResponse.json({ videoUrl, model: modelCfg.label })
    }

    if (pollData.status === 'FAILED') {
      const failReason = pollData.failure ?? 'Unknown'
      return NextResponse.json({ error: `Runway task failed: ${failReason}` }, { status: 502 })
    }
    // PENDING or RUNNING — keep polling
  }

  return NextResponse.json({ error: 'Runway generation timed out (5 min)' }, { status: 504 })
}
