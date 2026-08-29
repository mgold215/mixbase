import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import * as Sentry from '@sentry/nextjs'
import { supabaseAdmin } from '@/lib/supabase'
import { removeStorageObjects } from '@/lib/storage-remove'
import { accountDeleteLimiter, rateLimitHeaders, checkUserLimit } from '@/lib/rate-limit'
import {
  AUDIO_BUCKET,
  ARTWORK_BUCKET,
  VIDEO_BUCKET,
  collectAllRows,
  collectAssetKeys,
  collectAssetUrls,
  type CollectionAssetRow,
  OPTIONAL_ASSET_URL_COLUMNS,
  errorNamesColumn,
  filterToOwnedPrefixes,
  keysSafeToDelete,
  scanSurvivingKeys,
  totalKeyCount,
  type AssetKeys,
  type AssetUrlSelect,
  type ProjectAssetRow,
  type VersionAssetRow,
  type VisualizerAssetRow,
} from '@/lib/project-assets'
// The SAME request-line bound DELETE /api/projects/[id] applies to its survivor
// scan, reused rather than reinvented. An `.in()` list travels in the query
// string, so the hazard is identical wherever one is built from a list whose
// length the user controls — and two places sizing that list differently is the
// bug class src/lib/survivor-scan-plan.ts exists to prevent.
import { chunkByEncodedLength } from '@/lib/survivor-scan-plan'

// Named rather than inlined into the signature — see the same type in
// src/app/api/projects/[id]/route.ts.
type RowQuery = PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>

/**
 * Await one page of a PostgREST enumeration, mapping any failure to null.
 *
 * Null and `[]` must stay distinguishable: collectAllRows() stops on an empty
 * page and gives up on a null one, so collapsing an error into `[]` here would
 * end the enumeration early and pass the truncated result off as complete.
 */
async function fetchRowPage<T>(query: RowQuery, label: string): Promise<T[] | null> {
  const { data, error } = await query
  if (error) {
    console.error(`[delete-account] enumerating ${label} failed: ${error.message}`)
    return null
  }
  return (data ?? []) as T[]
}

/**
 * True when a PostgREST error means "this table isn't in this environment".
 *
 * Deliberately the SAME idiom src/lib/schema-heal.ts already uses for its own
 * optional relations (isMissingFeedCommentsTable, isMissingLibraryTracksTable)
 * rather than a second mechanism: match the SQL state 42P01, or a message that
 * both names THIS table and reads as a missing relation. 'schema cache' is in
 * the pattern because PostgREST answers an unknown table with PGRST205
 * ("Could not find the table 'public.x' in the schema cache") rather than a
 * Postgres error, and that is the form a fresh deploy actually sees.
 *
 * Requiring the table NAME is what keeps this narrow. Swallowing every
 * missing-relation error would let an error about some OTHER relation — a
 * broken view, a dropped FK target — silently pass for "optional table absent"
 * and skip a deletion that really did fail. That error must still abort.
 */
function isMissingRelation(error: { code?: string; message?: string } | null, table: string): boolean {
  if (!error) return false
  if (error.code === '42P01' && !!error.message?.includes(table)) return true
  return !!error.message && error.message.includes(table) && /does not exist|relation|schema cache/.test(error.message)
}

// Tables belonging to OTHER products that share this Supabase project — and,
// critically, share its auth.users. mixMASH (Railway services mixmash-api /
// -worker / -web, migration mixmash_initial) keys these to auth.users with
// confdeltype 'a', so a single row makes auth.admin.deleteUser fail and this
// user's mixBASE account becomes permanently undeletable.
//
// NOT deleted from here — see the pre-flight below for the reasoning. Listed by
// NAME ONLY and probed for nothing but a count, so mixBASE never reads another
// product's user data and nothing here depends on mixMASH's columns, its FK
// ordering, or its schema staying as it is today. If any of these tables is
// renamed, dropped, or given an ON DELETE CASCADE, this probe degrades to "not
// blocking" and the erasure simply proceeds.
const FOREIGN_BLOCKING_TABLES = ['mm_mixes', 'mm_tracks', 'mm_render_jobs'] as const

/**
 * Count rows in other products' tables that would block auth.admin.deleteUser.
 *
 * Returns the blocking tables (empty when clear), or null if the question could
 * not be answered. A table that does not exist here is NOT a blocker — a fresh
 * environment has the mb_* tables but none of the mm_* ones, and treating that
 * as a blocker would invent a new way to make an account undeletable.
 */
