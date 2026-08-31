import { NextRequest, NextResponse } from 'next/server'
import { checkAndIncrementUsage, refundUsage } from '@/lib/tier'
import { videoLimiter, rateLimitHeaders , checkUserLimit } from '@/lib/rate-limit'
import { storeVisualizer, userOwnsProject } from '@/lib/visualizer-store'
import { isUuid } from '@/lib/validators'

// Runway's slower models (Veo) can take minutes; the poll loop below allows up
// to ~5 min, so give the route room beyond the platform default.
export const maxDuration = 300

const RUNWAY_API_KEY = process.env.RUNWAY_API_KEY
const RUNWAY_BASE = 'https://api.dev.runwayml.com/v1'

// Every outbound call here needs its own deadline: Node's undici enforces no
// response timeout, only a connect timeout, so a server that accepts the socket
// and then answers slowly (or drips one byte at a time) is otherwise unbounded.
const POLL_TIMEOUT_MS = 15_000
const CREATE_TIMEOUT_MS = 30_000
// Wall-clock ceiling for the whole poll loop, matching `maxDuration` above.
const POLL_BUDGET_MS = 300_000
// The finished video is a real file, so it gets a longer, separate budget.
const DOWNLOAD_TIMEOUT_MS = 120_000

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
  const limit = await checkUserLimit(videoLimiter, userId)
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

  // An owned project is REQUIRED, and it is validated here — before the quota
  // gate — because it is exactly the "bad request that must never consume
  // quota" the gate comment below describes.
  //
  // Why it is required at all: a generation that cannot be persisted is not a
  // product. The Runway-hosted URL expires within hours, AiGeneratorCard gates
  // its pin button on `saved`, and finalize-video needs a PINNED visualizer —
  // so an unpersisted clip can never enter the pipeline. Letting the call
  // proceed without an owned project spent a studio user's tightest quota
  // (10/month) on something structurally unusable.
  //
  // It also has to come BEFORE the reservation for a second reason: the
  // persistence failure below now refunds, and if an unowned projectId could
  // still reach that path, anyone could farm unlimited free generations by
  // passing a bogus id. Validating up front closes the burn and the loophole
  // with the same check. Both real callers (Visualizer via ProjectClient and
  // MediaClient) always send one; iOS does not call this route at all.
  if (!isUuid(projectId)) {
    return NextResponse.json({ error: 'A valid projectId is required' }, { status: 400 })
  }
  if (!(await userOwnsProject(userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

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
      { error: `Monthly video limit reached (${gate.used}/${gate.limit}). Your quota resets at the start of next month.`, upgrade: true },
      { status: 403 }
    )
  }

  // The video slot is now reserved. Video is the most expensive call in the app
  // and the tightest quota (studio: 10/mo), so every failure path below must hand
  // the slot back — a Runway error or timeout must not burn a paid generation.
  // Refund the SAME month that was reserved (gate.month) so a generation that
  // straddles a UTC month boundary can't refund the wrong month.
  //
  // GUARDED AGAINST DOUBLE-REFUND. `refundUsage` is read-then-write and NOT
  // idempotent, so calling it twice decrements twice — handing the user a free
  // paid generation. This used to rely on the claim that "every inner failure
  // path refunds and RETURNS, so it never reaches the outer catch". That claim
  // was false for exactly one branch: the `!createRes.ok` path refunds and then
  // calls `createRes.text()`, which is outside the inner try — a connection
  // reset while reading the error body unwinds to the outer catch and refunds a
  // second time. The flag makes the invariant structural instead of a property
  // every future edit has to re-derive.
  let refunded = false
  const refund = async () => {
    if (refunded) return
    refunded = true
    await refundUsage(userId, 'video', gate.month)
  }

  // The whole create+poll region is wrapped so a network error or malformed-JSON
  // throw (createRes.json / pollRes.json, or the fetches themselves) refunds the
  // reserved slot instead of escaping uncaught as a 500 that silently burns the
  // user's tightest quota.
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
      signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
    })

    if (!createRes.ok) {
      await refund()
      const errText = await createRes.text()
      console.error('Runway create error:', createRes.status, errText)
      try {
        const errData = JSON.parse(errText)
        if (errData.error?.includes('credits')) {
          // Neutral, operator-facing detail stays in the server log above.
          // Never tell CLIENTS to go buy credits somewhere — the iOS app
          // renders these strings and App Store Guideline 3.1.1 forbids
          // steering users to external purchases.
          return NextResponse.json({ error: 'Video generation is temporarily unavailable. Please try again later.' }, { status: 402 })
        }
        // Upstream error strings can mention anything (pricing, credits, plans)
        // — don't relay them to clients verbatim.
        return NextResponse.json({ error: 'Video generation failed. Please try again.' }, { status: 502 })
      } catch {
        return NextResponse.json({ error: 'Runway generation failed' }, { status: 502 })
      }
    }

    const task = await createRes.json()
    const taskId = task.id
    if (!taskId) {
      // Without an id every poll below would hit `/tasks/undefined` and 404 its
      // way through the whole budget before reporting a timeout that never was.
      await refund()
      return NextResponse.json({ error: 'Runway did not return a task id' }, { status: 502 })
    }

    // Poll for completion. The budget is WALL-CLOCK, not an attempt count: the
    // old `maxAttempts = 100` bounded only the number of probes, so if Runway
    // slowed to ~20s per response the loop ran 100 × (3s + 20s) ≈ 38 minutes
    // while holding the reserved slot, then reported "timed out (5 min)" — a
    // message that was simply false. Same fix, same reasoning as the artwork
    // route's POLL_BUDGET_MS. (`maxDuration` is advisory: Railway runs plain
    // `next start`, which does not enforce it, so nothing else would cut this
    // off.) Each probe also gets its own deadline, because undici applies no
    // response timeout of its own and a slow-drip responder is otherwise
    // unbounded.
    const deadline = Date.now() + POLL_BUDGET_MS
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000))

      let pollRes: Response
      try {
        pollRes = await fetch(`${RUNWAY_BASE}/tasks/${taskId}`, {
          headers: {
            'Authorization': `Bearer ${RUNWAY_API_KEY}`,
            'X-Runway-Version': '2024-11-06',
          },
          signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
        })
      } catch {
        // A timed-out probe is transient — Runway may still be rendering. Retry
        // on the next tick rather than unwinding to the outer catch: one flaky
        // poll must not cancel a generation that is about to succeed. Falling
        // out of the loop hits the timeout refund below, so this adds no new
        // refund path.
        continue
      }

      if (!pollRes.ok) {
        // 401/403/404 never become 200 by waiting — a rotated key or an unknown
        // task id would otherwise burn the entire budget before reporting a
        // timeout. Fail fast and hand the slot back.
        if (pollRes.status === 401 || pollRes.status === 403 || pollRes.status === 404) {
          await refund()
          console.error(`[runway] poll rejected permanently: ${pollRes.status}`)
          return NextResponse.json({ error: 'Runway generation failed' }, { status: 502 })
        }
        console.warn(`Runway poll failed: ${pollRes.status}`)
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
        // Ownership was settled before the slot was reserved, so this is purely
        // the persistence attempt now.
        try {
          const vidRes = await fetch(runwayUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
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

        if (!saved) {
          // Runway succeeded but the bytes never reached mf-video. The user is
          // left holding a URL that expires within hours, and because the pin
          // button is gated on `saved`, it can never reach finalize-video — so
          // the quota bought nothing durable. That is our infrastructure's
          // failure, not a user action, and it is not farmable now that an
          // owned project is required up front. Hand the slot back and still
          // return the transient URL so they can at least watch/download it.
          await refund()
          console.error(`[runway] generation succeeded but persistence failed for project ${projectId} — video slot refunded`)
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
    // Derived from the budget so the number in the message can't drift away
    // from the number actually enforced — the old copy said "5 min" while the
    // loop could run for 38.
    return NextResponse.json(
      { error: `Runway generation timed out (${Math.round(POLL_BUDGET_MS / 60_000)} min)` },
      { status: 504 }
    )
  } catch (err) {
    // Network blip or malformed JSON after the slot was reserved — refund so a
    // transient failure doesn't burn the tightest, most expensive quota, then
    // surface a retryable 502.
    await refund()
    console.error('[runway] uncaught error after slot reserved:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Video generation failed unexpectedly. Please try again.' }, { status: 502 })
  }
}
