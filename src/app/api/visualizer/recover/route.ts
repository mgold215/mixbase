import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { supabaseAdmin } from '@/lib/supabase'
import { isMissingVisualizerColumn } from '@/lib/schema-heal'
import { keyProjectId } from '@/lib/project-assets'
import { mp4TwinPath } from '@/lib/visualizer-encode'
import {
  VIDEO_BUCKET,
  indexVisualizer,
  indexedVisualizerAt,
  userOwnsProject,
} from '@/lib/visualizer-store'
import { parseVizStoragePath, totalBytesFromHeaders } from '@/lib/visualizer-finalize'
import { CHUNK_ENCODED_BUDGET, chunkByEncodedLength, runBounded } from '@/lib/survivor-scan-plan'
import { vizSaveLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'

// GET|POST /api/visualizer/recover — find renders that were uploaded but never
// indexed, and put them back in the user's library.
//
// ── WHY THIS ROUTE EXISTS ────────────────────────────────────────────────────
// Since PR #113 the full-resolution save is two independent steps: the browser
// PUTs the rendered video straight to the PUBLIC mf-video bucket via a signed
// URL from /api/upload-url (bytes never traverse Railway — see
// upload-audio-architecture), then POSTs a small JSON claim to
// /api/visualizer/finalize, and ONLY that claim writes the mb_visualizers row.
//
// /api/visualizer/finalize closes every SERVER-side way that sequence can leave
// bytes behind. What no request can close is the claim that never arrives: the
// tab is closed, the browser is killed, the phone suspends the tab, the network
// dies in the gap. The bytes are then in the bucket and the render is simply
// GONE from the user's library — no row, no error, nothing in Sentry, because
// the failure happened in a browser that stopped executing.
//
// This is not hypothetical. On 2026-08-14, 19:47:45 → 19:50:12 UTC, EIGHT
// objects were written for one project in a 2.5-minute burst with no rows to
// match — a user pressing generate eight times and getting nothing back, while
// Sentry recorded zero visualizer errors in thirty days.
//
// src/lib/video-orphan-reaper.ts already knows how to find these objects. It is
// the DISPOSAL half: after 24 h it deletes them. This is the RECOVERY half, and
// it runs the same scan to the opposite end.
//
// ── THE ONE RULE ─────────────────────────────────────────────────────────────
// THIS ROUTE NEVER DELETES ANYTHING. It is purely additive: it lists objects
// and it writes rows. Every ambiguity is therefore resolved toward "show less /
// claim nothing", never toward "clean up". A recovery tool that can destroy the
// bytes it is recovering is a footgun, and the reaper is the only code in this
// codebase licensed to remove an mf-video object.
//
// (ONE deletion is not visible in this file's own source, so it is called out
// here: indexVisualizer() cleans up after ITSELF, and if its INSERT fails while
// a re-read definitively reports no row, claimAfterInsertFailure returns
// 'remove-bytes' and the object is deleted. On the finalize lane that is
// correct — those bytes arrived seconds ago and nothing else will ever index
// them. On THIS lane it is backwards: the bytes already survived one lost
// claim, they are the very thing the user is trying to get back, and a
// transient PostgREST blip would destroy them permanently. So the claim below
// passes `removeOnFailure: false`, an opt-out that lives in visualizer-store.ts
// rather than in a second claim implementation here — two ways to index one
// object is exactly the drift class that file exists to prevent. A failed
// recovery therefore leaves the object exactly as it found it: still unclaimed,
// still recoverable on the next attempt.)
//
// ── EXIT TABLE ───────────────────────────────────────────────────────────────
// GET
//   401 not authenticated      — nothing read
//   503 owned-project scan failed / listing incomplete / reference scan failed
//                              — NOTHING is reported. A partial scan cannot
//                                tell "no row exists" from "we didn't ask", and
//                                offering a live library item as "unsaved"
//                                would invite a pointless duplicate claim. The
//                                UI simply shows no banner.
//   200 { recoverable, ... }   — every entry is an object under a project this
//                                caller owns that NOTHING references.
// POST
//   401 not authenticated      — no credit charged, nothing written
//   400 bad body / no paths    — no credit charged: a malformed request must
//                                not cost a save, nothing was computed
//   429 over the cap           — credit charged by definition, nothing written
//   200 { recovered, failed }  — PER-PATH outcomes. A path this caller does not
//                                own, or that names no object, lands in
//                                `failed` and never touches the library. The
//                                request as a whole still succeeds, because a
//                                recovery of 7 of 8 renders is a better answer
//                                than a blanket 400.
// No exit on either verb deletes a storage object. scripts/viz-recover-test.mjs
// asserts that over the source.

export const maxDuration = 60

// ── Bounds ───────────────────────────────────────────────────────────────────
// Every enumeration below is bounded twice: by a page cap that turns a pager
// which never advances into a FAILURE rather than an infinite loop, and by a
// result cap that keeps one request's work proportional to a user's library
// rather than to the whole bucket.

// Objects (or folder markers) per storage listing page.
const LIST_PAGE_SIZE = 1000

// Pages per prefix. A storage API that ignored `offset` would otherwise hand
// back the same page forever; hitting this cap is read as an INCOMPLETE
// listing, which fails the whole scan. Under-reporting is free here (nothing is
// deleted), but reporting from a listing we know is truncated is not — see
// `truncated` in the response.
const LIST_MAX_PAGES = 50

// Rows per page of the owned-project scan, and its own page ceiling.
const PROJECT_PAGE_SIZE = 1000
const PROJECT_MAX_PAGES = 20

// Project prefixes one GET will walk. A user with more owned folders than this
// gets a truncated (but honest) answer rather than a request that walks the
// whole bucket.
const MAX_OWNED_PREFIXES = 500

// Candidate objects one GET will consider before it stops collecting.
const MAX_CANDIDATES = 2000

// Recoverable objects one GET will report — and the ceiling on the per-path
// re-check below, which costs one query each.
const MAX_RECOVERABLE = 100

// Paths one POST may claim. A legitimate recovery is a handful of renders (the
// production incident was eight); 25 covers the worst observed burst several
// times over while bounding the per-path probe fan-out.
const MAX_RECOVER_PATHS = 25

// What a recovered clip is filed as. Every object this route can see was
// written by the signed-URL lane, whose only kind is 'free' — the finished
// youtube/shorts renders are stored server-side by /api/finalize-video and are
// indexed in the same call that uploads them, so they can never orphan this
// way.
const RECOVERED_KIND = 'free' as const

type StorageRow = {
  name: string
  id: string | null
  created_at: string | null
  metadata?: { size?: number | null } | null
}

type OwnedProject = { id: string; title: string }

// Named rather than written inline as `Promise<{ … } | null>` so that
// `functionBody()` in scripts/viz-recover-test.mjs slices this scan's BODY
// instead of its return-type literal — an inline object type puts the first `{`
// in the signature, and a contract that matches an empty region passes
// vacuously. See the "MAGIC CHARACTER WINDOWS" note in scripts/source-contract.mjs.
type OwnedScan = { projects: OwnedProject[]; pinned: Set<string> }

type Candidate = {
  path: string
  project: OwnedProject
  createdAt: string | null
  size: number | null
}

/**
 * One page of an mf-video prefix, or null on ANY failure.
 *
 * Same shape as the reaper's injected `listPage`: a partial listing cannot tell
 * an absent object from an unlisted one, so a failure is never a short answer.
 */
async function listPage(prefix: string, offset: number): Promise<StorageRow[] | null> {
  const { data, error } = await supabaseAdmin.storage
    .from(VIDEO_BUCKET)
    .list(prefix, { limit: LIST_PAGE_SIZE, offset, sortBy: { column: 'name', order: 'asc' } })
  if (error || !data) {
    console.error('[viz-recover] list failed:', error?.message ?? 'no data')
    return null
  }
  return data as unknown as StorageRow[]
}

/**
 * Every row under one prefix, or null if a page failed or the page cap was hit.
 *
 * STOPS ON AN EMPTY PAGE, NOT A SHORT ONE — and that is the one place this
 * pager deliberately differs from video-orphan-plan's. A short page is an
 * INFERENCE that the listing ended; an empty page is the listing SAYING so.
 * Supabase's list() filters within a page (folder markers, placeholder rows), so
 * a page can come back short while more rows sit behind it, and the cost of
 * being wrong is asymmetric per caller: for the reaper a missed row merely
 * survives another 24 h, while here a missed row is a user's render the recovery
 * UI never offers — the exact invisibility this route exists to end. The price
 * is one extra round trip per prefix, paid once per scan.
 *
 * A listing server that ignores `offset` therefore cannot terminate this loop
 * by handing back the same page forever; it runs into LIST_MAX_PAGES, which is
 * reported as a FAILED listing rather than as the end of the data.
 */
async function pageThrough(prefix: string): Promise<StorageRow[] | null> {
  const rows: StorageRow[] = []
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const batch = await listPage(prefix, page * LIST_PAGE_SIZE)
    if (batch === null) return null
    if (batch.length === 0) return rows
    rows.push(...batch)
  }
  console.error(`[viz-recover] listing of "${prefix}" exceeded ${LIST_MAX_PAGES} pages — treating as incomplete`)
  return null
}