async function countForeignBlockers(
  userId: string,
): Promise<{ table: string; count: number }[] | null> {
  const blockers: { table: string; count: number }[] = []
  for (const table of FOREIGN_BLOCKING_TABLES) {
    // head + exact count: we need the NUMBER, never the rows. Reading another
    // product's records to decide our own deletion would be exactly the
    // overreach this pre-flight exists to avoid.
    const { count, error } = await supabaseAdmin
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
    if (error) {
      if (isMissingRelation(error, table)) continue
      console.error(`[delete-account] could not probe ${table} for ${userId}: ${error.message}`)
      return null
    }
    if ((count ?? 0) > 0) blockers.push({ table, count: count ?? 0 })
  }
  return blockers
}

// POST /api/auth/delete-account — permanently delete user and all their data
// Deletes storage files first (GDPR), then DB rows, then the auth user.
/**
 * Every mb_projects column that names a storage object, in the order the
 * projection asks for them. Kept adjacent to ProjectAssetRow on purpose: that
 * type is what collectAssetKeys reads, and the two drifting apart is precisely
 * how acapella_url became a byte nobody could delete.
 */
const PROJECT_ASSET_COLUMNS = [
  'id',
  'artwork_url',
  'finalized_artwork_url',
  'visualizer_url',
  'visualizer_wide_url',
  'acapella_url',
] as const

/**
 * The widest projection this deployment's schema actually supports.
 *
 * Railway deploys code the moment a PR merges while migrations are applied by
 * hand, so an optional column can be absent for a while — and PostgREST rejects
 * the WHOLE select when one referenced column is unknown. Asking for everything
 * unconditionally would turn a pending migration into a total enumeration
 * failure, which this route reports as "no projects" and treats as a clean
 * erasure. Degrading one column at a time is strictly better than that: we lose
 * the bytes that column names, and keep every other byte.
 *
 * Only columns declared in OPTIONAL_ASSET_URL_COLUMNS may be dropped. A missing
 * artwork_url is a real failure and must surface, not be quietly excused —
 * excusing it is what turns a broken scan into a licence to delete.
 */
