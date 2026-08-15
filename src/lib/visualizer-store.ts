import { supabaseAdmin } from '@/lib/supabase'
import { ensureVisualizerSettingsColumn, isMissingVisualizerSettingsColumn } from '@/lib/schema-heal'
import { claimAfterInsertFailure, claimPrecheck } from '@/lib/visualizer-claim'
import { removeStorageObjectsLogged } from '@/lib/storage-remove'

// Shared persistence for generated visualizers. Both the AI path
// (/api/visualizer/runway) and the free path (/api/visualizer/save) upload the
// video bytes to the mf-video bucket and record a row so the result is findable
// in the Media library — mirroring how artwork lands in mf-artwork.
//
// Every cleanup below goes through removeStorageObjectsLogged() rather than
// storage.remove(): a remove refused by storage RLS is NOT an error — the
// policy matches no rows and the API answers 200 with `[]` — so a guard that
// only checks `error` reports success while the bytes stay public. That is how
// these "best-effort deletes" were unconditional no-ops in production.

const VIDEO_BUCKET = 'mf-video'

// Confirm the caller owns the project before writing a visualizer against it —
// the same IDOR guard generate-artwork uses before touching project artwork.
export async function userOwnsProject(userId: string, projectId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('mb_projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', userId)
    .single()
  return !error && !!data
}

export type StoreVisualizerArgs = {
  userId: string
  projectId: string
  bytes: Buffer | Uint8Array
  contentType: string
  // 'free'/'ai' are visualizer loops; 'youtube'/'shorts' are the finished
  // full-length videos the video finalizer renders from those loops.
  kind: 'free' | 'ai' | 'youtube' | 'shorts'
  title: string
  sourceImageUrl?: string | null
  // FX-engine recipe (VizRecipe JSON, already validated + size-capped by the
  // route). Opaque to the server; enables "edit a copy" in the web studio.
  settings?: unknown
}

export type StoredVisualizer = { id: string; video_url: string }

// Insert the mb_visualizers row, healing the `settings` column if the deploy
// beat migration 031. Degrades in order: insert with settings → heal + retry →
// insert WITHOUT settings (a clip whose recipe didn't persist is still a saved
// clip; the reverse — a failed save over a metadata column — is not acceptable).
async function insertVisualizerRow(fields: {
  user_id: string
  project_id: string
  video_url: string
  source_image_url: string | null
  kind: string
  title: string
}, settings: unknown): Promise<{ id: string } | null> {
  const withSettings = settings !== undefined && settings !== null
  const attempt = (includeSettings: boolean) =>
    supabaseAdmin
      .from('mb_visualizers')
      .insert(includeSettings ? { ...fields, settings } : fields)
      .select('id')
      .single()

  let res = await attempt(withSettings)
  if (res.error && withSettings && isMissingVisualizerSettingsColumn(res.error)) {
    const healed = await ensureVisualizerSettingsColumn()
    res = await attempt(healed)
    if (res.error && healed && isMissingVisualizerSettingsColumn(res.error)) {
      // Heal reported success but PostgREST still rejects the column (stale
      // schema cache) — save the row without the recipe rather than failing.
      res = await attempt(false)
    }
  }
  if (res.error || !res.data) {
    console.error('[visualizer-store] db insert error:', res.error?.message)
    return null
  }
  return { id: res.data.id as string }
}

// Upload a generated visualizer and index it. Returns null when EITHER the
// upload or the DB insert fails — both are genuine "not saved" outcomes, so the
// caller surfaces the failure to the user. (An earlier version returned the URL
// with an empty id on a DB-insert failure; callers read that as success and told
// the user "saved" while the row never landed in Media and the bytes leaked.)
export async function storeVisualizer(args: StoreVisualizerArgs): Promise<StoredVisualizer | null> {
  const { userId, projectId, bytes, contentType, kind, title, sourceImageUrl, settings } = args

  const ext = contentType.includes('mp4') ? 'mp4'
    : contentType.includes('quicktime') ? 'mov'
    : 'webm'
  const filename = `${projectId}/viz-${Date.now()}.${ext}`

  const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
    .from(VIDEO_BUCKET)
    .upload(filename, bytes, { contentType, upsert: false })
  if (uploadError || !uploadData) {
    console.error('[visualizer-store] upload error:', uploadError?.message)
    return null
  }

  const { data: urlData } = supabaseAdmin.storage.from(VIDEO_BUCKET).getPublicUrl(uploadData.path)
  const videoUrl = urlData.publicUrl

  const row = await insertVisualizerRow({
    user_id: userId,
    project_id: projectId,
    video_url: videoUrl,
    source_image_url: sourceImageUrl ?? null,
    kind,
    title,
  }, settings)
  if (!row) {
    // The row is what Media reads, so an un-indexed object is invisible and would
    // leak forever. Delete the just-uploaded bytes — verified, because a remove
    // that quietly deletes nothing is exactly how these orphans accumulated —
    // then report the failure (return null) so the caller can tell the user it
    // didn't save.
    await removeStorageObjectsLogged(VIDEO_BUCKET, [uploadData.path], 'visualizer-store un-indexed upload')
    return null
  }

  return { id: row.id, video_url: videoUrl }
}