/**
 * Every project this user owns, plus the visualizer URLs their projects pin.
 *
 * Returns null when ANY query failed — the caller turns that into a 503 rather
 * than reporting a scan it knows is short. The pins are folded in for the same
 * belt-and-braces reason the reaper folds them in: PATCH /api/projects/[id]
 * only accepts a pin whose URL already has an mb_visualizers row, so the row
 * scan should already cover every pin, and if that invariant ever drifts the
 * cost here is offering the user a duplicate claim of a video they can already
 * see.
 *
 * Ownership is the ONLY filter — `.eq('user_id', userId)` with `userId` taken
 * from the X-User-Id header the middleware injects. Nothing in a request body
 * ever reaches this query.
 */
async function ownedProjects(userId: string): Promise<OwnedScan | null> {
  // Same two-step probe the reaper's addProjectPins uses: PostgREST rejects the
  // WHOLE select when one referenced column is missing, and visualizer_wide_url
  // (migration 020) can be absent on a deploy that beat it while visualizer_url
  // (015) is present.
  const probe = await supabaseAdmin.from('mb_projects').select('visualizer_wide_url').limit(1)
  if (probe.error && !isMissingVisualizerColumn(probe.error)) {
    console.error('[viz-recover] pin probe failed (not a missing column):', probe.error.message)
    return null
  }
  const columns = probe.error ? 'id, title, visualizer_url' : 'id, title, visualizer_url, visualizer_wide_url'

  type ProjectRow = {
    id: string
    title: string | null
    visualizer_url?: string | null
    visualizer_wide_url?: string | null
  }

  // One page of owned projects, degrading to the bare identity columns on a
  // pre-015 schema that has no pin columns at all (nothing to protect, and
  // nothing wrong). Returns null only on a real failure.
  const readPage = async (from: number): Promise<ProjectRow[] | null> => {
    const range = <T,>(q: { range(a: number, b: number): T }) => q.range(from, from + PROJECT_PAGE_SIZE - 1)
    const primary = await range(
      supabaseAdmin.from('mb_projects').select(columns).eq('user_id', userId).order('id', { ascending: true }),
    )
    if (!primary.error) return (primary.data ?? []) as unknown as ProjectRow[]
    if (!isMissingVisualizerColumn(primary.error)) {
      console.error('[viz-recover] owned-project scan failed:', primary.error.message)
      return null
    }
    const bare = await range(
      supabaseAdmin.from('mb_projects').select('id, title').eq('user_id', userId).order('id', { ascending: true }),
    )
    if (bare.error) {
      console.error('[viz-recover] owned-project scan failed:', bare.error.message)
      return null
    }
    return (bare.data ?? []) as unknown as ProjectRow[]
  }

  const projects: OwnedProject[] = []
  const pinned = new Set<string>()

  for (let page = 0; page < PROJECT_MAX_PAGES; page++) {
    const rows = await readPage(page * PROJECT_PAGE_SIZE)
    if (rows === null) return null
    for (const row of rows) {
      projects.push({ id: row.id, title: row.title ?? 'Untitled' })
      if (row.visualizer_url) pinned.add(row.visualizer_url)
      if (row.visualizer_wide_url) pinned.add(row.visualizer_wide_url)
    }
    // A short page ends a POSTGREST range walk (unlike the storage pager above,
    // `.range()` is an exact row window with no in-page filtering).
    if (rows.length < PROJECT_PAGE_SIZE) return { projects, pinned }
  }
  console.error(`[viz-recover] owned-project scan exceeded ${PROJECT_MAX_PAGES} pages — aborting`)
  return null
}

