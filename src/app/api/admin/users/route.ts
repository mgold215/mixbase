import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { currentMonth } from '@/lib/tier'
import { assertAdmin } from '@/lib/auth'

// GET /api/admin/users — list all users with current-month usage
export async function GET(request: NextRequest) {
  if (!await assertAdmin(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { data: { users }, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const userIds = users.map(u => u.id)

  const usageRes = await supabaseAdmin.from('mb_usage').select('user_id, artwork_generations, video_generations')
    .in('user_id', userIds).eq('month', currentMonth())

  const usageMap = Object.fromEntries((usageRes.data ?? []).map(u => [u.user_id, u]))

  const result = users.map(u => ({
    id:               u.id,
    email:            u.email ?? '',
    created_at:       u.created_at,
    artwork_used:     usageMap[u.id]?.artwork_generations ?? 0,
    video_used:       usageMap[u.id]?.video_generations   ?? 0,
  }))

  return NextResponse.json(result)
}

// POST /api/admin/users — create a new user
export async function POST(request: NextRequest) {
  if (!await assertAdmin(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const { email, password } = body
  if (!email || !password) return NextResponse.json({ error: 'email and password required' }, { status: 400 })

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ id: data.user.id, email: data.user.email }, { status: 201 })
}
