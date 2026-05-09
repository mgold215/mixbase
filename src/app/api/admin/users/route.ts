import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { currentMonth } from '@/lib/tier'
import { assertAdmin } from '@/lib/auth'

// GET /api/admin/users — list all users with profile + current-month usage
export async function GET(request: NextRequest) {
  if (!await assertAdmin(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { data: { users }, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const userIds = users.map(u => u.id)

  const [profilesRes, usageRes] = await Promise.all([
    supabaseAdmin.from('profiles').select('id, subscription_tier').in('id', userIds),
    supabaseAdmin.from('mb_usage').select('user_id, artwork_generations, video_generations')
      .in('user_id', userIds).eq('month', currentMonth()),
  ])

  const profileMap = Object.fromEntries((profilesRes.data ?? []).map(p => [p.id, p]))
  const usageMap   = Object.fromEntries((usageRes.data   ?? []).map(u => [u.user_id, u]))

  const result = users.map(u => ({
    id:               u.id,
    email:            u.email ?? '',
    created_at:       u.created_at,
    subscription_tier: profileMap[u.id]?.subscription_tier ?? 'free',
    artwork_used:     usageMap[u.id]?.artwork_generations ?? 0,
    video_used:       usageMap[u.id]?.video_generations   ?? 0,
  }))

  return NextResponse.json(result)
}

// POST /api/admin/users — create a new user
export async function POST(request: NextRequest) {
  if (!await assertAdmin(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { email, password, tier } = await request.json()
  if (!email || !password) return NextResponse.json({ error: 'email and password required' }, { status: 400 })

  const VALID_TIERS = ['free', 'pro', 'studio', 'admin']
  if (tier && !VALID_TIERS.includes(tier)) {
    return NextResponse.json({ error: 'Invalid tier' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (tier && tier !== 'free') {
    await supabaseAdmin.from('profiles').update({ subscription_tier: tier }).eq('id', data.user.id)
  }

  return NextResponse.json({ id: data.user.id, email: data.user.email }, { status: 201 })
}
