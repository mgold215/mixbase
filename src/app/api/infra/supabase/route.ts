import { NextRequest, NextResponse } from 'next/server'
import { assertAdmin } from '@/lib/auth'
import { getSupabaseStatus } from '@/lib/infra/supabase'

export const dynamic = 'force-dynamic'

// GET /api/infra/supabase — table row counts (service-role), storage usage, DB
// size, applied migrations, and scaling signals. Admin only. Always 200:
// without SUPABASE_MANAGEMENT_TOKEN, counts/buckets still populate while DB size
// and per-bucket bytes report null (managementConfigured:false).
export async function GET(request: NextRequest) {
  const adminId = await assertAdmin(request)
  if (!adminId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const status = await getSupabaseStatus()
  return NextResponse.json(status)
}