// The row that already indexes this exact object, if there is one.
//
// `undefined` means the LOOKUP ITSELF failed, which is NOT the same answer as
// "no row". Every caller below treats the two differently: a known-absent row
// licenses deleting the bytes, an unanswered question never does.
async function visualizerByVideoUrl(
  videoUrl: string,
): Promise<{ id: string; user_id: string } | null | undefined> {
  const { data, error } = await supabaseAdmin
    .from('mb_visualizers')
    .select('id, user_id')
    .eq('video_url', videoUrl)
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error('[visualizer-store] existing-claim lookup failed:', error.message)
    return undefined
  }
  return (data as { id: string; user_id: string } | null) ?? null
}

// Index an object that is ALREADY in mf-video (signed-URL upload path — the
// bytes never passed through this server). Same no-orphan rule as
// storeVisualizer: if the row can't land, best-effort delete the object so it
// doesn't leak invisibly.
//
// IDEMPOTENT ON THE STORAGE PATH. fx/upload.ts re-POSTs the claim when its
// response is lost (retrying the cheap JSON claim beats re-uploading, and
// beats the caller falling back to the legacy multipart save, which would
// store a second COPY of the bytes). So the same object can be claimed more
// than once, and a plain INSERT answered that with a SECOND mb_visualizers row
// over one object: the user sees a duplicate in Media, and deleting either row
// takes the bytes with it and leaves the other row pointing at a 404.
export async function indexVisualizer(args: {
  userId: string
  projectId: string
  storagePath: string
  kind: 'free' | 'ai' | 'youtube' | 'shorts'
  title: string
  sourceImageUrl?: string | null
  settings?: unknown
}): Promise<StoredVisualizer | null> {
  const { data: urlData } = supabaseAdmin.storage.from(VIDEO_BUCKET).getPublicUrl(args.storagePath)
  const videoUrl = urlData.publicUrl

  // The common repeat case: the first claim's row landed and only its response
  // was lost. Hand back that row — the client gets a success it can act on
  // (same id/video_url shape as a fresh save), and no second row is created.
  // A repeat claim keeps the FIRST claim's title/settings; that is what
  // idempotent means here, and the client sends the same values anyway.
  const existing = await visualizerByVideoUrl(videoUrl)
  const precheck = claimPrecheck(existing, args.userId)
  if (precheck === 'reuse') return { id: existing!.id, video_url: videoUrl }
  if (precheck === 'foreign') {
    console.error('[visualizer-store] claimed object is already indexed by another user')
    return null
  }

  const row = await insertVisualizerRow({
    user_id: args.userId,
    project_id: args.projectId,
    video_url: videoUrl,
    source_image_url: args.sourceImageUrl ?? null,
    kind: args.kind,
    title: args.title,
  }, args.settings)
  if (!row) {
    // Two concurrent retries of the SAME claim can both pass the precheck.
    // Post-033 the loser's insert fails on the unique index rather than writing
    // a duplicate, and the winner's row is the correct answer for both.
    const raced = await visualizerByVideoUrl(videoUrl)
    const decision = claimAfterInsertFailure(raced, args.userId)
    if (decision === 'reuse') return { id: raced!.id, video_url: videoUrl }
    if (decision === 'remove-bytes') {
      await removeStorageObjectsLogged(VIDEO_BUCKET, [args.storagePath], 'visualizer-store failed claim')
    }
    return null
  }
  return { id: row.id, video_url: videoUrl }
}

// Derive the storage object path (after the bucket segment) from a public URL,
// for deletes. Returns null if the URL isn't an mf-video object.
export function videoStoragePath(url: string): string | null {
  const marker = `/storage/v1/object/public/${VIDEO_BUCKET}/`
  const idx = url.indexOf(marker)
  if (idx === -1) return null
  return url.slice(idx + marker.length)
}

export { VIDEO_BUCKET }
