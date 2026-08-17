import { webmOriginalPath } from './visualizer-encode.ts'
import type { ListPage } from './video-orphan-plan.ts'
// Relative + extension-full, and survivor-scan-plan.ts imports nothing at all,
// so this stays loadable under Node type stripping (see PURE BY DESIGN below).
// Shared on purpose: DELETE /api/projects/[id] and POST /api/auth/delete-account
// must bound their fan-out and degrade on failure IDENTICALLY. They briefly did
// not — the account path kept an unbounded Promise.all — and that is the same
// "two places deriving the same answer differently" bug this module exists to
// prevent, just one level up.
import {
  CHUNK_ENCODED_BUDGET,
  SCAN_CONCURRENCY,
  assumedSurvivorRows,
  chunkByEncodedLength,
  runBounded,
} from './survivor-scan-plan.ts'

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

// The (table, column) pairs that can name one of our candidate objects — the
// same list DELETE /api/projects/[id]'s survivor scan walks, hoisted here so
// the two delete paths cannot drift apart on WHICH references count. A pair
// missing from this list is a live row the scan cannot see, and that is exactly
// how a shared object gets deleted out from under its other owner.
export const ASSET_URL_COLUMNS = [
  ['mb_versions', 'audio_url'],
  ['mb_projects', 'artwork_url'],
  ['mb_projects', 'finalized_artwork_url'],
  ['mb_projects', 'visualizer_url'],
  ['mb_projects', 'visualizer_wide_url'],
  ['mb_visualizers', 'video_url'],
  ['mb_visualizers', 'source_image_url'],
] as const

// Candidate URLs travel in the PostgREST query string, so they go out in
// chunks: an account with hundreds of versions would otherwise build a request
// line past the server's URL limit and fail the WHOLE scan — which, read
// fail-safe, means deleting nothing at all.
//
// A COUNT CAP ALONE IS NOT ENOUGH, and this is not hypothetical. mf-audio's
// bucket-root uploads are human filenames carrying raw spaces and parentheses
// ("… - ALONE (moodmixformat REMIX) - MIX 2.1.wav"); percent-encoded they run
// ~165 bytes each, so 50 of them build an ~8.2 KB request line — past the usual
// 8,192-byte nginx/Kong `large_client_header_buffers` ceiling. That chunk 414s
// before it reaches PostgREST. Production has ~114 such URLs and they ALL belong
// to one account, so that account's erasure is exactly the case a flat count cap
// would have degraded. This constant is therefore only the VALUE cap; the
// binding limit is CHUNK_ENCODED_BUDGET, applied by chunkByEncodedLength().
export const ASSET_URL_CHUNK = 50

/**
 * Run one `column IN (urls)` lookup. Returns the matching rows, or null if the
 * query failed in a way that makes the scan untrustworthy.
 *
 * Injected rather than imported so this module stays free of '@/lib/supabase'
 * (see PURE BY DESIGN above) and so the caller — not this file — decides which
 * PostgREST errors are benign (e.g. a pre-migration-015 missing pin column).
 */
export type AssetUrlSelect = (
  table: string,
  column: string,
  urls: readonly string[],
) => Promise<readonly unknown[] | null>

/**
 * Which of `urls` are STILL named by rows, expressed as storage keys.
 *
 * FAILURE IS PER-CHUNK, NOT ALL-OR-NOTHING. This used to set one `failed` flag
 * and return null if any single lookup failed, which made one pooler blip
 * discard a whole account's cleanup. The scan now degrades the way
 * DELETE /api/projects/[id] does: a chunk that cannot be answered has its URLs
 * folded into the survivor set via assumedSurvivorRows(), so those specific
 * objects are protected and every object the scan DID get an answer about is
 * still handled. "We don't know" reads as "something still points at this".
 *
 * Null is now reserved for learning nothing at all — every chunk failed — which
 * is a real outage worth reporting rather than a partial answer worth using.
 *
 * FAN-OUT IS BOUNDED. The old form was Promise.all over
 * columns × ⌈urls/50⌉ with no limit: an account owning many projects could open
 * ~150+ simultaneous PostgREST GETs, and since `IN (...)` is encoded into the
 * query string, a flat count of 50 long URLs could exceed the request-line
 * ceiling on its own. Chunks are now sized by ENCODED length and run through
 * runBounded(). Account deletion is the heavier of the two callers — it fans out
 * over every project a user owns, not one — so it needs this more than the
 * project-delete path that motivated it.
 *
 * Deliberately takes NO user id. Scoping the scan by owner is precisely the bug
 * it exists to prevent: PATCH /api/projects/[id] and POST
 * /api/visualizer/finalize accept any Supabase storage URL (isSupabaseStorageUrl
 * checks protocol and hostname only — not the bucket, not the path, not who
 * owns the object), so one account can point a row at another account's live
 * object. An owner-scoped scan would look straight past the very row that
 * proves the object is still in use.
 */
