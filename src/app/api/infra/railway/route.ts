import { NextRequest, NextResponse } from 'next/server'
import { assertAdmin } from '@/lib/auth'
import { getRailwayStatus } from '@/lib/infra/railway'

export const dynamic = 'force-dynamic'

// GET /api/infra/railway — Railway environments, deployment status, and app
// liveness (via /api/health). Admin only. Always 200: missing RAILWAY_API_TOKEN
// yields { configured:false } with health probes still populated.
export async function GET(request: NextRequest) {
  const adminId = await assertAdmin(request)
  if (!adminId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const status = await getRailwayStatus()
  return NextResponse.json(status)
}
