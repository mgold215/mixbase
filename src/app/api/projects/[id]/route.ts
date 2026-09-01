import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid, isJsonObject, isSupabaseStorageUrl } from '@/lib/validators'
import { ensureProjectVisualizerColumn, isMissingVisualizerColumn, ensureProjectInstrumentalColumn, isMissingInstrumentalColumn } from '@/lib/schema-heal'
import { removeStorageObjectsLogged } from '@/lib/storage-remove'
import {
  AUDIO_BUCKET,
  ARTWORK_BUCKET,
  ASSET_URL_COLUMNS,
  OPTIONAL_ASSET_URL_COLUMNS,
  VIDEO_BUCKET,
  bucketRootKeys,
  errorNamesColumn,
  collectAllRows,
  collectAssetKeys,
  collectAssetUrls,
  filterToOwnedPrefixes,
  keysSafeToDelete,
  listProjectPrefix,
  totalKeyCount,
  unionKeys,
  type AssetKeys,
  type CollectionAssetRow,
  type ProjectAssetRow,
  type SurvivorScan,
  type VersionAssetRow,
  type VisualizerAssetRow,
} from '@/lib/project-assets'
import {
  SCAN_CONCURRENCY,
  assumedSurvivorRows,
  chunkByEncodedLength,
  runBounded,
} from '@/lib/survivor-scan-plan'
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
  // isJsonObject, not a truthiness check: a body of `5` or `"x"` or `[]` parses
  // fine and is truthy, then `'title' in 5` throws a TypeError the caller sees as
  // an opaque 500. One honest 400 instead.
  if (!isJsonObject(body)) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

  const allowed = ['title', 'genre', 'bpm', 'key_signature', 'artwork_url', 'visualizer_url', 'visualizer_wide_url', 'instrumental_url'] as const
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

  // The instrumental slot is played back through /api/audio and deleted with the
  // project's other assets, so only accept a Supabase Storage URL (the sole
  // shape our uploads produce) or null to clear the slot.
  if ('instrumental_url' in body) {
    if (body.instrumental_url !== null && !isSupabaseStorageUrl(body.instrumental_url)) {
      return NextResponse.json({ error: 'instrumental_url must be a Supabase storage URL' }, { status: 400 })
    }
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

  // Same for the 035 instrumental column.
  if (error && 'instrumental_url' in patch
    && isMissingInstrumentalColumn(error) && await ensureProjectInstrumentalColumn()) {
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
    // PAGED, not `.limit(1000)`. The old cap dropped row 1001 onward silently —
    // no error, no warning — and those rows CASCADE away with the project
    // moments later, after which nothing can ever name their bytes again.
    // Unreachable at today's sizes (the largest project has 20 versions), but a
    // cap that loses data without saying so is the bug regardless of how far off
    // the number is. collectAllRows pages until an EMPTY page and reports null
    // rather than a short list, so neither a failure nor a server-side row cap
    // can pass itself off as "that was all of them".
    const [versionRows, visualizerRows] = await Promise.all([
      collectAllRows<VersionAssetRow>((offset, limit) => fetchRowPage(
        supabaseAdmin.from('mb_versions').select('audio_url').eq('project_id', id)
          .order('id', { ascending: true }).range(offset, offset + limit - 1),
        `versions for ${id}`,
      )),
      collectAllRows<VisualizerAssetRow>((offset, limit) => fetchRowPage(
        supabaseAdmin.from('mb_visualizers').select('video_url, source_image_url').eq('project_id', id)
          .order('id', { ascending: true }).range(offset, offset + limit - 1),
        `visualizers for ${id}`,
      )),
    ])
    // A failed enumeration must not read as "this project owned nothing" — that
    // is precisely how the bytes go missing. Log it and keep going: the user's
    // delete must still succeed, and the operator needs to know a sweep is owed.
    for (const [label, rows] of [['versions', versionRows], ['visualizers', visualizerRows]] as const) {
      if (rows === null) console.error(`[project delete] could not enumerate ${label} for ${id} — storage cleanup will be incomplete`)
    }
    const rows = {
      projects: [project as ProjectAssetRow],
      versions: versionRows ?? [],
      visualizers: visualizerRows ?? [],
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

// Named rather than inlined into the signature so the helper's body is the
// first braced region after its name — scripts/source-contract.mjs slices
// functions that way, and an inline object type silently hands it the type
// literal instead of the code it is meant to police.
type RowQuery = PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>

/**
 * Await one page of a PostgREST enumeration, mapping any failure to null.
 *
 * Null and `[]` must stay distinguishable all the way up: collectAllRows() stops
 * on an empty page and gives up on a null one, so collapsing an error into `[]`
 * here would end the enumeration early and report the truncated result as
 * complete — the precise failure the paging replaced `.limit(1000)` to avoid.
 */
async function fetchRowPage<T>(query: RowQuery, label: string): Promise<T[] | null> {
  const { data, error } = await query
  if (error) {
    console.error(`[project delete] enumerating ${label} failed: ${error.message}`)
    return null
  }
  return (data ?? []) as T[]
}

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
  // Key-shape filter, run BEFORE the survivor scan and alongside it — not
  // instead of it. filterToOwnedPrefixes' docstring says the two cover
  // different halves and both run; delete-account has always run both, and
  // this path ran only the scan, which is the half that cannot see this case.
  //
  // The gap it closes: PATCH accepts any `isSupabaseStorageUrl()` for
  // artwork_url / instrumental_url (protocol + hostname only, no ownership
  // check — unlike the visualizer pins just below it, which do verify
  // mb_visualizers.user_id). So a user can point a throwaway project of their
  // own at a stranger's object and delete the project to destroy it. The scan
  // cannot stop that: pass 1 matches exact URLs, and an UNREFERENCED object —
  // a superseded finalized-<ts>.jpg, an unpicked ai-<ts>.webp — has no
  // surviving row to find; pass 2's prefix match is scoped to THIS project's
  // id, so it never looks under the victim's prefix. Key shape settles it with
  // no query.
  //
  // Deleting one project, so the owned set is exactly [id]. Keys with no
  // project prefix (the mf-audio bucket-root uploads) are attributed to
  // nothing and pass through untouched, to be judged by the scan alone —
  // filtering them out here would strand a user's own root audio in a public
  // bucket. This can only ever narrow what gets deleted, never widen it.
  candidates = filterToOwnedPrefixes(candidates, [id])

  if (totalKeyCount(candidates) === 0) return

  const scan = await survivingAssetKeys(candidateUrls, id)
  if (!scan) {
    // The scan is what tells shared objects apart from exclusively-owned ones.
    // Without it we cannot prove a key is safe to delete, and deleting a shared
    // object destroys another project's live media. Leak deliberately.
    console.error(
      `[project delete] survivor scan failed for ${id} — skipping storage cleanup to avoid deleting ` +
      `objects another project still references. ${totalKeyCount(candidates)} object(s) may be orphaned.`,
    )
    return
  }

  // keysSafeToDelete applies the coverage rule BEFORE subtracting, so a scan
  // that lost its prefix pass cannot be spent as though it were complete. Doing
  // this by hand — `subtractKeys(candidates, scan.survivors)` — is the mistake
  // the SurvivorScan shape exists to make hard to write.
  const doomed = keysSafeToDelete(candidates, scan)

  if (scan.coverage !== 'all') {
    // Partial, and loud about which half was skipped. The withheld keys are the
    // ones only the prefix pass could have vouched for; they leak, as before.
    const withheld = totalKeyCount(candidates) - totalKeyCount(bucketRootKeys(candidates))
    console.error(
      `[project delete] survivor scan for ${id} lost its prefix pass — deleting only the ` +
      `${totalKeyCount(doomed)} bucket-root object(s) pass 1 could vouch for and leaving ${withheld} ` +
      `prefixed object(s) in place. Those may be orphaned and need a sweep.`,
    )
  }

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
 * Returns null when the scan cannot be trusted AT ALL — the caller must then
 * treat every key as possibly-shared and remove nothing, the same fail-safe
 * direction video-orphan-reaper takes when its reference scan can't be trusted.
 *
 * A pass-1 chunk that fails does NOT null the whole scan any more. That chunk
 * asked about a known list of URLs, so the damage is exactly scoped: those URLs
 * are folded into the survivor set as though a live row still named them. The
 * safety property is unchanged in the direction that matters — unknown still
 * means "keep", never "delete" — but one bad chunk no longer abandons cleanup
 * for the whole project, which is what made this feature a no-op on precisely
 * the large projects it exists for.
 *
 * A pass-2 failure no longer nulls the scan either; it DOWNGRADES it to
 * coverage 'bucket-root-only'. Pass 2's LIKE is not scoped to an enumerable set
 * of URLs, so most candidates genuinely become unprovable — but a key with no
 * path separator is not one of them. Every key pass 2 could contribute is
 * derived from a URL containing `/<id>/`, which in a canonical Supabase URL puts
 * `<id>/` inside the key itself; a slash-free key is therefore outside anything
 * pass 2 could have said, and pass 1 already answered for it by exact URL. See
 * ScanCoverage in src/lib/project-assets.ts for the full derivation and its one
 * stated residual. Discarding those answers was leaving 116 of 391 mf-audio
 * objects — the bucket with no sweeper — unreclaimable on a single failed query.
 *
 * Deliberately NOT scoped to the deleting user: PATCH only checks that
 * artwork_url is *a* Supabase storage URL, so one account can point a project
 * at another account's object. Scoping the scan by owner would let that pin be
 * used to delete a stranger's artwork.
 */
async function survivingAssetKeys(urls: string[], id: string): Promise<SurvivorScan | null> {
  const projects: ProjectAssetRow[] = []
  const versions: VersionAssetRow[] = []
  const visualizers: VisualizerAssetRow[] = []
  const collections: CollectionAssetRow[] = []

  // URLs the scan could not get an answer about, treated exactly as if a
  // surviving row still named them. See `run` below.
  const unresolved = new Set<string>()
  // Set when the UNSCOPED prefix pass gives up. Downgrades coverage rather than
  // failing the scan — see the header comment.
  let prefixFailed = false
  // How many queries came back with a usable answer. Zero means we learned
  // nothing at all, which must stay distinguishable from "asked, found nothing".
  let answered = 0

  // Every URL column that can name one of our candidate objects, imported from
  // project-assets rather than re-listed here.
  //
  // It WAS re-listed here — a second literal that had to be kept in step with
  // ASSET_URL_COLUMNS and collectAssetKeys() by hand, which is exactly the "two
  // places deriving the same answer differently" bug that module exists to
  // prevent. The two had already drifted: neither carried mb_collections, and
  // fixing only one of them would have left this scan blind. Importing the
  // shared constant removes the drift as a possibility rather than re-fixing it.
  const columns = ASSET_URL_COLUMNS

  const absorb = (table: string, rows: unknown[]) => {
    if (table === 'mb_versions') versions.push(...(rows as VersionAssetRow[]))
    else if (table === 'mb_projects') projects.push(...(rows as ProjectAssetRow[]))
    else if (table === 'mb_collections') collections.push(...(rows as CollectionAssetRow[]))
    else visualizers.push(...(rows as VisualizerAssetRow[]))
  }

  // `protect` is the URL list this query was asking about, or null when the
  // query is not scoped to one (pass 2). It is what a failure degrades to.
  const run = async (
    table: string,
    column: string,
    build: (q: ReturnType<typeof supabaseAdmin.from>) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
    protect: readonly string[] | null,
  ) => {
    let lastError: { message: string } | null = null

    // Retry once. With the fan-out bounded and the chunks sized to the request
    // line, what is left to fail here is overwhelmingly transient — a pooler
    // blip, a connection reset — and the cost of not retrying is not an error
    // page, it is these bytes leaking with nothing left to name them. PATCH's
    // visualizer lookup above makes the same call for the same reason. No
    // backoff: the bounded pool already staggers these, and a user is waiting.
    for (let attempt = 0; attempt < 2; attempt++) {
      let data: unknown[] | null = null
      let error: { message: string } | null = null
      try {
        ({ data, error } = await build(supabaseAdmin.from(table)))
      } catch (thrown) {
        // supabase-js reports failures in `error`, but a transport fault can
        // still throw. That exception used to escape DELETE entirely: a 500 for
        // a delete whose row removal had ALREADY succeeded, telling the user it
        // failed when it did not, and skipping cleanup on the way out.
        error = { message: thrown instanceof Error ? thrown.message : String(thrown) }
      }
      if (!error) {
        answered++
        absorb(table, data ?? [])
        return
      }
      // A column that may legitimately not exist on this database (the pins from
      // migrations 015 / 020, and either mb_collections cover spelling) means
      // there is nothing there to protect, not a broken scan. Never retried — it
      // cannot heal. Counted as ANSWERED because it is one: a column that does
      // not exist cannot be holding a reference. The injected select in
      // delete-account already reports this case as an empty row set for the
      // same reason. Keyed on `table.column`, not column — see
      // OPTIONAL_ASSET_URL_COLUMNS for why that distinction is load-bearing.
      if (OPTIONAL_ASSET_URL_COLUMNS.has(`${table}.${column}`) && errorNamesColumn(error, column)) {
        answered++
        return
      }
      lastError = error
    }

    console.error(`[project delete] survivor scan failed on ${table}.${column}: ${lastError?.message}`)

    if (protect) {
      // Scoped failure: assume every URL this chunk asked about is still
      // referenced. Unknown ⇒ survivor ⇒ leak. Strictly safer than deleting,
      // and strictly better than the old behaviour, where one bad chunk
      // abandoned cleanup for every other object the project owned.
      for (const url of protect) unresolved.add(url)
      return
    }

    // Unscoped failure: pass 2's LIKE spans every key under the project prefix,
    // so nothing the LISTING turned up can be proven safe any more. Downgrade
    // coverage instead of failing outright — the bucket-root keys pass 1
    // answered for are provably outside what this query could ever have said.
    prefixFailed = true
  }

  // Chunked ONCE — the URL list is the same for every column.
  //
  // Chunked by ENCODED length rather than a flat count of 50: these are full
  // URLs travelling in the PostgREST query string, and 50 of the real ones
  // (110 mf-audio rows carry raw spaces and parentheses, which postgrest-js
  // quotes) serialize to an 8,217-byte request line — past the usual 8,192
  // ceiling. That is a 414 on any project with 50 versions, and the route
  // already allows 1,000.
  const chunks = chunkByEncodedLength(urls)

  const queries: Array<() => Promise<void>> = []
  for (const [table, column] of columns) {
    // Pass 1 — exact matches on the URLs the deleted rows named. This is what
    // protects the iOS bucket-root audio keys, which have no project prefix.
    for (const chunk of chunks) {
      queries.push(() => run(table, column, q => q.select(column).in(column, chunk), chunk))
    }

    // Pass 2 — anything still pointing INTO this project's prefix. The prefix
    // listing turns up objects no column of ours named, so pass 1 cannot vouch
    // for them; this asks the question in key space instead. It is the check
    // that saves an artwork object another project reassigned to itself — two
    // such objects exist in production right now. `id` is a validated UUID, so
    // it carries no LIKE wildcards.
    //
    // No URL list scopes this one, so it passes null and a failure fails the
    // whole scan.
    queries.push(() => run(table, column, q => q.select(column).like(column, `%/${id}/%`), null))
  }

  // Bounded, NOT Promise.all. This used to fire columns × chunks + columns
  // queries simultaneously — about 147 at the route's own limit(1000) — which
  // is how the pooler rejections that failed the entire scan happened in the
  // first place.
  await runBounded(queries, SCAN_CONCURRENCY)

  // Not one query answered. That is an outage, not a partial answer: handing
  // back an empty survivor set here would read as "no row references any of
  // these" and authorise deleting every candidate, which is the single confusion
  // this return type exists to prevent. Same rule as scanSurvivingKeys().
  if (answered === 0 && queries.length > 0) return null

  const found = collectAssetKeys({ projects, versions, visualizers, collections })

  // Fold the unanswered URLs in as though they were survivors — through the
  // SHARED derivation, so their keys are worked out exactly the way the
  // candidate keys were (WebM twins included) rather than by a second parser
  // that could drift out of step with it.
  const survivors = unresolved.size === 0
    ? found
    : unionKeys(found, collectAssetKeys(assumedSurvivorRows([...unresolved])))

  return { survivors, coverage: prefixFailed ? 'bucket-root-only' : 'all' }
}
