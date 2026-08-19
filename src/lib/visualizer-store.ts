import { supabaseAdmin } from '@/lib/supabase'
import { ensureVisualizerSettingsColumn, isMissingVisualizerSettingsColumn } from '@/lib/schema-heal'
import { claimAfterInsertFailure, claimPrecheck } from '@/lib/visualizer-claim'
import { removeStorageObjectsLogged } from '@/lib/storage-remove'
import { parseVizStoragePath, type VizKeyExt } from '@/lib/visualizer-finalize'

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
  // Where to write the object. Defaults to a fresh `viz-<stamp>` key, which is
  // what every caller that holds only bytes wants.
  //
  // /api/visualizer/finalize's webm lane passes mp4TwinPath(claimedKey)
  // instead, so the transcoded twin lands on a key DERIVABLE from the claim.
  // That derivation is the whole idempotency story on that lane: the twin
  // replaces the webm original, so a replayed claim can no longer find the
  // object it names — but it can still compute where the finished mp4 went.
  // (Same convention the WebM→MP4 boot heal uses, so DELETE
  // /api/visualizer/[id], /api/auth/delete-account and the orphan sweep already
  // understand the pair via webmOriginalPath().)
  path?: string
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

  // ── The key this function is allowed to mint ────────────────────────────────
  // Everything below exists to guarantee ONE property: every key storeVisualizer
  // writes is a key VIZ_KEY_RE recognizes. That regex is the orphan sweep's
  // shape filter (planReap counts anything outside it as keptForeignShape and
  // never deletes it), so an object this app writes and this app cannot
  // recognize has no cleanup path ANYWHERE — invisible in Media, unnameable by
  // DELETE /api/visualizer/[id] and /api/auth/delete-account (both start from a
  // row's video_url), and skipped by the one sweep that exists to catch exactly
  // that. Unreapable forever, for a bucket the user is billed for.
  //
  // THE FIX IS THE BOUND, NOT A WIDER REGEX — the same trade VIZ_WEBM_STAMP_MAX
  // is priced on. Tightening what may be WRITTEN can never strand anything;
  // only loosening the recognizer can, and loosening it would hand the sweep
  // permission to delete shapes it currently protects.
  //
  // Two arms of the old key expression violated that property:
  //
  //   1. `contentType.includes('quicktime') ? 'mov'` minted `<pid>/viz-<ts>.mov`.
  //      VIZ_KEY_RE matches (mp4|webm) and nothing else. This was NOT
  //      theoretical: /api/visualizer/save takes contentType from `file.type` —
  //      the multipart part header, which the client writes — and mf-video's
  //      allowed_mime_types is ['video/webm','video/mp4','video/quicktime'], so
  //      the storage layer accepts the upload. A plain H.264 MP4 labelled
  //      video/quicktime passes the save lane's demux probe (mediabunny sniffs
  //      the container, not the label, and reports 'avc'), skips the transcode
  //      (the label does not contain 'webm') and lands here. /api/visualizer/
  //      runway is the second door: it forwards Runway's response content-type
  //      verbatim. So the extension is now typed VizKeyExt — re-adding a third
  //      arm is a compile error, not a silent leak — and quicktime joins the mp4
  //      lane. Only the KEY changes; `contentType` is still uploaded verbatim,
  //      so the object's header keeps describing its real bytes, and no consumer
  //      reads the extension anyway (ffmpeg and mediabunny sniff the container,
  //      the delete paths slice the key out of the URL).
  //
  //      Note the `: 'webm'` default is deliberately left alone. An unlabelled
  //      stream stored as .webm costs one redundant boot-heal transcode; stored
  //      as .mp4 it would be a real webm the heal never finds (it scans
  //      video_url like '%.webm'), i.e. silently unplayable on iOS forever.
  //
  //   2. The project segment was interpolated raw, but VIZ_KEY_RE spells it
  //      `[0-9a-f-]{36}` — LOWERCASE hex only — while the routes admit an
  //      UPPERCASE UUID: isUuid()'s regex carries /i, and userOwnsProject()'s
  //      .eq('id', projectId) hits a uuid column, whose comparison Postgres
  //      performs case-insensitively (verified against production). So an owner
  //      posting their own project id in uppercase to /api/visualizer/{free,save,
  //      runway} or /api/finalize-video passed every gate and minted
  //      `<UPPERCASE-UUID>/viz-<ts>.mp4` — unreapable for the same reason. This
  //      is not a hypothetical typo: Swift's UUID.uuidString is uppercase, the
  //      native app calls these routes, and the identical mistake already
  //      happened in mf-audio — 5 of its 391 objects are
  //      `<UPPERCASE-UUID>-v<n>-<ts>.wav`, written by the iOS app straight to the
  //      bucket root (measured 2026-08-18; see project-assets.ts). Five, not the
  //      115 an earlier note claimed: 116 mf-audio keys sit at the bucket root,
  //      but 111 of those are plain human filenames like "HALFWAY - MIX 1.wav",
  //      not the iOS UUID shape. Five is still precedent — the point is that this
  //      exact mistake reached production once already, not that it did so often.
  //      MixbaseAPI.swift
  //      currently writes .lowercased() at every call site, which is a
  //      per-caller mitigation; this is the bound.
  //
  //      The signed-URL lane already failed closed here — /api/upload-url
  //      refuses to sign any mf-video key outside VIZ_KEY_RE — so this only
  //      restores parity for the server-mint lane.
  const ext: VizKeyExt = contentType.includes('mp4') || contentType.includes('quicktime')
    ? 'mp4'
    : 'webm'
  const keyProjectId = projectId.toLowerCase()
  const filename = args.path ?? `${keyProjectId}/viz-${Date.now()}.${ext}`

  // The property itself, asserted rather than reasoned about. parseVizStoragePath
  // is the SAME gate /api/visualizer/finalize applies to an inbound claim, so
  // there is one definition of "a key this app may hold" and the write path
  // cannot drift away from the recognizer without failing here first. It also
  // covers the caller-supplied `path` lane (finalize's mp4 twin, already
  // validated there — this is belt and braces) and any future arm anyone adds
  // above.
  //
  // Refusing is the correct failure: returning null makes the caller report
  // "Failed to save visualizer", which is a visible, retryable, recoverable
  // outcome. Writing the object anyway is not recoverable by anything.
  if (!parseVizStoragePath(keyProjectId, filename)) {
    console.error(
      `[visualizer-store] refusing to write a key the orphan sweep cannot recognize: ${filename}`,
    )
    return null
  }

  // upsert follows the key, and both settings are load-bearing:
  //
  //   minted key  — `false` is a guard. Nothing should be sitting on a stamp
  //                 generated a millisecond ago, and if something is, it is not
  //                 ours to overwrite.
  //   derived key — `true`, matching the WebM→MP4 heal that writes this exact
  //                 key ("deterministic, so re-running after a partial failure
  //                 converges instead of piling up duplicates"). A twin object
  //                 left behind by a claim that died between upload and insert
  //                 would otherwise refuse every later attempt at the same clip
  //                 FOREVER — the derived key never changes, so the collision
  //                 never clears itself. What gets overwritten is a twin
  //                 re-derived from the same source webm, i.e. the same video.
  const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
    .from(VIDEO_BUCKET)
    .upload(filename, bytes, { contentType, upsert: !!args.path })
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
    // WHOSE bytes are these? A key minted a millisecond ago cannot be anyone
    // else's, so the answer is "ours" and the cleanup below is unambiguous. A
    // key the CALLER derived is different: the finalize webm lane writes its
    // mp4 twin at mp4TwinPath(claimedKey), so a concurrent replay of the same
    // claim can already hold a row over this exact URL — and post-033 that
    // unique index is precisely WHY our insert would fail. Deleting then would
    // destroy the object the WINNER's row points at. That is the same shape
    // migration 033 turned from "harmless duplicate" into "destroys a live
    // video" over in indexVisualizer; it must not come back through this door.
    if (args.path) {
      const raced = await visualizerByVideoUrl(videoUrl)
      const decision = claimAfterInsertFailure(raced, userId)
      // The winner's row is the right answer for the loser too: the object is
      // there and it is indexed, which is exactly what the caller asked for.
      if (decision === 'reuse') return { id: raced!.id, video_url: videoUrl }
      // Anything short of a definitive "no row exists" keeps the bytes; the
      // orphan sweep collects a genuine abandon 24 h later, which is a
      // recoverable mistake in a way that deleting a live video is not.
      if (decision !== 'remove-bytes') return null
    }
    // The row is what Media reads, so an un-indexed object is invisible and would
    // leak forever. Delete the just-uploaded bytes — verified, because a remove
    // that quietly deletes nothing is exactly how these orphans accumulated —
    // then report the failure (return null) so the caller can tell the user it
    // didn't save.
    await removeStorageObjectsLogged(VIDEO_BUCKET, [uploadData.path], 'visualizer-store un-indexed upload')
    return null
  }

  // A DERIVED key means two concurrent claims of the same upload write the SAME
  // object, so a duplicate row here is not a duplicate video — it is two rows
  // over one set of bytes. Migration 033's unique index would have refused the
  // second insert, but 033 is NOT applied in production, so pre-033 both
  // succeed. That is strictly worse than the behaviour this lane replaced:
  // stamped keys produced two independent (row, object) pairs, which were merely
  // redundant, whereas one object under two rows means DELETE
  // /api/visualizer/[id] — which removes bytes with no cross-row check — takes
  // the object out from under the surviving row and leaves it pointing at a 404.
  //
  // So collapse it here rather than depending on DDL nobody has applied yet.
  // Returns the id that actually survives, which may not be ours — handing back
  // a row we just deleted would leave the caller referencing a 404.
  const effectiveId = args.path ? await reconcileDuplicateClaim(videoUrl, row.id) : row.id

  return { id: effectiveId, video_url: videoUrl }
}

