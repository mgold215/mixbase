import { NextRequest, NextResponse } from 'next/server'
import { assertAdmin } from '@/lib/auth'
import { getGithubStatus } from '@/lib/infra/github'

export const dynamic = 'force-dynamic'

// GET /api/infra/github — latest CI run per branch (main, tst). Admin only.
// Works without a token (public repo); GITHUB_TOKEN raises rate limits.
export async function GET(request: NextRequest) {
  const adminId = await assertAdmin(request)
  if (!adminId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return NextResponse.json(await getGithubStatus())
}
