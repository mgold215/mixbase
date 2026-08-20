import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isUuid } from '@/lib/validators'
import { rateLimiter, ipKey, rateLimitHeaders } from '@/lib/rate-limit'

// POST /api/share/[token]/duration — the PUBLIC half of the self-healing
// duration backfill.
//
// ── WHY A SECOND, UNAUTHENTICATED ROUTE EXISTS ───────────────────────────────
// `mb_versions.duration_seconds` is NULL on 145 of 364 production rows. The
// browser re-learns the true length every time a mix plays, and
// PATCH /api/versions/[id] writes that reading back exactly once. But that
// route is owner-only: it reads identity from the X-User-Id header the
// middleware injects, so it can only ever heal while the ARTIST is listening.
//
// The share player (/share/<token>) and the album player (/album/<…>/<token>)
// are public. Their listeners have no session, so they could never reach the
// authenticated route — and those pages are exactly where an un-healed back
// catalogue actually gets played, by the people the artist sent the link to.
//
// ── WHY THIS IS SAFE ─────────────────────────────────────────────────────────
// A share token is already a bearer capability: whoever holds it can stream the
// audio and read the public projection of the row. The duration of that audio
// is a fact DERIVABLE from what the token already grants — anyone who can play
// the file can measure it. Letting the holder write that one derived fact back
// therefore adds no meaningful authority, provided the implementation grants
// not one inch more than the argument covers. Concretely:
//
//   · The TOKEN alone decides which row is writable. Branches 1 and 2 below
//     take no target from the body at all: the token itself names the version.
//     Only the album branch needs a target (an album has many tracks), and it
//     is checked against that collection's own item list.
//   · A `versionId` / `projectId` in the body can only ever NARROW — it must
//     agree with what the token resolved to, and is otherwise refused. It can
//     never widen the write to a row the token does not expose.
//   · The write is write-once, in the database: `.is('duration_seconds', null)`
//     rides on the UPDATE itself. A public caller can fill a hole; it can never
//     change a value the artist's own client already wrote, and never overwrite
//     another public caller's. No read-then-write, so nothing to TOCTOU.
//   · Nothing else on the row is writable. There is no passthrough list here,
//     deliberately — compare PATCH /api/versions/[id], which has one.
//
// ── THE RESPONSE IS A PURE FUNCTION OF THE REQUEST BODY ──────────────────────
// This route must not become an oracle. A token that does not exist, a token
// that exists but names a different project, a version that is not in this
// share, a row that was already healed and a row that this call just healed all
// return the SAME 202. So does success. The only thing that changes the
// response is the caller's own body being malformed (400) or its own IP being
// over the limit (429) — never anything read out of the database.
//
// That is a stronger promise than the neighbouring precedent
// (/api/visualizer/recover answers "Project not found" for both not-yours and
// doesn't-exist, but still distinguishes success), and it is free here: the
// callers are fire-and-forget and never read the body.

// ── Rate limit ───────────────────────────────────────────────────────────────
// Modelled on `feedbackLimiter` — the only other PUBLIC write route in the app
// (POST /api/feedback): same `rateLimiter` factory from src/lib/rate-limit.ts,
// same `ipKey(request)` keying, same `rateLimitHeaders()` on the 429. IP is the
// only identifier an anonymous listener has.
//
// Declared HERE rather than beside the other singletons in src/lib/rate-limit.ts
// only because this change is scoped to the share path; it behaves identically
// (a route module is a per-process singleton, so the window is shared across
// requests exactly like the exported limiters) and should be moved next to its
// siblings when someone is next in that file.
//
// 60/hour/IP, above feedback's 20 and matching `loudnessLimiter` /
// `moderationLimiter`, because the shape of the traffic is different: one album
// link can legitimately produce a dozen writes in a few minutes (one per track
// played), several listeners can sit behind one carrier NAT, and the server
// cost is one small UPDATE. The real bound on abuse is not this number — it is
// that a caller must hold an unguessable 128-bit token, and that each row it
// names can be written at most once, ever.
const shareDurationLimiter = rateLimiter({ windowMs: 60 * 60 * 1000, max: 60 })