/**
 * Which of these public URLs some mb_visualizers row already points at.
 *
 * Chunked by ENCODED length, not by a flat count: `.in()` travels in the query
 * string, and 50 long URLs serialize past the ~8 KB request line every nginx /
 * Kong in front of PostgREST enforces — measured, and the reason
 * CHUNK_ENCODED_BUDGET exists. The same helper the survivor scan uses is reused
 * here rather than re-derived, so the two cannot drift on what fits.
 *
 * NOT filtered by user_id, deliberately: a row belonging to ANYONE excludes the
 * object. Claiming an object another user's row indexes is refused downstream
 * by claimPrecheck ('foreign'), so surfacing it would only ever produce a
 * confusing failure.
 *
 * Returns null if any chunk failed — the caller reports nothing rather than
 * mistaking "we didn't ask" for "nothing points at this".
 */
async function referencedUrls(urls: readonly string[]): Promise<Set<string> | null> {
  if (urls.length === 0) return new Set()
  const chunks = chunkByEncodedLength(urls, CHUNK_ENCODED_BUDGET)
  // runBounded's contract is that a task NEVER rejects — a throw would abandon
  // the remaining workers mid-flight and leave this half-answered, which is the
  // one state indistinguishable from "nothing references these". So a transport
  // fault is caught here and recorded as the failed chunk it is.
  const results = await runBounded(chunks.map(chunk => async () => {
    try {
      const { data, error } = await supabaseAdmin
        .from('mb_visualizers')
        .select('video_url')
        .in('video_url', chunk)
      if (error) {
        console.error('[viz-recover] reference scan failed:', error.message)
        return null
      }
      return (data ?? []).map(r => r.video_url as string)
    } catch (err) {
      console.error('[viz-recover] reference scan threw:', err instanceof Error ? err.message : err)
      return null
    }
  }))
  const found = new Set<string>()
  for (const rows of results) {
    if (rows === null) return null
    for (const url of rows) found.add(url)
  }
  return found
}

