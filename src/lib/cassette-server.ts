// Cassette Studio — server-side plumbing: where the studio's files live,
// how they're read back, and the Replicate calls (cut-out + scene fill).
//
// ── STORAGE LAYOUT (mf-artwork) ─────────────────────────────────────────────
//   studio/<userId>/subject-<ts>.png               a cut-out cassette (reused across projects)
//   studio/<userId>/lettering-<projectId>-<ts>.png one handwriting lockup for one project
//   studio/<userId>/tmp-<ts>-*.{jpg,png}           FLUX/cut-out inputs, deleted after each call
//   studio/<userId>/plate-<ts>.jpg                 a cover's scene plate        ┐ moving-cover inputs,
//   studio/<userId>/layer-<ts>-<left>-<top>.png    its finished cassette layer  │ written by every render
//   studio/<userId>/title-<fts>-<pos>-<size>.png   its coloured lettering       ┘ (parseStudioMotionKey)
//
// Deliberately NOT under `<projectId>/`: Artwork History lists that prefix and
// offers every object in it as a restorable cover. A cut-out cassette or a bare
// lettering PNG is a tool, not a cover, so it lives in the user's own studio
// folder. The final images DO go under `<projectId>/` (ai-cassette-<ts>.jpg,
// cassette-<ts>.jpg, finalized-<ts>.jpg) so they join that history like any
// other artwork. Account deletion removes `studio/<userId>/` (see
// removeStudioFolder, called from /api/auth/delete-account).

import { supabaseAdmin } from '@/lib/supabase'
import { studioPrefix } from '@/lib/cassette-studio'

export { studioPrefix, isOwnStudioKey } from '@/lib/cassette-studio'

export const STUDIO_BUCKET = 'mf-artwork'

export const studioPublicUrl = (path: string) =>
  supabaseAdmin.storage.from(STUDIO_BUCKET).getPublicUrl(path).data.publicUrl

export type StudioFile = { path: string; url: string; createdAt: string | null }

/**
 * List the caller's studio folder, newest first. `search` narrows the listing
 * to names matching it (Storage's own filter; callers still check each key's
 * exact shape). Every render adds two or three motion-layer files to the
 * folder, so lookups for one kind of file pass the leaf's leading part rather
 * than relying on it landing inside one page of everything.
 */
export async function listStudio(userId: string, search?: string): Promise<StudioFile[]> {
  const prefix = studioPrefix(userId)
  const { data, error } = await supabaseAdmin.storage
    .from(STUDIO_BUCKET)
    .list(prefix.slice(0, -1), { limit: 1000, sortBy: { column: 'created_at', order: 'desc' }, ...(search ? { search } : {}) })
  if (error) throw new Error(error.message)
  return (data ?? [])
    .filter(e => e.name && !e.name.startsWith('tmp-'))
    .map(e => ({ path: `${prefix}${e.name}`, url: studioPublicUrl(`${prefix}${e.name}`), createdAt: e.created_at ?? null }))
}

export async function downloadStudio(path: string): Promise<Buffer> {
  const { data, error } = await supabaseAdmin.storage.from(STUDIO_BUCKET).download(path)
  if (error || !data) throw new Error(error?.message ?? 'not found')
  return Buffer.from(await data.arrayBuffer())
}

export async function uploadStudio(path: string, bytes: Buffer, contentType: string): Promise<string> {
  const { error } = await supabaseAdmin.storage.from(STUDIO_BUCKET).upload(path, bytes, { contentType, upsert: false })
  if (error) throw new Error(error.message)
  return studioPublicUrl(path)
}

export async function removeStudio(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  const { error } = await supabaseAdmin.storage.from(STUDIO_BUCKET).remove(paths)
  if (error) console.error('[cassette-studio] remove failed:', error.message)
}

/**
 * Account deletion: remove everything under studio/<userId>/. Every key there
 * is attributed to this user by its prefix alone, so no survivor scan is
 * needed. Best-effort, like the rest of the storage cleanup on that path.
 */
export async function removeStudioFolder(userId: string): Promise<void> {
  try {
    const prefix = studioPrefix(userId)
    for (let guard = 0; guard < 20; guard++) {
      const { data, error } = await supabaseAdmin.storage.from(STUDIO_BUCKET).list(prefix.slice(0, -1), { limit: 1000 })
      if (error) { console.error('[cassette-studio] studio listing failed:', error.message); return }
      const keys = (data ?? []).filter(e => e.name).map(e => `${prefix}${e.name}`)
      if (keys.length === 0) return
      const { error: rmErr } = await supabaseAdmin.storage.from(STUDIO_BUCKET).remove(keys)
      if (rmErr) { console.error('[cassette-studio] studio remove failed:', rmErr.message); return }
    }
  } catch (err) {
    console.error('[cassette-studio] studio cleanup threw:', err instanceof Error ? err.message : err)
  }
}

// ── Replicate ───────────────────────────────────────────────────────────────

const CREATE_TIMEOUT_MS = 60_000
const POLL_TIMEOUT_MS = 15_000
const POLL_BUDGET_MS = 150_000
const DOWNLOAD_TIMEOUT_MS = 60_000

