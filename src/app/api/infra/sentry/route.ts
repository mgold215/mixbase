import { NextRequest, NextResponse } from 'next/server'
import { assertAdmin } from '@/lib/auth'
import { getSentryStatus } from '@/lib/infra/sentry'

export const dynamic = 'force-dynamic'

// GET /api/infra/sentry — latest unresolved issues (sample). Admin only.
// Reports configured:false without SENTRY_AUTH_TOKEN.
export async function GET(request: NextRequest) {
  const adminId = await assertAdmin(request)
  if (!adminId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return NextResponse.json(await getSentryStatus())
}
