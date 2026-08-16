import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid, isSupabaseStorageUrl } from '@/lib/validators'
import { ensureProjectVisualizerColumn, isMissingVisualizerColumn } from '@/lib/schema-heal'
import { removeStorageObjectsLogged } from '@/lib/storage-remove'
import {
  AUDIO_BUCKET,
  ARTWORK_BUCKET,
  VIDEO_BUCKET,
  collectAssetKeys,
  collectAssetUrls,
  listProjectPrefix,
  subtractKeys,
  totalKeyCount,
  unionKeys,
  type AssetKeys,
  type ProjectAssetRow,
  type VersionAssetRow,
  type VisualizerAssetRow,
} from '@/lib/project-assets'
import type { ListPage, StorageEntry } from '@/lib/video-orphan-plan'

// GET /api/projects/[id] — get one project with its versions (must belong to the user)
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const [projectRes, versionsRes] = await Promise.all([
    supabaseAdmin.from('mb_projects').select('*').eq('id', id).eq('user_id', userId).single(),
    supabaseAdmin
      .from('mb_versions')
      .select('*, mb_feedback(count)')
      .eq('project_id', id)
      .order('version_number', { ascending: false })
      .limit(500),
  ])

  if (projectRes.error) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({
    project: projectRes.data,
    versions: versionsRes.data ?? [],
  })
}

// PATCH /api/projects/[id] — update project fields (owner only)
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

  const allowed = ['title', 'genre', 'bpm', 'key_signature', 'artwork_url', 'visualizer_url', 'visualizer_wide_url'] as const
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const key of allowed) {
    if (key in body) patch[key] = body[key]
  }

  // Replacing the source artwork invalidates any prior finalized render —
  // null it out so the next Finalize starts from the new source. The source is
  // fetched server-side by /api/finalize-artwork, so only accept a Supabase
  // Storage URL (its sole legitimate shape) or null to clear it.
  if ('artwork_url' in body) {
    if (body.artwork_url !== null && !isSupabaseStorageUrl(body.artwork_url)) {
      return NextResponse.json({ error: 'artwork_url must be a Supabase storage URL' }, { status: 400 })
    }
    patch.finalized_artwork_url = null
  }

  // The project visualizers (vertical + horizontal pins) are rendered as
  // <video> across the app, so only accept a video the user actually generated
  // (an mb_visualizers row they own — any of their projects, matching how
  // artwork can be reassigned), or null to clear a pin.
  for (const key of ['visualizer_url', 'visualizer_wide_url'] as const) {
    if (key in body && body[key] !== null) {
      if (typeof body[key] !== 'string') {
        return NextResponse.json({ error: `Invalid ${key}` }, { status: 400 })
      }
      // The lookup itself can fail transiently (connection reset, PostgREST
      // blip). That is NOT "unknown video" — swallowing the error here made a
      // freshly saved render un-pinnable with a misleading 400. Retry once,
      // then surface a 503 the client can retry, keeping 400 for the case
      // where the row is genuinely absent.
      let viz: { id: string } | null = null
      let lookupError: { message: string } | null = null
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await supabaseAdmin
          .from('mb_visualizers')
          .select('id')
          .eq('user_id', userId)
          .eq('video_url', body[key])
          .limit(1)
          .maybeSingle()
        viz = res.data
        lookupError = res.error
        if (!lookupError) break
      }
      if (lookupError) {
        console.error('[projects PATCH] visualizer lookup failed:', lookupError.message)
        return NextResponse.json({ error: 'Could not verify the visualizer video. Try again.' }, { status: 503 })
      }
      if (!viz) return NextResponse.json({ error: 'Unknown visualizer video' }, { status: 400 })
    }
  }

  // maybeSingle (not single) so updating a project the caller doesn't own — or
  // one that doesn't exist — matches 0 rows and returns data:null / error:null
  // instead of a PostgREST "no rows" error we'd otherwise surface as a 500.
  const runUpdate = () => supabaseAdmin
    .from('mb_projects')
    .update(patch)
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .maybeSingle()

  let { data, error } = await runUpdate()

  // Deploys can beat the 015/020 migrations to production — heal the columns and retry.
  if (error && ('visualizer_url' in patch || 'visualizer_wide_url' in patch)
    && isMissingVisualizerColumn(error) && await ensureProjectVisualizerColumn()) {
    ({ data, error } = await runUpdate())
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  return NextResponse.json(data)
}

