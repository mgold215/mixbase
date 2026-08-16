import { webmOriginalPath } from './visualizer-encode.ts'
import type { ListPage } from './video-orphan-plan.ts'

// Which storage objects a project's rows account for.
//
// WHY THIS IS SHARED
// Two delete paths need the same answer: DELETE /api/projects/[id] (one
// project) and POST /api/auth/delete-account (every project a user owns). They
// select DIFFERENT rows on purpose — account deletion also catches visualizers
// that have no project_id — but the mapping from a row to the storage keys it
// accounts for must be IDENTICAL in both. It wasn't: project deletion dropped
// the mb_projects row and nothing else, and because mb_versions and
// mb_visualizers both CASCADE on project_id, every URL that named those bytes
// vanished in the same statement. After that no code can find them — account
// deletion starts from rows too, and only mf-video has a sweeper
// (video-orphan-reaper), so mf-audio and mf-artwork leaked forever.
//
// Same reasoning as video-orphan-reaper's addReferenced(): if two places derive
// the key set differently, one of them eventually deletes bytes a live row
// still needs, or misses bytes nothing will ever name again.
//
// PURE BY DESIGN: no '@/lib/supabase' import, relative extension-full imports
// only, so scripts/project-delete-assets-test.mjs can load it under Node type
// stripping. Row SELECTION (which is legitimately different per caller) stays
// at the call site; only derivation lives here.

export const AUDIO_BUCKET = 'mf-audio'
export const ARTWORK_BUCKET = 'mf-artwork'
export const VIDEO_BUCKET = 'mf-video'

export type AssetBucket = typeof AUDIO_BUCKET | typeof ARTWORK_BUCKET | typeof VIDEO_BUCKET

/**
 * Pull the storage object key out of a Supabase public URL for a given bucket.
 * Returns null for anything that isn't an object in that bucket — a transient
 * Replicate/Runway URL, an empty column, or another bucket's object.
 */
export function storagePathFromUrl(url: string | null | undefined, bucket: string): string | null {
  if (!url) return null
  const marker = `/storage/v1/object/public/${bucket}/`
  const idx = url.indexOf(marker)
  return idx !== -1 ? url.slice(idx + marker.length) : null
}

export type ProjectAssetRow = {
  artwork_url?: string | null
  finalized_artwork_url?: string | null
  visualizer_url?: string | null
  visualizer_wide_url?: string | null
}
export type VersionAssetRow = { audio_url?: string | null }
export type VisualizerAssetRow = { video_url?: string | null; source_image_url?: string | null }

export type AssetRows = {
  projects?: readonly ProjectAssetRow[]
  versions?: readonly VersionAssetRow[]
  visualizers?: readonly VisualizerAssetRow[]
}

export type AssetKeys = Record<AssetBucket, string[]>

/**
 * Every storage key the given rows account for, per bucket, DEDUPED.
 *
 * Deduping is not cosmetic. A project's pinned visualizer_url is the very same
 * object as one of its mb_visualizers rows' video_url (in production every
 * single pin is — 21/21 vertical, 3/3 wide), and an AI visualizer's
 * source_image_url is usually the project's own artwork_url (32 of 35 rows).
 * Sending a key twice in one remove() batch gets one confirmation back for two
 * requested entries, which removeStorageObjects would correctly report as
 * "unconfirmed" — a false alarm on the exact signal that is supposed to mean a
 * permissions failure.
 */
