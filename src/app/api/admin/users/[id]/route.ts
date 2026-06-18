import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { currentMonth } from '@/lib/tier'
import { assertAdmin } from '@/lib/auth'
import { isUuid } from '@/lib/validators'

// PATCH /api/admin/users/[id] — update tier and/or reset usage
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!await assertAdmin(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const { tier, resetUsage } = body

  if (tier) {
    const VALID_TIERS = ['free', 'pro', 'studio', 'admin']
    if (!VALID_TIERS.includes(tier)) {
      return NextResponse.json({ error: 'Invalid tier' }, { status: 400 })
    }
    const { error } = await supabaseAdmin.from('profiles').update({ subscription_tier: tier }).eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (resetUsage) {
    const { error: usageError } = await supabaseAdmin.from('mb_usage').delete().eq('user_id', id).eq('month', currentMonth())
    if (usageError) return NextResponse.json({ error: usageError.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

// DELETE /api/admin/users/[id] — delete user account
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!await assertAdmin(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  const requestingUserId = request.headers.get('X-User-Id')
  if (id === requestingUserId) {
    return NextResponse.json({ error: 'Cannot delete your own account' }, { status: 400 })
  }
  const { error } = await supabaseAdmin.auth.admin.deleteUser(id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