// DELETE /api/projects/[id] — owner only. Deletes the row AND the storage
// objects the project owned.
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  // ── 1. Enumerate the bytes BEFORE the row is gone ──────────────────────────
  // mb_versions and mb_visualizers both CASCADE on project_id, so the moment
  // the project row is deleted every URL that named these objects is deleted
  // with it. There is no second chance: /api/auth/delete-account starts from
  // rows too, so it can never find them either, and only mf-video has a sweeper.
  //
  // Ownership gates all three lookups — the project SELECT carries the same
  // .eq('user_id', userId) guard as the DELETE below, and the version and
  // visualizer lookups hang off the id it returned (mb_versions has no user_id
  // of its own; it is scoped transitively by the owned project). A non-owner
  // therefore enumerates nothing, and falls out at the delete anyway.
  //
  // select('*') rather than a column list: visualizer_url (migration 015) and
  // visualizer_wide_url (020) can be absent on a not-yet-migrated deploy, and
  // PostgREST rejects the WHOLE select when one named column is missing.
  // collectAssetKeys() reads them as optional, so a pre-015 schema just yields
  // no pins instead of a 500.
  const { data: project } = await supabaseAdmin
    .from('mb_projects')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()

  let candidates = EMPTY_KEYS
  let candidateUrls: string[] = []
  if (project) {
    const [versionsRes, visualizersRes] = await Promise.all([
      supabaseAdmin.from('mb_versions').select('audio_url').eq('project_id', id).limit(1000),
      supabaseAdmin.from('mb_visualizers').select('video_url, source_image_url').eq('project_id', id).limit(1000),
    ])
    // A failed enumeration must not read as "this project owned nothing" — that
    // is precisely how the bytes go missing. Log it and keep going: the user's
    // delete must still succeed, and the operator needs to know a sweep is owed.
    for (const [label, res] of [['versions', versionsRes], ['visualizers', visualizersRes]] as const) {
      if (res.error) console.error(`[project delete] could not enumerate ${label} for ${id}: ${res.error.message} — storage cleanup will be incomplete`)
    }
    const rows = {
      projects: [project as ProjectAssetRow],
      versions: (versionsRes.data ?? []) as VersionAssetRow[],
      visualizers: (visualizersRes.data ?? []) as VisualizerAssetRow[],
    }
    candidates = collectAssetKeys(rows)
    candidateUrls = collectAssetUrls(rows)

    // Union in everything sitting under the project's own `<projectId>/` prefix.
    // The column URLs above only name the CURRENT artwork/video/audio; every
    // superseded "Finalize" render and unpicked AI candidate is unreferenced by
    // definition, so no URL-driven enumeration can reach it. Listing is
    // best-effort — on failure we still delete the column-derived keys rather
    // than abandoning the cleanup entirely.
    candidates = unionKeys(candidates, await listProjectPrefixes(id))
  }

  // ── 2. Delete the row FIRST, bytes second ─────────────────────────────────
  // Order is deliberate and must not be swapped. If the bytes went first and
  // this delete then failed, the project would still be listed in the UI with
  // every mix and cover 404ing — live media destroyed under a row that still
  // exists, and unrecoverable. This way the worst case is the reverse: the row
  // is gone and some bytes linger, which is a leak we can sweep, not data loss.
  const { data: deleted, error } = await supabaseAdmin
    .from('mb_projects')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
    .select('id')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Nothing matched (already deleted, or not the caller's project). Answer
  // exactly as before — but touch no bytes, since no row of ours went away.
  if (!deleted || deleted.length === 0) return NextResponse.json({ ok: true })

  // ── 3. Remove the bytes nothing else still points at ──────────────────────
  await removeProjectAssets(id, candidates, candidateUrls)

  // The row deletion — the thing the user actually asked for — succeeded, so
  // this is a success regardless of how storage went. Reporting a 500 here
  // would tell the user their delete failed when it did not, and invite a retry
  // that can never do anything. Storage trouble is loud in the log instead.
  return NextResponse.json({ ok: true })
}

