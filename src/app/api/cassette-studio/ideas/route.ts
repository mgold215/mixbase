import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { canonicalUuid, isJsonObject } from '@/lib/validators'
import { isAdminIdentity } from '@/lib/admin-identity'
import { cassetteStudioLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'
import { MAX_IDEAS, writeCoverIdeas } from '@/lib/cover-concept'
import { recentIdeas } from '@/lib/cassette-quick'

export const runtime = 'nodejs'
export const maxDuration = 120

// Cassette Studio — IDEAS FIRST (2026-11-11, the owner: "$.50 per run seems
// risky if I don't like the concept"). The artist sees a few ideas for the
// cover in plain words and picks one BEFORE any picture is drawn: this call
// is text only (about a cent), the drawing that follows costs about forty.
//
// POST /api/cassette-studio/ideas   JSON { project_id, description?, shown? }
//   description  the artist's own idea, optional: the ideas are built on it
//   shown        labels of ideas already shown for this song ("other ideas"):
//                the new ones are different
//   Optional, for the owner's own experiments (the screens never send them):
//   count        how many ideas, 1–4 (default 3)
//   instructions replaces the art director's standing instructions (tuning)
//   → 200 { ideas: [{ idea, label, scene, motion }] }
//   The chosen one goes back, as it came, in POST /quick { concept }.
//
// Owner-only (404 otherwise), like every Cassette Studio route.

const MAX_DESCRIPTION = 400

export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const limit = await checkUserLimit(cassetteStudioLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }
  const body = await request.json().catch(() => null)
  if (!isJsonObject(body)) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const projectId = canonicalUuid(body.project_id)
  if (!projectId) return NextResponse.json({ error: 'Valid project_id is required' }, { status: 400 })
  const description = typeof body.description === 'string' ? body.description.trim().replace(/\s+/g, ' ') : ''
  if (description.length > MAX_DESCRIPTION) return NextResponse.json({ error: `Keep the idea under ${MAX_DESCRIPTION} characters.` }, { status: 400 })
  const shown = Array.isArray(body.shown) ? body.shown.filter((v): v is string => typeof v === 'string').slice(0, 12) : []
  let count = 3
  if (body.count !== undefined) {
    if (typeof body.count !== 'number' || !Number.isInteger(body.count) || body.count < 1 || body.count > MAX_IDEAS) {
      return NextResponse.json({ error: `count must be a whole number from 1 to ${MAX_IDEAS}` }, { status: 400 })
    }
    count = body.count
  }
  const instructions = typeof body.instructions === 'string' ? body.instructions.slice(0, 12000) : undefined

  const { data: project } = await supabaseAdmin.from('mb_projects').select('id, title, genre, bpm, key_signature').eq('id', projectId).eq('user_id', userId).single()
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  const row = project as { title?: string | null; genre?: string | null; bpm?: number | null; key_signature?: string | null }

  const ideas = await writeCoverIdeas({
    title: row.title ?? '', idea: description, genre: row.genre ?? null,
    bpm: typeof row.bpm === 'number' ? row.bpm : null, key: row.key_signature ?? null,
    avoid: [...shown, ...(await recentIdeas(userId))],
  }, count, Math.random, instructions)
  return NextResponse.json({ ideas: ideas.map(({ idea, label, scene, motion }) => ({ idea, label, scene, motion })) })
}
