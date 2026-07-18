import { NextRequest, NextResponse } from 'next/server'
import { checkAndIncrementUsage, refundUsage } from '@/lib/tier'
import { videoLimiter, rateLimitHeaders } from '@/lib/rate-limit'
import { storeVisualizer, userOwnsProject } from '@/lib/visualizer-store'
import { isUuid } from '@/lib/validators'

// Runway's slower models (Veo) can take minutes; the poll loop below allows up
// to ~5 min, so give the route room beyond the platform default.
export const maxDuration = 300

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

  // Require an authenticated caller — middleware injects X-User-Id for non-public routes.
  // Without this the most expensive AI call in the app was reachable with no per-user
  // accounting at all.
  const userId = req.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // Rate limit: 5/hour per user — defence-in-depth alongside the monthly tier gate below.
  const limit = videoLimiter.check(userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const { imageUrl, promptText: customPrompt, model: requestedModel, duration, ratio, projectId } = body

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

  // Runway image-to-video adheres best when the text describes MOTION ONLY — the
  // image already defines the scene/style. Style/atmosphere keywords dilute the
  // signal and read as "the prompt was ignored", so the default is motion-first.
  // The API also rejects promptText over 1000 chars, so clamp to avoid a silent
  // create failure on long pastes.
  const promptText = (customPrompt?.trim() || 'Slow cinematic camera push-in with gentle parallax, subtle continuous motion throughout the scene, smooth seamless loop').slice(0, 1000)

  // Monthly tier gate — enforces the per-plan video quota (free/pro: 0, studio: 10).
  // Placed after input validation but before the paid Runway call so a bad request
  // never consumes quota. Mirrors generate-artwork's gate.
  const gate = await checkAndIncrementUsage(userId, 'video')
  if (gate.error) {
    // Couldn't reserve a slot (usage RPC failed) — don't run the paid call.
    return NextResponse.json({ error: 'Could not reserve a generation slot. Please try again.' }, { status: 503 })
  }
  if (!gate.allowed) {
    return NextResponse.json(
      { error: `Monthly video limit reached (${gate.used}/${gate.limit}). Upgrade to generate more.`, upgrade: true },
      { status: 403 }
    )
  }

  // The video slot is now reserved. Video is the most expensive call in the app
  // and the tightest quota (studio: 10/mo), so every failure path below must hand
  // the slot back — a Runway error or timeout must not burn a paid generation.
  // Refund the SAME month that was reserved (gate.month) so a generation that
  // straddles a UTC month boundary can't refund the wrong month.
  const refund = () => refundUsage(userId, 'video', gate.month)

  // The whole create+poll region is wrapped so a network error or malformed-JSON
  // throw (createRes.json / pollRes.json, or the fetches themselves) refunds the
  // reserved slot instead of escaping uncaught as a 500 that silently burns the
  // user's tightest quota. Every inner failure path refunds and RETURNS, so it
  // never reaches this catch — the catch handles only a genuine throw, and can't
  // double-refund.
  try {
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
      await refund()
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
        const runwayUrl = pollData.output?.[0]
        if (!runwayUrl) {
          await refund()
          return NextResponse.json({ error: 'No video in Runway response' }, { status: 502 })
        }

        // Runway-hosted URLs expire within hours, so persist the bytes to mf-video
        // and index the result — that's what makes it findable in the Media library.
        // If anything in the persistence path fails, fall back to the transient URL
        // so the user still sees the video they paid for.
        let videoUrl = runwayUrl
        let saved = false
        let visualizerId: string | null = null
        if (isUuid(projectId) && (await userOwnsProject(userId, projectId))) {
          try {
            const vidRes = await fetch(runwayUrl)
            if (vidRes.ok) {
              const bytes = Buffer.from(await vidRes.arrayBuffer())
              const contentType = vidRes.headers.get('content-type') ?? 'video/mp4'
              const stored = await storeVisualizer({
                userId,
                projectId,
                bytes,
                contentType,
                kind: 'ai',
                title: `${modelCfg.label} · ${runwayDuration}s`,
                sourceImageUrl: imageUrl,
              })
              if (stored) {
                videoUrl = stored.video_url
                visualizerId = stored.id || null
                saved = true
              }
            }
          } catch (e) {
            console.error('[runway] persist to Media failed:', e)
          }
        }

        return NextResponse.json({ videoUrl, model: modelCfg.label, saved, visualizerId })
      }

      if (pollData.status === 'FAILED') {
        await refund()
        const failReason = pollData.failure ?? 'Unknown'
        return NextResponse.json({ error: `Runway task failed: ${failReason}` }, { status: 502 })
      }
      // PENDING or RUNNING — keep polling
    }

    await refund()
    return NextResponse.json({ error: 'Runway generation timed out (5 min)' }, { status: 504 })
  } catch (err) {
    // Network blip or malformed JSON after the slot was reserved — refund so a
    // transient failure doesn't burn the tightest, most expensive quota, then
    // surface a retryable 502.
    await refund()
    console.error('[runway] uncaught error after slot reserved:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Video generation failed unexpectedly. Please try again.' }, { status: 502 })
  }
}