const EMPTY_KEYS: AssetKeys = { 'mf-audio': [], 'mf-artwork': [], 'mf-video': [] }

const ASSET_BUCKETS = [AUDIO_BUCKET, ARTWORK_BUCKET, VIDEO_BUCKET] as const

/**
 * List `<projectId>/` in all three buckets.
 *
 * The prefix is never built from a raw param: listProjectPrefix re-validates it
 * as a UUID and refuses anything else, so this cannot degrade into a
 * bucket-wide listing even if the route's own isUuid() guard were removed.
 */
async function listProjectPrefixes(id: string): Promise<AssetKeys> {
  const found: AssetKeys = { ...EMPTY_KEYS }
  await Promise.all(ASSET_BUCKETS.map(async bucket => {
    const listPage: ListPage = async (prefix, offset, limit) => {
      const { data, error } = await supabaseAdmin.storage.from(bucket).list(prefix, { offset, limit })
      if (error) {
        console.error(`[project delete] listing ${bucket}/${prefix} failed: ${error.message}`)
        return null
      }
      return (data ?? []) as StorageEntry[]
    }
    const keys = await listProjectPrefix(listPage, id)
    if (keys === null) {
      console.error(
        `[project delete] could not list ${bucket} prefix for ${id} — superseded renders under that ` +
        `prefix will be left behind. Falling back to the URLs the rows named.`,
      )
      return
    }
    found[bucket] = keys
  }))
  return found
}

/**
 * Drop the storage objects a just-deleted project owned, minus anything that
 * survived the cascade and still points at them.
 *
 * The survivor scan runs AFTER the row delete on purpose: the project's own
 * rows are already gone by then, so anything still referencing a candidate URL
 * is by definition a different, live owner — no need to special-case the rows
 * we are cleaning up after.
 */
async function removeProjectAssets(id: string, candidates: AssetKeys, candidateUrls: string[]) {
  if (totalKeyCount(candidates) === 0) return

  const survivors = await survivingAssetKeys(candidateUrls, id)
  if (!survivors) {
    // The scan is what tells shared objects apart from exclusively-owned ones.
    // Without it we cannot prove a key is safe to delete, and deleting a shared
    // object destroys another project's live media. Leak deliberately.
    console.error(
      `[project delete] survivor scan failed for ${id} — skipping storage cleanup to avoid deleting ` +
      `objects another project still references. ${totalKeyCount(candidates)} object(s) may be orphaned.`,
    )
    return
  }

  const doomed = subtractKeys(candidates, survivors)
  for (const bucket of [AUDIO_BUCKET, ARTWORK_BUCKET, VIDEO_BUCKET] as const) {
    const paths = doomed[bucket]
    if (paths.length === 0) continue
    // removeStorageObjectsLogged VERIFIES per key. Supabase Storage answers a
    // refused delete with 200 and `[]`, so an `if (error)` guard here would be
    // unreachable and this route would report a clean delete over bytes that
    // are still in a PUBLIC bucket — the bug that leaked 259 objects.
    const ok = await removeStorageObjectsLogged(bucket, paths, 'project delete')
    if (!ok) {
      // The row is ALREADY gone at this point, so nothing will ever name these
      // objects again. This is the orphan-creating path and it must be loud —
      // the client is still told the delete succeeded, because it did.
      console.error(
        `[project delete] ORPHANED BYTES: project ${id} row is deleted but ${bucket} cleanup was not ` +
        `confirmed. Nothing references these objects any more, so only a bucket sweep can reclaim them.`,
      )
      Sentry.captureMessage('project delete: storage cleanup incomplete (orphaned bytes)', {
        level: 'warning',
        extra: { projectId: id, bucket, objectCount: paths.length },
      })
    }
  }
}