export function collectAssetKeys(rows: AssetRows): AssetKeys {
  const audio = new Set<string>()
  const artwork = new Set<string>()
  const video = new Set<string>()

  const addArtwork = (url: string | null | undefined) => {
    const key = storagePathFromUrl(url, ARTWORK_BUCKET)
    if (key) artwork.add(key)
  }

  // A stored mf-video URL accounts for TWO objects: the key it names, and the
  // pre-conversion WebM the boot transcode heal leaves behind as a rollback
  // path. The heal repoints the row to the MP4 twin, so deriving from the row
  // alone leaves the original bytes in a PUBLIC bucket with nothing naming
  // them. webmOriginalPath() returns null when the key isn't a twin, and
  // deleting a key that doesn't exist is a no-op in Supabase Storage.
  const addVideo = (url: string | null | undefined) => {
    const key = storagePathFromUrl(url, VIDEO_BUCKET)
    if (!key) return
    video.add(key)
    const original = webmOriginalPath(key)
    if (original) video.add(original)
  }

  for (const v of rows.versions ?? []) {
    const key = storagePathFromUrl(v.audio_url, AUDIO_BUCKET)
    if (key) audio.add(key)
  }

  for (const p of rows.projects ?? []) {
    addArtwork(p.artwork_url)
    // The finalized (text-lockup) render is a SEPARATE object from the source
    // artwork it was rendered from — both must go or one is orphaned.
    addArtwork(p.finalized_artwork_url)
    // The pins normally dedupe against the mb_visualizers rows below, but a pin
    // is the last reference standing if the library row was deleted while the
    // pin stayed, so derive from both rather than assuming they agree.
    addVideo(p.visualizer_url)
    addVideo(p.visualizer_wide_url)
  }

  for (const v of rows.visualizers ?? []) {
    addVideo(v.video_url)
    // The still image an AI visualizer was generated FROM lives in mf-artwork.
    // Usually it is the project's own artwork_url and dedupes away; when it
    // isn't, it is superseded artwork that nothing else references.
    addArtwork(v.source_image_url)
  }

  return {
    [AUDIO_BUCKET]: [...audio],
    [ARTWORK_BUCKET]: [...artwork],
    [VIDEO_BUCKET]: [...video],
  }
}

/**
 * Every URL in these rows that a storage key could be derived from.
 *
 * Used to ask "does anything that SURVIVED the delete still point at one of
 * these objects?" — see subtractKeys() and the survivor scan in
 * DELETE /api/projects/[id].
 */
export function collectAssetUrls(rows: AssetRows): string[] {
  const urls = new Set<string>()
  const add = (u: string | null | undefined) => { if (u) urls.add(u) }
  for (const v of rows.versions ?? []) add(v.audio_url)
  for (const p of rows.projects ?? []) {
    add(p.artwork_url); add(p.finalized_artwork_url)
    add(p.visualizer_url); add(p.visualizer_wide_url)
  }
  for (const v of rows.visualizers ?? []) { add(v.video_url); add(v.source_image_url) }
  return [...urls]
}

/**
 * Candidate keys minus anything a surviving row still points at.
 *
 * Storage objects are NOT privately owned by one project. PATCH
 * /api/projects/[id] accepts any Supabase storage URL as artwork_url and any of
 * the user's own visualizer videos as a pin, so the same object can legitimately
 * back two projects — in production right now two mf-artwork objects are each
 * referenced by two different projects. Removing a shared object because one of
 * its referrers was deleted destroys the OTHER project's live media, which is
 * strictly worse than the orphan this whole change exists to prevent. When in
 * doubt, leak the bytes: mf-video has a sweeper, and a wrongly-kept object is
 * recoverable while a wrongly-deleted one is not.
 */
export function subtractKeys(candidates: AssetKeys, survivors: AssetKeys): AssetKeys {
  const drop = (bucket: AssetBucket) => {
    const keep = new Set(survivors[bucket])
    return candidates[bucket].filter(k => !keep.has(k))
  }
  return {
    [AUDIO_BUCKET]: drop(AUDIO_BUCKET),
    [ARTWORK_BUCKET]: drop(ARTWORK_BUCKET),
    [VIDEO_BUCKET]: drop(VIDEO_BUCKET),
  }
}

export function totalKeyCount(keys: AssetKeys): number {
  return keys[AUDIO_BUCKET].length + keys[ARTWORK_BUCKET].length + keys[VIDEO_BUCKET].length
}

/** Merge two key sets, deduped per bucket. */
export function unionKeys(a: AssetKeys, b: AssetKeys): AssetKeys {
  const merge = (bucket: AssetBucket) => [...new Set([...a[bucket], ...b[bucket]])]
  return {
    [AUDIO_BUCKET]: merge(AUDIO_BUCKET),
    [ARTWORK_BUCKET]: merge(ARTWORK_BUCKET),
    [VIDEO_BUCKET]: merge(VIDEO_BUCKET),
  }
}

// Objects per listing page, and the "don't loop forever" ceiling — a storage
// API that ignored `offset` would otherwise hand back the same page endlessly.
export const ASSET_PAGE_SIZE = 1000
export const ASSET_MAX_PAGES = 50

// How far below `<projectId>/` to walk. Every key this app writes today is flat
// (`<projectId>/<name>` — verified against production: zero keys are nested
// under any project prefix), so this only exists so a future nested key is not
// half-swept. Bounded because the walk is recursive.
export const ASSET_MAX_DEPTH = 3