/**
 * Total byte length of an object, or null when it could not be measured.
 *
 * A one-byte Range probe, the same measurement /api/visualizer/finalize's webm
 * lane makes before it commits to anything, through the same header parser. Two
 * distinct answers matter to the caller and `null` is neither of them:
 *   - 416 means the object is ZERO bytes (nothing can satisfy `bytes=0-0`),
 *     which is the classic MediaRecorder-never-fired blob. Reported as 0 so the
 *     caller refuses to file it in the library.
 *   - null means UNREACHABLE or UNMEASURABLE, which is NOT proof the object is
 *     bad and NOT proof it exists. The caller declines that path this time
 *     rather than writing a row that might point at a 404.
 */
async function probeObjectBytes(publicUrl: string): Promise<number | null> {
  try {
    const res = await fetch(publicUrl, {
      headers: { Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(15_000),
    })
    res.body?.cancel().catch(() => {})
    if (res.status === 416) return 0
    if (!res.ok) return null
    return totalBytesFromHeaders(res.headers)
  } catch {
    return null
  }
}

/**
 * GET — list this user's renders that never got claimed.
 *
 * Scan shape, and why it is this shape rather than "list every owned project's
 * prefix": mf-video only has a folder for a project that actually holds video,
 * so listing the ROOT first and intersecting the folder names against the owned
 * set costs one walk per project-with-video instead of one per project. It is
 * also the only shape that can SEE a folder whose name is spelled in a case the
 * database does not use — see the normalization note below.
 */
export async function GET(req: NextRequest) {
  const userId = req.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // The ONE failure exit this scan has. Every "we could not finish looking"
  // lands here, and it reports NOTHING rather than a partial list: an
  // incomplete scan cannot tell "no row exists" from "we did not ask", and the
  // difference between those is whether a live library item gets offered up for
  // a pointless duplicate claim. The banner simply does not appear.
  const incomplete = () => {
    return NextResponse.json({ error: 'Could not check for unsaved renders.' }, { status: 503 })
  }

  const owned = await ownedProjects(userId)
  if (!owned) return incomplete()
  if (owned.projects.length === 0) {
    return NextResponse.json({ recoverable: [], truncated: false })
  }

  // ── CASE NORMALIZATION, and why it cannot be skipped ──────────────────────
  // Postgres `uuid` comparison is case-INSENSITIVE (`'AB…'::uuid = 'ab…'::uuid`
  // is true, verified against production) and always RENDERS lowercase.
  // Supabase Storage keys are plain text and are stored VERBATIM. So an id that
  // is one value to the database is two different literals to the bucket, and a
  // scan that walks `${row.id}/` sees only the lowercase half. Production
  // already contains keys of the other half — 5 mf-audio objects written by the
  // iOS app, whose Swift `UUID.uuidString` is uppercase.
  //
  // Hence: the owned set is keyed on the LOWERCASED id, and a folder name is
  // lowercased (by keyProjectId, the codebase's one attribution helper) before
  // it is matched. That is the only comparison in this file that normalizes
  // case; the SHAPE gate below deliberately does not — see there.
  const byLowerId = new Map<string, OwnedProject>()
  for (const p of owned.projects) byLowerId.set(p.id.toLowerCase(), p)

  const roots = await pageThrough('')
  if (roots === null) return incomplete()

  // Folder markers only, restricted to prefixes this user owns. A real object
  // sitting at the bucket root (id !== null) is skipped: it has no project
  // segment, so it attributes itself to nobody and this route must never guess.
  const ownedFolders: { folder: string; project: OwnedProject }[] = []
  const seenFolders = new Set<string>()
  for (const entry of roots) {
    if (entry.id !== null || !entry.name) continue
    if (seenFolders.has(entry.name)) continue
    seenFolders.add(entry.name)
    // The folder name is turned into a KEY so the codebase's one attribution
    // helper can judge it, rather than this file growing a second UUID test
    // that could disagree with keyProjectId about what a project segment is.
    // keyProjectId lowercases, which is what lets an uppercase folder be
    // matched to its owner at all.
    const attributed = keyProjectId(`${entry.name}/x`)
    const project = attributed ? byLowerId.get(attributed) : undefined
    if (project) ownedFolders.push({ folder: entry.name, project })
  }

  let truncated = ownedFolders.length > MAX_OWNED_PREFIXES
  const candidates: Candidate[] = []
  // Whole-scan dedup: an offset-ignoring listing, or two folder spellings of the
  // same project, must not produce the same key twice.
  const seenKeys = new Set<string>()
  let unrecognized = 0

  for (const { folder, project } of ownedFolders.slice(0, MAX_OWNED_PREFIXES)) {
    if (candidates.length >= MAX_CANDIDATES) { truncated = true; break }
    const rows = await pageThrough(folder)
    if (rows === null) return incomplete()
    for (const entry of rows) {
      // id === null marks a sub-prefix. No viz key is ever nested
      // (`<projectId>/viz-<stamp>.<ext>` is exactly one level deep), so a folder
      // here is not something this app wrote and is not descended into.
      if (!entry.name || entry.id === null) continue
      const key = `${folder}/${entry.name}`
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      // ── SHAPE GATE — the same one /api/visualizer/finalize applies ─────────
      // `project.id` is the canonical spelling Postgres handed back, and
      // parseVizStoragePath compares the key's first segment to it as TEXT.
      // That strictness is the point and must not be "fixed" by lowercasing the
      // key first: a non-canonically-spelled key is one that VIZ_KEY_RE — the
      // recognizer the whole app shares — cannot match, so nothing downstream
      // could claim, find or ever delete it. Offering it here would produce a
      // Recover button that fails every time. Counted instead, so a growing
      // number is visible rather than silent.
      if (!parseVizStoragePath(project.id, key)) { unrecognized++; continue }
      if (candidates.length >= MAX_CANDIDATES) { truncated = true; break }
      candidates.push({
        path: key,
        project,
        createdAt: entry.created_at ?? null,
        size: typeof entry.metadata?.size === 'number' ? entry.metadata.size : null,
      })
    }
  }

  if (candidates.length === 0) {
    return NextResponse.json({ recoverable: [], truncated })
  }

  // ── Exclusion, in one bulk pass ──────────────────────────────────────────
  // A webm candidate is asked about TWICE: under its own URL, and under the URL
  // of the mp4 twin the finalize webm lane would have transcoded it into
  // (mp4TwinPath — the same derivation the WebM→MP4 heal and the reaper use).
  // A claim that got as far as writing the twin leaves the original webm in
  // place and unreferenced; without the second question this route would offer
  // it as "unsaved" and a Recover click would file a SECOND library entry for a
  // video the user can already see.
  const urlOf = (path: string) => supabaseAdmin.storage.from(VIDEO_BUCKET).getPublicUrl(path).data.publicUrl
  const askAbout: string[] = []
  const twinUrlOf = new Map<string, string>()
  for (const c of candidates) {
    askAbout.push(urlOf(c.path))
    if (c.path.endsWith('.webm')) {
      const twinUrl = urlOf(mp4TwinPath(c.path))
      twinUrlOf.set(c.path, twinUrl)
      askAbout.push(twinUrl)
    }
  }

  const referenced = await referencedUrls(askAbout)
  if (!referenced) return incomplete()

  const survivors = candidates.filter(c => {
    const url = urlOf(c.path)
    if (referenced.has(url) || owned.pinned.has(url)) return false
    const twinUrl = twinUrlOf.get(c.path)
    return !(twinUrl && (referenced.has(twinUrl) || owned.pinned.has(twinUrl)))
  })

  // Newest first — the recovery banner is about work the user just lost.
  survivors.sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? '') || a.path.localeCompare(b.path))
  if (survivors.length > MAX_RECOVERABLE) truncated = true
  const shortlist = survivors.slice(0, MAX_RECOVERABLE)

  // ── Per-path re-check, bounded by MAX_RECOVERABLE ────────────────────────
  // The same "confirm immediately before acting" step the reaper runs, for the
  // same reason: the bulk query above makes the scan cheap, and this makes a
  // mistake in it — or a row that landed DURING it — survivable. It is
  // deliberately asymmetric with the bulk pass: indexedVisualizerAt() answers
  // null both for "no row" and for "a row owned by someone else", so it can
  // only ever ADD confidence that an object is this user's to recover; the
  // foreign case is what the unfiltered bulk query above is for.
  //
  // A THROW here falls back to the bulk answer (keep the candidate) rather than
  // dropping it. This pass can only ever REMOVE entries, so an unanswered
  // question must not be allowed to remove one — and offering a claim that
  // turns out to be redundant is harmless, because POST is idempotent.
  const stillOrphaned = await runBounded(shortlist.map(c => async () => {
    try {
      return (await indexedVisualizerAt(c.path, userId)) ? null : c
    } catch (err) {
      console.error('[viz-recover] re-check threw:', err instanceof Error ? err.message : err)
      return c
    }
  }))

  const recoverable = stillOrphaned
    .filter((c): c is Candidate => c !== null)
    .map(c => ({
      path: c.path,
      video_url: urlOf(c.path),
      size: c.size,
      created_at: c.createdAt,
      project_id: c.project.id,
      project_title: c.project.title,
    }))

  if (unrecognized > 0) {
    // Objects under this user's own project folders that the app's shared
    // recognizer cannot name. They are unclaimable here AND unreapable by the
    // sweep (planReap counts them keptForeignShape), so they leak silently —
    // exactly the class VIZ_WEBM_STAMP_MAX and the lowercase key mint were
    // introduced to close. Worth a breadcrumb, never worth acting on.
    Sentry.captureMessage(`viz-recover: ${unrecognized} unrecognizable mf-video key(s) under owned prefixes`, {
      level: 'warning',
      tags: { area: 'visualizer-storage', phase: 'recover-scan' },
      extra: { userId, unrecognized, scanned: candidates.length },
    })
  }

  return NextResponse.json({ recoverable, truncated })
}

