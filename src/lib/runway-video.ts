// Runway image-to-video for the Cassette Studio's moving scenes — one still
// in, one clip out (bytes). The public /api/visualizer/runway route keeps its
// own request/quota handling; this is the plain call the Studio's one-click
// flow (src/lib/cassette-quick.ts) makes from a background job.
//
// Models are tried in order: the first is the best-looking, the next ones
// are what the account can still render if the first is not enabled or
// rejects the input. Every outbound call has its own deadline (undici has no
// response timeout of its own — see the route for the history).

const RUNWAY_BASE = 'https://api.dev.runwayml.com/v1'
const VERSION = '2024-11-06'
const CREATE_TIMEOUT_MS = 30_000
const POLL_TIMEOUT_MS = 15_000
const POLL_BUDGET_MS = 7 * 60_000
const DOWNLOAD_TIMEOUT_MS = 120_000

export class VideoUnavailable extends Error {}

export type ClipShape = 'portrait' | 'landscape'

/** The models the Studio films with, best first, and how each is asked for each shape. */
export const STUDIO_VIDEO_MODELS: { id: string; label: string; duration: number; ratio: Record<ClipShape, string> }[] = [
  { id: 'veo3.1', label: 'Veo 3.1', duration: 8, ratio: { portrait: '1080:1920', landscape: '1920:1080' } },
  { id: 'gen4.5', label: 'Gen-4.5', duration: 10, ratio: { portrait: '720:1280', landscape: '1280:720' } },
  { id: 'gen4_turbo', label: 'Gen-4 Turbo', duration: 10, ratio: { portrait: '720:1280', landscape: '1280:720' } },
]

function apiKey(): string {
  const key = process.env.RUNWAY_API_KEY?.trim()
  if (!key) throw new VideoUnavailable('RUNWAY_API_KEY not configured')
  return key
}

/**
 * Film `imageUrl` (a public Supabase Storage URL) as a `shape` clip driven by
 * `promptText` (motion only — the image already defines the scene). Returns
 * the clip bytes and which model made it. Throws VideoUnavailable when the
 * key is missing or the account is out of credits, Error for anything else.
 */
export async function filmStill(imageUrl: string, promptText: string, shape: ClipShape): Promise<{ bytes: Buffer; model: string }> {
  const key = apiKey()
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Runway-Version': VERSION }
  let taskId: string | null = null
  let used = ''
  let lastErr = ''
  for (const m of STUDIO_VIDEO_MODELS) {
    const res = await fetch(`${RUNWAY_BASE}/image_to_video`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: m.id, promptImage: imageUrl, promptText: promptText.slice(0, 1000), duration: m.duration, ratio: m.ratio[shape] }),
      signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
    })
    if (res.ok) {
      const task = await res.json().catch(() => null) as { id?: string } | null
      if (task?.id) { taskId = task.id; used = m.label; break }
      lastErr = 'no task id'
      continue
    }
    const text = await res.text().catch(() => '')
    lastErr = `${m.id} ${res.status}: ${text.slice(0, 300)}`
    console.error('[runway-video] create rejected:', lastErr)
    if (/credit/i.test(text)) throw new VideoUnavailable('video credits exhausted')
    if (res.status === 401 || res.status === 403) throw new VideoUnavailable(`runway rejected the key (${res.status})`)
    // 400/404/422 (model not enabled, input rejected) → try the next model; 5xx → also worth a second model.
  }
  if (!taskId) throw new Error(`no video model accepted the request (${lastErr})`)

  const deadline = Date.now() + POLL_BUDGET_MS
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 4000))
    let poll: Response
    try {
      poll = await fetch(`${RUNWAY_BASE}/tasks/${taskId}`, { headers: { Authorization: `Bearer ${key}`, 'X-Runway-Version': VERSION }, signal: AbortSignal.timeout(POLL_TIMEOUT_MS) })
    } catch {
      continue
    }
    if (!poll.ok) {
      if (poll.status === 401 || poll.status === 403 || poll.status === 404) throw new Error(`runway poll rejected (${poll.status})`)
      continue
    }
    const data = await poll.json().catch(() => null) as { status?: string; output?: string[]; failure?: string } | null
    if (data?.status === 'SUCCEEDED') {
      const url = data.output?.[0]
      if (!url) throw new Error('runway returned no video')
      const vid = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
      if (!vid.ok) throw new Error(`runway video download failed (${vid.status})`)
      return { bytes: Buffer.from(await vid.arrayBuffer()), model: used }
    }
    if (data?.status === 'FAILED') throw new Error(`runway task failed: ${String(data.failure ?? 'unknown')}`.slice(0, 300))
  }
  throw new Error('runway task timed out')
}
