import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { isJsonObject } from '@/lib/validators'
import { isAdminIdentity } from '@/lib/admin-identity'
import { checkUserLimit, mixCheckLimiter, rateLimitHeaders } from '@/lib/rate-limit'

// POST /api/intern/diagnostics — the Mac app reports what it can see of Logic
// Pro (owner-only, like Mix Check: 404 unless isAdminIdentity).
//
// First piece of the mixing intern (the owner, 2026-11-18: hand the Mix Check
// notes to an agent that fixes them in the actual Logic project and uploads
// the new version, started from the app). Logic only exists on the owner's
// Mac, and the mixBASE Mac app is already there, signed in and updating
// itself, so it is the intern's hands. Before it changes anything it has to
// tell us what this Mac lets it read: its permission to see other apps'
// windows, Logic's version and menus, and how a plug-in's controls appear.
//
// Body: { report: string, source?: string }. Text only; stored as one row.

export const dynamic = 'force-dynamic'

const MAX_REPORT = 300_000

export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await isAdminIdentity(userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body: unknown = await request.json().catch(() => null)
  if (!isJsonObject(body) || typeof body.report !== 'string' || !body.report.trim()) {
    return NextResponse.json({ error: 'report is required' }, { status: 400 })
  }
  const source = typeof body.source === 'string' ? body.source.trim().slice(0, 40) : ''

  const rl = await checkUserLimit(mixCheckLimiter, userId)
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many reports — try again later' }, { status: 429, headers: rateLimitHeaders(rl) })
  }

  const { error } = await supabaseAdmin
    .from('mb_mac_probe')
    .insert({ probe_version: source || 'mac-app', report: body.report.slice(0, MAX_REPORT) })
  if (error) {
    console.error('[intern] diagnostics not stored:', error.message)
    return NextResponse.json({ error: 'Could not store the report' }, { status: 500 })
  }
  return NextResponse.json({ ok: true }, { status: 201 })
}
