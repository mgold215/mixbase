import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'

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
}

// Backfill any existing versions that are missing a share_token.
// Runs once per server process; short-circuits immediately on subsequent calls.
let _backfillDone = false
async function ensureShareTokens(supabase: Awaited<ReturnType<typeof createClient>>) {
  if (_backfillDone) return
  try {
    const { data } = await supabase
      .from('mb_versions')
      .select('id')
      .is('share_token', null)
      .limit(200)
    if (!data?.length) { _backfillDone = true; return }
    await Promise.all(
      data.map(v =>
        supabase
          .from('mb_versions')
          .update({ share_token: crypto.randomUUID().replace(/-/g, '') })
          .eq('id', v.id)
      )
    )
    _backfillDone = true
  } catch {
    // Non-fatal: tokens will be backfilled on the next request
  }
}

export async function GET() {
  const supabase = await createClient()

  // Ensure all versions have share tokens before returning tracks
  await ensureShareTokens(supabase)

  const { data, error } = await supabase
    .from('mb_versions')
    .select('id, project_id, share_token, label, version_number, audio_url, status, created_at, mb_projects(title, artwork_url)')
    .order('version_number', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Keep only the highest version_number per project (latest version per track).
  const seen = new Set<string>()
  const latest = (data ?? []).filter((v) => {
    if (seen.has(v.project_id)) return false
    seen.add(v.project_id)
    return true
  })

  const tracks: Track[] = latest.map((v) => {
    const project = Array.isArray(v.mb_projects) ? v.mb_projects[0] : v.mb_projects
    const projectTitle: string = project?.title ?? 'Unknown'
    return {
      id: v.id,
      project_id: v.project_id,
      share_token: v.share_token ?? null,
      // Title is just the project title — the version label lives in its own field.
      title: projectTitle,
      artist: projectTitle,
      artwork_url: project?.artwork_url ?? null,
      audio_url: v.audio_url,
      status: v.status ?? 'WIP',
      version: v.label || `v${v.version_number}`,
      uploaded_at: Math.floor(new Date(v.created_at).getTime() / 1000),
    }
  })

  return NextResponse.json(tracks)
}
