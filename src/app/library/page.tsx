import { supabaseAdmin } from '@/lib/supabase'
import { getUserId } from '@/lib/auth'
import Nav from '@/components/Nav'
import LibraryClient from './LibraryClient'

export const dynamic = 'force-dynamic'

// Released Library — the artist's already-out discography (ISRC, UPC, dates,
// original files), synced from Spotify/Deezer. Kept separate from /pipeline,
// which holds planned work only.
export default async function LibraryPage() {
  const userId = await getUserId()

  const [tracksRes, profileRes, projectsRes, versionsRes] = await Promise.all([
    supabaseAdmin
      .from('mb_library_tracks')
      .select('*, mb_projects(title)')
      .eq('user_id', userId)
      .order('release_date', { ascending: false, nullsFirst: false })
      .limit(1000),
    supabaseAdmin
      .from('profiles')
      .select('artist_name, spotify_url')
      .eq('id', userId)
      .maybeSingle(),
    supabaseAdmin
      .from('mb_projects')
      .select('id, title')
      .eq('user_id', userId)
      .order('title'),
    // Versions provide the "original file" download for matched projects —
    // scoped through the project join (mb_versions has no user_id column).
    supabaseAdmin
      .from('mb_versions')
      .select('id, project_id, version_number, status, audio_url, audio_filename, mb_projects!inner(user_id)')
      .eq('mb_projects.user_id', userId)
      .order('version_number', { ascending: false }),
  ])

  const versions = (versionsRes.data ?? []).map(v => ({
    id: v.id,
    project_id: v.project_id,
    version_number: v.version_number,
    status: v.status,
    audio_url: v.audio_url,
    audio_filename: v.audio_filename,
  }))

  return (
    <div className="min-h-screen bg-[#080808]">
      <Nav />
      <div className="pt-14">
        <LibraryClient
          initialTracks={tracksRes.error ? [] : (tracksRes.data ?? [])}
          profile={profileRes.error ? null : (profileRes.data ?? null)}
          projects={projectsRes.data ?? []}
          versions={versions}
        />
      </div>
    </div>
  )
}
