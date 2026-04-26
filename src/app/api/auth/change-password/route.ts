import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// POST /api/auth/change-password — verify current password, then update
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { current_password, new_password } = await request.json()

  if (!current_password || !new_password) {
    return NextResponse.json({ error: 'Both current and new password are required' }, { status: 400 })
  }
  if (new_password.length < 8) {
    return NextResponse.json({ error: 'New password must be at least 8 characters' }, { status: 400 })
  }

  // Look up the user's email so we can verify the current password
  const { data: { user }, error: userError } = await supabaseAdmin.auth.admin.getUserById(userId)
  if (userError || !user?.email) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  // Verify current password by attempting a sign-in
  const { error: signInError } = await supabaseAdmin.auth.signInWithPassword({
    email: user.email,
    password: current_password,
  })

  if (signInError) {
    return NextResponse.json({ error: 'Current password is incorrect' }, { status: 403 })
  }

  // Update the password
  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    password: new_password,
  })

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
