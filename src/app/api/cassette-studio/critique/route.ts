import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { canonicalUuid, isJsonObject } from '@/lib/validators'
import { isAdminIdentity } from '@/lib/admin-identity'
import { cassetteStudioLimiter, checkUserLimit, rateLimitHeaders } from '@/lib/rate-limit'
import { ARTWORK_BUCKET, keyProjectId } from '@/lib/project-assets'
import { critiqueTakes, REAL_PASS } from '@/lib/cover-concept'

export const runtime = 'nodejs'
export const maxDuration = 180

// Cassette Studio — DOES IT LOOK AI-MADE? The same critic every drawn take
// passes (src/lib/cover-concept.ts critiqueTakes), pointed at covers that
// already exist, so its marks can be checked against covers the owner has
// given a verdict on. No screen calls this: it is how the critic is tuned.
//
// POST /api/cassette-studio/critique   JSON { project_id, paths, instructions? }
//   paths         1–6 keys under that song's own folder in mf-artwork
//                 (<projectId>/<file>.jpg|jpeg|png|webp)
//   instructions  replaces the critic's standing instructions (tuning)
//   → 200 { pass: 7, results: [{ path, real, tells, fix }] }
//
// Owner-only (404 otherwise), like every Cassette Studio route.

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
  const paths = Array.isArray(body.paths) ? body.paths.filter((v): v is string => typeof v === 'string') : []
  if (paths.length < 1 || paths.length > 6) return NextResponse.json({ error: 'paths must hold 1 to 6 keys' }, { status: 400 })
  // The key must attribute itself to THIS project (the same test restore uses) and be a plain image leaf.
  for (const p of paths) {
    if (keyProjectId(p) !== projectId || !/^[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,120}\.(jpe?g|png|webp)$/i.test(p)) {
      return NextResponse.json({ error: 'Each path must be an image in that song\'s own folder.' }, { status: 400 })
    }
  }
  const instructions = typeof body.instructions === 'string' ? body.instructions.slice(0, 12000) : undefined

  const { data: project } = await supabaseAdmin.from('mb_projects').select('id').eq('id', projectId).eq('user_id', userId).single()
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const images: Buffer[] = []
  for (const p of paths) {
    const { data, error } = await supabaseAdmin.storage.from(ARTWORK_BUCKET).download(p)
    if (error || !data) return NextResponse.json({ error: `Could not read ${p.slice(p.indexOf('/') + 1)}` }, { status: 404 })
    images.push(Buffer.from(await data.arrayBuffer()))
  }
  const critique = await critiqueTakes(images, instructions)
  if (!critique) return NextResponse.json({ error: 'The check is not available right now.' }, { status: 503 })
  return NextResponse.json({ pass: REAL_PASS, results: critique.map((c, i) => ({ path: paths[i], ...c })) })
}