/**
 * Which of these URLs are STILL referenced after the delete, as storage keys.
 *
 * Returns null if any query failed — the caller must then treat every key as
 * possibly-shared and remove nothing, the same fail-safe direction
 * video-orphan-reaper takes when its reference scan can't be trusted.
 *
 * Deliberately NOT scoped to the deleting user: PATCH only checks that
 * artwork_url is *a* Supabase storage URL, so one account can point a project
 * at another account's object. Scoping the scan by owner would let that pin be
 * used to delete a stranger's artwork.
 */
async function survivingAssetKeys(urls: string[], id: string): Promise<AssetKeys | null> {
  const projects: ProjectAssetRow[] = []
  const versions: VersionAssetRow[] = []
  const visualizers: VisualizerAssetRow[] = []
  let failed = false

  // Every URL column that can name one of our candidate objects. Missing the
  // table/column pair here is how a shared object gets deleted, so keep this
  // list in step with collectAssetKeys().
  const columns = [
    ['mb_versions', 'audio_url'],
    ['mb_projects', 'artwork_url'],
    ['mb_projects', 'finalized_artwork_url'],
    ['mb_projects', 'visualizer_url'],
    ['mb_projects', 'visualizer_wide_url'],
    ['mb_visualizers', 'video_url'],
    ['mb_visualizers', 'source_image_url'],
  ] as const

  // The pin columns are the only ones that can be legitimately absent
  // (migrations 015 / 020). A missing column means there are no pins to protect,
  // not a broken scan.
  const optional = new Set(['visualizer_url', 'visualizer_wide_url'])

  const absorb = (table: string, rows: unknown[]) => {
    if (table === 'mb_versions') versions.push(...(rows as VersionAssetRow[]))
    else if (table === 'mb_projects') projects.push(...(rows as ProjectAssetRow[]))
    else visualizers.push(...(rows as VisualizerAssetRow[]))
  }

  const run = async (
    table: string,
    column: string,
    build: (q: ReturnType<typeof supabaseAdmin.from>) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
  ) => {
    const { data, error } = await build(supabaseAdmin.from(table))
    if (error) {
      if (optional.has(column) && isMissingVisualizerColumn(error)) return
      console.error(`[project delete] survivor scan failed on ${table}.${column}: ${error.message}`)
      failed = true
      return
    }
    absorb(table, data ?? [])
  }

  await Promise.all(columns.flatMap(([table, column]) => {
    const queries = []

    // Pass 1 — exact matches on the URLs the deleted rows named. This is what
    // protects the iOS bucket-root audio keys, which have no project prefix.
    //
    // Chunked: these are full URLs travelling in the PostgREST query string, so
    // a project with hundreds of versions would otherwise build a request URL
    // past the server's limit and fail the whole scan.
    for (let i = 0; i < urls.length; i += 50) {
      const chunk = urls.slice(i, i + 50)
      queries.push(run(table, column, q => q.select(column).in(column, chunk)))
    }

    // Pass 2 — anything still pointing INTO this project's prefix. The prefix
    // listing turns up objects no column of ours named, so pass 1 cannot vouch
    // for them; this asks the question in key space instead. It is the check
    // that saves an artwork object another project reassigned to itself — two
    // such objects exist in production right now. `id` is a validated UUID, so
    // it carries no LIKE wildcards.
    queries.push(run(table, column, q => q.select(column).like(column, `%/${id}/%`)))

    return queries
  }))

  // A scan we cannot complete cannot tell a shared object from an exclusively
  // owned one, and deleting a shared object destroys another project's live
  // media. Fail towards leaking bytes, never towards deleting them.
  if (failed) return null

  return collectAssetKeys({ projects, versions, visualizers })
}
