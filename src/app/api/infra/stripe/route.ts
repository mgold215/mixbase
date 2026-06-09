import { NextRequest, NextResponse } from 'next/server'
import { assertAdmin } from '@/lib/auth'
import { getStripeStatus } from '@/lib/infra/stripe'

export const dynamic = 'force-dynamic'

// GET /api/infra/stripe — subscription tier distribution + estimated MRR (from
// profiles) and actual active subscriptions (from Stripe when keyed). Admin only.
export async function GET(request: NextRequest) {
  const adminId = await assertAdmin(request)
  if (!adminId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return NextResponse.json(await getStripeStatus())
}
