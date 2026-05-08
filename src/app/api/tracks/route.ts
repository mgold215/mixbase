import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export type Track = {
  id: string
  project_id: string
  share_token: string | null
  title: string
  artist: string
  artwork_url: string | null
  audio_url: string
  status: string
  version: string
  uploaded_at: number
  key_signature: string | null
  bpm: number | null
}

let _backfillDone = false
async function ensureShareTokens(userId: string) {
  if (_backfillDone) return
  try {
    const { data } = await supabaseAdmin
      .from('mb_versions')
      .select('id, mb_projects!inner(user_id)')
      .is('share_token', null)
      .eq('mb_projects.user_id', userId)
      .limit(200)
    if (!data?.length) { _backfillDone = true; return }
    await Promise.all(
      data.map(v =>
        supabaseAdmin
          .from('mb_versions')
          .update({ share_token: crypto.randomUUID().replace(/-/g, '') })
          .eq('id', v.id)
      )
    )
    _backfillDone = true
  } catch {
    // Non-fatal
  }
}

export async function GET(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  await ensureShareTokens(userId)

  const [tracksRes, profileRes] = await Promise.all([
    supabaseAdmin
      .from('mb_versions')
      .select('id, project_id, share_token, label, version_number, audio_url, status, created_at, mb_projects!inner(title, artwork_url, key_signature, bpm, user_id)')
      .eq('mb_projects.user_id', userId)
      .order('version_number', { ascending: false }),
    supabaseAdmin
      .from('profiles')
      .select('artist_name, display_name')
      .eq('id', userId)
      .maybeSingle(),
  ])

  if (tracksRes.error) return NextResponse.json({ error: tracksRes.error.message }, { status: 500 })

  const artistName: string =
    profileRes.data?.artist_name?.trim() ||
    profileRes.data?.display_name?.trim() ||
    'mixBASE'

  const seen = new Set<string>()
  const latest = (tracksRes.data ?? []).filter((v) => {
    if (seen.has(v.project_id)) return false
    seen.add(v.project_id)
    return true
  })

  const tracks: Track[] = latest.map((v) => {
    const project = Array.isArray(v.mb_projects) ? v.mb_projects[0] : v.mb_projects
    const p = project as { title?: string; artwork_url?: string | null; key_signature?: string | null; bpm?: number | null }
    const projectTitle: string = p?.title ?? 'Unknown'
    return {
      id: v.id,
      project_id: v.project_id,
      share_token: v.share_token ?? null,
      title: projectTitle,
      artist: artistName,
      artwork_url: p?.artwork_url ?? null,
      audio_url: v.audio_url,
      status: v.status ?? 'WIP',
      version: v.label || `v${v.version_number}`,
      uploaded_at: Math.floor(new Date(v.created_at).getTime() / 1000),
      key_signature: p?.key_signature ?? null,
      bpm: p?.bpm ?? null,
    }
  })

  return NextResponse.json(tracks)
}