export class StudioUnavailable extends Error {}

function replicateToken(): string {
  const token = process.env.REPLICATE_API_TOKEN?.trim().replace(/^["']|["']$/g, '')
  if (!token || !token.startsWith('r8_')) throw new StudioUnavailable('REPLICATE_API_TOKEN missing or malformed')
  return token
}

type Prediction = { status?: string; output?: unknown; error?: unknown; detail?: string; urls?: { get?: string } }

function firstUrl(output: unknown): string | null {
  if (typeof output === 'string') return output
  if (Array.isArray(output) && typeof output[0] === 'string') return output[0]
  if (output && typeof output === 'object') {
    for (const k of ['image', 'url', 'output']) {
      const v = (output as Record<string, unknown>)[k]
      if (typeof v === 'string') return v
    }
  }
  return null
}

/**
 * Run an official Replicate model and return the output file's bytes.
 * `inputs` is tried in order, advancing ONLY on a 422 (the provider rejected
 * the input shape — a renamed optional field) or a 404 (model moved): the
 * richer tuned input first, the documented core last. Any other failure
 * throws.
 */
export async function runReplicate(model: string, inputs: Record<string, unknown>[], tag: string): Promise<Buffer> {
  const token = replicateToken()
  const endpoint = `https://api.replicate.com/v1/models/${model}/predictions`
  let prediction: Prediction | null = null
  let lastStatus = 0
  for (const input of inputs) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'wait' },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
    })
    lastStatus = res.status
    if (res.status === 422 || res.status === 404) {
      console.error(`[cassette-studio] ${tag}: ${model} answered ${res.status}:`, (await res.text().catch(() => '')).slice(0, 400))
      continue
    }
    prediction = await res.json() as Prediction
    if (!res.ok || prediction.error) {
      throw new Error(`${tag}: ${model} failed (${res.status}): ${String(prediction.error ?? prediction.detail ?? '')}`.slice(0, 500))
    }
    break
  }
  if (!prediction) throw new Error(`${tag}: ${model} rejected every input shape (last ${lastStatus})`)

  let url = prediction.status === 'succeeded' ? firstUrl(prediction.output) : null
  if (!url && prediction.urls?.get) {
    const deadline = Date.now() + POLL_BUDGET_MS
    while (!url && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000))
      let p: Prediction
      try {
        const r = await fetch(prediction.urls.get, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(POLL_TIMEOUT_MS) })
        p = await r.json() as Prediction
      } catch {
        continue
      }
      if (p.status === 'succeeded') url = firstUrl(p.output)
      else if (p.status === 'failed' || p.status === 'canceled') throw new Error(`${tag}: ${String(p.error ?? 'prediction failed')}`.slice(0, 500))
    }
  }
  if (!url) throw new Error(`${tag}: no output (status ${prediction.status ?? 'unknown'})`)
  const img = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!img.ok) throw new Error(`${tag}: output download failed (${img.status})`)
  return Buffer.from(await img.arrayBuffer())
}

/**
 * Cut the cassette out of its photo. Two background-removal models, tried in
 * order — if the first is gone or errors, the second still gets the user a
 * cut-out. Returns PNG bytes with alpha.
 */
export async function cutOut(photoUrl: string): Promise<Buffer> {
  const models: [string, Record<string, unknown>[]][] = [
    ['bria/remove-background', [{ image: photoUrl, preserve_partial_alpha: true }, { image: photoUrl }]],
    ['recraft-ai/recraft-remove-background', [{ image: photoUrl }]],
  ]
  let lastErr: unknown = null
  for (const [model, inputs] of models) {
    try {
      return await runReplicate(model, inputs, 'cutout')
    } catch (err) {
      if (err instanceof StudioUnavailable) throw err
      lastErr = err
      console.error('[cassette-studio] cut-out model failed, trying next:', err instanceof Error ? err.message : err)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('cut-out failed')
}

/** FLUX Fill [pro]: paint the scene around the cassette. Returns image bytes. */
export async function fillScene(imageUrl: string, maskUrl: string, prompt: string, seed: number): Promise<Buffer> {
  return runReplicate('black-forest-labs/flux-fill-pro', [
    { prompt, image: imageUrl, mask: maskUrl, steps: 50, output_format: 'png', safety_tolerance: 2, prompt_upsampling: false, seed },
    { prompt, image: imageUrl, mask: maskUrl },
  ], 'scene')
}

// ── Request intake ──────────────────────────────────────────────────────────

/**
 * The screen downsizes every photo in the browser before sending it (≤3000px
 * JPEG, typically 1–3 MB), which keeps request bodies far under Railway's
 * 10 MB proxy wall. This cap is the server's own guard on top of that.
 */
export const MAX_PHOTO_BYTES = 9 * 1024 * 1024

export async function readPhoto(form: FormData, field: string): Promise<Buffer | string> {
  const file = form.get(field)
  if (!file || typeof file === 'string') return 'Choose a photo first.'
  if (file.size > MAX_PHOTO_BYTES) return 'That photo is too large — try a smaller one.'
  if (file.type && !file.type.startsWith('image/')) return 'That file is not an image.'
  return Buffer.from(await file.arrayBuffer())
}