export async function scanSurvivingKeys(
  select: AssetUrlSelect,
  urls: readonly string[],
): Promise<AssetKeys | null> {
  const projects: ProjectAssetRow[] = []
  const versions: VersionAssetRow[] = []
  const visualizers: VisualizerAssetRow[] = []

  // URLs no lookup could answer for. Protected, not deleted.
  const unresolved = new Set<string>()
  let answered = 0

  const chunks = chunkByEncodedLength(urls, CHUNK_ENCODED_BUDGET, ASSET_URL_CHUNK)

  const tasks = ASSET_URL_COLUMNS.flatMap(([table, column]) => chunks.map(chunk => async () => {
    const rows = await select(table, column, chunk)
    if (rows === null) {
      for (const url of chunk) unresolved.add(url)
      return
    }
    answered++
    if (table === 'mb_versions') versions.push(...(rows as VersionAssetRow[]))
    else if (table === 'mb_projects') projects.push(...(rows as ProjectAssetRow[]))
    else visualizers.push(...(rows as VisualizerAssetRow[]))
  }))

  await runBounded(tasks, SCAN_CONCURRENCY)

  // Nothing came back at all — that is an outage, not a partial answer. Say so
  // rather than handing back an empty survivor set, which would read as "no row
  // references any of these" and authorise deleting every candidate.
  if (answered === 0 && tasks.length > 0) return null

  // Fold the unanswered URLs in as if a live row still named them. Routed back
  // through the SAME collectAssetKeys derivation as everything else, so an
  // assumed-surviving MP4 also protects its WebM twin.
  const assumed = assumedSurvivorRows([...unresolved])

  // Back through the SAME derivation the candidates came from, so a surviving
  // MP4 also protects its WebM twin exactly as a doomed one would have named it.
  return collectAssetKeys({
    projects: [...projects, ...assumed.projects],
    versions: [...versions, ...assumed.versions],
    visualizers: [...visualizers, ...assumed.visualizers],
  })
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
// a listing prefix; see listProjectPrefix. Also the attribution test used by
// keyProjectId below.
const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The project id a storage key attributes ITSELF to, or null when the key
 * attributes itself to nobody.
 *
 * Only the first path segment counts, and only when it is a canonical UUID.
 * Everything else — a bucket-root key with no separator at all, or a first
 * segment like `covers` or `test-probe` — is UNATTRIBUTABLE and must return
 * null rather than a guess. Callers treat null as "this key proves nothing
 * about ownership", not as "this key is foreign".
 *
 * Case-insensitive, and normalised to lowercase: Postgres spells project ids
 * lowercase while the iOS app spells UUIDs uppercase, and both spellings reach
 * storage (production has 5 uppercase-UUID keys in mf-audio today).
 */
export function keyProjectId(key: string): string | null {
  const slash = key.indexOf('/')
  if (slash === -1) return null
  const segment = key.slice(0, slash)
  return PROJECT_ID_RE.test(segment) ? segment.toLowerCase() : null
}

/**
 * Drop candidate keys whose own prefix attributes them to a project the
 * deleting user does not own.
 *
 * WHY THIS EXISTS ON TOP OF THE SURVIVOR SCAN
 * The scan answers "is anything still pointing at this object?". That misses
 * one case: an object that sits under ANOTHER user's project prefix and is
 * currently unreferenced — a superseded `finalized-<ts>.jpg` of theirs, say.
 * A crafted `artwork_url` (isSupabaseStorageUrl validates protocol + hostname
 * only) can make our rows name it, the scan finds no survivor, and account
 * deletion would take a stranger's bytes with it. Key shape settles that case
 * without a query, so the two filters cover different halves and both run.
 *
 * WHY IT CANNOT BE THE ONLY FILTER — the mf-audio root-key split
 * 116 of 390 mf-audio objects sit at the BUCKET ROOT with no prefix at all, and
 * they are NOT all the iOS `<UUID>-v<n>-<ts>.wav` shape: only 5 are. The other
 * 111 are plain human filenames (`HALFWAY - MIX 1.wav`). Nothing in those keys
 * names a project, so a filter that demanded a project-id prefix would refuse
 * to delete every one of a user's own root uploads — leaving their audio in a
 * PUBLIC bucket after a GDPR erasure, in the one bucket with no sweeper. Hence
 * keyProjectId returns null for them and they pass through here untouched, to
 * be judged by the survivor scan alone.
 */
export function filterToOwnedPrefixes(
  candidates: AssetKeys,
  ownedProjectIds: readonly string[],
): AssetKeys {
  const owned = new Set(ownedProjectIds.map(id => id.toLowerCase()))
  const keep = (bucket: AssetBucket) => candidates[bucket].filter(key => {
    const attributed = keyProjectId(key)
    return attributed === null || owned.has(attributed)
  })
  return {
    [AUDIO_BUCKET]: keep(AUDIO_BUCKET),
    [ARTWORK_BUCKET]: keep(ARTWORK_BUCKET),
    [VIDEO_BUCKET]: keep(VIDEO_BUCKET),
  }
}

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
