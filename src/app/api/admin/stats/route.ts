import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { currentMonth } from '@/lib/tier'
import { assertAdmin } from '@/lib/auth'

export async function GET(request: NextRequest) {
  if (!await assertAdmin(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const month = currentMonth()

  const [usageRes, profilesRes] = await Promise.all([
    supabaseAdmin.from('mb_usage').select('user_id, artwork_generations, video_generations').eq('month', month),
    supabaseAdmin.from('profiles').select('id, subscription_tier'),
  ])

  const { data: { users } } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
  const emailMap = Object.fromEntries(users.map(u => [u.id, u.email ?? '']))
  const tierMap  = Object.fromEntries((profilesRes.data ?? []).map(p => [p.id, p.subscription_tier]))

  const rows = (usageRes.data ?? [])
    .map(r => ({
      user_id:   r.user_id,
      email:     emailMap[r.user_id] ?? '—',
      tier:      tierMap[r.user_id]  ?? 'free',
      artwork:   r.artwork_generations,
      video:     r.video_generations,
    }))
    .sort((a, b) => b.artwork - a.artwork)

  return NextResponse.json({ month, rows })
}