async function resolveProjectProjection(): Promise<string> {
  const columns: string[] = [...PROJECT_ASSET_COLUMNS]
  // PostgREST names only the FIRST unknown column, so drop at most one per round.
  for (let attempt = 0; attempt < PROJECT_ASSET_COLUMNS.length; attempt++) {
    const projection = columns.join(', ')
    const { error } = await supabaseAdmin.from('mb_projects').select(projection).limit(1)
    if (!error) return projection
    const missing = columns.find(
      c => OPTIONAL_ASSET_URL_COLUMNS.has(`mb_projects.${c}`) && errorNamesColumn(error, c),
    )
    // Not a missing-optional-column failure (network, RLS, a required column):
    // hand it back unchanged so the real paged read reports it properly rather
    // than this probe swallowing it.
    if (!missing) return projection
    console.warn(`[delete-account] mb_projects.${missing} absent — its storage objects cannot be reaped`)
    columns.splice(columns.indexOf(missing), 1)
  }
  return columns.join(', ')
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // Bounds the blast radius of a stolen session against the least reversible
  // route in the app. See accountDeleteLimiter for why this is a cap and not
  // the step-up password check /api/auth/change-password already has.
  const limit = await checkUserLimit(accountDeleteLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  // ── PRE-FLIGHT: can this erasure finish at all? ─────────────────────────────
  // FIRST, before Stripe, before a single row or byte is touched.
  //
  // This Supabase project is shared by several of Matt's products, and they
  // share ONE auth.users. mixMASH keys mm_mixes / mm_tracks / mm_render_jobs to
  // auth.users with NO ACTION, so if this user has any mixMASH data, the very
  // LAST statement of this route — auth.admin.deleteUser — dies on a raw
  // foreign-key violation. By then the Stripe subscription is cancelled, every
  // mixBASE row is deleted and every byte is gone: the user has lost everything
  // AND still has an account, and the 500 they get names no cause. That is the
  // worst outcome this route can produce, and today nothing detects it.
  //
  // Asking the question up front converts it into a clean, retryable refusal
  // that changes nothing. It costs three counting queries on the happy path.
  //
  // WHY DETECT AND NOT DELETE. Reaching into another product's tables looked
  // like the obvious fix and is worse on the merits:
  //   * mm_tracks.storage_path / stems_path and mm_mixes.render_path are the
  //     ONLY pointers to that audio, and it lives in mixMASH's storage buckets,
  //     which this route cannot sweep. Deleting the rows would destroy the
  //     index while leaving the bytes — the personal data survives and nothing
  //     can find it again. For a GDPR erasure that is a step backwards.
  //   * Doing it safely means encoding mixMASH's FK order here (mm_mix_items
  //     references mm_tracks NOT NULL with NO ACTION, so mm_mixes must be
  //     deleted before mm_tracks), which hard-couples mixBASE to a schema it
  //     does not own and cannot test against.
  // So: refuse precisely, name the table and the count, and let the erasure be
  // completed by whoever owns that data. Zero rows exist in any of these tables
  // today, so this branch is unreachable in production right now — it exists so
  // that the first mixMASH user to request deletion produces a one-line
  // diagnosis instead of an unexplainable 500.
  const foreignBlockers = await countForeignBlockers(userId)
  if (foreignBlockers === null || foreignBlockers.length > 0) {
    const detail = foreignBlockers === null
      ? 'the pre-flight probe itself failed'
      : foreignBlockers.map(b => `${b.table}=${b.count}`).join(', ')
    console.error(`[delete-account] refusing to start erasure for ${userId} — ${detail}`)
    Sentry.captureMessage('delete-account: blocked by another product\'s rows on the shared auth user', {
      level: 'error',
      extra: { userId, blockers: foreignBlockers ?? 'probe failed' },
    })
    // Nothing has been touched, so this is honest and the user can retry once
    // the blocking data is cleared.
    return NextResponse.json(
      { error: 'Your account could not be deleted automatically because other data is still linked to it. Nothing was changed — support has been notified.' },
      { status: 409 },
    )
  }

  // Cancel any active Stripe subscription FIRST — once profiles is deleted the
  // stripe_subscription_id is gone and the webhook can never reconcile, so a
  // deleted account would keep getting billed. Cancellation must never block the
  // deletion: log and continue on any error, and treat an already-cancelled sub
  // (resource_missing) as success.
  const { data: billing } = await supabaseAdmin
    .from('profiles')
    .select('stripe_subscription_id')
    .eq('id', userId)
    .single()
  const subscriptionId = billing?.stripe_subscription_id
  if (subscriptionId && process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
      await stripe.subscriptions.cancel(subscriptionId)
    } catch (err) {
      const code = (err as { code?: string })?.code
      if (code !== 'resource_missing') {
        console.error('[delete-account] Stripe cancel failed for', userId, err instanceof Error ? err.message : err)
        Sentry.captureMessage('delete-account: Stripe subscription cancel failed', {
          level: 'warning',
          extra: { userId, subscriptionId, error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
  }

  // Gather projects (with both artwork URLs) and version IDs before deleting
  // anything. Folding the URLs into this select avoids a second full scan.
  //
  // PAGED, AND ITS ERROR IS READ. It had neither. `const { data: projects } =`
  // discarded the error object outright, so a failed read was indistinguishable
  // from "this user owns no projects" — and every consequence of that is silent:
  // an empty projectIds skips the versions enumeration, empties the candidate
  // key set, and hands filterToOwnedPrefixes an empty owned set, after which the
  // route reports a clean GDPR erasure having cleaned up nothing at all. The
  // missing range is the same defect one layer down: no `.limit()` is not "no
  // ceiling", it is PostgREST's server-side `max-rows` applied invisibly.
  //
  // WHAT AN INCOMPLETE READ HERE COSTS — checked against the live FK graph
  // (pg_constraint, 2026-08-19) rather than assumed, because the answer is what
  // decides whether this branch may abort. It costs BYTES, not PII: mb_projects
  // is deleted by `.eq('user_id', …)` below, NOT by this list, and every child of
  // mb_projects is ON DELETE CASCADE — mb_versions, mb_activity,
  // mb_collection_items, mb_visualizers, mb_favorites, mb_press_kits,
  // mb_social_posts, mb_spotify_links, mb_curator_submissions and sb_submissions
  // all read confdeltype 'c'. So the account still empties completely and no PII
  // survives; what is lost is the URL list naming this user's artwork and audio.
  // That is the versions enumeration's trade exactly, so it takes the versions
  // enumeration's answer: log, report, CONTINUE. Blocking a GDPR erasure over a
  // storage leak would trap the user in an undeletable account, which this route
  // must never do. A failed row DELETE is the opposite case and still aborts —
  // see the dbErrors gate below.
  //
  // THE PROJECTION IS THE WHOLE REACH OF THIS ROUTE. Unlike
  // DELETE /api/projects/[id], the account path has NO prefix sweep to catch what
  // this select misses — filterToOwnedPrefixes only BOUNDS keys that were already
  // nominated, it never discovers one. So any asset column omitted here is a byte
  // that survives a GDPR erasure, in a public-read bucket, with no later pass that
  // can ever name it again (only mf-video has a sweeper).
  //
  // This shipped broken. Migration 035 added mb_projects.acapella_url, registered
  // it in ASSET_URL_COLUMNS, and taught collectAssetKeys to read it — whose own
  // comment says "without this line the bytes would be invisible to account
  // delete, which has no prefix sweep" — while this select still asked only for
  // artwork. The read therefore saw `undefined` on every row. Both visualizer pins
  // had the same hole. It is the collections bug inverted: there a column was
  // asked for and its answer ignored; here a consumer read a field the producer
  // never fetched. Neither is visible from the consumer alone, which is why the
  // projection is now derived from one list next to the type it must satisfy.
  const projection = await resolveProjectProjection()
  const projects = await collectAllRows<ProjectAssetRow & { id: string }>(
    (offset, limit) => fetchRowPage(
      supabaseAdmin.from('mb_projects').select(projection).eq('user_id', userId)
        .order('id', { ascending: true }).range(offset, offset + limit - 1),
      `projects for ${userId}`,
    ))
  if (projects === null) {
    console.error(
      `[delete-account] could not enumerate projects for ${userId} — none of their artwork or audio can ` +
      `be named, so NO storage cleanup will happen and all of it needs a sweep. Row deletion continues.`,
    )
    Sentry.captureMessage('delete-account: project enumeration incomplete, storage cleanup skipped', {
      level: 'warning',
      extra: { userId },
    })
  }

  const projectIds = (projects ?? []).map(p => p.id)

  let versionIds: string[] = []
  let versions: VersionAssetRow[] = []

  if (projectIds.length > 0) {
    // PAGED. This select carried no `.limit()` at all, which is not "unbounded"
    // — it silently inherits PostgREST's server-side `max-rows` ceiling, and a
    // truncation you cannot see in the code is worse than one you can. It is
    // also the REACHABLE instance of that bug: this fans out over every project
    // a user owns, and the largest account today holds 271 versions against a
    // per-project maximum of 20. Rows past the cut would have their audio left
    // in a PUBLIC bucket after a GDPR erasure, in the one bucket with no sweeper.
    //
    // CHUNKED TOO, on the other axis. Paging bounds how many rows come BACK;
    // `.in('project_id', projectIds)` is how many ids go OUT, and it rides in
    // the query string. Chunk boundaries are per-filter, so each chunk gets its
    // own independent offset walk.
    const collectedVersions: { id: string; audio_url: string | null }[] = []
    let versionsComplete = true
    for (const chunk of chunkByEncodedLength(projectIds)) {
      const page = await collectAllRows<{ id: string; audio_url: string | null }>(
        (offset, limit) => fetchRowPage(
          supabaseAdmin.from('mb_versions').select('id, audio_url').in('project_id', chunk)
            .order('id', { ascending: true }).range(offset, offset + limit - 1),
          `versions for ${userId}`,
        ))
      if (page === null) { versionsComplete = false; break }
      collectedVersions.push(...page)
    }
    // One unanswered chunk makes the WHOLE list untrustworthy, same contract
    // collectAllRows applies to one unanswered page: a partial enumeration read
    // as complete is what leaks bytes silently, and this list is only ever spent
    // on byte cleanup.
    const rows = versionsComplete ? collectedVersions : null
    if (rows === null) {
      // Logged, NOT fatal. Checked against the live schema (2026-08-18) before
      // choosing this: every dependent of mb_versions that matters here —
      // mb_feedback, mb_feed_comments, mb_collab_requests — is ON DELETE
      // CASCADE, and the mb_versions delete below is keyed by project rather
      // than by this list, so the account still empties completely and no PII
      // survives. What an incomplete read costs is only the byte cleanup for the
      // rows it could not see. Blocking a GDPR erasure over a leak is the wrong
      // trade and the wrong direction: this route must never trap a user in an
      // undeletable account, so storage trouble is logged for a sweep, never
      // returned. Same call the project-delete path makes.
      console.error(
        `[delete-account] could not enumerate versions for ${userId} — their audio will not be ` +
        `cleaned up and needs a sweep. Row deletion continues.`,
      )
      Sentry.captureMessage('delete-account: version enumeration incomplete, audio may be orphaned', {
        level: 'warning',
        extra: { userId, projectCount: projectIds.length },
      })
    }
    versionIds = (rows ?? []).map(v => v.id)
    versions = (rows ?? []) as VersionAssetRow[]
  }

  // Visualizers (free canvas + AI + finished YouTube/Shorts) are keyed by
  // user_id and stored in mf-video. They were previously never cleaned up,
  // leaving orphaned rows and bytes after a GDPR delete.
  //
  // Selected by user_id, NOT by project — that is deliberately broader than
  // DELETE /api/projects/[id]'s project-scoped lookup, because project_id is
  // nullable and a row without one would otherwise be missed here. Row
  // SELECTION is what legitimately differs between the two delete paths; the
  // URL→key derivation below must not.
  //
  // Paged for the same reason as the versions enumeration above: no `.limit()`
  // is not "no ceiling", it is PostgREST's own `max-rows` applied invisibly.
  // Unlike versions this list feeds ONLY the byte cleanup — the row delete below
  // is keyed by user_id — so an incomplete read is logged and the deletion
  // proceeds rather than blocking the user's erasure over a leak.
  const visualizers = await collectAllRows<VisualizerAssetRow>((offset, limit) => fetchRowPage(
    supabaseAdmin.from('mb_visualizers').select('id, video_url, source_image_url').eq('user_id', userId)
      .order('id', { ascending: true }).range(offset, offset + limit - 1),
    `visualizers for ${userId}`,
  ))
  if (visualizers === null) {
    console.error(
      `[delete-account] could not enumerate visualizers for ${userId} — their video and source-image ` +
      `bytes will not be cleaned up and need a sweep.`,
    )
  }

  // Collections (albums / EPs) carry a cover image in mf-artwork, and until
  // 2026-08-21 this route never looked at it — the enumeration below used to
  // live in the row-delete phase and selected `id` only, so a cover was never a
  // candidate and its bytes survived the user's erasure in a PUBLIC bucket.
  //
  // It is not a theoretical shape: production holds
  // `collection-<id>-<ts>.jpg` at the mf-audio-style BUCKET ROOT, named by
  // nothing but mb_collections.cover_url. Root keys attribute themselves to no
  // project, so FILTER 1 passes them through and only a row reference can ever
  // name them — which is precisely the reference this route was missing.
  //
  // select('*') for the same reason the projects select uses it: BOTH cover
  // spellings can be absent depending on how a database was bootstrapped
  // (migration 004 creates `artwork_url`, /api/db-init creates `cover_url`),
  // and PostgREST rejects the WHOLE select when one named column is missing.
  //
  // Enumerated ONCE, here, and reused for the mb_collection_items delete below.
  // Two enumerations of the same rows is the drift this file keeps being bitten
  // by; a failure is logged and erasure proceeds, exactly as before.
  const collections = await collectAllRows<{ id: string } & CollectionAssetRow>((offset, limit) => fetchRowPage(
    supabaseAdmin.from('mb_collections').select('*').eq('user_id', userId)
      .order('id', { ascending: true }).range(offset, offset + limit - 1),
    `collections for ${userId}`,
  ))
  if (collections === null) {
    console.error(
      `[delete-account] could not enumerate collections for ${userId} — their cover bytes will not ` +
      `be cleaned up, and mb_collection_items falls back to the CASCADE from mb_collections.`,
    )
  }
  const collectionIds = (collections ?? []).map(c => c.id)

  // One shared derivation for both delete paths (src/lib/project-assets.ts):
  // source + finalized artwork, audio, visualizer videos AND the pre-conversion
  // WebM twin the MP4 heal leaves behind, all deduped per bucket. Anything this
  // route derived by hand instead was free to drift from the project-delete
  // path — and did: source_image_url was missed entirely here.
  const assetRows = {
    projects: (projects ?? []),
    versions,
    visualizers: visualizers ?? [],
    collections: collections ?? [],
  }
  const collected = collectAssetKeys(assetRows)
  const candidateUrls = collectAssetUrls(assetRows)

  // FILTER 1 (pure, cannot fail): a candidate whose key attributes itself to a
  // project this user does not own is not ours to delete.
  //
  // Storage objects are NOT privately owned by the row that names them.
  // isSupabaseStorageUrl() — the only guard on PATCH /api/projects/[id]'s
  // artwork_url and POST /api/visualizer/finalize's sourceImageUrl — checks the
  // protocol and hostname and nothing else, so a crafted request can make one
  // of THIS user's rows point at ANOTHER user's live artwork. Without this
  // filter, deleting the crafting account destroys the victim's cover and
  // leaves a 404 on their live project.
  //
  // Only keys that name a project id in their first segment are judged here.
  // Bucket-root keys carry no owner at all (116 of 390 mf-audio objects, of
  // which only 5 are the iOS `<UUID>-v<n>-<ts>.wav` shape — the rest are plain
  // filenames like `HALFWAY - MIX 1.wav`), so demanding a prefix would refuse
  // to erase a user's OWN audio and defeat the GDPR wipe in the one bucket with
  // no sweeper. Those fall through to the reference check below instead.
  const assetKeys = filterToOwnedPrefixes(collected, projectIds)
  const foreign = totalKeyCount(collected) - totalKeyCount(assetKeys)
  if (foreign > 0) {
    // Not fatal, but it means rows of this user named objects under someone
    // else's project prefix — worth seeing, since nothing legitimate does that.
    console.warn(
      `[delete-account] ${foreign} candidate object(s) for ${userId} sit under a project prefix this ` +
      `user does not own — left in place rather than deleting another account's media.`,
    )
  }

  // Delete DB rows in dependency order, capturing every error. If ANY row
  // deletion fails we abort before auth.admin.deleteUser — otherwise the auth
  // user would be destroyed while PII rows keyed to that id linger as zombies.
  const dbErrors: string[] = []
  const del = async (p: PromiseLike<{ error: { message: string } | null }>, label: string) => {
    const { error } = await p
    if (error) dbErrors.push(`${label}: ${error.message}`)
  }

  // del()'s contract, minus ONE pre-identified failure: this table not existing
  // in this environment. Everything else still lands in dbErrors and still
  // aborts — "optional" is about the table's PRESENCE, never about whether its
  // rows were really deleted.
  //
  // This distinction is the whole point. Several tables the erasure must clear
  // are absent from db-init's SCHEMA_SQL and arrive only via supabase/migrations,
  // so a freshly bootstrapped environment genuinely does not have them. Routing
  // those through plain del() would push a "relation does not exist" string into
  // dbErrors and trip the abort gate below — turning a hardening change into a
  // brand-new way to make account deletion impossible, which is precisely the
  // bug class this whole sweep exists to close.
  const delOptional = async (
    p: PromiseLike<{ error: { code?: string; message: string } | null }>,
    label: string,
  ) => {
    const { error } = await p
    if (!error) return
    if (isMissingRelation(error, label)) {
      console.warn(`[delete-account] optional table ${label} is not present in this environment — skipped`)
      return
    }
    dbErrors.push(`${label}: ${error.message}`)
  }

  // EVERY `.in()` BELOW IS CHUNKED, and on this path that is not a precaution —
  // one of them is over the wire limit in production right now.
  //
  // An `.in()` list is serialized into the query string, so its length is part
  // of the HTTP request line, which nginx/Kong caps at the usual 8,192-byte
  // `large_client_header_buffers`. A canonical UUID costs 39 encoded characters
  // in that list (36 for the id, 3 for the `%2C` separator — postgrest-js
  // appends through url.searchParams, so the commas are percent-encoded too).
  // Measured against the live row counts (2026-08-19):
  //   * projectIds — 46 for the largest account = 1,794 characters. Latent.
  //   * versionIds — 271 for that same account = 10,569 characters. NOT latent:
  //     that request line is ~2.4 KB PAST the ceiling, so the mb_feedback delete
  //     414s before it reaches PostgREST, lands in dbErrors, and trips the abort
  //     gate below. That account cannot be erased at all today, and the failure
  //     grows with the account rather than resolving.
  // A count cap alone would not be a fix here either — see ASSET_URL_CHUNK — so
  // this uses the shared length-aware chunker rather than a second mechanism.
  // Chunking a delete is safe to do blindly: each statement removes its own
  // rows, per-chunk errors accumulate in dbErrors, and an empty list yields zero
  // chunks, which is why the old `length > 0` guards are gone rather than kept.
  for (const chunk of chunkByEncodedLength(versionIds)) {
    await del(supabaseAdmin.from('mb_feedback').delete().in('version_id', chunk), 'mb_feedback')
  }
  for (const chunk of chunkByEncodedLength(projectIds)) {
    await del(supabaseAdmin.from('mb_activity').delete().in('project_id', chunk), 'mb_activity')
    await del(supabaseAdmin.from('mb_versions').delete().in('project_id', chunk), 'mb_versions')
  }

  // mb_activity AGAIN, by owner. The by-project delete above cannot reach a row
  // whose project_id is NULL, and mb_activity.user_id references auth.users with
  // NO ACTION (verified in pg_constraint, 2026-08-19) — so one such row is
  // enough to make auth.admin.deleteUser fail on a foreign-key violation and
  // leave the account permanently undeletable. Exactly the Submitbase trap
  // documented further down, in a table nobody had checked. Production holds one
  // of these rows today, and it belongs to the 46-project account above.
  // Cascade does not save this case: mb_activity CASCADEs from mb_projects, and
  // a row with no project_id has no mb_projects row to cascade from.
  await del(supabaseAdmin.from('mb_activity').delete().eq('user_id', userId), 'mb_activity (by owner)')
  // Visualizers are keyed by user_id (not project) — delete by owner.
  await del(supabaseAdmin.from('mb_visualizers').delete().eq('user_id', userId), 'mb_visualizers')

  // collectionIds came from the ASSET-phase enumeration above — the same rows,
  // read once. mb_collection_items is ON DELETE CASCADE from mb_collections
  // (deleted just below), so this loop is belt-and-braces; it is kept because
  // "the cascade covers it" is a schema property a future migration can revoke
  // silently, and an unreadable list therefore costs nothing here.
  for (const chunk of chunkByEncodedLength(collectionIds)) {
    await del(supabaseAdmin.from('mb_collection_items').delete().in('collection_id', chunk), 'mb_collection_items')
  }

  await del(supabaseAdmin.from('mb_collections').delete().eq('user_id', userId), 'mb_collections')
  await del(supabaseAdmin.from('mb_releases').delete().eq('user_id', userId), 'mb_releases')
  await del(supabaseAdmin.from('mb_projects').delete().eq('user_id', userId), 'mb_projects')

  // Submitbase rows (migration 013) reference auth.users WITHOUT on delete
  // cascade, so leaving them makes auth.admin.deleteUser below fail with an FK
  // violation — the account becomes undeletable (a Guideline 5.1.1(v) bug, not
  // just a 500). Deleting the user's own curators leaves the shared starter
  // directory (user_id IS NULL) untouched.
  await del(supabaseAdmin.from('sb_submissions').delete().eq('user_id', userId), 'sb_submissions')
  await del(supabaseAdmin.from('sb_curators').delete().eq('user_id', userId), 'sb_curators')

  // mixBASE's OWN remaining NO ACTION references to auth.users, verified in
  // pg_constraint on production (2026-08-20): both read confdeltype 'a', so one
  // surviving row is enough to make auth.admin.deleteUser fail on a foreign-key
  // violation and leave the account permanently undeletable — a Guideline
  // 5.1.1(v) / GDPR erasure bug, not just a 500. Both hold zero rows today and
  // nothing in this repo writes to either (migration 006 leftovers from the
  // single-user era; grepped across src/ AND ios/), so this closes a latent
  // wedge rather than fixing a live break.
  //
  // mb_favorites is deleted BY OWNER rather than left to its CASCADE from
  // mb_projects, for exactly the reason mb_activity is: a row favouriting
  // SOMEONE ELSE's project has no project of this user's to cascade from.
  //
  // delOptional, not del: neither table is in db-init's SCHEMA_SQL, so a freshly
  // bootstrapped environment has neither, and a missing table must not abort an
  // erasure. See the note on isMissingRelation.
  await delOptional(supabaseAdmin.from('mb_favorites').delete().eq('user_id', userId), 'mb_favorites')
  await delOptional(supabaseAdmin.from('mb_spotify_auth').delete().eq('user_id', userId), 'mb_spotify_auth')

  if (dbErrors.length > 0) {
    // Leave the account intact and retryable rather than half-deleting it.
    console.error('[delete-account] aborting before auth deletion for', userId, dbErrors)
    Sentry.captureMessage('delete-account: aborted before auth deletion (partial DB delete)', {
      level: 'error',
      extra: { userId, dbErrors },
    })
    return NextResponse.json(
      { error: 'Failed to delete account data — no changes were finalized. Please try again.' },
      { status: 500 }
    )
  }

  // Remove the bytes ONLY now, once every row of this user's is confirmed gone.
  //
  // The order is deliberate and must not be swapped back. Deleting bytes first
  // (as this route used to) means the abort branch above returns "no changes
  // were finalized" over an account whose every mix and cover has already been
  // destroyed — live rows pointing at 404s, unrecoverable. Doing it here makes
  // that message true, and it is what lets the survivor scan work at all: this
  // user's own rows are gone, so anything still naming a candidate object is by
  // definition a different, live owner. Same reasoning as the survivor scan in
  // DELETE /api/projects/[id]. A storage failure still must NOT trap the user in
  // an undeletable account, so it is logged for a later sweep, never returned.
  await removeAccountAssets(userId, assetKeys, candidateUrls)

  // Delete the auth user last (cascades to profiles via FK). Log + Sentry the
  // failure like every branch above — this was the one 500 path that returned
  // silently, which made a real deletion failure (e.g. an invalid service-role
  // key downgrading admin calls to anon) invisible in the logs.
  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId)
  if (error) {
    console.error('[delete-account] auth.admin.deleteUser failed for', userId, error.message)
    Sentry.captureMessage('delete-account: auth.admin.deleteUser failed', {
      level: 'error',
      extra: { userId, error: error.message },
    })
    return NextResponse.json({ error: 'Failed to delete account' }, { status: 500 })
  }

  const response = NextResponse.json({ ok: true })
  response.cookies.delete('sb-access-token')
  response.cookies.delete('sb-refresh-token')
  response.cookies.delete('sb-authed')
  response.cookies.delete('sb-expires-at')
  return response
}

// Which columns may legitimately be absent is decided in ONE place, shared with
// DELETE /api/projects/[id] (OPTIONAL_ASSET_URL_COLUMNS in project-assets.ts).
//
// This route used to keep its own `new Set(['visualizer_url',
// 'visualizer_wide_url'])`, which had already drifted: it never learned about
// mb_collections.cover_url / .artwork_url, so on a /api/db-init-bootstrapped
// database (where mb_collections is absent) the scan returned null for those
// chunks, folded every candidate into `unresolved`, and skipped the cleanup
// entirely — erasure defeated, silently. Failing towards a leak is the right
// DIRECTION, but the drift is the defect: a duplicated rule is one edit from
// disagreeing with the rule it copies, which is the whole reason
// project-assets.ts exists.
//
// Keyed on `table.column`, never column alone — `artwork_url` names both
// mb_projects (load-bearing) and mb_collections (routinely absent), so a
// column-only key would excuse a real mb_projects failure and turn a broken
// scan into a licence to delete.

/**
 * FILTER 2 (reference check): drop the user's storage objects, minus anything a
 * row that SURVIVED the account deletion still points at.
 *
 * This is the filter that covers the key shapes filterToOwnedPrefixes cannot
 * judge — above all the 116 bucket-root mf-audio objects, whose names carry no
 * project id at all. For those, "is anybody else still using this?" is the only
 * question that can be asked, and it has to be asked of the DB.
 */
async function removeAccountAssets(userId: string, candidates: AssetKeys, candidateUrls: string[]) {
  if (totalKeyCount(candidates) === 0) return

  const select: AssetUrlSelect = async (table, column, urls) => {
    const { data, error } = await supabaseAdmin.from(table).select(column).in(column, [...urls])
    if (error) {
      if (OPTIONAL_ASSET_URL_COLUMNS.has(`${table}.${column}`) && errorNamesColumn(error, column)) return []
      console.error(`[delete-account] survivor scan failed on ${table}.${column}: ${error.message}`)
      return null
    }
    return data ?? []
  }

  const scan = await scanSurvivingKeys(select, candidateUrls)
  if (!scan) {
    // Without the scan we cannot prove a key is unshared, and deleting a shared
    // object destroys another account's live media — strictly worse than the
    // leak. Fail towards leaking bytes, and make the sweep visible.
    console.error(
      `[delete-account] survivor scan failed for ${userId} — skipping storage cleanup to avoid deleting ` +
      `objects another account still references. ${totalKeyCount(candidates)} object(s) may be orphaned.`,
    )
    Sentry.captureMessage('delete-account: survivor scan failed, storage cleanup skipped', {
      level: 'warning',
      extra: { userId, objectCount: totalKeyCount(candidates) },
    })
    return
  }

  // Same coverage-aware helper DELETE /api/projects/[id] uses. This path has no
  // prefix pass, so scanSurvivingKeys always reports coverage 'all' and the
  // helper reduces to the subtraction it always did — but routing through it is
  // what keeps the two delete paths deciding "may I delete this?" identically,
  // which is the whole reason project-assets.ts exists.
  const doomed = keysSafeToDelete(candidates, scan)

  // Removal is VERIFIED per key, not inferred from the absence of an error. A
  // storage delete that RLS refuses returns 200 with `[]`, so an `if (error)`
  // check would be unreachable: this route reported a clean GDPR wipe while
  // every byte stayed in a PUBLIC bucket, and the Sentry warnings that were
  // supposed to feed a later sweep never fired once. Unconfirmed keys are
  // reported individually so a sweep has something to act on.
  for (const bucket of [AUDIO_BUCKET, ARTWORK_BUCKET, VIDEO_BUCKET] as const) {
    const paths = doomed[bucket]
    if (paths.length === 0) continue
    const outcome = await removeStorageObjects(bucket, paths)
    if (outcome.ok) continue
    console.error(
      `[delete-account] ${bucket} cleanup incomplete for`, userId,
      `— removed ${outcome.removed.length}/${paths.length}`,
      outcome.error ?? '(no error reported; the delete was refused or the objects were already gone)',
    )
    Sentry.captureMessage(`delete-account: ${bucket} cleanup incomplete`, {
      level: 'warning',
      extra: {
        userId,
        objectCount: paths.length,
        removedCount: outcome.removed.length,
        unconfirmed: outcome.unconfirmed,
        error: outcome.error,
      },
    })
  }
}