/**
 * Collapse concurrent rows over ONE derived object down to the earliest.
 *
 * Deletes only the ROW, never the bytes: the object is exactly what the
 * surviving row points at, so removing it is the one thing that must not happen.
 *
 * Ordering is a deterministic TOTAL order — created_at, then id as tiebreaker —
 * and each caller deletes only ITS OWN row and only when that row is not the
 * minimum. Exactly one row is the minimum, so concurrent reconcilers cannot all
 * delete themselves and leave the object unindexed. A failed lookup keeps
 * everything: a duplicate row is visible and fixable, an object with no row at
 * all is invisible in Media and leaks forever.
 *
 * Returns the row id the caller should report — ours when it survives, the
 * winner's when ours was the one collapsed.
 */
async function reconcileDuplicateClaim(videoUrl: string, ownRowId: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('mb_visualizers')
    .select('id, created_at')
    .eq('video_url', videoUrl)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(10)
  if (error || !data || data.length < 2) return ownRowId

  const winner = data[0] as { id: string }
  if (winner.id === ownRowId) return ownRowId

  const { error: delError } = await supabaseAdmin
    .from('mb_visualizers')
    .delete()
    .eq('id', ownRowId)
  if (delError) {
    // Both rows still exist. Keep reporting ours — it is real and it points at
    // the right object; the duplicate is a cosmetic problem, not a broken save.
    console.error('[visualizer-store] duplicate-claim reconcile failed:', delError.message)
    return ownRowId
  }
  console.warn(
    `[visualizer-store] collapsed a concurrent duplicate claim over ${videoUrl} — kept ${winner.id}, dropped ${ownRowId}`,
  )
  return winner.id
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

// The library row that ALREADY indexes this storage key for this user, or null.
//
// This is the read half of claim idempotency, for the callers that have to
// decide whether to do expensive work at all. /api/visualizer/finalize's webm
// lane asks it twice before downloading anything: once for the mp4 twin its
// success path produces, once for the webm original its transcode-failure path
// indexes. A hit means this exact claim already succeeded, so the answer is the
// row it produced — not a second download, transcode and row.
//
// Deliberately asymmetric with the delete rules in visualizer-claim.ts: there,
// an unanswered lookup (`undefined`) must never license destroying bytes; here
// it must never license reporting a save that may not have landed. Both fall
// through to "do the real work", which claimPrecheck already encodes as
// `insert`.
export async function indexedVisualizerAt(
  storagePath: string,
  userId: string,
): Promise<StoredVisualizer | null> {
  const { data: urlData } = supabaseAdmin.storage.from(VIDEO_BUCKET).getPublicUrl(storagePath)
  const videoUrl = urlData.publicUrl
  const existing = await visualizerByVideoUrl(videoUrl)
  const precheck = claimPrecheck(existing, userId)
  if (precheck === 'foreign') {
    console.error('[visualizer-store] object is already indexed by another user')
  }
  return precheck === 'reuse' ? { id: existing!.id, video_url: videoUrl } : null
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
  // Whether a definitively-failed insert may take the object's bytes with it.
  // Defaults true, which is right for the finalize/save lanes: there the object
  // was uploaded moments ago FOR this claim, so bytes with no row are litter
  // nothing will collect.
  //
  // /api/visualizer/recover passes false, because on that lane the reasoning
  // inverts. Those bytes are exactly what the user is asking to get back — they
  // already survived one lost claim — so deleting them on a transient PostgREST
  // blip would destroy the thing the request exists to rescue, and the caller
  // could never offer it again. A failed recovery must leave the object exactly
  // as it found it: still unclaimed, still recoverable on the next attempt.
  removeOnFailure?: boolean
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
    if (decision === 'remove-bytes' && args.removeOnFailure !== false) {
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