/**
 * POST — claim one or more of those objects into the library.
 *
 * Body: { paths: string[] }. Nothing else is read, and in particular NO user id
 * — identity comes from the X-User-Id header the middleware injects, full stop.
 */
export async function POST(req: NextRequest) {
  const userId = req.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // Body first, limiter second — the same ordering /api/visualizer/finalize
  // uses and for the same reason: the payload is a few hundred bytes of JSON,
  // so a request we reject as malformed has cost us nothing and must not cost
  // the caller one of their hourly saves.
  const body = await req.json().catch(() => null) as { paths?: unknown } | null
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

  const paths = Array.from(new Set(
    (Array.isArray(body.paths) ? body.paths : []).filter((p): p is string => typeof p === 'string'),
  )).slice(0, MAX_RECOVER_PATHS)
  if (paths.length === 0) {
    return NextResponse.json({ error: 'paths is required' }, { status: 400 })
  }

  // Same limiter as /api/visualizer/save and /api/visualizer/finalize — this is
  // the same logical operation (a clip entering the library) reached by a third
  // door, so it must not be a way around the cap those two share. One credit
  // per REQUEST rather than per path: no bytes are received, no encoder runs,
  // and MAX_RECOVER_PATHS already bounds the fan-out to a couple of dozen cheap
  // reads — the cap here is about bounding a client that loops, not about
  // pricing CPU.
  const limit = await checkUserLimit(vizSaveLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many visualizer saves. Try again shortly.' },
      { status: 429, headers: rateLimitHeaders(limit) },
    )
  }

  const recovered: { path: string; id: string; video_url: string }[] = []
  const failed: { path: string; error: string }[] = []

  for (const path of paths) {
    // ── OWNERSHIP, RE-DERIVED FROM THE PATH ITSELF ────────────────────────
    // NEVER trust a client-supplied path. The GET above is a convenience, not
    // an authorization: a path that never appeared in it must be judged from
    // scratch, and the judgement is made in this order for a reason.
    //
    //   1. keyProjectId() attributes the key to a project by its first segment,
    //      returning null for anything that names no project (a bucket-root
    //      key, `covers/…`, a traversal attempt). Null is "this key proves
    //      nothing", never "this key is mine".
    //   2. parseVizStoragePath() is the SAME gate /api/visualizer/finalize
    //      applies to an inbound claim, run against that attributed id. This is
    //      where a non-canonical spelling dies, and it must stay STRICTER than
    //      step 1: keyProjectId lowercases, VIZ_KEY_RE matches lowercase hex
    //      only, and the raw key is compared unmodified — so
    //      `<UPPERCASE-UUID>/viz-1.mp4` is refused even though its attributed id
    //      resolves to a real owned project. Refusing is correct: a key outside
    //      VIZ_KEY_RE cannot be reaped, cannot be healed, and cannot be deleted
    //      by /api/visualizer/[id] once indexed, so indexing it would create a
    //      row over bytes nothing can ever clean up.
    //   3. userOwnsProject() — the shared IDOR gate, resolving the attributed
    //      id against `user_id`. Postgres compares uuids case-INSENSITIVELY, so
    //      this gate alone would happily accept the uppercase spelling; step 2
    //      is what makes that irrelevant, and the two are ordered so the cheap
    //      textual gate runs before the query.
    const attributed = keyProjectId(path)
    if (!attributed || !parseVizStoragePath(attributed, path)) {
      failed.push({ path, error: 'Not a recoverable render key' })
      continue
    }
    if (!(await userOwnsProject(userId, attributed))) {
      // Same answer a claim for someone else's project gets from finalize, and
      // deliberately the same answer a claim for a project that does not exist
      // gets — this must not become an ownership oracle.
      failed.push({ path, error: 'Project not found' })
      continue
    }

    const { data: pub } = supabaseAdmin.storage.from(VIDEO_BUCKET).getPublicUrl(path)

    // ── IDEMPOTENCE, WITHOUT A UNIQUE CONSTRAINT ──────────────────────────
    // migration 033 (the unique index on mb_visualizers.video_url) is written
    // but NOT applied in production, so nothing in the database stops a second
    // row over one object — and two rows over one set of bytes is worse than a
    // cosmetic duplicate: DELETE /api/visualizer/[id] removes bytes with no
    // cross-row check, so deleting either leaves the other pointing at a 404.
    //
    // Two layers close it in code. This one answers the common case — a user
    // double-tapping Recover, or the GET list being a few seconds stale —
    // before any work happens, with the row that already exists. The second
    // lives inside indexVisualizer(), which re-reads under claimPrecheck and
    // reuses rather than inserting; that one is what covers two requests
    // genuinely in flight together. Neither is redundant: this one keeps a
    // repeat claim from consuming a storage probe, and that one is the only
    // one that sees a row written between these two lines.
    const already = await indexedVisualizerAt(path, userId)
    if (already) {
      recovered.push({ path, id: already.id, video_url: already.video_url })
      continue
    }

    // Does the object actually exist, and is it more than an empty shell? The
    // claim that would have validated these bytes never arrived, so nothing has
    // ever looked at them. A full demux (what finalize does) would mean
    // downloading megabytes per path inside one request; a Range probe is free
    // and rejects the one failure shape that is common — the 0-byte
    // MediaRecorder blob — plus the case that matters most here: a path that
    // names no object at all, which would otherwise become a library row
    // pointing at a 404.
    const bytes = await probeObjectBytes(pub.publicUrl)
    if (bytes === null) {
      failed.push({ path, error: 'Could not verify this render — try again in a moment' })
      continue
    }
    if (bytes === 0) {
      // NOT deleted. This route never removes anything; the reaper owns that,
      // and an empty object is exactly what it collects after 24 h.
      failed.push({ path, error: 'This render is empty and cannot be restored' })
      continue
    }

    const stored = await indexVisualizer({
      userId,
      projectId: attributed,
      storagePath: path,
      kind: RECOVERED_KIND,
      // The claim carried the studio's title ("Square · Glow") and its FX
      // recipe, and both died with it — nothing on the server ever saw either,
      // so neither can be reconstructed. recoveredTitle() derives what it can
      // from the one fact the key does carry.
      title: recoveredTitle(path),
      sourceImageUrl: null,
      // THE one call in this file that could otherwise delete. indexVisualizer
      // defaults to removing the object when its insert definitively fails —
      // correct on the save/finalize lanes, backwards here: these bytes have
      // already survived one lost claim, and destroying them on a transient
      // failure would take away the very thing this endpoint exists to hand
      // back. A failed recovery leaves the object untouched and recoverable.
      removeOnFailure: false,
    })
    if (!stored) {
      failed.push({ path, error: 'Could not restore this render' })
      continue
    }
    recovered.push({ path, id: stored.id, video_url: stored.video_url })
  }

  if (recovered.length > 0) {
    // A recovery is proof the claim path failed for a real user with no error
    // anywhere — the whole reason this hole went unnoticed for days. Every
    // successful recovery is therefore a breadcrumb, not a routine event.
    Sentry.captureMessage(`viz-recover: restored ${recovered.length} unclaimed render(s) to the library`, {
      level: 'warning',
      tags: { area: 'visualizer-storage', phase: 'recover-claim' },
      extra: { userId, recovered: recovered.length, failed: failed.length },
    })
  }

  return NextResponse.json({ recovered, failed })
}

/**
 * The title a recovered row carries.
 *
 * Deliberately derived from the storage key's stamp rather than left constant:
 * a burst of eight lost renders would otherwise land in Media as eight
 * identically-named rows with no way to tell them apart.
 */
function recoveredTitle(path: string): string {
  const stamp = /viz-([A-Za-z0-9_-]{1,64})\./.exec(path)?.[1] ?? ''
  const asDate = Number(stamp)
  const when = Number.isSafeInteger(asDate) && asDate > 0
    ? new Date(asDate).toISOString().slice(0, 16).replace('T', ' ')
    : stamp
  return `Recovered visualizer${when ? ` — ${when}` : ''}`.slice(0, 200)
}
