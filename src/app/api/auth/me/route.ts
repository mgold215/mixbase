import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET /api/auth/me — return the authenticated user's email + profile
export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { data: { user }, error } = await supabaseAdmin.auth.admin.getUserById(userId)
  if (error || !user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('artist_name, display_name')
    .eq('id', userId)
    .single()

  return NextResponse.json({
    email: user.email,
    artist_name: profile?.artist_name ?? '',
    display_name: profile?.display_name ?? '',
  })
}

// PATCH /api/auth/me — update profile fields
export async function PATCH(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const body = await request.json()
  const updates: Record<string, string> = {}
  if (typeof body.artist_name === 'string') updates.artist_name = body.artist_name.trim()
  if (typeof body.display_name === 'string') updates.display_name = body.display_name.trim()

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const { error } = await supabaseAdmin
    .from('profiles')
    .upsert({ id: userId, ...updates }, { onConflict: 'id' })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