// Kept deliberately identical to MIN/MAX_BACKFILL_SECONDS in
// src/app/api/versions/[id]/route.ts — the same column, healed from two doors,
// must not accept two different ranges. share-duration-heal-test.mjs asserts
// the two files still agree, so a change to one that forgets the other fails CI.
const MIN_BACKFILL_SECONDS = 1
const MAX_BACKFILL_SECONDS = 12 * 60 * 60

/**
 * Validate a client-supplied duration. Returns integer seconds, or null.
 *
 * This is the wire-facing half of the whole feature, on an endpoint with no
 * session behind it, so it refuses rather than coerces at every step.
 *
 * `HTMLMediaElement.duration` is NaN before metadata parses and Infinity for a
 * stream whose length the browser cannot determine — and this app streams every
 * mix through /api/audio, which only forwards Content-Length when Supabase
 * sends one. "Those can't reach the server because they aren't JSON" is FALSE:
 * `1e999` is perfectly valid JSON and `JSON.parse` turns it into Infinity. So
 * the finite test is not decoration, it is the load-bearing check.
 */
function parseHealSeconds(raw: unknown): number | null {
  // No coercion. `Number("240")` would accept a string, and a client sending
  // strings is a client we do not understand well enough to trust.
  if (typeof raw !== 'number') return null
  // One test that rejects NaN, Infinity and -Infinity.
  if (!Number.isFinite(raw)) return null
  // The column is `integer`; round BEFORE the range test so a value that only
  // clears a bound after rounding cannot slip past it.
  const seconds = Math.round(raw)
  if (seconds < MIN_BACKFILL_SECONDS || seconds > MAX_BACKFILL_SECONDS) return null
  return seconds
}

// Every share token in production is 32 lowercase hex characters
// (`replace(gen_random_uuid()::text, '-', '')` — verified across mb_projects,
// mb_versions and mb_collections, 458/458 rows). This check is deliberately
// looser than that exact shape: hard-coding `^[0-9a-f]{32}$` would silently
// stop healing the day the generator changes, and the value is a parameterised
// query argument either way. The point is only to keep obvious junk out of
// three DB round trips.
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/

/** The version a token exposes, plus the project it belongs to. */
type ShareTarget = { versionId: string; projectId: string }

/** Newest mix of a project — the one, and only one, that both public players
 *  actually load. `share/[token]/page.tsx` and `src/lib/album-share.ts` both
 *  resolve "latest" exactly this way; mirroring it is what keeps this route
 *  from granting a version the token does not expose. */
async function latestVersionOf(projectId: string): Promise<ShareTarget | null> {
  const { data } = await supabaseAdmin
    .from('mb_versions')
    .select('id, project_id')
    .eq('project_id', projectId)
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data ? { versionId: data.id as string, projectId: data.project_id as string } : null
}

/**
 * Resolve a share token to the single version it authorises a write to.
 *
 * Mirrors the three token forms the app actually serves:
 *   1. PROJECT-level  (mb_projects.share_token)    → /share/<token>, latest mix
 *   2. VERSION-level  (mb_versions.share_token)    → /share/<token>, legacy links
 *   3. COLLECTION     (mb_collections.share_token) → /album/<artist>/<title>/<token>
 *
 * Form 2 is what makes this feature able to reach ARCHIVED mixes at all: a
 * project link only ever plays the newest version, so without it the older
 * rows — the bulk of the NULLs — are structurally unreachable.
 *
 * `wantProjectId` is required for form 3 and ignored by the others: an album
 * has many tracks, so the caller must say which one, and that claim is checked
 * against the collection's own item list before it means anything.
 */