// Lowercase-or-uppercase canonical UUID, anchored. Nothing else may ever become
// a listing prefix; see listProjectPrefix.
const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Every object key under a project's own `<projectId>/` prefix.
 *
 * WHY LISTING IS NEEDED AT ALL, ON TOP OF THE COLUMN URLS
 * Column-derived keys only ever name the CURRENT artwork/video/audio. Every
 * "Finalize" click writes a fresh `<projectId>/finalized-<ts>.jpg` and the
 * project row is repointed at it, so the superseded render is instantly
 * unreferenced — no column names it, and a URL-driven enumeration cannot see
 * it. That is where the bulk of the production orphans came from (202 of 262
 * objects, three renders of one project 19 seconds apart). The same is true of
 * `ai-<ts>.jpg` candidates the user generated and didn't pick, and of superseded
 * `viz-<ts>.mp4` renders.
 *
 * NEITHER ENUMERATION IS SUFFICIENT ALONE — do not "simplify" this to one of
 * them. Measured against production:
 *   * mf-audio holds 115 BUCKET-ROOT keys out of 389 (29.6%) — the iOS uploads,
 *     `<UPPERCASE-UUID>-v<n>-<ts>.wav`. No `<projectId>/` prefix listing sees a
 *     single one, so for audio the column URLs are the only way to find nearly a
 *     third of a project's files.
 *   * mf-artwork holds 202 superseded renders that no column names, so for
 *     artwork the prefix listing is the only way to find them.
 * One legacy shape sits outside both halves of the prefix story:
 * `covers/<projectId>/<name>` (one such object in production). It is not under
 * `<projectId>/` at any depth, so only the column URL that names it can reach it.
 *
 * Returns null if the listing could not be completed — the caller degrades to
 * column-derived keys only rather than deleting on a listing it cannot trust.
 */
export async function listProjectPrefix(listPage: ListPage, projectId: string): Promise<string[] | null> {
  // The prefix is interpolated into a listing whose results are handed to
  // storage.remove(). An empty or partial prefix lists the WHOLE bucket and
  // would feed every other project's objects to the remover. Validating here
  // rather than trusting the caller makes that impossible by construction —
  // this function cannot be called into a bucket-wide sweep no matter what the
  // route does with its params.
  if (!PROJECT_ID_RE.test(projectId)) return null

  // Trailing separator is part of the construction, not the caller's input:
  // `<uuid>` alone would prefix-match a sibling folder, and '' lists the bucket.
  const keys: string[] = []
  const ok = await walkPrefix(listPage, `${projectId}/`, 0, keys)
  return ok ? keys : null
}

/**
 * Page through one prefix, recursing into any sub-prefix it reports.
 *
 * On the `id === null` folder marker: that is what supabase-js documents and
 * what video-orphan-plan's listing already relies on, but it is NOT verified
 * against the live API here — production currently has no nested keys and no
 * `.emptyFolderPlaceholder` objects, so nothing exercises it. Both ways of being
 * wrong are therefore deliberately made harmless rather than assumed away:
 *   * if a real object were mistaken for a folder, listing it returns nothing
 *     and the object is simply not collected — it leaks, which a sweep can fix;
 *   * if a folder were mistaken for an object, its name is collected as a key
 *     that does not exist, and remove() on a non-existent key is a no-op.
 * Neither direction can delete something real that we did not mean to delete.
 */
async function walkPrefix(listPage: ListPage, prefix: string, depth: number, out: string[]): Promise<boolean> {
  if (depth >= ASSET_MAX_DEPTH) return true

  const subPrefixes: string[] = []
  for (let page = 0; page < ASSET_MAX_PAGES; page++) {
    const batch = await listPage(prefix, page * ASSET_PAGE_SIZE, ASSET_PAGE_SIZE)
    if (batch === null) return false
    for (const entry of batch) {
      if (!entry.name) continue
      if (entry.id === null) subPrefixes.push(`${prefix}${entry.name}/`)
      else out.push(`${prefix}${entry.name}`)
    }
    // A short page is the last page. A server that ignored `offset` would keep
    // returning full pages and hit ASSET_MAX_PAGES below, which reads as a
    // failed listing — the safe end.
    if (batch.length < ASSET_PAGE_SIZE) {
      for (const sub of subPrefixes) {
        if (!(await walkPrefix(listPage, sub, depth + 1, out))) return false
      }
      return true
    }
  }
  return false
}