async function resolveShareTarget(token: string, wantProjectId: string | null): Promise<ShareTarget | null> {
  // 1. Project-level token.
  const { data: project } = await supabaseAdmin
    .from('mb_projects')
    .select('id')
    .eq('share_token', token)
    .maybeSingle()
  if (project) return latestVersionOf(project.id as string)

  // 2. Legacy version-level token — the token IS the row.
  const { data: version } = await supabaseAdmin
    .from('mb_versions')
    .select('id, project_id')
    .eq('share_token', token)
    .maybeSingle()
  if (version) return { versionId: version.id as string, projectId: version.project_id as string }

  // 3. Collection/album token. An error here (e.g. a deploy that raced
  // migration 019 and has no share_token column yet) is treated as "no match":
  // this route is advisory, so it declines to heal rather than reaching for a
  // schema self-heal from an unauthenticated write path.
  const { data: collection } = await supabaseAdmin
    .from('mb_collections')
    .select('id')
    .eq('share_token', token)
    .maybeSingle()
  if (!collection) return null
  if (!wantProjectId) return null

  // The album token authorises exactly the collection's own tracks — never an
  // arbitrary project id the caller attached to a valid token.
  const { data: item } = await supabaseAdmin
    .from('mb_collection_items')
    .select('project_id')
    .eq('collection_id', collection.id as string)
    .eq('project_id', wantProjectId)
    .maybeSingle()
  if (!item) return null

  return latestVersionOf(wantProjectId)
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limit = shareDurationLimiter.check(ipKey(request))
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  // ── Body first, ALWAYS, before the token is even looked at ─────────────────
  // Order is load-bearing, not stylistic: validating the body before touching
  // the database is what makes the response independent of database state. A
  // caller cannot learn anything about a token by varying it, because for any
  // given body every token produces the same answer.
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const seconds = parseHealSeconds((body as Record<string, unknown>).duration_seconds)
  if (seconds === null) {
    // Loud, like the authenticated route: a rejected reading means the client
    // measured something impossible, and swallowing it would hide that forever.
    // It says nothing about the database — only about the number that was sent.
    return NextResponse.json({ error: 'Invalid duration_seconds' }, { status: 400 })
  }

  const rawProjectId = (body as Record<string, unknown>).projectId
  const rawVersionId = (body as Record<string, unknown>).versionId
  if (rawProjectId != null && !isUuid(rawProjectId)) {
    return NextResponse.json({ error: 'Invalid projectId' }, { status: 400 })
  }
  if (rawVersionId != null && !isUuid(rawVersionId)) {
    return NextResponse.json({ error: 'Invalid versionId' }, { status: 400 })
  }
  const wantProjectId = typeof rawProjectId === 'string' ? rawProjectId : null
  const wantVersionId = typeof rawVersionId === 'string' ? rawVersionId : null

  // From here down every outcome is the same 202. See the oracle note at the
  // top of the file — this is the only return value the database can influence,
  // which is another way of saying it cannot influence one.
  const accepted = NextResponse.json({ ok: true }, { status: 202 })

  const { token } = await ctx.params
  if (!TOKEN_RE.test(token)) return accepted

  const target = await resolveShareTarget(token, wantProjectId)
  if (!target) return accepted

  // Body ids may only NARROW what the token resolved to. A mismatch is a client
  // that has drifted from the page it is running on (e.g. the artist uploaded a
  // newer mix mid-session, so the share page's version is no longer latest) —
  // or an attempt to aim a valid token at a row it does not cover. Both decline.
  if (wantVersionId && wantVersionId !== target.versionId) return accepted
  if (wantProjectId && wantProjectId !== target.projectId) return accepted

  // Write-once, atomically. The `.is('duration_seconds', null)` filter rides on
  // the UPDATE itself rather than being checked first, so two listeners whose
  // 'loadedmetadata' lands in the same instant cannot both write — the loser
  // matches no row. There is deliberately no preceding read: a read-then-write
  // would be a TOCTOU check, and reading first would also give this route a
  // fact about the row it has no reason to know.
  const { data: healed } = await supabaseAdmin
    .from('mb_versions')
    .update({ duration_seconds: seconds })
    .eq('id', target.versionId)
    .is('duration_seconds', null)
    .select('id')
    .maybeSingle()

  // Never log the token — it is an unguessable capability credential, exactly
  // like an upload id (see the note in src/lib/validators.ts).
  if (healed) console.log(`[share-duration] healed version ${target.versionId} → ${seconds}s`)

  return accepted
}
